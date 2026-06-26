---
title: "fix: P2 streaming & tool-call correctness (Batch 1)"
type: fix
status: completed
date: 2026-06-21
---

> **Execution outcome:** U1, U2, U3 shipped (3 commits). U4 (P2-19) **skipped**
> during execution — the dataclass extraction contradicts the application's
> dict pass-through design (storage format == API wire format == in-memory
> format == working buffer format; zero conversion boundaries). Introducing
> a `ToolCall` dataclass adds two conversion layers on the exact path the
> U1/U2/U3 fixes just stabilized, and forces churn across ~30 test sites
> that construct raw dicts. A TypedDict overlay would fit the existing
> design; a dataclass does not. P2-19 closed as wontfix.

# P2 — Streaming & tool-call correctness (Batch 1)

## Summary

Three real correctness bugs in the streaming tool-call pipeline (`llm/client.py`, `domain/chain.py`) plus one typing/refactor item on `domain/message.py`. Fixes are one-line guards (P2-3, P2-85, P2-87) followed by an isolated dataclass extraction (P2-19). The remaining three issues originally grouped under Batch 1 (P2-4, P2-6, P2-84, P2-86) were verified false-positive or intended design and have been moved to `todo-completed-fixes.md`.

---

## Problem Frame

The streaming loop in `llm/client.py` ingests OpenAI-shaped deltas into a live `tool_calls: list[dict[str, Any]]` working buffer, enqueues raw references into `ready_q` for the executor task, and persists the resulting assistant message via `record_streamed_message`. Replay goes through `_reconcile_orphan_tool_results` (domain/chain.py) and `_history_to_api_messages`. Three independent latent defects exist on this path, all reachable under provider edge cases that production has not yet hit:

1. A single corrupted/replayed TOOL_RESULT with a duplicate `tool_call_id` survives reconciliation and reaches the provider, producing an HTTP 400 on strict providers.
2. A delta carrying `index=None` (Anthropic-via-litellm, some Bedrock adapters) raises `TypeError` at `client.py:624`, aborting the turn mid-stream after partial state has been persisted.
3. The executor shares a live reference to a tool_call dict whose `arguments` field is concurrently mutated by the stream loop, producing spurious "Invalid arguments" tool errors on parallel tool calls.

None of these block the happy path today; all three are reachable by documented provider behaviors.

---

## Requirements

- R1. Duplicate TOOL_RESULT messages with a `tool_call_id` already seen earlier in the list are pruned at replay time (chain.from_storage_dict).
- R2. Stream deltas with `tc_delta.index is None` are coerced instead of producing `TypeError`.
- R3. Tool-call dicts enqueued to the executor are snapshots, not live references shared with the stream loop.
- R4. `tool_calls` is modeled as a typed `ToolCall` dataclass rather than `dict[str, Any]`, without changing the OpenAI-shaped wire serialization.
- R5. All existing `record_streamed_message`, `_reconcile_orphan_tool_results`, `_history_to_api_messages`, `_stream_task`, and `_executor_task` behavior is preserved (verified by characterization tests).
- R6. No serialization-format change to `Message.to_storage_dict` / `Message.from_storage_dict` (disk compat).

---

## Scope Boundaries

- Does **not** change the wire/serialization shape of persisted messages (storage dict stays `{role, content, type, tool_call_id, tool_calls: [list of dicts]}`).
- Does **not** reorder the dynamic system prompt (P2-84 — verified as intended design; system prompt appended after conversation history by design).
- Does **not** change the ToolCall-open streaming delta shape (OpenAI delta shape stays as litellm provides it).
- Does **not** migrate other `list[dict]` model fields (e.g. `metadata`).

### Deferred to Follow-Up Work

- P2-4 (TOOL_CALL MessageType drop): false-positive, closed.
- P2-6 (THINKING drops tool_calls): false-positive, closed.
- P2-84 (dynamic system prompt position): intended design, closed.
- P2-86 (`tool_call_id` empty-string collision): false-positive, closed.

---

## Context & Research

### Relevant Code and Patterns

- `src/stupidex/domain/chain.py:71-110` — `_reconcile_orphan_tool_results` drives orphan pruning at replay.
- `src/stupidex/domain/message.py:38` — `tool_calls: list[dict[str, Any]] | None` field.
- `src/stupidex/domain/message.py:40-77` — `to_dict` / `to_storage_dict` are the wire serialization surface.
- `src/stupidex/llm/client.py:624` — `while tc_delta.index >= len(tool_calls):` is the None-index crash point.
- `src/stupidex/llm/client.py:573-588` — `maybe_enqueue` enqueues the live `tool_calls[prev_idx]` reference onto `ready_q`.
- `src/stupidex/llm/client.py:328-381` — `_execute_tool` reads `tc["function"]["name"]` / `tc["function"]["arguments"]` from the enqueued reference.
- `src/stupidex/llm/client.py:622-634` — delta loop mutates `tc["function"]["arguments"]` in place via `+=`.

### Institutional Learnings

- Existing P2 batch (2026-06-21 batches B/C) consistently chose one-line guards over refactors when the bug was isolate-able; P2-19 is the rare exception because the field type itself is the smell.
- `from_storage_dict` patterns (see message.py:80-123) carry forward-compat fallbacks — R6 mandates the same discipline for any new tool_call de/serialization.

---

## Key Technical Decisions

- **Order P2-3, P2-85, P2-87 before P2-19.** The three guards are one-line, dict-shaped, and operationally independent. Landing them first lets P2-19's dataclass extraction rewrite settled call sites rather than racing concurrent bug fixes.
- **P2-3 uses a second set, not a dict-merge.** `seen_tool_call_ids` already exists for assistant `tool_calls` blocks (chain.py:101-105); adding `seen_result_ids` for the TOOL_RESULT branch reuses the set-membership pattern without restructuring the loop.
- **P2-85 coerces `None` to `len(tool_calls)`.** Mirrors how OpenAI-delta shape treats the first delta's implicit index (`0` becomes `len == 0` → append). Anthropic-style "no index on single-tool delta" providers thus append at slot 0 as intended.
- **P2-87 uses `copy.deepcopy`** rather than shallow copy, because the nested `function` dict has its `arguments` field mutated in place by `client.py:634`. Shallow copy would still race on the nested string.
- **P2-19 introduces `ToolCall` + `ToolCallFunction` dataclasses** with `to_dict` / `from_dict` returning the OpenAI wire shape (`{"id", "type": "function", "function": {"name", "arguments"}}`). Field remains `list[ToolCall] | None` on `Message`; `to_storage_dict` continues to emit `list[dict]` (R6).
- **`from_storage_dict` tolerates missing/extra keys** — mirrors existing Message.from_storage_dict defensive pattern (message.py:80-123) to avoid P2-9-style whole-session aborts.

---

## Open Questions

### Resolved During Planning

- Should P2-87 snapshot in `maybe_enqueue` or in `_execute_tool`? — In `maybe_enqueue`, so the snapshot happens at the same transition point where the tool_call is considered well-formed (commit_assistant_with_tool_calls + filter already done). Keeps the executor unchanged.
- Should P2-19 also migrate `Message.tool_calls` storage format? — No, R6 forbids it. Disk stays dict-shaped.
- Should P2-19 add type validation in `from_storage_dict`? — Yes, defensively, but only to *ignore* bad entries (consistent with P2-9's tolerant deserialization).

### Deferred to Implementation

- Exact dataclass field order / slots use in `ToolCall`/`ToolCallFunction` (decide when writing).
- Whether `ToolCall.to_dict()` should freeze the OpenAI-shaped dict (immutable after emit) or allow in-place mutation until commit.

---

## Implementation Units

- U1. **Deduplicate repeated TOOL_RESULT at replay (P2-3)**

**Goal:** Prevent a duplicate `tool_call_id` TOOL_RESULT from surviving `_reconcile_orphan_tool_results` and reaching the provider.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/domain/chain.py`
- Test: `tests/test_chain.py` (or matching existing test file for `chain.py`; if none exists, create `tests/test_chain_reconcile.py`)

**Approach:**
- Add a `seen_result_ids: set[str]` local in `_reconcile_orphan_tool_results` alongside the existing `seen_tool_call_ids`.
- For the `msg.role.value == "tool"` branch (chain.py:90-100): drop the message (continue, with the same debug log) if `msg.tool_call_id` is already in `seen_result_ids`; otherwise add it to `seen_result_ids`.
- Order: test `seen_result_ids` first (drop if duplicate), then the existing orphan check (drop if no preceding assistant tool_calls match). Both checks are drop-on-match.
- Keep the orphan-prune debug log; add a parallel "dropping duplicate TOOL_RESULT" debug log.

**Test scenarios:**
- Happy path: assistant(tool_calls=[A]) → tool(A) → assistant(tool_calls=[A]) already in `seen_tool_call_ids` (added when the first assistant block was walked). Verifies no regression on the existing orphan-prune path.
- Edge case: same `tool_call_id` appears on two TOOL_RESULT messages back-to-back. Reconcile keeps the first, drops the second, final `messages` length is reduced by one.
- Edge case: duplicate `tool_call_id` across two separate turns (assistant→tool→assistant(content)→tool(A)). Verify the second tool(A) is dropped as orphan (different-turn sequence break, not as duplicate) — guards against over-collapsing unrelated replay states.
- Integration: end-to-end replay of a chain with a duplicate TOOL_RESULT produces an `api_messages` list with exactly one entry for the duplicated `tool_call_id`.

**Verification:**
- `pytest tests/test_chain_reconcile.py` (or matching existing path) passes.
- No new `log.debug` output on the happy-path chain replay.

---

- U2. **Guard against `tc_delta.index is None` (P2-85)**

**Goal:** Prevent mid-stream `TypeError` when a provider emits a tool-call delta without `index`.

**Requirements:** R2, R5

**Dependencies:** None (independent of U1)

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_stream_task.py` (or matching existing test file)

**Approach:**
- At `client.py:624` (the `for tc_delta in delta.tool_calls:` loop body), compute the effective index before the `while` comparison: `idx = tc_delta.index if tc_delta.index is not None else len(tool_calls)`. Use `idx` in the `while` condition, the dict lookup (`tool_calls[idx]`), and the `maybe_enqueue` call below.
- Single-tool-first deltas from Anthropic-style providers (no `index`) append at slot 0 as intended.
- Add a defensive comment naming the provider edge case (Anthropic-via-litellm, Bedrock adapters).

**Test scenarios:**
- Happy path: delta with `index=0` followed by `index=1` — both tool_calls are appended at the correct slots (no regression).
- Edge case: single delta with `index=None` and `function.name='X'` — appended at slot 0, no exception raised.
- Edge case: `index=None` arriving after a prior `index=0` already appended — appended at slot 1 (len is 1, so `idx=1`).
- Error path: delta has `index=None` but no `function.name` or `id` — still processed (no crash); downstream `maybe_enqueue` continues to emit the malformed-tool-call error via existing path (`commit_assistant_with_tool_calls` filter drops it).

**Verification:**
- `pytest tests/test_stream_task.py` passes; existing stream-task tests do not regress.

---

- U3. **Snapshot tool_calls on enqueue (P2-87)**

**Goal:** Prevent the executor from reading a concurrently-mutated `arguments` string on parallel tool calls.

**Requirements:** R3, R5

**Dependencies:** None (independent of U1, U2)

**Files:**
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_stream_task.py` (or matching existing test file)

**Approach:**
- In `maybe_enqueue` (client.py:573-588), replace `await ready_q.put(tc)` with `await ready_q.put(copy.deepcopy(tc))`.
- `copy.deepcopy` (not shallow) because `tc["function"]["arguments"]` is mutated in place by `client.py:634` (`+= chunk`); a shallow copy would still share the nested string.
- Add `import copy` at the top of `client.py` if not already present (it is — see message.py:1; client.py likely already imports it transitively, but the explicit import is mandatory at the call site's file).
- Leave `commit_assistant_with_tool_calls` already-snapshot logic (client.py:528-535) alone — that path already builds a fresh list comprehension.

**Test scenarios:**
- Happy path: single tool call, enqueued at end-of-stream — executor sees the same args as the persisted message (no regression).
- Edge case: two parallel tool calls (indices 0 and 1), index-1 deltas arrive after index-0 was enqueued — executor's snapshot of index-0's args is unaffected by index-1's subsequent argument-chunk appends.
- Integration: synthetic stream interleaving indices 0 and 1 with partial `arguments` chunks — `json.loads(tc["function"]["arguments"])` in `_execute_tool` succeeds on the snapshot even when the live `tc` reference still has partial JSON at execution time.

**Verification:**
- `pytest tests/test_stream_task.py` passes.
- Existing behavior of `_executor_task` (client.py:695-722) unchanged.

---

- U4. **Extract `ToolCall` / `ToolCallFunction` dataclasses (P2-19)**

**Goal:** Replace the bare `list[dict[str, Any]]` shape of `Message.tool_calls` with typed dataclasses, removing string-key access (`tc["function"]["name"]`) at every call site.

**Requirements:** R4, R5, R6

**Dependencies:** U1, U2, U3 (so the bug fixes land as dict-shaped first; this unit then rewrites the settled call sites).

**Files:**
- Modify: `src/stupidex/domain/message.py`
- Modify: `src/stupidex/domain/chain.py`
- Modify: `src/stupidex/llm/client.py`
- Test: `tests/test_message_tool_call_roundtrip.py` (or extend existing message tests)

**Approach:**
- Define `@dataclass class ToolCallFunction: name: str; arguments: str` and `@dataclass class ToolCall: id: str; function: ToolCallFunction` with `to_dict()` returning the OpenAI wire shape (`{"id", "type": "function", "function": {"name", "arguments"}}`).
- Add `from_dict(cls, d)` classmethod with defensive `.get(...)` extraction mirroring `Message.from_storage_dict` (message.py:80-123) — missing `id`/`name` → empty string, unknown extra keys ignored.
- Change `Message.tool_calls` field type from `list[dict[str, Any]] | None` to `list[ToolCall] | None`.
- `Message.to_dict` and `Message.to_storage_dict` continue to emit `list[dict]` (R6 — no disk format change). Replace the inline `copy.deepcopy(tc)` blocks with `[tc.to_dict() for tc in self.tool_calls]` if the dataclasses are effectively immutable; OR keep `deepcopy(tc.to_dict())` if call sites mutate the returned dict. Decide during implementation (deferred).
- `Message.from_storage_dict`: build `[ToolCall.from_dict(tc) for tc in data.get("tool_calls", [])]` with per-item try/except that skips bad entries (matches P2-9's tolerant pattern).
- Migrate all call sites:
  - `chain.py:101-105` — `tid = tc.id` instead of `tc.get("id")`.
  - `chain.py:250-254` — `{tc.id for tc in msg.tool_calls if tc.id}`.
  - `chain.py:300-303` — `tc.id in surviving_tool_call_ids`.
  - `chain.py:315-317` — `last_assistant_tool_call_ids = {tc.id for tc in msg.tool_calls if tc.id}`.
  - `client.py:328` — `name = tc.function.name`.
  - `client.py:330-340` — `tc.function.arguments` (string, not nested dict).
  - `client.py:528-531, 549, 580-588, 624-672, 687` — rewrite the delta-loop accumulator to build `ToolCall` instances. The `tool_calls` working buffer in `_stream_task` stays a `list[dict]` (raw litellm delta shape) for accumulator simplicity; the `commit_assistant_with_tool_calls` snapshot converts dict → `ToolCall.from_dict(tc)` at commit time, and the emitted `Message(tool_calls=...)` then carries the typed list.
- Optional: enable `slots=True` on the dataclasses for memory locality and accidental-attr-mutation guard. Decide during implementation.

**Execution note:** characterization-first — before migrating each call site, ensure existing `record_streamed_message` / `_reconcile_orphan_tool_results` / `_history_to_api_messages` tests cover the call site's current behavior. Add gap-filler tests where the existing suite is thin (it isn't — P2-104 covers the THINKING-between-tool_calls invariant; verify coverage of `to_dict`/`from_storage_dict` round-trip for a tool-call-bearing message).

**Technical design:** *Directional guidance only — the exact field order of `ToolCall` and whether `slots=True` is applied is an implementation-detail decision, not a contract.*

```python
# Directional sketch
@dataclass
class ToolCallFunction:
    name: str
    arguments: str

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "arguments": self.arguments}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ToolCallFunction":
        return cls(name=d.get("name", ""), arguments=d.get("arguments", ""))

@dataclass
class ToolCall:
    id: str
    function: ToolCallFunction

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "type": "function", "function": self.function.to_dict()}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ToolCall | None":
        # Defensive: skip entries lacking function.name (mirrors
        # commit_assistant_with_tool_calls filter at client.py:528-531).
        fn = ToolCallFunction.from_dict(d.get("function") or {})
        if not fn.name:
            return None
        return cls(id=d.get("id", ""), function=fn)
```

**Patterns to follow:**
- `src/stupidex/domain/message.py:80-123` — defensive `from_storage_dict` with `.get()`, validation, and warning metadata.
- `src/stupidex/domain/usage.py` (adjacent `Usage` dataclass pattern).

**Test scenarios:**
- Happy path: round-trip a `Message(role=ASSISTANT, tool_calls=[ToolCall(id="A", function=ToolCallFunction(name="sum", arguments='{"a":1}'))])` through `to_storage_dict` → `from_storage_dict` → equal dataclass instance (no behavior change vs today's dict round-trip).
- Edge case: `tool_calls` entry missing `function` key → `from_storage_dict` returns `None` and `Message.tool_calls` ends up an empty list (or `None`), not a crash.
- Edge case: `tool_calls` entry with extra unknown keys → ignored without warning (or with `_deserialize_warning`, matching existing pattern).
- Error path: `Message.to_dict()` for a tool-call-bearing assistant message emits `{"role": "assistant", "content": None, "tool_calls": [{"id", "type": "function", "function": {"name", "arguments"}}]}` — exact OpenAI shape (no regression on the existing empty-content-null rule at message.py:46-47).
- Integration: `record_streamed_message` of a streamed TEXT-typed message with `tool_calls=[ToolCall(...)]` appends/anchors the assistant message on disk identically to today.
- Integration: `_reconcile_orphan_tool_results` walks `msg.tool_calls` (now `list[ToolCall]`) and adds `tc.id` to `seen_tool_call_ids` exactly as today.

**Verification:**
- `pytest tests/` passes, in particular existing `test_chain_reconcile.py`, `test_stream_task.py`, `test_message*.py`.

---

## System-Wide Impact

- **Interaction graph:** every read of `Message.tool_calls` (chain.py reconcile + emit-pass, client.py delta loop, client.py executor, message.py serialization) is touched by U4. U1/U2/U3 touch the same surface but only at one line each.
- **Error propagation:** U1 adds a new drop-and-log branch (duplicate TOOL_RESULT). U2, U3 convert a future latent crash/mis-execution into a normal one. U4 does not change the set of error paths.
- **State lifecycle risks:** U3 snapshot timing is critical — must snapshot inside `maybe_enqueue` at transition time (after `commit_assistant_with_tool_calls` has filtered well-formed entries), not at the raw delta-arrival site. Otherwise late-arriving parallel tool_calls (client.py:670) would be re-added to the snapshot list each time, defeating the `committed_indices` dedup.
- **API surface parity:** the disk serialization shape is unchanged (R6). `Message.to_dict()` (API-shape, not disk) is unchanged.
- **Integration coverage:** the U4 dataclass extraction changes field access syntax but not behavior; characterization tests guard the surface. U3's race fix is only provable with an interleaving test (see U3 integration scenarios).
- **Unchanged invariants:**
  - `Message` storage dict shape (`{role, content, type, ...}`) — preserved.
  - OpenAI chat-message API shape emitted by `to_dict()` — preserved (R6).
  - Delta accumulator's `list[dict]` working buffer in `_stream_task` — preserved (the litellm delta shape is dict-shaped; conversion to `ToolCall` happens at commit time).
  - The "commit at first index transition" anchoring semantics in `commit_assistant_with_tool_calls` — preserved.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| U4 introduces a serialization drift (missing a field, wrong casing) | Round-trip tests in U4 (Happy path and Error path scenarios) cover the wire shape explicitly. |
| U3 deepcopy of large tool_call args (very large JSON) adds CPU cost | Tool-call args are typically small JSON. If profiling shows hot loops, `dict(tc)` with separately frozen `function.arguments` string could replace `deepcopy`; deferred to implementation. |
| U1 over-collapses legitimate same-`tool_call_id` TOOL_RESULT across turns | U1 Edge-case test (across-turn duplicate) pins the boundary: the second is dropped as orphan via `pending_tool_call_ids` reset, not as duplicate; both drop paths converge on the same outcome without firing duplicate-drop log noise. |
| U2 coercion masks a different provider bug (index always-None) | U2 Edge-case test for `index=None` after a prior `index=0` already exists; if all deltas ship `index=None` for a 3-tool response, they all collapse to slot 0 — but that is the provider's bug, not ours; malformed-tool-call error path handles the resulting shape gracefully. |
| U4 lands before U1/U2/U3 (sequencing violation) | U4 explicitly `Dependencies: U1, U2, U3` — enforced by plan, not by tooling. |

---

## Documentation / Operational Notes

- No migration: disk format is unchanged.
- No new log levels: U1 adds one new `log.debug` line; U2/U3/U4 add none.
- Manual verification after the batch lands: load an existing session with tool-call history and confirm replay matches pre-batch output byte-for-byte (covered by R5/R6 tests, but a one-off human check on a real session is recommended given the streaming path's centrality).

---

## Sources & References

- Origin: `todo-pendings-fixes.md` lines 62-90 (P2 batch list, domain + agents sections)
- Source verification: `src/stupidex/domain/chain.py:71-110`, `src/stupidex/domain/message.py:38-123, 133-192`, `src/stupidex/llm/client.py:209-320, 450-708`
- Related completed fixes: `todo-completed-fixes.md` P2-9 (defensive `Message.from_storage_dict`), P2-31 (`_reconcile_orphan_tool_results` applied to subagent messages)
- Related plans: `docs/plans/2026-06-21-002-fix-p2-persistence-replay-batch-b-plan.md`, `docs/plans/2026-06-21-003-fix-p2-concrete-bugs-batch-c-plan.md`
