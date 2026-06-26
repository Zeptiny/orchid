---
title: "feat: Token usage display (input / cached input / output) per chain, per subagent, and session-total beside the model"
type: feat
date: 2026-06-22
---

# Token usage display across chains, subagents, and the session

## Summary

Surface three token numbers — total input, cached input, total output — at three levels: per chain footer, per subagent tab footer, and session-total beside the selected model in the footer. To get uniform accounting and footer reuse, model each subagent's message history as a `Chain` via composition (`SubagentRecord.chain`) rather than merging the two types, and record each subagent's parent chain so delegated work is attributable to its spawning turn.

## Problem Frame

Token usage from the LLM stream is captured today (`Usage` on the final assistant message of each chain, persisted, reloaded), but it is not surfaced anywhere except the sidebar's `Context:` line, which shows only the last request's prompt tokens for the active view. Cached input tokens are never captured — `_stream_task` discards `prompt_tokens_details.cached_tokens`. Subagent token consumption lives on `SubagentRecord.messages`, which is not part of any chain and not summed into any session total, so it is invisible at both the per-turn and session level. A chain footer (`ChainFooterWidget`) shows `model · elapsed` but no tokens; the `#model` label in the footer shows only the model name.

## Requirements

### Data layer

R1. `Usage` carries a `cached_tokens` field (default `0`), persisted to and loaded from storage with forward/backward compatibility (old sessions load as `0`; usage dicts with unknown keys do not crash the session restore).

R2. `_stream_task` extracts cached input tokens from provider-dependent usage shapes — OpenAI `prompt_tokens_details.cached_tokens` and Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens` — defaulting to `0` when the field is absent or the provider does not report caching.

### Display

R3. Each chain footer displays that chain's total input, cached input, and total output tokens.

R4. The footer `#model` Static displays session-total input, cached input, and output tokens beside the selected model name.

R5. Each subagent tab displays that subagent's total input, cached input, and output tokens.

R6. Session-total numbers include subagent token consumption, not only the main-thread chains.

R7. `Usage` semantics preserve that cached input is a subset of input, not additive (display "of which cached", never sum input + cached).

### Architecture

R8. `SubagentRecord` wraps a `Chain` (composition) instead of holding a bare `messages` list; `SubagentRecord.model` and `SubagentRecord.parent_chain_index` are recorded and persisted.

R9. Orphan-tool-result reconciliation runs once, via `Chain.from_storage_dict`, instead of being duplicated across both `Chain` and `SubagentRecord` deserializers.

R10. Each subagent records the index of the chain that spawned it, so delegated work is attributable to its parent turn.

R11. A chain footer optionally shows the delegated subagent subtotal (tokens of subagents whose `parent_chain_index` is this chain's index).

## Scope Boundaries

- **Full type-merge of `Chain` and `SubagentRecord` is out of scope.** Subagents keep their orchestration concerns (`async_task`, callbacks, `SubagentState`, agent identity). Only the shared message-history/model/lifecycle shape is unified via composition. Merging would force null orchestration fields and a branched deserializer — net negative for clarity.
- The sidebar `Context:` line and `Sidebar._usage_by_view` per-view tracking are unchanged. The token feature walks record lists directly and does not repurpose the sidebar's last-usage cache.
- `reasoning_tokens` / `completion_tokens_details` are not displayed (captured or dropped unchanged per provider; no new field beyond `cached_tokens`).
- Subagents cannot spawn subagents, so attribution is exactly one level deep — no recursive walk.
- Prompt tokens overlap across chains (each request resends history). Summing is cumulative cost, the standard semantics, not deduplicated context tokens.
- `cached == 0` is ambiguous (provider does not report caching vs. genuinely nothing cached); the display shows the number as-is without inferring meaning.

## High-Level Technical Design

```
stream chunk (provider usage)
        │
        ▼  _stream_task extracts prompt / cached / completion / total
   Usage(prompt, cached, completion, total)
        │  attached to final assistant Message of the turn
        ▼
   Chain.messages[...]   ──┐
                           │   parent_chain_index linkage set at spawn
   SubagentRecord.chain ───┘   (SubagentRecord wraps a Chain)
        │
        ▼  summation (uniform walk over chains + subagent records)
   per-chain footer  ·  per-subagent footer  ·  session-total beside #model
```

The `Chain` becomes the single abstraction for "a unit of agentic LLM work with messages + model + lifecycle + usage". Per-chain, per-subagent, and session accounting all reduce to walking `chain.messages` and reading `message.usage`. `ChainFooterWidget` renders any `Chain`, so a subagent footer is `ChainFooterWidget(record.chain)`.

## Key Technical Decisions

- **Composition, not merge.** `SubagentRecord.chain: Chain` replaces `messages: list[Message]`; a `messages` property delegates to `self.chain.messages` for back-compat. Rationale: unifies accounting and footer reuse while keeping the genuinely distinct orchestration layer (`async_task`, callbacks, `SubagentState.PENDING`) separate. A merged type would carry null fields and invariants that only apply to one variant.

- **Cache the resolved model on the subagent record.** `spawn` already receives `model` (resolved via `get_model_for_tier` in `execute_delegate_to_subagent`) but currently only passes it to `stream_response` and discards it. Storing `record.model` lets the subagent footer render its model, matching chain footers.

- **Parent linkage via a `_current_chain_index` ContextVar.** Set in `_start_chain` (where `app._current_chain` is established), read in `execute_delegate_to_subagent` at spawn time. Rationale: the tool executor runs inside `_executor_task` with no chain context otherwise; a ContextVar mirrors the existing `set_subagent_manager` binding pattern. Chain indices are stable for persistence because `session.chains` is append-only.

- **Subagent footer reuses `ChainFooterWidget` with `record.chain`.** No bespoke `SubagentFooterWidget`. Rationale: composition makes the record's `Chain` directly renderable; a near-duplicate widget would re-introduce the divergence the refactor removes.

- **Cached extraction is provider-shape-aware with a `0` fallback.** Read `prompt_tokens_details.cached_tokens` (OpenAI), fall back to `cache_read_input_tokens` (Anthropic), else `0`. Do not treat `0` as "not cached" — it may mean "unreported".

- **Token formatter mirrors `Chain.format_elapsed`.** A small `_format_tokens(n)` helper producing `1.2k` / `12.3k` / `1.2M`, co-located with `Chain.format_elapsed` or in `utils`.

## Implementation Units

### U1. Extend `Usage` with `cached_tokens`

**Goal:** Add the cached-input field to the domain model and persistence, backward/forward compatible.

**Requirements:** R1, R7

**Dependencies:** None

**Files:**
- Modify: `src/stupidex/domain/message.py` (`Usage` dataclass, `to_storage_dict`, `from_storage_dict`)
- Test: `tests/test_message.py` (`TestUsageDeserializationForwardCompat`)

**Approach:**
- Add `cached_tokens: int = 0` to the `Usage` dataclass. This field holds **cache-read** tokens only (Anthropic `cache_read_input_tokens` / OpenAI `cached_tokens`) — see R7: reads are genuinely a subset of `prompt_tokens` on both providers, which the `↑{input} (⟲{cached})` display format depends on. Anthropic `cache_creation_input_tokens` is deliberately **not** folded here: it is additive to `input_tokens` (not a subset), billed differently (~1.25×), and conflating reads with creations would break the subset invariant the display relies on.
- Serialize it in `to_storage_dict` alongside `prompt_tokens`/`completion_tokens`/`total_tokens`.
- Load it in `from_storage_dict` via `src.get("cached_tokens", 0)`, reusing the existing `.get(..., 0)` non-dict-safe pattern. Existing extra-key handling (`prompt_tokens_details` in the persisted dict, line ~39/84 of the test) already drops unknown keys — the loader reads only the known field, so a persisted `prompt_tokens_details` block from a newer writer is ignored, matching today's behavior.

**Known limitation / follow-up:** Anthropic cache-creation tokens are dropped (under-reported Anthropic input cost). A follow-up should add a `cache_creation_tokens` field and a display slot (`→{created} ⟲{read}`) for accurate Anthropic cost accounting; out of scope here to keep the feature to the three requested numbers.

**Patterns to follow:**
- The existing `.get(key, 0)` forward-compat pattern in `from_storage_dict` (non-dict guard returns a zeroed `Usage`).

**Test scenarios:**
- **Round-trip:** `Usage(prompt=10, cached=4, completion=5, total=15)` → `to_storage_dict` → `from_storage_dict` preserves all four fields including `cached_tokens=4`.
- **Forward-compat (extra keys):** persisted dict with `prompt_tokens_details: {cached_tokens: 4}` plus top-level `cached_tokens: 7` → loader reads top-level `cached_tokens=7`, ignores the nested block. Covers existing extra-key handling extended to the new field.
- **Backward-compat (missing key):** persisted dict without `cached_tokens` → loads as `0`. Covers old sessions.
- **Zero default:** `Usage(1, 2, 3)` (positional, no cached) → `cached_tokens == 0`. Covers call sites that do not pass the new arg yet.

**Verification:** `pytest tests/test_message.py` green; existing forward-compat tests unchanged in behavior.

---

### U2. Extract cached tokens from stream usage chunks

**Goal:** Capture cached input tokens from provider usage objects in `_stream_task`.

**Requirements:** R2

**Dependencies:** U1

**Files:**
- Modify: `src/stupidex/llm/client.py` (`_stream_task`, the `if hasattr(chunk, "usage")...` block)
- Test: `tests/test_streaming_messages.py` (the `chunk(...)` helper and a usage-carries-cached assertion)

**Approach:**
- After reading `chunk.usage.prompt_tokens` / `completion_tokens` / `total_tokens`, compute `cached_tokens` (cache reads only) from the first available of: `getattr(prompt_tokens_details, "cached_tokens", 0)` (OpenAI), then `getattr(chunk.usage, "cache_read_input_tokens", 0)` (Anthropic). Default `0`. Do **not** read `cache_creation_input_tokens` — it is additive to `input_tokens` on Anthropic and folding it would break the subset invariant R7 relies on (see U1 known limitation).
- Pass `cached_tokens` into the `Usage(...)` constructor.
- `stream_options={"include_usage": True}` is already set; no request-side change needed.

**Patterns to follow:**
- The existing defensive `hasattr(chunk, "usage") and chunk.usage` guard.

**Test scenarios:**
- **OpenAI shape:** chunk usage with `prompt_tokens_details=SimpleNamespace(cached_tokens=800)` → emitted `Message.usage.cached_tokens == 800`.
- **Anthropic shape (reads):** chunk usage with `cache_read_input_tokens=600` and no `prompt_tokens_details` → `cached_tokens == 600`.
- **Anthropic creation ignored:** chunk usage with `cache_creation_input_tokens=500` and no `cache_read_input_tokens` / `prompt_tokens_details` → `cached_tokens == 0` (creation is not folded). Covers Option C.
- **Absent (provider reporting off):** chunk usage with no `prompt_tokens_details` and no cache fields → `cached_tokens == 0`. Covers provider-not-reporting.
- **Regression:** the existing `test_final_text_message_does_not_duplicate_content` (which constructs `Usage(1, 2, 3)` positionally) still passes with `cached_tokens=0`.

**Verification:** `pytest tests/test_streaming_messages.py` green.

---

### U3. `Chain.format_tokens` + per-chain footer

**Goal:** Render per-chain input / cached / output tokens in `ChainFooterWidget`.

**Requirements:** R3, R7

**Dependencies:** U1, U2

**Files:**
- Modify: `src/stupidex/domain/chain.py` (add `format_tokens` staticmethod next to `format_elapsed`)
- Modify: `src/stupidex/widgets/message_widget.py` (`ChainFooterWidget._build_text`)
- Test: `tests/test_chain.py` (or a new focused footer test)

**Approach:**
- Add `Chain.format_tokens(n) -> str` as a `@staticmethod` co-located with `format_elapsed`, mirroring its compact style (`1.2k`/`12.3k`/`1.2M`, raw number below 1000). Rationale: `format_elapsed` is the established home for "compact number → display string" on the chain abstraction; `format_tokens` is the same shape. `format_elapsed` already imports `Chain` into `message_widget.py`, so no new import path. `utils.py` is config/path/seed/tree helpers — presentation formatting does not fit its theme.
- `_build_text` computes the chain's usage from the last message with `usage` (same lookup `rerender_footer` already uses) and appends `· ↑{input} ⟲{cached} ↓{output}` to the existing `{model} · {elapsed}` line.
- Format cached as a subset: render `↑{input} (⟲{cached}) ↓{output}` so cached is visually "of which", not additive.
- When a chain has no usage, omit the token segment.

**Patterns to follow:**
- `Chain.format_elapsed` for the formatter style and co-location.
- `ChainFooterWidget`'s existing `tick`/`freeze` re-render through `_build_text`.

**Test scenarios:**
- **With usage:** a `Chain` whose final assistant message carries `Usage(prompt=1000, cached=400, completion=200, total=1200)` → footer text contains the three formatted numbers with cached shown as subset.
- **No usage:** a chain with no usage messages → footer text is `model · elapsed` only (no token segment).
- **Formatter boundaries:** `Chain.format_tokens(999)`, `(1200)`, `(12345)`, `(1_500_000)` → `999` / `1.2k` / `12.3k` / `1.5M`.

**Verification:** `pytest tests/test_chain.py` green; footer renders tokens when usage present.

---

### U4. Session-total beside the selected model

**Goal:** Show session-total input / cached / output in the footer `#model` Static.

**Requirements:** R4

**Dependencies:** U1, U2

**Files:**
- Modify: `src/stupidex/app.py` (`rerender_footer`, the `#model` update near `model_label = self.model or "No Model"`)
- Test: `tests/test_session.py` (or a new footer-rendering test)

**Approach:**
- In `rerender_footer`, sum usage across `session.chains` (each chain's final-usage message) rather than reading only the last message in `session.messages`.
- Render `{model} · ↑{input} (⟲{cached}) ↓{output}` into the `#model` Static via `self.query_one("#model", Static).update(...)`.
- Keep the existing sidebar `update_tokens` call unchanged.
- When no usage exists, show the model label alone (current behavior).

**Patterns to follow:**
- The existing `rerender_footer` structure and `#model` update.
- The `_format_tokens` helper from U3.

**Test scenarios:**
- **Two chains with usage:** session with two chains each carrying usage → `#model` shows summed input/cached/output across both, not just the last chain.
- **Mixed (one chain no usage):** only chains with usage contribute; the no-usage chain does not zero the total.
- **No usage at all:** `#model` shows `{model}` with no token suffix.

**Verification:** `pytest tests/test_session.py` green; `#model` reflects session-total tokens after a turn.

---

### U5. Composition refactor: `SubagentRecord.chain`

**Goal:** Replace `SubagentRecord.messages` with `chain: Chain`; derive model + parent linkage; de-duplicate orphan reconciliation. No behavior change beyond persisting `model`/`parent_chain_index`.

**Requirements:** R8, R9, R10

**Dependencies:** None strictly (independent refactor), but lands cleanly before U6/U7 which depend on it.

**Files:**
- Modify: `src/stupidex/agents/manager.py` (`SubagentRecord` dataclass, `spawn`, `from_storage_dict`, `to_storage_dict`, `_run` closure)
- Modify: `src/stupidex/tools/subagent.py` (record `parent_chain_index` at spawn)
- Modify: `src/stupidex/app.py` (`_start_chain` sets a `_current_chain_index` ContextVar; threading the index into spawn)
- Test: `tests/test_subagent_manager.py`

**Approach:**
- Replace `messages: list[Message]` with `chain: Chain = field(default_factory=Chain)`. Add `model: str | None = None` and `parent_chain_index: int | None = None`. Keep `messages_mounted`, callbacks, `async_task`, etc.
- Add a `messages` property returning `self.chain.messages` (back-compat for callers in `manager._run`, `subagent_ui.py`, `to_storage_dict`). Append/read through this property continue to work since it returns the list reference.
- `spawn`: set `record.chain.model = model` and `record.parent_chain_index = current_chain_index` (read from a new ContextVar set by `_start_chain`). `execute_delegate_to_subagent` passes `model` already; it reads the ContextVar and passes `parent_chain_index` into `spawn`.
- `from_storage_dict`: build `chain = Chain.from_storage_dict({**c, "model": data.get("model")})` (or construct `Chain(messages=..., model=...)`). Remove the duplicated `_reconcile_orphan_tool_results(messages)` call — it now runs inside `Chain.from_storage_dict`.
- `to_storage_dict`: emit `chain` as a nested dict (model + messages + times) plus `model` and `parent_chain_index` at the top level for direct access. Preserve id/agent/state/label/task/result/error/times/messages_mounted.
- Add `_current_chain_index` ContextVar in `agents/manager.py` or a small new module; `_start_chain` sets it to `len(self.sessions.active.chains) - 1` after appending.

**Patterns to follow:**
- The existing `set_subagent_manager` ContextVar binding pattern.
- `Chain.from_storage_dict`'s orphan reconciliation (the call being de-duplicated).

**Test scenarios:**
- **Back-compat `messages` property:** `record.messages.append(m)` then `record.chain.messages` contains `m`; `record.messages` returns the same list. Covers `_run` and `subagent_ui.py` callers unchanged.
- **Persistence round-trip:** `SubagentRecord(model="gpt-4o", parent_chain_index=2, chain=Chain(model=..., messages=[...]))` → `to_storage_dict` → `from_storage_dict` preserves `model`, `parent_chain_index`, and the messages.
- **Orphan reconcile runs once:** a subagent record with an orphaned TOOL_RESULT → on restore, `Chain.from_storage_dict` drops it; `SubagentRecord.from_storage_dict` does not call reconcile again (assert call count or assert the single drop path).
- **Default construction:** `SubagentRecord(id=..., agent=..., state=...)` without `chain`/`model` → `chain` is an empty `Chain`, `model is None`, `parent_chain_index is None`. Covers existing tests that construct without messages (e.g. elapsed-seconds tests).
- **parent linkage at spawn:** spawning within a turn whose chain index is `i` → `record.parent_chain_index == i`.

**Verification:** `pytest tests/test_subagent_manager.py` green; no orphan-reconcile duplication.

---

### U6. Subagent tab footer + session-total includes subagents

**Goal:** Per-subagent footer (reusing `ChainFooterWidget`) and fold subagent usage into the session-total beside the model.

**Requirements:** R5, R6

**Dependencies:** U5, U3, U4

**Files:**
- Modify: `src/stupidex/widgets/subagent_ui.py` (mount a `ChainFooterWidget(record.chain)` in each subagent `TabPane`; tick/freeze it)
- Modify: `src/stupidex/app.py` (`rerender_footer` — also sum `session.subagent_manager.all_records()` usages into the session total)
- Test: `tests/test_subagent_ui.py`, `tests/test_session.py`

**Approach:**
- In `SubagentUIManager.on_spawn`/`sync_tabs`, after mounting the subagent's `ScrollableContainer`, mount a `ChainFooterWidget(record.chain)` and store it in `_widgets[subagent_id]["footer"]` for later ticking.
- Drive footer ticks off the **subagent UI timer** (`_manage_timer`'s 1s interval, fired via `_tick_timer` → `update_sidebar`), not the app footer timer. Rationale: the two timers have non-overlapping lifespans precisely when it matters — `streaming_finished` stops the app footer timer (`_tick_footer`) the instant the main agent's turn ends, but subagents spawned during that turn often keep running; only the subagent UI timer stays alive in that window (it exists for exactly this case). Routing subagent ticks through the app timer would freeze their footers while still running. Extend `_tick_timer` to also iterate mounted subagent footers and call `tick()` on each `ChainFooterWidget` whose `chain.status == RUNNING`, and `freeze()` once terminal. This keeps each timer's ownership clean: app timer owns the main chain + `#model`; subagent timer owns subagent tabs. Avoids double-driving and a second timer.
- Since the subagent footer is mounted into a `TabPane` (not a `ChainContainer`), `tick()` is called on the `ChainFooterWidget` directly, not via a container — mirroring how `ChainContainer.tick` → `ChainFooterWidget.tick` already works.
- In `rerender_footer`, extend the session-total sum to iterate `session.subagent_manager.all_records()` and add each `record.chain`'s final-usage message tokens to the running totals.
- The per-subagent footer renders `model · elapsed · tokens` via `_build_text`, identical to a main chain footer.

**Patterns to follow:**
- The existing `ChainContainer.compose` footer mounting.
- `SubagentUIManager`'s existing `_manage_timer`/`_tick_timer` refresh driving sidebar updates.

**Test scenarios:**
- **Subagent footer present:** a spawned subagent whose chain has usage → its `TabPane` contains a `ChainFooterWidget` showing model + tokens.
- **Session total includes subagent:** session with one chain (usage A) and one subagent (usage B) → `#model` shows input/cached/output summed as A + B.
- **Subagent without usage:** subagent that produced no assistant usage → footer shows `model · elapsed` only; session total not affected by it.
- **Tick updates:** a running subagent's footer updates elapsed via the refresh timer.

**Verification:** `pytest tests/test_subagent_ui.py tests/test_session.py` green; subagent tokens appear in session total and per-tab footer.

---

### U7. Per-chain delegated subtotal

**Goal:** A chain footer shows the tokens of subagents it spawned, attributed via `parent_chain_index`.

**Requirements:** R11

**Dependencies:** U5, U3, U6

**Files:**
- Modify: `src/stupidex/widgets/message_widget.py` (`ChainFooterWidget._build_text`, or pass the attributed subtotal into the widget)
- Modify: `src/stupidex/app.py` (compute attributed subtotals; propagate to `ChainContainer`/footer)
- Test: `tests/test_chain.py` or `tests/test_subagent_manager.py`

**Approach:**
- When rendering a chain's footer, sum usage across `session.subagent_manager.all_records()` where `record.parent_chain_index == this chain's index`.
- Append `(sub: ↑{in} (⟲{cached}) ↓{out})` to the chain footer when nonzero.
- The chain needs its own index; `mount_all_messages` already iterates `session.chains` by position — carry the index onto the `ChainContainer` or look it up.

**Patterns to follow:**
- The per-chain usage lookup from U3.

**Test scenarios:**
- **Attributed subtotal:** chain index 0 spawns a subagent with usage B; chain index 0's footer shows its own usage plus `(sub: ...)`. Chain index 1's footer shows no sub segment.
- **No subagents:** a chain with no spawned subagents → no `(sub:)` segment.
- **Multiple subagents in one chain:** two subagents attributed to the same chain → subtotals summed together.

**Verification:** `pytest` green; per-chain footer reflects delegated work.

## System-Wide Impact

- **Persistence:** `Usage` gains a field (additive, backward-compatible). `SubagentRecord` storage shape changes (`messages` becomes a nested `chain` dict; `model`/`parent_chain_index` added). Old sessions load via `.get(..., None)` defaults. Existing `subagent_chains` storage key is retained; its per-entry shape nests a `chain`.
- **Rendering:** `ChainFooterWidget` renders subagent tabs in addition to main chains (one widget, two mount sites). The footer `#model` gains a token suffix. No new widgets; `ChainContainer` unchanged.
- **Accounting path:** session-total and per-chain totals walk `chain.messages[].usage` uniformly; subagent records are reached via `all_records()[].chain`. The sidebar `Context:` line (last-usage per view) is untouched.
- **No API surface change.** `stream_response`, `Tool`, and `Agent` signatures are unchanged. `spawn` gains an optional `parent_chain_index` param (defaultable to preserve internal callers that don't set it).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `SubagentRecord` field-order change breaks positional construction in tests. | Use keyword-only construction; existing tests already pass kwargs (`id=`, `agent=`, `state=`, ...). Add `chain` with `default_factory=Chain` so default-constructed records work. Provide `messages` property for read/append back-compat. |
| Cached tokens always `0` for some providers, mistaken for "not working". | Document that `0` is ambiguous; do not infer meaning. Extraction defaults to `0` rather than raising. |
| `prompt_tokens` already includes cached (OpenAI), risking double-count if display sums. | Display cached as subset (`↑{input} (⟲{cached})`), never additive. Pin via a test that the rendered line is subset-shaped. |
| `_current_chain_index` ContextVar not set when subagent spawns outside a turn (e.g. test harness). | Default to `None`; `parent_chain_index` is `None`-able and the U7 subtotal simply finds no match. |
| Orphan-reconcile de-duplication changes restore behavior if `Chain.from_storage_dict` and the old explicit call ever diverged. | They call the same function today; removing the duplicate is behavior-preserving. A test pins the single-call path. |
| `Chain` needs a stable index for U7 attribution; chains could be reordered in future. | `session.chains` is append-only today. If reordering is ever introduced, add a `chain_id` — flagged here, not needed now. |

## Open Questions

### Resolved During Planning

- **Subagent footer timer driver — reuse `_manage_timer` vs `_tick_footer`.** Resolved: extend the subagent UI timer (`_tick_timer`/`update_sidebar`), not the app footer timer. The app footer timer stops at `streaming_finished` while subagents often keep running; only the subagent timer stays alive in that window. Routing through it avoids a stale footer and a second timer. See U6.
- **Co-location of `_format_tokens`.** Resolved: `Chain.format_tokens` staticmethod in `domain/chain.py`, next to `format_elapsed`. `format_elapsed` is the established home for compact number formatting on the chain; `utils.py` is config/path/seed/tree helpers and is the wrong home. See U3.
- **Anthropic `cache_creation_input_tokens` — fold or separate.** Resolved: do not fold. Track cache-reads only (OpenAI `cached_tokens` / Anthropic `cache_read_input_tokens`), defaulting to `0`. Reads are genuinely a subset of `prompt_tokens` on both providers, preserving the R7 invariant the `↑{input} (⟲{cached})` display depends on. Anthropic creation is additive to `input_tokens` and billed differently (~1.25×); folding it conflates a saving with a cost and breaks the subset invariant. Known limitation: Anthropic creation tokens are dropped (under-reported input cost); a follow-up adds a `cache_creation_tokens` field + display slot for accurate cost accounting. See U1/U2.

### Deferred to Implementation

- Whether the subagent footer should also refresh on `sync_tabs` (restored sessions) in addition to live `_tick_timer` ticks. The implementer should ensure restored-completed subagents render a frozen footer via `freeze()` at mount time, since the timer only runs while subagents are active.

## Sources & Research

- `src/stupidex/domain/message.py` — `Usage` dataclass, `to_storage_dict`/`from_storage_dict` forward-compat pattern.
- `src/stupidex/llm/client.py` (`_stream_task`) — current three-field usage extraction (`prompt_tokens`/`completion_tokens`/`total_tokens`); `stream_options={"include_usage": True}` already set.
- `src/stupidex/widgets/message_widget.py` — `ChainFooterWidget` (`model · elapsed`), `ChainContainer`.
- `src/stupidex/widgets/sidebar.py` — `update_tokens`/`_usage_by_view` (per-view, last-usage; deliberately unchanged).
- `src/stupidex/widgets/subagent_ui.py` — `on_message` feeds per-subagent usage to the sidebar; `_manage_timer` 1s refresh.
- `src/stupidex/agents/manager.py` — `SubagentRecord` shape, `spawn`/`_run`, `from_storage_dict` orphan-reconcile duplication, `_current_manager` ContextVar pattern.
- `src/stupidex/tools/subagent.py` — `execute_delegate_to_subagent` resolves model via `get_model_for_tier` and passes it to `spawn` (currently discarded after `stream_response`).
- `src/stupidex/app.py` — `rerender_footer` (last-usage lookup), `_start_chain` (chain append + `ChainContainer` mount), `_tick_footer`.
- `src/stupidex/domain/chain.py` — `Chain.from_storage_dict` orphan reconciliation (the de-duplication target); `format_elapsed` (formatter template).
- Tests: `tests/test_message.py` (`TestUsageDeserializationForwardCompat`), `tests/test_streaming_messages.py` (`chunk`/`Usage` helpers), `tests/test_subagent_manager.py` (`SubagentRecord` constructions + persistence round-trip), `tests/test_chain.py`.
