---
title: "Compaction chain-split id assignment is deliberately asymmetric and contract-pinned"
category: convention
module: "llm/compaction"
date: 2026-08-19
last_updated: 2026-08-20
problem_type: convention
component: assistant
severity: low
tags:
  - compaction
  - chain-split
  - id-assignment
  - contract-tests
  - pinned-tests
  - session-persistence
  - code-review
applies_when:
  - "Modifying chain-split or compaction id-assignment logic (buildCompactionApply or applyCompactionPersistence)"
  - "Evaluating a review finding that proposes fixing id or status handling in the compaction split"
  - "Adding or changing compaction tests that encode chain id/status semantics"
---

# Compaction chain-split id assignment is deliberately asymmetric and contract-pinned

> **SUPERSEDED (2026-08-20):** The durable chain-split this doc describes was **removed**. `applyCompactionPersistence` now inserts summary heads INLINE into the anchor chain — no prefix/summary/suffix rows, no `splitTailChain`, no `resolveSplitTailChain` — restoring one-turn-one-chain-row (see `docs/solutions/ui-bugs/mid-turn-compaction-inline-summary-heads.md`). The pure-apply split in `buildCompactionApply` still exists in-memory. This doc's *meta-lesson* survives but carries a counterexample: the "pinned contract tests = decline the finding" rule was later disproven as an absolute — the pinned split layout was itself the root cause of a transcript-corruption bug, and the tests had to be rewritten with the fix. Verify a pinned invariant against the system's other invariants (e.g. one-chain-row-per-turn) before letting it veto a finding.

## Context

A PR-review pass over the context-compaction subsystem produced an inline finding demanding that the intra-chain split's id assignment be inverted — "the original chain ID remains on the continuing suffix, while the frozen prefix receives a new ID and is marked COMPLETED" — claiming `sessions.active_chain_id` would otherwise reference a stale chain after reload. Implementing it exactly as written broke **five pinned contract tests**, because the two halves of the subsystem deliberately pin *opposite* directions:

- **Pure apply** (`electron/src/main/llm/compaction/apply.ts:399-423`, `buildCompactionApply`) — the in-memory split keeps the **original id on the preserved after-half** (external references — `session.activeChainId`, subagent `record.chain` — keep pointing at the live continuing half); the frozen flagged prefix gets a fresh `randomUUID()`. Both halves preserve the original status. Pinned by `electron/tests/unit/compaction-apply.test.ts:324-380` ("intra-chain split keeps the original id on the preserved half (FIX #7)").
- **Durable persistence** (`electron/src/main/session/storage.ts:2100-2121`, `applyCompactionPersistence`) — the on-disk split keeps the **original id on the flagged prefix row** (rewritten in place); the continuing suffix takes a fresh id or the caller-supplied `splitTailChain` id. Pinned by `electron/tests/unit/session-compaction-persistence.test.ts` test (c) at :294-336 and (c2) at :338-362.

`resolveSplitTailChain` (`electron/src/main/ipc/chat/persist.ts:345-359`) bridges the two: it detects the pure apply's fresh suffix id (absent from the pre-compaction chain list) and feeds it to the durable path as `splitTailChain`.

A reachability check showed the claimed hazard was not real: `applyCompactionPersistence` is a between-turns path where `sessions.active_chain_id` is already NULL — process-restart load recovery nulls active-chain pointers regardless (`storage.ts` restart-recovery + load paths). Resolution: revert both halves of the attempted change and decline the finding citing the pinned tests and the unreachable hazard.

## Guidance

When a review finding proposes a "better" behavior that a pinned contract test locks in differently, treat that as a strong signal the behavior is deliberate, then verify before changing anything:

1. **Run the pinned tests first.** A contract test asserting exact chain-id ordering in the direction the finding wants to change is the system saying the "bug" is a designed invariant — and often that a second legitimate path exists that the finding's author did not see (here, the pure and durable layers assign ids oppositely *on purpose*).
2. **Check reachability of the claimed hazard.** Ask: can this path execute in the state where the hazard matters? Grep the pointer's other mutation sites. A hazard resting on a pointer that is already NULL in the target path is unfounded regardless of how plausible the prose sounds.
3. **Read the status semantics, not just the ids.** The finding's "mark the prefix COMPLETED" also conflicted with the pinned "statuses preserved on both halves" — status is a domain property, not a side effect of the split.
4. **When reverting a declined change, revert every half.** Flipping one layer without its counterpart leaves the two layers contradicting each other; reverting the whole attempted change restores one coherent, test-pinned design.
5. **Grep for any "established mechanism" the finding assumes.** Findings often justify themselves by reusing something that does not exist (see Examples).

## Why This Matters

Pinned contract tests are the footprint of a prior, resolved design decision. The relative cost of verifying — run a test, grep an invariant — is trivial next to a wrong inversion of durable data semantics (which half owns the original chain id on disk after reload) that must be unwound. Same pass, same discipline, three more declines: heal-gating broke paged-read healing tests; a reclaim-overhead discount had no mechanism to reuse (grep-verified) and would violate the module's no-heuristic-token-estimation rule; a kebab-case file rename broke a 10:2 local naming convention.

## When to Apply

- A review finding proposes inverting or relocating an id/status assignment that reads as "obviously better."
- A pure-apply change would need a durable-write partner (or vice versa) — check both layers and both test files for mirrored, possibly *opposite* assertions.
- A claimed fix cites a hazard (dangling pointer, stale ID) — confirm the hazard path can actually execute.
- Declining a finding: leave an evidence trail (which tests pin current behavior, why the alternative is a behavior change) so the reasoning survives.

## Examples

**Declined — pinned-tests + reachability evidence:** the split-id inversion broke `compaction-apply.test.ts:324-380` (pure direction) and `session-compaction-persistence.test.ts:294-362` (durable direction); the `active_chain_id` hazard is unreachable because the durable path runs between turns with the pointer already NULLed by restart recovery.

**Same-session declines (same discipline):**
- "Gate superseded-chain healing to full loads only" — reverted: paged-read (`loadSessionView`) tests assert healing happens there too; gating is a behavior change for a perf-only concern.
- "Subtract system-prompt/tool overhead from `estimateReclaimedTokens`" — declined: no non-message char weight exists at those pure trigger call sites; grep confirms no established conservative-discount mechanism; inventing one violates the documented no-heuristic estimation rule.
- "Rename `CompactionWidget.tsx` to kebab-case" — declined: `ToolResults/` is 10 PascalCase : 2 kebab-case.

**Contrast — fixes that landed** (they changed under-specified behavior, not pinned invariants): `buildManifest` now skips excluded/hidden messages so no keep op can resurrect them; the summarizer idle timeout re-arms per text delta; `validateSelectiveOps` no longer counts drop ops as summarize-gap coverage and now rejects cross-op duplicate ids as an exact-once error.

## Related

- `docs/code-review-reports/2026-08-18-feat-session-compaction-pr141.md` — origin of the FIX #7 pin and the durable-path redesign; its finding #7 prose describes only the pure direction and could mislead if read as global.
- `docs/plans/2026-08-17-001-feat-session-compaction-plan.md` — R3 (replace, never delete), R20 (summary head is its own chain), R22 (crash-atomic write) invariants both paths implement.
- `docs/solutions/design-flaws/compaction-null-window-chars4-and-chain-preserve.md` — chain-preservation semantics in the same module.
- `docs/solutions/logic-errors/mid-turn-compaction-apply-dedupe-mismatch.md` — pure-apply path correctness.
- `docs/solutions/performance-issues/incremental-sqlite-session-lifecycle-writes.md` — the SQL-footprint rule that motivated `applyCompactionPersistence`.
- GitHub issue #119 — "Session compaction / compression — analyze strategy then implement" (umbrella issue).
