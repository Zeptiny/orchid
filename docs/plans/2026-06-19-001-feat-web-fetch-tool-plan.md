---
title: feat: Add web_fetch tool with summarize and raw modes
type: feat
date: 2026-06-19
origin: docs/brainstorms/web-fetch.md
---

# Web Fetch Tool

## Summary

Add a `web_fetch` tool that fetches a URL, converts HTML to markdown, and either returns the content directly (raw mode) or sends it to a Tolo-tier LLM to extract information based on a query (summarize mode). Large raw-mode content spills to a session-scoped cache file. The summarization prompt is a user-configurable internal agent (`web-fetch/AGENT.md`).

---

## Problem Frame

The agent has no native web fetching. When it needs web content, it shells out to `curl` via `execute_command`, getting raw HTML. The `web-researcher` agent explicitly states "Web fetching is not available in this environment." This tool fills the gap with two modes: intelligent extraction via LLM, and direct markdown access with file-overflow for large pages.

---

## Requirements

- R1. Tool interface: `web_fetch(url: str, query: str, mode: str = "summarize")` — both `url` and `query` are required.
- R2. **Summarize mode**: fetch URL → convert HTML to markdown → one-shot LLM call (Tolo tier) with page content + query → return LLM answer with metadata (URL, title, content type).
- R3. **Raw mode**: fetch URL → convert HTML to markdown → return directly if under threshold → if over threshold, write to `~/.stupidex/cache/web-fetch/<session-id>/<slug>.md` and return file path + warning.
- R4. Non-HTML content types (JSON, plain text, XML) pass through without markdown conversion.
- R5. HTTP behavior: follow redirects, set `User-Agent` header, 30s default timeout, graceful error messages for 403/timeout/connection errors.
- R6. Summarization prompt lives in `agents/defaults/web-fetch/AGENT.md` with `type: internal`, `tier: tolo`. Users override via `~/.stupidex/agents/web-fetch/AGENT.md`.
- R7. LLM call is a one-shot `litellm.acompletion` (not a full agent loop), using the resolved model for the Tolo tier.
- R8. Cache lifecycle: session-scoped at `~/.stupidex/cache/web-fetch/<session-id>/`. Session delete cleans up the cache directory.
- R9. New dependency: `html2text` for HTML→markdown conversion (more battle-tested than `markdownify`, pure Python, lighter).

---

## Scope Boundaries

- JavaScript rendering (SPA sites) — out of scope
- Authentication / cookies — out of scope
- `robots.txt` compliance — out of scope
- Rate limiting — out of scope
- PDF / image extraction — out of scope
- Multi-page crawling — out of scope
- Content caching across sessions — out of scope
- Streaming large files — out of scope
- Chunked/iterative LLM summarization — out of scope (send full content)

---

## Key Technical Decisions

### Session ID access from tool executors

Tools don't currently have access to the session ID. The existing pattern is `ContextVar` — `TodoStore` uses `set_todo_store()` / `get_todo_store()`, and `SubagentManager` uses `set_subagent_manager()` / `get_subagent_manager()`. Both are set when a session becomes active (in `app.py` and `session_commands.py`).

The plan adds a `_current_session_id: ContextVar[str | None]` with `get_current_session_id()` / `set_current_session_id()`, set alongside the existing `set_todo_store()` calls in `app.py` and `session_commands.py`.

### LLM call pattern for summarize mode

Two patterns exist in the codebase:
1. **Full agent loop**: `stream_response()` in `llm/client.py` — streaming, tool calls, message history. Too heavy for a one-shot extraction.
2. **Direct `litellm.acompletion`**: used in `app.py:460` for session auto-naming. Simple, single call.

The tool uses pattern 2: build the system prompt from the agent's `AGENT.md`, construct a single user message with the page content + query, call `litellm.acompletion`, extract the response text. Model resolution via `get_model_for_tier("tolo")` → `resolve_model_ref()`.

### Raw mode threshold

Default: 10,000 characters. Configurable later via `config.json` if needed (not in v1). Below threshold: return markdown inline. At or above: write to cache file, return path + warning.

### URL slug for filenames

Derive from the URL path: strip protocol, replace `/` and non-alphanumeric chars with `_`, truncate to 80 chars. Example: `https://docs.python.org/3/library/http.html` → `docs.python.org_3_library_http.html.md`.

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/domain/tool.py` — `Tool`, `ToolParameter`, `ToolParameterProperties`, `ExecutorResult` dataclasses. Every tool follows this pattern.
- `src/stupidex/tools/__init__.py:64-95` — `get_tool_registry()`. New tool entry goes here: `"web_fetch": {"tool": web_fetch_tool, "executor": execute_web_fetch}`.
- `src/stupidex/tools/rag.py` — closest analog: a tool that does async work, returns structured `ExecutorResult`. Follow the same error-handling pattern (return error results, don't raise).
- `src/stupidex/llm/providers.py:86-116` — `resolve_model_ref(alias_model)` returns `(litellm_provider, model_id, base_url, api_key)`.
- `src/stupidex/config.py:462-464` — `get_model_for_tier(tier)` returns `cfg.tier_models.get(tier, cfg.default_model)`.
- `src/stupidex/agents/__init__.py:13-77` — `_load_agents_from_dir()` loads agents from `AGENT.md` with frontmatter parsing. The `web-fetch` agent needs no special registration — it's loaded like all other agents.
- `src/stupidex/agents/defaults/explorer/AGENT.md` — pattern for Tolo-tier subagent `AGENT.md`.
- `src/stupidex/agents/defaults/general/AGENT.md` — pattern for `type: internal` agent.
- `src/stupidex/domain/todo.py:159-171` — `ContextVar` pattern for session-scoped state. Template for `_current_session_id`.
- `src/stupidex/app.py:104` and `src/stupidex/commands/session_commands.py:172,202,225` — where `set_todo_store()` is called. The `set_current_session_id()` calls go alongside these.
- `src/stupidex/storage.py:71-81` — `delete_session()`. Needs extension to also `shutil.rmtree` the session's cache directory.
- `src/stupidex/config.py:17` — `HOME_CONFIG_DIR = Path.home() / ".stupidex"`. Cache directory is `HOME_CONFIG_DIR / "cache" / "web-fetch" / session_id`.
- `src/stupidex/llm/client.py:98-156` — `_execute_tool()` pattern for calling tool executors with timeout. `web_fetch` should NOT be in `_TOOLS_WITHOUT_TIMEOUT` since HTTP fetches can hang.
- `src/stupidex/agents/defaults/web-researcher/AGENT.md` — its description mentions "Web fetching is not available" — should be updated after this tool lands.

### Test Patterns

- `tests/test_rag_tools.py` — tests tool executors by calling them directly with mock inputs. Follow for `web_fetch` executor tests.
- `tests/test_mcp_config.py` — tests `_validate_config` as a pure function. Useful pattern if we add config validation for the raw-mode threshold.

---

## Implementation Units

### U1. Add `html2text` dependency

**Goal:** Add the HTML→markdown conversion library to the project.

**Dependencies:** None

**Files:**
- `pyproject.toml` — add `html2text` to dependencies

**Approach:** Add `html2text` to the `[project.dependencies]` list. It's a pure-Python library with no transitive dependencies, maintained since 2010.

**Test scenarios:**
- Verify `uv pip install` or `pip install -e .` installs `html2text` successfully

---

### U2. Create `web-fetch` internal agent

**Goal:** Define the summarization prompt as a configurable internal agent.

**Dependencies:** None

**Files:**
- `src/stupidex/agents/defaults/web-fetch/AGENT.md` — create
- `src/stupidex/agents/__init__.py` — fix `_load_agents_from_dir()` to accept empty `allowed_tools`

**Approach:**

**Prerequisite — fix agent loader bug:** `_load_agents_from_dir()` at `agents/__init__.py:53` skips any agent with `allowed_tools: []` because `if not allowed_tools:` evaluates `[]` as falsy. Internal agents legitimately have no tools. Fix: change the condition to `if allowed_tools is None:` so that an explicit empty list is accepted while truly missing fields are still skipped.

Create `AGENT.md` with frontmatter:
```yaml
---
name: web-fetch
type: internal
tier: tolo
description: Summarizes web page content based on a query. Used by the web_fetch tool in summarize mode.
allowed_tools: []
---
```

The body contains the system prompt: instructions for the Tolo LLM to extract the requested information from the provided web page content. The prompt should instruct the LLM to:
- Read the full page content provided
- Extract or answer based on the user's query
- Be concise and accurate
- If the query asks for something not found in the content, say so

**Test scenarios:**
- Verify the agent loads in the registry via `get_agent_registry()` with `name="web-fetch"`
- Verify it has `type=AgentTypes.INTERNAL` and `tier=ModelTier.TOLO`
- Verify agents with `allowed_tools: []` are no longer skipped by the loader

---

### U3. Add session ID ContextVar plumbing

**Goal:** Make the current session ID accessible to tool executors via a ContextVar.

**Dependencies:** None

**Files:**
- `src/stupidex/domain/session.py` — add `_current_session_id` ContextVar, `get_current_session_id()`, `set_current_session_id()`
- `src/stupidex/app.py` — call `set_current_session_id(session.id)` where `set_todo_store()` is called
- `src/stupidex/commands/session_commands.py` — same, alongside existing `set_todo_store()` calls

**Approach:** Follow the exact `ContextVar` pattern from `domain/todo.py:159-171`:
```python
_current_session_id: ContextVar[str | None] = ContextVar("current_session_id", default=None)

def get_current_session_id() -> str | None:
    return _current_session_id.get()

def set_current_session_id(session_id: str) -> None:
    _current_session_id.set(session_id)
```

Add `set_current_session_id(session.id)` calls at:
- `app.py:104` (alongside `set_todo_store`)
- `commands/session_commands.py:172,202,225` (alongside `set_todo_store`)

Also set to `None` when session is deleted or no active session.

**Architectural note:** `SessionManager.create()` at `session.py:75` and `SessionManager.switch()` at `session.py:78` also change `self.active` but don't go through the caller sites listed above. Currently `create()` is called from `session_commands.py` (which already sets the ContextVar), and `switch()` is dead code. Two options:
1. **Caller-site only (current plan):** Accept the fragility — any new call site must remember to set the ContextVar. Follows the existing `set_todo_store()` convention.
2. **Inside `SessionManager`:** Move `set_current_session_id()` into `create()` and `switch()` so the ContextVar is always updated. Safer but breaks the pattern of setting it alongside `set_todo_store()`.

The plan follows option 1 (caller-site) to match existing conventions. Document this as a known fragility.

**Test scenarios:**
- Verify `get_current_session_id()` returns the correct ID after `set_current_session_id()` is called
- Verify it returns `None` by default

---

### U4. Implement `web_fetch` tool module

**Goal:** Implement the core tool — fetch, convert, and dispatch to summarize or raw mode.

**Dependencies:** U1, U2, U3

**Files:**
- `src/stupidex/tools/web_fetch.py` — create (tool definition + executor)
- `src/stupidex/tools/__init__.py` — add import + registry entry

**Approach:**

**Tool definition:**
```python
web_fetch_tool = Tool(
    name="web_fetch",
    description="Fetch a web page and extract information. ..."
    parameters=ToolParameter(
        properties={
            "url": ToolParameterProperties(type="string", description="The URL to fetch"),
            "query": ToolParameterProperties(type="string", description="What to extract from the page"),
            "mode": ToolParameterProperties(type="string", description='"summarize" (default) or "raw"'),
        },
        required=["url", "query"],
    ),
    action_label="Fetching...",
)
```

**Executor: `execute_web_fetch(url, query, mode="summarize")`**

1. Validate inputs (url non-empty, mode valid). Reject non-http/https URL schemes. Sanitize the filename slug to prevent path traversal (strip `..` sequences, use `pathlib.Path.name` on each segment).
2. Fetch URL via `httpx.AsyncClient` with:
   - `follow_redirects=True`
   - `headers={"User-Agent": "Stupidex/1.0 web-fetch"}`
   - `timeout=30`
   - Catch `httpx.TimeoutException`, `httpx.HTTPStatusError` (403 etc.), `httpx.ConnectError` — return graceful `ExecutorResult` with error in XML.
3. Determine content type from response headers. If HTML (`text/html`), convert to markdown via `html2text.HTML2Text().handle(response.text)`. Otherwise pass through as-is.
4. Extract page title from HTML if available (parse `<title>` tag, or from html2text output).
5. If `mode == "raw"`:
   - If content length < threshold (10,000 chars): return content inline in `<web_fetch_raw>` XML.
   - If >= threshold: derive filename slug from URL, write to cache dir (`HOME_CONFIG_DIR / "cache" / "web-fetch" / session_id / f"{slug}.md"`), return `<web_fetch_raw>` with `file=` attribute and warning.
6. If `mode == "summarize"`:
   - Look up the `web-fetch` agent from `get_agent_registry()`.
   - Resolve model: `get_model_for_tier("tolo")` → `resolve_model_ref()`, which returns `(litellm_provider, model_id, base_url, api_key)`.
   - Call `litellm.acompletion(model=litellm_provider + "/" + model_id, messages=[...], base_url=base_url, api_key=api_key, timeout=60)` with system prompt from agent + user message containing page content + query. Pass all 4 values from `resolve_model_ref()` — without `base_url` and `api_key`, the call fails for non-default providers (same pattern as `app.py:460-464`).
   - Return `<web_fetch_summarize>` XML with the LLM answer + metadata.

**Registry entry in `tools/__init__.py`:**
```python
from stupidex.tools.web_fetch import execute_web_fetch, web_fetch_tool
# in get_tool_registry():
"web_fetch": {"tool": web_fetch_tool, "executor": execute_web_fetch},
```

**Error handling patterns:** Follow `rag.py` — return `ExecutorResult` with descriptive XML on every error path. Never raise.

**Test scenarios:**
- Successful HTML fetch + markdown conversion (mock httpx response)
- Non-HTML content (JSON API response) — passes through unchanged
- HTTP 403 — returns graceful error message
- Timeout — returns graceful error message
- Connection error — returns graceful error message
- Raw mode, small content — returns inline markdown
- Raw mode, large content — writes to cache file, returns file path + warning
- Summarize mode — calls `litellm.acompletion` with correct args, returns LLM response
- Summarize mode with non-HTML content — still sends to LLM (just without conversion)
- Invalid mode — returns error
- Empty URL — returns error

---

### U5. Update `delete_session()` to clean cache

**Goal:** When a session is deleted, also delete its web-fetch cache directory.

**Dependencies:** U4

**Files:**
- `src/stupidex/storage.py` — extend `delete_session()`

**Approach:** After unlinking the session JSON file, add:
```python
import shutil
cache_dir = Path.home() / ".stupidex" / "cache" / "web-fetch" / session_id
if cache_dir.exists():
    shutil.rmtree(cache_dir, ignore_errors=True)
```

This is safe: `ignore_errors=True` handles race conditions and permission issues. The cache directory is session-scoped and contains only tool-generated content.

**Test scenarios:**
- Delete session with cache files — cache directory is removed
- Delete session without cache files — no error
- Delete session with missing cache dir — no error (graceful)

---

### U6. Update `web-researcher` agent

**Goal:** Update the `web-researcher` agent's description and prompt to reflect that web fetching is now available.

**Dependencies:** U4

**Files:**
- `src/stupidex/agents/defaults/web-researcher/AGENT.md` — update

**Approach:** Remove "Web fetching is not available in this environment" from the description and prompt. Add a note that the agent can now use the `web_fetch` tool (or that the caller should use `web_fetch` directly). The web-researcher is a subagent that gets spawned by the main agent — it should know the tool exists in its ecosystem even if it doesn't have direct access (the caller can fetch first, then pass content to the web-researcher).

**Test scenarios:**
- Verify the updated agent loads correctly
- Verify its description no longer mentions web fetching being unavailable

---

## Risks

1. **Tolo context window**: Large pages may exceed the Tolo model's context window. The plan sends full content without truncation — if the model rejects or truncates silently, summarize mode will return incomplete answers. Mitigation: document this as a known limitation; future work can add chunked summarization if needed. **Note:** The raw-mode threshold (10,000 chars) does not apply to summarize mode — the tool trusts the LLM to handle large inputs. If testing reveals failures on very large pages, consider adding a pre-LLM content-size guard that warns the user or falls back to raw mode with a file spill.

2. **Site blocking**: Many sites block `python-httpx` or similar user agents even with a custom header. The tool returns graceful errors but won't retry with different user agents. Out of scope for v1.

3. **html2text edge cases**: Some HTML structures (tables, deeply nested divs) may not convert cleanly to markdown. This is acceptable — the tool returns the best conversion available.

4. **SSRF surface**: The tool fetches arbitrary URLs provided by the LLM agent. Risk is mitigated by: (a) the summarize-mode LLM call is one-shot with no tool access, so prompt injection in fetched content can't trigger secondary actions; (b) `execute_command` already enables arbitrary HTTP via `curl`, so this tool amplifies an existing capability rather than creating a new attack surface; (c) URL scheme validation restricts to http/https only.

5. **Cache file permissions**: Cache files inherit default permissions (0o644) unlike session files which use 0o600 (`storage.py:23`). On multi-user systems, cached web content could be readable by other users. Consider using `0o600` when writing cache files.

---

## Deferred to Implementation

- Choice between `markdownify` and `html2text` — research both during U1 implementation; plan defaults to `html2text` for maturity.
- Exact raw-mode threshold value — start at 10,000 chars, adjust based on testing.
- Whether `web_fetch` should be in `_TOOLS_WITHOUT_TIMEOUT` — likely no, since HTTP fetches should time out, but the existing 60s tool timeout may be too short for slow pages. May need per-tool timeout override.
- Configurable raw-mode threshold in `config.json` — not in v1, easy to add later.
- Whether raw mode threshold should measure pre-conversion HTML size or post-conversion markdown size — affects file size estimate and user expectation.
- Whether to add a per-tool timeout parameter for web_fetch to decouple HTTP fetch + LLM call from the 60s tool timeout.
- Cache file permissions — consider writing with `0o600` instead of default `0o644` for multi-user safety.
