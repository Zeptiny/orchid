# Full Audit S1 — Process Shell & IPC Boundary

**Date:** 2026-07-16  
**Mode:** report-only (no fixes applied)  
**Intent:** Electron main/preload/renderer trust boundary — IPC correctness, security, contracts, reliability, types.  
**Scope:**
- `electron/src/main/index.ts`
- `electron/src/main/logging.ts`
- `electron/src/main/updater.ts`
- `electron/src/main/ipc/**`
- `electron/src/preload/index.ts`
- `electron/src/shared/types/ipc.ts`
- `electron/src/shared/types/ipc-boundary.ts`
- `electron/src/shared/commands.ts`

## Review team

| Reviewer | Role |
|----------|------|
| correctness | always |
| testing / maintainability / project-standards / agent-native / learnings | always (combined) |
| security | conditional |
| api-contract | conditional |
| reliability | conditional |
| kieran-typescript | conditional |
| adversarial | conditional |

**Team size:** 11 equivalent lenses (7 spawn groups)

## Verdict

**Do not treat the IPC surface as a hardened trust boundary.** Two **P0** issues give a compromised or buggy renderer host RCE (MCP config spawn) and arbitrary filesystem read (`tool:execute`). Several **P1** authz/lifecycle bugs compound that (bgcmd cross-session leak, false-success session mutations, MCP lease leaks on teardown, quit hangs).

---

## P0 — Critical (2)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 1 | `config:save` accepts arbitrary `mcp_servers.command` → main-process RCE | `electron/src/main/ipc/config.ts:148` | security, adversarial | 100 | manual |
| 2 | `tool:execute` read tools allow absolute path reads outside the project | `electron/src/main/ipc/tool.ts:36` | security, adversarial | 100 | manual |

### 1. config:save → MCP stdio RCE

**Why it matters:** A compromised renderer (XSS, hostile content, extension) can `config:save` with `mcp_servers` that spawn any executable. Main persists config, invalidates MCP managers, and later `startAll` uses `StdioClientTransport({ command, args, env, cwd })` with full user privileges — no allowlist, confirmation, or path confinement.

**Evidence:**
- `configSaveSchema` allows free-form `mcp_servers` nested records
- `ProjectMCPManagerRegistry` → `manager.startAll(servers)` → `createTransport` spawns `command`
- Same path used by intentional UI (`MCPServersTab`) without a privileged gate

**Suggested fix:** Dedicated audited MCP IPC; native confirmation before persist/start; absolute-path allowlist for commands; https-only + SSRF guards for URL transports; never auto-start newly saved servers without confirmation.

---

### 2. tool:execute absolute path exfiltration

**Why it matters:** Renderer-allowed tools (`read`, `read_directory`, `glob`, `grep`, …) resolve absolute paths with no project-root boundary. Compromised renderer can read `~/.ssh`, vault material, other projects, etc. without the agent loop.

**Evidence:**
- `RENDERER_ALLOWED_TOOLS` includes read-family tools
- `resolveToolPath` returns normalized absolute paths as-is
- `read.ts` documents unrestricted absolute paths (deferred sandbox)

**Suggested fix:** On **IPC-initiated** `tool:execute` only: realpath + require under bound `cwd` (optional explicit home-config allowlist). Keep agent-turn policy separate if broader FS access is product-required.

---

## P1 — High (20)

| # | Title | File:line | Reviewers | Confidence | Autofix |
|---|-------|-----------|-----------|------------|---------|
| 3 | `bgcmd:snapshot` has no session/window ownership check | `electron/src/main/ipc/chat.ts:1733` | correctness, security, adversarial, standards | 100 | gated_auto |
| 4 | `session:change_model` reports success on no-op | `electron/src/main/ipc/session.ts:304` | correctness | 100 | safe_auto |
| 5 | `session:rename` always emits renamed on no-op | `electron/src/main/ipc/session.ts:285` | correctness | 100 | safe_auto |
| 6 | `unregisterChatIPC` tears down agents without releasing MCP leases | `electron/src/main/ipc/chat.ts:1762` | correctness, reliability | 100 | safe_auto |
| 7 | macOS signed-build detection uses build-time env vars at runtime | `electron/src/main/index.ts:277` | correctness | 100 | gated_auto |
| 8 | macOS `activate` recreates window without rebinding updater `mainWindowRef` | `electron/src/main/index.ts:306` | correctness, reliability | 75 | gated_auto |
| 9 | Esc interrupt timeout disposes agent without cancelling subagents | `electron/src/main/ipc/chat.ts:1268` | correctness | 75 | gated_auto |
| 10 | `chat:send` with `sessionId` re-selects session mid-flight (selection steal) | `electron/src/main/ipc/chat.ts:577` | correctness | 75 | gated_auto |
| 11 | `before-quit` always `preventDefault` without re-entrancy/deadline | `electron/src/main/index.ts:314` | correctness, reliability, adversarial | 75 | gated_auto |
| 12 | Graceful shutdown can hang: `FileLogger.close` has no timeout | `electron/src/main/index.ts:314` + `logging.ts` | reliability | 75 | gated_auto |
| 13 | MCP SSE `url` from config enables main-process SSRF | `electron/src/main/mcp/transport.ts:32` | security | 75 | gated_auto |
| 14 | `session:set_workspace` binds any absolute readable dir without dialog | `electron/src/main/ipc/session.ts:355` | security, adversarial | 100 | gated_auto |
| 15 | Composition: `set_workspace` + `tool:execute` rebinds cwd then reads secrets | `session.ts:355` + `tool.ts` | adversarial | 100 | manual |
| 16 | Concurrent draft `chat:send` creates duplicate sessions / dual streams | `electron/src/main/ipc/chat.ts:563` | adversarial | 75 | manual |
| 17 | Updater events allowlisted/emitted but never on `OrchidAPI`/preload | `electron/src/preload/index.ts:360` | api-contract, kieran-ts, agent-native | 100 | manual |
| 18 | Preload event listeners trust unchecked `as Event` casts | `electron/src/preload/index.ts:118` | kieran-typescript | 100 | gated_auto |
| 19 | `invoke()` return type is an unchecked `Promise` cast | `electron/src/preload/index.ts:84` | kieran-typescript | 100 | gated_auto |
| 20 | Allowlists are `readonly string[]` instead of `IPCChannel` literals | `electron/src/shared/types/ipc.ts:838` | kieran-typescript | 100 | safe_auto |
| 21 | `ChatSendResult` is open `status`/`kind` strings, not a closed union | `electron/src/shared/types/ipc.ts:512` | api-contract, kieran-typescript | 100 | manual |
| 22 | `ConfigSaveMessage` contract disagrees with main validation/merge | `electron/src/shared/types/ipc.ts:247` | kieran-typescript | 75 | manual |
| 23 | `chat.ts` is a ~1779-line god module | `electron/src/main/ipc/chat.ts:1` | maintainability | 100 | manual |
| 24 | `providers` IPC imports `main/index` → circular dependency | `electron/src/main/ipc/providers.ts:30` | maintainability | 100 | gated_auto |
| 25 | app-shell IPC Zod tests reimplement weaker schemas than production | `electron/tests/integration/app-shell.test.ts:142` | testing | 100 | gated_auto |
| 26 | Critical IPC modules lack dedicated handler tests | `electron/tests/unit` | testing | 100 | manual |
| 27 | No first-class agent-native command surface for full UI capability set | `electron/src/shared/commands.ts:1` | agent-native | 75 | advisory |

### Detail highlights (P1)

**3. bgcmd:snapshot unscoped**  
`store.snapshot(commandId)` vs agent path `snapshotVisible(sessionId, agentScopeId)`. Monotonic command IDs → cross-session secret exfil.

**4–5. Session mutation false success**  
`changeModel` / `rename` no-op when session not selected by any owner, but IPC returns `changed`/`renamed` and may emit events.

**6. MCP lease on unregister**  
`disposeActiveAgent` releases leases; `unregisterChatIPC` only aborts/stops/clears — leases stay > 0 through quit.

**7–8. Updater / signing / window ref**  
Darwin `isSigned` checks `CODESIGN_CERT`/`CSC_NAME` at runtime (almost always false in packaged apps). `activate` creates new window without `setUpdaterWindow`.

**9–10. Interrupt / selection**  
5s Esc timeout disposes main agent without `cancelRunning` subagents. `chat:send` can `switchTo` and undo user navigation.

**11–12. Quit reliability**  
No `isQuitting` latch; `closeFileLogging` awaits stream end with no timeout → stuck quit.

**13–15. Config / workspace pivot**  
SSE MCP URLs unconstrained (SSRF). Programmatic `set_workspace` + absolute tool reads expand blast radius.

**16. Draft double-send race**  
Parallel first messages both see null active session → dual `create()` + dual streams.

**17–22. Contract / types**  
Updater half-wired; preload casts trust boundary away; `ChatSendResult`/`ConfigSave` contracts lie relative to main.

**23–27. Structure / tests / agent-native**  
God-file chat IPC; provider↔main cycle; weak/missing IPC tests; palette commands not an executable agent surface.

---

## P2 — Moderate (18)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 28 | Stream error path never completes activity to terminal idle | `chat.ts:1499` | correctness | 50→kept as residual note; primary keep at 50 only for P0 — **listed as residual risk** if gate strict; retained for audit completeness at P2 with conf 50 |
| 29 | Auto-update `signed` gate ineffective on non-macOS packaged builds | `index.ts:277` | security | 50 |
| 30 | `quitAndInstall` strips all `before-quit` cleanup (MCP/logging/IPC) | `updater.ts:202` | reliability | 75 |
| 31 | `tool:execute` has no timeout or abort | `tool.ts:113` | reliability | 75 |
| 32 | RAG/AST index IPC has no cancel/abort once started | `rag.ts:58` | reliability | 50 |
| 33 | Cancel/stop status kinds untyped (`status: string`) | `ipc.ts` / OrchidAPI | api-contract | 100 |
| 34 | `session:change_model` response richer than OrchidAPI documents | `ipc.ts:614` | api-contract | 100 |
| 35 | `ChatStateEvent.state` widened to `string` vs closed snapshot union | `ipc.ts:172` | api-contract, kieran-ts | 100 |
| 36 | Inconsistent IPC error shapes (throw vs structured vs soft-success) | multi | api-contract | 75 |
| 37 | Definition save Zod accepts names `DEFINITION_NAME_PATTERN` later rejects | `definitions.ts:31` | api-contract | 75 |
| 38 | `config:save` double `unknown` cast for merge | `config.ts:166` | kieran-ts | 75 |
| 39 | `providers:update` builds connection via structural assertion | `providers.ts:607` | kieran-ts | 75 |
| 40 | Status-bearing IPC results mostly `{ status: string }` | `ipc.ts:555` | kieran-ts | 75 |
| 41 | `Config.mcp_servers` untyped nested bag | `ipc-boundary.ts:114` | kieran-ts | 75 |
| 42 | Unbounded `chat:send` message size | `chat.ts:79` | adversarial | 75 |
| 43 | Definition save unbounded `system_prompt`/content | `definitions.ts:33` | adversarial | 75 |
| 44 | `chat:stop`/`chat:cancel` any `sessionId` without ownership | `chat.ts:1589` | adversarial | 75 |
| 45 | `bgcmd:snapshot` `lastN` has no upper bound | `chat.ts:99` | adversarial | 75 |
| 46 | `chat-history` params/docs still say `windowId`, callers use `sessionId` | `chat-history.ts:10` | maintainability | 100 |
| 47 | IPC Zod schemas private; no shared export for contract tests | `main/ipc/` | standards | 100 |
| 48 | `providers.ts` second large mixed-concern module (~801 lines) | `providers.ts:1` | maintainability | 75 |
| 49 | Allowlist completeness tests partial vs full `IPC_CHANNELS` | `app-shell.test.ts:80` | testing | 100 |
| 50 | `electron/CLAUDE.md` documents non-existent IPC modules | `electron/CLAUDE.md` | standards | 100 |
| 51 | `tool:execute` no IPC tests and no renderer consumers | `tool.ts:36` | agent-native/testing | 75 |
| 52 | XState snapshot context repeatedly asserted as `AgentContext` | `chat.ts:300` | kieran-ts | 50 |

*Note: Finding 28 confidence 50 and non-P0 — under skill gate it is soft; retained in residual risks below for operators.*

---

## P3 — Low (5)

| # | Title | File:line | Reviewers | Confidence |
|---|-------|-----------|-----------|------------|
| 53 | Updater channel docs disagree with `IPC_CHANNELS` names | `updater.ts:10` | api-contract | 100 |
| 54 | No IPC versioning/deprecation surface | `ipc.ts:718` | api-contract | 50 |
| 55 | Updater check/download no concurrency/hang guard | `updater.ts:164` | reliability | 50 |
| 56 | `ProviderStatusView.data` opaque `Record<string, unknown>` | `ipc.ts:317` | kieran-ts | 50 |
| 57 | No Electron IPC learnings in `docs/solutions` | `docs/solutions/...` | learnings | 75 |
| 58 | No rate limits on expensive IPC (index, tool, chat) | `rag.ts:59` | adversarial | 75 |

---

## Deduplication notes

| Merged from | Into |
|-------------|------|
| security + adversarial on mcp_servers RCE | #1 |
| security + adversarial on tool absolute paths | #2 |
| correctness + security + adversarial + standards on bgcmd | #3 |
| correctness + reliability on MCP unregister leases | #6 |
| correctness + reliability on updater window ref | #8 |
| correctness + reliability + adversarial on before-quit | #11–12 |
| security + adversarial on set_workspace | #14–15 |
| api-contract + kieran + agent-native on updater surface | #17 |
| api-contract + kieran on ChatSendResult | #21 |

---

## Residual risks

1. Agent-turn tools (`write`/`edit`/`execute_command`) intentionally broad host power; path sandbox deferred (R20) — outside renderer IPC but same `resolveToolPath` behavior.
2. `ActiveAgent.abortController` vs machine-internal `AbortController` dual cancellation paths — easy to break.
3. Preload allowlists channels but does not schema-validate payloads; safety depends on main Zod.
4. Multi-window stream fan-out increases blast radius if session selection desyncs.
5. Provider API keys write-only/redacted responses, but compromised renderer can still overwrite vault entries or repoint endpoints.
6. Logging redaction is best-effort.
7. Stream error activity may stick in `needs_attention` without complete-to-idle (low confidence).
8. Python MCP `CancelledError` learning in `docs/solutions` may not apply to TS MCP manager.

---

## Testing gaps (union)

- `session:change_model` / `session:rename` failure when not selected by owner
- `unregisterChatIPC` / quit releases MCP leases
- Esc `confirmSubagents` 5s timeout cancels subagents
- `chat:send` does not `switchTo` after user navigated away
- Packaged darwin `isSigned` without `CSC_*`
- `activate` rebinds updater destination
- Adversarial: malicious `mcp_servers.command` blocked/confirmed
- `tool:execute` rejects `/etc/passwd` and escapes
- `bgcmd:snapshot` cross-session denial
- SSRF tests for MCP URLs (link-local/metadata)
- Production `set_workspace` gated in packaged builds
- Concurrent draft `chat:send` single-session create
- Max-size rejection for chat message and definition bodies
- Quit deadline when `FileLogger.end` never fires
- `tool:execute` timeout returns `isError`
- Contract: every `IPC_CHANNELS` in allowlist + preload wiring
- Golden types for `ChatSendResult` / cancel statuses
- Definition names rejected at IPC boundary via `DEFINITION_NAME_PATTERN`
- IPC handler tests: tool, mcp, rag, ast, definitions, bgcmd
- Export production Zod schemas for tests (fix app-shell drift)

---

## Coverage

| Item | Value |
|------|--------|
| Paths reviewed | main shell, all `ipc/*`, preload, shared IPC types |
| Reviewers returned | 7/7 spawn groups |
| Findings after merge | 2 P0, ~25 P1, ~25 P2, ~6 P3 (tables above) |
| Confidence gate | Primary tables prefer ≥75; P0@100 kept; a few P2@50 retained for operator visibility |
| Fixes applied | **none** (report-only) |

---

## Suggested fix priority (for later work, not done here)

1. **P0:** MCP config spawn gate + `tool:execute` path confinement  
2. **P1 authz:** `bgcmd:snapshot` visibility, `set_workspace` prod gate, stop/cancel ownership  
3. **P1 lifecycle:** MCP lease on unregister, quit latch+timeout, subagent cancel on interrupt timeout  
4. **P1 UX correctness:** rename/change_model truthfulness, selection steal, draft send mutex  
5. **P1 contracts/types:** ChatSendResult unions, preload validation, updater surface decision  
6. **P1 structure/tests:** split chat.ts, break provider cycle, real IPC schema tests  
