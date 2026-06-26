import asyncio
import copy
import html
import json
import logging
import os
import random
import re
import shutil
import time
import traceback
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import httpx
import litellm
from litellm.exceptions import MidStreamFallbackError

from stupidex.config import HOME_CONFIG_DIR, get_config
from stupidex.domain.message import Message, MessageRole, MessageType, Usage
from stupidex.domain.session import get_current_session_id
from stupidex.domain.tool import ExecutorResult, Tool
from stupidex.llm.dynamic_system_prompt import build_dynamic_system_prompt
from stupidex.llm.providers import ProviderResolutionError, qualify_model, resolve_model_ref
from stupidex.llm.static_system_prompt import build_static_system_prompt
from stupidex.tools import get_tool_registry

log = logging.getLogger(__name__)

_YIELD_THROTTLE = 0.1
_TOOL_TIMEOUT = 60
_ERROR_DETAIL_MAX_LEN = 200
_TOOL_OUTPUT_INLINE_THRESHOLD = 10_000
_TOOLS_WITHOUT_OUTPUT_OFFLOAD = {"read", "grep", "glob", "directory_tree", "web_fetch", "skill", "write"}
_TOOLS_WITHOUT_TIMEOUT = {
    "wait_for_subagent",
    "get_file_skeleton",
    "get_function",
    "find_symbol_references",
    "replace_symbol",
    "rename_symbol",
}


def classify_error(exc: Exception) -> tuple[str, str]:
    """Map an exception to a (title, detail) pair for user-facing display."""
    detail = str(exc)[:_ERROR_DETAIL_MAX_LEN] or type(exc).__name__
    if isinstance(exc, ProviderResolutionError):
        return (
            "Unknown Provider",
            detail or "The model reference could not be resolved. Check your providers config.",
        )
    if isinstance(exc, litellm.AuthenticationError):
        return "Authentication Failed", "Invalid or missing API key. Check your configuration."
    if isinstance(exc, litellm.RateLimitError):
        return "Rate Limit Exceeded", "Too many requests. Please wait and try again."
    if isinstance(exc, litellm.Timeout):
        return "Request Timed Out", "The API did not respond in time. Try again later."
    if isinstance(exc, litellm.APIConnectionError):
        return "Connection Failed", "Could not reach the API server. Check your network and base_url."
    if isinstance(exc, litellm.BadRequestError):
        return "Invalid Request", detail or "The request was rejected by the API."
    if isinstance(exc, litellm.InternalServerError):
        return "Server Error", detail or "The API server encountered an internal error."
    if isinstance(exc, litellm.ServiceUnavailableError):
        return "Service Unavailable", detail or "The API service is temporarily unavailable."
    if isinstance(exc, litellm.BadGatewayError):
        return "Bad Gateway", detail or "The API server returned a bad gateway error."
    if isinstance(exc, litellm.APIError):
        return "API Error", detail or "The API returned an error."
    if isinstance(exc, httpx.TimeoutException):
        return "Request Timed Out", "The API did not respond in time. Try again later."
    if isinstance(exc, httpx.HTTPError):
        return "HTTP Error", detail or "An HTTP error occurred."
    return "Unexpected Error", detail


def _raise_first_task_exception(results: tuple[Any, ...]) -> None:
    """Re-raise the first non-cancellation exception from gathered task results."""
    for r in results:
        if isinstance(r, BaseException) and not isinstance(r, asyncio.CancelledError):
            raise r


def _is_transient_error(exc: Exception) -> bool:
    """Check if an exception is a transient provider error worth retrying."""
    transient_types = (
        litellm.RateLimitError,
        litellm.Timeout,
        litellm.APIConnectionError,
        litellm.InternalServerError,
        litellm.ServiceUnavailableError,
        litellm.BadGatewayError,
    )
    if isinstance(exc, transient_types):
        return True
    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code if exc.response is not None else None
        return status in (408, 429, 500, 502, 503, 504)
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status in (408, 429, 500, 502, 503, 504)
    return False


_MID_STREAM_BENIGN_SIGNATURE = "list index out of range"


def _patch_litellm_raise_on_model_repetition() -> None:
    """Monkey-patch ``CustomStreamWrapper.raise_on_model_repetition`` to guard
    against empty ``choices`` lists.

    litellm appends usage-only chunks (``choices=[]``) to ``self.chunks``
    (`streaming_handler.py:2135`). When the next content chunk triggers
    ``raise_on_model_repetition``, it accesses
    ``self.chunks[-1].choices[0].delta.content`` and
    ``self.chunks[-2].choices[0].delta.content`` — both crash with
    ``IndexError`` if the chunk has an empty ``choices`` list.

    This patch skips chunks with empty ``choices`` when looking for the last
    and second-to-last content, silently fixing the root cause of the
    truncation bug.
    """
    from litellm import CustomStreamWrapper

    if getattr(CustomStreamWrapper.raise_on_model_repetition, "_stupidex_patched", False):
        return

    _orig = CustomStreamWrapper.raise_on_model_repetition

    def _safe_raise_on_model_repetition(self) -> None:
        if len(self.chunks) < 2:
            return
        last = None
        second = None
        for chunk in reversed(self.chunks):
            if chunk.choices and len(chunk.choices) > 0:
                if last is None:
                    last = chunk
                elif second is None:
                    second = chunk
                    break
        if last is None or second is None:
            return
        last_content = last.choices[0].delta.content
        if last_content is None or not isinstance(last_content, str) or len(last_content) <= 2:
            self._repeated_messages_count = 1
            return
        second_to_last_content = second.choices[0].delta.content
        if last_content == second_to_last_content:
            self._repeated_messages_count += 1
        else:
            self._repeated_messages_count = 1
        if self._repeated_messages_count >= litellm.REPEATED_STREAMING_CHUNK_LIMIT:
            raise litellm.InternalServerError(
                message=f"The model is repeating the same chunk = {last_content}.",
                model="",
                llm_provider="",
            )

    _safe_raise_on_model_repetition._stupidex_patched = True  # type: ignore[attr-defined]
    _safe_raise_on_model_repetition._orig = _orig  # type: ignore[attr-defined]
    CustomStreamWrapper.raise_on_model_repetition = _safe_raise_on_model_repetition


_patch_litellm_raise_on_model_repetition()


def _is_benign_midstream_litellm_error(exc: MidStreamFallbackError) -> bool:
    """Identify the litellm empty-choices parsing bug as a benign stream event.

    litellm's ``__anext__`` accesses ``choices[0]`` with no length guard, so
    any chunk whose ``choices`` array is empty (a usage-only chunk, a
    keep-alive frame, a periodic usage snapshot from a chatty proxy) raises
    ``IndexError: list index out of range`` inside litellm's chunk parser.
    ``exception_type`` maps that to an ``APIConnectionError`` whose message
    embeds "list index out of range", and ``_handle_stream_fallback_error``
    wraps that in a ``MidStreamFallbackError`` intended for a Router to fail
    over on.

    stupidex calls ``litellm.acompletion`` directly (no Router), so the
    fallback signal can never be consumed. When this specific signature
    appears AFTER content has already been delivered
    (``is_pre_first_chunk=False``), the error came from an empty-choices
    chunk — NOT from real content loss. The stream consumer should
    ``continue`` to the next chunk (the underlying SSE iterator is still
    alive) rather than ``break`` (which silently drops any content that
    arrives after the empty-choices chunk).

    Pre-first-chunk occurrences and non-matching signatures (genuine
    connection drops, etc.) return False so they propagate to the retry /
    error-display path unchanged.
    """
    if exc.is_pre_first_chunk:
        return False
    if _MID_STREAM_BENIGN_SIGNATURE in str(exc):
        return True
    orig = exc.original_exception
    return orig is not None and _MID_STREAM_BENIGN_SIGNATURE in str(orig)


def _validate_tool_args(tool: Tool, args: dict) -> str | None:
    """Return error message if args are invalid, None if ok."""
    known = set(tool.parameters.properties.keys())
    unknown = set(args.keys()) - known
    if unknown:
        return f"Unknown parameters: {', '.join(sorted(unknown))}. Expected: {', '.join(sorted(known))}"
    for req in tool.parameters.required:
        if req not in args:
            return f"Missing required parameter: {req}"
    return None


def _tool_output_slug(tool_name: str, tool_call_id: str) -> str:
    raw = f"{tool_name}_{tool_call_id}"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._-")
    slug = re.sub(r"_+", "_", slug)
    slug = (slug or "output")[:120]
    return f"{slug}.txt"


def _tool_output_cache_dir(session_id: str) -> Path:
    return HOME_CONFIG_DIR / "cache" / "tool-output" / session_id


def cleanup_tool_output_cache(session_id: str) -> None:
    """Remove the tool-output cache directory for a session."""
    cache_dir = _tool_output_cache_dir(session_id)
    try:
        shutil.rmtree(cache_dir, ignore_errors=True)
    except OSError:
        log.debug("Failed to clean tool-output cache for session %s", session_id, exc_info=True)


def _maybe_offload_tool_output(tool_name: str, content: str, tool_call_id: str) -> str:
    """Bound tool output size before it enters ``api_messages``.

    Outputs at or below ``_TOOL_OUTPUT_INLINE_THRESHOLD`` and tools that
    already self-limit (``_TOOLS_WITHOUT_OUTPUT_OFFLOAD``) pass through
    unchanged. Larger outputs are written to a per-session cache file
    (mirroring the web_fetch pattern) and replaced with a compact pointer
    so the provider context window is not blown out. When no session is
    active, the content is hard-truncated instead.
    """
    if len(content) <= _TOOL_OUTPUT_INLINE_THRESHOLD or tool_name in _TOOLS_WITHOUT_OUTPUT_OFFLOAD:
        return content

    session_id = get_current_session_id()
    if session_id is None:
        truncated = content[:_TOOL_OUTPUT_INLINE_THRESHOLD]
        return (
            f"<{tool_name}_result length={len(content)}>\n"
            f"<warning>Output exceeded {_TOOL_OUTPUT_INLINE_THRESHOLD} characters "
            f"and was truncated because no active session is available for cache "
            f"storage. Use the tool again with narrower scope (offset/limit) to "
            f"inspect the full result.</warning>\n{truncated}\n</{tool_name}_result>"
        )

    cache_dir = _tool_output_cache_dir(session_id)
    try:
        cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(cache_dir, 0o700)
        except OSError:
            log.debug("Failed to chmod tool-output cache dir %s", cache_dir, exc_info=True)
        path = cache_dir / _tool_output_slug(tool_name, tool_call_id)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        try:
            os.chmod(path, 0o600)
        except OSError:
            log.debug("Failed to chmod tool-output cache file %s", path, exc_info=True)
    except OSError as e:
        log.warning("Failed to offload tool output for %s: %s", tool_name, e, exc_info=True)
        truncated = content[:_TOOL_OUTPUT_INLINE_THRESHOLD]
        return (
            f"<{tool_name}_result length={len(content)}>\n"
            f"<warning>Output exceeded {_TOOL_OUTPUT_INLINE_THRESHOLD} characters "
            f"and cache write failed ({e}). Truncated below; re-run the tool with "
            f"narrower scope to inspect the full result.</warning>\n"
            f"{truncated}\n</{tool_name}_result>"
        )

    escaped_path = html.escape(str(path))
    return (
        f'<{tool_name}_result length={len(content)} file="{escaped_path}">\n'
        f"<warning>Output exceeded {_TOOL_OUTPUT_INLINE_THRESHOLD} characters and "
        f"was written to {escaped_path}. Use read (with offset/limit) or grep to inspect "
        f"it.</warning>\n</{tool_name}_result>"
    )


def _history_to_api_messages(messages: list[Message]) -> list[dict[str, Any]]:
    """Convert persisted display history to API history.

    Enforces the OpenAI-shaped invariant both ways:
    - every `tool` message is preceded by an assistant message whose
      `tool_calls` contains the same `tool_call_id` (orphaned tool results
      are dropped); and
    - every assistant `tool_calls` block has at least one following matching
      `tool` message (assistant tool_calls that never received a result --
      e.g. after an interrupted turn -- are filtered so we don't send
      dangling tool_calls, which would 400 on strict providers).
    """
    # Pre-pass: collect tool_call_ids that have a properly-sequenced matching
    # TOOL_RESULT — i.e. the result follows its preceding assistant tool_calls
    # block before any intervening non-thinking/non-tool message. Assistant
    # tool_calls entries whose ids have no *sequenced* result are filtered on
    # emit so we don't send a tool_calls block that never receives its tool
    # responses. A global "anywhere" presence check is too broad: it would
    # mark an id as surviving based on an orphan result that appears in a
    # later turn after the sequence was already broken, emitting a dangling
    # tool_calls block with no paired result in message order.
    surviving_tool_call_ids: set[str] = set()
    pending_tool_call_ids: set[str] = set()
    for msg in messages:
        if msg.type == MessageType.ERROR:
            continue
        if msg.type == MessageType.TOOL_CALL and not msg.tool_calls:
            continue
        if msg.type == MessageType.THINKING:
            # THINKING never breaks the tool_call/tool_result pairing (mirrors
            # the main loop's non-reset-on-thinking guarantee below).
            continue
        if msg.role == MessageRole.TOOL:
            if msg.tool_call_id and msg.tool_call_id in pending_tool_call_ids:
                surviving_tool_call_ids.add(msg.tool_call_id)
            continue
        if not msg.content and not msg.tool_calls:
            continue
        # An emitted non-tool message breaks the sequence: results from a
        # later turn can no longer legitimately pair with earlier tool_calls.
        # A new assistant tool_calls block resets pending to its own ids.
        pending_tool_call_ids = {tc.get("id") for tc in msg.tool_calls if tc.get("id")} if msg.tool_calls else set()

    api_messages: list[dict[str, Any]] = []
    last_assistant_tool_call_ids: set[str] = set()
    for msg in messages:
        if msg.type == MessageType.ERROR:
            continue
        if msg.type == MessageType.TOOL_CALL and not msg.tool_calls:
            continue
        if msg.type == MessageType.THINKING:
            # Replay THINKING as plain assistant content so reasoning-capable
            # models retain prior deliberation. The `reasoning` top-level
            # field is intentionally NOT emitted here: strict OpenAI Chat
            # Completions providers (gpt-4o etc.) reject unknown top-level
            # fields with HTTP 400. We pass the thinking text as `content`
            # because most providers tolerate it and it preserves context.
            # The match-set is NOT reset on THINKING: an intervening THINKING
            # between assistant(tool_calls=[A]) and tool(A) must not cause A
            # to be dropped as orphaned.
            if not msg.content:
                continue
            api_messages.append(
                {
                    "role": "assistant",
                    "content": msg.content,
                }
            )
            continue
        if msg.role == MessageRole.TOOL:
            if not msg.tool_call_id:
                continue
            if msg.tool_call_id not in last_assistant_tool_call_ids:
                log.debug(
                    "Dropping orphaned tool result for tool_call_id=%s "
                    "(no preceding assistant tool_calls message in history)",
                    msg.tool_call_id,
                )
                continue
            api_messages.append(msg.to_dict())
            continue
        if not msg.content and not msg.tool_calls:
            continue
        d = msg.to_dict()
        # Filter assistant tool_calls to only those that received a tool
        # result, and drop the field entirely if none survived. Avoids sending
        # dangling assistant tool_calls (e.g. after a cancelled turn) that
        # strict providers reject with 400.
        if msg.tool_calls:
            surviving = [tc for tc in msg.tool_calls if tc.get("id") in surviving_tool_call_ids]
            if surviving:
                d["tool_calls"] = surviving
            else:
                d.pop("tool_calls", None)
                # If the assistant message has no content AND its tool_calls
                # were all unserviced, skip it entirely (empty assistant turn).
                if not msg.content:
                    last_assistant_tool_call_ids = set()
                    continue
        api_messages.append(d)
        if msg.tool_calls:
            last_assistant_tool_call_ids = {tc.get("id") for tc in msg.tool_calls if tc.get("id")}
        else:
            last_assistant_tool_call_ids = set()
    return api_messages


async def _execute_tool(
    tc: dict,
    filtered_tools: dict[str, dict[str, Any]],
) -> Message:
    """Execute a single tool call and return the result message."""
    name = tc["function"]["name"]

    try:
        args = json.loads(tc["function"]["arguments"])
    except json.JSONDecodeError:
        result = ExecutorResult(
            display=f"Invalid arguments for {name}",
            content=f"Error: Could not parse arguments for tool '{name}': invalid JSON.",
        )
    else:
        if not isinstance(args, dict):
            result = ExecutorResult(
                display=f"Invalid arguments for {name}",
                content=f"Error: Arguments for tool '{name}' must be a JSON object, got {type(args).__name__}.",
            )
        elif name not in filtered_tools:
            result = ExecutorResult(
                display=f"Unknown tool: {name}",
                content=f"Error: tool '{name}' does not exist. Available tools: {', '.join(filtered_tools.keys())}",
            )
        else:
            tool_def = filtered_tools[name]["tool"]
            validation_error = _validate_tool_args(tool_def, args)
            if validation_error:
                result = ExecutorResult(
                    display=f"Invalid args for {name}",
                    content=f"Error: {validation_error}",
                )
            else:
                executor = filtered_tools[name]["executor"]
                try:
                    if name in _TOOLS_WITHOUT_TIMEOUT:
                        result = await executor(**args)
                    else:
                        result = await asyncio.wait_for(executor(**args), timeout=_TOOL_TIMEOUT)
                except TimeoutError:
                    result = ExecutorResult(
                        display=f"Timeout in {name}",
                        content=f"Tool '{name}' timed out after {_TOOL_TIMEOUT}s.",
                    )
                except Exception:
                    log.exception("Tool '%s' raised an exception", name)
                    result = ExecutorResult(
                        display=f"Error in {name}",
                        content=f"Tool '{name}' failed with an internal error.",
                    )

    return Message(
        role=MessageRole.TOOL,
        content=result.content,
        display=result.display,
        type=MessageType.TOOL_RESULT,
        tool_call_id=tc["id"],
    )


_BACKOFF_BASE = 0.2


class _StreamIdleTimeoutError(Exception):
    """Raised when the LLM stream produces no chunk for the configured idle timeout.

    The timeout is scoped to the streaming loop only — it measures
    time-since-last-delta-received and is reset on every chunk. Tool-execution
    time (which happens outside the stream iteration, in ``_executor_task``)
    does NOT count against it. A retry with exponential backoff is attempted up
    to ``cfg.llm_stream_retries`` times before this propagates to the caller.
    """

    def __init__(self, idle_timeout: float) -> None:
        super().__init__(f"LLM stream was idle for more than {idle_timeout:.1f}s with no deltas")


async def _safe_aclose(response: Any) -> None:
    """Best-effort ``aclose()`` on a streaming response object.

    Ensures the underlying HTTP stream is released on timeout/retry/finish
    (addresses the P1-10 stream-leak concern). Litellm streaming responses are
    async generators that expose ``aclose()``; fake/test iterables may not, so
    the attribute is checked dynamically.
    """
    aclose = getattr(response, "aclose", None)
    if aclose is None:
        return
    try:
        await aclose()
    except Exception:
        log.debug("aclose() on stream response failed", exc_info=True)


async def _idle_timed_stream(response: Any, idle_timeout: float) -> AsyncGenerator[Any, None]:
    """Re-yield chunks from ``response`` with a per-chunk idle deadline +
    benign MidStreamFallbackError suppression.

    The deadline is measured from the last received chunk — each chunk resets
    the timer. If no chunk arrives within ``idle_timeout`` seconds,
    ``_StreamIdleTimeoutError`` is raised after the underlying response is closed.

    litellm raises ``MidStreamFallbackError`` per-offending-chunk (empty-choices
    IndexError on usage/keep-alive chunks from chatty proxies). The underlying
    SSE iterator is still alive — each error corresponds to a CONSUMED chunk,
    so the stream position advances. We catch the error INSIDE the loop and
    ``continue``: this is critical because if the exception propagated out of
    the ``try`` block, the ``finally`` would run ``aclose()``, killing the
    stream. After that the caller's ``continue`` would get
    ``StopAsyncIteration`` because the generator is exhausted, silently
    truncating the message (the exact bug that caused "All five explor"
    cut-off).

    No cap is needed: each ``MidStreamFallbackError`` maps to one consumed
    SSE chunk, so the stream cannot loop forever — it advances past each
    bad chunk. The ``idle_timeout`` guards against a truly stalled stream
    (no chunks at all for N seconds). A cap was previously used (limit=3)
    but it truncated legitimate streams where the provider sends >3
    consecutive usage/keep-alive chunks between content chunks.
    """
    tb_logged = False
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(response.__anext__(), timeout=idle_timeout)
            except StopAsyncIteration:
                return
            except TimeoutError:
                raise _StreamIdleTimeoutError(idle_timeout) from None
            except MidStreamFallbackError as msfe:
                # Catch INSIDE the loop so the exception never exits the
                # try block. If it did, the finally would run aclose() and
                # kill the stream; the caller's next __anext__ would then
                # get StopAsyncIteration (generator is done) — silently
                # eating the rest of the assistant message.
                if _is_benign_midstream_litellm_error(msfe):
                    if not tb_logged:
                        tb_logged = True
                        orig = msfe.original_exception
                        tb_str = "".join(
                            traceback.format_exception(
                                type(orig) if orig is not None else Exception,
                                orig,
                                orig.__traceback__ if orig is not None else None,
                            )
                        )
                        log.warning(
                            "First MidStreamFallbackError traceback "
                            "(is_pre_first_chunk=%s, "
                            "generated_content_len=%d):\n%s",
                            msfe.is_pre_first_chunk,
                            len(msfe.generated_content or ""),
                            tb_str,
                        )
                    else:
                        log.debug(
                            "Suppressing benign litellm mid-stream error; continuing stream: %s",
                            msfe,
                        )
                    continue
                raise
            yield chunk
    except _StreamIdleTimeoutError:
        await _safe_aclose(response)
        raise
    finally:
        await _safe_aclose(response)


async def _backoff_sleep(attempt: int) -> None:
    """Exponential backoff with jitter between stream-idle retries."""
    delay = _BACKOFF_BASE * (2**attempt)
    jitter = random.uniform(0, _BACKOFF_BASE)
    await asyncio.sleep(delay + jitter)


def _log_stream_termination(
    cause: str,
    finish_reason: str | None,
    chunk_count: int,
    content: str,
    thinking: str,
    tool_calls: list[dict],
) -> None:
    """Log a diagnostic summary at stream end to catch silent truncation.

    Called from the main stream loop just before the ``finally`` block puts
    ``None`` on ``ready_q``. Catches every silent-termination path:

    * ``stop_async_iteration`` — the stream ended naturally. If
      ``finish_reason`` is ``None``, the provider never sent a terminal
      chunk with a finish marker (anomaly). If ``finish_reason='length'``,
      the model hit its output token cap and was cut off — a likely
      truncation cause that was previously invisible. If
      ``finish_reason='content_filter'``, content was filtered.
    * ``benign_suppression_cap`` — NOT used here anymore; the suppression
      now happens inside ``_idle_timed_stream`` which handles the
      ``MidStreamFallbackError`` transparently. This function only sees
      ``stop_async_iteration``. The benign suppression cap hitting causes
      ``_idle_timed_stream`` to ``return`` (raising StopAsyncIteration)
      which maps to ``stop_async_iteration`` here.

    The heuristic at the end flags suspiciously-short trailing content
    after tool calls (the "Now let" signature): if tool_calls were
    present AND the final content is non-empty but ends without sentence-
    ending punctuation, it's a likely truncation candidate worth
    investigating.
    """
    content_len = len(content)
    tail = content[-80:] if content else ""
    has_tool_calls = bool(tool_calls)
    log.info(
        "stream ended: cause=%s finish_reason=%s chunks=%d content_len=%d thinking_len=%d tool_calls=%d",
        cause,
        finish_reason,
        chunk_count,
        content_len,
        len(thinking),
        len(tool_calls),
    )
    if tail:
        log.debug("stream final content tail: %r", tail)

    if cause == "stop_async_iteration" and finish_reason is None and chunk_count > 0:
        log.warning(
            "stream ended without a finish_reason on any chunk (%d chunks "
            "received) — provider may have dropped the stream prematurely",
            chunk_count,
        )
    if cause == "stop_async_iteration" and finish_reason == "length":
        log.warning(
            "stream ended because the model hit its output token cap "
            "(finish_reason='length') — content was truncated by the "
            "provider, not by stupidex"
        )
    if cause == "stop_async_iteration" and finish_reason == "content_filter":
        log.warning(
            "stream ended due to content filtering (finish_reason="
            "'content_filter') — content was blocked by the provider"
        )
    if (
        has_tool_calls
        and content_len > 0
        and content_len < 200
        and not content.rstrip().endswith((".", "!", "?", "```", ":", ")"))
    ):
        log.warning(
            "stream ended after tool calls with short trailing content (%d "
            "chars, no terminal punctuation) — possible truncation; tail: %r",
            content_len,
            tail,
        )


async def _stream_task(
    response: Any,
    msg_q: asyncio.Queue[Message | None],
    ready_q: asyncio.Queue[dict | None],
    api_messages: list[dict[str, Any]],
    assistant_appended: asyncio.Event,
    tool_calls_started: asyncio.Event,
) -> None:
    """Consume the LLM stream, yield messages to msg_q, and queue tools to ready_q."""
    try:
        thinking = ""
        content = ""
        tool_calls: list[dict] = []
        emitted_tool_calls: set[int] = set()
        enqueued_tool_calls: set[int] = set()
        usage = None
        last_thinking_yield: float = 0
        thinking_dirty: bool = False
        prev_index: int | None = None
        assistant_api_msg: dict[str, Any] | None = None
        # Track finish_reason and chunk count for end-of-stream diagnostics.
        _finish_reason: str | None = None
        _chunk_count: int = 0
        _termination_cause: str = "unknown"
        # The anchored assistant message's tool_calls list. None until
        # commit_assistant_with_tool_calls snapshots it; afterwards, late-
        # arriving parallel tool_calls (index >= snapshot length) that become
        # well-formed are appended here so the persisted assistant message and
        # the anchored api_messages entry both see them (shared list ref),
        # without mutating the raw `tool_calls` working buffer.
        committed_tool_calls: list[dict] | None = None
        committed_indices: set[int] = set()

        async def flush_thinking() -> None:
            nonlocal thinking_dirty, last_thinking_yield
            if not thinking_dirty:
                return
            last_thinking_yield = time.monotonic()
            thinking_dirty = False
            if thinking.strip():
                await msg_q.put(
                    Message(
                        role=MessageRole.ASSISTANT,
                        content=thinking,
                        type=MessageType.THINKING,
                    )
                )

        async def commit_assistant_with_tool_calls() -> None:
            """Anchor the assistant tool_calls block once.

            Appends the assistant message to the ephemeral `api_messages`
            (so the executor sees it follow by its tool results in the same
            list), signals `assistant_appended` so the executor is unblocked,
            marks `tool_calls_started` so the end-of-stream flush knows not
            to repeat this, and emits the same assistant message through
            `msg_q` so record_streamed_message persists it on disk.

            Called at most once per stream: at the first mid-stream index
            transition (multi-tool) or at end-of-stream (single tool).
            Subsequent transitions re-use the same anchored assistant entry.

            Tool-call entries lacking an `id` or `function.name` (placeholders
            that never received their identifying delta) are filtered out of
            a separate `committed_tool_calls` list before anchoring so strict
            providers don't 400 on an empty id/name. If none survive the
            filter, an empty-assistant (content-only, no tool_calls) message
            is anchored instead. The live `tool_calls` list is NOT mutated:
            a fresh `committed_tool_calls` snapshot is used for the anchored
            assistant dict/Message so the shared list referenced elsewhere
            (and grown by later deltas) is untouched.

            The snapshot anchored here captures only the tool_calls that are
            well-formed at commit time. Because the commit fires at the first
            index transition (e.g. delta for index 1 arriving while index 0 is
            running), later parallel tool_calls (index 2+) have not arrived
            yet. To preserve the persistence guarantee for those, the delta
            loop appends each newly well-formed tool_call to
            `committed_tool_calls` (the anchored message's shared list) after
            commit fires; see the append block in the delta loop. The
            `committed_indices` set dedupes against entries already in the
            snapshot so the filter + append path never double-adds.
            """
            nonlocal assistant_api_msg, committed_tool_calls, committed_indices
            committed_tool_calls = [tc for tc in tool_calls if tc.get("id") and tc["function"].get("name")]
            committed_indices = {i for i, tc in enumerate(tool_calls) if tc.get("id") and tc["function"].get("name")}
            if committed_tool_calls:
                assistant_api_msg = {
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": committed_tool_calls,
                }
                api_messages.append(assistant_api_msg)
                assistant_appended.set()
                tool_calls_started.set()
                await msg_q.put(
                    Message(
                        role=MessageRole.ASSISTANT,
                        content=content,
                        type=MessageType.TEXT,
                        tool_calls=committed_tool_calls,
                    )
                )
            else:
                assistant_api_msg = {"role": "assistant", "content": content or None}
                api_messages.append(assistant_api_msg)
                assistant_appended.set()
                tool_calls_started.set()
                if content:
                    await msg_q.put(
                        Message(
                            role=MessageRole.ASSISTANT,
                            content=content,
                            type=MessageType.TEXT,
                        )
                    )

        async def emit_malformed_tool_call(prev_idx: int) -> None:
            await msg_q.put(
                Message(
                    role=MessageRole.ASSISTANT,
                    content=(f"Malformed tool call: missing id or name for tool_call index {prev_idx}"),
                    type=MessageType.ERROR,
                    metadata={"error_title": "Malformed Tool Call"},
                )
            )

        async def maybe_enqueue(prev_idx: int) -> None:
            if prev_idx in enqueued_tool_calls:
                return
            if prev_idx >= len(tool_calls):
                await emit_malformed_tool_call(prev_idx)
                enqueued_tool_calls.add(prev_idx)
                return
            tc = tool_calls[prev_idx]
            tc_id = tc.get("id")
            tc_name = tc["function"].get("name")
            if not tc_id or not tc_name:
                await emit_malformed_tool_call(prev_idx)
                enqueued_tool_calls.add(prev_idx)
                return
            enqueued_tool_calls.add(prev_idx)
            # P2-87: snapshot the tool_call at transition time. The raw `tc`
            # dict is the live working buffer; its `function.arguments` field
            # is mutated in place by `+=` below as later argument-chunk deltas
            # arrive. The executor task reads `tc["function"]["arguments"]`
            # from the enqueued reference — without a snapshot, a parallel
            # tool_call whose arguments arrive after enqueue time would let
            # the executor `json.loads` a partial JSON string, surfacing as a
            # spurious "Invalid arguments" tool error.
            await ready_q.put(copy.deepcopy(tc))

        stream_iter = response.__aiter__()
        while True:
            try:
                chunk = await stream_iter.__anext__()
            except StopAsyncIteration:
                _termination_cause = "stop_async_iteration"
                break
            if not chunk.choices:
                continue
            _chunk_count += 1
            delta = chunk.choices[0].delta

            # Capture finish_reason for end-of-stream diagnostics (providers
            # set this on the terminal chunk: 'stop' = natural, 'length' =
            # hit max_tokens, 'content_filter' = filtered, 'tool_calls' =
            # model chose to call tools). Without this, truncation from
            # finish_reason='length' is indistinguishable from natural stop.
            _fr = getattr(chunk.choices[0], "finish_reason", None)
            if _fr:
                _finish_reason = _fr

            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                thinking += delta.reasoning_content
                now = time.monotonic()
                if now - last_thinking_yield >= _YIELD_THROTTLE:
                    last_thinking_yield = now
                    thinking_dirty = False
                    if thinking.strip():
                        await msg_q.put(
                            Message(
                                role=MessageRole.ASSISTANT,
                                content=thinking,
                                type=MessageType.THINKING,
                            )
                        )
                else:
                    thinking_dirty = True

            if delta.content:
                await flush_thinking()
                content += delta.content
                if assistant_api_msg is not None:
                    assistant_api_msg["content"] = content
                # Always forward the cumulative content snapshot. Earlier
                # versions gated this on `not tool_calls_started.is_set()` to
                # avoid re-mounting a duplicate widget after the commit TEXT
                # message — but mount_streamed_message no longer nulls
                # state.content on TOOL_CALL, so late content coalesces into
                # the existing widget via update_content. Gating it instead
                # silently drops trailing/interleaved text that arrives after
                # the commit fires (interleaved text+tool_calls, or a final
                # explanatory sentence after the last tool_call delta),
                # cutting off the displayed and persisted final assistant
                # message while the model still remembers the full text on
                # the next turn.
                await msg_q.put(
                    Message(
                        role=MessageRole.ASSISTANT,
                        content=content,
                        type=MessageType.TEXT,
                    )
                )

            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    # P2-85: some providers (Anthropic-via-litellm, Bedrock
                    # adapters) emit tool_call deltas without an explicit
                    # `index`. Coerce None to the next append slot; otherwise
                    # `None >= len(tool_calls)` raises TypeError mid-stream,
                    # aborting the turn with partial tool_calls already on disk.
                    idx = tc_delta.index if tc_delta.index is not None else len(tool_calls)
                    while idx >= len(tool_calls):
                        tool_calls.append({"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    tc = tool_calls[idx]
                    if tc_delta.id:
                        tc["id"] = tc_delta.id
                    if tc_delta.function:
                        if tc_delta.function.name:
                            tc["function"]["name"] = tc_delta.function.name
                        if tc_delta.function.arguments:
                            tc["function"]["arguments"] += tc_delta.function.arguments

                    if tc["function"]["name"] and idx not in emitted_tool_calls:
                        await flush_thinking()
                        emitted_tool_calls.add(idx)
                        await msg_q.put(
                            Message(
                                role=MessageRole.ASSISTANT,
                                content=f"Calling tool: {tc['function']['name']}",
                                type=MessageType.TOOL_CALL,
                                metadata={"tool_name": tc["function"]["name"]},
                            )
                        )

                    if prev_index is not None and prev_index != idx:
                        await flush_thinking()
                        if not tool_calls_started.is_set():
                            await commit_assistant_with_tool_calls()
                        await maybe_enqueue(prev_index)
                    prev_index = idx

                    # Late-arriving parallel tool_calls (index >= snapshot
                    # length at commit time) become well-formed only after the
                    # commit already fired. Append them to the anchored
                    # assistant message's `committed_tool_calls` list (shared
                    # reference with the anchored api_messages dict and the
                    # emitted Message) so they land on disk and pair with their
                    # TOOL_RESULT on next-turn replay. The raw `tool_calls`
                    # working buffer is NOT used as the anchor. The
                    # `committed_indices` guard prevents re-adding entries
                    # already captured by the commit-time snapshot (e.g. the
                    # transition index that triggered the commit).
                    if (
                        committed_tool_calls is not None
                        and tc.get("id")
                        and tc["function"].get("name")
                        and idx not in committed_indices
                    ):
                        committed_tool_calls.append(tc)
                        committed_indices.add(idx)

            if hasattr(chunk, "usage") and chunk.usage:
                u = chunk.usage
                cached = None
                ptd = getattr(u, "prompt_tokens_details", None)
                if ptd is not None:
                    cached = getattr(ptd, "cached_tokens", None)
                if cached is None:
                    cached = getattr(u, "cache_read_input_tokens", 0) or 0
                usage = Usage(
                    prompt_tokens=u.prompt_tokens,
                    completion_tokens=u.completion_tokens,
                    total_tokens=u.total_tokens,
                    cached_tokens=cached,
                )

        await flush_thinking()

        if prev_index is not None:
            if not tool_calls_started.is_set():
                await commit_assistant_with_tool_calls()
            if usage:
                await msg_q.put(Message(role=MessageRole.ASSISTANT, content="", usage=usage))
            await maybe_enqueue(prev_index)

        if not tool_calls and usage:
            await msg_q.put(Message(role=MessageRole.ASSISTANT, content="", usage=usage))

        _log_stream_termination(
            _termination_cause,
            _finish_reason,
            _chunk_count,
            content,
            thinking,
            tool_calls,
        )
    finally:
        await ready_q.put(None)


async def _executor_task(
    msg_q: asyncio.Queue[Message | None],
    ready_q: asyncio.Queue[dict | None],
    api_messages: list[dict[str, Any]],
    filtered_tools: dict[str, dict[str, Any]],
    assistant_appended: asyncio.Event,
) -> None:
    """Execute tools sequentially as they become ready, yielding results to msg_q."""
    try:
        while True:
            tc = await ready_q.get()
            if tc is None:
                break
            result_msg = await _execute_tool(tc, filtered_tools)
            trimmed = await asyncio.to_thread(
                _maybe_offload_tool_output,
                tc["function"]["name"],
                result_msg.content,
                tc["id"],
            )
            result_msg.content = trimmed
            await msg_q.put(result_msg)
            await assistant_appended.wait()
            api_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": trimmed,
                }
            )
    finally:
        await msg_q.put(None)


async def stream_response(
    messages: list[Message],
    model: str | None,
    allowed_tools: list[str],
    system_prompt: str,
    allowed_skills: list[str] | None = None,
) -> AsyncGenerator[Message, None]:
    from stupidex.tools.skill import build_skill_tool, set_current_allowed_skills

    set_current_allowed_skills(allowed_skills)

    cfg = get_config()
    system_msg = build_static_system_prompt(system_prompt)
    dynamic_prompt = await build_dynamic_system_prompt()
    api_messages: list[dict[str, Any]] = (
        [system_msg.to_dict()] + _history_to_api_messages(messages) + [dynamic_prompt.to_dict()]
    )

    registry = get_tool_registry()
    from fnmatch import fnmatch

    filtered_tools = {k: v for k, v in registry.items() if any(fnmatch(k, p) for p in allowed_tools)}

    from stupidex.mcp import get_mcp_manager

    mcp_manager = get_mcp_manager()
    if mcp_manager is not None:
        for name, tool_entry in mcp_manager.get_tools().items():
            if any(fnmatch(name, p) for p in allowed_tools):
                filtered_tools[name] = tool_entry

    if allowed_skills is not None and "skill" in filtered_tools:
        filtered_tools["skill"] = {**filtered_tools["skill"], "tool": build_skill_tool(allowed_skills)}

    tools_list = [entry["tool"].to_dict() for entry in filtered_tools.values()]

    litellm_provider, model_id, base_url, api_key = resolve_model_ref(model or cfg.default_model)
    litellm_model = qualify_model(litellm_provider, model_id)

    idle_timeout = cfg.llm_stream_idle_timeout
    retries = max(0, cfg.llm_stream_retries)

    while True:
        attempt = 0
        while True:
            snapshot_len = len(api_messages)
            delivered_any = False

            try:
                response = await asyncio.wait_for(
                    litellm.acompletion(
                        model=litellm_model,
                        messages=api_messages,
                        tools=tools_list,
                        base_url=base_url,
                        api_key=api_key,
                        stream=True,
                        stream_options={"include_usage": True},
                    ),
                    timeout=idle_timeout,
                )
            except TimeoutError:
                if attempt < retries:
                    del api_messages[snapshot_len:]
                    log.warning(
                        "LLM connect timed out after >%.1fs; retry %d/%d",
                        idle_timeout,
                        attempt + 1,
                        retries,
                    )
                    await _backoff_sleep(attempt)
                    attempt += 1
                    continue
                raise
            except Exception as exc:
                if attempt < retries and _is_transient_error(exc):
                    del api_messages[snapshot_len:]
                    log.warning(
                        "Transient provider error: %s; retry %d/%d",
                        exc,
                        attempt + 1,
                        retries,
                    )
                    await _backoff_sleep(attempt)
                    attempt += 1
                    continue
                raise

            msg_q: asyncio.Queue[Message | None] = asyncio.Queue(maxsize=1)
            ready_q: asyncio.Queue[dict | None] = asyncio.Queue()
            assistant_appended = asyncio.Event()
            tool_calls_started = asyncio.Event()

            stream_t = asyncio.create_task(
                _stream_task(
                    _idle_timed_stream(response, idle_timeout),
                    msg_q,
                    ready_q,
                    api_messages,
                    assistant_appended,
                    tool_calls_started,
                )
            )
            executor_t = asyncio.create_task(
                _executor_task(
                    msg_q,
                    ready_q,
                    api_messages,
                    filtered_tools,
                    assistant_appended,
                )
            )

            try:
                try:
                    while True:
                        msg = await msg_q.get()
                        if msg is None:
                            break
                        delivered_any = True
                        yield msg
                except BaseException:
                    stream_t.cancel()
                    executor_t.cancel()
                    _raise_first_task_exception(await asyncio.gather(stream_t, executor_t, return_exceptions=True))
                    raise
                else:
                    _raise_first_task_exception(await asyncio.gather(stream_t, executor_t, return_exceptions=True))
            except _StreamIdleTimeoutError:
                if attempt < retries and not delivered_any:
                    del api_messages[snapshot_len:]
                    log.warning(
                        "LLM stream idle for >%.1fs; retry %d/%d",
                        idle_timeout,
                        attempt + 1,
                        retries,
                    )
                    await _backoff_sleep(attempt)
                    attempt += 1
                    continue
                raise
            except Exception as exc:
                if attempt < retries and not delivered_any and _is_transient_error(exc):
                    del api_messages[snapshot_len:]
                    log.warning(
                        "Transient provider error: %s; retry %d/%d",
                        exc,
                        attempt + 1,
                        retries,
                    )
                    await _backoff_sleep(attempt)
                    attempt += 1
                    continue
                raise
            break

        if not tool_calls_started.is_set():
            return
