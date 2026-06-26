from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from stupidex.agents import _load_agents_from_dir
from stupidex.domain.agent import Agent, AgentTypes, ModelTier
from stupidex.domain.session import get_current_session_id, set_current_session_id
from stupidex.domain.tool import ExecutorResult
from stupidex.storage import delete_session
from stupidex.tools.web_fetch import FETCH_TIMEOUT_SECONDS, USER_AGENT, _fetch_response, execute_web_fetch


def _response(
    url: str = "https://example.com/page",
    text: str = "hello",
    content_type: str = "text/plain",
    status_code: int = 200,
) -> httpx.Response:
    return httpx.Response(
        status_code=status_code,
        text=text,
        headers={"content-type": content_type},
        request=httpx.Request("GET", url),
    )


@pytest.mark.asyncio
async def test_fetch_response_uses_expected_http_options(monkeypatch):
    captured = {}

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url):
            captured["url"] = url
            return _response(url=url, text="ok")

    monkeypatch.setattr("stupidex.tools.web_fetch.httpx.AsyncClient", FakeAsyncClient)

    response = await _fetch_response("https://example.com")

    assert response.text == "ok"
    assert captured["follow_redirects"] is True
    assert captured["headers"] == {"User-Agent": USER_AGENT}
    assert captured["timeout"] == FETCH_TIMEOUT_SECONDS
    assert captured["url"] == "https://example.com"


@pytest.mark.asyncio
async def test_web_fetch_raw_html_converts_to_markdown(monkeypatch):
    response = _response(
        text="<html><head><title>Example Title</title></head><body><h1>Hello</h1></body></html>",
        content_type="text/html; charset=utf-8",
    )
    fetch = AsyncMock(return_value=response)
    monkeypatch.setattr("stupidex.tools.web_fetch._fetch_response", fetch)
    monkeypatch.setattr("stupidex.tools.web_fetch._html_to_markdown", lambda html: "# Hello")

    result = await execute_web_fetch("https://example.com/page", "return the page", mode="raw")

    assert isinstance(result, ExecutorResult)
    assert "<web_fetch_raw" in result.content
    assert "# Hello" in result.content
    assert 'title="Example Title"' in result.content
    fetch.assert_awaited_once_with("https://example.com/page")


@pytest.mark.asyncio
async def test_web_fetch_raw_non_html_passes_through(monkeypatch):
    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(return_value=_response(text='{"ok": true}', content_type="application/json")),
    )

    result = await execute_web_fetch("https://example.com/api", "return json", mode="raw")

    assert "<web_fetch_raw" in result.content
    assert '{"ok": true}' in result.content
    assert 'content_type="application/json"' in result.content


@pytest.mark.asyncio
async def test_web_fetch_raw_large_content_writes_session_cache(tmp_path, monkeypatch):
    set_current_session_id("session-1")
    monkeypatch.setattr("stupidex.tools.web_fetch.HOME_CONFIG_DIR", tmp_path / ".stupidex")
    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(return_value=_response(url="https://docs.python.org/3/library/http.html", text="x" * 10001, content_type="text/plain")),
    )

    try:
        result = await execute_web_fetch("https://docs.python.org/3/library/http.html", "return raw", mode="raw")
    finally:
        set_current_session_id(None)

    assert "<warning>" in result.content
    assert 'file="' in result.content
    cache_file = tmp_path / ".stupidex" / "cache" / "web-fetch" / "session-1" / "docs.python.org_3_library_http.html.md"
    assert cache_file.read_text() == "x" * 10001
    assert cache_file.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_web_fetch_raw_large_content_requires_active_session(monkeypatch):
    set_current_session_id(None)
    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(return_value=_response(text="x" * 10001, content_type="text/plain")),
    )

    result = await execute_web_fetch("https://example.com/large", "return raw", mode="raw")

    assert result.display == "No active session"
    assert "<web_fetch_error" in result.content


@pytest.mark.asyncio
async def test_web_fetch_summarize_calls_litellm_with_resolved_provider(monkeypatch):
    agent = Agent(
        name="web-fetch",
        type=AgentTypes.INTERNAL,
        tier=ModelTier.TOLO,
        description="Fetch summary",
        system_prompt="answer from content only",
        allowed_tools=[],
    )
    completion = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="The answer is 42."))]
        )
    )
    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(return_value=_response(text='{"answer": 42}', content_type="application/json")),
    )
    monkeypatch.setattr("stupidex.tools.web_fetch.get_agent_registry", lambda: {"web-fetch": agent})
    monkeypatch.setattr("stupidex.tools.web_fetch.get_model_for_tier", lambda tier: "default/mimo-v2.5")
    monkeypatch.setattr(
        "stupidex.tools.web_fetch.resolve_model_ref",
        lambda model_ref: ("openai", "gpt-4o-mini", "https://llm.example/v1", "secret-key"),
    )
    monkeypatch.setattr("stupidex.tools.web_fetch.litellm.acompletion", completion)

    result = await execute_web_fetch("https://example.com/data.json", "What is the answer?")

    assert "<web_fetch_summarize" in result.content
    assert "The answer is 42." in result.content
    completion.assert_awaited_once()
    kwargs = completion.await_args.kwargs
    assert kwargs["model"] == "openai/gpt-4o-mini"
    assert kwargs["base_url"] == "https://llm.example/v1"
    assert kwargs["api_key"] == "secret-key"
    assert kwargs["timeout"] == 60
    assert kwargs["messages"][0] == {"role": "system", "content": "answer from content only"}
    assert "What is the answer?" in kwargs["messages"][1]["content"]
    assert '{"answer": 42}' in kwargs["messages"][1]["content"]


@pytest.mark.asyncio
async def test_web_fetch_validation_errors_do_not_fetch(monkeypatch):
    fetch = AsyncMock()
    monkeypatch.setattr("stupidex.tools.web_fetch._fetch_response", fetch)

    empty_url = await execute_web_fetch("", "query")
    invalid_mode = await execute_web_fetch("https://example.com", "query", mode="full")
    invalid_scheme = await execute_web_fetch("file:///etc/passwd", "query")
    empty_query = await execute_web_fetch("https://example.com", "")
    creds_url = await execute_web_fetch("https://user:pass@example.com", "query")

    assert "<web_fetch_error" in empty_url.content
    assert "<web_fetch_error" in invalid_mode.content
    assert "<web_fetch_error" in invalid_scheme.content
    assert "<web_fetch_error" in empty_query.content
    assert "<web_fetch_error" in creds_url.content
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_web_fetch_http_errors_are_graceful(monkeypatch):
    request = httpx.Request("GET", "https://example.com/private")
    response = httpx.Response(403, request=request)
    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(side_effect=httpx.HTTPStatusError("Forbidden", request=request, response=response)),
    )

    result = await execute_web_fetch("https://example.com/private", "query")

    assert result.display == "HTTP 403"
    assert "<web_fetch_error" in result.content
    assert 'status="403"' in result.content


@pytest.mark.asyncio
async def test_web_fetch_timeout_and_connection_errors_are_graceful(monkeypatch):
    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(side_effect=httpx.TimeoutException("timed out")),
    )
    timeout_result = await execute_web_fetch("https://example.com/slow", "query")
    assert timeout_result.display == "Fetch timed out"

    monkeypatch.setattr(
        "stupidex.tools.web_fetch._fetch_response",
        AsyncMock(side_effect=httpx.ConnectError("connection refused")),
    )
    connection_result = await execute_web_fetch("https://example.com/down", "query")
    assert connection_result.display == "Connection failed"


def test_web_fetch_agent_loads_with_empty_allowed_tools():
    defaults_dir = Path("src/stupidex/agents/defaults")

    agents = _load_agents_from_dir(defaults_dir)

    assert "web-fetch" in agents
    assert agents["web-fetch"].type == AgentTypes.INTERNAL
    assert agents["web-fetch"].tier == ModelTier.TOLO
    assert agents["web-fetch"].allowed_tools == []
    assert "web_fetch" in agents["general"].allowed_tools


def test_web_researcher_no_longer_says_fetching_is_unavailable():
    agents = _load_agents_from_dir(Path("src/stupidex/agents/defaults"))

    researcher = agents["web-researcher"]
    assert "Web fetching is not available" not in researcher.description
    assert "Web fetching is not available" not in researcher.system_prompt


def test_current_session_id_context_var():
    set_current_session_id(None)
    assert get_current_session_id() is None

    set_current_session_id("session-123")
    try:
        assert get_current_session_id() == "session-123"
    finally:
        set_current_session_id(None)


def test_delete_session_removes_web_fetch_cache(tmp_path, monkeypatch):
    sessions_dir = tmp_path / "sessions"
    home_dir = tmp_path / ".stupidex"
    session_id = "session-1"
    sessions_dir.mkdir()
    (sessions_dir / f"{session_id}.json").write_text('{"id": "session-1"}')
    cache_dir = home_dir / "cache" / "web-fetch" / session_id
    cache_dir.mkdir(parents=True)
    (cache_dir / "page.md").write_text("cached")
    monkeypatch.setattr("stupidex.storage.SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr("stupidex.storage.HOME_CONFIG_DIR", home_dir)

    assert delete_session(session_id) is True
    assert not (sessions_dir / f"{session_id}.json").exists()
    assert not cache_dir.exists()


def test_delete_session_without_cache_is_graceful(tmp_path, monkeypatch):
    sessions_dir = tmp_path / "sessions"
    home_dir = tmp_path / ".stupidex"
    session_id = "session-2"
    sessions_dir.mkdir()
    (sessions_dir / f"{session_id}.json").write_text('{"id": "session-2"}')
    monkeypatch.setattr("stupidex.storage.SESSIONS_DIR", sessions_dir)
    monkeypatch.setattr("stupidex.storage.HOME_CONFIG_DIR", home_dir)

    assert delete_session(session_id) is True
