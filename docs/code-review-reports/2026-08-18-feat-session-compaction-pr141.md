# Code Review Results — feat/session-compaction (PR #141)

**Scope:** merge-base `536602a` with main -> HEAD `848ac46` (72 files, +10,608 / −76)
**Intent:** Automatic context-window compaction for sessions and subagent runs: token-threshold trigger (provider usage + calibrated estimate) with hysteresis, mechanical reclaim (duplicate tool-output dedupe), internal compactor agents (simple + validated selective manifest modes), mid-turn apply for main sessions (pause tool loop, resume) and subagent runs (step boundaries, partial-report degradation), crash-atomic persistence via `compacted` summary-head marker + `excludeFromModel` flags, `summary_tokens` analytics + ContextGrid segment + CompactionWidget, CompactionTab config with project overrides, SQLite migration adding `summary_tokens` to `context_snapshots`.
**Mode:** interactive (initially report-only; P0/P1 remediation applied same day — see Remediation Status)
**Plan:** `docs/plans/2026-08-17-001-feat-session-compaction-plan.md` (plan_source: inferred)

**Reviewers:** correctness, testing, maintainability, project-standards, agent-native, learnings-researcher (always-on)
- security — compactor LLM output (untrusted data) validated and injected into replay history; IPC payload changes
- performance — per-usage-event token estimation, history scans, synchronous SQLite writes on the streaming path
- api-contract — ipc.ts / ipc-schemas.ts / payload-schemas.ts / preload surface / shared type changes
- data-integrity (data-migration) — `ALTER TABLE context_snapshots ADD COLUMN summary_tokens` + persistence atomicity
- reliability — mid-turn pause/resume, abort paths, debounced-checkpoint races, cancel interleavings
- adversarial — ≥50 changed lines (10.6k)
- previous-comments — PR #141 has 3 prior Coderabbit review rounds (33 inline comments)

Validation: 17 P0/P1 findings independently re-verified by per-finding validators — 16 confirmed, 1 dropped, 1 severity corrected.

### Remediation Status (2026-08-18)

All 15 P0/P1 findings are **FIXED** (#1–#15), plus P2 #30 (subsumed by the durable-persistence redesign) and P2 #34 (fixed together with #3's `priorMessageCount` anchoring). En-route fix: the subagent post-compaction estimate now skips `excludeFromModel` messages (was a residual risk).

- Durable persistence: new storage-level `applyCompactionPersistence` transaction (full durable `messages_json` reads, targeted chain updates + summary-head insert, `subagent_chains` untouched); both persist paths rewired; legacy fallback deleted.
- Turn bookkeeping: `priorMessageCount` anchored at the turn's user message across mid-turn resume, unapplied-resume, and overflow-retry.
- Apply semantics: inner pre-flagged messages tolerated (fatal only for a deeper-than-start summary head); active-chain split keeps the original id on the preserved half.
- Selective integrity: replay re-anchored at apply time (`reanchorSelectiveReplay`); subagent selective mode preserves originals via `buildSelectiveSubagentApply`; R9 user-message protection now universal in selective mode; chain ids unified to `randomUUID()`.
- IPC: `chat:error` kind enum derives from `ChatErrorKind` with a compile-time exhaustiveness guard.
- Dead code: test-only persistence API removed from apply.ts; dead XState step-boundary channel reverted.
- Structure: `ipc/chat/compaction.ts` (engine) + `llm/compaction/run-attempt.ts` (shared selective runner) extracted; send.ts 1890 -> 868 lines.
- Tests added: 14 subagent-orchestration, overflow-retry + 23 classifier cases, 22 stream-building + 11 widget, 11 real-DB persistence, plus parity/supersession tests.

Verification after remediation: typecheck clean; lint 38 -> 25 errors (0 new); 4267/4268 tests (single failure is `subagent-view.test.ts`, pre-existing at HEAD, unrelated). All other findings (P2 #16–#29, #31–#33, #35–#39; P3 #40–#50) remain OPEN.

---

### Triage Groups

| Group | Findings | Context | Preferred Resolution | Why |
|-------|----------|---------|----------------------|-----|
| Durable persistence rewritten from bounded views | #1, #2, #30 | Compaction saves source the session from the 240-msg/2MB navigation view, then `saveSession` delete-all-reinserts every chain and every subagent_chains row | Add a targeted compaction write transaction (UPDATE flag-changed chains + INSERT summary head); never source from the view; guard partial loads | One transaction redesign fixes truncation, the subagent wipe, and the flag/chain mismatch together |
| Mid-turn apply corrupts turn bookkeeping | #3, #33, #34, #35 | The pause/apply/resume path rebases counters incompletely and lacks liveness guards | One resume routine: rebase `priorMessageCount` at the turn's user message, clear `streamSegments`, staleness-check after every await, cancel the debounced checkpoint before persist | Four distinct data-loss/wedge bugs share one root: apply-time agent state is reset by hand at three call sites |
| `excludeFromModel` semantics conflated | #4, #42, #50 | Reclaim flags, cancelled tool results, and compaction flags all share one bit; apply treats inner flags as fatal, renderer labels them all "compacted" | Distinguish reclaim-flagged from compacted; treat pre-flagged range members as pre-excluded, not fatal | Removes the compaction-forever-disabled failure and the renderer mislabeling with one semantic split |
| Selective-mode replay integrity | #5, #7, #8 | Selective path materializes replay at prepare time and diverges from main-path invariants (chain ids, flag preservation) | Re-materialize at apply time over current history; keep original chain id on the preserved half; flag (never delete) originals | One fix path restores R3/R4 compliance and the dropped-user-message bug |
| Untested critical paths | #13, #14, #15, #29, #31, #38, #39 | Subagent orchestration, overflow retry, renderer projection, production persistence, and the migration have zero coverage | Prioritize: subagent arm/apply/degrade, overflow-retry classifier+retry, real-DB round-trip, stream-building projection | The highest-severity bugs all live in exactly the untested paths |
| Structural debt in the engine | #9, #10, #11, #12, #16–#21, #23–#25 | ~970 lines of orchestration inlined into send.ts, 3 diverged orchestration copies, dead exports and dead XState channel | Extract `ipc/chat/compaction.ts` + shared `runCompactionAttempt`; delete dead code first (mechanical), then extract | Dead code is trivially removable now and blocks the extraction refactor if left |

### P0 — Critical

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 1 | `electron/src/main/ipc/chat/persist.ts:265` | **[FIXED]** Compaction save rewrites sessions.db from the bounded navigation view — durable history truncated | data-migration | 100 |
| 2 | `electron/src/main/ipc/chat/persist.ts:276` | **[FIXED]** Same saveSession wipes all durable subagent_chains rows for the session | data-migration | 100 |

- **#1** — `persistCompactionBetweenTurns` (and `persistSelectiveCompaction` in send.ts:340) builds the next session from `getSession()/load()`, which resolve through `loadSessionView` (240-msg/2MB budgets, partial chains), then calls `saveSession` — delete-all-then-reinsert. Compaction targets exactly the sessions that exceed the view budget, so the pre-window transcript is permanently truncated on the first compaction after a restart. The codebase's own `saveFullSessionFallback` guard exists for this hazard and is bypassed. Validator-confirmed end to end.
- **#2** — The view load never populates `subagentChains` (stays `[]`); `saveSession` does `DELETE FROM subagent_chains WHERE session_id = ?` then reinserts the (empty) array. Any session whose subagent rows predate the current process loses all subagent transcripts on first compaction. Realistic scenario confirmed: subagent history -> app restart -> next message -> compaction -> rows gone.

### P1 — High

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 3 | `electron/src/main/ipc/chat/send.ts:1602` | **[FIXED]** Mid-turn resume rebases priorMessageCount — durable active chain overwritten with post-resume messages only | correctness, adversarial, data-migration | 100 |
| 4 | `electron/src/main/llm/compaction/apply.ts:174` | **[FIXED]** Inner excludeFromModel in range throws CompactionApplyError — compaction permanently disabled | correctness | 75 |
| 5 | `electron/src/main/ipc/chat/send.ts:401` | **[FIXED]** Selective pending installs prepare-time replay — new user message never reaches the model | correctness | 75 |
| 6 | `electron/src/shared/types/ipc-schemas.ts:182` | **[FIXED]** chat:error kind enum missing context_length_exceeded — preload drops terminal error events | api-contract | 100 |
| 7 | `electron/src/main/llm/compaction/apply.ts:347` | **[FIXED]** Active-chain split keeps id on prefix half — activeChainId never repointed, replay order inverts | adversarial | 75 |
| 8 | `electron/src/main/agents/subagent-runner.ts:290` | **[FIXED]** Subagent selective compaction hard-replaces chain with replay — originals deleted (R3 violation) | adversarial, previous-comments | 75 |
| 9 | `electron/src/main/agents/xstate/agent-machine.ts:554` | **[FIXED]** Dead XState step-boundary channel — zero consumers in src or tests | maintainability, testing | 100 |
| 10 | `electron/src/main/llm/compaction/apply.ts:441` | **[FIXED]** Test-only persistence API whose deprecated alias collides with production persistCompactionBetweenTurns | maintainability | 100 |
| 11 | `electron/src/main/agents/subagent-runner.ts:1362` | **[FIXED]** Selective orchestration copy-pasted 3x and already behaviorally diverged | maintainability, previous-comments | 100 |
| 12 | `electron/src/main/ipc/chat/send.ts:94` | **[FIXED]** send.ts triples 608 to 1788 lines — entire engine inlined into chat-turn module | maintainability | 100 |
| 13 | `electron/src/main/agents/manager.ts:1509` | **[FIXED]** Subagent compaction orchestration (U9/R16/R17) has zero test coverage | testing | 75 |
| 14 | `electron/src/main/ipc/chat/send.ts:1683` | **[FIXED]** context_length_exceeded compaction-retry and classifier untested (R15) | testing | 75 |
| 15 | `electron/src/renderer/utils/stream-building.ts:58` | **[FIXED]** Renderer compaction projection and key-format change untested | testing | 75 |

- **#3** — After mid-turn apply, `priorMessageCount` is rebased to the full replay length; finalize's `turnMessagesFromAgent` then yields only post-resume content and `persistTurn` REPLACES the durable active chain with it — the user message and pre-pause tool calls/results are deleted from storage. Three independent reviewers + validator traced the full chain (send.ts:1602 -> persist.ts:112 -> manager.ts:788-959). Same defect family at the unapplied-resume path (~1655) and overflow retry (#34).
- **#4** — `selectCut` skips only a contiguous flagged prefix; inner flagged messages (cancelled tool results flagged at creation, prior reclaim flags) stay in range, and the summary path throws. The throw (or, mid-turn, the `isPendingCutStillValid` rejection) is swallowed without arming hysteresis, so the summarizer LLM call re-fires and fails forever. Default `simple` mode hits the sync throw path.
- **#5** — `replayMessages` is materialized at prepare time; both consumption sites splice it wholesale. Between-turns: `startChatTurn` appends the user message, then replaces the array with the stale replay — the model literally never sees the message being sent (validator-confirmed: `createProviderStreamFn` freezes that array). Mid-turn: post-prepare in-turn messages vanish. The simple path re-anchors at apply time; selective is the outlier.
- **#6** — `classifyErrorKind` emits the new kind and send.ts sends it on CHAT_ERROR, but `chatErrorEventSchema.kind` still allows only `['stream','rate-limit','auth','generic']` — the preload safeParse-fails and silently drops the terminal typed error event. (A raw `chat:state` error string still arrives, so this loses the structured event, not all signal.)
- **#7** — When the cut splits the active chain, the flagged prefix keeps the original id and the preserved half gets a new UUID; nothing repoints `activeChainId`. Resumed checkpoints and finalize write the newest turn content into the prefix chain; on reload (`ORDER BY ordinal`) newest content replays before the summary head and preserved window — order inversion. Reachable via the shipped mid-turn path.
- **#8** — Subagent selective-success branch replaces the single chain's messages with `replayMessages` (originals appear only in `flaggedIds`, not the replay) and persists the replacement into `subagent_chains` with no snapshot — violating plan R3 ("never deletes the original transcript") and diverging from `buildCompactionApply` and the main-session selective path, which flag originals. Opt-in mode (not default), but data loss when used.
- **#9** — `onStepBoundary` hook, `STEP_FINISH` handlers, `lastStepBoundary` context, `getLastStepBoundary` accessor: zero consumers anywhere (manager consumes raw `step_finish` StreamEvents directly). All new in this diff. Revert.
- **#10** — apply.ts exports `persistCompactionThroughWriter` plus a `@deprecated kept for backward compat with tests` alias named identically to the real production function in persist.ts:257. The unit tests exercise the test-only stub, so the production persistence path (where P0 #1/#2 live) is untested. Plus zero-usage exports (`hasReclaimableFlags`, `assertCompactableRangeNotFlagged`) and test-only `buildReclaimOnlyApply`/`buildMidTurnCheckpoint`/`MidTurnPersistInput`.
- **#11** — Three near-copies of selective orchestration (subagent-runner.ts:215-350, send.ts:663-784, send.ts:950-1014 + consumption twin at 391-462). Diverged: user-message un-flagging exists only in the subagent copy; chain-id schemes differ (`selective-${Date.now()}` vs `randomUUID()`); the apply->persist->postTokens->onCompactionApplied sequence repeats ~10x in send.ts. Prior review comment item 14 asked for extraction; duplication has since grown.
- **#12** — 608 -> 1788 lines; ~970 lines of compaction engine (state maps, calibration, prepare/apply, selective persistence, widget completion) sit inline ahead of `startChatTurn`. Domain logic is properly in `llm/compaction/*`; only the orchestration glue is misplaced. Extraction to `ipc/chat/compaction.ts` is cycle-free (validator-verified no sibling imports send.ts).
- **#13** — `ensureCompactionInit`, `maybeStartCompactionPrepare`, `maybeApplyCompactionAtBoundary`, `tryCompactSubagentHistory`, `buildSubagentPartialReport`, `resolveSubagentContextTokens`: zero references across `electron/tests` (validator-verified). The subagent arm->apply->degrade flow — the riskiest state machine in the diff — is unverified.
- **#14** — `isContextLengthExceededError` (error-classification.ts:73-106) and the reactive retry branch (send.ts:1683-1749) have zero test coverage; the classifier's substring heuristics are also unguarded against false positives.
- **#15** — stream-building.ts gained `compacted-stub`/`compaction-summary` kinds, `compactedBuffer` expand logic, cross-chain `seenCompactedIds` dedupe, exact-id suppression — and changed the React key format for ALL items — while the 550-line `stream-building.test.ts` is untouched and compaction-free (validator-verified). No CompactionWidget test exists.

### P2 — Moderate

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 16 | `electron/src/main/agents/manager.ts:1416` | +291 lines of closure-based compaction inside _startRun (file now 2010 lines) | maintainability | 100 |
| 17 | `electron/src/main/agents/manager.ts:1426` | Type holes: any-typed config cache, as-unknown-as into own private members | maintainability, project-standards | 100 |
| 18 | `electron/src/main/agents/manager.ts:1495` | tokens-per-char clamp duplicated 9x across 4 files; canonical helper never called | maintainability | 100 |
| 19 | `electron/src/main/agents/manager.ts:1733` | State classified by content-sniffing ('[Subagent partial report' substring, /reclaim/i regex) | maintainability | 100 |
| 20 | `electron/src/main/ipc/chat/persist.ts:321` | Dead exports: unwired R22 checkpoint helpers with latent double-slice bug | maintainability, data-migration, previous-comments | 100 |
| 21 | `electron/src/main/ipc/chat/send.ts:708` | estimateMessageChars copy-pasted inline twice beside its own import | maintainability | 100 |
| 22 | `electron/src/main/ipc/chat/send.ts:1705` | Overflow-retry resets offsets but not streamSegments — duplicate ids, leaked text into snapshots | reliability | 100 |
| 23 | `electron/src/main/llm/compaction/select.ts:45` | Five overlapping preserve-budget knobs incl. a documented 'alias for tests' | maintainability | 100 |
| 24 | `electron/src/main/llm/context-snapshot.ts:51` | Compacted-marker predicate implemented 4x incl. beside the canonical parser | maintainability | 100 |
| 25 | `electron/src/main/config/schema.ts:107` | Unconfigurable knobs: agent_name literal-vs-string drift at 3 boundaries, keep_recent_chains born deprecated | maintainability, project-standards, api-contract | 100 |
| 26 | `electron/src/main/agents/manager.ts:1563` | Subagent mid-run compaction never affects the in-flight stream (R16 unmet for the live run) | correctness | 75 |
| 27 | `electron/src/main/agents/manager.ts:1566` | ~10 silent catch{} swallows across the subagent compaction path | project-standards | 75 |
| 28 | `electron/src/main/agents/manager.ts:1705` | Subagent compaction runs full pipeline (stringify + select + SHA-256) on every usage event — no threshold gate | performance | 75 |
| 29 | `electron/src/main/ipc/chat/send.ts:258` | persistSelectiveCompaction never exercised by any test | testing | 75 |
| 30 | `electron/src/main/ipc/chat/send.ts:637` | **[FIXED]** Flags computed against truncated view chains — persisted compaction mismatches the cut | data-migration | 75 |
| 31 | `electron/src/main/ipc/chat/send.ts:930` | Reclaim-short-circuit mid-turn wiring untested | testing | 75 |
| 32 | `electron/src/main/ipc/chat/send.ts:1020` | In-flight compactor LLM request not tied to turn abort signal | performance | 75 |
| 33 | `electron/src/main/ipc/chat/send.ts:1612` | Resume continuation lacks staleness guard — Esc during apply window resurrects cancelled state | reliability | 75 |
| 34 | `electron/src/main/ipc/chat/send.ts:1703` | **[FIXED]** Overflow-retry leaves priorMessageCount stale — finalize duplicates/drops in-turn messages | correctness | 75 |
| 35 | `electron/src/main/ipc/chat/send.ts:1725` | Overflow-retry IIFE persists FAILED chain and emits CHAT_ERROR after user cancel | reliability | 75 |
| 36 | `electron/src/main/project/trust.ts:434` | compaction.model project override (full transcripts) hidden from trust report | security | 75 |
| 37 | `electron/src/renderer/components/ChatStream.tsx:436` | Fake 'compaction' tool-call channel — JSON-stringified state re-parsed by toolName match | maintainability | 75 |
| 38 | `electron/tests/unit/compaction-apply.test.ts:204` | Crash-atomicity (R22) tests vacuous — they test dead helpers, not the shipped path | testing | 75 |
| 39 | `electron/src/main/providers/accounting/schema.ts:150` | summary_tokens guarded-ALTER migration and latestMainInputTokens untested | testing | 75 |

- **#16** — Ten captured mutable locals inside `_startRun`; extract a `SubagentCompactionCoordinator` with `onUsage`/`onStepBoundary`.
- **#17** — `any` config cache, `(this as unknown as {_persistence})._persistence` inside the owning class (direct call typechecks), assembler-internals cast. Any rename silently disables subagent compaction persistence.
- **#18** — Canonical `computeTokensPerChar` (trigger.ts:68) exported but never called; inline re-derivations everywhere, plus repeated `try{getConfig()}catch{return 0.85}` IIFEs.
- **#19** — A copy edit to `buildSubagentPartialReport` silently breaks graceful run completion; the renderer classifies reclaim-only summaries via `/reclaim/i` + length heuristics. Carry flags on the record/marker instead.
- **#20** — `checkpointCompactionMidTurn`/`flushCompactionCheckpoint`/`buildMidTurnCheckpoint` have zero production callers; the dead `checkpointCompactionMidTurn` still double-slices its already-windowed payload (latent transcript loss if ever wired). Wire-or-delete.
- **#21** — `calibratedEstimator`/`calibratedEstimator2` duplicate the imported `estimateMessageChars`.
- **#22** — Both pause paths reset `streamSegments` (send.ts:1604, 1657); the overflow-retry reset block (1703-1711) omits it — segment identity is offset-derived, so post-retry chunks merge into pre-retry segments and snapshots rehydrate abandoned text concatenated with the new response.
- **#23** — Production callers use only `preserveTokens`/`tokenEstimator`/`chainBoundaries`; the rest is test surface with mismatched docs.
- **#24** — Export `hasCompactedMarker` from shared/types/message.ts; delete three private reimplementations.
- **#25** — Zod enforces a single `agent_name` literal per scope; the shared boundary type says `string`; the selective caller hardcodes the agent — dead config that admits values the boundary rejects, on three surfaces. `keep_recent_chains` shipped already-deprecated.
- **#26** — The runner holds a frozen history snapshot for the whole multi-step stream (one `streamText`); boundary apply mutates only the persisted chain. A run that crosses its window still dies mid-run; no subagent-side overflow retry exists (validator confirmed; P2 because the outcome matches pre-diff behavior — unmet R16 intent, not a regression).
- **#27** — Silent catches contradict the repo's "non-fatal errors logged" rule; the branch's own solutions doc documents how undiagnosable this makes compaction failures.
- **#28** — Full-history `JSON.stringify` (~4 passes) + `selectCut` + SHA-256 reclaim hashing run per usage event below threshold too; the main path has the numeric gate (send.ts:883-891) — the subagent path doesn't.
- **#29** — Chain-splicing insertion positions (before preserved chain / spanning / end) untested; `saveSession` mocked in all compaction IPC tests.
- **#30** — `applyResult.updatedChains` derives from the same truncated view as #1; persisted flags under-represent what the summary covers.
- **#31** — Duplicate-large-tool-results + over-threshold usage -> summarize NOT called -> loop pauses -> widget completes: no test.
- **#32** — Cancel/session-switch leaves a full-range summarize call running and `pendingPrepare` armed; `summarize.ts` already honors `abortSignal` — it is never given one.
- **#33** — The mirror guard exists at send.ts:1646 in the same IIFE but is missing after the apply await: Esc during the summarizer wait leads to a stopped actor `actor.send`, session activity flipped back to a permanent "working - Resuming after compaction" state, and stray post-cancel tool events.
- **#34** — After splicing retry `updatedMessages`, `priorMessageCount` is not recomputed — persistTurn's slice boundary mismatches the compacted base+user layout (same family as #3).
- **#35** — Interleaving: overflow -> IIFE awaits summarizer (up to 300s) -> user double-Esc persists INTERRUPTED + disposes -> summarizer fails -> IIFE overwrites chain to FAILED, republishes needs_attention, emits CHAT_ERROR for an already-cancelled turn.
- **#36** — A cloned repo's `.orchid.json` `compaction.model` routes the compactor (entire-transcript prompt) to a different user-configured connection; `diffModelOverrides` doesn't parse the `compaction` key, so the trust dialog shows only a truncated 200-char blob with attacker-controlled key order.
- **#37** — Structured progress state is JSON-stringified into synthetic tool args; the renderer intercepts by literal toolName `'compaction'` and parses. A rename on either side silently disables the widget; the widget also doesn't survive snapshot replay.
- **#38** — The R22 tests assert helpers no production code calls; no test covers atomicWriter failure, saveSession throw preserving old history, or a reload round-trip.
- **#39** — Legacy-DB ALTER branch (the migration path real users hit) has no test; only fresh CREATE is covered.

### P3 — Low

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 40 | `electron/src/main/ipc/config.ts:181` | Redundant allowlist conditions (rag/compaction already in set) | maintainability | 100 |
| 41 | `electron/src/main/agents/manager.ts:1472` | Dead shouldDelegate* computations silenced with void | previous-comments, project-standards | 100 |
| 42 | `electron/src/main/ipc/chat/send.ts:622` | mechanical_reclaim=false ignored — main scope always runs reclaim | correctness | 100 |
| 43 | `electron/src/main/ipc/chat/send.ts:912` | Unreachable 0.25 tokens-per-char fallback contradicts adjacent no-heuristic rule | maintainability | 100 |
| 44 | `electron/src/main/llm/compaction/trigger.ts:30` | CompactableRange interface defined identically in three files | maintainability | 100 |
| 45 | `AGENTS.md:583` | Governing doc not updated for the compaction surface | project-standards | 75 |
| 46 | `electron/src/main/agents/xstate/agent-machine.ts:464` | abort() side effect inside XState v5 assign updater (CANCEL) | previous-comments | 75 |
| 47 | `electron/src/main/llm/compaction/message-chars.ts:7` | One evaluation re-serializes the same messages 4-6x | performance | 75 |
| 48 | `electron/src/main/llm/compaction/selective/run.ts:34` | Manifest previews unescaped inside XML tags — injection control present on simple path only | security | 75 |
| 49 | `electron/src/main/ipc/chat/send.ts:859` | dedupeHistoryById + totalChars computed before the numeric threshold gate | performance | 75 |
| 50 | `electron/src/renderer/utils/stream-building.ts:507` | Every excludeFromModel message folded into 'Compacted' stub — cancelled results mislabeled | correctness | 75 |

- **#42** — Gate both call sites (send.ts:622, 916) on `cfg.mechanical_reclaim`, mirroring the subagent-runner guard.
- **#45** — Config table, `llm/` directory listing, new event channel and error kind absent from AGENTS.md.
- **#46** — Emit a plain action before the assign; XState v5 assign updaters must be pure.
- **#48** — Tool-output previews can open with `</manifest>` to steer summarize ops; `escapeXml` already exists and is used on the simple path (summarize.ts:340).
- **#50** — Only buffer into the stub within a marker's `rangeStart/rangeEnd`; other flagged messages keep their previous presentation.

### Actionable Findings

All 15 P0/P1 actionable findings below were fixed on 2026-08-18 (see Remediation Status). The table preserves the original routes for reference.

| # | File | Issue | Route | Notes |
|---|------|-------|-------|-------|
| 1 | `persist.ts:265` | Compaction save truncates durable history | `manual -> downstream-resolver` | Targeted-write redesign; suggested fix present |
| 2 | `persist.ts:276` | Compaction save wipes subagent_chains | `manual -> downstream-resolver` | Rides #1's redesign; hydrate-or-refuse guard |
| 3 | `send.ts:1602` | Mid-turn resume corrupts durable active chain | `manual -> downstream-resolver` | needs targeted tests |
| 4 | `apply.ts:174` | Inner flags permanently disable compaction | `manual -> downstream-resolver` | skip/clamp pre-flagged instead of fatal |
| 5 | `send.ts:401` | Selective stale replay drops user message | `manual -> downstream-resolver` | re-materialize at apply time |
| 6 | `ipc-schemas.ts:182` | chat:error enum missing new kind | `gated_auto -> downstream-resolver` | one-line enum extension + parity test |
| 7 | `apply.ts:347` | Active-chain split leaves activeChainId stale | `manual -> downstream-resolver` | needs targeted tests |
| 8 | `subagent-runner.ts:290` | Subagent selective deletes originals (R3) | `manual -> downstream-resolver` | mirror main-path flagging |
| 9 | `agent-machine.ts:554` | Dead step-boundary channel | `gated_auto -> downstream-resolver` | revert, mechanical |
| 10 | `apply.ts:441` | Test-only persistence API + colliding alias | `gated_auto -> downstream-resolver` | delete + port tests to production fn |
| 11 | `subagent-runner.ts:1362` | 3x diverged orchestration copies | `manual -> downstream-resolver` | extract runCompactionAttempt |
| 12 | `send.ts:94` | send.ts triples; engine inlined | `manual -> downstream-resolver` | extract ipc/chat/compaction.ts |
| 13 | `manager.ts:1509` | Subagent compaction zero coverage | `manual -> downstream-resolver` | test plan in artifact |
| 14 | `send.ts:1683` | Overflow-retry untested | `manual -> downstream-resolver` | classifier + single-retry assertions |
| 15 | `stream-building.ts:58` | Renderer projection untested | `manual -> downstream-resolver` | stub/expand, dedupe, keys |

Remaining actionable P2/P3 (gated_auto/manual -> downstream-resolver): #16-#29, #31-#33, #35-#44, #46-#49 — see run artifacts for suggested fixes. Also fixed during remediation: #30 (durable redesign) and #34 (priorMessageCount anchoring). Advisory/report-only: #45 (doc), #50 (human judgment on renderer semantics).

### Requirements Completeness

Plan: `docs/plans/2026-08-17-001-feat-session-compaction-plan.md` (plan_source: inferred)

| Requirement | Status | Evidence |
|---|---|---|
| R1 stay within window | Partial | Main path works (post-remediation: #3/#4/#5 fixed); subagent in-flight stream still unaffected (#26, open) |
| R2 transparent + visible | Met | Widget, ContextGrid segment, config tab |
| R3 never delete transcript | Met (post-remediation) | #1, #2, #8 fixed — targeted durable writes; subagent selective flags originals |
| R4 full history viewable | Partial | #1 fixed (no durable truncation); #50 (renderer mislabels cancelled results) still open |
| R5 no dangling tool blocks | Met | `adjustCutToSafeBoundary` verified |
| R6 preserve window protected | Met | Budget walk + trailing-group floor verified |
| R7-R9 modes | Met (post-remediation) | Selective integrity restored: #5, #8, #11 fixed; R9 user-protection now universal in selective mode |
| R10 independent scope config | Partial | `agent_name` dead knob (#25) |
| R11 trigger + calibrated estimate | Met | Calibration hydration verified; estimate counts flagged msgs (premise of dropped finding) |
| R12 parallel prepare, boundary apply | Met | Mid-turn pause/resume implemented |
| R13 hysteresis | Met | Re-arm line logic verified |
| R14 min_compactable floor | Met | Floor enforced |
| R15 reactive overflow retry | Partial | #6, #14 fixed (enum + retry tested); still main-session only (subagent-side retry absent, see #26) |
| R16 subagent mid-run compaction | Not met (live run) | #26 — persisted chain compacts, in-flight stream doesn't |
| R17 partial-report degradation | Met + tested | Implemented; #13 fixed (14 orchestration tests) |
| R18 subagent cost attribution | Met | Record-scoped upserts verified clean |
| R19 summary_tokens category | Met | Migration + ContextGrid segment |
| R20 compaction chains with usage | Met | Isolated COMPLETED chain per compaction |
| R21 collapsed stub display | Met + tested | #15 fixed (stream-building + widget tests) |
| R22 crash-atomic write | Met (core path) | #1/#2 fixed (single targeted durable transaction, real-DB tests incl. failure rollback); #20/#38 (dead helpers, vacuous tests) still open as cleanup |
| R23 compacted marker | Met | Server-side only; marker forging verified impossible |
| R24 thinking artifacts | Met (no finding) | No violation found |
| R25 mechanical reclaim | Partial | Config gate ignored in main scope (#42) |
| R26 window-fit warning at config time | Not met | Computed then dropped to console.warn (see Agent-Native Gaps) |

Implementation units U1-U15: all present in the diff; U9 (subagent integration) carried the largest defect density — #8 and #13 are fixed; #17, #26-#28 remain open (P2).

### Pre-existing Issues

| # | File | Issue | Reviewer |
|---|------|-------|----------|
| 1 | `electron/src/main/providers/accounting/analytics-queries.ts:1045` | Analytics read model has no agent/tool access — spend not agent-observable (pre-dates diff) | agent-native |

### Learnings & Past Solutions

- [Violated] `docs/solutions/performance-issues/incremental-sqlite-session-lifecycle-writes.md` — the doc's rule: `saveSession` is a creation/recovery primitive only; new mutations need SQL footprint matching the domain event. The diff adds two full-replacement sites (persist.ts:276, send.ts:340) — now P0 #1/#2. Ordering (persist-first) is followed; footprint is not.
- [Followed] `docs/solutions/design-flaws/compaction-null-window-chars4-and-chain-preserve.md` (in-branch) — null-window disable, calibrate-or-skip, preserve budget all verified complete in final code.
- [Followed] `docs/solutions/logic-errors/mid-turn-compaction-apply-dedupe-mismatch.md` (in-branch) — dedupe-before-validate and resume-from-accumulated-turn verified complete.
- [Followed] `docs/solutions/logic-errors/subagent-resume-lifecycle-races.md` — `_runPromise`/eviction invariants respected; new gap: `lastCompactionRevision` is in-memory only, not serialized for crash recovery.
- [N/A] trusted-projects fail-closed gating (compaction config rides already-gated ProjectRuntime), MCP CancelledError doc.
- CONCEPTS.md lacks ~12 compaction terms (compactable range, preserve budget, summary head, reclaim, re-arm line, calibration) and conflates `excludeFromModel` vs `hidden` vs "flagged".

### Agent-Native Gaps

- Agent-edited compaction config silently never takes effect — `ProjectRuntimeRegistry` caches config; file edits (the agent's only write path) have no watcher/reset (P2, runtime.ts:77).
- Compacted-away history is user-expandable but agent-unreadable — no recall primitive (P2, history.ts:161).
- Compaction vocabulary/config locations absent from the system prompt (P3, system-prompt.ts:136).
- Mid-run compaction rewrites the agent's replay with no in-band signal — summary arrives as unattributed assistant text (P3@50, apply.ts:117).
- R26 window-fit warning computed then dropped to a console.warn — surfaces to neither user UI nor agent (P3, summarize.ts:288).
- Score: 2/5 high-priority compaction capabilities agent-accessible (summary-in-replay: yes; effective configure: no; recall: no; cost observability: no; discoverability: no).

### Coverage

- Reviewers: 13 dispatched, 13 completed (adversarial required one follow-up to emit output). No failed reviewers.
- Validation: 17 P0/P1 findings -> 17 validators -> 16 confirmed, 1 dropped ("estimate ignores excludeFromModel fires compactor every send" — compensating tokensPerChar recalibration gates the loop), 1 severity corrected (subagent frozen stream P1 -> P2).
- Suppressed below anchor 75: 5 findings (1 at P2, 4 at P3 — incl. subagent stale-snapshot apply @50, selective mode-enum drift @50, Zod-embedded deprecation warn @50, post-commit-failure false return @50).
- Demoted to soft buckets: 3 weak testing findings (tautological reclaim assertions, STEP_FINISH plumbing, over-window trigger branch) -> testing gaps.
- Residual risks (top): compactor timeout reuses idle-timeout semantics as a wall-clock cap (slow providers systematically no-op compaction); mid-turn apply can stall the visible turn for the full compactor timeout; renderer full-session reload on every SESSION_COMPACTION event; two windows on one session race openShared (last-write-wins today); tokensPerChar calibration divides system+tools tokens by message-only chars (over-arms); `subagent_chains` `lastCompactionRevision` not serialized for crash recovery.
- Testing gaps (top): no real-sessions.db round-trip for a compacted session; no cancel-during-apply/retry tests; no subagent integration tests; no renderer/CompactionWidget tests; no legacy-DB migration test; no chat-error kind parity test.
- Verified safe (notable): `compacted` marker is server-side only (no LLM forging path); selective op parsing is prototype-pollution-free, clamped, fully guarded; SQLite parameterized throughout; IPC additions Zod-validated; the `summary_tokens` migration itself is correct and idempotent; agent_name schema-pinned so project agents cannot shadow internal compactors; no secrets/transcripts reach logs.

---

> **Verdict:** Not ready
>
> **Reasoning:** Two P0 data-loss paths (durable history truncation + subagent_chains wipe on the compaction save) directly violate the plan's own R3/R4/R22 invariants and will fire on the first compaction of any restarted long session — precisely the sessions compaction exists for. The mid-turn resume path (#3) and selective stale-replay path (#5) additionally corrupt or silently drop turn content in normal usage. The core trigger/cut/validator machinery is sound and well-tested at the unit level; the failures concentrate in persistence integration and the three diverged orchestration copies.
>
> **Fix order:** P0 persistence redesign (#1, #2, rides #30) -> P1 mid-turn bookkeeping (#3, #33-#35) -> P1 apply-validity loop (#4) + selective replay integrity (#5, #7, #8) -> P1 one-liner enum fix (#6) -> tests for everything above (#13-#15) -> structural cleanup (#9-#12, dead code first).

---

> **Post-remediation verdict (2026-08-18):** Ready with follow-ups
>
> **Reasoning:** All P0/P1 findings are fixed and test-verified (4267/4268 tests, typecheck clean, no new lint errors): durable compaction persistence is now a targeted transactional write that cannot truncate history or wipe subagent chains; mid-turn resume persists the full turn; selective mode preserves originals and re-anchors at apply time; the preload no longer drops terminal error events; the engine is extracted and the three orchestration copies unified. Open work is P2/P3: the subagent in-flight stream still doesn't compact mid-run (#26), several cleanup items (#16-#25, #37, #41-#49), renderer semantics (#50), and doc drift (#45).
>
> **Original verdict (pre-remediation):** Not ready — two P0 data-loss paths (durable history truncation + subagent_chains wipe on the compaction save) violating the plan's own R3/R4/R22 invariants, plus mid-turn resume corruption (#3) and selective stale-replay (#5). The core trigger/cut/validator machinery was sound and well-tested at the unit level; failures concentrated in persistence integration and the three diverged orchestration copies.
>
> **Fix order (as executed):** P0 persistence redesign (#1, #2, rides #30) -> P1 mid-turn bookkeeping (#3, #34) -> P1 apply-validity (#4) + selective replay integrity (#5, #7, #8) -> enum fix (#6) -> tests (#13-#15) -> structural cleanup (#9-#12).

*Run artifacts: `/tmp/code-review/20260818-152203-08aa5d7b/` (per-reviewer JSON, diff, files). Generated by the code-review skill.*
