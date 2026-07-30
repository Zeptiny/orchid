---
title: Subagent resume/cancel lifecycle races — settling runs, evicted summaries, and stranded durable rows
date: 2026-07-29
category: logic-errors
module: subagents
problem_type: logic_error
component: background_job
symptoms:
  - Resumed subagent's chain silently clobbered by the previous run's teardown; new run's abort controller orphaned (uncancellable zombie run)
  - close_subagents reported success but the closed flag never reached disk
  - Cancelled resume-queued subagent stranded with status "queued" in durable storage, un-rehydratable until restart
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [subagents, lifecycle, resume, hydration, eviction, persistence, race]
---

# Subagent resume/cancel lifecycle races — settling runs, evicted summaries, and stranded durable rows

## Problem

Adding resume (`followUp`) and close (`close_subagents`) lifecycle operations to the subagent manager created three races against two pre-existing invariants: the runner-owned async interruption boundary (a cancelled RUNNING record is terminal on paper while its run loop still owns teardown), and the retention-eviction contract (every persistence checkpoint skips `_evicted` records). All three were caught in code review, not production.

## Symptoms

- After `cancelOne` on a RUNNING subagent, an immediate `followUp` started a second run on the same record; the zombie run loop's partial flush then replaced the resumed chain (follow-up message erased) and its `finally` block nulled the new run's `abortController`/`_runPromise` — an uncancellable streaming run, with transient chain corruption reaching disk if a checkpoint landed in the window.
- `manager.close()` set `closed = true` on an `_evicted` summary shell (reachable when a concurrent checkpoint evicted the record between the close tool's hydration `await` and its guard loop, or when durable storage lost the row); every flush skips `_evicted` records, so the tool reported `closed` while the flag never persisted.
- `cancelOne` on a resume-queued record (`_resumeQueued = true`, which deliberately keeps a durable row) called `_evictToSummary` synchronously; the `_evicted` skip then preceded the `_resumeQueued` eligibility carve-out, so the INTERRUPTED finalization never reached disk and the row was stranded with the invalid persisted status `queued`. Hydration only accepts terminal statuses, so the record became un-rehydratable until restart.

## What Didn't Work

- Relying on the tool-side hydrate-first ordering alone: the guard loop and the hydration helper are separated by an `await` (macrotask boundary), so a record's eviction status can change underneath the tool. Manager-level defenses are required for every mutation whose persistence depends on record shape.
- Testing the resume-queued durable-row rule with a local copy of the production predicate (`queuedAt !== null && startedAt === null && !record._resumeQueued`): the test stayed green regardless of the real module. Assert persistence behavior through the real `persistSubagentChains` path or observationally (eviction state, durable status), never with mirrored predicates.

## Solution

Three manager-level guards plus one cancel-path fix (all in `electron/src/main/agents/manager.ts`):

1. **Still-settling guard** — `followUp` rejects a record whose `_runPromise !== null`. A cancelled RUNNING record is already terminal, so this is the only window where a zombie run loop can clobber a resumed record. Mapped at the tool to a retryable "still settling; retry shortly" error (`SubagentStillSettlingError`).
2. **Evicted-close guard** — `manager.close()` throws `SubagentSummaryClosedError` on an `_evicted` record instead of setting an unpersistable flag; the close tool maps it to a loud `not_found` for that id rather than a silent success.
3. **Resume-queued cancel** — `cancelOne`'s queued path skips `_evictToSummary`/`_trackSummary` when `record._resumeQueued` is true. The record stays a full dirty INTERRUPTED record: the terminal wave persists the correct status (and the follow-up message), then `confirmRecordsPersisted` evicts it through the normal row-confirmed path.

## Why This Works

Each fix moves an invariant from an implicit, order-dependent assumption into the mutation site:

- The runner-owned interruption boundary means "terminal state" and "finished unwinding" are different points in time; any new lifecycle entry point that treats terminal as safe-to-mutate must also check `_runPromise`.
- `_evicted` is not just a memory optimization — it is a persistence veto (`if (record._evicted) continue;` runs before every eligibility rule). Any mutation whose effect must reach disk is meaningless on a summary shell, so the mutation must refuse loudly instead of succeeding silently.
- The `_resumeQueued` carve-out only works if nothing sets `_evicted` before the next checkpoint; the cancel path was the one caller that did so unconditionally.

## Prevention

- When a state machine has an async teardown boundary ("owner X finalizes later"), enumerate every other entry point that can touch the record in that window and add a settling guard or a generation check.
- When adding a persistence-eligibility carve-out, grep for every site that sets the veto flag (here `_evicted = true`) and verify ordering against the carve-out.
- Regression tests that pin the durable outcome, not just in-memory state: cancel-resume-queued asserts `_evicted === false` plus the follow-up message survives for the terminal wave; still-settling asserts the rejected resume leaves the chain unmutated; evicted-close asserts the flag stays false.
- Prefer manager-level typed errors over tool-level checks for invariants tied to record shape — tools compose and interleave; the manager is the last line of defense.

## Related Issues

- docs/solutions/performance-issues/incremental-sqlite-session-lifecycle-writes.md — the targeted-upsert + persist-first ordering this work relies on
- docs/plans/2026-07-28-001-feat-subagent-close-and-follow-up-plan.md — the feature plan these findings came from
