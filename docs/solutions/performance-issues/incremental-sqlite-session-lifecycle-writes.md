---
title: Incremental SQLite writes at session lifecycle boundaries
date: 2026-07-24
category: performance-issues
module: Electron session persistence
problem_type: performance_issue
component: database
severity: medium
symptoms:
  - Ordinary turn boundaries rewrote every historical chain row in the session
  - Persistence work grew with accumulated conversation history
  - Stable historical chain rows were deleted and reinserted during unrelated updates
root_cause: logic_error
resolution_type: code_fix
tags:
  - sqlite
  - session-persistence
  - incremental-writes
  - transactions
  - turn-boundaries
  - electron-main-process
---

# Incremental SQLite Writes at Session Lifecycle Boundaries

## Problem

Ordinary session lifecycle operations used a persistence primitive whose work
scaled with the complete conversation history. `saveSession()` upserts the
session, deletes every chain belonging to it, then serializes and reinserts
every chain in ordinal order
(`electron/src/main/session/storage.ts:395-445`).

That operation is appropriate when creating or reconstructing a complete
session. It is unnecessarily broad for a turn boundary or metadata change,
where only one chain and a small set of session columns changed. Since Orchid's
SQLite API is synchronous in the Electron main process, repeatedly doing
history-sized work on these paths also creates avoidable main-process work as a
session grows. No timing benchmark was recorded for this change, so the durable
claim is about the SQL and serialization footprint rather than an absolute
latency improvement.

## Symptoms

The scaling behavior was explicit in the full-save algorithm:

1. Upsert the session row.
2. Run `DELETE FROM chains WHERE session_id = ?`.
3. Iterate through the complete `session.chains` array.
4. Serialize and insert every chain again.

The implementation is visible at
`electron/src/main/session/storage.ts:402-444`. Its work therefore grew with
both the number of historical chains and the messages stored in those chains,
even when a caller changed only the active chain or a session field.

The broad save also replaced stable historical rows rather than preserving
their database identity. The regression test makes this observable by
installing a trigger that rejects any chain deletion and comparing a completed
chain's `rowid` before and after a second turn plus metadata updates
(`electron/tests/unit/session-persistence.test.ts:1690-1754`).

## What Didn't Work

The full-replacement transaction was correct as a complete snapshot write, but
its unit of work did not match normal lifecycle mutations. Atomicity alone did
not make deleting and reconstructing unrelated historical rows appropriate.

A targeted `updateChain()` path already showed the right shape for streaming
checkpoints: update one chain and the owning session's recency in a transaction,
and return `false` if the expected chain is missing
(`electron/src/main/session/storage.ts:662-679`). It did not cover the complete
turn lifecycle:

- Starting a turn must insert a chain, move the session's active pointer, and
  interrupt only identified stale active chains together.
- Finishing a turn must persist the terminal chain and clear the active pointer
  together.
- Metadata updates must not touch chain history at all.

Earlier work on subagent-history persistence encountered the same general
failure mode: replacing a complete persisted collection from a partial
in-memory working set could erase records that were simply not loaded. That
work settled on merging by immutable identity and preserving persisted-only
terminal records. This is supporting provenance for the pattern, not evidence
about the current implementation; the current code and tests remain
authoritative. (session history)

## Solution

The storage layer now exposes operations shaped around the domain mutations,
while retaining `saveSession()` for creation and missing-row recovery.

### Update only declared session fields

`SessionFieldsUpdate` is an explicit allowlist of session columns that may
change without touching persisted chains
(`electron/src/main/session/storage.ts:62-74`). `updateSessionFields()` builds
an update from only the supplied fields, always updates `updated_at`, and
returns whether the expected session row existed
(`electron/src/main/session/storage.ts:452-503`).

`SessionManager.persistSessionFields()` uses this targeted operation and falls
back to the complete save only when the session row is missing
(`electron/src/main/session/manager.ts:138-150`). Rename, model, working
directory, reasoning-effort, permission, todo, subagent, and auto-name paths
route their affected fields through this mechanism
(`electron/src/main/session/manager.ts:198-217`,
`electron/src/main/session/manager.ts:333-443`,
`electron/src/main/session/manager.ts:740-785`,
`electron/src/main/session/manager.ts:814-837`).

### Make turn start one transaction

`appendActiveChain()` performs the complete start boundary in one SQLite
transaction:

1. Update the session's active pointer, todo snapshot, and recency.
2. Mark only the stale active-chain IDs supplied by the manager as interrupted.
3. Compute the next chain ordinal.
4. Insert the new active chain.

The transaction is implemented at
`electron/src/main/session/storage.ts:506-559`. The manager derives the stale
IDs while constructing its next immutable session snapshot, invokes the
transaction, uses a full save only if the owning session row is missing, and
publishes the in-memory replacement only after persistence succeeds
(`electron/src/main/session/manager.ts:493-558`).

### Make turn completion one transaction

`finishChain()` updates the addressed chain to its terminal snapshot, then
clears the session's active pointer and persists todos and recency in the same
transaction (`electron/src/main/session/storage.ts:562-590`).

`finishActiveChain()` constructs the next snapshot, invokes that operation,
falls back to complete replacement only when the expected chain row is missing,
and updates in-memory state only after persistence succeeds
(`electron/src/main/session/manager.ts:606-649`).

### Keep streaming checkpoints turn-local

Streaming checkpoints continue through `updateChain()`, which updates one
chain snapshot and the owning session's recency without touching siblings
(`electron/src/main/session/storage.ts:662-679`). The manager follows the same
ordering and recovery rule: persist first, use full replacement only for a
missing expected row, then publish the in-memory snapshot
(`electron/src/main/session/manager.ts:565-599`).

The resulting persistence shape is:

```text
Complete replacement (creation/recovery):
  UPSERT session
  DELETE all chains for session
  INSERT every chain snapshot

Targeted lifecycle (normal operation):
  start     -> update active pointer and metadata
               interrupt identified stale active chains
               insert one active chain
  stream    -> update one active chain and session recency
  finish    -> update one terminal chain
               clear active pointer and update metadata
  metadata  -> update only supplied session columns
```

## Why This Works

The transaction boundary now matches the domain event. A start cannot commit a
new active pointer without its chain insert and stale-chain transitions. A
finish cannot commit the terminal chain without also clearing the session's
active pointer. SQLite rolls back the whole transaction if any statement
throws.

The manager also delays replacing in-memory state until storage succeeds on
start, checkpoint, and finish paths
(`electron/src/main/session/manager.ts:547-558`,
`electron/src/main/session/manager.ts:594-599`,
`electron/src/main/session/manager.ts:639-649`). This prevents memory from
presenting a lifecycle transition that the database rejected.

Normal persistence work is bounded by explicitly changed records rather than
total historical chain count:

- Start inserts one chain and updates only stale chains that were actually
  active.
- Stream and finish update one chain.
- Metadata changes update no chain rows.

The complete-save fallback preserves recovery behavior. Targeted functions
return `false` when an expected session or chain row is absent, while database
exceptions still propagate
(`electron/src/main/session/storage.ts:452-503`,
`electron/src/main/session/storage.ts:506-590`,
`electron/src/main/session/storage.ts:662-679`). The manager treats only that
missing-row signal as permission to reconstruct the authoritative snapshot.

The regression tests establish preservation and rollback:

- A deletion-blocking trigger proves ordinary lifecycle and metadata updates do
  not delete historical chain rows. The test also verifies stable `rowid`,
  reloads the session, and checks both turns and updated metadata
  (`electron/tests/unit/session-persistence.test.ts:1690-1754`).
- A terminal-update trigger forces the finish transaction to fail. The test
  verifies the exception propagates and both in-memory and persisted state
  retain the same active chain, active status, and null end time
  (`electron/tests/unit/session-persistence.test.ts:1756-1800`).

## Prevention

Treat `saveSession()` as a creation and recovery primitive, not the normal
persistence API for an existing session. New lifecycle mutations should have a
storage operation whose SQL footprint matches the domain event: one chain
update, one chain insert, or a declared set of session columns.

Keep coupled state transitions inside one database transaction:

- A new active-chain pointer and its chain insert belong together.
- A terminal chain snapshot and clearing the active pointer belong together.
- A streaming checkpoint and the session recency update belong together.

Preserve the manager's "persist first, replace memory second" ordering. Moving
the in-memory update ahead of storage would weaken the failure guarantee even
if SQLite remained atomic.

Retain behavior-level failure-injection tests:

- Make historical deletion fail loudly so a reintroduced full replacement
  cannot pass unnoticed.
- Assert that unaffected historical row identities remain stable.
- Inject a terminal-write failure and verify both database rollback and
  in-memory state preservation.

Do not turn missing-row recovery into a catch-all for SQL failures. A missing
expected row is an explicit boolean recovery signal; exceptions must propagate
so callers can observe a rejected write.

## Related Issues

This documents review finding F5, "Full Synchronous Session Rewrites at Turn
Boundaries." No overlapping solution document or related GitHub issue was
found during the 2026-07-24 compound search.

The closest existing persistence pattern is the targeted `updateChain()`
checkpoint path. Its focused test verifies that updating an active response
does not alter the serialized messages of a completed sibling chain
(`electron/tests/unit/session-persistence.test.ts:1651-1683`).

Database corruption recovery is complementary rather than interchangeable.
Storage operations run through `withCorruptionRecovery()`, which disposes the
cached connection and retries once for corruption-class errors
(`electron/src/main/session/storage.ts:110-129`). Missing-row recovery instead
handles an expected persistence row disappearing while the in-memory session
still has an authoritative complete snapshot.
