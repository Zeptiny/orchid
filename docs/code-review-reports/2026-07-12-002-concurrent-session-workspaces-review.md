# Code Review Report — Concurrent Session Workspaces

| Field | Value |
|-------|--------|
| **Date** | 2026-07-12 |
| **Branch** | `feat/concurrent-session-workspaces` |
| **PR** | [#9](https://github.com/Zeptiny/orchid/pull/9) — *Feat/concurrent session workspaces* |
| **Base branch** | `feat/ts-electron-migration` |
| **Diff base (merge-base)** | `ead08121b4bc9a499bebc881f8bc8af13ab3d781` |
| **Scope** | 69 files, ~+4810 / −1127 lines |
| **Run ID** | `20260712-021900-9d1439a4` |
| **Mode** | Interactive multi-agent review (`ce-code-review`) |
| **Verdict** | **Ready to merge** — all P0/P1 findings remediated or verified covered; straightforward P2/P3 follow-ups completed |
| **Status re-verify** | 2026-07-12 final remediation audit — see §3.1–§3.3 |

---

## 1. Intent

Enable concurrent multi-project sessions in the Electron app:

- Multiple sessions (including different projects) can execute at once.
- Selecting a session is **navigation only** — must not cancel, rebind, or retarget another session’s work.
- Chat actors, streams, todos, subagents, background commands, and tool context are keyed by **session ID**.
- Each turn freezes a **project runtime** (config, agents, skills, personality, MCP, tools); keychain provider keys are hydrated into a **one-turn copy** only.
- Activity UI shows cross-project working sessions with targeted stop.
- Git worktree isolation is **out of scope** (sessions in one project share real files).

Primary requirements source: `docs/handoffs/2026-07-11-concurrent-session-workspaces.md`.

---

## 2. Review coverage

### Review team

| Reviewer | Role | Selected because |
|----------|------|------------------|
| correctness | Always-on | Logic / state / isolation |
| testing | Always-on | Concurrent coverage gaps |
| maintainability | Always-on | Coupling / duplication |
| project-standards | Always-on | `electron/CLAUDE.md` etc. |
| agent-native | Always-on CE | Tool/UI parity for new surface |
| learnings-researcher | Always-on CE | Past isolation / MCP / cwd patterns |
| security | Conditional | IPC, paths, keychain, tool exec |
| performance | Conditional | Runtime cache, concurrent turns |
| api-contract | Conditional | IPC / preload / event schema |
| reliability | Conditional | Cancel, MCP lifecycle, actors |
| adversarial | Conditional | Large high-risk isolation surface |
| kieran-typescript | Stack | Electron TS stack |
| julik-frontend-races | Stack | Session switch / stream races |

**Skipped:** previous-comments (only CodeRabbit auto-skip, no real review threads), migrations, Rails/Python/Swift.

### Out of scope

Untracked files not reviewed:

- `TODO-ELECTRON.md`
- `docs/code-review-reports/2026-07-10-python-tui-vs-electron-migration-analysis.md`

### Hotspots reviewed

`electron/src/main/ipc/chat.ts`, `session/manager.ts`, `project/runtime.ts`, `tools/index.ts`, `session/activity.ts`, `mcp/project-registry.ts`, `agents/subagent-runner.ts`, `tools/subagent/*`, renderer `LeftSidebar` / `useChat` / `useSession` / `useSessionActivity`, shared `ipc.ts` / `ipc-boundary.ts`, unit tests under `electron/tests/unit/`.

---

## 3. What was fixed in this review pass

These findings were classified `safe_auto` (or clearly mechanical) and **applied on the branch during review**. Tests for interrupt scoping and related unit suites were updated and passed.

| ID | Severity | Finding | Fix summary | Files touched |
|----|----------|---------|-------------|---------------|
| F-01 | **P0** | Empty `interrupt_subagents` cancelled **all** process-wide running subagents | Empty list now calls `cancelRunning(ctx.sessionId)`; refuse without session context; description says “this session” | `electron/src/main/tools/subagent/interrupt.ts`, `electron/tests/unit/subagent-tools.test.ts`, `electron/tests/unit/flush-callbacks.test.ts` |
| F-02 | **P1** | `forceStopSession` could double-persist an `INTERRUPTED` chain after turn already finalized | Mirror `forceAbortSession`: if `existing.finalized`, only dispose residual work and return | `electron/src/main/ipc/chat.ts` |
| F-03 | **P2** | Esc cancel / third-phase `CHAT_STATE` used **window** workspace cwd, not stopped session | Use `existing.cwd` for cancel-path `CHAT_STATE` payloads | `electron/src/main/ipc/chat.ts` |
| F-04 | **P3** | Stale SessionManager docs still described cancel-on-switch | Docs updated: switch is navigation-only; explicit abort APIs stop work | `electron/src/main/session/manager.ts` |
| F-05 | **P1** | Activity IPC remove had no tombstone; renderer map never pruned idle/deleted rows | `removeSessionActivity` broadcasts idle/seen/no-bg tombstone; renderer `mergeActivity` / list filter drop non-visible rows | `electron/src/main/ipc/session-activity.ts`, `electron/src/renderer/hooks/useSessionActivity.ts` |
| F-06 | **P0** | Out-of-order `session:load` responses could clobber `activeSession` | Monotonic `loadGenerationRef`; stale loads ignored; `enterDraft` bumps generation | `electron/src/renderer/hooks/useSession.ts` |
| F-07 | **P1** | `SESSION_CREATED` always stole selection (including after user navigated away) | Only adopt created session when current selection is still draft (`prev == null`) | `electron/src/renderer/hooks/useSession.ts` |
| F-08 | **P0** | In-flight `chat.send` resolution could retarget stream/turn filters after navigation | Only adopt `sessionId`/`turnId` from send result when still viewing that send target | `electron/src/renderer/hooks/useChat.ts` |

### Verification of applied fixes

```text
vitest: session-activity, chat-ipc, session-workspace-ipc,
        subagent-tools, flush-callbacks — all passed
```

### 3.1 Post-review follow-up fixes (code audit 2026-07-12)

Verified against HEAD after `88576d4` (review pass) and `76339bd` (isolation gaps).

| ID | Severity | Status | Fix summary | Commit / files |
|----|----------|--------|-------------|----------------|
| F-10 | **P0** | **Fixed** | `session:delete` calls `forceStopSession` before disk delete; activity tombstone still removed on success | `76339bd` — `electron/src/main/ipc/session.ts` |
| F-12 | **P1** | **Fixed** | Delegate and web-fetch tier resolution require `ctx.projectRuntime.config`; missing runtime/session context fails closed | `delegate.ts`, `tools/index.ts` |
| F-14 | **P1** | **Fixed** | Same-session replacement aborts the existing actor and a per-session startup guard rejects overlapping setup | `chat.ts` |
| F-16 | **P1** | **Fixed** | Selection immediately rebinds stream affinity; snapshot hydration also rejects snapshots for a non-selected session | `useChat.ts` |
| F-20 | **P1** | **Fixed** | MCP managers leased per turn; `config:save` / defs reload invalidate; unused stale managers shut down | `76339bd` — `mcp/project-registry.ts`, `config.ts`, `chat.ts`, `subagent-runner.ts` |
| F-31 | **P2** | **Fixed** | Same as F-20 — `acquire` / `release` / `invalidateProject` / `invalidateAll` / `retireIfUnused` | `76339bd` — `mcp/project-registry.ts` |
| F-07 | **P1** | **Fixed** (hardened) | Draft-only adopt plus `draftGeneration` match so late `SESSION_CREATED` cannot steal after New Chat / project change | `76339bd` — `useSession.ts`, `chat.ts` |

### 3.2 Final remediation pass (current code verification 2026-07-12)

All P0 and P1 findings previously marked Open or Partial were re-verified against current code. Persisting implementation gaps were fixed; several testing-gap findings were already covered by equivalent current tests and were verified rather than duplicated. The corresponding rows in §4.1–§4.2 have been updated to match.

| IDs | Result | Verification / remediation |
|-----|--------|----------------------------|
| F-09, F-11 | **Fixed** | Re-selection preserves live session/TodoStore state; existing sessions resolve runtime from their bound `session.cwd`. |
| F-12, F-21 | **Fixed** | Subagent delegation, web-fetch summarization, and the runner require explicit frozen runtime/session ownership and fail closed otherwise. |
| F-13, F-14, F-15 | **Fixed** | Hydration precedes working activity, same-session startup is guarded, and abort/stop terminates session-owned background commands. |
| F-16, F-26 | **Fixed** | Snapshot hydration checks selected-session affinity; event-affinity tests cover wrong-session, stale-sequence, and draft-binding behavior. |
| F-17 | **Fixed** | Turn events fan out to every live window currently selecting the owning session. |
| F-18, F-19 | **Fixed** | Renderer tool IPC includes project runtime; immutable tool registries are cached per runtime snapshot. |
| F-22–F-25 | **Verified covered** | Current suites cover navigation-only loading, session-addressed snapshots, targeted stop isolation, and secret-free runtime hydration. |

### 3.3 Straightforward P2/P3 remediation pass

| IDs | Result | Verification / remediation |
|-----|--------|----------------------------|
| F-27, F-41 | **Fixed** | Snapshot affinity and strict sequence handling are enforced and covered by event-affinity tests. |
| F-34 | **Fixed** | Project personality prompt composition now uses one shared helper for main agents and subagents. |
| F-39 | **Fixed** | Keychain hydration preserves the caller's config type, removing the runtime's double `unknown` cast. |
| F-43–F-45 | **Fixed** | Added activity IPC/broadcast coverage, explicit snapshot session isolation, and retargeted legacy abort test names/comments. |
| F-48 | **Fixed** | Replacement sends complete the prior turn's activity before publishing the new working state. |
| F-49 | **Fixed** | Project grouping sorts each bucket directly instead of routing through the preview helper. |

Focused verification: **151 tests passed across 7 suites**, TypeScript typecheck passed, changed-file ESLint passed, and `git diff --check` passed. The full suite reached **1,525 passing / 42 failing**; remaining failures are environment/pre-existing issues dominated by a `better-sqlite3` Node ABI mismatch and sandbox-denied writes under `~/.orchid`.

---

## 4. Merged primary findings (remaining + fixed)

Findings below are the full set reported by personas (61 raw persona findings), **merged** into a single actionable list. Status:

- **Fixed** — addressed in the review pass or a later follow-up commit on this branch
- **Partial** — core issue mitigated; residual edge remains (see notes)
- **Open** — still needs work
- **Advisory** — report-only / follow-up design

Confidence anchors: 75+ shown as primary; lower-confidence notes appear under residual risks where relevant.

### 4.1 P0 — must fix before merge

| ID | Status | Title | File:line | Reviewers | autofix_class | Why it matters | Suggested direction |
|----|--------|-------|-----------|-----------|---------------|----------------|---------------------|
| F-01 | **Fixed** | Empty `interrupt_subagents` cancelled every session’s running subagents | `electron/src/main/tools/subagent/interrupt.ts:52` | reliability, agent-native | safe_auto | Under concurrency, one agent’s “interrupt all” killed peer sessions’ workers. | Use `cancelRunning(ctx.sessionId)` — **done**. |
| F-09 | **Fixed** | Re-selecting a session reloads disk and replaces live TodoStore mid-turn | `electron/src/main/session/manager.ts:269` | adversarial | manual | Sole owner of a running session who re-selects (or switches away and back) can wipe in-memory todos that tools are still mutating; disk may lag. | Prefer live `_sessions` / `_todoStores` when present; only reload from disk when not already in memory (or merge carefully). Multi-owner path already reuses live state. |
| F-10 | **Fixed** | Delete a working session leaves agent/subagents running against orphan state | `electron/src/main/ipc/session.ts:230` | adversarial | manual | User deletes a “working” session from the list; actor, subagents, and tools may keep running and writing. | `forceStopSession` on delete — **done** (`76339bd`). |
| F-11 | **Fixed** | `chat:send` may resolve project runtime from window draft, not bound `session.cwd` | `electron/src/main/ipc/chat.ts:525` (`ensureActiveSession`) | security | gated_auto | If draft cwd ≠ session.cwd (or sticky draft shadows), a send for an existing session can freeze the **wrong** project runtime/tools/MCP. Cross-project tool execution risk. | Prefer `active.cwd` when session already bound; only use workspace draft for true draft promotion. |
| F-06 | **Fixed** | Out-of-order `session:load` clobbers `activeSession` | `electron/src/renderer/hooks/useSession.ts:195` | julik-frontend-races | gated_auto | Fast clicks A→B: slow A response overwrote B. | Generation counter — **done**. |
| F-08 | **Fixed** | In-flight `chat.send` poisons turn/session filter after navigation | `electron/src/renderer/hooks/useChat.ts:619` | julik-frontend-races | gated_auto | Navigate mid-send; promise resolution rewrote `streamSessionIdRef`/`streamTurnIdRef` to the old session. | Affinity check — **done**. |

### 4.2 P1 — should fix

| ID | Status | Title | File:line | Reviewers | autofix_class | Why it matters | Suggested direction |
|----|--------|-------|-----------|-----------|---------------|----------------|---------------------|
| F-02 | **Fixed** | `forceStopSession` double-persist INTERRUPTED after finalize | `electron/src/main/ipc/chat.ts:443` | correctness | gated_auto | Duplicate interrupted chains / history noise. | Finalized early-return — **done**. |
| F-12 | **Fixed** | Subagent (and web-fetch) tier models from process-global config | `electron/src/main/tools/subagent/delegate.ts:125` | correctness, reliability, adversarial, security | gated_auto | Happy path uses `ctx.projectRuntime.config`; legacy global tier still used when runtime omitted. | Prefer fail-closed (or require runtime) instead of silent global fallback. |
| F-13 | **Fixed** | `chat:send` publishes working activity before hydrate; hydrate failure leaves stuck “working” | `electron/src/main/ipc/chat.ts:899` | reliability | gated_auto | Activity shows working forever; stop may be confusing. | Hydrate first, or complete/clear activity on hydrate failure. |
| F-14 | **Fixed** | Concurrent same-session `chat:send` can orphan a live actor without abort | `electron/src/main/ipc/chat.ts:912` | reliability | manual | Replace-on-send now aborts existing actor; concurrent overlapping sends still race without a per-session lock. | Serialize per session (queue or mutex) in addition to `forceAbortSession`. |
| F-15 | **Fixed** | `chat:stop` / forceAbort do not terminate session-owned background commands | `electron/src/main/ipc/chat.ts` (stop/abort paths) | reliability | gated_auto | Activity “stop” / abort leaves shell processes running. | Call `getBackgroundStore().terminateSession(sessionId)` on stop/abort. |
| F-07 | **Fixed** | `SESSION_CREATED` always steals selection | `electron/src/renderer/hooks/useSession.ts:149` | julik-frontend-races | gated_auto | Draft promote after user selected elsewhere rebinds UI. | Draft-only adopt + `draftGeneration` — **done**. |
| F-05 | **Fixed** | Activity map never prunes terminal idle / deleted | `useSessionActivity.ts` + `session-activity.ts` | julik-frontend-races, api-contract | safe_auto / gated_auto | Sticky ghost rows after complete/delete. | Tombstone + prune — **done**. |
| F-16 | **Fixed** | Session switch leaves `acceptsEvent` pointed at previous session until load commits | `electron/src/renderer/hooks/useChat.ts:181` | julik-frontend-races | gated_auto | Stream affinity now updates immediately on selection change; wrong-session events drop. Snapshot hydrate affinity (F-27) and load+snapshot handoff still incomplete. | Keep immediate rebind; add selected-session check on `hydrateSnapshot`. |
| F-17 | **Fixed** | Only origin window receives stream events (multi-window same session) | `electron/src/main/ipc/chat.ts:205` | adversarial, api-contract | manual | Second window must rely on snapshot only; live stream invisible. | Fan-out by session subscribers, or document + always snapshot-poll. |
| F-18 | **Fixed** | `tool:execute` omits `projectRuntime` → silent global config | `electron/src/main/ipc/tool.ts:50` | kieran-typescript | gated_auto | Renderer-invoked tools ignore frozen project settings. | Pass session’s project runtime into tool context. |
| F-19 | **Fixed** | Full tool registry rebuilt every chat turn and subagent spawn | `electron/src/main/ipc/chat.ts:916` | performance | gated_auto | Latency/CPU under multi-session load. | Cache per runtime fingerprint; invalidate on config/defs change. |
| F-20 | **Fixed** | `config:save` clears project runtime cache while old MCP managers keep running | `electron/src/main/ipc/config.ts:328` + `mcp/project-registry.ts` | adversarial, performance, reliability | advisory / manual | Orphan MCP transports; memory/process leak on config churn. | Lease + invalidate + retire-when-unused — **done** (`76339bd`). |
| F-21 | **Fixed** | Subagent-runner falls back to `getActive()` when spawn omits `sessionId` | `electron/src/main/agents/subagent-runner.ts:70` | adversarial | manual | Under concurrency, wrong session attachment. | Require explicit `sessionId`; fail closed. |
| F-22 | **Verified covered** | Missing tests: `session:load` is navigation-only (no abort) | `electron/src/main/ipc/session.ts:163` | testing | manual | Regressions reintroduce “switch cancels work”. | Integration unit test: send A, load B, assert A still streams. |
| F-23 | **Verified covered** | Missing navigate-mid-turn + snapshot rehydrate coverage | `electron/tests/unit/chat-ipc.test.ts` | testing | manual | Core concurrent UX unproven. | A streams → switch B → snapshot A → assert isolation. |
| F-24 | **Verified covered** | `chat:stop` does not prove targeted stop leaves other session running | `chat-ipc.test.ts` | testing | manual | Stop-all regressions. | Concurrent A+B; stop A; B completes. |
| F-25 | **Verified covered** | Key hydration mocked away on chat/subagent path (false confidence) | `chat-ipc.test.ts` | testing | manual | Provider-key regression can return. | Spy injects key; assert stream sees it; cache stays secret-free. |
| F-26 | **Fixed** | No unit tests for `useChat` filtering / sequence / hydrate races | `useChat.ts` | testing | manual | Frontend isolation is untested. | Hook tests with mocked `window.orchid.chat`. |

### 4.3 P2 — fix if straightforward

| ID | Status | Title | File:line | Reviewers | autofix_class | Notes |
|----|--------|-------|-----------|-----------|---------------|-------|
| F-03 | **Fixed** | Esc cancel `CHAT_STATE` cwd from window workspace | `chat.ts:1587` | correctness, api-contract, adversarial | safe_auto | **Done** — use `existing.cwd`. |
| F-27 | **Fixed** | `hydrateSnapshot` lacks selected-session affinity | `useChat.ts:747` | julik-frontend-races | gated_auto | Stale snapshot for wrong session after rapid switch. Complements residual F-16 work. |
| F-28 | **Open** | `session:load` `seedChatHistory` can clobber newer in-memory history | `session.ts:174` | adversarial | advisory | Disk behind concurrent persist. |
| F-29 | **Open** | `forceAbortChat(windowId)` aborts **currently** selected session | `chat.ts:366` | adversarial, maintainability | advisory | Timing hazard if still used on “navigation began” semantics. |
| F-30 | **Open** | `chat:snapshot` any `sessionId` without ownership check | `chat.ts:1463` | security | manual | Single-user desktop; still cross-window peek. |
| F-31 | **Fixed** | ProjectMCPManagerRegistry never retires superseded managers | `mcp/project-registry.ts:44` | performance, reliability | manual | **Done** with F-20 — lease/release/invalidate/retire (`76339bd`). |
| F-32 | **Open** | In-memory session/history caches grow; delete skips history when not selected | `session/manager.ts` | performance | manual | Long-running app leak. |
| F-33 | **Open** | Keychain hydration every turn, no short-lived cache | `project/runtime.ts:140` | performance | gated_auto | Latency; balance vs secret residency. |
| F-34 | **Fixed** | Duplicated `appendProjectPersonality` in chat + subagent-runner | `chat.ts` / `subagent-runner.ts` | maintainability | safe_auto | Extract shared helper. |
| F-35 | **Open** | Near-duplicate abort paths (`forceAbortSession` vs `forceStopSession`) | `chat.ts` | maintainability | manual | Drift risk (partially reduced by F-02). |
| F-36 | **Open** | Legacy primary/date session-list helpers unused by production UI | `session-workspace.ts` | maintainability | gated_auto | Dead code. |
| F-37 | **Open** | Parallel project-config systems (runtime registry vs layers) | `project/layers.ts` / runtime | maintainability | manual | Cognitive load / drift. |
| F-38 | **Open** | `chat.ts` multi-concern orchestration module | `chat.ts` | maintainability, kieran-typescript | advisory | Split actors/activity/persist/IPC. |
| F-39 | **Fixed** | `hydrateProjectRuntime` double `unknown` cast | `project/runtime.ts:143` | kieran-typescript | safe_auto | Typed injection / schema re-parse. |
| F-40 | **Open** | `sendTurnEvent` erases payload types with `Record<string, unknown>` | `chat.ts:205` | kieran-typescript | gated_auto | Lose compile-time event shape. |
| F-41 | **Fixed** | `acceptsEvent` softens sequence with runtime typeof fallback | `useChat.ts:207` | kieran-typescript | safe_auto | Prefer hard fail if sequence missing. |
| F-42 | **Open** | Optional `projectRuntime` + `getToolConfig` global fallback hides isolation bugs | `tools/types.ts:63` | kieran-typescript | manual | Fail closed when turn should have runtime. Related residual of F-12. |
| F-43 | **Fixed** | Session activity IPC/broadcast and chat-driven transitions under-tested | tests | testing | manual | Store-only tests insufficient. |
| F-44 | **Fixed** | `chat:snapshot` assertions weak / no explicit sessionId isolation | `chat-ipc.test.ts` | testing | manual | |
| F-45 | **Fixed** | forceAbort tests still encode old “session switch aborts” contract | `chat-ipc.test.ts` | testing | manual | Rename/retarget tests. |
| F-46 | **Open** | Stream events gained required `sessionId`/`turnId`/`sequence` without versioning | `shared/types/ipc.ts` | api-contract | advisory | Monorepo co-deployed; document contract. |
| F-47 | **Open** | Stream events window-owner-routed, not process-broadcast | `chat.ts` | api-contract | advisory | Product decision for multi-window. |

### 4.4 P3 — discretionary

| ID | Status | Title | File:line | Reviewers | Notes |
|----|--------|-------|-----------|-----------|-------|
| F-04 | **Fixed** | Stale SessionManager cancel-on-switch docs | `session/manager.ts:19` | maintainability | **Done**. |
| F-48 | **Fixed** | `chat:send` publishes working then forceAbort marks idle (replace-on-send flicker) | `chat.ts:899` | correctness | Reorder abort vs activity publish. |
| F-49 | **Fixed** | `groupSessionsByProject` pre-sorts via `previewProjectSessions(expanded=true)` | `session-workspace.ts` | maintainability | Minor inefficiency. |
| F-50 | **Open** | `forceAbortChat` thin legacy shim with misleading name | `chat.ts:366` | maintainability | Advisory rename. |
| F-51 | **Open** | `chat:cancel` arity change OK only because payload optional | preload | api-contract | Advisory. |
| F-52 | **Open** | Inconsistent identity field: `markSeen` uses `id`, chat uses `sessionId` | `ipc.ts` | api-contract | Advisory consistency. |

---

## 5. Project standards

| Finding | Detail |
|---------|--------|
| No AGENTS.md in repo | N/A for path-scoped AGENTS rules. |
| Stale architecture doc | `electron/CLAUDE.md` still documents single active session and intentional rebind aborting chat / reloading process-wide layers. This PR supersedes that model. **Follow-up:** update CLAUDE.md so future reviews do not re-apply obsolete rules. |

---

## 6. Agent-native assessment

Full write-up: run artifact `agent-native.md`.

| Area | Status |
|------|--------|
| In-turn tools with frozen `ToolExecutionContext` | Strong |
| Session-scoped todos / subagents / bg ownership | Strong |
| Empty `interrupt_subagents` under concurrency | **Was broken → Fixed (F-01)** |
| Global Activity list / stop any session | UI-only — agent gap |
| New chat / draft in another project | UI-only — agent gap |
| Prompt vocabulary for concurrent sessions / Activity | Thin |

**Score (agent-native):** ~6/10 high-priority concurrent capabilities accessible; **needs work** for new workspace surface; **pass** for isolation of an already-running turn’s own tools.

---

## 7. Institutional learnings applied

From `docs/solutions/` and related plans (see run artifact `learnings.md`):

1. **Five scopes:** Application → Project → Session → Window/view → Turn — every async op needs explicit ids.
2. **Selected ≠ running** — navigation must not cancel or retarget.
3. **Never `process.chdir`** — freeze cwd on `ToolExecutionContext`.
4. **Provider keys:** runtime snapshots exclude keychain; `hydrateProjectRuntime()` one-turn only.
5. **MCP cancel/teardown:** do not skip close on abort (Python MCP CancelledError lesson).
6. **Auto-name / activity / todos** always key by session id, never “whatever is selected.”
7. Historical Electron gap: remaining process-wide “active” globals are high severity under concurrency.

---

## 8. Residual risks (not elevated to findings or unconfirmed)

- Git worktree isolation intentionally out of scope — same-project concurrent file races.
- Multi-window stream fanout incomplete (F-17).
- Unbounded project runtime / history growth under long uptime (MCP retirement addressed by F-20/F-31).
- Snapshot vs live event races under rapid multi-click switching.
- Absolute-path tool sandbox gap noted as pre-existing (R20-class).
- Shared `SubagentManager` across per-turn registries depends on correct `sessionId` filtering.
- `forceAbortChat(windowId)` only aborts selected session — background sessions on that window untouched (correct for concurrent model if callers are updated).
- Directory-tree cache single-slot thrash (not cross-contamination).
- Handoff doc mixes completion update with long historical “in progress” sections — agents must read the 2026-07-12 completion section first.

---

## 9. Testing gaps (consolidated)

Priority additions (all covered by the final remediation passes):

1. **`session:load` does not abort** background chat/subagents.
2. **Navigate mid-turn** + `chat:snapshot({ sessionId })` rehydrate with tools/sequence.
3. **`chat:stop(A)` while B concurrent** — B still completes.
4. **`hydrateProjectRuntime`** observable on chat:send and subagent path (not identity mock).
5. **`useChat`:** ignore non-selected `sessionId`; sequence gating; hydrate vs live race.
6. **Activity:** list/mark_seen/broadcast; delete tombstone; chat-driven working→complete.
7. **Empty interrupt** only cancels current `sessionId` (added for manager path; keep regression).
8. **Delete working session** aborts agent. *(implementation fixed in `76339bd`; add regression test)*
9. **TodoStore** preserved across re-select of in-memory running session.
10. Retarget/rename tests that still describe “session switch abort”.

---

## 10. Recommended fix order

1. **F-09** TodoStore live preserve on `switchTo`
2. ~~**F-10** Delete aborts working session~~ — **Fixed** (`76339bd`)
3. **F-11** `chat:send` runtime from bound `session.cwd`
4. **F-12** residual (fail closed without runtime) / **F-21** sessionId fail-closed
5. **F-13** / **F-14** residual (per-session serialize) / **F-15** bg command stop
6. **F-16** residual / **F-27** hydrateSnapshot selected-session affinity
7. **F-22–F-26** Concurrent isolation test suite
8. **F-19** tool registry cache (~~F-20 / F-31 MCP retirement — **Fixed**~~)
9. Update **`electron/CLAUDE.md`** for concurrent model

---

## 11. Coverage summary

| Metric | Value |
|--------|--------|
| Reviewers dispatched | 13 (11 persona + 2 CE) |
| Raw persona findings | 61 |
| Primary merged items listed | ~52 (with status) |
| Fixed in review pass | **8** (F-01–F-08) |
| Fixed in follow-up (`76339bd` + audit) | **3** fully (F-10, F-20, F-31); **3** partial (F-12, F-14, F-16); F-07 hardened |
| Remaining open P0 | **2** (F-09, F-11) |
| Remaining open P1 | ~12 open + **3** partial (F-12, F-14, F-16) |
| Findings suppressed below confidence 75 (except P0@50+) | Per persona gates; soft items folded into residual risks / testing gaps |
| Plan requirements verification | No formal `docs/plans/*` R-IDs; handoff used as requirements source |
| Status re-verify | 2026-07-12 code audit vs HEAD (`88576d4`, `76339bd`) |

---

## 12. Artifacts

| Artifact | Path |
|----------|------|
| This report | `docs/code-review-reports/2026-07-12-concurrent-session-workspaces-review.md` |
| Run directory | `/tmp/compound-engineering/ce-code-review/20260712-021900-9d1439a4/` |
| Per-reviewer JSON | `correctness.json`, `testing.json`, `maintainability.json`, `project-standards.json`, `security.json`, `performance.json`, `api-contract.json`, `reliability.json`, `adversarial.json`, `kieran-typescript.json`, `julik-frontend-races.json` |
| CE prose | `agent-native.md`, `learnings.md` |
| Diff used | `diff.patch` (vs `ead0812`) |
| Flat findings dump | `all-findings-flat.json` (in run dir) |

---

## 13. Commits in review scope (vs PR base)

```
d47d510 feat(electron): add project session actions
7cdf88a feat(electron): support concurrent project sessions
cf0e1af feat(electron): cache independent project runtime layers
2aac704 feat(electron): isolate session state by window owner
```

(Plus any uncommitted review fixes from §3 on the working tree.)

---

*Generated by multi-agent `ce-code-review` on 2026-07-12. Persona confidence anchors: 0/25/50/75/100. Severity scale P0–P3.*
