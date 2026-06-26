---
title: "fix: Resolve P0/P1/P2 branch review findings from 2026-06-20 multi-agent review"
type: fix
status: active
date: 2026-06-20
origin: docs/code-review-reports/2026-06-20-branch-review.md
---

# Fix P0/P1/P2 Branch Review Findings + Migrate P3/Testing Gaps

## Summary

Fix the 1 P0, 8 P1s, and 5 P2s surfaced by the 11-reviewer multi-agent code review of branch `fix/a_lot_of_things`. The findings cluster around two critical areas: (1) the LLM stream-idle retry path that doesn't roll back partial `api_messages` mutations and can't retry transient HTTP errors, and (2) the tool-output offload pattern that only works within a single turn and blocks the event loop. Additional fixes address RAG per-file vector-load regression, MCP startup-timeout orphaned tools, missing test coverage for the mount lock, and several smaller correctness issues.

## Problem Frame

The branch `fix/a_lot_of_things` closed 53 P1 findings and added 172 tests, but the multi-agent review (`docs/code-review-reports/2026-06-20-branch-review.md`) found that the P0-5/P1-9/P1-11 stream-idle retry work **does not actually close the failure modes it claims to**: retry doesn't roll back `api_messages`, `litellm.acompletion()` has no timeout, and transient 429/502 errors are not retried. The P1-4 tool-output offload **only protects within a single turn** — `_history_to_api_messages` re-expands full content on the next turn — and the offload function runs blocking file I/O on the event loop. These are not edge cases: a stalled LLM stream that already delivered partial content will silently duplicate output or 400 on retry, and any large tool output will re-blow the context window on the next user turn.

---

## Requirements

- R1. Stream-idle retry must not duplicate already-delivered messages or send malformed `api_messages` to the provider on retry.
- R2. `litellm.acompletion()` connect phase must be bounded by a timeout; transient HTTP errors (429/502/503) must be retried with backoff.
- R3. RAG incremental index must not do a full `vectors.npy` load+save per changed file.
- R4. `commit_assistant_with_tool_calls` in-place filter must not shift list indices or re-inject empty-id/name placeholders into the anchored assistant message.
- R5. Tool-output offload must persist the pointer (not full content) on the `TOOL_RESULT` `Message` so `_history_to_api_messages` emits trimmed content across turns.
- R6. `_maybe_offload_tool_output` must not block the event loop — cache writes must go through `run_in_executor`.
- R7. `TestShadowWarning` must exercise the real `_connect_server` code path, not re-implement the guard inside the test body.
- R8. `llm_stream_idle_timeout` validation must use `_check_positive_float` like its sibling fields.
- R9. SubagentUIManager mount lock must have test coverage.
- R10. MCP startup timeout must clear `self._tools` (not just `self._sessions`) to avoid orphaned tool entries advertised to the LLM.
- R11. Settings rename rejection must not silently persist edited fields under the original key — either restore the original entry unchanged or surface a confirmation.
- R12. Tool-output cache must be garbage-collected on session delete.
- R13. `_mount_locks` dict must evict entries when subagents are cancelled/completed.
- R14. Tool-output cache pointer must escape the filesystem path in XML-like framing.
- R15. All P3 findings and testing gaps from the branch review must be appended to `2026-06-20-full-sweep-all-findings.md`.

---

## Scope Boundaries

- **Deferred to follow-up**: P0-1 (SSRF allowlist), P0-2 (shell=True), P0-3 (workspace path confinement) — these are already tracked in `README.md` TODO and are prerequisites for a complete fix of P1-E's offload-recovery path (see Risks).
- **Out of scope**: The `wait_for_subagent` unbounded timeout (P2 residual risk) — tracked in the branch review's residual risks, not a primary finding.
- **P3/testing gaps**: Moved to `2026-06-20-full-sweep-all-findings.md`, not fixed in this plan.

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/llm/client.py:647-744` — `stream_response` outer/inner retry loop; `api_messages` shared by reference across `_stream_task` and `_executor_task`
- `src/stupidex/llm/client.py:449-505` — `commit_assistant_with_tool_calls` closure; in-place `tool_calls[:] = [...]` filter at L476; append to `api_messages` at L486/L497
- `src/stupidex/llm/client.py:619-644` — `_executor_task`; tool result appended to `api_messages` at L638-642
- `src/stupidex/llm/client.py:689-697` — `litellm.acompletion` call site (OUTSIDE the try block at L712)
- `src/stupidex/llm/client.py:111-171` — `_maybe_offload_tool_output` (synchronous `os.open`/`os.write`)
- `src/stupidex/llm/client.py:174-285` — `_history_to_api_messages` rebuilds from `Message.to_dict()` — emits `msg.content` untrimmed
- `src/stupidex/llm/client.py:107-108` — `_tool_output_cache_dir` (no eviction anywhere)
- `src/stupidex/rag/indexer.py:199-252` — per-file loop calling `store.upsert_file` (regression from single-flush)
- `src/stupidex/rag/store.py:338-404` — `upsert_file`: full `_load_vectors` + `_save_vectors` per call
- `src/stupidex/rag/store.py:145-171` — `_save_vectors`: full atomic rewrite via mkstemp + os.replace
- `src/stupidex/rag/store.py:173-187` — `_load_vectors`: `np.load().tolist()` (O(N·d) copy)
- `src/stupidex/mcp/__init__.py:92-112` — startup timeout path: clears `_sessions` at L111, does NOT clear `_tools`
- `src/stupidex/mcp/__init__.py:217-223` — shadow warning falls through to unconditional overwrite
- `src/stupidex/widgets/subagent_ui.py:35,81` — `_mount_locks` dict, never cleaned up
- `src/stupidex/screens/settings.py:855-862` — rename rejection: writes edited `result` under `original_alias`, skips `_refresh_tab`/`_mark_dirty`
- `src/stupidex/config.py:241-244` — `llm_stream_idle_timeout` inline validation (sibling MCP fields use `_check_positive_float`)
- `src/stupidex/tools/file_manipulation.py` uses `atomic_write` pattern from `tools/ast.py:222-251`
- `src/stupidex/llm/client.py:168-232` in `web_fetch.py` — canonical large-output offload pattern using `run_in_executor`

### Institutional Learnings

- `docs/solutions/runtime-errors/mcp-runner-cancellederror-skips-aclose.md` — CancelledError in MCP runner's finally block skips `exit_stack.aclose()`. The startup-timeout path calls `_await_runner` which can cancel mid-`aclose()`; the CancelledError guard pattern applies.

---

## Key Technical Decisions

- **Retry rollback via snapshot length**: Snapshot `len(api_messages)` at the top of each retry attempt and `del api_messages[snapshot_len:]` on `_StreamIdleTimeoutError`. This is simpler than deep-copying and works because prior-turn messages are never mutated by the current attempt. — Rationale: deep-copy of a list of dicts is expensive on long conversations; length-based truncation is O(K) where K = messages added this attempt.

- **`delivered_any` flag to gate retry**: Track whether any message was yielded to `msg_q` during the current attempt. If yes and timeout fires, treat as terminal (no retry) rather than risk duplicating output. — Rationale: duplicating delivered content is worse than failing the turn; the user sees an error and can retry manually.

- **Transient error classification**: Catch `asyncio.TimeoutError` (from `acompletion` timeout) and litellm transient errors (`RateLimitError`, `InternalServerError`, `ServiceUnavailableError`, `BadGatewayError`, `APIConnectionError`) in the retry path alongside `_StreamIdleTimeoutError`. Do NOT retry `BadRequestError` / `AuthenticationError` (4xx). — Rationale: P1-11 explicitly targeted 429/502; the current implementation only catches stream-idle.

- **`acompletion` connect timeout via `asyncio.wait_for`**: Wrap `litellm.acompletion()` in `asyncio.wait_for(..., timeout=cfg.llm_stream_idle_timeout)` rather than passing litellm's `timeout=` parameter. — Rationale: litellm's `timeout=` governs the whole request, which is hard to set for streaming; `wait_for` on the initial call gives us a connect-phase timeout that converts to `_StreamIdleTimeoutError` for unified retry handling.

- **Persist offload pointer on Message**: Store the trimmed pointer content on `Message.content` for `TOOL` role messages, and write the full output to the cache file *before* yielding to `msg_q`. `_history_to_api_messages` already emits `msg.content` — so the pointer round-trips naturally. — Rationale: the simplest fix that doesn't require changing `Message` schema or `_history_to_api_messages`. Full content is still on disk and recoverable via the `read` tool. (Note: this changes what's displayed in the TUI for tool results — see P2-B for the display trade-off.)

- **RAG batch vector state**: Thread an in-memory `dict[int, list[float]]` (chunk_id → vector) through `_index_project_impl`. Load once at start, mutate per file (delete old + insert new), save once at end. Keep the existing single-file `upsert_file` for the `update_file` hot-path. — Rationale: restores the old single-flush behavior for the bulk loop without changing the single-file API.

- **MCP startup timeout: clear `_tools` alongside `_sessions`**: On startup timeout, clear `self._tools` after `self._sessions.clear()` so orphaned tool entries are not advertised to the LLM. — Rationale: tools without backing sessions are dead descriptors; the LLM calling them gets a soft-failure "not connected" error that wastes a turn.

- **Rename rejection: restore original unchanged**: On collision, do NOT write `result` under `original_alias`. Instead, notify the user and leave the original entry untouched. Call `_refresh_tab()` and `_mark_dirty()` before returning. — Rationale: the current behavior silently persists edited fields the user thinks were discarded; restoring the original unchanged is the least-surprising behavior.

---

## Implementation Units

- U1. **Stream-idle retry: snapshot/restore `api_messages` + `delivered_any` gate**

**Goal:** Prevent retry from sending mutated `api_messages` to the provider or duplicating already-delivered messages.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_streaming_messages.py`

**Approach:**
- At the top of the inner `while True:` retry loop (before `litellm.acompletion`), snapshot `api_snapshot_len = len(api_messages)`.
- Introduce `delivered_any = False` before the stream-consumption loop. Set `delivered_any = True` inside the `msg_q.put` yield loop (the `while True:` that drains `msg_q` and yields to the caller).
- In the `except _StreamIdleTimeoutError:` clause:
  - If `delivered_any` is `True`, re-raise the exception as terminal (no retry — content was already delivered).
  - If `delivered_any` is `False`, `del api_messages[api_snapshot_len:]` to roll back any partial mutations (assistant message appends, tool result appends), then proceed with backoff + retry.

**Test scenarios:**
- Happy path: stream completes without timeout → no rollback, `api_messages` intact.
- Error path: stream stalls with zero delivered messages → `api_messages` restored to snapshot, retry succeeds.
- Error path: stream stalls after delivering messages → no retry, `_StreamIdleTimeoutError` propagates as terminal.
- Edge case: `commit_assistant_with_tool_calls` appends to `api_messages` before stall, zero delivered → snapshot truncation removes the partial assistant message.
- Integration: multi-tool stream where one tool executes before stall, zero delivered to caller → both the assistant message and the tool result are truncated from `api_messages`.

**Verification:**
- `pytest tests/test_streaming_messages.py -k "retry" -v` passes.
- No test simulates duplicate content reaching the caller.

---

- U2. **`litellm.acompletion` connect timeout + transient HTTP error retry**

**Goal:** Bound the connect phase of `litellm.acompletion()` and retry on transient HTTP errors (429/502/503), not just stream-idle timeout.

**Requirements:** R2

**Dependencies:** U1 (shares the retry loop)

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_streaming_messages.py`

**Approach:**
- Wrap `response = await litellm.acompletion(...)` in `asyncio.wait_for(...)` with an `asyncio.TimeoutError` catch that converts to `_StreamIdleTimeoutError` so it flows through the existing retry path. Use `cfg.llm_stream_idle_timeout` as the connect timeout (reusing the existing config; a separate `llm_connect_timeout` can be added later if needed).
- Import litellm exception types at the top of `client.py`: `RateLimitError`, `InternalServerError`, `ServiceUnavailableError`, `BadGatewayError`, `APIConnectionError`, `APIError` (these are already imported at L55-71 per research — verify they're available and usable).
- Expand the `except` clause from `except _StreamIdleTimeoutError:` to also catch the transient HTTP errors. Use a helper `_is_transient_error(exc) -> bool` to classify, keeping the retry logic clean.
- Do NOT retry `BadRequestError` or `AuthenticationError` — these are non-transient.
- The `delivered_any` gate from U1 applies here too: if any HTTP error occurs after delivery, it's terminal.

**Test scenarios:**
- Error path: mock `litellm.acompletion` to raise `RateLimitError` → retry fires, succeeds on second attempt.
- Error path: mock `litellm.acompletion` to raise `BadRequestError` → no retry, propagates immediately.
- Error path: mock `litellm.acompletion` to hang (awaitable that never resolves) → `asyncio.TimeoutError` → converted to `_StreamIdleTimeoutError` → retry.
- Error path: `RateLimitError` after `delivered_any=True` → terminal, no retry.

**Verification:**
- `pytest tests/test_streaming_messages.py -k "transient or connect" -v` passes.

---

- U3. **`commit_assistant_with_tool_calls`: stop mutating shared `tool_calls` list in place**

**Goal:** Eliminate index-shift bugs by snapshotting the filtered list at commit time instead of mutating the shared list.

**Requirements:** R4

**Dependencies:** None (independent of U1/U2)

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_streaming_messages.py`

**Approach:**
- Replace `tool_calls[:] = [tc for tc in tool_calls if ...]` with a local `committed_tool_calls = [tc for tc in tool_calls if tc.get("id") and tc["function"].get("name")]`.
- Use `committed_tool_calls` for the `assistant_api_msg["tool_calls"]` assignment (L484) and the `msg_q.put(Message(... tool_calls=committed_tool_calls ...))` (L493).
- Keep the live `tool_calls` list intact — subsequent deltas continue to append to it and fill placeholders via the existing `while tc_delta.index >= len(tool_calls): tool_calls.append(...)` loop.
- `maybe_enqueue(prev_index)` continues to index into `tool_calls` (the live list) — this is correct because `prev_index` is the stream's absolute index, and the live list preserves all positions.
- The anchored `assistant_api_msg["tool_calls"]` now contains only well-formed entries (the snapshot), not the live list — so empty-id placeholders can never leak into `api_messages`.
- When the empty-filter branch is taken (all tool_calls malformed), anchor the assistant message with NO `tool_calls` key (existing behavior) — but also do NOT call `maybe_enqueue` for subsequent well-formed deltas in this stream (they would create orphaned tool results). Set a `tool_calls_committed = True` flag that prevents further enqueuing when the commit produced zero valid tool calls.

**Test scenarios:**
- Happy path: 3 well-formed tool calls → all enqueued, `assistant_api_msg["tool_calls"]` has 3 entries, no empty placeholders.
- Edge case: 1 malformed + 2 well-formed → `assistant_api_msg["tool_calls"]` has 2 entries (malformed dropped), live `tool_calls` still has 3 (preserving index positions for subsequent deltas).
- Edge case: all malformed (empty filter) → assistant anchored with no `tool_calls` key, no subsequent enqueueing, stream ends as non-tool turn.
- Edge case: mixed — malformed[0] + well-formed[1] → `maybe_enqueue(0)` emits malformed, `maybe_enqueue(1)` enqueues the valid one, `assistant_api_msg["tool_calls"]` has only the valid entry.

**Verification:**
- `pytest tests/test_streaming_messages.py -k "tool_calls or filter or commit" -v` passes.
- No empty-id/name placeholder appears in `api_messages` under any stream shape.

---

- U4. **Tool-output offload: persist pointer on `Message` + async cache write**

**Goal:** Make the offload effective across turns by persisting the pointer on `Message.content`, and move cache writes off the event loop.

**Requirements:** R5, R6

**Dependencies:** None (independent)

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Modify: `src/stupidex/domain/message.py` (if needed for `metadata` field)
- Test: `tests/test_tool_output_offload.py`
- Test: `tests/test_streaming_messages.py`

**Approach:**
- In `_executor_task` (L619-644): call `_maybe_offload_tool_output` **before** yielding `result_msg` to `msg_q`. Set `result_msg.content` to the trimmed/pointer content from offload. So `msg_q.put` receives the trimmed message, and `record_streamed_message` / `Message` persistence stores the pointer — not the full content.
- Make `_maybe_offload_tool_output` an `async def` and wrap the cache-write block (`os.open`/`os.fdopen`/`os.write`/`os.chmod`/`Path.mkdir`) in `await loop.run_in_executor(None, _write_cache_file, cache_dir, path, content)`. Follow the pattern from `web_fetch.py:168-232`.
- The full content is still written to the cache file (recoverable via `read`).
- Change the offload pointer instruction from "Use read (with offset/limit) or grep" to "Use `grep` to search it or `read` with offset/limit to view sections" — keep `read` in the instruction but acknowledge it's a viable recovery path.
- Note: the TUI display will now show the pointer for offloaded tool results instead of the full content. This is acceptable — the pointer includes a `<warning>` explaining where the full output is.

**Test scenarios:**
- Happy path: tool returns <10KB → no offload, `Message.content` = full content.
- Happy path: tool returns >10KB → offload writes cache file, `Message.content` = pointer envelope.
- Integration: `stream_response` yields the trimmed `Message` to `msg_q` → `record_streamed_message` stores pointer → next turn's `_history_to_api_messages` emits pointer (not full content).
- Error path: cache write raises `OSError` → `Message.content` = truncated content with warning.
- Error path: no active session → `Message.content` = truncated content (no cache file).

**Verification:**
- `pytest tests/test_tool_output_offload.py tests/test_streaming_messages.py -v` passes.
- A two-turn integration test confirms `_history_to_api_messages` emits pointer content for an offloaded tool result.

---

- U5. **RAG batch vector state: load once, mutate in memory, save once**

**Goal:** Restore O(N·d) vector I/O for incremental indexing instead of O(K·N·d).

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/rag/store.py`
- Modify: `src/stupidex/rag/indexer.py`
- Test: `tests/test_rag_indexer.py`
- Test: `tests/test_rag_store.py`

**Approach:**
- Add a `VectorState` lightweight class (or `NamedTuple`) to `store.py` holding `chunk_ids: list[int]`, `vectors: list[list[float]]`, and an `id_to_index: dict[int, int]` for O(1) lookup. Add `load_vector_state() -> VectorState` method on `RAGStore` that loads once.
- Add `upsert_file_batch(state: VectorState, file_path: str, chunks: list[Chunk], embeddings: list[list[float]]) -> None` — deletes old chunk_ids for the file from `state` and sqlite, inserts new ones into sqlite and `state`. No `_save_vectors`.
- Add `delete_by_file_batch(state: VectorState, file_path: str) -> None` — deletes from sqlite and `state`. No `_save_vectors`.
- Add `flush_vector_state(state: VectorState) -> None` — single `_save_vectors(state.vectors)` call.
- In `_index_project_impl`: load `state = store.load_vector_state()` before the file loop, call `upsert_file_batch`/`delete_by_file_batch` in the loop, call `flush_vector_state` once after the loop. Keep `update_file_hash` calls (they're cheap SQL).
- Keep the existing `upsert_file`/`delete_by_file` methods unchanged for the single-file `update_file` hot-path.
- Use `rel in existing_hashes` → `rel in state.id_to_index` (or a derived set) — the `existing_hashes` dict is still loaded for the skip-unchanged optimization; the `state` is for vector management.

**Test scenarios:**
- Happy path: index 3 files → `vectors.npy` written exactly once (monkeypatch `_save_vectors` to count calls).
- Happy path: incremental reindex with 2 changed files + 1 deleted → `_save_vectors` called once, vectors.npy correct.
- Edge case: empty project (no files) → `flush_vector_state` not called (or no-op).
- Edge case: file produces 0 chunks → `upsert_file_batch` deletes old vectors for that file from `state`, inserts nothing.
- Integration: `search` after batch index returns correct results (vectors aligned with chunk_ids).

**Verification:**
- `pytest tests/test_rag_indexer.py tests/test_rag_store.py -v` passes.
- Monkeypatch `_save_vectors` count == 1 for a multi-file incremental index.

---

- U6. **MCP startup timeout: clear `_tools` + harden teardown**

**Goal:** Prevent orphaned tool entries from being advertised to the LLM after a startup timeout.

**Requirements:** R10

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/mcp/__init__.py`
- Test: `tests/test_mcp_startup_timeout.py`

**Approach:**
- In the `except TimeoutError:` branch of `start_all` (L94-112): after `self._sessions.clear()`, also call `self._tools.clear()`.
- This ensures `get_tools()` returns an empty dict after a startup timeout — the LLM sees no MCP tools instead of dead descriptors.
- The non-fatal skip-and-continue path (where individual servers fail) already marks failed servers as "unavailable" — that path is correct and should not be changed.
- For the teardown race (REL-4/REL-5): before `_sessions.clear()`, explicitly close each session via `await asyncio.gather(*[s.aclose() for s in self._sessions.values() if s is not None], return_exceptions=True)`. This prevents in-flight `call_tool` from holding a stale session reference.

**Test scenarios:**
- Error path: startup timeout fires after one server registered tools → `get_tools()` returns empty dict after timeout.
- Error path: startup timeout with partial connect → `_tools` and `_sessions` both cleared.
- Integration: after timeout, `call_tool` returns "not connected" `ExecutorResult` for any previously-registered tool.

**Verification:**
- `pytest tests/test_mcp_startup_timeout.py -v` passes.

---

- U7. **Settings rename rejection: restore original unchanged + refresh UI**

**Goal:** Prevent silent persistence of edited fields under the original key when rename is rejected.

**Requirements:** R11

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/screens/settings.py`
- Test: `tests/test_settings_screen.py`

**Approach:**
- In `_on_edit_provider_result` (L855-862) and `_on_edit_mcp_result` (L980-988): on rename collision, do NOT write `result` under `original_alias`. Instead:
  - `self.notify(...)` (existing warning).
  - Call `self._refresh_tab()` and `self._mark_dirty(...)` (currently skipped).
  - `return` — the original entry stays unchanged.
- This means the user's edits in the form are discarded. This is the least-surprising behavior: "rename cancelled" should mean "nothing changed."

**Test scenarios:**
- Happy path: rename provider from "old" to "new" (no collision) → old key removed, new key added, dirty/refersh called.
- Error path: rename to existing alias → original entry unchanged, `notify` called with "warning", `_refresh_tab` and `_mark_dirty` called.
- Error path: rename MCP to existing name → same behavior.
- Edge case: edit without rename (alias == original_alias) → normal overwrite path, no rejection.

**Verification:**
- `pytest tests/test_settings_screen.py -k "rename" -v` passes.

---

- U8. **Config validation: use `_check_positive_float` for `llm_stream_idle_timeout`**

**Goal:** Eliminate the inline validation duplication.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/config.py`

**Approach:**
- Replace the inline validation at L241-244 with `_check_positive_float(cfg, "llm_stream_idle_timeout", errors)`.

**Test scenarios:**
- Test expectation: none — pure refactor, existing config validation tests cover the behavior.

**Verification:**
- `pytest tests/ -k "config" -v` passes. Ruff clean.

---

- U9. **SubagentUIManager mount lock test coverage + `_mount_locks` eviction**

**Goal:** Add regression tests for the P1-3 mount-lock race fix and evict lock entries on cancel/complete.

**Requirements:** R9, R13

**Dependencies:** None

**Files:**
- Create: `tests/test_subagent_ui.py`
- Modify: `src/stupidex/widgets/subagent_ui.py`

**Approach:**
- Create `tests/test_subagent_ui.py` with tests that:
  - Drive two concurrent `on_message` calls for the same `subagent_id` against a stubbed `mount_streamed_message` that records concurrency (max simultaneous in-flight calls). Assert at most 1 at a time.
  - Verify `StreamWidgetState.temp` is non-corrupted after concurrent mounting.
  - Verify `on_message` for different `subagent_id`s can run concurrently (different locks).
- Add `_mount_locks` eviction: in the method that handles subagent completion/cancellation (check `SubagentUIManager` for a cleanup hook — likely in `sync_tabs` or when a subagent reaches a terminal state), remove the `subagent_id` entry from `_mount_locks`.
- If no cleanup hook exists, add a `prune_lock(self, subagent_id: str)` method and call it from `SubagentManager._cancel_record` (or wherever terminal state is reached — research shows `on_state_change(INTERRUPTED)` is the signal).

**Test scenarios:**
- Happy path: concurrent `on_message` for same `subagent_id` → serialized, no corruption.
- Happy path: concurrent `on_message` for different `subagent_id`s → parallel, no blocking.
- Edge case: subagent cancelled → `_mount_locks` entry evicted, dict doesn't grow.
- Edge case: `on_message` after eviction → new lock created via `setdefault`.

**Verification:**
- `pytest tests/test_subagent_ui.py -v` passes.

---

- U10. **Tool-output cache eviction on session delete**

**Goal:** Prevent unbounded disk growth from offloaded tool outputs.

**Requirements:** R12

**Dependencies:** U4 (the cache write path must exist and be async before adding eviction)

**Files:**
- Modify: `src/stupidex/domain/session.py`
- Modify: `src/stupidex/llm/client.py` (export cache dir helper)
- Test: `tests/test_session_manager_contextvar.py` or `tests/test_tool_output_offload.py`

**Approach:**
- In `SessionManager.delete` (or `delete_session`): after deleting the session, also delete `HOME_CONFIG_DIR / "cache" / "tool-output" / session_id` if it exists, using `shutil.rmtree(path, ignore_errors=True)`.
- Export `_tool_output_cache_dir` (rename to `tool_output_cache_dir` — remove underscore prefix) from `client.py` so `session.py` can import it.
- Add the cleanup call inside a `run_in_executor` to avoid blocking session deletion on disk I/O.

**Test scenarios:**
- Happy path: session deleted → cache dir for that session_id removed from disk.
- Edge case: session deleted but no cache dir exists → no error.
- Edge case: cache dir has files → all removed.

**Verification:**
- `pytest tests/test_tool_output_offload.py -k "evict or delete" -v` passes.

---

- U11. **Offload pointer XML escaping**

**Goal:** Prevent malformed XML-like framing when cache path contains special characters.

**Requirements:** R14

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/llm/client.py`

**Approach:**
- In `_maybe_offload_tool_output`, use `html.escape(str(cache_path))` when constructing the pointer envelope (L166-171).
- Import `html` at the top of `client.py` (stdlib).

**Test scenarios:**
- Test expectation: none — pure safety fix, no behavioral change for normal paths. Optionally add a test with a `session_id` containing `<` or `&` (unlikely but defensive).

**Verification:**
- Ruff clean. Existing offload tests pass.

---

- U12. **Rewrite `TestShadowWarning` to exercise real `_connect_server` path**

**Goal:** Replace the tautological test with one that exercises the real code path.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `tests/test_mcp_registry.py`

**Approach:**
- Delete the current `test_duplicate_registration_logs_warning` body that manually writes `manager._tools` and calls `logger.warning` itself.
- Replace with a test that:
  - Stubs `stdio_client` (or uses `_FakeSession`) to return a session whose `list_tools()` returns two tools with the same name.
  - Calls `await manager.start_all(...)` with two servers that each expose a tool named "dup".
  - Asserts a WARNING was logged via the real `_connect_server` → shadow guard path.
  - Asserts the second server's executor overwrites the first (current behavior — this test characterizes the existing behavior, not the fix; making the guard preventive is a P3 advisory, not in scope).

**Test scenarios:**
- Happy path: two servers expose "dup" tool → WARNING logged with `"mcp::srv1::dup"` or `"mcp::srv2::dup"` containing "shadows existing registration".
- Edge case: no collision (different tool names) → no WARNING.

**Verification:**
- `pytest tests/test_mcp_registry.py::TestShadowWarning -v` passes.
- Test fails if the shadow guard code is deleted (proves it's a real test, not tautology).

---

- U13. **Migrate P3 findings and testing gaps to `2026-06-20-full-sweep-all-findings.md`**

**Goal:** Record all P3 findings and testing gaps from the branch review in the existing findings tracker so they're not lost.

**Requirements:** R15

**Dependencies:** None

**Files:**
- Modify: `2026-06-20-full-sweep-all-findings.md`

**Approach:**
- Append a new section `## P3 — From 2026-06-20 Branch Review` listing all P3 findings from `docs/code-review-reports/2026-06-20-branch-review.md`, each with file:line, title, and status (all "Tracked — deferred").
- Append a new section `## Testing Gaps — From 2026-06-20 Branch Review` listing all testing gaps.
- Number P3s starting from P3-54 (continuing the existing P3 sequence if one exists; otherwise P3-1 through P3-N).
- Number testing gaps starting from TG-1.
- Do NOT fix any P3 or testing gap — this is a documentation migration only.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- The findings file contains all P3 and testing-gap entries from the branch review.

---

## System-Wide Impact

- **Interaction graph:** The `stream_response` retry changes (U1, U2) affect every LLM call in the app — the agent loop, subagent spawn, and any future caller of `stream_response`. The offload changes (U4) affect how tool results are persisted and displayed — every tool that returns >10KB.
- **Error propagation:** With U1/U2, transient LLM errors that previously aborted the turn now retry; if retry is exhausted, the original error propagates. The `delivered_any` gate means partial delivery is terminal (no retry), which is safer but means the user must retry manually.
- **State lifecycle risks:** U4 changes what's persisted on `Message.content` for tool results — the TUI will show pointers instead of full content for offloaded results. Full content is on disk and recoverable via `read`/`grep`. U5 changes the RAG index internals but not the external API.
- **API surface parity:** The offload pointer change (U4) affects both `api_messages` (trimmed, within-turn) and persisted `Message.content` (trimmed, across-turns) — they're now consistent.
- **Integration coverage:** The retry rollback (U1) + transient error retry (U2) need integration tests that simulate mid-stream stalls with partial delivery and verify no duplicates and no 400. The RAG batch (U5) needs a test verifying `_save_vectors` is called exactly once for a multi-file index.
- **Unchanged invariants:** `_history_to_api_messages` still emits `msg.content` — the change is what's stored on `Message.content`, not how it's read. `upsert_file` single-file API is unchanged. `start_all`'s non-fatal skip-and-continue path is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| U4 changes TUI display for offloaded tool results — users see pointer text instead of full output | The pointer includes `<warning>` explaining where the full output is and how to access it. This is a deliberate trade-off: context-bounding is the stated goal of P1-4. |
| U1 `delivered_any` gate makes some previously-retried scenarios terminal | Safer than duplicating output. The user sees an error and can retry the turn manually. Default `llm_stream_idle_timeout=300s` means this only fires on genuinely stalled providers. |
| U5 batch vector state adds complexity to `store.py` | The single-file `upsert_file` API is preserved for the hot-path; only the bulk indexer uses the batch API. Tests verify correctness. |
| U2 litellm exception imports may be incomplete (`APIError` base class may not cover all transient types) | Use defensive `isinstance` checks + `_is_transient_error` helper that can be extended. litellm exceptions are already imported at L55-71. |
| U4 offload-recovery path depends on P0-3 (workspace path confinement) not breaking `read` of cache files outside the workspace | P0-3 is deferred to README TODO. When it ships, it must either allowlist `HOME_CONFIG_DIR/cache/` or write cache under `.stupidex/cache/` in cwd. Documented in the branch review's residual risks. |
| U1 snapshot truncation doesn't deep-copy nested dicts — `assistant_api_msg` is shared by reference | Prior-turn messages in `api_messages` are never mutated by the current attempt (only appended to). The truncated entries (this attempt's appends) are discarded entirely, so no shared-reference issue. |

---

## Open Questions

### Resolved During Planning

- **Should `llm_connect_timeout` be a separate config key?** No — reuse `llm_stream_idle_timeout` for the connect phase too. A separate key can be added later if users need different connect vs idle timeouts. AI_completion that hangs during connection is the same class of "stalled provider" as a mid-stream stall.
- **Should the shadow guard be preventive (skip the later registration)?** No — that's a P3 advisory. The current behavior (warn + overwrite) is characterized but not changed in this plan. Making it preventive would be a behavior change that needs its own design discussion.
- **Should `_history_to_api_messages` be changed?** No — U4 fixes the root cause by persisting the pointer on `Message.content`, so `_history_to_api_messages` naturally emits the pointer without any change to its logic.

### Deferred to Implementation

- **Exact litellm exception class hierarchy**: The research shows imports at L55-71, but whether `APIError` is the base for all transient types needs runtime verification. Use `_is_transient_error` helper with `isinstance` checks.
- **SubagentUIManager cleanup hook**: Research shows no existing cleanup hook for terminal subagent states. The implementer should check `SubagentManager._cancel_record` and `on_state_change` for where to call `prune_lock`.
- **RAG `VectorState` thread-safety**: The batch API is called from `run_in_executor` — the `VectorState` object is passed by reference and mutated. Since the batch is sequential (the indexer loop awaits each `run_in_executor` call), no concurrent mutation occurs. But this should be documented.

---

## Sources & References

- **Origin document:** `docs/code-review-reports/2026-06-20-branch-review.md`
- Related code: `src/stupidex/llm/client.py`, `src/stupidex/rag/store.py`, `src/stupidex/rag/indexer.py`, `src/stupidex/mcp/__init__.py`, `src/stupidex/screens/settings.py`, `src/stupidex/widgets/subagent_ui.py`, `src/stupidex/config.py`
- Prior plans: `docs/plans/2026-06-20-001-fix-p1-code-review-findings-plan.md`, `docs/plans/2026-06-20-002-fix-p1-testing-gaps-plan.md`
- Institutional learning: `docs/solutions/runtime-errors/mcp-runner-cancellederror-skips-aclose.md`
- Findings tracker: `2026-06-20-full-sweep-all-findings.md`
