# Code Review: `fix/a_lot_of_things` branch

**Date:** 2026-06-20
**Base:** `bef9d50` (merge-base with `main`)
**Scope:** 52 files, +9106/-246 lines across 12 commits
**Reviewers:** correctness, testing, maintainability, project-standards, security, performance, reliability, adversarial, kieran-python, agent-native, learnings-researcher (11 total)
**Run ID:** `20260620-211558-77003800`

## Verdict: NEEDS WORK

The branch closes 53 P1 findings and adds 172 tests, but the multi-agent review surfaced **one critical cluster** around the LLM stream-idle retry path that re-introduces the very failure modes P0-5/P1-9/P1-11 were intended to close, plus a context-blowout regression in the P1-4 tool-output offload fix that the agent-native reviewer flagged as defeating the fix's stated purpose.

## Primary Findings

### P0 — Critical

#### P0-A — SubagentUIManager mount-lock race fix has zero test coverage
**Reviewers:** testing (conf 75)
**File:** `src/stupidex/widgets/subagent_ui.py:91`
**Class:** `manual` / downstream-resolver
**Pre-existing:** No (introduced by this branch's P1-3 fix)

The P1-3 fix adds `_mount_locks` and wraps `mount_streamed_message` in `async with self._mount_locks.setdefault(subagent_id, asyncio.Lock())`. No `tests/test_subagent_ui.py` exists; none of the 22 new/extended test files touch `SubagentUIManager`. A future refactor that drops the `async with` or moves it to the wrong scope has no regression guard.

**Fix:** Add a test driving two concurrent `on_message` calls for the same `subagent_id` against a stubbed `mount_streamed_message` that records concurrency; assert at most one in-flight call at a time and that final `StreamWidgetState.temp` is non-corrupted.

---

### P1 — High-impact defects

#### P1-A — Stream-idle retry replays mutated `api_messages` and duplicates already-delivered content
**Reviewers:** correctness (conf 75), reliability REL-3 (conf 50), adversarial #1 (conf 75) — cross-reviewer agreement promotes to anchor 100
**Files:** `src/stupidex/llm/client.py:734`, `:803`, `:476`, `:495`
**Class:** `manual` / downstream-resolver
**Requires verification:** Yes

The stream-idle timeout retry path (P0-5/P1-9) does not roll back partial state mutations. On `_StreamIdleTimeoutError` mid-stream:
1. `_stream_task` has typically already mutated `api_messages` via `commit_assistant_with_tool_calls` (appended assistant dict with partial `tool_calls`) and `_executor_task` may have appended tool-result messages.
2. The previous attempt may have already yielded TEXT deltas / TOOL_CALL metadata to `msg_q` (→ UI / `record_streamed_message`).
3. Retry re-invokes `acompletion` with the now-grown `api_messages` and a fresh `_stream_task`; the provider re-emits the same content, which is yielded again to the caller → duplicated in the TUI and persisted history.
4. Multi-tool cascade: if any tool was enqueued before the stall, `api_messages` becomes `[user, assistant(tool_calls=[t0,t1,t2]), tool_result(t0)]` — indices 1,2 have no matching `role:'tool'` entries. Strict OpenAI-shaped providers reject with 400; the 400 propagates from `acompletion` *outside* the `except _StreamIdleTimeoutError` clause, aborting the entire turn with a misleading "provider rejected messages" error rather than a transient-stall diagnostic.

**Fix:** (a) snapshot `api_messages=list(api_messages)` before each attempt and `del api_messages[snapshot:]` on retry; (b) track a `delivered_any` flag set in the `msg_q` yield loop and only retry when `False` (or propagate partial-delivery failures as terminal); (c) for the cascade case, either truncate uncommitted `tool_calls` entries that have no matching tool result, or treat partial-tool-plan stalls as terminal.

---

#### P1-B — `litellm.acompletion()` call has no timeout; retry only catches `_StreamIdleTimeoutError`
**Reviewers:** reliability REL-1 (conf 75), REL-2 (conf 80)
**Files:** `src/stupidex/llm/client.py:735`, `:812`
**Class:** `manual` / downstream-resolver

Two related gaps in the P0-5/P1-9/P1-11 retry machinery:

1. **Connect-phase hang unbounded.** `response = await litellm.acompletion(...)` is awaited *outside* the idle-timeout wrapper. The idle timeout only engages once `_idle_timed_stream` is entered, after `acompletion` returns the async generator. If the provider hangs during connection establishment, TLS handshake, or before emitting the first byte, the entire agent turn blocks indefinitely with no retry.

2. **Transient HTTP errors unretried.** The retry clause is `except _StreamIdleTimeoutError:`. `RateLimitError`/`APIError` (429/502/503) raised by `litellm.acompletion()` propagate synchronously *before* the `try` block — no retry, no backoff. P1-11 explicitly called out "single 429/502 aborts the entire agent turn" but the catalog marks it FIXED via "exponential backoff + jitter"; that backoff path is unreachable for HTTP-error responses. `retries(3)` mitigates only stream-stall, not the most common transient failure mode.

**Fix:** (1) Pass an explicit `timeout=` / httpx client with connect+read timeouts to `acompletion`, or wrap the `acompletion` call in `asyncio.wait_for` bounded by a separate `connect_timeout`. (2) Broaden the retry classifier to catch transient HTTP errors (5xx/429/connection) with backoff; fail fast on 4xx auth/validation.

---

#### P1-C — RAG incremental index now does full `vectors.npy` load+save per changed file (O(K × corpus) regression)
**Reviewers:** performance PERF-1 (conf 75)
**File:** `src/stupidex/rag/indexer.py:242` (loop), `src/stupidex/rag/store.py:338-404` (`upsert_file`)
**Class:** `manual` / downstream-resolver
**Requires verification:** Yes

`_index_project_impl` switched from accumulating all chunks/embeddings in memory and flushing once via `_flush_store` (single write) to calling `store.upsert_file(rel, ...)` *per changed file* inside the loop. Each `upsert_file` does `_load_vectors()` → `np.load()` of the **entire** `vectors.npy` + `.tolist()` to a Python list of lists (~4-6× memory vs the ndarray, ~280MB for a large corpus per P2-155), builds an `id_to_vec` dict over all vectors, then `_save_vectors()` rewrites the **entire** `vectors.npy`. The same pattern applies to `store.delete_by_file` (called per deleted/empty/binary/stale file at `indexer.py:221,234,275-277`).

For K changed + D deleted files this is (K+D) full-vector load+save rounds — e.g. ~5GB redundant I/O for a 50MB vectors file + 100 changed files — on the default `ThreadPoolExecutor`. The pre-existing single-file `update_file` post-write callback correctly keeps load+save; the regression is only the loop.

**Fix:** Decouple the per-file chunk write (cheap SQLite) from the vectors array rebuild. Load vectors once at run start, mutate `id_to_vec` in memory per file (delete+reinsert), write once at end (restore the old single-flush behaviour for the loop path).

---

#### P1-D — `commit_assistant_with_tool_calls` in-place `tool_calls` filter shifts list indices, breaking `maybe_enqueue(prev_index)` and re-injecting empty-id/name placeholders
**Reviewers:** correctness C2 (conf 75)
**File:** `src/stupidex/llm/client.py:476`
**Class:** `manual` / review-fixer
**Requires verification:** Yes

`tool_calls[:] = [tc for tc in tool_calls if tc.get('id') and tc['function'].get('name')]` mutates the shared list (referenced by `assistant_api_msg['tool_calls']`). But `prev_index` is the provider's `tc_delta.index` (an absolute stream index). After commit, subsequent `tc_delta` deltas with `index >= 1` extend the shared list via `while tc_delta.index >= len(tool_calls): append({'id':'',...})` — injecting placeholders at the positions the filtered entries used to occupy. Those placeholders are never populated (the provider never re-emits index 0 once it advanced). End-of-stream `maybe_enqueue(prev_index)` reads `tool_calls[prev_index]`, which is now either OOB (spurious "Malformed tool call" error) OR a placeholder (enqueued + executed with empty id/name). The `api_messages['assistant']['tool_calls']` now contains the empty-id placeholder — exactly what P1-7 was trying to prevent.

Related (correctness C3, conf 50): when the filter *empties* `tool_calls`, the `else` branch anchors an assistant message with NO `tool_calls` key but still sets `tool_calls_started`. If the stream then sends well-formed tool_call deltas, `_executor_task`'s end-of-stream `maybe_enqueue` enqueues them and appends `{'role':'tool',...}` to `api_messages` → strict providers 400 ("tool message must be preceded by assistant with tool_calls").

**Fix:** Don't mutate `tool_calls` in place; build a separate filtered list for anchoring. Or re-key `enqueued_tool_calls`/`emitted_tool_calls` by `tool_call_id` instead of index. Or remap `prev_index` after the filter.

---

#### P1-E — Tool-output offload only protects the *current* turn; full content is replayed into the LLM context on every subsequent turn — defeating P1-4
**Reviewers:** agent-native Finding 1, adversarial #3 (conf 75)
**Files:** `src/stupidex/llm/client.py:632-642`, `:174-285`, `src/stupidex/domain/message.py:40-55`, `src/stupidex/llm/client.py:99-103`
**Class:** `manual` / downstream-resolver

In `_executor_task`, the full-content `result_msg` is yielded to `msg_q` (→ `record_streamed_message` persists full `content` to history at `app.py:324` / `manager.py:275`) *before* `_maybe_offload_tool_output` writes the cache file and appends only the trimmed pointer to the ephemeral `api_messages`. So within a single multi-tool `stream_response` call the LLM sees pointers — good. But `stream_response` is re-invoked per user turn (`app.py:317`), and `_history_to_api_messages` rebuilds the request from persisted `Message.to_dict()` (`message.py:50` emits `content: self.content`, untrimmed) for every prior `TOOL_RESULT`. Net effect: a 5 MB `execute_command` / `replace_symbol` output that was "offloaded" re-enters the provider's context window in full on the next turn. P1-4 is therefore only a within-turn band-aid.

Compounding bypass (adversarial #3): the offload pointer tells the LLM "Use read (with offset/limit) or grep to inspect it." But `read` is in `_TOOLS_WITHOUT_OUTPUT_OFFLOAD` — its output is never offloaded. An agent (or prompt-injected instruction) that follows the warning by calling `read` on the cache path re-injects the full content inline. The context-bounding guard is nullified by following the tool's own suggestion.

**Fix:** Persist the pointer (or a flag + cache path) on the `TOOL_RESULT` `Message` instead of the full content, and have `_history_to_api_messages` emit the pointer for offloaded results. The simplest fix: yield the trimmed `Message` to `msg_q` and write the cache file *before* yielding. For the bypass: either offload `read` results too when they target cache files, or change the pointer instruction to "use `grep`" (which is self-limiting) instead of `read`.

---

#### P1-F — `_maybe_offload_tool_output` performs blocking file I/O synchronously on the event loop
**Reviewers:** kieran-python KP-1 (conf 75)
**File:** `src/stupidex/llm/client.py:111-170`
**Class:** `manual` / downstream-resolver

The offload function does `os.open` / `os.fdopen` / `os.write` / `os.chmod` / `Path.mkdir` (parents=True) synchronously on the event loop, on the hot streaming path inside `_executor_task`. For a slow disk or NFS mount this blocks the entire stream loop (and every other tool execution in flight) for the duration of the write. The `web_fetch` offload pattern (the canonical reference for P1-4) correctly uses `loop.run_in_executor`.

**Fix:** Wrap the cache-write block in `await loop.run_in_executor(None, _write_cache_file, ...)` mirroring `web_fetch.py:168-232`.

---

#### P1-G — `TestShadowWarning` is a false-confidence test that re-implements the guard inside the test body
**Reviewers:** testing T-P1-1 (conf 100)
**File:** `tests/test_mcp_registry.py:582`
**Class:** `manual` / review-fixer

`TestShadowWarning.test_duplicate_registration_logs_warning` claims to cover the P1-19 duplicate-registration warning at `mcp/__init__.py:211`, but the test body manually writes `manager._tools` and then calls `logger.warning(...)` itself. It never invokes `_connect_server`, `call_tool`, or `start_all`. The assertion `len(warnings)==1` only verifies that `logger.warning()` writes to a handler. The real guard is never exercised; the test passes even if someone deletes the guard entirely.

**Fix:** Stub `session.list_tools()` to return two tools producing the same `registry_name`, `await manager.start_all(...)`, and assert a WARNING was logged via the real code path.

---

#### P1-H — `llm_stream_idle_timeout` validation inlined instead of using the new `_check_positive_float` helper
**Reviewers:** project-standards PS-1 (conf 75), maintainability M2 (conf 75), kieran-python KP-2 (conf 75) — cross-reviewer agreement promotes to anchor 100
**File:** `src/stupidex/config.py:241-244`
**Class:** `safe_auto` / review-fixer

`config.py:241-244` inlines byte-for-byte identical logic to the `_check_positive_float` helper that was added in this same diff. Sibling MCP float fields (`mcp_startup_timeout`/`mcp_per_server_timeout` at `:247-248`) correctly use the helper.

**Fix:** Replace the inline check with `_check_positive_float(cfg, "llm_stream_idle_timeout", errors)`.

---

### P2 — Moderate issues

#### P2-A — MCP startup-timeout path orphans `_tools` entries whose `_sessions` were cleared → LLM continues calling dead tools
**Reviewers:** adversarial #4 (conf 75), reliability REL-4 (conf 75), REL-5 (conf 75)
**File:** `src/stupidex/mcp/__init__.py:81-101`, `:200`
**Class:** `manual` / downstream-resolver

If `cfg.mcp_startup_timeout` fires after some servers connected + registered tools but before others finish, the except branch clears `self._sessions` (and `_run`'s finally closes `_exit_stack`, tearing down every transport including successful ones) — but `self._tools` is NOT cleared. Tools registered by previously-connected servers stay in the registry and remain advertised to the LLM. The LLM emits a tool_call for an orphan entry → `make_mcp_executor` closure calls `call_tool(server_name, ...)` → `self._sessions.get(server_name)` is `None` → `ExecutorResult('MCP server ... is not connected.')`. The LLM sees tools declared available; receives soft-failure for each.

Additional teardown-race concern (REL-4/REL-5): `_sessions.clear()` drops references without awaiting `session.aclose()` individually. A concurrent `call_tool` holding a session reference races teardown → silent partial-failure. And `_await_runner` can cancel the runner mid-`aclose()`, re-introducing the dangling-async-generator condition the prior `CancelledError` fix (see `docs/solutions/runtime-errors/mcp-runner-cancellederror-skips-aclose.md`) prevents.

**Fix:** Before `_sessions.clear()`, explicitly close each session via `asyncio.gather`; block new `call_tool` attempts during teardown via a lock or in-flight counter. After teardown, clear `self._tools` so dead tools are not advertised. Re-examine the 3s secondary cancel in `_await_runner` for the startup-timeout path.

---

#### P2-B — Renamed provider/MCP key silently keeps OTHER edit-form field changes despite "rename cancelled" notice
**Reviewers:** adversarial #2 (conf 75)
**File:** `src/stupidex/screens/settings.py:852-858`, `:973-979`
**Class:** `manual` / downstream-resolver

The P1-53 rename-rejection fix writes the edited `result` dict back under `original_alias` before notifying "rename cancelled". If the user edited other fields (base_url, models, command) alongside the alias change, those modifications are silently persisted under the original key. Users read "rename cancelled" and infer nothing changed. The rejection test asserts `screen._config.providers["old"]["models"] == {}` (the edited value) but doesn't assert the *pre-edit* fields are unchanged — so the silent-persistence goes uncaught.

**Fix:** On collision, restore the *original* entry unchanged (don't write `result` under `original_alias`); re-render the edit form pre-populated with the user's edits so they can pick a non-colliding alias. Or: surface a confirmation ("Apply field changes under 'old' instead?") rather than silently persisting.

---

#### P2-C — Tool-output offload cache directory has no eviction — unbounded disk growth
**Reviewers:** correctness P3, performance PERF-2 (conf 50), reliability REL-6 (conf 75), kieran-python KP-4 (residual), agent-native observation 7
**File:** `src/stupidex/llm/client.py:107-171`
**Class:** `manual` / human

`_tool_output_cache_dir(session_id)` returns `HOME_CONFIG_DIR/cache/tool-output/<session_id>/`. Each large tool output (>10KB) becomes a permanent cache file. No cleanup hook on session delete, app shutdown, or size threshold. Slow-burn: disk fills silently, eventually breaking writes (the `OSError` truncate path then degrades agent quality with no warning).

**Fix:** Delete `cache/tool-output/<session_id>/` on session delete + add an LRU size cap on the cache root. At minimum, scope cleanup to session lifecycle.

---

#### P2-D — `_mount_locks` dict in `SubagentUIManager` grows unbounded
**Reviewers:** reliability REL-RR-3, kieran-python KP-4 (conf 50)
**File:** `src/stupidex/widgets/subagent_ui.py:31`
**Class:** `manual` / downstream-resolver

`self._mount_locks: dict[str, asyncio.Lock]` keyed by `subagent_id`, created on first `on_message`. No cleanup on cancel/complete/prune. `_subagents` is also unbounded (P2-33). Memory leak over long sessions.

**Fix:** Evict the lock entry when the subagent record is pruned/cancelled.

---

#### P2-E — Tool-output pointer interpolates an unescaped filesystem path into XML-like framing
**Reviewers:** kieran-python KP-5 (conf 50)
**File:** `src/stupidex/llm/client.py:166-170`
**Class:** `safe_auto` / review-fixer

The pointer text embeds `cache_path` directly inside `<tool_output_offloaded>...</tool_output_offloaded>` framing. If `cache_path` ever contains `<`, `&`, or `>` (possible on some filesystems), the framing is malformed. The LLM may misparse the path.

**Fix:** Escape the path (e.g. `html.escape(str(cache_path))`) or use a plaintext delimiter.

---

### P3 — Low-impact / minor

- **`_cancel_record` double-fires `on_state_change(INTERRUPTED)`** — correctness P3, conf 75. `_cancel_record` fires it, then `_run`'s finally fires it again. Likely idempotent in practice. `src/stupidex/agents/manager.py:182`.
- **`from_storage_dict` end_time fallback yields `elapsed=0.0`** for records persisted with `end_time=None`. correctness P3, conf 50. `src/stupidex/agents/manager.py:161`.
- **MCP shadow warning fires but later server still overwrites earlier binding** — correctness P3, conf 50. Warning only, no prevention. `src/stupidex/mcp/__init__.py:211`.
- **`execute_grep` `finally: task.cancel()` cannot cancel in-flight `run_in_executor` futures** — correctness P3, conf 50. Bounded by Semaphore(32) + `_PER_FILE_TIMEOUT`. `src/stupidex/tools/search.py:243`.
- **`_read_bounded` over-trim when `rem > len(stdout_buf)`** — correctness P3, conf 75, `safe_auto`. `del stdout_buf[len(stdout_buf)-rem:]` removes last k elements (or all if k ≥ len). `src/stupidex/tools/exec.py:529`. Fix: `rem = min(rem, len(stdout_buf))`.
- **`TodoStore.create` `RuntimeError` after 8 retries may propagate uncaught** — correctness P3, conf 50. Verify the `todo_create` tool handler wraps it as `ExecutorResult`. `src/stupidex/domain/todo.py:91`.
- **`resolve_skill_dependencies` inner dedup now redundant with `_resolved` memoization** — correctness P3, conf 50. `src/stupidex/tools/skill.py:61`.
- **Provider/MCP rename-rejected early-returns without `_refresh_tab()`/`_mark_dirty()`** — correctness P3, conf 75, `safe_auto`. `src/stupidex/screens/settings.py:856`, `:981`. Fix: call them before the early return.
- **`os.open` / `os.fdopen` pairing can leak an fd if `fdopen` raises between allocation and `with`-block entry** — kieran-python KP-3, conf 50, `safe_auto`. `src/stupidex/llm/client.py:148-150`.
- **`_idle_timed_stream` calls `_safe_aclose` twice on the timeout path** — kieran-python KP-7, conf 50. `src/stupidex/llm/client.py:416-437`.
- **Skill resource traversal guard TOCTOU** between resolved-skill-dir check and resolved-subdir check — adversarial #7, conf 50. Microsecond window; requires FS attacker inside skill install dir. `src/stupidex/tools/skill.py:181-195`.
- **`commit_assistant_with_tool_calls` in-place filter mutates list concurrently iterated by executor task** — adversarial #8, conf 50. Correct today because dict identity survives the filter (undocumented invariant). `src/stupidex/llm/client.py:498-532`.

## Testing Gaps

- **Stream-idle retry path untested with partial delivery** — no test simulates "3 chunks, then stalls > idle_timeout, then retries" and asserts no duplicate messages. `tests/test_streaming_messages.py`.
- **`commit_assistant_with_tool_calls` all-malformed filter (empty `tool_calls`) untested** — whether subsequent tool_call deltas become orphaned tool results. `tests/test_streaming_messages.py`.
- **MCP per-server timeout transport-enter hang (`fail_enter=True`) fixture defined but never driven** — `tests/test_mcp_startup_timeout.py:6857`.
- **`_read_bounded` overflow-trim stderr-only sub-branch untested** — `src/stupidex/tools/exec.py:4932`.
- **Streaming tests mutate module-global `llm_client._execute_tool` outside `patch` context** — brittle under `pytest-timeout`. `tests/test_streaming_messages.py:8923` (7 sites). Use `with patch.object(...)`.
- **`test_max_results_does_not_leak_tasks` tolerates `+1` slack** — admits exactly the leak the fix prevents. `tests/test_search.py:7969`. Tighten to `<= tasks_before`.
- **`_maybe_offload_tool_output` `except OSError` cache-write failure branch untested** — `src/stupidex/llm/client.py:4878`.
- **No test for `TodoStore.create` exhausting 8 retries** — verify it propagates as `ExecutorResult`, not an unhandled exception. `src/stupidex/domain/todo.py:91`.
- **`_check_positive_float` branches and float ENV cast not exercised** — `src/stupidex/config.py:177-178,345-351`.
- **Rename-rejected test doesn't assert pre-edit fields unchanged** — see P2-B. `tests/test_settings_screen.py`.

## Residual Risks (advisory)

- **Offload recovery depends on no workspace path confinement (P0-3 deferred).** The pointer tells the LLM to `read` the cache file at `~/.stupidex/cache/...` — outside the workspace. The moment P0-3 path confinement lands, the agent will be silently unable to read its own offloaded outputs. Consider writing cache under `.stupidex/cache/` in cwd, or adding an allowlist exemption, before P0-3 ships. (`src/stupidex/llm/client.py:140-171`, `src/stupidex/tools/file_manipulation.py:38`)
- **`session_id` used as path component without uuid validation.** Not exploitable across a trust boundary (requires prior write access to per-user sessions dir), but the new offload sink and pre-existing `delete_session` rmtree both inherit it. Defense-in-depth: validate uuid format at `load_session` boundary. (`src/stupidex/llm/client.py:107-108`)
- **`llm_stream_retries` config has no upper bound.** `STUPIDEX_LLM_STREAM_RETRIES=30` → max backoff `0.2*2^29s`. Add `min(retries, 10)`. (`src/stupidex/llm/client.py:707`)
- **Overall agent-turn wall-clock still unbounded (P1-12 deferred).** Idle timeout bounds per-chunk latency but a provider emitting one chunk every ~290s for hours won't trip it. (`src/stupidex/llm/client.py`)
- **`wait_for_subagent` still unbounded and timeout-exempt.** A subagent wedged in a `_TOOLS_WITHOUT_TIMEOUT` tool hangs the parent indefinitely. Add a configurable timeout defaulting to `llm_stream_idle_timeout`. (`src/stupidex/llm/client.py:37-44`)
- **MCP start_all implies parallel but is sequential.** Worst case N × per_server_timeout (bounded by startup_timeout overall). Not a regression. (`src/stupidex/mcp/__init__.py:121`)
- **`docs/solutions/` is essentially empty.** This branch's 15+ distinct topics (atomic writes, bounded exec, streaming dedup, PENDING→INTERRUPTED migration, ContextVar centralization, etc.) are strong candidates for `/ce-compound` after the work lands.

## What's Working Well

- **Subagent state-transition observability is solid.** `_cancel_record` centralizes transition + fires `on_state_change`; PENDING→INTERRUPTED migration guarantees restored records are terminal; `interrupt_subagents` returns structured `cancelled`/`already_done`/`not_found` content. Per-subagent `_mount_lock` fixes the shared-`StreamWidgetState` race without changing tool contracts.
- **Tools remain composable primitives.** `atomic_write` exported and reused by both `edit` and `write`; `_maybe_offload_tool_output` composes with `read` for recovery; skill-dependency resolver separates `_stack` (cycle detection) from `_resolved` (memoization).
- **MCP lifecycle is now bounded** with config + env-var wiring and a non-fatal skip-and-continue path (partial failure doesn't brick the loop). Registry key `mcp::server::tool` is injective — eliminates silent executor shadowing.
- **P1-46 path traversal fix is robust.** Verified against absolute paths, `..` traversal, in-dir symlinks-to-outside, Windows backslash, empty/leading-slash splits. No bypass found.
- **Security: no new exploitable vulnerabilities.** MCP server-name validation gates command spawn before any subprocess/transport is constructed. Tool-output offload slug sanitizes LLM-controlled inputs.
- **172 new tests are high quality** — concrete behavioral assertions, real-fs fixtures, genuine concurrency coverage in `test_subagent_manager.py` and `test_mcp_startup_timeout.py`.

## Fix Priority

| Priority | Finding | Effort |
|----------|---------|--------|
| **P0** | P0-A: mount-lock test coverage | Small (1 test file) |
| **P1** | P1-A: stream retry rollback | Medium (snapshot/restore api_messages + delivered_any gate) |
| **P1** | P1-B: acompletion timeout + transient-error retry | Medium (httpx timeout + broader except) |
| **P1** | P1-C: RAG per-file vectors load+save | Medium (restore single-flush for loop path) |
| **P1** | P1-D: commit_assistant in-place filter | Medium (don't mutate shared list) |
| **P1** | P1-E: offload cross-turn replay | Medium (persist pointer on Message) |
| **P1** | P1-F: offload blocking I/O on event loop | Small (run_in_executor wrap) |
| **P1** | P1-G: shadow-warning tautology test | Small (rewrite via real code path) |
| **P1** | P1-H: config inline validation | Trivial (safe_auto) |
| **P2** | P2-A through P2-E | Varies |
