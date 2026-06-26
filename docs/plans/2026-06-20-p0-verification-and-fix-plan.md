# P0 Verification & Fix Plan — Code Review Sweep

**Date:** 2026-06-20
**Source:** `2026-06-20-full-sweep-all-findings.md` (P0-4 through P0-8)
**Verification mode:** 5 parallel `general` subagents, research-only, no code mutations
**Result:** All 5 findings **CONFIRMED** as real bugs/gaps

P0-1, P0-2, P0-3 were moved to `README.md` → "P0 - Code Review" TODO; they are not covered here.

---

## P0-4 — Incremental RAG re-index wipes unchanged chunks/vectors

**Verdict:** CONFIRMED

### Evidence
- `RAGStore.upsert` (`rag/store.py:100-143`) runs `DELETE FROM chunks; DELETE FROM files` unconditionally at the top, then re-inserts only the rows it was passed.
- `_index_project_impl` (`rag/indexer.py:226-229, 243-244, 256-257`) skips unchanged files via hash check and only extends `all_chunks`/`all_embeddings` for changed files. The resulting `_flush_store(store, all_chunks, all_embeddings)` call passes only changed files' data.
- `self._save_vectors(embeddings)` (`rag/store.py:143, 145-159`) overwrites `vectors.npy` with only changed files' embeddings.
- The hash-restore loop (`rag/indexer.py:269-277`) only writes the `files` row hash column via `update_file_hash` (`store.py:437-447`); it does **not** restore chunks or vectors.
- **Net effect:** on the first incremental run with 1 of N files edited, RAG coverage collapses from N files → 1 file and stays collapsed. Silently.

**Note:** the bug is exclusively in the `index_project` batch path. The per-file `indexer.update_file` (line 54-97) → `store.upsert_file` (store.py:325-391) path is correct and preserves other files' chunks/vectors.

### Fix plan
Reuse the existing correct primitive `RAGStore.upsert_file` (`store.py:325`) instead of the destructive `upsert` for the batch path.

1. **`rag/indexer.py:_index_project_impl` (~lines 200-292):** Replace the batched `_flush_store(store, all_chunks, all_embeddings)` call (line 257) with a per-file `await loop.run_in_executor(None, store.upsert_file, rel, chunks, embeddings)` immediately after embedding succeeds (after line 244). Delete the `all_chunks`/`all_embeddings` accumulators and the `_flush_store` call.
2. **Keep the hash update** (lines 260-267), still calling `update_file_hash` per changed file (since `upsert_file` writes `hash=''` at store.py:362).
3. **`rag/indexer.py:156-163` empty-files branch:** repurpose as explicit `store.clear()` + `touch_last_indexed()` rather than routing through `upsert` (stays correct, intent becomes explicit).
4. **Delete the hash-restore loop** (indexer.py:269-277): dead code once per-file `upsert_file` is used.
5. **Deleted-file handling** (indexer.py:280-292, `store.delete_by_file`): already correct, no change.
6. **Optional cleanup:** rename `RAGStore.upsert` → `rebuild_all` with `force=True` parameter, or remove entirely once `index_project` stops using it.

### Tests to add (`tests/rag/` or matching existing layout)
- `test_incremental_preserves_unchanged` — index 3 files; re-index after editing 1; assert `total_chunks` and `len(_load_vectors())` still cover all 3 files, `search()` returns hits from unchanged files.
- `test_incremental_updates_changed_file` — after edit, changed file's chunks reflect new content; old content no longer searchable.
- `test_incremental_deleted_file` — remove a file; re-index; assert its chunks/vectors are gone and others remain.
- `test_index_after_all_files_removed` — assert index clears to empty (regression for `if not files` branch).
- Invariant assertion in `upsert_file` path: `len(vectors) == len(chunks)` after the run.

No schema changes, no migrations. Localized to `rag/indexer.py` and (optionally) `rag/store.py`.

---

## P0-5 — `wait_for_subagent` has no timeout AND is excluded from 60s tool timeout

**Verdict:** CONFIRMED (mechanism in the companion report is imprecise; wedge outcome is correct)

### Evidence
- `wait_for_subagent` is listed in `_TOOLS_WITHOUT_TIMEOUT` at `llm/client.py:25`. `_execute_tool` (`client.py:236-239`) bypasses the 60s `asyncio.wait_for` wrap for this set; the executor runs bare.
- `execute_wait_for_subagent` (`tools/subagent.py:102-106`) does `await get_subagent_manager().wait(subagent_ids)` — no `asyncio.wait_for`, no deadline.
- `SubagentManager.wait()` (`agents/manager.py:285-296`) calls `await asyncio.gather(*tasks, return_exceptions=True)` with no timeout.
- **Wedge trace:** if a subagent's `async_task` hangs (e.g. its own `litellm.acompletion` call at `client.py:465` has no `timeout=` either), `manager.wait()` blocks forever; the executor is parked; the parent agent loop has no recovery short of `Ctrl+C`.
- **Companion report's `msg_q (maxsize=1) stalls stream_task` sub-claim is imprecise** — the actual wedge is the unbounded `asyncio.gather` inside `manager.wait()`, not msg_q backpressure. The outcome (full agent-loop wedge) is correct.

### Fix plan — layered timeouts
1. **Executor-level (primary fix):** in `execute_wait_for_subagent` (`tools/subagent.py:106`), wrap the wait:
   ```python
   _SUBAGENT_WAIT_TIMEOUT = 600  # 10 min ceiling; subagents legitimately run long
   try:
       records = await asyncio.wait_for(
           get_subagent_manager().wait(subagent_ids),
           timeout=_SUBAGENT_WAIT_TIMEOUT,
       )
   except TimeoutError:
       # return partial results + a <timed_out> element for unfinished IDs
   ```
   On timeout: return records for finished subagents + an explicit `<timed_out>` marker for the rest. Do not raise — let the parent agent decide to `interrupt_subagents` and retry.
2. **Manager-level (defense in depth):** give `SubagentManager.wait()` an optional `timeout: float | None = None` parameter (`agents/manager.py:285`):
   ```python
   await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=timeout)
   ```
   Default `None` so other internal callers are unaffected.
3. **Keep `wait_for_subagent` IN `_TOOLS_WITHOUT_TIMEOUT`** — removing it would impose the 60s `_TOOL_TIMEOUT`, far too short for real subagent work (code review, multi-file edits). The 600s executor ceiling replaces the missing safety net.
4. **Optional but recommended:** add `timeout=` to `litellm.acompletion` at `client.py:465` (configurable `_STREAM_TIMEOUT`) so a hung provider stream doesn't wedge a subagent in the first place.

### Tests to add
- `tests/agents/test_manager.py::test_wait_times_out` — register a subagent whose `_run` awaits an `Event` that never fires; `manager.wait([id], timeout=0.1)` returns within ~0.2s with record still non-terminal.
- `tests/agents/test_manager.py::test_wait_returns_partial_on_timeout` — mix one finished + one hung; assert timeout returns finished record and lists hung one as timed out.
- `tests/tools/test_subagent.py::test_wait_for_subagent_executor_timeout` — monkeypatch `manager.wait` to block forever; monkeypatch `_SUBAGENT_WAIT_TIMEOUT = 0.05`; assert executor returns within ~0.1s with `ExecutorResult` containing a `<timed_out>` block (not raising).
- `tests/tools/test_subagent.py::test_wait_for_subagent_respects_long_running` — a subagent that sleeps 1s then completes; assert executor with 600s default returns real result (regression guard).

---

## P0-6 — MCP startup has no overall timeout; hung server blocks `App.on_mount`

**Verdict:** CONFIRMED

### Evidence
- `_start_server` (`mcp/__init__.py:124-152`) awaits `session.initialize()` (line 138), `session.list_tools()` (line 141), `session.list_resources()` (line 150), and the transport `enter_async_context` calls (lines 128, 135) with no `asyncio.wait_for`. Any of these can hang indefinitely.
- The `_run` per-server loop (lines 76-83) awaits `_start_server` with no timeout. A hang never reaches the `except Exception` branch — the server is stuck in "starting forever" state, not marked "failed".
- `start_all` (lines 66-67) does `await self._ready.wait()` with no overall timeout. `_ready` is set only in `_run`'s `finally` (line 88), so a hang in `_start_server` parks here forever.
- App layer (`app.py:135-137`) awaits `start_all` inside `App.on_mount`; Textual does not impose an internal timeout on `on_mount`. UI never becomes interactive.
- `_await_runner`'s 3s shutdown timeout (`mcp/__init__.py:107-115`) is structurally unreachable from the hang path — it lives behind `on_unmount`, which is gated on `on_mount` returning.
- Related: per-server `Exception` IS swallowed (lines 81-83); only the *hang* case is unbounded. Consistent with P2-112/117/118 being separate, lower-severity findings.

### Fix plan
1. **Per-server timeout in `_start_server` (primary):** wrap each blocking RPC with `asyncio.wait_for(..., timeout=per_server)`:
   - Line 138: `await asyncio.wait_for(session.initialize(), timeout=per_server)`
   - Line 141: `await asyncio.wait_for(session.list_tools(), timeout=per_server)`
   - Line 150: `await asyncio.wait_for(session.list_resources(), timeout=per_server)`
   - Also wrap the transport `enter_async_context` calls (lines 128, 135) — a slow/hung `stdio_client`/`sse_client` shouldn't block. May need separate (shorter) connect timeout vs RPC timeouts.
   - Default `per_server ≈ 10s` (generous for cold stdio subprocess spawn + initialize).
   - On `TimeoutError`: it propagates out of `_start_server` into `_run`'s `except Exception` (line 81), gets marked `"failed"` with `str(e)[:80]`, loop continues. No new handling needed.
   - **Caveat to verify during fix:** when `wait_for` cancels the wrapped await, the transport (entered via `AsyncExitStack`) must be torn down via the exit stack's `aclose()` so the runner doesn't idle with a half-open transport. Best practice: wrap the whole `_start_server` body in a `wait_for` and rely on the exit stack's finally.
2. **Overall safety net in `start_all` (secondary):** replace `await self._ready.wait()` (line 67) with:
   ```python
   await asyncio.wait_for(self._ready.wait(), timeout=overall)
   ```
   Default `overall ≈ 60s`. On `TimeoutError`: cancel the runner, `await asyncio.wait_for(self._runner, timeout=3)` to let `_run`'s finally close transports, then either raise (fail-fast) or skip-and-continue (mark manager usable / no manager). **Recommended: skip-and-continue** — matches the existing "best effort" design (lines 81-83) and lets the user use the app without MCP.
3. **Make the existing `_await_runner` 3s timeout actually reachable** — independent of fixes 1/2, wrap the `start_all` call (`app.py:137`) in `wait_for` so a hung startup is cancellable from `on_mount`. Belt-and-suspenders; keeps responsibility where the report's `action=manual` implies it belongs.

### Tests to add
- `test_start_server_times_out_on_hung_initialize` — fake MCP stdio server whose `initialize` awaits an `Event` that never fires; assert `start_all` returns within `per_server + slack`, hung server status `"failed"`, others still connect.
- `test_start_all_overall_timeout` — N servers each blocking `initialize`; assert `start_all` aborts within `overall` and returns (skip-and-continue) with manager usable or marked unavailable.
- `test_start_server_per_call_timeout_list_tools` — server whose `initialize` succeeds but `list_tools` hangs; assert timeout fires at the `list_tools` step (not `initialize`), status `"failed"`, `tool_count` 0.
- `test_shutdown_timeout_reachable_after_hang` — simulate hung `start_all`; call `MCPManager.schedule_shutdown`; assert `_await_runner`'s 3s path executes within budget (guards against regression of the "dead code in hang path" symptom).
- `test_partial_failure_does_not_block_others` — regression guard for P2-112/117/118: one raising, one hanging-with-timeout, one healthy; assert healthy server's tools available, statuses `failed`/`failed`/`connected`, `start_all` returns.

---

## P0-7 — TodoStore state machine has zero direct test coverage

**Verdict:** CONFIRMED (zero direct AND zero indirect coverage)

### Evidence
- 27-file `tests/` search: zero matches for `todo`, `Todo`, `TodoStore`, `TodoStatus`, or `TodoTask`.
- The only `to_storage_dict`/`from_storage_dict` round-trip test (`tests/test_streaming_messages.py:532`) exercises `Message`, not `TodoStore`.
- No test loads a session via `Session.from_storage_dict` (which would invoke `TodoStore.from_storage_dict` at `session.py:57`).
- `tests/test_sidebar_collapsible.py` uses a `_MockSession` without a real `todo_store` — does NOT exercise the real `TodoStore` or `VALID_TRANSITIONS`.

### Untested branches in `src/stupidex/domain/todo.py`
| Path | Lines |
|------|-------|
| `TodoStatus.from_str` happy+error path | 21-28 |
| `TodoStore.create` (uuid, timestamps, default OPEN) | 68-85 |
| `TodoStore.get` (existing + missing) | 87-88 |
| `TodoStore.list` unfiltered + status/subagent filters | 90-99 |
| `TodoStore.update` not-found / terminal-rejection / invalid-transition / valid transition / field update / `updated_at` bump | 113-133 |
| `TodoStore.delete` (existing + missing) | 136-137 |
| `TodoStore.to_storage_dict` / `from_storage_dict` round-trip | 139-156 |
| `get_todo_store` / `set_todo_store` ContextVar | 162-171 |

0% direct coverage of every branch in the module.

### Fix plan
Create **`tests/test_todo_store.py`**. Use plain pytest + `assert` (no Textual harness needed). Fixture `fresh_store()` returns a `TodoStore()` instance and calls `set_todo_store()` where relevant.

**Test functions:**
1. `test_from_str_valid_statuses` — every enum value lower-cased round-trips; case-insensitivity (e.g. `"DONE"` works via `.lower()` at todo.py:24).
2. `test_from_str_invalid_raises_valueerror` — invalid string raises `ValueError` whose message lists all valid statuses (assert format at todo.py:27).
3. `test_create_assigns_id_title_open_status_timestamps` — `create("x")` returns `TodoTask` with 8-hex id (todo.py:76), `status=OPEN`, `created_at`≈`updated_at`>0.
4. `test_create_with_description_and_subagent` — optional args persisted.
5. `test_get_existing_and_missing` — `get` returns task; `get("nope")` returns `None`.
6. `test_list_unfiltered_returns_all` — create 3, `list()` length 3.
7. `test_list_filter_by_status` — `list(status=OPEN)` returns only OPEN.
8. `test_list_filter_by_subagent_id` — `list(subagent_id="a")` returns only matching.
9. `test_update_title_description_subagent` — non-status fields update + `updated_at` strictly increases.
10. `test_update_status_valid_transition` — OPEN→IN_PROGRESS succeeds, returns `(task, None)` (todo.py:120,124).
11. `test_update_status_invalid_transition_returns_error` — OPEN→DONE returns `(None, "Cannot transition from 'open' to 'done'...")`, state unchanged.
12. `test_update_terminal_status_rejected` — force DONE then attempt title update → `(None, "Task ... is in terminal status 'done'...")`; include ABANDONED.
13. `test_update_missing_task_returns_notfound_error` — `update("z")` → `(None, "No task found with ID 'z'.")`.
14. `test_delete_existing_and_missing` — delete returns task and removes it; delete again returns `None`.
15. `test_storage_roundtrip_preserves_all_fields` — populate store (multiple tasks, varied statuses incl. terminal, subagent ids); `to_storage_dict()` → `from_storage_dict()`; assert task count, ids, titles, descriptions, statuses, subagent_ids, `created_at`/`updated_at` all equal.
16. `test_from_storage_dict_empty_and_missing_tasks_key` — `from_storage_dict({})` and `from_storage_dict({"tasks": []})` both yield empty store.
17. `test_from_storage_dict_status_fallback_default_open` — task dict without `"status"` key → defaults to OPEN (todo.py:150).
18. `test_get_todo_store_lazy_init_and_set_todo_store` — `get_todo_store()` creates + caches on ContextVar; `set_todo_store(s)` overrides.

Run with `pytest tests/test_todo_store.py` (match existing repo convention).

---

## P0-8 — SubagentManager.spawn / `_run` lifecycle has zero direct test coverage

**Verdict:** CONFIRMED (with caveat on the report's framing of the four fix commits)

### Evidence
- No `tests/test_*subagent*.py` or `tests/test_*manager*.py` files exist.
- `tests/test_sidebar_collapsible.py` is the only test importing `SubagentRecord`; it bypasses the manager via `object.__new__(SubagentRecord)` (test_sidebar_collapsible.py:34) and uses a `_MockManager` stub (lines 148-156). Never invokes `spawn`, `_run`, `cancel_*`, `wait`, `from_storage_dict`.
- `tests/test_streaming_messages.py` exercises `Message.from_storage_dict` and `record_streamed_message`; never `SubagentRecord.from_storage_dict` or `SubagentManager`.
- No indirect coverage via `src/stupidex/tools/subagent.py` — no tests import it.

### Caveat — the four "fix" commits do NOT touch SubagentManager
| SHA | Files touched | Tests added |
|-----|---------------|-------------|
| 406e032 | `domain/chain.py`, `domain/message.py`, `llm/client.py`, `tests/test_streaming_messages.py` | streaming-message tests only |
| da0ff86 | `domain/message.py`, `tests/test_streaming_messages.py` | streaming-message tests only |
| ff4434e | `domain/message.py`, `llm/client.py`, `tests/test_streaming_messages.py` | streaming-message tests only |
| df34ea4 | `mcp/__init__.py`, a docs `.md` | no pytest tests |

`git show --stat` confirms `src/stupidex/agents/manager.py` is absent from every diff. These commits harden *streaming/persistence* of messages inside `stream_response` (`llm/client.py`) and `Chain` — not the `SubagentManager` lifecycle. The finding's title stands; its "context" rationale misattributes the commits' scope.

### Untested code paths in `src/stupidex/agents/manager.py`
- `spawn()` (201-283) — registry lookup, record creation, `on_spawn` fire-and-forget, `asyncio.create_task`.
- `_run()` closure (233-277) — PENDING→RUNNING + `on_state_change`; user msg append + `on_message` + `messages_mounted` increment; streaming loop, `record_streamed_message`, second `on_message`/`messages_mounted` path, TEXT result capture; COMPLETED transition; CancelledError → INTERRUPTED; Exception → FAILED; `finally` sets `end_time` + final `on_state_change`.
- `cancel_one` (173-179), `cancel_all` (181-189, incl. `self.on_spawn = None` teardown), `cancel_running` (191-199, non-terminal filter).
- `wait` (285-296, `asyncio.gather` with `return_exceptions=True`).
- `from_storage_dict` RUNNING→INTERRUPTED migration (150-152).
- `to/from_storage_dict` round-trip (108-164).
- `get_states` / `get_record` / `all_records` (298-318).
- ContextVar accessors `get_subagent_manager`/`set_subagent_manager` (38-43).

### Fix plan
Create **`tests/test_subagent_manager.py`**. Use a fake `stream_response` monkeypatched into `stupidex.llm.client.stream_response` (or the local symbol used inside `_run`) yielding an async iterator of canned `Message` objects, and a fake `get_agent_registry` returning a stub `Agent`. No network, no real LLM. Each test drives a real `SubagentManager.spawn(...)` and awaits `record.async_task` (or cancels it).

**Fixtures:**
- `fake_agent` — `stupidex.domain.agent.Agent` instance (or stub dataclass) with `name`, `type.value`, `allowed_tools`, `system_prompt`, `allowed_skills`.
- `fake_registry` — dict `{"Subagent": fake_agent}` patched into `stupidex.agents.get_agent_registry`.
- `fake_stream` — async-iterator factory patched into `stupidex.llm.client.stream_response`. Yields `Message` objects of controlled types (TEXT, TOOL_CALL, TOOL_RESULT, THINKING) so all branches of `record_streamed_message` and `on_message`/`messages_mounted` paths are exercised.
- `collecting_callbacks` — `AsyncMock` (or plain coroutine stubs) for `record.on_message`, `record.on_state_change`, and `manager.on_spawn`, asserting call args and ordering.

**Tests to add:**
1. `test_spawn_happy_path_transitions_pending_running_completed` — spawn, await `async_task`; assert `record.state == COMPLETED`, `start_time`/`end_time` set, `record.result` == final TEXT content.
2. `test_spawn_fires_on_spawn_callback_with_record` — `manager.on_spawn` collecting; after spawn (before await) callback awaited exactly once with the PENDING record.
3. `test_run_fires_on_state_change_running_then_completed` — collecting `on_state_change`; assert two calls in order: RUNNING then COMPLETED.
4. `test_on_message_invoked_for_user_msg_and_each_streamed_msg` — collecting `on_message`; assert call count == 1 + len(fake_stream yields) and call args are appended messages.
5. `test_messages_mounted_counter_increments_per_appended_message` — assert `record.messages_mounted == len(record.messages)` after completion; verify the `appended` gate at :257-258 (yield a TOOL_RESULT that does not append → counter does not increment).
6. `test_finally_block_fires_on_state_change_on_completion` — assert final `on_state_change` call happens *after* `end_time` is set (ordering via callback reading `record.end_time`).
7. `test_finally_block_fires_on_state_change_on_cancel` — `record.async_task.cancel()` mid-stream; await and suppress `CancelledError`; assert state transitions PENDING→RUNNING→INTERRUPTED, `error == "Interrupted by user"`, `end_time` set, `on_state_change` called with INTERRUPTED from the `finally`.
8. `test_finally_block_fires_on_state_change_on_exception` — `fake_stream` raises `RuntimeError("boom")`; assert state FAILED, `error == "boom"`, `on_state_change` called with FAILED.
9. `test_cancel_one_cancels_running_task_returns_true` — spawn but stall `fake_stream`; `cancel_one(id)`; returns `True`, task transitions to cancelled, record INTERRUPTED on next await.
10. `test_cancel_one_returns_false_for_missing_or_done` — missing id → `False`; completed task → `False`.
11. `test_cancel_all_cancels_running_and_clears_on_spawn` — spawn 2 stalled subagents; `cancel_all()`; both ids returned, both tasks cancelled, `manager.on_spawn is None` afterwards (pins :188 teardown).
12. `test_cancel_running_skips_terminal_records` — `_subagents` with one RUNNING + one COMPLETED (with non-done async_task stub); assert only RUNNING id is cancelled.
13. `test_wait_returns_records_for_valid_ids_and_skips_unknown` — spawn + complete two subagents; `wait([id1, id2, "unknown"])`; dict has id1/id2 records, no KeyError for unknown.
14. `test_wait_awaits_inflight_tasks` — spawn a stalled subagent; `wait([id])` must block until `fake_stream` completes; wait returns only after task done.
15. `test_from_storage_dict_running_migrates_to_interrupted` — dict with `state="running"`; `from_storage_dict(...)` yields `state == INTERRUPTED`.
16. `test_to_storage_dict_round_trips_completed_record` — build `SubagentRecord` with messages, result, error, start/end; `to_storage_dict()` → `from_storage_dict()` → all fields equal, `messages` round-trip; `async_task`/`on_message`/`on_state_change` are `None` on restore.
17. `test_from_storage_dict_falls_back_to_pseudoagent_when_registry_misses` — patch `get_agent_registry().get` to return `None`; assert record still constructs with `agent.name == agent_name` and `type == AgentTypes.<from_str(agent_type)>` (pins the duplicated-fallback branch at :130-149; also covers P2-26 indirectly).
18. `test_spawn_unknown_agent_type_raises_valueerror` — `spawn(..., agent_type="nope")` raises `ValueError` with "Available:" list (pins :215-218).
19. `test_get_states_all_records_get_record` — assert `get_states()` shape (`id`/`name`/`type`/`task`/`state`/`elapsed` keys), `all_records()` returns inserted records in insertion order, `get_record(unknown)` returns `None`.

Run with `pytest tests/test_subagent_manager.py` (follow `tests/test_streaming_messages.py` style — `unittest.IsolatedAsyncioTestCase` or top-level `async def` per existing patterns).

---

## Recommended fix order

1. **P0-7 + P0-8 tests first** — unblock regression guards for everything else; pure test additions with no behavioral changes.
2. **P0-4 RAG incremental wipe** — localized, highest user-visible impact, no API/schema changes.
3. **P0-6 MCP startup timeout** — layered timeouts; start with per-server in `_start_server`.
4. **P0-5 subagent wait timeout** — depends on the same timeout pattern as P0-6; pair with the `wait()` parameter addition.

P0-1/2/3 (SSRF, prompt-injection→shell, path confinement) remain in `README.md` TODO for separate handling — they're larger defense-in-depth changes (URL allowlists, output envelope markers, workspace-root guard) that warrant their own design pass.
