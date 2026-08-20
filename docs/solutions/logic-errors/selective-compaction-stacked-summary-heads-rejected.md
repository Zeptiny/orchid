---
title: "Stacked selective summary heads deadlocked re-compaction"
date: 2026-08-20
category: logic-errors
module: "session-context compaction"
problem_type: logic_error
component: assistant
symptoms:
  - "After the first selective compaction, later compactions fire the compactor LLM on every step above threshold but never apply"
  - "Input usage climbs far past the context window (46k to 105k against a 48k window in one production session)"
  - "One orphaned compactor-selective LLM run per usage step (~26 in the affected session), all discarded"
  - "Nothing in ~/.orchid/logs/orchid.log — failures logged at console.debug"
  - "Multiple 'Compaction summary' widgets render for one logical compaction"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [compaction, selective-compaction, summary-heads, pending-apply, isPendingCutStillValid, apply-failure-backoff, orphaned-compactor, widget-coalescing]
---

# Stacked selective summary heads deadlocked re-compaction

## Problem

After the first selective-mode compaction persisted multiple stacked summary-head messages (one per summarize op), every later compaction above threshold fired the compactor LLM but the apply was always rejected. The session could never compact again, input grew to 2.2x the window, and each usage event started another orphaned compactor run whose result was silently discarded.

## Symptoms

- `compactor-selective` provider attempts in `accounting.db` on every consecutive step, while `sessions.db` gains no new `compacted` markers.
- Input token series keeps climbing after each prepare (no post-compaction drop).
- `applyPendingCompactionIfAny` returns `{ applied: false }` instantly — it never awaits the compactor promise when the pending is invalidated.
- Legacy sessions with several stacked heads render one "Compaction summary" widget per head.
- All failure paths logged at `console.debug`, invisible in `orchid.log`.

## What Didn't Work

- **Suspecting hysteresis / trigger gating** — the trigger did re-fire correctly; the accounting DB proved compactor runs happened every step. The bug was after prepare, in validation/apply.
- **Checking config (threshold / preserve_percent / min_compactable_tokens)** — the gate legitimately fired; the cut was legitimately non-empty.
- **Grepping `~/.orchid/logs/orchid.log`** — empty because every discard logged at debug level. Diagnosis only became possible by cross-referencing `accounting.db` `provider_attempts` (compactor-selective every step) against `sessions.db` (zero new compacted markers).

## Solution

Four coordinated changes (all on the main process + renderer):

**1. Compacted heads are valid at ANY depth in a compactable range.**
`isPendingCutStillValid` (`electron/src/main/llm/compaction/pending-store.ts`) no longer rejects ranges containing marker heads deeper than the range start. Staleness protection is the index-anchored `expectedIds` sequence captured at prepare time — a head inserted after the prepare shifts ids and is still rejected. The check now **fails closed** when `expectedIds` is absent (it is the only remaining structural protection).

**2. The apply supersedes heads instead of throwing.**
`buildCompactionApply`'s double-compaction guard (`validateCompactableRangeNotSummarized` + `CompactionApplyError`) was removed. Heads inside the range are flagged and replaced by the new head, exactly like other range messages — matching `select.ts`, which treats summary heads as re-summarizable chain boundaries, and `CONCEPTS.md`'s "a Summary Head may itself be re-summarized by a later compaction".

**3. The orphan cascade is stopped at the fire point.**
- Apply-failure backoff: `TriggerState.lastApplyFailureAt` + `markApplyFailed`/`isInApplyBackoff` (`APPLY_FAILURE_BACKOFF_MS = 30s`) in `trigger.ts`; `markCompactionApplied` clears it on success.
- One terminal helper `failPendingApply` (warn + `abortPrepare` + `onApplyFailed` + widget teardown) routes every discard branch in `applyPendingCompactionIfAny` — invalid cut, unusable result, persist failure, simple-mode fall-through, exception.
- In-flight guard: `selectiveRunsInFlight` map tracks the unsettled selective promise; `handleUsageCompaction` and `tryCompactSynchronously` refuse to start a new run while one is in flight. The backoff is deliberately NOT consulted in `tryCompactSynchronously` — the overflow-retry path must bypass the cooldown as the emergency safety net.

**4. One compaction = one summary head = one widget.**
- `materializeSelectiveOps` (`selective/run.ts`) coalesces ALL summarize ops into ONE synthetic head spliced at the first summarize op's position (sections joined by the shared `SUMMARY_SECTION_SEPARATOR` from `shared/types/message.ts`).
- The renderer (`stream-building.ts` walk + expanded flush, `SubagentTranscript.tsx`) coalesces CONSECUTIVE non-flagged heads into one `compaction-summary` item; `CompactionWidget` takes `messages[]` and sums counts/tokens. A flagged (superseded) head breaks the run and joins the compacted stub — the original messages stay visible by expanding that stub.

Regression coverage lives in `electron/tests/unit/compaction-recompaction.test.ts` (full select → run → apply → re-select → re-prepare → re-apply lifecycle, including the exact legacy six-stacked-heads shape), plus fire-point guard tests in `compaction-stream-emitter.test.ts`.

## Why This Works

The deadlock had two independent gates rejecting the same shape: pending validation and the apply guard both assumed "one head, at the range start". Selective materialization violated that assumption N times per compaction, so after the first apply, every subsequent range contained heads at depth > 0 → guaranteed rejection → prepare aborted without disarming anything → the next usage event started a fresh compactor run while the previous one was still streaming. Fixing the guards makes re-compaction apply (heads are superseded, which the selection engine always intended); coalescing materialization stops creating the stacked shape going forward; backoff + the in-flight guard bound the damage of any future failure mode instead of letting it multiply per step.

## Prevention

- **Diagnosis recipe** for "compaction fires but context never shrinks": compare `accounting.db` `provider_attempts` (`agent_name = 'compactor-selective'`) against `sessions.db` compacted markers. Attempts without markers ⇒ the failure is in validation/apply/persist, not the trigger.
- **Compaction discards must log at warn level** — a discarded pending is operationally significant (repeated provider calls + context growth).
- **Every pending-discard path must arm the backoff** via the shared `failPendingApply` helper; a new failure branch that clears state without `onApplyFailed` re-opens the cascade.
- **A compacted summary head is re-summarizable at any depth.** Never add a guard that rejects marker heads inside a compactable range — the staleness protection is the prepare-time expected-id sequence.
- **One logical compaction persists ONE synthetic summary head**; anything that introduces per-op messages must coalesce them (and render them as one widget).

## Related Issues

- `docs/solutions/logic-errors/mid-turn-compaction-apply-dedupe-mismatch.md` — the earlier re-fire loop from a different apply-rejection cause (dedupe mismatch); its "failed apply cannot disable future fires" rule is what this cascade exploited — see its update note.
- `docs/solutions/ui-bugs/mid-turn-compaction-inline-summary-heads.md` — stub/run coalescing; now extended by head→widget coalescing (see its update note).
- `docs/solutions/design-flaws/compaction-null-window-chars4-and-chain-preserve.md` — trigger/threshold/hysteresis background.

## Follow-up: mid-turn resume erased the compacted transcript (review #54)

Field report after the deadlock fix: re-compaction now applies (usage drops each fire), but the live view rendered one "Compacted N messages" stub per kept-thinking gap (4/8/2/2/2), and after the next request the stubs "merged" — actually **vanished**: the durable chain row had zero `excludeFromModel` flags and only one surviving summary head across 8 compactions.

Root cause (two parts):

1. **Durable data loss.** The mid-turn apply durably flags originals + inlines the head into the ACTIVE chain row (one row per turn), but `resetTurnForCompactionResume` then swaps the turn base `messages` to the *model-view replay* (no flagged originals). Every later checkpoint/finalize derives the durable row from `turnMessagesFromAgent` = `messages.slice(priorMessageCount)` + new messages — overwriting the row and erasing the flagged originals and superseded heads. "Merged on next request" = silent never-delete violation.
2. **Renderer fragmentation.** Selective keeps thinking verbatim (R24) between summarized tool spans; the renderer's compacted run broke at every kept thinking message, so one compaction rendered as N stubs.

Fix:

- `ActiveAgent.transcriptBase` (ipc/chat/state.ts): the transcript-complete turn slice; `turnMessagesFromAgent` prefers it over the model-view slice. `resetTurnForCompactionResume(next, transcriptOverride?)` maintains it; `persistSelectiveCompaction` now returns the transcript view (settled flags + new summary rows spliced at the same anchor storage used) and every selective apply/retry path threads it through.
- Renderer (`stream-building.ts`): kept thinking between flagged spans is absorbed into the open compacted run (lookahead rule: the run continues only if the next non-thinking visible message is itself excluded); the stub count reports only messages actually hidden from the model; the expanded view still shows the absorbed thinking at full fidelity.

Regression tests: `chat-ipc.test.ts` "mid-turn selective apply keeps flagged originals + inline head in the durable turn row" (fails on the pre-fix code), plus the stream-building absorption tests.

## Follow-up 2: stray Thought widgets + the stale-checkpoint race (review #55)

Field report after the #54 fix: stray "Thought Ns" widgets still rendered *above* and *between* the "Compacted N messages" stubs, fragmenting one compaction into 5+ pieces; a second compaction in the same turn made it worse.

Root causes:

1. **Absorption only covered the interleaved case.** Leading kept thinking (before the FIRST flagged span) and trailing kept thinking (between the run's end and its summary head) rendered as standalone widgets; so did kept assistant text ("Now let me read …") between flagged spans.
2. **Stale-checkpoint race (data loss path).** `scheduleCheckpoint` captured the turn snapshot at *schedule* time. The checkpoint scheduled by the same usage event that triggers the compaction fires 300 ms later — post-apply — and `updateActiveChainMessages` wholesale-replaced the active chain row with the stale pre-compaction slice, erasing the just-written flags and inline head until the next write recovered them (and permanently, on a crash/interrupt inside the window).

Fixes:

- `stream-building.ts`: absorption now covers leading (kept thinking absorbs when the first non-thinking visible message ahead is excluded), interleaved, and trailing (next is excluded *or* the summary head) kept thinking, plus interleaved kept assistant text (leading text after the user message still renders; user messages never absorb). The stub count still reports only messages hidden from the model.
- `persist.ts`/`state.ts`: the debounced checkpoint now stores a snapshot *getter* and re-derives from the live agent at fire time (`checkpointMessagesFromAgent(agent, context)`), so it always reflects the current `transcriptBase`/`turnMessages` — never a pre-compaction capture. `checkpointCompactionMidTurn` keeps its intentionally-pinned slice with the agent-identity guard.

Also: **dev-workflow gotcha** — `npm run dev` hot-reloads only the renderer; main-process compaction changes require an Electron restart, otherwise the new widgets render against the old data-loss main process (exactly this field report's durable row: 7 heads, zero flags).

Regression tests: stream-building leading/trailing/kept-text absorption cases, and the review-#54 integration test now uses a deliberately slow (450 ms) resume so the 300 ms checkpoint debounce fires post-apply mid-turn — it asserts every post-apply checkpoint write carries the flagged originals (fails on schedule-time capture).
