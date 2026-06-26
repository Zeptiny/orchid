---
title: "fix: Close all P1 testing gaps from 2026-06-20 code review sweep"
type: fix
status: active
date: 2026-06-20
---

# fix: Close all P1 testing gaps from 2026-06-20 code review sweep

## Summary

Add direct test coverage for 20 P1-class testing gaps (P1-28 through P1-53, excluding the 6 already fixed) across 7 modules: `domain/`, `llm/`, `agents/`, `mcp/`, `tools/`, `rag/`, and `screens/`. Each gap identifies a function or code path with zero or insufficient direct tests despite branching logic, security-critical guards, or behavioral contracts that must hold. The plan creates 5 new test files and extends 9 existing ones, adding an estimated 180-220 test scenarios total.

---

## Problem Frame

The 2026-06-20 full-codebase code review sweep produced 53 P1 findings, of which 24 are testing-gap findings. Of those 24, the prior P1 fix work (`docs/plans/2026-06-20-001-fix-p1-code-review-findings-plan.md`) closed 6 (P1-35/36/39/40/44/45 — tests came bundled with behavior fixes). **20 testing-gap findings remain unfixed**, spanning every module in the codebase. The sweep summary notes: "Test-coverage findings dominate the P1 bucket (24 of 53) — every reviewer in every module flagged gaps. This is systemic; a test-coverage sprint is the single highest-leverage follow-up after the P0 reliability/security fixes." These gaps leave security-critical code (path traversal guard), behavioral contracts (tool-call-only `content: null` for strict providers), state-machine invariants (subagent callback failure isolation), and core agentic loops (multi-turn `stream_response`) unverified.

---

## Requirements

- R1. Every function identified by a P1 testing-gap finding has direct unit tests covering its documented branches
- R2. Security-critical guards have regression tests (path traversal in `execute_skill`, callback failure isolation, `force=True` stale-data persistence)
- R3. Behavioral contracts documented in source comments or docstrings are pinned by tests (e.g. `content: null` for tool-call-only turns, orphan tool_result reconciliation, `upsert_file` vector/chunk positional alignment)
- R4. Tests follow existing mock patterns per module (no new test infrastructure; reuse `FakeEmbedder`, `MagicMock`-stub Textual, `AsyncMock` litellm, `tmp_path` SQLite)
- R5. All tests pass under `pytest-timeout` 120s deadline; no test requires network, ONNX download, or real LLM API call
- R6. Any bugs discovered during test-writing are documented as findings but NOT fixed in this plan (scope is test coverage only)

**Origin findings:** P1-28, P1-29, P1-30, P1-31, P1-32, P1-33, P1-34, P1-37, P1-38, P1-41, P1-42, P1-43, P1-46, P1-47, P1-48, P1-49, P1-50, P1-51, P1-52, P1-53

---

## Scope Boundaries

- This plan adds tests only — no production code changes unless a test reveals a crash-bug that blocks test execution
- P2/P3 testing findings are out of scope (separate triage)
- P0-1/2/3, P1-12/17/22 (deferred to README TODO) are out of scope
- Bugs discovered during test-writing are documented but not fixed here
- No new test framework dependencies (no pytest-asyncio added to files that don't already use it)

### Deferred to Follow-Up Work

- P2 testing findings (~30 items across all modules): separate test-coverage sprint after P1 gaps close
- `test_llm_client.py` comprehensive module (P1-31/32/33 could eventually outgrow `test_streaming_messages.py`): refactor into dedicated file if `test_streaming_messages.py` exceeds ~2000 lines

---

## Context & Research

### Relevant Code and Patterns

**Domain layer patterns:**
- `tests/test_message.py`: 8 `Usage` forward-compat tests — pure `unittest.TestCase`, no async, direct `Message.from_storage_dict` calls
- `tests/test_streaming_messages.py` (1604 lines): covers `record_streamed_message` via integration with `llm_client._stream_task` — uses `chunk()` helper building `SimpleNamespace` litellm chunks
- `chain.py` has NO direct test file; `_reconcile_orphan_tool_results` is a module-level function with 12 branches

**LLM layer patterns:**
- `litellm.acompletion` is `AsyncMock(side_effect=fake_acompletion)` patched at `stupidex.llm.client.litellm.acompletion`; `fake_acompletion` is an async generator
- `_execute_tool` is monkeypatched by direct attribute assignment (`llm_client._execute_tool = fake`) in try/finally — tests need to call the REAL `_execute_tool` instead
- `build_dynamic_system_prompt` is always `AsyncMock`-replaced in stream_response tests — direct tests need to call the real function with mocked `directory_tree`, `get_subagent_manager`, `get_todo_store`
- Config injection: `Config(providers=...)` + `patch("stupidex.llm.client.get_config", return_value=cfg)` + `patch("stupidex.llm.providers.get_config", return_value=cfg)`

**Agents layer patterns:**
- `tests/test_subagent_manager.py` uses `asyncio.run()` directly (no pytest-asyncio), real `SubagentManager` instances
- Callbacks are `MagicMock(side_effect=AsyncMock())` or `AsyncMock()` — failure-isolation tests can use `side_effect=RuntimeError("boom")`

**MCP layer patterns:**
- `tests/test_mcp_lifecycle.py`: patches `stdio_client` with async context manager mocks; uses `ExitStack` for multi-patch
- `tests/test_mcp_startup_timeout.py`: generous timing bounds (`< 1.5`, `< 4.5`) to avoid CI flake — pattern to mirror
- SSE tests need to patch `sse_client` instead of `stdio_client`

**Tools layer patterns:**
- `tests/test_file_manipulation.py`: uses `tmp_path` for real file I/O, `aiofiles` real reads; `AsyncMock` for post-write callbacks
- `tests/test_skill_tools.py`: pure sync tests for `resolve_skill_dependencies`; executor tests need `tmp_path` for resource files
- `Tool` / `ExecutorResult` contract: `ExecutorResult(display: str, content: str)` — success-vs-error inferred from `content` prefix (`"Error:"` or XML `success="false"`)

**RAG layer patterns:**
- `FakeEmbedder(Embedder)` subclass with md5-based deterministic vectors, `dim=8`
- Real SQLite + real numpy `.npy` on `tmp_path` — no DB mocking
- `pytest.mark.asyncio` used in `test_rag_indexer.py` and `test_rag_incremental.py` (pytest-asyncio is a dev dependency)
- `test_rag_store.py` extends `unittest.TestCase` — no async needed for store methods (all sync)

**Screens layer patterns:**
- `tests/test_settings_screen.py`: direct instantiation (`SettingsScreen(Config())`), `MagicMock` for Textual methods (`dismiss`, `query_one`, `_refresh_tab`), `PropertyMock` for `screen.app`
- No `run_test()` / `AppTest` anywhere — pure-logic unit tests with heavy mocking
- Edit-result tests call `_on_edit_provider_result` directly with crafted `result` dicts

### Institutional Learnings

- `_atomic_write` in `ast.py:222-251` is the canonical atomic write pattern (temp + fsync + os.replace + chmod)
- `web_fetch.py:168-232` is the canonical large-output offload pattern
- `ExecutorResult` has no `success` flag — tests must inspect `content` prefix for error detection

---

## Key Technical Decisions

- **Group by test file, not by finding**: 20 findings map to 14 test files (5 new, 9 extended). Multiple findings in the same source file share mock setup, so co-locating tests reduces fixture duplication. Example: P1-31/32/33 all target `client.py` and share the litellm mock pattern.
- **Follow per-module established async pattern**: `test_rag_indexer.py` and `test_rag_incremental.py` already use `pytest.mark.asyncio`; `test_subagent_manager.py` uses `asyncio.run()`. New tests in each file follow the file's existing pattern — no cross-file standardization.
- **Characterization tests for current behavior**: If a test reveals a bug, the test pins current behavior (with an `# FIXME: finding P1-XX` comment) rather than asserting the ideal. The bug gets documented as a new finding but NOT fixed in this plan — scope is test coverage only.
- **No new test infrastructure**: Reuse existing helpers (`chunk()`, `FakeEmbedder`, `_run_stream`), existing patch targets, existing `tmp_path` patterns. If a helper doesn't exist (e.g. a fake `sse_client`), it's a local test fixture, not a shared conftest addition.
- **`_execute_tool` tests call the real function**: The existing pattern monkeypatches `_execute_tool` to bypass it. New P1-32 tests must import and call the real `_execute_tool` with mocked `filtered_tools` dict and mocked executor functions, so the actual error-path branches are exercised.
- **`stream_response` multi-turn test uses two-round `fake_acompletion`**: Round 1 yields a chunk with `tool_calls` delta (sets `tool_calls_started`), round 2 yields a plain text chunk (loop exits via `not tool_calls_started.is_set()` → return). Asserts `acompletion_mock.call_count == 2` and `len(api_messages)` grew.
- **SSE transport test patches `sse_client`**: Mirror the existing `stdio_client` mock pattern — `AsyncMock` returning `(read_stream, write_stream)` async context manager, with config carrying `"url"` key instead of `"command"`.
- **Path traversal tests use real filesystem**: `tmp_path` with `scripts/`, `references/`, `assets/` subdirs and real files — test `../etc/passwd`, `../../sibling-skill/scripts/x`, `scripts/../foo`, symlink escape, and `is_file()` false branch.
- **Settings rename tests use direct-instantiation pattern**: Call `_on_edit_provider_result` / `_on_edit_mcp_result` with crafted `result` dicts, assert on `screen._config.providers` / `screen._config.mcp_servers`. No `run_test()`.
- **`force=True` deleted-file test**: Create project with 2 files → index → delete 1 file from disk → re-index with `force=True` → assert deleted file's chunks still in store (documents the bug). Then test non-force → assert deleted file's chunks are removed (pins correct behavior).

---

## Implementation Units

- U1. **Domain: Skill.validate() + to_dict() coverage (P1-28)**

**Goal:** Add direct tests for `Skill.validate()` (5 branches), `Skill.to_dict()` (count-collapse contract), and `SkillResource.to_dict()` (description-omission).

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `tests/test_skill_domain.py`
- Reference: `src/stupidex/domain/skill.py`

**Approach:**
- Pure sync `unittest.TestCase` — no async, no mocks needed (validation is a pure function on dataclass fields)
- Test `_NAME_PATTERN` exhaustively: valid single-char (`a`), valid multi-char (`a-b`, `abc123`), leading hyphen (`-foo`), trailing hyphen (`foo-`), both (`-`), uppercase (`Foo`), underscore (`foo_bar`)
- Test `_MAX_NAME_LEN` boundary: exactly 64 (pass), exactly 65 (fail)
- Test `_MAX_DESC_LEN` boundary: exactly 1024 (pass), exactly 1025 (fail)
- Test `to_dict()` omits `content`, collapses `references`/`scripts`/`assets` to integer counts, includes `requires` only when truthy
- Test `SkillResource.to_dict()` includes `description` only when truthy

**Test scenarios:**
- Happy path: `Skill(name="valid-name", description="desc", location="/x")` → `validate()` returns `None`
- Edge case: name length 64 boundary → returns `None`; length 65 → returns error string
- Edge case: description length 1024 boundary → `None`; 1025 → error
- Edge case: single-char name `"a"` → `None` (pattern allows it)
- Edge case: leading hyphen `"-foo"` → returns pattern error
- Edge case: trailing hyphen `"foo-"` → returns pattern error
- Edge case: uppercase `"Foo"` → returns pattern error
- Edge case: underscore `"foo_bar"` → returns pattern error
- Edge case: empty name `""` → returns length error
- Edge case: name is not str (e.g. `None`) → returns type error
- Edge case: description not str → returns type error
- Happy path: `to_dict()` with empty `requires` → `"requires"` key omitted
- Happy path: `to_dict()` with populated `references` → value is `len(references)` (integer, not list of dicts)
- Happy path: `to_dict()` does NOT emit `"content"` key at all
- Happy path: `SkillResource(description="")` → `to_dict()` omits `description`
- Happy path: `SkillResource(description="x")` → `to_dict()` includes `description`

**Verification:**
- `test_skill_domain.py` has ≥15 tests, all pass under `pytest tests/test_skill_domain.py -v`

---

- U2. **Domain: _reconcile_orphan_tool_results coverage (P1-29)**

**Goal:** Add direct tests for `_reconcile_orphan_tool_results()` covering all 12 branches (orphan drop, seen-id registration, None-id survival, duplicate tool_result survival, ordering-sensitivity, no-op identity, mutation convergence).

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `tests/test_chain.py`
- Reference: `src/stupidex/domain/chain.py`

**Approach:**
- Pure sync `unittest.TestCase` — `_reconcile_orphan_tool_results` is a module-level function taking `list[Message]` and mutating in place
- Build `Message` objects via `Message(role=MessageRole.ASSISTANT, type=MessageType.TEXT, content="...", tool_calls=[{"id": "tc1", "function": {"name": "x", "arguments": "{}"}}])` and `Message(role=MessageRole.TOOL, type=MessageType.TOOL_RESULT, content="result", tool_call_id="tc1")`
- Assert list identity preserved (`messages` is the same object after call) and contents replaced when orphans pruned
- Verify `len(keep) == len(messages)` no-op path does NOT clear/extend (identity check via `messages is messages`)

**Test scenarios:**
- Edge case (E1): empty list `[]` → no mutation, returns early
- Happy path (E3+E5): assistant with `tool_calls[0]["id"]="tc1"` followed by TOOL_RESULT `tool_call_id="tc1"` → both kept
- Happy path (E2): TOOL_RESULT with `tool_call_id="unknown"` and no preceding assistant → dropped, `len(messages)` decreases
- Edge case (E4): assistant `tool_calls` entry without `"id"` key → not added to seen-set, msg still kept
- Edge case (E6): TOOL_RESULT with `tool_call_id=None` → NOT dropped (falsy `tool_call_id` short-circuits the `and`), kept
- Edge case (E8): two TOOL_RESULTs with same `tool_call_id="tc1"` where tc1 IS in seen-set → both kept (no dedup)
- Edge case (E9): TOOL_RESULT appears BEFORE the assistant tool_calls that should pair it → dropped (ordering matters)
- Edge case (E7): multiple orphans with different unknown ids → each dropped individually
- Happy path (E10): no orphans in list → `len(messages)` unchanged, list identity preserved (no `del`/`extend`)
- Happy path (E11): orphans present → `del messages[:]` + `messages.extend(keep)` — list object identity preserved, contents replaced
- Happy path (E12): non-tool, non-tool_calls message (user/system/text) → falls through both `if`s, appended to `keep`
- Integration: full round-trip — `Chain.to_storage_dict()` → `Chain.from_storage_dict()` with a pre-corrupted message list containing an orphan → reconcile runs during load, orphan is pruned

**Verification:**
- `test_chain.py` has ≥12 tests, all pass

---

- U3. **Domain: Message.to_dict() content=null contract (P1-30)**

**Goal:** Add direct unit tests for `Message.to_dict()` branches D1-D6, pinning the `content: null` contract for tool-call-only turns and deep-copy-of-tool_calls contract.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_message.py` (existing, 114 lines)
- Reference: `src/stupidex/domain/message.py`

**Approach:**
- Add a new `TestMessageToDict` test class to the existing `test_message.py`
- D2 is the critical contract: assistant + `tool_calls` truthy + `content=""` → `content: None` in output dict (OpenAI strict-provider requirement)
- Deep-copy test: mutate `to_dict()["tool_calls"][0]` and verify original `Message.tool_calls[0]` is unaffected
- D4: TOOL role with empty `content=""` → `content` stays `""` (NOT coerced to None)

**Test scenarios:**
- Happy path (D1): assistant + tool_calls + non-empty content → `content` is the string, `tool_calls` present
- Happy path (D2): assistant + tool_calls + empty content → `content` is `None` (the strict-provider contract)
- Happy path (D3): assistant + no tool_calls + empty content → `content` is `""` (NOT None — only tool_calls turns get null)
- Happy path (D4): TOOL role + empty content → `content` is `""` (preserved, not null-coerced)
- Happy path (D5): USER role + content → `content` is the string identity
- Happy path (D6): SYSTEM role + content → `content` is the string identity
- Edge case: `tool_call_id` truthy → included in dict; falsy/empty → omitted
- Edge case: `tool_calls` deep-copy — mutate returned dict's `tool_calls[0]["function"]["arguments"]`, assert original `Message.tool_calls[0]["function"]["arguments"]` unchanged
- Integration: `to_dict()` → feed into `_history_to_api_messages` indirectly (already tested in streaming, but pin the direct dict shape)

**Verification:**
- `test_message.py` has ≥9 new tests in `TestMessageToDict`, plus existing 8 Usage tests still pass

---

- U4. **LLM: _validate_tool_args + _execute_tool error branches (P1-32, P1-33)**

**Goal:** Add direct tests for `_validate_tool_args()` (unknown params, missing required) and `_execute_tool()` (JSONDecodeError, args-not-dict, unknown tool, validation failure, TimeoutError, generic Exception, `_TOOLS_WITHOUT_TIMEOUT` bare-call branch).

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_streaming_messages.py` (existing, 1604 lines)
- Reference: `src/stupidex/llm/client.py`

**Approach:**
- Add two new test classes to the existing file: `TestValidateToolArgs` and `TestExecuteToolErrorPaths`
- `_validate_tool_args` is a pure function — build `Tool` objects with `ToolParameters(properties=..., required=...)` and call directly
- `_execute_tool` requires `filtered_tools: dict[str, dict]` with `"tool"` and `"executor"` keys; mock executor as `AsyncMock` or `AsyncMock(side_effect=asyncio.TimeoutError())`
- For TimeoutError test: mock executor with `side_effect=asyncio.TimeoutError()`, assert `result.content` contains "timed out"
- For generic Exception test: mock executor with `side_effect=RuntimeError("boom")`, assert `result.content` contains "internal error"
- For `_TOOLS_WITHOUT_TIMEOUT` branch: use a tool name that's in the set (e.g. `"wait_for_subagent"`), mock executor sleeps, assert no timeout wrapper

**Test scenarios:**
- _validate_tool_args:
  - Happy path: all required params present, no unknown → returns `None`
  - Error path: unknown param `"foo"` in args → returns string starting `"Unknown parameters:"`
  - Error path: missing required param → returns `"Missing required parameter: <name>"`
  - Edge case: empty `args={}` with no required params → `None`
  - Edge case: empty `args={}` with required params → returns missing-required error
- _execute_tool:
  - Error path (JSONDecodeError): `tc["function"]["arguments"] = "not json"` → result content contains "Could not parse"
  - Error path (args-not-dict): `tc["function"]["arguments"] = "[1,2,3]"` → result content contains "must be a JSON object"
  - Error path (unknown tool): `tc["function"]["name"] = "nonexistent"` → result content contains "does not exist"
  - Error path (validation failure): tool exists but `_validate_tool_args` returns error → result content starts with "Error:"
  - Error path (TimeoutError): executor raises `asyncio.TimeoutError()` → result content contains "timed out"
  - Error path (generic Exception): executor raises `RuntimeError("boom")` → result content contains "internal error"
  - Happy path: executor returns `ExecutorResult(display="ok", content="result")` → `Message` with `role=TOOL`, `content="result"`
  - Happy path (`_TOOLS_WITHOUT_TIMEOUT`): tool name in set → bare `await executor(**args)`, no timeout wrap
  - Edge case: returned `Message.tool_call_id` matches `tc["id"]`

**Verification:**
- ≥15 new tests across the two classes, all pass under existing `test_streaming_messages.py` run

---

- U5. **LLM: stream_response multi-turn tool-call loop (P1-31)**

**Goal:** Add a test that exercises the outer `while True` loop in `stream_response` — model emits tool_calls, executor appends results to `api_messages`, loop re-issues `acompletion`, second round has no tool calls, loop exits via `return`.

**Requirements:** R1, R3

**Dependencies:** U4 (shares mock patterns)

**Files:**
- Modify: `tests/test_streaming_messages.py` (existing)
- Reference: `src/stupidex/llm/client.py`

**Approach:**
- Add `TestStreamResponseMultiTurn` class
- `fake_acompletion` is a stateful `AsyncMock` with `call_count` tracking: round 1 yields `chunk(tool_calls=[tool_delta(0)])`, round 2 yields `chunk(content="done", usage=Usage(1,2,3))`
- `_execute_tool` monkeypatched to return a preset `Message(role=TOOL, type=TOOL_RESULT, ...)` (the existing pattern)
- Assert: `acompletion_mock.call_count == 2`, the consumer received both the tool-call round and the final text round, `tool_calls_started` was set in round 1
- Assert: `api_messages` grew by 2 entries between rounds (assistant tool_calls + tool result)

**Test scenarios:**
- Happy path: two-round loop — round 1 tool_calls → executor → round 2 text → loop exits → assert `call_count == 2`
- Happy path: single-round (no tool calls) → loop exits immediately → `call_count == 1` (regression to existing pattern)
- Edge case: round 1 tool_calls, round 2 also has tool_calls → loop continues to round 3 with text → `call_count == 3`
- Integration: assert `api_messages` contains assistant tool_calls dict + tool result dict in correct order after multi-turn

**Verification:**
- ≥3 new tests, all pass; `acompletion_mock.call_count` assertions pin multi-turn behavior

---

- U6. **LLM: build_dynamic_system_prompt coverage (P1-34)**

**Goal:** Add direct tests for `build_dynamic_system_prompt()` — TTL cache hit/miss, subagents block (with/without task), todos block (with/without description/subagent_id), XML escaping.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `tests/test_dynamic_system_prompt.py`
- Reference: `src/stupidex/llm/dynamic_system_prompt.py`

**Approach:**
- Use `pytest.mark.asyncio` (matches RAG test pattern for async)
- Mock `get_config()` to return a config with `directory_tree_depth=2`
- Mock `directory_tree` with `patch("stupidex.llm.dynamic_system_prompt.directory_tree", ...)` — return a fixed string
- Mock `get_subagent_manager()` to return a manager with `get_states()` returning crafted subagent dicts
- Mock `get_todo_store()` to return a store with `list()` returning crafted `TodoTask` objects
- TTL cache: call twice within 5s, assert `directory_tree` called only once; wait >5s (or patch `_TREE_TTL=0.01`), assert called twice
- Reset module-level `_TREE_CACHE` to `None` between tests

**Test scenarios:**
- Happy path: no subagents, no todos → output has `<current_time>`, `<working_directory>`, `<directory_structure>` but no `<subagents>` or `<todos>` blocks
- Happy path: subagents present with task → `<subagents>` block contains `<subagent>` with `<task>` subelement
- Happy path: subagents present without task → `<subagent>` has no `<task>` subelement
- Happy path: todos present with description → `<todo>` contains `<description>`
- Happy path: todos present without description → `<todo>` lacks `<description>`
- Happy path: todos present with `subagent_id` → `<subagent_id>` element present
- Edge case: TTL cache hit — second call within window → `directory_tree` NOT called, cached tree returned
- Edge case: TTL cache miss — cache expired → `directory_tree` called again
- Edge case (security): todo title with XML special chars (`<script>`) → escaped in output (`&lt;script&gt;`)
- Edge case: subagent task text with XML chars → escaped
- Edge case: subagent name/type with XML chars → escaped

**Verification:**
- ≥11 new tests in `test_dynamic_system_prompt.py`, all pass

---

- U7. **Agents: wait() edge cases + callback failure isolation (P1-37, P1-38)**

**Goal:** Add tests for `wait()` with empty input and all-unknown IDs, and pin the `except Exception: pass` failure-isolation behavior in `on_message` / `on_state_change` callbacks.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_subagent_manager.py` (existing, 644 lines)
- Reference: `src/stupidex/agents/manager.py`

**Approach:**
- Add tests to existing `TestSubagentManager` or a new `TestWaitEdgeCases` class
- `wait([])` → returns `{}` immediately, no `gather` called
- `wait(["unknown1", "unknown2"])` → returns `{}`, no tasks awaited
- Callback failure isolation: `on_message = AsyncMock(side_effect=RuntimeError("boom"))` — stream continues, `messages_mounted` still increments, no exception propagates
- Callback failure isolation: `on_state_change = AsyncMock(side_effect=RuntimeError("boom"))` — `_fire_and_forget` wraps it, `_log_task_exception` swallows, `_run` continues to completion

**Test scenarios:**
- wait():
  - Happy path: `wait([])` → returns `{}`, no tasks awaited
  - Edge case: `wait(["nonexistent"])` → returns `{}` (unknown IDs silently dropped)
  - Edge case: `wait(["done-id", "unknown-id"])` → returns `{"done-id": record}`, done task not awaited
- callback failure isolation:
  - Happy path: `on_message` raises RuntimeError → stream continues, `messages_mounted` correct, no exception in `_run`
  - Happy path: `on_state_change` raises RuntimeError → `_fire_and_forget` swallows via `_log_task_exception`, `_run` completes normally
  - Edge case: `on_message` raises for the FIRST message but not subsequent → second message still processed, counter correct
  - Edge case: `on_state_change` raises during RUNNING transition → COMPLETED transition still fires (not blocked by prior failure)

**Verification:**
- ≥6 new tests, all pass; `test_subagent_manager.py` total now ≥28 tests

---

- U8. **MCP: SSE transport + start_all error propagation (P1-41, P1-42, P1-43)**

**Goal:** Add tests for the SSE transport branch in `_connect_server`, the `_start_error` re-raise path in `start_all`, and the per-server failure recovery + catastrophic-failure capture in `_run`.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_mcp_lifecycle.py` (existing, 201 lines)
- Reference: `src/stupidex/mcp/__init__.py`

**Approach:**
- SSE test: `patch("stupidex.mcp.sse_client", new=AsyncMock(...))` returning `(read_stream, write_stream)` async context manager; config with `"url": "http://localhost:8080/sse"`; assert `sse_client` called with `url=`, assert session registered, tools loaded
- `_start_error` re-raise: mock `_run` to set `self._start_error = RuntimeError("catastrophic")` before `_ready.set()` → `start_all` re-raises `RuntimeError`
- Per-server failure recovery: already partially tested by `test_mcp_startup_timeout.py` (per-server timeout → continue), but the `except BaseException` capture (L129) → `_start_error` → re-raise in `start_all` (L113-116) is NOT tested — needs a test that forces `exit_stack.__aenter__` to raise, asserting `start_all` re-raises

**Test scenarios:**
- SSE transport:
  - Happy path: config with `"url"` → `sse_client` called (not `stdio_client`), session registered, tools discovered
  - Edge case: SSE server fails `initialize()` → marked `"failed"`, other servers continue
- start_all error propagation:
  - Error path: `_run` captures `BaseException` into `_start_error` → `start_all` re-raises it
  - Error path: `_run` captures non-timeout `Exception` → `start_all` re-raises (not swallowed)
- Per-server recovery:
  - Happy path: two servers, second fails with `Exception` → first still `"connected"`, second `"failed"`, `start_all` does NOT raise (per-server isolation works)
  - Edge case: `start_all` with empty `servers={}` → completes immediately, no runner spawned
- Integration: config-load failure swallow (`get_config()` raises) → defaults used, startup proceeds

**Verification:**
- ≥7 new tests, all pass; `test_mcp_lifecycle.py` total now ≥10 tests

---

- U9. **Tools: execute_skill resource-read path traversal guard (P1-46)**

**Goal:** Add security-critical regression tests for `_execute_resource_read` path traversal guard and allowlist enforcement.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_skill_tools.py` (existing, 89 lines)
- Reference: `src/stupidex/tools/skill.py`

**Approach:**
- Use `tmp_path` to create real skill directories with `scripts/`, `references/`, `assets/` subdirs and real files
- Build `Skill` objects with `location=str(tmp_path / "skill.md")`
- Build the registry dict and `allowed_skills` set manually
- Test traversal attempts: `../../etc/passwd`, `../sibling/scripts/x`, `scripts/../../etc/passwd`
- Test allowlist violations: `scripts/../foo` (resolves outside `scripts/` but inside `skill_dir` — fails allowlist), `content/secret` (not in allowlist dirs)

**Test scenarios:**
- Happy path: `scripts/run.sh` within skill dir → file content returned
- Happy path: `references/doc.md` → file content with frontmatter stripped
- Happy path: `assets/icon.png` → file content returned
- Security: `../../etc/passwd` → "Path traversal rejected" error
- Security: `../sibling-skill/scripts/x` → "Path traversal rejected" (escapes skill_dir)
- Security: `scripts/../../etc/passwd` → passes traversal check (resolves to skill_dir) but fails allowlist (not in scripts/references/assets) → "Resource not in allowed directory"
- Security: `content/secret` → "Resource not in allowed directory" (not in allowlist)
- Edge case: resource file doesn't exist (`scripts/missing.sh`) → "Resource not found"
- Edge case: `OSError` during read → error `ExecutorResult` (not raised)
- Edge case: skill not in registry → "Unknown skill" error
- Edge case: skill in registry but not in `allowed_skills` → "not available" error
- Happy path: `execute_list_skills()` with empty registry → `"<skills />"`
- Happy path: `execute_list_skills()` with populated registry → `<skills>` block with count attributes

**Verification:**
- ≥13 new tests, all pass; `test_skill_tools.py` total now ≥18 tests

---

- U10. **Tools: subagent executors (P1-47)**

**Goal:** Add tests for all four subagent tool executors: `execute_delegate_to_subagent`, `execute_wait_for_subagent`, `execute_list_subagents`, `execute_interrupt_subagents`.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `tests/test_subagent_tools.py`
- Reference: `src/stupidex/tools/subagent.py`, `src/stupidex/agents/manager.py`

**Approach:**
- Mock `get_subagent_manager()` to return a mock `SubagentManager` with controlled `spawn()`, `wait()`, `get_states()`, `cancel_one()`, `cancel_running()`, `cancel_all()` return values
- Assert on `ExecutorResult.content` XML structure (`<subagent>`, `<subagents>`, `<not_found>` blocks)
- `delegate_to_subagent`: test unknown agent type, invalid tier, `tier=None` default, happy path
- `wait_for_subagent`: test empty list, empty result dict, missing IDs, per-record formatting (result/error/no-result)
- `list_subagents`: test empty states, non-empty formatting
- `interrupt_subagents`: test empty list → `cancel_running()`, per-id loop (cancelled/already_done/not_found buckets), all-not-found case

**Test scenarios:**
- delegate_to_subagent:
  - Error path: unknown agent type → content contains "Available agents:"
  - Error path: invalid tier string → content contains error
  - Happy path: `tier=None` → uses agent's default tier, spawn called
  - Happy path: valid spawn → content contains `<subagent` element
- wait_for_subagent:
  - Error path: empty `subagent_ids=[]` → error result
  - Happy path: wait returns records → content lists each with result/error
  - Edge case: some IDs missing from returned dict → `<not_found>` block present
  - Edge case: all IDs missing → "No subagents found" message
- list_subagents:
  - Happy path: empty states → `<subagents />`
  - Happy path: populated states → `<subagents>` with `<subagent>` elements
  - Edge case: subagent with task → `<task>` block present
- interrupt_subagents:
  - Happy path: empty list → `cancel_running()` called (interrupt ALL)
  - Happy path: per-id with mixed results (cancelled/already_done/not_found) → three-bucket formatting
  - Edge case: all IDs not_found → "No subagents matched."

**Verification:**
- ≥15 new tests, all pass

---

- U11. **Tools: todo executors (P1-48)**

**Goal:** Add tests for all four todo tool executors: `execute_todo_create`, `execute_todo_update`, `execute_todo_list`, `execute_todo_delete`.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Create: `tests/test_todo_tools.py`
- Reference: `src/stupidex/tools/todo.py`, `src/stupidex/domain/todo.py`

**Approach:**
- Mock `get_todo_store()` to return a real `TodoStore` (the domain is well-tested; use real store for integration) or a mock with controlled `create/update/list/delete` returns
- Mock `notify_todo_changed()` as `AsyncMock()` to verify call ordering (only after success)
- Assert on `ExecutorResult.content` structure

**Test scenarios:**
- execute_todo_create:
  - Happy path: title only → task created, content contains id/title/status
  - Happy path: title + description + subagent_id → all fields set
  - Edge case: `description=None` → coerced to `""`
- execute_todo_update:
  - Error path: invalid status string → error result
  - Happy path: update title only → changes list contains title
  - Happy path: update status → changes list contains status
  - Error path: `store.update` returns error → error result propagated
  - Edge case: update on terminal task → error from store
- execute_todo_list:
  - Happy path: no filter → all tasks listed
  - Happy path: filter by status → only matching tasks
  - Edge case: empty result → "No tasks match"
  - Edge case: description >100 chars → truncated in output
  - Error path: invalid status filter → error result
- execute_todo_delete:
  - Happy path: existing task → deleted, `notify_todo_changed` called
  - Error path: nonexistent task → "Task not found"
  - Edge case: `notify_todo_changed` NOT called on failure path

**Verification:**
- ≥13 new tests, all pass

---

- U12. **Tools: file_manipulation read/glob/directory executors (P1-49)**

**Goal:** Add tests for `execute_read_tool`, `execute_glob_tool`, `execute_read_directory_tool` — the three executors with zero direct coverage.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_file_manipulation.py` (existing, 99 lines)
- Reference: `src/stupidex/tools/file_manipulation.py`

**Approach:**
- Use `tmp_path` with real files and directories
- `execute_read_tool`: create a file with N lines, test offset/limit, empty file, offset-out-of-range, exception swallow (unreadable file)
- `execute_glob_tool`: create files matching a pattern, test `include_hidden`, no-matches, directory marking, error swallow
- `execute_read_directory_tool`: create a tree, test `max_depth=None` config fallback, `include_hidden`, error swallow

**Test scenarios:**
- execute_read_tool:
  - Happy path: read full file → content has `"N | line"` format, display has line range
  - Happy path: `offset=3, limit=2` → only lines 3-4
  - Edge case: `limit=None` → falls back to config `read_line_limit`
  - Edge case: empty file → "is empty" result
  - Edge case: `offset > line_count` → "offset out of range"
  - Error path: unreadable file (chmod 000) → error `ExecutorResult` (not raised)
- execute_glob_tool:
  - Happy path: `pattern="*.py"` matches files → content lists paths
  - Happy path: recursive `pattern="**/*.py"` → nested matches
  - Edge case: `include_hidden=False` → `.hidden` files excluded
  - Edge case: no matches → "No files found"
  - Edge case: matches include directories → trailing `/` marker
  - Error path: nonexistent directory → error `ExecutorResult`
- execute_read_directory_tool:
  - Happy path: tree with depth 2 → content is directory tree string
  - Edge case: `max_depth=None` → config fallback
  - Edge case: `include_hidden=True` → `.git` included
  - Error path: nonexistent directory → error `ExecutorResult`

**Verification:**
- ≥15 new tests, all pass; `test_file_manipulation.py` total now ≥21 tests

---

- U13. **RAG: update_file + force=True deleted files (P1-50, P1-52)**

**Goal:** Add direct tests for `update_file()` (6 branches) and `force=True` re-index behavior with deleted files (pinning the bug where stale entries persist).

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_rag_indexer.py` (existing)
- Reference: `src/stupidex/rag/indexer.py`

**Approach:**
- Use `FakeEmbedder` (existing pattern in `test_rag_indexer.py`) and `tmp_path` with real files
- `update_file`: create a project, index it, then call `update_file` on a single file with various conditions
- `force=True` deleted files: index project with 2 files, delete 1 from disk, re-index with `force=True`, assert deleted file's chunks still in store (pins the bug). Then test non-force → assert removed (pins correct behavior).
- Use `pytest.mark.asyncio`

**Test scenarios:**
- update_file:
  - Happy path (B6): file changed → `upsert_file` + `update_file_hash` called, chunks updated
  - Edge case (B1): file outside project path → no-op, `relative_to` raises `ValueError`
  - Edge case (B2): file extension not in INCLUDE_EXTS → `delete_by_file` called, return
  - Edge case (B3): file is binary (contains `\0`) → `delete_by_file` called, return
  - Edge case (B4): file produces 0 chunks → `delete_by_file` called, return
  - Error path (B5): embedding raises → warning logged, store untouched
- force=True deleted files:
  - Happy path: index 2 files, delete file B, `force=True` re-index → file A re-indexed, file B chunks still in store (BUG — pin with `# FIXME: P1-52` comment)
  - Happy path (regression): index 2 files, delete file B, non-force re-index → file B chunks removed (correct behavior)
  - Edge case: `force=True` with no deletions → all files re-indexed
  - Edge case: `force=True` on empty project → no error

**Verification:**
- ≥10 new tests, all pass; file B persistence test has `# FIXME: P1-52` comment documenting the bug

---

- U14. **RAG: upsert_file vector-rebuild edge cases (P1-51)**

**Goal:** Add tests for `RAGStore.upsert_file` vector-rebuild logic — empty-chunks stub branch, vector-reuse for surviving chunks, vector/chunk positional alignment after mixed delete+insert.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_rag_store.py` (existing)
- Reference: `src/stupidex/rag/store.py`

**Approach:**
- Use real SQLite + real numpy `.npy` on `tmp_path` (existing pattern)
- `upsert_file` with empty chunks → assert `files` table has stub row with `chunk_count=0, hash=''`
- `upsert_file` on existing file → assert surviving chunks from OTHER files retain their vectors (positional alignment after rebuild)
- `upsert_file` twice on same file → second call replaces first's chunks, vectors realigned

**Test scenarios:**
- Happy path: `upsert_file("f1", [chunk1], [vec1])` then `upsert_file("f2", [chunk2], [vec2])` → both files' chunks in store, vectors.npy has 2 vectors in chunk_id order
- Happy path (vector reuse): `upsert_file("f1", [c1, c2], [v1, v2])` then `upsert_file("f2", [c3], [v3])` → f1's vectors reused (same values), f2's vector appended
- Edge case (empty chunks): `upsert_file("f1", [], [])` → `files` row exists with `chunk_count=0, hash=''`, no chunks inserted
- Edge case (replace existing): `upsert_file("f1", [c1, c2], [v1, v2])` then `upsert_file("f1", [c3], [v3])` → f1 now has 1 chunk, total chunks in store = 1, vectors.npy has 1 vector
- Edge case (no old vectors): `upsert_file` when vectors.npy doesn't exist → `id_to_vec={}`, all chunks use new embeddings
- Edge case (vector mismatch): old_ids and old_vectors have different lengths → `id_to_vec={}`, all chunks use new embeddings
- Integration: `upsert_file` then `delete_by_file` then `upsert_file` again → vectors realigned correctly

**Verification:**
- ≥7 new tests, all pass; `test_rag_store.py` total now ≥16 tests

---

- U15. **Screens: provider/MCP rename flow (P1-53)**

**Goal:** Add tests for `_on_edit_provider_result` and `_on_edit_mcp_result` rename paths — in-place rename, rename-to-existing (silent overwrite), same-alias (no-op), and missing `_alias` key edge cases.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `tests/test_settings_screen.py` (existing, 846 lines)
- Reference: `src/stupidex/screens/settings.py`

**Approach:**
- Follow existing pattern: direct instantiation (`SettingsScreen(Config())`), `MagicMock` for `_refresh_tab`, assert on `screen._config.providers` / `screen._config.mcp_servers`
- Call `_on_edit_provider_result(result={"_alias": "new", "models": []}, original_alias="old")` directly
- Rename-to-existing: pre-populate `providers["existing"]`, edit "old" → "existing" → assert "existing" overwritten (pin with `# FIXME: P1-53` comment documenting the silent-overwrite bug)

**Test scenarios:**
- _on_edit_provider_result:
  - Happy path: rename "old" → "new" → `providers` has "new", "old" removed
  - Happy path: same alias (no rename) → "old" overwritten in place, no pop
  - Edge case: rename to existing alias "other" → "other" silently overwritten, original "other" lost (pin as `# FIXME: P1-53`)
  - Edge case: `original_alias=None` → no pop, just insert
  - Edge case: `result={"models": []}` without `_alias` key → `KeyError` (pin current behavior)
  - Happy path: providers dict dirty flag set after edit
- _on_edit_mcp_result:
  - Happy path: rename "old" → "new" → `mcp_servers` has "new", "old" removed
  - Happy path: same name (no rename) → overwritten in place
  - Edge case: rename to existing name → silent overwrite (pin as `# FIXME: P1-53`)

**Verification:**
- ≥9 new tests, all pass; `test_settings_screen.py` total now ≥55+ tests

---

## System-Wide Impact

- **Interaction graph:** No production code changes — tests are additive. Test imports may increase module load time slightly during `pytest --collect-only`.
- **Error propagation:** Tests that pin bugs use `# FIXME: P1-XX` comments — they assert current (buggy) behavior, not ideal behavior. This ensures the test suite passes while documenting the gap for a future fix.
- **State lifecycle risks:** Module-level mutable state (`_TREE_CACHE` in `dynamic_system_prompt.py`, `_indexing` flag in `indexer.py`) must be reset between tests to prevent cross-test contamination. Use `setUp`/`tearDown` or `pytest` fixtures.
- **API surface parity:** No API changes — tests exercise existing function signatures.
- **Integration coverage:** U5 (multi-turn `stream_response`) and U8 (MCP SSE) are the closest to integration tests — they exercise real `asyncio` task orchestration with mocked external boundaries (litellm, MCP SDK transport).
- **Unchanged invariants:** All existing 608 tests remain passing — new tests are additive, no existing test file is refactored beyond adding classes/methods.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `stream_response` multi-turn test is complex (two-round `fake_acompletion`, `_executor_task` + `_stream_task` orchestration) | Follow existing `_run_stream` helper pattern from `test_streaming_messages.py`; if too complex, split into a focused test that only asserts `acompletion_mock.call_count == 2` without asserting message content |
| `_execute_tool` tests need real `filtered_tools` dict with valid `Tool` objects | Build minimal `Tool` fixtures in the test class; reuse `ToolParameters` / `Tool` dataclasses from `domain/tool.py` |
| SSE transport test needs a mock `sse_client` async context manager | Mirror the existing `stdio_client` mock pattern from `test_mcp_lifecycle.py` — same structure, different patch target |
| `build_dynamic_system_prompt` tests need to reset module-level `_TREE_CACHE` | `setUp` sets `dynamic_system_prompt._TREE_CACHE = None` before each test |
| `update_file` tests need a real indexed project to test the delete-by-file branches | Use `FakeEmbedder` + `tmp_path` — create a project dir, `index_project()` first, then call `update_file` on individual files |
| `force=True` deleted-file test pins a BUG (stale entries persist) | Test asserts current behavior with `# FIXME: P1-52` comment; if the bug is fixed later, the test will fail and can be updated to assert correct behavior |
| Settings rename tests pin the silent-overwrite bug (rename to existing alias) | Test asserts current behavior with `# FIXME: P1-53` comment |
| Test count growth (~180-220 new tests) may slow CI | All tests are unit tests with mocks — no network, no ONNX. `pytest-timeout` 120s deadline is per-test, not per-suite. Suite time should grow by <15s. |

---

## Sources & References

- **Origin document:** `2026-06-20-full-sweep-all-findings.md` (project root) — P1 testing-gap section, lines 82-112
- **Prior P1 fix plan:** `docs/plans/2026-06-20-001-fix-p1-code-review-findings-plan.md`
- **P0 verification plan:** `docs/plans/2026-06-20-p0-verification-and-fix-plan.md`
- Related code: `src/stupidex/domain/{skill,chain,message}.py`, `src/stupidex/llm/{client,dynamic_system_prompt}.py`, `src/stupidex/agents/manager.py`, `src/stupidex/mcp/__init__.py`, `src/stupidex/tools/{skill,subagent,todo,file_manipulation}.py`, `src/stupidex/rag/{indexer,store}.py`, `src/stupidex/screens/settings.py`
- Related tests: `tests/test_{message,streaming_messages,subagent_manager,mcp_lifecycle,skill_tools,file_manipulation,rag_indexer,rag_store,settings_screen}.py`
