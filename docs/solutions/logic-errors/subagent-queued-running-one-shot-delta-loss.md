---
title: Subagent queued→running transitions lost to one-shot delta drops
date: 2026-08-26
category: logic-errors
module: subagents
problem_type: logic_error
component: background_job
symptoms:
  - Subagents sit in the Queued list (status badge queued) long after admission actually started them
  - Badge and streaming transcript say running while the row stays bucketed under Queued, then flips late
  - In dev (StrictMode remount) a subagent could stay stuck running until turn end or a session re-select
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [subagents, delta-events, eligibility, admission-queue, renderer-state, convergence]
---

# Subagent queued→running transitions lost to one-shot delta drops

## Problem

A subagent parked in the admission queue emits exactly one `status_changed` delta when it is admitted (`pending`, then `running`). Those one-shot events were dropped permanently in two places, so the renderer's `records[].status` — which drives Queued/Running list placement — stayed stale until the next snapshot (turn end, session re-select, or recovery flush).

## Symptoms

- Row stays in the Queued group while the badge (live-projection preferred in `buildSubagentDetail`) already says "running" — the badge/list split makes the desync visible.
- Recovery latency feels random: any later snapshot heals it, so the row "eventually flips".

## What Didn't Work

- Reproducing through the manager → renderer happy path in isolation: spawn-seeded, snapshot-seeded, and heavy-flood (400-delta) compositions all passed — the happy path is sound. The bug only appears when the one-shot delta is *lost*, which no isolated test exercised.
- Assuming the batcher's budget deferral covered lifecycle events: eligibility dropping happened *after* the budget split, so `spawned`/`terminal`/`status_changed` marked "budget-exempt and always flush" were still silently discarded for a session with no currently-eligible recipient window (transient misses: session-select race, lazily-connected host client, StrictMode unsubscribe gap).

## Solution

Three convergence layers (branch `fix/subagent-queued-running-desync`, commit `215302aa`):

1. **Batcher carry** (`electron/src/main/agents/subagent-events.ts`): ineligible-session lifecycle deltas are carried in the deferred queue in order and retried on later flushes; content deltas for ineligible sessions stay dropped (snapshots re-establish them). A stall budget (`MAX_STALLED_CARRY_FLUSHES = 40` consecutive undelivered flushes) drops the carry so an abandoned session cannot poll `isEligible` forever. Eligibility now runs *before* budget accounting so ineligible sessions no longer consume the per-flush budget.
2. **Renderer self-heal** (`electron/src/renderer/utils/subagent-stream.ts`): the first content delta that promotes a queued live draft (`applyDeltaToDraft`'s queued→running rule) now also updates `records[].status`, so list placement converges on the same evidence the badge uses.
3. **Unknown-run convergence**: `terminal` now applies without a seeded run (authoritative record handoff settles a dropped-seed row), and `status_changed` applies for an existing non-terminal row without opening the run's live stream. Guards: terminal-valued `status_changed` is dropped, settled rows can never be un-settled by a stale carry, and a rotation-`spawned` resets the sticky `settled` flag so terminal + resume in one envelope keeps the new run's live stream (reviewer-caught P2).

## Why This Works

The delivery pipeline treats lifecycle deltas as one-shot notifications with no re-delivery or mid-session re-sync (the `subagents:changed` broadcast fires only on recovery flushes by design, R8). Once any single hop drops the transition, nothing re-asserts it. Making each layer independently convergent — carry at the transport, evidence-based promotion in the renderer, authoritative-record application for terminals — means no single dropped event can strand the row, without violating the R8 "no broadcast on ordinary flushes" rule.

Key invariants that made the carry safe (verified by review):
- An undelivered flush implies the queue is *only* carried lifecycle events (budget deferral requires delivered events), so the stall drop can never discard budget-deferred content.
- Carried lifecycle and budget-deferred content share one `deferred` array in queue order, preserving per-subagent emission order.
- `runId` is only assigned for `spawned` events, so status/terminal application can never open a live stream that later content would half-populate.

## Prevention

- Every new delta type must be added to the exhaustive-switch test (`summarizeDelta` in `tests/unit/subagent-ipc.test.ts`) — `status_changed` shipped without one, leaving its paths untested.
- Regression tests now pin the drop paths: carry-then-deliver, stall-bound drop with no lingering timer, content-delta self-heal, unknown-run status/terminal gating, and terminal+rotation in one envelope.
- When adding a one-shot wire event, ask "what happens when it is lost?" — prefer designs where later events or a snapshot can converge the same state.

## Related Issues

- `docs/solutions/logic-errors/subagent-resume-lifecycle-races.md` — adjacent lifecycle races on the same manager.
- Commit `0fe3899b` — introduced the `status_changed` delta for queued→running (the event this doc makes loss-tolerant).
- Issue #121 work (branch `fix/issue-121-subagent-restart-desync`) — restart-time counterpart: queued spawns never persisted and the shutdown breaker losing terminal statuses.
