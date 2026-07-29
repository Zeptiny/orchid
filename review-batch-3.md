# Code Review — Batch 3: Subagent Live/Durable Separation

**Date:** 2026-07-28
**Branch:** `perf/batch-3-subagent-live-durable` (10 commits, `37937fa..HEAD`)
**Scope:** 42 files, +5,398/−655 — delta-event protocol end-to-end, budgeted IPC batcher, renderer incremental application, row-per-record persistence with dirty-only checkpoints, admission control with queued state, worker-pool main-agent priority, terminal eviction.
**Reviewer team:** correctness, data-integrity, performance, adversarial, testing, api-contract, maintainability (+project-standards). Reliability reviewer failed on infrastructure before returning.
**Mode:** multi-agent review, report-only.

## Verdict

**Ready with fixes.** One P0 contract break (wire schemas reject the new `queued` status — proven mechanically by two reviewers) and two P1s around evicted-summary records clobbering durable data. All three have small, well-scoped fixes. The remaining findings are P2/P3 hardening.

## Triage Groups

| Group | Findings | Context | Preferred Resolution | Why |
|-------|----------|---------|---------------------|-----|
| Wire contract vs `queued` | #1, #6 | U7 added `queued` to the domain model but not the Zod wire enums | Add `'queued'` to both ipc-schemas enums (reuse `subagentStatusSchema`); add boundary tests | One change fixes snapshot throw + envelope drop; batch semantics finding informs whether to also go per-event validation |
| Evicted summaries vs durable truth | #2, #3, #10 | U9 keeps empty-chain summaries in `allRecords()`; snapshot merge + recovery flush both let summaries overwrite full stored rows | Mark summaries (`_evicted` flag); skip them in snapshot runtime list and in recovery flushes | Persist-first eviction only works if the summary never re-reads as authoritative |
| Soft size/telemtry bounds | #4, #7, #16 | Byte estimators and eligibility checks run per-event where per-session works | Memoize eligibility per session per flush; measure bytes in UTF-8; document/count chain payloads | Cheap fixes on the branch's own perf-critical path |
| Stale display state | #5 | Delta protocol freezes `record.status` between spawned/terminal; badges read records | Derive display state from live projection when present in `buildSubagentDetail` | Restores pre-delta badge behavior without touching record stability |

---

## P0 — Critical

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 1 | `electron/src/shared/types/ipc-schemas.ts:302` | Wire schemas reject `'queued'`: snapshot invoke throws, spawned-delta envelopes dropped at preload | correctness, api-contract, maintainability | 100 |

**#1** — U7 made `queued` a first-class `SubagentStatus` emitted on both IPC surfaces (`spawn()` delta, `createSubagentSnapshot`, live projections), but `subagentLiveProjectionSchema.state` and `subagentRecordSchema.status` still enumerate only `pending|running|completed|failed|interrupted`. Proven by repro: both schemas return `false` for queued payloads. Consequences: (a) any session with a queued subagent makes every `subagents.snapshot` invoke throw → hydration error panel until the queue drains; (b) preload `onParsed` drops the whole delta envelope containing a queued spawn — losing every co-batched delta for other subagents in that flush plus the queued run's live history.
**Fix:** add `'queued'` to both inline enums — better, derive both from `subagentStatusSchema` (`shared/types/subagent.ts`) so they can't drift again. Add wire-schema tests for a queued spawned envelope and a queued snapshot (record + live projection).

---

## P1 — High

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 2 | `electron/src/main/agents/persist-subagent-chains.ts:266` | Recovery flush overwrites durable terminal rows with empty-chain evicted summaries — triggered by ordinary `wait_for_subagent` | data-integrity, adversarial | 100 |
| 3 | `electron/src/main/ipc/subagents.ts:29` | Evicted summaries clobber stored full records in snapshots — usage totals drop after eviction, recover on restart | correctness, adversarial | 100 |

**#2** — Sequence: subagent completes → terminal wave persists the full row → `confirmRecordsPersisted` evicts to summary (`chain.messages = []`) → later `wait_for_subagent` calls `recoverSubagentPersistence` (wait.ts) → recovery flush bypasses the `persistRevision` tracker and re-serializes **every** runtime record including evicted summaries → `ON CONFLICT DO UPDATE` replaces full durable rows with empty chains. Silent, near-deterministic destruction of conversation history, and the recovery broadcast reseeds the renderer with the empty record too.
**Fix:** mark summaries at eviction (`record._evicted = true`) and skip flagged records even under `recovery: true` (their row was confirmed persisted — that is the eviction precondition), or make recovery upserts row-missing-conditional. Regression: persist → confirm → recovery flush → reload → `chain.messages` intact.

**#3** — `createSubagentSnapshot` merges stored rows then overwrites with runtime records; retained summaries (up to `terminal_retention`) stay in `allRecords()` with empty chains, so post-eviction snapshots serve empty-chain records. Renderer usage is derived from chain messages (`sumSubagentUsage`), so the footer `sub:` total and per-parent-chain attribution silently lose every evicted subagent's tokens after any re-hydrate — and jump back after an app restart when stored full rows win. Also churns `deriveSubagentUsageSummary` identity, invalidating the chat-history memo on every eviction wave — U5's own invariant.
**Fix:** exclude flagged summaries from the snapshot runtime list (stored row wins), or carry aggregate usage on the summary. Test: `markCompleted → confirmRecordsPersisted → createSubagentSnapshot` returns stored chain messages.

---

## P2 — Moderate

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 4 | `electron/src/main/ipc/subagents.ts:171` | Batcher checks window eligibility per event — up to 200 `BrowserWindow.getAllWindows()` per 16 ms flush instead of per session | performance | 75 |
| 5 | `electron/src/renderer/hooks/useSubagents.ts:101` | `buildSubagentDetail` reads frozen `record.status`; badges show `pending`/`queued` for actively running subagents (delta path), disagreeing with snapshot path | correctness, maintainability | 75 |
| 6 | `electron/src/shared/types/ipc-schemas.ts:370` | Envelope-level validation: one malformed delta drops the whole flush, including unrelated subagents' terminal handoffs (no retry path) | adversarial, api-contract | 75 |
| 7 | `electron/src/main/session/storage.ts:804` | Checkpoint `bytes` diagnostic counts UTF-16 code units (`json.length`), not bytes — R9 telemetry misleads on multibyte content | data-integrity | 100 |
| 8 | `electron/src/main/config/schema.ts:108` | `prompt_recent_terminal`/`prompt_task_max_chars` ship with schema, docs, parity tests, and zero consumers — U10 was descoped | maintainability | 100 |
| 9 | `electron/src/main/agents/manager.ts` | manager.ts grew 1,196→1,694 lines (+42%); admission control and eviction both bolted onto `SubagentManager` | maintainability | 100 |
| 10 | `electron/src/main/agents/manager.ts:127` | Config fallback defaults hardcoded in ≥4 places (`DEFAULT_ADMISSION_LIMITS`, catch fallbacks, `resolveSubagentDeltaBudgets`) duplicate schema defaults and will silently diverge | maintainability | 75 |

**#4** — Per-flush eligibility gate runs once per event rather than once per distinct session: up to ~200 native window enumerations + session-manager lookups per 16 ms flush. Fix: group by session first (the delivery loop already does), gate at that granularity.
**#5** — Fix: `state: live?.state ?? record.status` (and treat `queued` in `isRunning`) in `buildSubagentDetail`; add a hook-level test that a text delta after a pending spawn shows `running`.
**#6** — Fix: validate batch members individually at the preload boundary and deliver the valid subset, or trigger a reseed on drop; pin chosen semantics with a test.
**#7** — Fix: `Buffer.byteLength(json, 'utf8')` (or accumulate from bound statement). Diagnostics-only impact.
**#8** — U10 (prompt-context bounding) was explicitly descoped in favor of `docs/plans/2026-07-28-001-feat-subagent-close-and-follow-up-plan.md`. Either that plan consumes the knobs or they should be removed until it lands — shipping documented-but-dead config invites tuning with no effect.
**#9** — Extract admission control (~120 lines, own config + invariants) and the terminal-summary cache into modules the manager delegates to. Not blocking; schedule as follow-up.
**#10** — Replace hand-written fallbacks with `subagentsConfigSchema.parse({})` from the schema module (the doc comments already claim "schema defaults" — make it true).

---

## P3 — Low

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 11 | `electron/src/main/agents/manager.ts:921` | `_sessionRevisions` (and per-session `lastPersistedRevision` inner maps) never pruned on `purgeSession` — slow per-session leak | performance, data-integrity | 100 |
| 12 | `electron/src/main/agents/manager.ts:924` | `purgeSession`'s cancel loop can admit and start queued runners for the session being deleted | data-integrity | 75 |
| 13 | `electron/src/main/agents/wire-subagents.ts:100` | Late terminal deltas after deletion re-schedule persistence timers `clear()` was meant to prevent (ghost dirty sessions until drain) | data-integrity | 75 |
| 14 | `electron/src/main/agents/manager.ts:707` | `cancelAll`/`cancelRunning` with a full queue starts one doomed runner per queued record (admit-then-cancel cascade) | adversarial | 75 |
| 15 | `electron/src/main/agents/persist-subagent-chains.ts:265` | Records cancelled while queued are never persisted and never evicted — accumulate unboundedly in the manager | correctness, adversarial | 75 |
| 16 | `electron/src/shared/types/subagent.ts:229` | `estimateRecordBytes` ignores `record.chain` — the dominant payload of spawned/terminal deltas; byte budgets and hydration bound are soft undercounts | adversarial, maintainability | 75 |
| 17 | `electron/src/main/agents/manager.ts:1527` | `_finishLive` casts `state as SubagentTerminalState`; parameter should be typed terminal-only (call sites already comply) | maintainability | 75 |
| 18 | `electron/src/main/ipc/subagents.ts:103` | `resolveSubagentDeltaBudgets` uses lazy `require()` with eslint-disable, contradicting the proven top-level-import pattern documented in manager.ts | maintainability | 75 |
| 19 | `electron/src/main/agents/persist-subagent-chains.ts:288` | Terminal-state check inlined 3 places (`TERMINAL_STATES` already exists) | maintainability | 75 |
| 20 | `electron/src/main/utils/worker-pool.ts:517` | `undefined as unknown as WorkerTaskHandle` bootstrap — restructure promise/handle ordering to remove the double cast | maintainability | 75 |
| 21 | `electron/src/renderer/utils/subagent-stream.ts:124` | Queued/running/ended partitioning duplicated between stream util and Sidebar; duplicated JSX row maps in SubagentsSection | maintainability | 75 |
| 22 | `electron/src/main/ipc/subagents.ts:220` | Sibling exports name the same unit differently (`queueSubagentDelta` vs `flushSubagentEvents`) | maintainability | 75 |

---

## Pre-existing (not blocking)

- DB schema v1→v2 has **no data migration** from `subagent_chains_json` — the legacy column is abandoned in place with old data unread. **Intentional decision** (fresh-install assumption, confirmed by the user at planning time); noted because upgraded dev installs will show empty subagent history until new runs repopulate. Recommendation: drop the column in the first real future migration.
- Worker-pool circuit-open state is permanent for the app lifetime once respawn attempts exhaust (pre-existing; reliability territory).

## Suppressed / deferred to coverage

- **`recoveryPending` delete race in nested storage-corruption recovery** (adversarial, confidence 50, needs verification): a corruption rebuild nested inside an in-flight flush can have its `recoveryPending` flag erased by the outer flush's unconditional delete, leaving the rebuilt DB without the recovery rewrite. Plausible; requires a targeted reentrancy test to confirm reachability before fixing.
- Hydration reseed hook trigger untested (testing, conf 50) — moved to testing gaps.

## Testing Gaps (highest value first)

1. Wire-schema tests for queued payloads (spawned envelope + snapshot) — would have caught #1 pre-merge.
2. Recovery-flush-after-eviction preserves the durable row — regression for #2.
3. Snapshot continuity for *retained* summaries (not just fully removed) — regression for #3.
4. Worker-pool scope tagging wiring in `executeToolCall` (`runTask` mock asserts `scope`) — inverting it silently reintroduces F-06 starvation.
5. `createSubagentSnapshot().sessionRevision` equals the manager's counter after emitted deltas — the reseed floor's input is currently unasserted.
6. `mainAgentReserved` clamp `[0, size-1]` (config allows 0–8; size-2 pool + reserved 8 starves subagents if clamp removed).
7. Per-session-cap skip branch in round-robin admission (global 2 / per-session 1 alternation).
8. Session-purge assertion should pin the exact terminal-delta id set + all runners aborted, not `>= 3` (currently masks mid-purge admission).
9. No v1→v2 upgrade test (accepted risk, but pin the behavior).
10. Envelope-drop semantics test once #6's behavior is chosen.

## Residual Risks

- `useSubagents` below-floor snapshot re-request has no backoff/cap; safe within one process (monotonic manager revision) but a future counter reset becomes an unbounded hydrate loop.
- `sessionRevision` is non-decreasing but not strictly monotonic across runs at the spawn boundary (seed emitted before first bump) — tolerated by the floor logic.
- Unscoped records (`sessionId: null`) attribute to `getActive()` at checkpoint time — can persist under different sessions across flushes (inherited pattern, now keyed per session).
- Terminal deltas are budget-exempt and carry full chains; a mass-completion wave can exceed envelope byte budgets by design (bounded by tool-output offload).
- Renderer hydration dedup rebuilds a Set per incoming batch (O(buffer × batches) in the loading window; bounded by the 256 KB cap).
- Legacy `subagent_chains_json` remains typed on `SessionRow` with no reader — invites a future "helpful" read path resurrecting dead data.

---

*Run artifacts: `/tmp/code-review/batch3-20260728-132256/` (input diff + file list). Reviewers: correctness, data-integrity, performance, adversarial, testing, api-contract, maintainability; reliability reviewer lost to infrastructure error.*
