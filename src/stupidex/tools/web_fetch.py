import logging
import os
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from xml.sax.saxutils import escape, quoteattr

import httpx

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
import html2text
import litellm  # noqa: E402

from stupidex.agents import get_agent_registry  # noqa: E402
from stupidex.config import HOME_CONFIG_DIR, get_model_for_tier  # noqa: E402
from stupidex.domain.session import get_current_session_id  # noqa: E402
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties  # noqa: E402
from stupidex.llm.providers import ProviderResolutionError, qualify_model, resolve_model_ref  # noqa: E402

log = logging.getLogger(__name__)

FETCH_TIMEOUT_SECONDS = 30
SUMMARY_TIMEOUT_SECONDS = 60
RAW_CONTENT_THRESHOLD = 10_000
USER_AGENT = "Stupidex/1.0 web-fetch"


web_fetch_tool = Tool(
    name="web_fetch",
    description=(
        "Fetch a URL and extract information from it. In summarize mode, fetches the page, "
        "converts HTML to markdown, and asks an internal model to answer the query. In raw "
        "mode, returns the converted content directly or writes large content to a cache file."
    ),
    parameters=ToolParameter(
        properties={
            "url": ToolParameterProperties(
                type="string",
                description="The http or https URL to fetch.",
            ),
            "query": ToolParameterProperties(
                type="string",
                description="What to extract from the fetched content.",
            ),
            "mode": ToolParameterProperties(
                type="string",
                description='"summarize" (default) to answer the query, or "raw" to return page content.',
            ),
        },
        required=["url", "query"],
    ),
    action_label="Fetching...",
)


class _TitleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_title = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.parts.append(data)


def _xml_attrs(**attrs: object) -> str:
    parts = []
    for key, value in attrs.items():
        if value is None:
            continue
        parts.append(f"{key}={quoteattr(str(value))}")
    return " ".join(parts)


def _error_result(display: str, message: str, **attrs: object) -> ExecutorResult:
    attr_text = _xml_attrs(**attrs)
    open_tag = f"<web_fetch_error {attr_text}>" if attr_text else "<web_fetch_error>"
    return ExecutorResult(
        display=display,
        content=f"{open_tag}{escape(message)}</web_fetch_error>",
    )


def _validate_url(url: str) -> str | None:
    if not url or not url.strip():
        return "url is required and cannot be empty."
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"}:
        return "url must use http or https."
    if not parsed.netloc:
        return "url must include a host."
    if parsed.username or parsed.password:
        return "url must not contain embedded credentials."
    return None


async def _fetch_response(url: str) -> httpx.Response:
    async with httpx.AsyncClient(
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
        timeout=FETCH_TIMEOUT_SECONDS,
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response


def _extract_title(html: str) -> str:
    parser = _TitleParser()
    try:
        parser.feed(html)
    except Exception:
        log.debug("Failed to parse HTML title", exc_info=True)
        return ""
    return " ".join(" ".join(parser.parts).split())


def _html_to_markdown(html: str) -> str:
    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_images = True
    return converter.handle(html).strip()


def _content_type(response: httpx.Response) -> str:
    return response.headers.get("content-type", "unknown").strip() or "unknown"


def _is_html(content_type: str) -> bool:
    return "text/html" in content_type.lower()


def _response_content(response: httpx.Response) -> tuple[str, str, str]:
    content_type = _content_type(response)
    body = response.text
    if not _is_html(content_type):
        return body, "", content_type
    return _html_to_markdown(body), _extract_title(body), content_type


def _slug_from_url(url: str) -> str:
    parsed = urlparse(url)
    raw = f"{parsed.netloc}{parsed.path or ''}"
    if parsed.query:
        raw = f"{raw}_{parsed.query}"
    raw = raw.strip("/") or parsed.netloc or "page"
    raw = raw.replace("..", "")
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._-")
    slug = re.sub(r"_+", "_", slug)
    slug = Path(slug or "page").name[:80].strip("._-") or "page"
    return f"{slug}.md"


def _cache_dir(session_id: str) -> Path:
    return HOME_CONFIG_DIR / "cache" / "web-fetch" / session_id


def _write_cache_file(session_id: str, url: str, content: str) -> Path:
    cache_dir = _cache_dir(session_id)
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(cache_dir, 0o700)
    except OSError:
        log.debug("Failed to chmod web-fetch cache directory %s", cache_dir, exc_info=True)

    path = cache_dir / _slug_from_url(url)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
    try:
        os.chmod(path, 0o600)
    except OSError:
        log.debug("Failed to chmod web-fetch cache file %s", path, exc_info=True)
    return path


def _raw_result(url: str, title: str, content_type: str, content: str) -> ExecutorResult:
    attrs = _xml_attrs(
        url=url,
        title=title or None,
        content_type=content_type,
        length=len(content),
    )
    if len(content) < RAW_CONTENT_THRESHOLD:
        return ExecutorResult(
            display=f"Fetched {len(content)} characters",
            content=f"<web_fetch_raw {attrs}>\n{escape(content)}\n</web_fetch_raw>",
        )

    session_id = get_current_session_id()
    if session_id is None:
        return _error_result(
            "No active session",
            "Large raw web_fetch results require an active session for cache storage.",
            url=url,
            mode="raw",
        )

    try:
        path = _write_cache_file(session_id, url, content)
    except OSError as e:
        return _error_result(
            "Cache write failed",
            str(e) or "Failed to write web_fetch content to the session cache.",
            url=url,
            mode="raw",
        )
    attrs = _xml_attrs(
        url=url,
        title=title or None,
        content_type=content_type,
        length=len(content),
        file=str(path),
    )
    return ExecutorResult(
        display=f"Fetched {len(content)} characters to {path}",
        content=(
            f"<web_fetch_raw {attrs}>\n"
            f"<warning>Content exceeded {RAW_CONTENT_THRESHOLD} characters and was written to cache - {path}, use grep and read tools to get the result</warning>\n"
            f"</web_fetch_raw>"
        ),
    )


def _choice_content(response: object) -> str:
    try:
        choices = response["choices"] if isinstance(response, dict) else response.choices
        choice = choices[0]
        message = choice["message"] if isinstance(choice, dict) else choice.message
        content = message.get("content") if isinstance(message, dict) else message.content
        return (content or "").strip()
    except (AttributeError, KeyError, IndexError, TypeError):
        return str(response).strip()


async def _summarize_result(url: str, title: str, content_type: str, content: str, query: str) -> ExecutorResult:
    agent = get_agent_registry().get("web-fetch")
    if agent is None:
        return _error_result(
            "Missing web-fetch agent",
            "The internal web-fetch agent could not be loaded.",
            url=url,
            mode="summarize",
        )

    try:
        model_ref = get_model_for_tier(agent.tier.value)
        litellm_provider, model_id, base_url, api_key = resolve_model_ref(model_ref)
    except ProviderResolutionError as e:
        return _error_result(
            "Model resolution failed",
            str(e),
            url=url,
            mode="summarize",
        )

    user_message = (
        f"URL: {url}\n"
        f"Title: {title or '(none)'}\n"
        f"Content-Type: {content_type}\n\n"
        f"Query:\n{query}\n\n"
        f"Fetched page content:\n{content}"
    )

    try:
        response = await litellm.acompletion(
            model=qualify_model(litellm_provider, model_id),
            messages=[
                {"role": "system", "content": agent.system_prompt},
                {"role": "user", "content": user_message},
            ],
            base_url=base_url or None,
            api_key=api_key,
            timeout=SUMMARY_TIMEOUT_SECONDS,
        )
    except Exception as e:
        log.warning("web_fetch summarize LLM call failed: %s", e)
        return _error_result(
            "Summarization failed",
            str(e) or type(e).__name__,
            url=url,
            mode="summarize",
        )

    answer = _choice_content(response)
    attrs = _xml_attrs(
        url=url,
        title=title or None,
        content_type=content_type,
        length=len(content),
    )
    return ExecutorResult(
        display=f"Fetched and summarized {url}",
        content=f"<web_fetch_summarize {attrs}>\n{escape(answer)}\n</web_fetch_summarize>",
    )


async def execute_web_fetch(url: str, query: str, mode: str = "summarize") -> ExecutorResult:
    url = (url or "").strip()
    query = (query or "").strip()
    mode = (mode or "summarize").strip().lower()

    url_error = _validate_url(url)
    if url_error:
        return _error_result("Invalid URL", url_error, url=url, mode=mode)
    if not query:
        return _error_result("Empty query", "query is required and cannot be empty.", url=url, mode=mode)
    if mode not in {"summarize", "raw"}:
        return _error_result(
            "Invalid mode",
            'mode must be either "summarize" or "raw".',
            url=url,
            mode=mode,
        )

    try:
        response = await _fetch_response(url)
        final_url = str(response.url)
        content, title, content_type = _response_content(response)
    except httpx.TimeoutException:
        return _error_result("Fetch timed out", "Request timed out after 30 seconds.", url=url, mode=mode)
    except httpx.HTTPStatusError as e:
        status_code = e.response.status_code
        return _error_result(
            f"HTTP {status_code}",
            f"Request failed with HTTP status {status_code}.",
            url=url,
            mode=mode,
            status=status_code,
        )
    except httpx.ConnectError as e:
        return _error_result("Connection failed", str(e) or "Could not connect to host.", url=url, mode=mode)
    except httpx.HTTPError as e:
        return _error_result("Fetch failed", str(e) or type(e).__name__, url=url, mode=mode)
    except Exception as e:
        log.warning("web_fetch failed to process response: %s", e)
        return _error_result("Fetch failed", str(e) or type(e).__name__, url=url, mode=mode)

    if mode == "raw":
        return _raw_result(final_url, title, content_type, content)
    return await _summarize_result(final_url, title, content_type, content, query)
