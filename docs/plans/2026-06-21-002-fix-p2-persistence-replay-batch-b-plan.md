---
title: "fix: P2 persistence/replay robustness (Batch B)"
type: fix
status: active
date: 2026-06-21
origin: todo-pendings-fixes.md (P2-1, P2-8, P2-9, P2-23, P2-24, P2-26, P2-31, P2-34, P2-36)
---

# fix: P2 persistence/replay robustness (Batch B)

## Summary

Harden the persistence-replay surface so one corrupt chain, one malformed message, one unknown enum value, or one missing timestamp no longer aborts entire session recovery or leaves restored subagents in non-terminal forever-growing state. Also makes subagent cancellation deterministic so the INTERRUPTED transition is guaranteed to fire before callers continue. Covers nine P2 findings from `todo-pendings-fixes.md` in three files (`domain/session.py`, `domain/message.py`, `agents/manager.py`) plus two async call sites.

---

## Problem Frame

The persistence layer in `domain/session.py` and `agents/manager.py` deserializes sessions, chains, messages, and subagent records from disk-written JSON. Today, every `from_storage_dict` site uses bare enum constructor calls (`MessageRole(data["role"])`, `SubagentState(...)`, `AgentTypes.from_str(...)`) that raise on unknown values — one drifted field aborts the whole session load, losing all conversation history. Restored INTERRUPTED subagents with `end_time=None` produce forever-growing `elapsed_seconds` because the fallback chain `end_time = data.get("end_time") or start_time or time.time()` only triggers when both fields are falsy; if `start_time` is set but `end_time` is missing, elapsed reports 0.0 (underreport), and if both are 0/None (PENDING case), elapsed becomes `time.time() - 0.0` ≈ 1.7 billion seconds (absurd). Restored subagent messages also skip the orphan TOOL_RESULT reconciliation that parent chains already run (commit `406e032`), so on-disk corruption lingers indefinitely in the subagent path.

Separately, `SubagentManager.cancel_all` / `cancel_running` / `cancel_one` fire the `on_state_change(INTERRUPTED)` callback via `_fire_and_forget` and immediately return, so callers (ESC-to-interrupt handler, subagent interrupt tool) continue before the UI pane has observed the INTERRUPTED transition. Pane teardown racing the fire-and-forget task produces stale UI.

`SessionManager.delete` mutates in-memory state (`del self.sessions[id]`, `self.active = None`) before calling `delete_session(id)` on disk. If the disk delete fails (permissions, missing file, full disk), the in-memory state is already gone — next `save_active`/restart sees no session to save, and the disk file remains as a ghost that loads on next boot.

---

## Requirements

- R1. `SessionManager.delete` MUST remove the session from disk before mutating in-memory state; if disk deletion fails, in-memory state MUST remain intact and the caller MUST be informed.
- R2. `Session.from_storage_dict` MUST not abort whole-session load when a single `Chain.from_storage_dict` raises; corrupt chains MUST be skipped with a warning, and surviving chains MUST still load.
- R3. `Message.from_storage_dict` MUST not raise on unknown `role` or `type` enum values; the message MUST load with a safe fallback role/type and a `metadata["_deserialize_warning"]` entry documenting the drift.
- R4. `SubagentRecord.from_storage_dict` MUST not raise when `AgentTypes.from_str(agent_type)` raises on unknown agent_type; the record MUST load with `AgentTypes.SUBAGENT` fallback and a warning.
- R5. Restored INTERRUPTED records with `end_time=None` MUST produce non-growing, non-absurd `elapsed_seconds`; if start_time is 0, start_time MUST be set to `end_time` so elapsed reports 0.0 (never started) instead of `time.time()`.
- R6. Restored subagent messages MUST run the same `_reconcile_orphan_tool_results` pruning that parent chains run, so on-disk orphan TOOL_RESULTs converge on the clean state on first load.
- R7. `cancel_one` / `cancel_all` / `cancel_running` MUST provide a primitive that lets async callers deterministically await pending `on_state_change` callbacks before continuing; callbacks MUST NOT be silently dropped on event-loop shutdown.
- R8. P2-36 ("Persistence replay silently accepts state=PENDING") MUST be verified already-fixed via the PENDING→INTERRUPTED migration at `manager.py:158-159` (committed as part of P1-1 / U9); if verification holds, mark as duplicate-of-P1-1 with characterization test.

---

## Scope Boundaries

- NO changes to `record_streamed_message` SYSTEM-role mutation bug (pinned by Batch A characterization test; deferred to Batch C)
- NO changes to `format_subagent_attrs` `"`-escaping XML attribute injection (P2-49 BLOCKED; deferred to Batch C)
- NO changes to `_reconcile_orphan_tool_results` dedup logic for repeated TOOL_RESULT same tool_call_id (P2-3, advisory, separate batch)
- NO changes to TodoStore.from_storage_dict corrupt-status handling (P2-10/P2-17, manual — different deserialization path, separate batch)
- NO restructuring of `cancel_*` API to be async-only (only adds optional async flush primitive)
- NO changes to `SubagentManager._subagents` private-attr access from `SubagentRecord.from_storage_dict` (P2-2, manual — refactor concern not robustness)
- NO migration of `start_time`/`end_time` from `time.monotonic()` to wall-clock (P3-3, advisory)

### Deferred to Follow-Up Work

- Typing fixes for `from_storage_dict` parameter annotations (P2-134, P2-135, P3-74): manual tier, Batch D
- `_fire_and_forget(coro: Coroutine)` bare Coroutine typing (P2-43): manual tier, Batch D
- Subagent memory unbounded growth / `_subagents` never pruned (P2-33): manual tier, requires reaping policy
- `wait()` no timeout (P2-37): manual tier, requires configurable timeout decision

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/domain/session.py:54-71` — `Session.from_storage_dict` (current site, has try/except around subagent restore but not chains)
- `src/stupidex/domain/session.py:109-119` — `SessionManager.delete` (mutates before disk delete)
- `src/stupidex/domain/message.py:79-107` — `Message.from_storage_dict` (bare enum constructors)
- `src/stupidex/agents/manager.py:130-173` — `SubagentRecord.from_storage_dict` (timing fallback, duplicated Agent construction)
- `src/stupidex/agents/manager.py:182-219` — `_cancel_record` / `cancel_one` / `cancel_all` / `cancel_running`
- `src/stupidex/domain/chain.py:57-68` — `Chain.from_storage_dict` (already invokes `_reconcile_orphan_tool_results`)
- `src/stupidex/domain/chain.py:71-110` — `_reconcile_orphan_tool_results` (module-level function, mutates list in place)
- `src/stupidex/app.py:189-199` — ESC handler, calls sync `cancel_running()`
- `src/stupidex/tools/subagent.py:187-224` — async tool executor, calls `cancel_running` and `cancel_one`

### Institutional Learnings

- `docs/solutions/` is essentially empty (called out as BR-RR-7). This batch is a candidate for `/ce-compound` after landing: persistence-replay fail-soft pattern + cancellation determinism.
- Prior P1 sweep (commit `406e032`) explicitly applied orphan reconciliation only to parent chains; subagent path was deferred. P2-31 closes that gap.
- Prior P1-1 / U9 work already migrated PENDING→INTERRUPTED on restore. P2-36 is a duplicate finding; this batch verifies and pins the invariant.

### External References

- None — internal persistence format, no external contract.

---

## Key Technical Decisions

- **Disk-first delete ordering**: `SessionManager.delete` calls `delete_session(id)` first; only on success does it remove from `sessions` dict and clear `active`. On failure, returns `False` and logs. Matches the fail-safe principle (in-memory state stays consistent with disk state). Avoids ghost sessions on disk.
- **Per-chain try/except guard**: Each `Chain.from_storage_dict(c)` call is wrapped individually. Corrupt chains are dropped (not inserted as empty shells) because an empty chain has no semantic meaning and would skew the chain list. Same pattern as the existing subagent-chains loop at `session.py:65-70`.
- **Message enum fallback to SYSTEM + TEXT** with `metadata["_deserialize_warning"]` recording the original value. SYSTEM is chosen because (a) providers tolerate stray system messages, (b) it doesn't pretend to be a tool_call/tool_result pair (which would break replay invariants), and (c) it's the lowest-privilege role. Avoids dropping the message entirely (would break chain length and tool_call_id pairing).
- **Agent fallback consolidation**: Factor Agent construction into a single local helper `_restore_agent(name, type_str)` that tries `registry.get(name)` first, then constructs a fallback `Agent` with `AgentTypes.from_str` wrapped in its own try (falling back to `AgentTypes.SUBAGENT` if `from_str` raises). Removes the duplicated try/except dead path. Uses `AgentTypes.SUBAGENT` as the safe default type (matches the persisted record's intent — subagent).
- **Restored INTERRUPTED end_time/start_time fix**: Compute `now = time.time()` once. If state was migrated PENDING/RUNNING→INTERRUPTED and `end_time` is None: set `end_time = now`. If `start_time` is 0, set `start_time = end_time` (so elapsed = 0.0 for never-started records). This is consistent with the existing fallback chain but addresses the case where `start_time` is set but `end_time` is missing.
- **`_reconcile_orphan_tool_results` shared helper**: Function is module-level in `chain.py` and can be imported directly into `manager.py` (no cycle — `chain.py` already imports `Message` only). Calls it on `messages` after `[Message.from_storage_dict(m) for m in ...]` in `SubagentRecord.from_storage_dict`. Matches `Chain.from_storage_dict` pattern at `chain.py:60`.
- **`flush_state_callbacks()` primitive**: Track pending `on_state_change` fire-and-forget tasks in `SubagentManager._pending_callback_tasks: set[asyncio.Task]`. Convert module-level `_fire_and_forget` to a manager method that registers the task (with `add_done_callback` to discard from the set). Add `async def flush_state_callbacks(self) -> None` that awaits all pending tasks. Update two async call sites (`app.py:191`, `tools/subagent.py:187-224`) to `await manager.flush_state_callbacks()` after cancel_*. `SessionManager.delete` remains fire-and-forget (delete tears down the manager; callback coherence is not required).

---

## Open Questions

### Resolved During Planning

- **Should `Message.from_storage_dict` drop unknown-role messages entirely?** No — dropping breaks chain length and tool_call_id pairing, and would orphan TOOL_RESULTs. Fallback to SYSTEM+TEXT keeps the message visible.
- **Should `cancel_*` methods become async?** No — too broad a cascade (SessionManager.delete is sync, called from command handlers). Add `flush_state_callbacks()` as an optional primitive; sync callers can ignore it.
- **Is P2-36 already fixed?** Yes — the PENDING→INTERRUPTED migration at `manager.py:158-159` covers it (committed as P1-1). P2-36 is a duplicate finding. Verify with a characterization test and mark as duplicate-of-P1-1.

### Deferred to Implementation

- **Exact warning message format for `metadata["_deserialize_warning"]`**: implementer chooses a short, machine-readable string. Recommendation: `f"unknown role '{raw}', falling back to system"`.
- **Whether to log `flush_state_callbacks()` calls:** decision left to implementer; recommend DEBUG-level log of pending count.

---

## Implementation Units

<!-- U-IDs are stable: reordering preserves, splitting keeps original, deletion leaves gaps. -->

- U1. **Disk-first delete in SessionManager.delete (P2-1)**

**Goal:** Eliminate ghost-session-on-disk failure mode by deleting from disk before mutating in-memory state.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/domain/session.py`
- Test: `tests/test_session.py`

**Approach:**
- Reorder `delete()`: call `from stupidex.storage import delete_session; delete_session(id)` FIRST, then mutate in-memory state only on success.
- On `delete_session` exception (OSError, etc.): log warning, return `False`, leave `self.sessions[id]` and `self.active` intact.
- Preserve existing `session.subagent_manager.cancel_all()` invocation BEFORE disk delete (subagent tasks must be cancelled regardless of disk outcome — losing in-memory state to a stuck task is worse than the disk-failure case). `cancel_all()` is fire-and-forget and acceptable here per Key Technical Decisions.
- Move `del self.sessions[id]` and `self.active = None` to AFTER successful disk delete.

**Patterns to follow:**
- Existing `delete_session` from `stupidex.storage` (already imported lazily at line 116)

**Test scenarios:**
- **Happy path**: session exists in `sessions` dict and on disk; `delete()` returns `True`; session removed from dict and disk; `active` cleared if it was the deleted session.
- **Happy path — active is different session**: deleted session is not `active`; `active` is NOT cleared.
- **Happy path — session not in memory but on disk**: `delete()` for unknown id returns `False` without touching disk.
- **Error path — disk delete raises OSError**: `delete_session` raises; `delete()` returns `False`; in-memory `sessions[id]` and `active` are UNCHANGED; warning logged.
- **Integration**: `cancel_all()` is invoked before disk delete attempt (verify with mock).

**Verification:**
- `python -m pytest tests/test_session.py -q` all pass
- New test "disk delete failure preserves in-memory state" passes

---

- U2. **Per-chain deserialization guard in Session.from_storage_dict (P2-8)**

**Goal:** One corrupt chain no longer aborts whole-session recovery.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/domain/session.py`
- Test: `tests/test_session.py`

**Approach:**
- Wrap each `Chain.from_storage_dict(c)` in `Session.from_storage_dict` (currently `session.py:56`) in a try/except.
- On exception: log warning with chain index and exception, skip the chain (do not append an empty Chain — empty chain has no semantic meaning and would skew chain list).
- Mirror the existing subagent-chains loop pattern at `session.py:65-70` (which already has try/except around `SubagentRecord.from_storage_dict`).

**Patterns to follow:**
- Existing subagent-chains loop at `session.py:65-70` (`try: ...; except Exception: log.warning(...)`)

**Test scenarios:**
- **Happy path**: 3 valid chains; all 3 load into `session.chains`.
- **Error path**: 3 chains, middle one has corrupt `status` enum (`"bogus"`); `Session.from_storage_dict` returns session with 2 chains (corrupt one skipped); warning logged.
- **Error path**: 3 chains, first one has `messages` field as string instead of list; loads remaining 2 chains.
- **Edge case**: 0 chains → returns session with empty `chains` list (existing behavior preserved).
- **Integration**: subagent_chains still restored independently (corrupt chain does not cascade to subagent restoration).

**Verification:**
- `python -m pytest tests/test_session.py -q` all pass
- New test "corrupt middle chain does not abort session load" passes

---

- U3. **Message.from_storage_dict enum tolerance (P2-9)**

**Goal:** One malformed message no longer kills session recovery.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/domain/message.py`
- Test: `tests/test_message.py`

**Approach:**
- In `Message.from_storage_dict`, wrap `MessageRole(data["role"])` and `MessageType(data.get("type", "text"))` in try/except ValueError.
- On ValueError for role: default to `MessageRole.SYSTEM` (lowest-privilege, providers tolerate stray system messages, doesn't break tool_call_id pairing); set `metadata["_deserialize_warning"] = f"unknown role '{raw}', falling back to system"`.
- On ValueError for type: default to `MessageType.TEXT`; set `metadata["_deserialize_warning"]` similarly.
- Preserve existing `Usage` tolerance (already added in P1-27).
- Preserve original `content`, `display`, `tool_call_id`, `tool_calls` from data.

**Patterns to follow:**
- Existing `Usage` tolerance at `message.py:82-97` (`.get()` with defaults)

**Test scenarios:**
- **Happy path**: well-formed message with role="assistant", type="text" loads normally.
- **Error path — unknown role**: `role="helper"`; falls back to `MessageRole.SYSTEM`; `metadata["_deserialize_warning"]` records original value; `content` and other fields preserved.
- **Error path — unknown type**: `type="reasoning"`; falls back to `MessageType.TEXT`; warning recorded.
- **Error path — both unknown**: both role and type fall back independently; two warnings recorded.
- **Edge case**: missing `role` key (`KeyError`); fall back to SYSTEM with warning. (Decide: implementer may use `data.get("role", "system")` to avoid KeyError entirely.)
- **Integration**: replay through `Chain.from_storage_dict` does not raise; chain loads with the fallback message.

**Verification:**
- `python -m pytest tests/test_message.py -q` all pass
- New test "unknown role falls back to SYSTEM with warning metadata" passes

---

- U4. **Agent fallback dedup + safe type in SubagentRecord.from_storage_dict (P2-24, P2-26)**

**Goal:** Remove the duplicated Agent construction; make the except path actually work when `AgentTypes.from_str` raises.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/agents/manager.py`
- Test: `tests/test_subagent_manager.py`

**Approach:**
- Define a module-level helper `_restore_agent(name: str, type_str: str) -> Agent` (or inline as a local function inside `from_storage_dict`) that:
  1. Tries `get_agent_registry().get(name)` — returns if found.
  2. Otherwise constructs `Agent(name=name, type=AgentTypes.from_str(type_str), tier=ModelTier.PAPUDO, description="Restored from storage", system_prompt="")`.
  3. If `AgentTypes.from_str` raises `ValueError`: falls back to `AgentTypes.SUBAGENT` (matches subagent intent) and logs warning.
- Replace the existing try/except block (lines 136-156) with a single call to this helper.
- Removes P2-26's "duplication" finding because there is now one construction site.
- Removes P2-24's "replays same failing call" finding because the inner try wraps only `AgentTypes.from_str`, not the whole registry lookup.

**Patterns to follow:**
- Existing `Agent(...)` construction pattern at `manager.py:141-147`

**Test scenarios:**
- **Happy path**: agent_name matches registry; returns registry Agent (no fallback).
- **Happy path**: agent_name not in registry, agent_type="Subagent" (valid); constructs fallback Agent with type=SUBAGENT.
- **Error path**: agent_name not in registry, agent_type="garbage" (invalid); constructs fallback with `AgentTypes.SUBAGENT`; warning logged; no exception.
- **Error path**: `get_agent_registry()` itself raises (registry not initialized); constructs fallback Agent with `AgentTypes.SUBAGENT`; warning logged; no exception.
- **Edge case**: agent_name="" (empty string); still works (constructs Agent with name="").

**Verification:**
- `python -m pytest tests/test_subagent_manager.py -q` all pass
- New test "unknown agent_type falls back to SUBAGENT" passes
- Existing tests still pass (no regression in restored-record behavior)

---

- U5. **Restored INTERRUPTED end_time/start_time normalization (P2-23, P2-36)**

**Goal:** Restored INTERRUPTED records produce non-absurd, non-growing `elapsed_seconds`; verify P2-36 is already fixed.

**Requirements:** R5, R8

**Dependencies:** U4 (same `from_storage_dict` site; both modify adjacent code)

**Files:**
- Modify: `src/stupidex/agents/manager.py`
- Test: `tests/test_subagent_manager.py`

**Approach:**
- In `SubagentRecord.from_storage_dict`, after computing migrated `state`, normalize `start_time`/`end_time`:
  - Compute `now = time.time()` once.
  - If state was migrated to INTERRUPTED (i.e., original state was PENDING or RUNNING) AND `end_time` is None: set `end_time = now`.
  - If `start_time` is 0 (or missing) AND `end_time` is now set: set `start_time = end_time` (so elapsed = 0.0 for never-started records).
  - If state is already INTERRUPTED on disk but `end_time` is None: also set `end_time = now` (defensive — covers disk corruption where state was set but end_time wasn't persisted).
- The existing fallback `end_time = data.get("end_time") or start_time or time.time()` is REMOVED in favor of the explicit normalization above (the fallback chain has the absurd-elapsed bug when start_time is set and end_time is missing).
- For P2-36 verification: add a characterization test that loads a record with `state="pending"` and asserts `record.state == INTERRUPTED` (already fixed, but pinned to guard regression).

**Patterns to follow:**
- Existing migration logic at `manager.py:158-159` (PENDING/RUNNING → INTERRUPTED)

**Test scenarios:**
- **Happy path — completed record**: state=COMPLETED, start_time=100, end_time=200; `elapsed_seconds == 100.0`.
- **Happy path — restored INTERRUPTED with both times**: state=INTERRUPTED, start_time=100, end_time=200; `elapsed_seconds == 100.0`.
- **Error path — restored RUNNING migrated to INTERRUPTED with end_time=None**: state=RUNNING, start_time=100, end_time=None; `elapsed_seconds == (now - 100)` (within test tolerance); `state == INTERRUPTED`. Tests P2-23.
- **Error path — restored PENDING (never started) with both 0/None**: state=PENDING, start_time=0, end_time=None; migrated to INTERRUPTED; `elapsed_seconds == 0.0` (NOT `time.time()`); `start_time == end_time`. Tests P2-23 extreme + P2-36.
- **Error path — restored RUNNING with start_time=0, end_time=None**: migrated to INTERRUPTED; `elapsed_seconds == 0.0`; `start_time == end_time == now`.
- **Characterization — state="pending" already migrates**: state="pending", start_time=100, end_time=200; `record.state == INTERRUPTED`; pins P2-36 as already-fixed.
- **Edge case — state="completed", end_time=None**: NOT migrated; `elapsed_seconds` falls back to `(now - start_time)` (the live-running case). Preserve this behavior — only INTERRUPTED migration sets end_time.

**Verification:**
- `python -m pytest tests/test_subagent_manager.py -q` all pass
- New test "restored PENDING with no times reports 0s elapsed" passes
- Mark P2-36 as `**[FIXED — duplicate of P1-1, characterized in Batch B 2026-06-21]**` in `todo-pendings-fixes.md`

---

- U6. **Subagent message orphan reconciliation (P2-31)**

**Goal:** Restored subagent messages converge on the same clean state that parent chains already reach.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/agents/manager.py`
- Test: `tests/test_subagent_manager.py`

**Approach:**
- Import `_reconcile_orphan_tool_results` from `stupidex.domain.chain` at top of `manager.py` (no cycle: `chain.py` imports `Message` from `message.py`, not `manager.py`).
- In `SubagentRecord.from_storage_dict`, after `messages=[Message.from_storage_dict(m) for m in data.get("messages", [])]`, call `_reconcile_orphan_tool_results(messages)`.
- The function mutates the list in place; no return value change needed.
- Matches the parent-chain pattern at `chain.py:60`.

**Patterns to follow:**
- Existing call site at `chain.py:60` (`_reconcile_orphan_tool_results(messages)` after list comprehension)

**Test scenarios:**
- **Happy path**: well-formed subagent messages (assistant with tool_calls → tool_result with matching id); no messages dropped.
- **Error path — orphan tool_result**: subagent has TOOL_RESULT with `tool_call_id="abc"` but no preceding assistant message with `tool_calls` containing id="abc"; `from_storage_dict` drops the orphan; `record.messages` doesn't contain it.
- **Error path — multiple orphans**: 3 orphan TOOL_RESULTs interleaved with valid messages; only orphans dropped, valid messages preserved.
- **Edge case**: empty messages list; reconciliation is a no-op.
- **Integration**: replay through `stream_response` does not log orphan-drop warnings for subagent messages on subsequent turns (the disk has converged).

**Verification:**
- `python -m pytest tests/test_subagent_manager.py -q` all pass
- New test "subagent orphan tool_result pruned on restore" passes

---

- U7. **Deterministic state-change callback flush (P2-34)**

**Goal:** Async callers can deterministically await pending `on_state_change(INTERRUPTED)` callbacks before continuing, preventing UI-teardown races.

**Requirements:** R7

**Dependencies:** U4, U5 (same file; coordinate around `from_storage_dict` and `_cancel_record`)

**Files:**
- Modify: `src/stupidex/agents/manager.py`
- Modify: `src/stupidex/app.py`
- Modify: `src/stupidex/tools/subagent.py`
- Test: `tests/test_subagent_manager.py`

**Approach:**
- Add `_pending_callback_tasks: set[asyncio.Task]` attribute to `SubagentManager.__init__`.
- Convert module-level `_fire_and_forget` to a method `SubagentManager._fire_and_forget(self, coro)` that:
  1. Creates the task via `asyncio.create_task(coro)`.
  2. Adds to `_pending_callback_tasks`.
  3. Attaches a `add_done_callback` that discards the task from the set.
  4. Returns the task.
- Update call sites that pass `record.on_state_change(...)` (manager.py:192, 256, 297) and `self.on_spawn(record)` (manager.py:301) to use `self._fire_and_forget(...)` instead of module function.
- Add `async def flush_state_callbacks(self) -> None` that awaits `asyncio.gather(*self._pending_callback_tasks, return_exceptions=True)` and clears the set.
- Update async call sites:
  - `app.py:191` (ESC handler — convert to async if currently sync; verify `_on_esc_press` or equivalent is async — Textual event handlers can be async): after `cancelled = ...cancel_running()`, add `await self.sessions.active.subagent_manager.flush_state_callbacks()`.
  - `tools/subagent.py:187-224` (already async): after `cancel_running()` and the `cancel_one` loop, add `await manager.flush_state_callbacks()`.
- `SessionManager.delete` (sync) does NOT call flush — acceptable per Key Technical Decisions because delete tears down the manager.

**Patterns to follow:**
- Existing `_log_task_exception` done-callback pattern at `manager.py:24-29`

**Test scenarios:**
- **Happy path**: cancel_one fires on_state_change; `flush_state_callbacks()` awaits it; callback completes with observed INTERRUPTED transition.
- **Happy path**: cancel_running fires multiple on_state_change; `flush_state_callbacks()` awaits all.
- **Error path — callback raises**: `flush_state_callbacks()` does NOT raise (gather with `return_exceptions=True`); exception logged via `_log_task_exception`.
- **Edge case — no pending callbacks**: `flush_state_callbacks()` returns immediately (empty gather).
- **Integration**: after `execute_interrupt_subagents` returns, all on_state_change callbacks have completed (no fire-and-forget lingering).
- **Integration**: ESC handler's INTERRUPTED message (constructed at `app.py:193-199`) reflects the post-callback state, not stale state.

**Verification:**
- `python -m pytest tests/test_subagent_manager.py -q` all pass
- `python -m pytest tests/test_subagent_tools.py -q` all pass (no regression in tool executor)
- New test "flush_state_callbacks awaits pending INTERRUPTED transition" passes

---

## System-Wide Impact

- **Interaction graph:** All `from_storage_dict` sites touched (Session, SubagentRecord); affects every session-load path on startup and `/sessions` switch. `flush_state_callbacks` adds a new await point in ESC handler and subagent interrupt tool.
- **Error propagation:** Deserialization errors now downgrade to warnings + fallback values, never propagate to abort whole-session load. Disk-delete failures now surface as `False` return from `SessionManager.delete` (previously silently mutated in-memory state).
- **State lifecycle risks:** Fire-and-forget `on_state_change` tasks now tracked; if event loop shuts down with pending callbacks, `_log_task_exception` still fires (unchanged). No new partial-write concerns.
- **API surface parity:** `flush_state_callbacks()` is a new primitive; sync callers (SessionManager.delete) intentionally do not use it.
- **Integration coverage:** Tests cover `Session.from_storage_dict` with corrupt chain + corrupt subagent record simulataneously (U2 + U4 + U5 in same deserialization path).
- **Unchanged invariants:** `Message.to_dict` OpenAI wire format unchanged. `Chain.from_storage_dict` reconciliation behavior unchanged (U6 mirrors it for subagents). `cancel_*` return signatures unchanged (sync, return IDs as before).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Disk-first delete changes observable behavior for callers that catch the exception externally | Check `app.py` delete_cmd handler — if it currently ignores return value, behavior is unchanged on success; only failure case changes (now returns False instead of True-after-mutation). |
| `Message.from_storage_dict` SYSTEM fallback could produce a stray system message that surprises providers | Providers tolerate stray system messages; `metadata["_deserialize_warning"]` makes the drift visible in TUI/debug. Characterization test pins the behavior. |
| Converting `_fire_and_forget` to a method touches all 3 call sites in `manager.py` | All sites already use `self.on_spawn` or `record.on_state_change` — the method binding is straightforward. No external callers of the module function. |
| `_reconcile_orphan_tool_results` import in `manager.py` could create import cycle | Verified: `chain.py` imports only `Message` from `message.py`; no cycle. Add to top-level imports. |
| `_on_esc_press` may be sync and require conversion to async | Textual event handlers are async-compatible (`async def on_key(self, event)` is standard). Verify in implementation. |
| U4 helper name collision with existing private helpers | Use `_restore_agent` (descriptive, no existing collision in module). |

---

## Documentation / Operational Notes

- After Batch B lands, persistence-replay failure mode changes from "abort whole session" to "skip corrupt element + warn". Operators reviewing logs should look for `WARNING` lines from `stupidex.domain.session`, `stupidex.domain.message`, `stupidex.agents.manager` to detect data drift.
- `flush_state_callbacks()` is a new public-ish API on `SubagentManager`. Document in any future API doc.
- P2-36 verified as duplicate of P1-1; mark in `todo-pendings-fixes.md` with `**[FIXED — duplicate of P1-1, characterized in Batch B 2026-06-21]**`.

---

## Sources & References

- **Origin document:** `todo-pendings-fixes.md` (P2-1, P2-8, P2-9, P2-23, P2-24, P2-26, P2-31, P2-34, P2-36)
- Related code: `src/stupidex/domain/session.py`, `src/stupidex/domain/message.py`, `src/stupidex/domain/chain.py`, `src/stupidex/agents/manager.py`, `src/stupidex/app.py`, `src/stupidex/tools/subagent.py`
- Prior art: P1-27 (`Usage.from_storage_dict` tolerance — same pattern, applied to Message), commit `406e032` (orphan reconciliation for parent chains only — U6 closes the subagent gap)
- Preceding plan: `docs/plans/2026-06-21-001-test-p2-testing-gaps-batch-a-plan.md` (Batch A — characterized 3 bugs pinned for Batch C; noted but not addressed in this plan)
