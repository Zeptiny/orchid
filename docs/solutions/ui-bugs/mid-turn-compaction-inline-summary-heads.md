---
title: "Mid-turn compaction must keep one-turn-one-chain-row (inline summary heads) and refresh the session cache from storage"
date: 2026-08-20
category: docs/solutions/ui-bugs
module: session compaction (main scope) — durable persistence, renderer projection, live cache
problem_type: ui_bug
component: database
severity: high
symptoms:
  - "\"Compacted 1 message\" stubs render between/after turn content; expanding shows a superseded compaction summary"
  - "Compaction summary renders ABOVE the turn's user message"
  - "User message disappears from the transcript after the turn's final assistant message"
  - "One ~130-message turn grows to 29 chain rows / ~630 message rows durably (duplication ladder)"
root_cause: logic_error
resolution_type: code_fix
tags: [compaction, chain, session, sqlite, persistence, renderer, stub, summary-head, bounded-view, cache]
related_components: [renderer stream-building, session manager cache, chat send/persist]
---

# Mid-turn compaction must keep one-turn-one-chain-row (inline summary heads) and refresh the session cache from storage

## Problem

During a single agent turn that triggers several compactions, the chat transcript rendered corrupted — fragmented "Compacted 1 message" stubs, the compaction summary ordered above the turn's user message, and the user message vanishing once the turn finished. Durably, the turn exploded into many duplicate chain rows. Re-entering the session looked correct, so the corruption was specific to the live mid-turn view.

## Symptoms

- "Compacted 1 message" stubs interleaved with tool output / below the chain footer; expanding one revealed the previous compaction's summary text.
- The compaction summary card appeared above the user message that started the turn.
- The user message disappeared entirely after the turn's final assistant message (transcript started with the stub).
- SQLite inspection: a single turn produced a ladder of chain rows, each containing a full superset copy of the previous rung (20 → 33 → 44 → 52 → 74 → 83 → 92 → 107 → 118 messages).
- Exiting and re-entering the session rendered correctly (the reload read durable rows, bypassing the stale in-memory cache).

## What Didn't Work

- **Renderer-only stub merging (first fix attempt).** Hoisting the compacted-run buffer out of the per-chain walk into shared state so flagged runs merge across chain boundaries fixed the count-1 stubs at rest — but the live view still mis-ordered, because the renderer was being served a stale, unsplit session cache (root cause 4). Renderer fixes cannot survive a wrong durable layout.
- **Keeping the original chain id on the "continuing" split half (second fix attempt).** Matching the pure apply's split invariant (preserved suffix keeps the original id/ACTIVE status; flagged prefix gets a fresh frozen row) fixed the append-order semantics — but the split itself still multiplied rows: mid-turn resume re-anchored the durable slice at the user message, so debounced checkpoints rewrote the ENTIRE turn into the continuing row, and the next compaction re-split a bigger balloon (root cause 3).
- **Anchoring the resume at the continuing-row boundary (third fix attempt).** Threading a `resumeAnchorId` so the durable slice started at the first preserved message kept rungs disjoint — but the bounded renderer view still starved: it budgets newest-chain-first, so the ACTIVE row's balloon consumed the 240-message/2MB budget and the oldest row (holding the user message's first copy) arrived empty, stubbed by the 20-chain collapse threshold. Any multi-row-per-turn layout loses here; the correct fix is to not create the rows.
- **`deleteSupersededChains` containment judged on raw id sets.** A stale duplicate row survived cleanup because it carried one hidden usage-carrier message id the subsuming row lacked — containment must be judged on VISIBLE ids (hidden messages don't protect a row).

## Solution

Three coordinated changes (plus renderer merging, which is correct but not sufficient alone):

**1. Insert summary heads INLINE into the anchor chain — never split rows** (`session/storage.ts`, `applyCompactionPersistence`). When `insertBeforeMessageId` names a durable message, the summary chain's messages are spliced into the owning chain at that index; flags are applied in place. One turn stays one chain row, mirroring the subagent scope's `applySubagentCompactionPersistence` shape. The append-at-end case (no anchor) still writes a separate row.

```ts
// storage.ts — inline insertion replaces the old prefix/summary/suffix split
if (!anchorEntry) {
  // append after the last durable chain (no anchor chain to inline into)
  insertChainRow(db, insertChain, summary, ordinal);
} else {
  const withSummary: Message[] = [
    ...anchorEntry.messages.slice(0, anchorIndex),
    ...summary.messages,
    ...anchorEntry.messages.slice(anchorIndex),
  ];
  updateChainRow(db, { ...chainMetadataFromRow(anchorEntry.row), messages: withSummary });
}
```

Because the row is never split, the mid-turn resume keeps its original user-message anchor (`resetTurnForCompactionResume` in `ipc/chat/send.ts`): the full-turn checkpoint rewrite preserves the flagged prefix and inline heads exactly where the compaction put them. The earlier `resumeAnchorId` threading was removed.

**2. Refresh the session cache from storage after every durable compaction write** (`session/manager.ts` → `refreshCachedSessionFromStorage`, `ipc/chat/persist.ts` → `publishCompactedSession`). The renderer's compaction reload (`session:open`) reuses the in-memory session, so serving a hand-built pre-compaction view mis-orders the transcript. The refresh reads a NEW unrecovered bounded load (`loadSessionViewUnrecovered`) so a live ACTIVE chain keeps its status and the session's active-chain pointer, then merges live non-chain fields (name, selection, todos…). `buildCompactedCacheChains` (hand-built cache) was deleted.

**3. Renderer merges compacted runs across chain boundaries** (`renderer/utils/stream-building.ts`). The compacted-run buffer is shared state threaded through every chain walk (`ChainWalkState`), flushed only when a visible item renders — message, summary, footer, collapsed-stub, or end of build. Superseded summary heads are flagged like range messages, so they coalesce into the adjacent run's single stub. A chain contributing only a user message plus a compacted run (legacy split-prefix shape) drops no footer, and cross-chain message-id dedupe collapses stale mirrored rows.

**4. Containment on visible ids** (`deleteSupersededChains`): superseded-row detection compares the candidate's VISIBLE id set against the owner's full id set, so hidden usage-carrier extras no longer protect duplicate rows.

## Why This Works

The corruption had four reinforcing causes; the fix removes the structural one and the cache one, and the renderer change absorbs legacy shapes:

1. Per-chain buffering fragmented one logical compacted run (spread across split rows) into count-1 stubs. Shared buffering with boundary-only flushing renders one stub regardless of row layout — and matches the post-finalize reload view.
2. The split-row layout ("summary head is its own chain") violated one-turn-one-chain-row. The bounded renderer view budgets newest-chain-first, so extra rows starved the oldest row — the one holding the user message — and pushed sessions past the 20-chain collapse threshold. With inline heads there is exactly one row per turn; the user message always renders from its own turn's row.
3. Resume-anchored-at-user + full-turn checkpoint rewrites are now harmless: there is no split to duplicate. The durable row already holds user + flagged prefix + inline heads + window; rewriting it is idempotent.
4. The cache refresh guarantees the renderer's reload sees precisely what a cold read would see, eliminating the window where the summary was spliced above an un-split chain and the next checkpoint update deleted the user message from view.

Verified end-to-end against the corrupted production session (via a scratch harness over the real DB): user message first → one merged stub → current summary → preserved window → active footer; the chain remained a single ACTIVE row across two successive compactions.

## Prevention

- **Never restructure durable chain rows from compaction.** Compaction is a flagging operation plus an inline message insertion. If a change feels like it needs row splitting, re-derive against the one-turn-one-chain-row invariant (see `performance-issues/incremental-sqlite-session-lifecycle-writes.md`) before writing code.
- **After any durable write that changes row shape, refresh the in-memory session from storage — unrecovered when a live turn is in flight.** A hand-built "cache view" diverges from what reloads serve; the renderer's session:open reuses the cache, so the cache is a rendering surface, not a private optimization.
- **Pinned contract tests are the durable record of a design — including a wrong one.** The old split layout was pinned by `session-compaction-persistence.test.ts` (c)/(c2); when the layout was the bug, the tests had to be rewritten with it. Treat "a test pins this" as "a test must be updated too," not as evidence the finding is invalid.
- **Bounded views are newest-first; per-turn row growth has a hard UI budget** (message budget, byte budget, chain-collapse threshold). Any feature multiplying rows per turn will starve the renderer — assert row count per turn in storage tests (the `(c3)` re-compaction test does: one row, every message id exactly once).
- **Inspect the real DB when renderer symptoms look impossible.** `~/.orchid/sessions.db` chain dumps (`ordinal`, message ids, `exclude_from_model`, `compacted` markers, `recentStartIndex`) made every root cause directly observable; simulations of `loadSessionView` + `buildHistoryStreamItems` against a copy of the production DB reproduced and verified each fix before shipping it.

## Related Issues

- `docs/solutions/conventions/compaction-chain-split-asymmetric-id-assignment.md` — documented the now-removed split-row layout; superseded by this fix (needs refresh).
- `docs/solutions/logic-errors/mid-turn-compaction-apply-dedupe-mismatch.md` — same mid-turn pause/apply/resume machinery; its resume-merge persistence interaction is what fed the duplication ladder under the old layout.
- `docs/solutions/performance-issues/incremental-sqlite-session-lifecycle-writes.md` — source of the one-turn-one-chain-row and persist-first/publish-second invariants this fix restores.
- `docs/solutions/design-flaws/compaction-null-window-chars4-and-chain-preserve.md` — long-turn compaction behavior in the same trigger scenario.
