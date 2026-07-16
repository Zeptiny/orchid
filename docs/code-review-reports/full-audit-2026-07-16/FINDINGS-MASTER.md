# Full Audit 2026-07-16 — Master Findings Table

**Source:** S1–S6 section reports (re-read in full)  
**Mode:** report-only · **Fixes applied:** none  
**Dedup rules:** Same root cause / same primary fix site → one master row. Cross-section corroboration listed in **Sections**. Severity = highest reported. Confidence = max. Autofix = most conservative when mixed.

**Totals after cross-section dedup:** **24 P0 · 111 P1 · 115 P2 · 32 P3 = 282 unique findings**

Section raw tables (before cross-dedup) had ~320+ row citations; cross-section merges collapsed repeated root causes into single master IDs.

---

## How to read

| Column | Meaning |
|--------|---------|
| **ID** | Stable master id `M-P{sev}-{nnn}` |
| **Sections** | Which audit sections reported it (`S1`…`S6`) |
| **Primary file** | Best single location for navigation |
| **Autofix** | `safe_auto` · `gated_auto` · `manual` · `advisory` |

Protected paths (`docs/brainstorms|plans|solutions`) were never flagged for deletion.

---

## P0 — Critical (24)

Index table, then full write-ups (Why it Matters · Evidence · Suggested Fix).

| ID | Title | Primary file | Sections | Conf | Autofix |
|----|-------|--------------|----------|------|---------|
| M-P0-001 | `config:save` → MCP stdio RCE | `main/ipc/config.ts:148` | S1, S3, S4 | 100 | manual |
| M-P0-002 | Project MCP auto-spawn | project-registry + transport | S4, S1 | 90 | manual |
| M-P0-003 | No FS path sandbox | `tools/types.ts:89` | S4 | 100 | manual |
| M-P0-004 | `tool:execute` absolute reads | `main/ipc/tool.ts:36` | S1, S4 | 100 | manual |
| M-P0-005 | Unrestricted shell RCE | `execute-command.ts:222` | S4 | 100 | manual |
| M-P0-006 | `web_fetch` SSRF | `tools/web/fetch.ts:87` | S4 | 100 | manual |
| M-P0-007 | Env-auth secret exfil | `providers/index.ts:160` | S3 | 75 | manual |
| M-P0-008 | `allowInsecureHttp` dropped | `compatible.ts:63` + index.ts | S3 | 100 | gated_auto |
| M-P0-009 | submit_api_key ∥ disconnect race | `ipc/providers.ts` | S3 | 85 | manual |
| M-P0-010 | validateConnection re-enables disabled | `ipc/providers.ts` | S3 | 90 | manual |
| M-P0-011 | Unbounded `wait_for_subagent` | `agents/manager.ts:264` | S2, S4 | 100 | gated_auto |
| M-P0-012 | Esc orphans subagents | `ipc/chat.ts` | S1, S2 | 92 | gated_auto |
| M-P0-013 | Cross-session waiter flush | `tools/subagent/interrupt.ts` | S2 | 90 | manual |
| M-P0-014 | Quit doesn’t kill bg process groups | `main/index.ts:314` | S4, S1 | 92 | gated_auto |
| M-P0-015 | MCP startup timeout false-connected | `mcp/manager.ts:153` | S4 | 88 | gated_auto |
| M-P0-016 | Tool timeout abandons detached shells | `tool-dispatch` + execute | S4 | 90 | gated_auto |
| M-P0-017 | Agent path skips Zod validate | `llm/tool-dispatch.ts:144` | S2, S4 | 88 | gated_auto |
| M-P0-018 | Dual `useSession()` Config vs Chat | `ConfigView.tsx:53` | S5 | 92 | manual |
| M-P0-019 | Incomplete skill/agent seed | `skills/registry.ts:190` | S4, S6 | 100 | gated_auto |
| M-P0-020 | Empty `allowed_tools` semantics split | `tools/registry.ts:49` | S4, S6 | 100 | gated_auto |
| M-P0-021 | No `list_mcp_resources` | tools/mcp + manager | S4, S6 | 100 | manual |
| M-P0-022 | `read_mcp_resource` not on general | `general/AGENT.md` | S6 | 90 | safe_auto |
| M-P0-023 | No AST index management tool | tools/ast | S4, S6 | 100 | manual |
| M-P0-024 | Session lifecycle UI-only | commands + session IPC | S6, S1 | 100 | manual |

**Related product orphan (S6 P0 map, tracked as P1):** config/providers agent CRUD gap → **M-P1-053**.

### M-P0-001 — `config:save` → MCP stdio RCE

- **Primary:** `electron/src/main/ipc/config.ts:148` · **Sections:** S1, S3, S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** A compromised or buggy renderer can turn a settings write into main-process code execution: config is persisted, project MCP managers are invalidated, and the next chat turn (or MCP status path) spawns the attacker-chosen command with full user privileges.
- **Evidence:** `configSaveSchema` allows free-form `mcp_servers` nested records; after save, `clearProjectRuntimeRegistry` / `invalidateAllProjectMCPManagers`; `ProjectMCPManagerRegistry` → `startAll` → `StdioClientTransport({ command, args, env, cwd })` with no allowlist, confirmation, or path confinement; same path used by intentional UI (`MCPServersTab`) without a privileged gate.
- **Suggested fix:** Dedicated audited MCP IPC; native confirmation before persist/start; absolute-path allowlist for commands; https-only + SSRF guards for URL transports; never auto-start newly saved servers without confirmation.

### M-P0-002 — Project `.orchid.json` MCP auto-spawn

- **Primary:** `mcp/transport.ts` + project-registry + config merge · **Sections:** S4, S1 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Home + project config deep-merge means a cloned repo’s `.orchid` / project MCP map can introduce a malicious server that runs when the project is bound—stdio spawn as the desktop user without a trust prompt.
- **Evidence:** Config merge includes `mcp_servers` from project layer; `ProjectMCPManagerRegistry` sets cwd to `projectDir` and starts every configured server; `createTransport` spawns `command`/`args`/`env` with no binary allowlist; validation only checks name regex and non-empty command; manager documents no sandboxing.
- **Suggested fix:** Never auto-start project-supplied MCP commands without explicit user consent UI; pin allowlisted commands; isolate env; treat project `mcp_servers` as untrusted until approved.

### M-P0-003 — Filesystem tools have no project path sandbox

- **Primary:** `electron/src/main/tools/types.ts:89` · **Sections:** S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Any agent turn (or prompt injection) can read/write/enumerate arbitrary absolute paths outside the bound workspace—secrets, SSH keys, other projects, system files. Primary agent-tool boundary is open by design (deferred R20).
- **Evidence:** `resolveToolPath()` keeps absolute paths absolute and only `path.resolve`/`normalize`—no realpath containment under `ctx.cwd`; read/write/edit/glob/read_directory/grep all use it; security notes in filesystem tools document R20 deferral; contrast: `defs/paths.ts` already has realpath containment unused by tools.
- **Suggested fix:** `assertPathInProject(cwd, userPath)` with realpath of cwd + candidate; reject if outside; apply to all FS, search, AST path tools, and `execute_command` working_directory.

### M-P0-004 — `tool:execute` absolute path exfiltration

- **Primary:** `electron/src/main/ipc/tool.ts:36` · **Sections:** S1, S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Renderer-facing “safe” tools still allow absolute reads. Compromised renderer can exfiltrate SSH keys, vault material, cookies, etc. without the agent loop.
- **Evidence:** `RENDERER_ALLOWED_TOOLS` includes read/read_directory/glob/grep; handlers use same unrestricted `resolveToolPath`; `read.ts` documents unrestricted absolute paths; attack: `tool:execute({ name: 'read', args: { file_path: '/home/user/.ssh/id_rsa' } })`.
- **Suggested fix:** On IPC-initiated `tool:execute` only: realpath + require under bound `cwd` (optional explicit home-config allowlist). Keep agent-turn policy separate if broader FS access is product-required.

### M-P0-005 — `execute_command` unrestricted shell RCE

- **Primary:** `electron/src/main/tools/process/execute-command.ts:222` · **Sections:** S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Prompt injection or a malicious model response can run arbitrary shell as the logged-in user with full privileges and full `process.env` (API keys, tokens), plus optional cwd escape.
- **Evidence:** Default `shell=true` → `/bin/sh -c command`; background path same; `env = { ...process.env, ...ENV_SUPPRESSION }` only sets NO_COLOR/TERM/PAGER; `working_directory` via unrestricted `resolveToolPath`; no confirmation, allowlist, or capability split.
- **Suggested fix:** Force cwd under project realpath; scrub sensitive env for children; optional approval/allowlist for high-risk patterns; prefer `shell=false` + argv for known tools; document residual risk if full shell remains product intent.

### M-P0-006 — `web_fetch` classic SSRF

- **Primary:** `electron/src/main/tools/web/fetch.ts:87` · **Sections:** S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Agent (or prompt injection) can force main process to request localhost, RFC1918, link-local, and cloud metadata (e.g. 169.254.169.254), exfiltrating credentials or probing internal services; `redirect:'follow'` can bounce public → internal.
- **Evidence:** `validateUrl` only checks non-empty + http/https; no private IP/localhost/metadata checks; `fetch(..., { redirect: 'follow' })` with no post-redirect revalidation; body up to 10 MiB returned to the model.
- **Suggested fix:** Block private/reserved ranges after DNS resolve (and re-check after each redirect hop); deny localhost/link-local/metadata hostnames; prefer `redirect:'manual'` or re-validate Location; optional public-only mode.

### M-P0-007 — Env-auth + generic endpoint secret exfil

- **Primary:** `electron/src/main/providers/index.ts:160` · **Sections:** S3 · **Conf:** 75 · **Autofix:** manual
- **Why it matters:** Environment auth reads any `process.env` value matching the user-supplied variable name and sends it as the API key to a fully user-controlled generic endpoint—compromised renderer can bind e.g. `OPENAI_API_KEY` / AWS tokens to an attacker URL.
- **Evidence:** `resolveCredential`: `process.env[connection.credential.variable]` with no allowlist; `environmentVariableSchema` only `/^[A-Z_][A-Z0-9_]*$/`; generic drivers allow custom endpoints; IPC create/update accept env var + endpoint; adapter posts apiKey to user baseURL.
- **Suggested fix:** Restrict env variable names to per-provider allowlist (or known provider keys); for generic endpoints block private/metadata hosts by default; refuse environment-auth + non-allowlisted hosts; prefer vault keys for custom endpoints.

### M-P0-008 — `allowInsecureHttp` dropped on request path

- **Primary:** `drivers/compatible.ts:63` + `providers/index.ts:176` · **Sections:** S3 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Users who explicitly allow non-loopback HTTP can create/store credentials (IPC honors the flag) but chat/embed resolution re-validates without it—ready connections hard-fail at runtime; LAN/self-hosted HTTP is false-ready.
- **Evidence:** IPC/registry validate with `allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true`; `resolveCredential` calls bare `validateGenericEndpoint(endpoint)`; `createCompatibleLanguageModel` re-validates without the flag; tests cover flag in isolation, not E2E resolve/execution.
- **Suggested fix:** Thread `{ allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true }` through `resolveCredential` and `createCompatibleLanguageModel` (or trust registry-validated endpoint once).

### M-P0-009 — Concurrent submit_api_key + disconnect leaves live key

- **Primary:** `electron/src/main/ipc/providers.ts` · **Sections:** S3 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Independent handlers with no shared connection-level mutex; interleaving can leave a usable vault handle while UI reports disconnected (or reverse)—credentials not durably removed.
- **Evidence:** `PROVIDERS_DISCONNECT` and `PROVIDERS_SUBMIT_API_KEY` only serialize their own store; constructed sequence: disconnect deletes vault → submit writes new key → disconnect marks disconnected → submit updates handle + may validate ready; vault and connection write locks are independent.
- **Suggested fix:** Per-connection mutation lock spanning vault + connection-store for submit/update/disconnect/disable/enable/validate; or CAS that re-deletes vault after final connection write.

### M-P0-010 — validateConnection re-enables disabled/disconnected

- **Primary:** `electron/src/main/ipc/providers.ts` (validate path) · **Sections:** S3 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Concurrent validate/submit with disable/disconnect can overwrite terminal health back to `ready`/`needs_attention`, defeating user intent for new turns.
- **Evidence:** `validateConnection` short-circuits only on snapshot health then always `connections.update({ health: ready|needs_attention })`; CREATE/UPDATE/SUBMIT/ENABLE end in validate after earlier read; concurrent DISABLE/DISCONNECT then validate’s update under ConnectionStore lock overwrites terminal health.
- **Suggested fix:** Conditional health transitions inside connection write lock (only draft|needs_attention|ready may become ready; never overwrite disabled/disconnected unless explicit enable/reconnect); pass expected prior health/generation.

### M-P0-011 — `wait_for_subagent` can hang forever

- **Primary:** `agents/manager.ts:264` + tool-dispatch + wait · **Sections:** S2, S4 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Hung or never-completing subagent blocks the parent indefinitely; UI stays “working”; background children keep consuming quota; neither tool timeout nor stream idle recovery can unblock.
- **Evidence:** `manager.wait()` awaits waiters with no max wait/deadline/AbortSignal; `TOOLS_WITHOUT_TIMEOUT` includes `wait_for_subagent`; orchestrator `pauseIdleForTool()` clears idle timer for whole tool window; wait handler awaits `manager.wait` with no outer timeout.
- **Suggested fix:** Config-backed `timeoutMs` on `SubagentManager.wait()`; accept AbortSignal so parent cancel unblocks; fail tool with `isError`; never unbounded.

### M-P0-012 — Esc-cancel + interrupt timeout orphans subagents

- **Primary:** `main/ipc/chat.ts` + interrupt-machine · **Sections:** S1, S2 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Second Esc finalizes main INTERRUPTED without `cancelRunning`; 5s timeout disposes main only—children keep tools/LLM/persist while UI thinks the turn is over. `forceStop` cancels children; Esc path inconsistent.
- **Evidence:** Second Esc sets `agentCancelled`, finalizes, advances to confirmSubagents, does not call `cancelRunning`; timeout → idle + `disposeActiveAgent` only; `cancelRunning` only on third Esc / forceAbort / forceStop.
- **Suggested fix:** On agent cancel and dispose-after-`agentCancelled`, always `cancelRunning(sessionId)` (match `forceStopSession`).

### M-P0-013 — Cross-session waiter flush

- **Primary:** `tools/subagent/interrupt.ts` + `agents/manager.ts` · **Sections:** S2 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Session B’s interrupt can unblock Session A’s blocked `wait_for_subagent` while A’s children still run—parent A continues on incomplete/empty results (cross-session timing side channel).
- **Evidence:** Session A waits on A1; Session B `interrupt_subagents` → `cancelRunning(B)` then `flushStateCallbacks()`; flush iterates **all** process-wide records and resolves every pending waiter, including A1 still non-terminal; wait returns incomplete record.
- **Suggested fix:** Remove `flushStateCallbacks` from interrupt path, or only flush waiters for records just made terminal / matching calling `sessionId`.

### M-P0-014 — App quit never terminates background process groups

- **Primary:** `main/index.ts:314` + background-store · **Sections:** S4, S1 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Detached shells/builds/PTYs survive Electron exit, holding ports/files/CPU and confusing the next session.
- **Evidence:** `before-quit` cleans MCP, IPC, config, logging but never `getBackgroundStore().terminateAll()`/`clear()`; background spawns use `detached: true` process groups; detached children survive Electron exit.
- **Suggested fix:** In before-quit (and hard-exit paths), `terminateAll()`, await short drain, force SIGKILL remaining PIDs before `app.exit`.

### M-P0-015 — MCP startup timeout false-connected

- **Primary:** `mcp/manager.ts:153` · **Sections:** S4 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** Partial MCP startup (slow later server) closes healthy earlier servers, then tools hit dead transports while status still reports connected—silent tool failures and possible orphaned stdio children.
- **Evidence:** On overall timeout, `startAll` awaits `_awaitRunner()` which stops and `client.close()`s every entry in `_clients`; status for already-connected servers remains `connected`; `_clearDisconnectedState` only drops non-connected entries; tools stay registered against closed clients.
- **Suggested fix:** On overall timeout, do not shut down the whole runner if any server is already connected—only abort remaining connects; or after forced teardown mark all failed and clear `_clients`/`_tools`/`_uriMap` entirely.

### M-P0-016 — Tool-dispatch timeout abandons detached shells

- **Primary:** `llm/tool-dispatch.ts` + execute-command · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Outer tool timeout rejects the Promise without killing the detached process group—children keep running; agent retries → more orphans; resource exhaustion outside the agent loop.
- **Evidence:** `execute_command` spawns `detached: true`; `runWithToolTimeout` only Promise.races the handler and does not signal the child; long-running payload + ~60s outer timeout leaves process group alive; SIGTERM only if execute_command’s own timeout wins the race.
- **Suggested fix:** On tool timeout, kill process group for foreground spawns; track PIDs in turn-scoped registry; reaper tied to tool cancellation.

### M-P0-017 — Agent tool path never runs Zod validation

- **Primary:** `llm/tool-dispatch.ts:144` · **Sections:** S2, S4 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** IPC validates tool args; agent loop does not. Malformed LLM args reach handlers via `input as XInput`—type checker off on the primary execution path; Zod schemas exist but are unused there.
- **Evidence:** `executeToolCall` JSON-parses args and calls `registered.handler(args, toolCtx)` without `registry.validate()`; IPC `tool:execute` does validate; handlers cast `unknown` input; registry `validate()` unused on agent path.
- **Suggested fix:** Call `registry.validate(name, args)` in `executeToolCall` and pass `validation.data`; prefer generic `ToolHandler<T>` / `z.infer` so casts disappear.

### M-P0-018 — Dual `useSession()` Config vs Chat

- **Primary:** `renderer/ConfigView.tsx:53` + ChatView + useSession · **Sections:** S5 · **Conf:** 92 · **Autofix:** manual
- **Why it matters:** App keeps ChatView mounted under Config, but ConfigView mounts a second independent `useSession()`. Selecting/creating/deleting/rebinding from Config left rail only mutates Config’s local state—ChatView can show the old conversation or chat against a deleted/stale selection until full reload.
- **Evidence:** App keeps ChatView mounted while ConfigView open (`hidden`); ConfigView and ChatView each call `useSession()` with no shared store; Config `handleSessionSelect` only `session.load` then `onClose`—never ChatView’s switch/hydrate paths; no `session:active-changed` reconciliation across instances.
- **Suggested fix:** Lift session state to a single shared store (like `useProviders`), or forward Config session actions into ChatView handlers; do not dual-mount `useSession()` for navigation while ChatView remains mounted.

### M-P0-019 — Incomplete skill/agent seedDefaults

- **Primary:** `skills/registry.ts:190` (+ agents) · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** First-run seed into `~/.orchid/skills/` leaves skill bodies without resource trees; skill tool resolves scripts/references/assets under skill dir—seeded installs get resource-not-found and broken workflows (compound, plan, resolve-pr-feedback, etc.).
- **Evidence:** `seedDefaults` only `copyFileSync` for SKILL.md/AGENT.md; 13 default skills ship refs/scripts/assets; `executeResourceRead` requires those subdirs under `skill.location`; parity tests load from full source tree, never seeded home.
- **Suggested fix:** Recursive copy of skill/agent subdirs on seed (or read-through to bundled defaults); integration test: seed temp home → load → skill resource reads succeed; re-seed missing resources without clobbering user-edited SKILL.md.

### M-P0-020 — Empty `allowed_tools` semantics split

- **Primary:** `tools/registry.ts:49` · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Empty allowlist is either “no tools” or “all tools” depending on path—silent tool starvation or accidental over-grant.
- **Evidence:** `ToolRegistry.filter([])` returns `[]`; `tools/index.ts` comment claims empty means all tools for normal subagents; `subagent-runner` coerces empty → `['*']`; main `buildToolMap` / streamChat uses raw `filter` with no empty→`*`; web-fetch AGENT.md has `allowed_tools: []`.
- **Suggested fix:** Single canonical helper `resolveAllowedToolPatterns` (empty ≡ all OR empty ≡ none); use in filter, buildToolMap, subagent-runner, and definitions UI; align comments + frontmatter.

### M-P0-021 — No `list_mcp_resources`

- **Primary:** tools/mcp + manager · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** MCP resources are enumerated into `_uriMap` at connect but never exposed as a list tool—agents must already know URIs; incomplete agent-native resource use.
- **Evidence:** Manager `listResources` only fills `_uriMap`; only tool is `read_mcp_resource(uri)`; no list_mcp_resources / list_mcp_servers tools; no resource URI injection into dynamic prompt.
- **Suggested fix:** `list_mcp_resources` returning `{uri, server, name?, description?}` from the same map; inject summary into dynamic system prompt.

### M-P0-022 — `read_mcp_resource` not on general agent

- **Primary:** `agents/defaults/general/AGENT.md` · **Sections:** S6 · **Conf:** 90 · **Autofix:** safe_auto
- **Why it matters:** Tool is registered and parity inventory expects it, but main agent allowlist omits it—general cannot read MCP resources even when URIs are known.
- **Evidence:** Tool registered in `tools/mcp/resource.ts` + `tools/index.ts`; parity expects `read_mcp_resource`; general `allowed_tools` lists `mcp::context7::*` / `mcp::example::*` but not `read_mcp_resource`.
- **Suggested fix:** Add `read_mcp_resource` to general (and any agent that should use MCP data); prefer coherent `mcp::*` + resource allowlist.

### M-P0-023 — No AST index management tool

- **Primary:** tools/ast · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** UI has `/ast index` and RAG has `rag_index` (status|index|clear); agents cannot force rebuild, clear, or inspect AST status mid-turn—stale index after large refactors is a silent failure mode.
- **Evidence:** AST tools are skeleton/function/refs/rename/replace only; some call `ensureIndexed` as side effect; RAG has `rag_index` action enum; AST IPC has status/index; no tool wrapper.
- **Suggested fix:** Add `ast_index` tool mirroring `rag_index` (status|index|clear), reusing indexer APIs.

### M-P0-024 — Session lifecycle + model change UI-only

- **Primary:** commands + session IPC · **Sections:** S6, S1 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Core multi-session product (`/new`, `/sessions`, `/rename`, `/delete`, `/model`) is UI/IPC-only—agent cannot create, switch, rename, delete sessions or change session model mid-session.
- **Evidence:** `renderer/commands/registry.ts` defines session/model commands; `session:*` IPC; no session_list/create/load/rename/delete or session_change_model tools; coding tools do not rebind session selection.
- **Suggested fix:** Session primitives over same `SessionManager` as UI (`session_list`, `session_create`, `session_load`, `session_rename`, `session_delete`, `session_change_model` with typed selection); emit existing `SESSION_*` events for UI refresh.

---

## P1 — High (98)

| ID | Title | Primary file | Sections | Conf | Autofix |
|----|-------|--------------|----------|------|---------|
| M-P1-001 | `bgcmd:snapshot` has no session/window ownership check | `main/ipc/chat.ts:1733` | S1 | 100 | gated_auto |
| M-P1-002 | `session:change_model` reports success on no-op | `main/ipc/session.ts:304` | S1 | 100 | safe_auto |
| M-P1-003 | `session:rename` always emits renamed on no-op | `main/ipc/session.ts:285` | S1 | 100 | safe_auto |
| M-P1-004 | `unregisterChatIPC` tears down agents without releasing MCP leases | `main/ipc/chat.ts:1762` | S1, S2 | 100 | safe_auto |
| M-P1-005 | macOS signed-build detection uses build-time env vars at runtime | `main/index.ts:277` | S1 | 100 | gated_auto |
| M-P1-006 | macOS `activate` recreates window without rebinding updater `mainWindowRef` | `main/index.ts:306` | S1 | 75 | gated_auto |
| M-P1-007 | `chat:send` with `sessionId` re-selects session mid-flight (selection steal) | `main/ipc/chat.ts:577` | S1 | 75 | gated_auto |
| M-P1-008 | `before-quit` always `preventDefault` without re-entrancy/deadline | `main/index.ts:314` | S1 | 75 | gated_auto |
| M-P1-009 | Graceful shutdown can hang: `FileLogger.close` has no timeout | `main/index.ts` + `logging.ts` | S1 | 75 | gated_auto |
| M-P1-010 | MCP SSE `url` from config enables main-process SSRF | `mcp/transport.ts:32` | S1, S4 | 75 | gated_auto |
| M-P1-011 | `session:set_workspace` binds any absolute readable dir without dialog | `main/ipc/session.ts:355` | S1 | 100 | gated_auto |
| M-P1-012 | Composition: `set_workspace` + `tool:execute` rebinds cwd then reads secrets | session + tool IPC | S1 | 100 | manual |
| M-P1-013 | Concurrent draft `chat:send` creates duplicate sessions / dual streams | `main/ipc/chat.ts:563` | S1 | 75 | manual |
| M-P1-014 | Updater events allowlisted/emitted but never on `OrchidAPI`/preload | `preload/index.ts:360` | S1, S6 | 100 | manual |
| M-P1-015 | Preload event listeners trust unchecked `as Event` casts | `preload/index.ts:118` | S1 | 100 | gated_auto |
| M-P1-016 | `invoke()` return type is an unchecked `Promise` cast | `preload/index.ts:84` | S1 | 100 | gated_auto |
| M-P1-017 | Allowlists are `readonly string[]` instead of `IPCChannel` literals | `shared/types/ipc.ts:838` | S1 | 100 | safe_auto |
| M-P1-018 | `ChatSendResult` is open `status`/`kind` strings, not a closed union | `shared/types/ipc.ts:512` | S1 | 100 | manual |
| M-P1-019 | `ConfigSaveMessage` is `Partial<Config>` but runtime is tombstone PATCH | `shared/types/ipc.ts:247` | S1, S3 | 92 | manual |
| M-P1-020 | `chat.ts` is a ~1779-line god module | `main/ipc/chat.ts:1` | S1 | 100 | manual |
| M-P1-021 | `providers` IPC imports `main/index` → circular dependency | `main/ipc/providers.ts:30` | S1, S3 | 100 | gated_auto |
| M-P1-022 | app-shell IPC Zod tests reimplement weaker schemas than production | `tests/integration/app-shell.test.ts:142` | S1 | 100 | gated_auto |
| M-P1-023 | Critical IPC modules lack dedicated handler tests | `electron/tests/unit` | S1 | 100 | manual |
| M-P1-024 | No first-class agent-native command surface for full UI capability set | `shared/commands.ts` + tools | S1, S6 | 85 | advisory |
| M-P1-025 | `JSON.parse` on history tool_calls can crash entire stream turn | `llm/orchestrator.ts:249` | S2 | 100 | safe_auto |
| M-P1-026 | Subagent final result ignores tool-only work (empty wait payload) | `agents/manager.ts:463` | S2 | 100 | gated_auto |
| M-P1-027 | Interrupted subagent drops in-flight partial assistant text | `agents/manager.ts:533` | S2 | 75 | gated_auto |
| M-P1-028 | `toApiMessages` match-set keeps filtered-out tool_call ids | `llm/history.ts:167` | S2 | 75 | gated_auto |
| M-P1-029 | Tool timeout does not cancel underlying work | `llm/tool-dispatch.ts:270` | S2, S4 | 100 | gated_auto |
| M-P1-030 | Retry backoff sleep ignores abort/cancel | `llm/middleware/retry.ts:43` | S2 | 100 | gated_auto |
| M-P1-031 | Retry only covers `doStream()` setup, not mid-stream drops | `llm/middleware/retry.ts:86` | S2 | 75 | manual |
| M-P1-032 | Conversation history unbounded; full re-send every turn | session + history + orchestrator | S2 | 90 | manual |
| M-P1-033 | Every chain/subagent persist rewrites full pretty-printed session JSON + fsync | `session/storage.ts` | S2 | 85 | manual |
| M-P1-034 | SubagentManager never prunes records (process lifetime) | `agents/manager.ts` | S2 | 93 | gated_auto |
| M-P1-035 | Subagent tool events → debounced full-session rewrites of all chains | wire-subagents + persist | S2 | 80 | gated_auto |
| M-P1-036 | Subagent `Chain.sessionId` is subagent id, not session UUID | `agents/manager.ts:656` | S2 | 90 | gated_auto |
| M-P1-037 | Asymmetric restore: subagents → INTERRUPTED; chains keep ACTIVE | `shared/types/chain.ts` | S2 | 85 | gated_auto |
| M-P1-038 | Dual SubagentRecord / status enums + third `SubagentState` prompt DTO | manager + subagent.ts + system-prompt | S2 | 90 | manual |
| M-P1-039 | Explicit `any` tool map disables type checking at LLM tool boundary | `orchestrator.ts:726` | S2 | 92 | gated_auto |
| M-P1-040 | Unsafe double cast Zod→AI SDK in context-snapshot | `context-snapshot.ts:32` | S2 | 88 | gated_auto |
| M-P1-041 | `fullStream` / `onStepFinish` cast away SDK discriminants | `orchestrator.ts:411` | S2 | 80 | gated_auto |
| M-P1-042 | Cancelled turns leave in-flight tools running (no abortSignal) | tool-dispatch + orchestrator | S2 | 85 | gated_auto |
| M-P1-043 | CLAUDE.md documents non-existent agent modules | `electron/CLAUDE.md` | S2, S6 | 100 | safe_auto |
| M-P1-044 | Tier override affects model selection but not `Agent.tier` on record | `tools/subagent/delegate.ts:107` | S2 | 75 | gated_auto |
| M-P1-045 | Unscoped subagent persist falls back to active session | `persist-subagent-chains.ts:47` | S2 | 75 | gated_auto |
| M-P1-046 | HTTPS custom endpoints: no destination allowlist (credential SSRF) | `drivers/compatible.ts:21` | S3 | 75 | manual |
| M-P1-047 | Loopback check treats any hostname starting with `127.` as local | `drivers/compatible.ts:17` | S3 | 100 | safe_auto |
| M-P1-048 | Vault + connection mutations multi-step without joint atomicity | `main/ipc/providers.ts:631` | S3 | 85 | manual |
| M-P1-049 | `submit_api_key` binds vault origin from stale snapshot while endpoint mutates | `main/ipc/providers.ts` | S3 | 85 | manual |
| M-P1-050 | Invalid home config fails closed by quitting entire app | `config/loader.ts:215` | S3 | 85 | gated_auto |
| M-P1-051 | Dual model resolution: incomplete custom models allowed at resolve, rejected at gate | `providers/resolver.ts:70` | S3 | 88 | gated_auto |
| M-P1-052 | `mcp_servers` untyped nested bag on Config / IPC boundary | `ipc-boundary.ts:114` | S1, S3, S4 | 88 | manual |
| M-P1-053 | Agent has ~0% action parity on provider/config ops | tools + system-prompt | S3, S6 | 100 | manual |
| M-P1-054 | Context starvation: no provider/config (and little product state) in system prompt | `llm/system-prompt.ts` | S3, S6 | 100 | gated_auto |
| M-P1-055 | `providers:update` builds candidate via `as ProviderConnection` | `main/ipc/providers.ts:607` | S1, S3 | 78 | gated_auto |
| M-P1-056 | Config dual source: hand-written `Config` vs Zod schema | `config/schema.ts` | S3 | 82 | manual |
| M-P1-057 | Accounting middleware `wrapGenerate` completely untested | `accounting/middleware.ts:111` | S3 | 90 | manual |
| M-P1-058 | Provider IPC `validate` / `enable` / `status_refresh` untested | `main/ipc/providers.ts:651` | S3 | 88 | manual |
| M-P1-059 | Vault fail-closed/corruption paths largely untested | `credentials/vault.ts` | S3 | 85 | manual |
| M-P1-060 | Accounting store singleton init/fail-closed API untested | `accounting/store.ts:356` | S3 | 85 | manual |
| M-P1-061 | Middleware cost evidence (headers + Neuralwatt) never exercised | `accounting/middleware.ts:60` | S3 | 82 | manual |
| M-P1-062 | Child processes inherit full `process.env` (secret leak) | background-store / execute | S4 | 75 | gated_auto |
| M-P1-063 | AST `rename_symbol` requires `file_path` but never uses it | `tools/ast/rename-symbol.ts:21` | S4 | 95 | gated_auto |
| M-P1-064 | RAG partial-path index deletes all other indexed files | `rag/indexer.ts:386` | S4 | 90 | gated_auto |
| M-P1-065 | `rag_search` always local ONNX; index may use API embedder | `tools/rag/search.ts:72` | S4 | 90 | gated_auto |
| M-P1-066 | `read_mcp_resource` treats MCP error strings as success | `tools/mcp/resource.ts:60` | S4 | 90 | gated_auto |
| M-P1-067 | MCP runner shutdown abandons hung `client.close` after 3s | `mcp/manager.ts:497` | S4 | 82 | gated_auto |
| M-P1-068 | HF model download fetch has no timeout | `rag/embedder.ts:572` | S4 | 95 | gated_auto |
| M-P1-069 | AST/RAG index workers no overall timeout/cancel | `ast/indexer.ts:376` | S4 | 85 | gated_auto |
| M-P1-070 | Foreground `waitForExit` unbounded after kill | `execute-command.ts:299` | S4 | 80 | gated_auto |
| M-P1-071 | RAG SQLite no `busy_timeout` (AST has 5000) | `rag/store.ts:244` | S4 | 78 | safe_auto |
| M-P1-072 | RAG holds full vector corpus as `number[][]` | rag indexer + store | S4 | 90 | manual |
| M-P1-073 | `glob` fully sync + unbounded matches | `tools/filesystem/glob.ts` | S4 | 92 | gated_auto |
| M-P1-074 | `grep` full-tree full-file load, no size bound | `tools/search/grep.ts` | S4 | 88 | gated_auto |
| M-P1-075 | AST stores every reference; tools return unbounded | ast store + tools | S4 | 85 | gated_auto |
| M-P1-076 | Main RAG search cache stale after worker reindex | `rag/store.ts` cache | S4 | 80 | gated_auto |
| M-P1-077 | Concurrent AST rename partial multi-file write | `rename-symbol.ts` | S4 | 75 | gated_auto |
| M-P1-078 | Explicit `any` in `zodToJsonSchema` conversion | `tools/registry.ts:84` | S4 | 95 | gated_auto |
| M-P1-079 | Tree-sitter surface entirely `any`-typed | `ast/parser.ts:34` | S4 | 92 | gated_auto |
| M-P1-080 | Fallback MCP manager partial object cast to full MCPManager | `tools/index.ts:67` | S4 | 90 | gated_auto |
| M-P1-081 | MCP tool inputs passthrough Zod | `mcp/manager.ts:656` | S4 | 85 | gated_auto |
| M-P1-082 | MCP config untyped Record cast at project boundary | `mcp/project-registry.ts:18` | S4 | 82 | manual |
| M-P1-083 | Interactive PTY path untested | process tools | S4 | 90 | manual |
| M-P1-084 | `rag_index` / `rag_search` handlers never executed in tests | tools/rag | S4 | 93 | manual |
| M-P1-085 | AST indexing uses live `getConfig()`, not frozen project runtime | `ast/indexer.ts:217` | S4 | 90 | gated_auto |
| M-P1-086 | `getBuiltinToolRegistryForRuntime` caches first options forever | `tools/index.ts:284` | S4 | 80 | gated_auto |
| M-P1-087 | MCP allowlist naive regex vs minimatch for builtins | `llm/orchestrator.ts:784` | S4, S6 | 85 | gated_auto |
| M-P1-088 | Composer `isSendingRef` sticks after silent send gates | `renderer/InputArea.tsx:383` | S5 | 100 | gated_auto |
| M-P1-089 | Esc/cancel has no mutual exclusion across stages | `renderer/hooks/useChat.ts:757` | S5 | 75 | gated_auto |
| M-P1-090 | `chat.send` catch leaves optimistic bubble + half-stream state | `renderer/hooks/useChat.ts:748` | S5 | 78 | gated_auto |
| M-P1-091 | GeneralTab cannot set `llm_stream_retries` to 0 | `Preferences/GeneralTab.tsx:64` | S5 | 95 | safe_auto |
| M-P1-092 | RAGTab cannot set `chunk_overlap` to 0 | `Preferences/RAGTab.tsx:80` | S5 | 93 | safe_auto |
| M-P1-093 | Config draft is untyped `Record` with cast-to-Config | `ConfigView.tsx:65` | S5 | 90 | gated_auto |
| M-P1-094 | `orchid:config-updated` treats `default_model` as ModelSelection without narrowing | `ChatView.tsx:181` | S5 | 82 | gated_auto |
| M-P1-095 | 100ms elapsed ticker rebuilds full chat history every tick | `useChat.ts:317` + ChatStream | S5 | 95 | gated_auto |
| M-P1-096 | Unbatched per-token stream updates thrash ChatView tree | `useChat.ts:342` | S5 | 92 | gated_auto |
| M-P1-097 | Streaming assistant fully re-parses markdown every chunk | `MarkdownContent.tsx:91` | S5 | 90 | gated_auto |
| M-P1-098 | Command palette navigation dispatches dead `orchid:navigate` | `CommandPalette.tsx:345` | S5 | 100 | gated_auto |
| M-P1-099 | Domain hook `useChat` imports UI `ContextGrid` for pure math | `useChat.ts:29` | S5 | 88 | gated_auto |
| M-P1-100 | `useChat` / `useSession` / `useSessionTabs` behavioral surface almost untested | renderer hooks + tests | S5 | 90 | manual |
| M-P1-101 | Preferences/onboarding tests assert mocks/booleans, not ConfigView | `preferences-onboarding.test.ts` | S5 | 95 | manual |
| M-P1-102 | Omitted `allowed_skills` defaults to `['*']` for several default agents | `agents/registry.ts:87` | S6 | 100 | gated_auto |
| M-P1-103 | Skill discovery claimed in system prompt but prompt injects no skill inventory | system-prompt + skill.ts | S6 | 100 | gated_auto |
| M-P1-104 | general AGENT.md identity: “terminal-based coding agent” in Electron desktop | `general/AGENT.md:39` | S6 | 100 | safe_auto |
| M-P1-105 | Command palette actions without agent tools (/cd, /model, /sessions, …) | `renderer/commands/registry.ts` | S6 | 85 | manual |
| M-P1-106 | Workspace rebind (`/cd`) no agent equivalent | session IPC | S6 | 100 | manual |
| M-P1-107 | Personality switch UI-only | commands | S6 | 100 | manual |
| M-P1-108 | Definition CRUD (agents/skills/personalities) UI-only | defs IPC | S6 | 100 | manual |
| M-P1-109 | General MCP allowlist hard-coded to context7/example | `general/AGENT.md` | S6 | 75 | gated_auto |
| M-P1-110 | system-prompt branches largely untested | `llm/system-prompt.ts` | S6 | 100 | manual |
| M-P1-111 | web-fetch summarizer production wiring untested | `tools/index.ts` | S6 | 75 | manual |

*Note: M-P1-053/054/014/024/043/087/052 are cross-section merges; original S3 “config agent orphan P0” is M-P1-053.*

---

## P2 — Moderate (89)

| ID | Title | Primary file | Sections | Conf | Autofix |
|----|-------|--------------|----------|------|---------|
| M-P2-001 | Stream error path never completes activity to terminal idle | `chat.ts:1499` | S1 | 50 | advisory |
| M-P2-002 | Auto-update `signed` gate ineffective on non-macOS packaged builds | `index.ts:277` | S1 | 50 | gated_auto |
| M-P2-003 | `quitAndInstall` strips all `before-quit` cleanup | `updater.ts:202` | S1 | 75 | gated_auto |
| M-P2-004 | `tool:execute` has no timeout or abort | `tool.ts:113` | S1 | 75 | gated_auto |
| M-P2-005 | RAG/AST index IPC has no cancel/abort once started | `ipc/rag.ts:58` | S1 | 50 | manual |
| M-P2-006 | Cancel/stop status kinds untyped (`status: string`) | `ipc.ts` / OrchidAPI | S1, S5 | 100 | manual |
| M-P2-007 | `session:change_model` response richer than OrchidAPI documents | `ipc.ts:614` | S1 | 100 | manual |
| M-P2-008 | `ChatStateEvent.state` widened to `string` vs closed snapshot union | `ipc.ts:172` | S1 | 100 | manual |
| M-P2-009 | Inconsistent IPC error shapes (throw vs structured vs soft-success) | multi IPC | S1, S3 | 82 | manual |
| M-P2-010 | Definition save Zod accepts names `DEFINITION_NAME_PATTERN` later rejects | `ipc/definitions.ts:31` | S1 | 75 | manual |
| M-P2-011 | `config:save` double `unknown` cast for merge | `ipc/config.ts:166` | S1 | 75 | gated_auto |
| M-P2-012 | Status-bearing IPC results mostly `{ status: string }` | `ipc.ts:555` | S1 | 75 | manual |
| M-P2-013 | Unbounded `chat:send` message size | `chat.ts:79` | S1 | 75 | gated_auto |
| M-P2-014 | Definition save unbounded `system_prompt`/content | `definitions.ts:33` | S1 | 75 | gated_auto |
| M-P2-015 | `chat:stop`/`chat:cancel` any `sessionId` without ownership | `chat.ts:1589` | S1 | 75 | gated_auto |
| M-P2-016 | `bgcmd:snapshot` `lastN` has no upper bound | `chat.ts:99` | S1 | 75 | safe_auto |
| M-P2-017 | `chat-history` params/docs still say `windowId`, callers use `sessionId` | `chat-history.ts:10` | S1 | 100 | safe_auto |
| M-P2-018 | IPC Zod schemas private; no shared export for contract tests | `main/ipc/` | S1 | 100 | manual |
| M-P2-019 | `providers.ts` second large mixed-concern module (~801 lines) | `ipc/providers.ts` | S1, S3 | 75 | manual |
| M-P2-020 | Allowlist completeness tests partial vs full `IPC_CHANNELS` | `app-shell.test.ts:80` | S1 | 100 | gated_auto |
| M-P2-021 | `electron/CLAUDE.md` documents non-existent IPC modules / wrong paths | `electron/CLAUDE.md` | S1, S3, S4, S6 | 100 | safe_auto |
| M-P2-022 | `tool:execute` no IPC tests and no renderer consumers | `ipc/tool.ts` | S1 | 75 | manual |
| M-P2-023 | XState snapshot context repeatedly asserted as `AgentContext` | `chat.ts:300` | S1 | 50 | gated_auto |
| M-P2-024 | `ActiveAgent.abortController` never wired to stream AbortController | `ipc/chat.ts:1035` | S2 | 75 | gated_auto |
| M-P2-025 | Esc phase 2 does not cancel subagents until third Esc (design + orphaning) | `chat.ts:1638` | S2 | 75 | advisory |
| M-P2-026 | Agent machine ERROR nulls abortController while invoke races | `agent-machine.ts:394` | S2 | 50 | gated_auto |
| M-P2-027 | Provider-quirks mid-stream suppression cannot see stream errors | `provider-quirks.ts:99` | S2 | 75 | gated_auto |
| M-P2-028 | Throttle timer can fire after stream teardown | `throttle.ts:80` | S2 | 75 | safe_auto |
| M-P2-029 | `toolsInFlight` can stick if tool-result never arrives | `orchestrator.ts:346` | S2 | 75 | gated_auto |
| M-P2-030 | No concurrency/spawn-rate limit on `delegate_to_subagent` | delegate + manager | S2 | 80 | gated_auto |
| M-P2-031 | `wait_for_subagent` injects full result without offload | `wait.ts` | S2 | 72 | gated_auto |
| M-P2-032 | Historical THINKING fully replayed every request | `history.ts` | S2 | 70 | gated_auto |
| M-P2-033 | Two public SubagentRecord shapes (runtime vs domain) | manager vs shared | S2 | 80 | manual |
| M-P2-034 | Domain SubagentRecord mixes snake_case and camelCase | `subagent.ts:29` | S2 | 75 | manual |
| M-P2-035 | `subagentRecordSchema` incomplete vs type | `subagent.ts:61` | S2 | 70 | manual |
| M-P2-036 | Domain agent type/tier plain `string` | `subagent.ts:32` | S2 | 82 | gated_auto |
| M-P2-037 | Enum narrowing via Set + assertion | `agents/registry.ts:96` | S2 | 78 | gated_auto |
| M-P2-038 | Session load trusts `JSON.parse` cast | `session/storage.ts:224` | S2 | 72 | gated_auto |
| M-P2-039 | Mid-turn cancel: tool_call without tool_result until filter drops | chat + history | S2 | 78 | gated_auto |
| M-P2-040 | Overlapping chat:send after hydrate can abort just-started peer turn | `chat.ts` | S2 | 72 | gated_auto |
| M-P2-041 | God-modules: orchestrator ~930 + session/agent managers | multi | S2 | 75 | manual |
| M-P2-042 | Tool handlers type assertions vs Zod parse | subagent tools | S2 | 65 | gated_auto |
| M-P2-043 | Log redaction misses non-`sk-` key formats | `logging.ts:55` | S3 | 50 | safe_auto |
| M-P2-044 | `storeApiKey` appends generations (orphan secrets) | `vault.ts:331` | S3 | 100 | gated_auto |
| M-P2-045 | Session cost totals attach global `unknownCount` to every currency row | `accounting/store.ts:329` | S3 | 100 | safe_auto |
| M-P2-046 | Stream attempt can finalize succeeded without finish usage | `accounting/middleware.ts:201` | S3 | 75 | gated_auto |
| M-P2-047 | `config:save` persists values `validateConfig` rejects | `ipc/config.ts:171` | S3 | 75 | gated_auto |
| M-P2-048 | ProviderStatusCache `put()` no write serialization | `status/cache.ts:162` | S3 | 85 | gated_auto |
| M-P2-049 | Status refresh coalescing ignores manual vs automatic | `status/service.ts:140` | S3 | 80 | gated_auto |
| M-P2-050 | Corrupt config JSON silently treated as empty layer | `loader.ts:49` | S3 | 75 | gated_auto |
| M-P2-051 | `config:save` rejects `providers` while types/tombstones still treat it writable | multi | S3 | 88 | manual |
| M-P2-052 | `ProviderStatusView.data` unversioned open bag | `ipc.ts:311` | S1, S3 | 72 | manual |
| M-P2-053 | `FrozenProviderRequestSnapshot.protocol` is `string` | `accounting.ts:59` | S3 | 85 | gated_auto |
| M-P2-054 | Accounting provenance bags open `unknown` | `accounting.ts:37` | S3 | 76 | manual |
| M-P2-055 | SQLite rows cast to `AttemptRow` without row Zod | `accounting/store.ts:282` | S3 | 74 | gated_auto |
| M-P2-056 | Config validation blanket unknown casts | `validation.ts:113` | S3 | 72 | gated_auto |
| M-P2-057 | `environmentVariable!` non-null assertion | `ipc/providers.ts:549` | S3 | 70 | gated_auto |
| M-P2-058 | Connection rules triplicated (IPC / resolver / registry) | multi | S3 | 75 | manual |
| M-P2-059 | Fresh driver registry on every `services()` | `ipc/providers.ts:148` | S3 | 75 | safe_auto |
| M-P2-060 | `deepMergeProviderDict` name obsolete | `config/merge.ts:76` | S3 | 75 | safe_auto |
| M-P2-061 | Empty `providers` config field permanent shim | `schema.ts:41` | S3 | 75 | manual |
| M-P2-062 | Zod and `validateConfig` duplicate constraints | `validation.ts:89` | S3 | 75 | manual |
| M-P2-063 | `customModels` can override catalog model metadata for same id | `resolver.ts` | S3 | 85 | gated_auto |
| M-P2-064 | Disconnect deletes vault before health flips (race window) | `ipc/providers.ts` | S3 | 75 | gated_auto |
| M-P2-065 | Resolver lifecycle unavailability reasons untested | `resolver.ts` | S3 | 80 | manual |
| M-P2-066 | Config IPC `model_metadata` / `list_personalities` / unknown-key untested | `ipc/config.ts` | S3 | 78 | manual |
| M-P2-067 | Catalog transport/coalescing under-tested | catalog updater | S3 | 75 | manual |
| M-P2-068 | Cost formula reasoning branches under-tested | `cost.ts` | S3 | 75 | manual |
| M-P2-069 | Docs: `connections.json` vs actual `providers.json` | CLAUDE.md vs store | S3 | 80 | safe_auto |
| M-P2-070 | Docs: project config path `.orchid/config.json` vs `.orchid.json` | CLAUDE.md vs loader | S3 | 80 | safe_auto |
| M-P2-071 | `config:model_metadata` skips Zod at IPC boundary | `ipc/config.ts:128` | S3 | 90 | gated_auto |
| M-P2-072 | Skill resource path no realpath (symlink escape) | `skill/skill.ts:202` | S4 | 75 | gated_auto |
| M-P2-073 | AST rename write without containment | `rename-symbol.ts:111` | S4 | 50 | gated_auto |
| M-P2-074 | web_fetch unescaped URL/title in XML | `fetch.ts:341` | S4 | 50 | safe_auto |
| M-P2-075 | Glob/grep from `/` when absolute directory_path | multi | S4 | 75 | gated_auto |
| M-P2-076 | ensureIndexed waiters after failed concurrent index | `ast/indexer.ts:123` | S4 | 88 | gated_auto |
| M-P2-077 | Sticky `default_project_dir` memory vs disk abort | `workspace.ts:89` | S4 | 85 | gated_auto |
| M-P2-078 | RAG `readAndHash` ignores frozen config for max_file_size | `indexer.ts:597` | S4 | 82 | gated_auto |
| M-P2-079 | AST `initializedProjects` never re-indexes if DB cleared | `indexer.ts:156` | S4 | 80 | gated_auto |
| M-P2-080 | grep concurrent can exceed max_results | `grep.ts:261` | S4 | 78 | gated_auto |
| M-P2-081 | background_command_idle_timeout never kills idle processes | background-store | S4 | 72 | advisory |
| M-P2-082 | HeadTailBuffer Buffer.concat every append | head-tail-buffer | S4 | 82 | gated_auto |
| M-P2-083 | RAG/AST discovery Promise.all fan-out | indexers | S4 | 78 | gated_auto |
| M-P2-084 | MCP sequential server startup | manager.ts | S4 | 76 | gated_auto |
| M-P2-085 | callTool timeout does not cancel server work | manager.ts | S4 | 75 | gated_auto |
| M-P2-086 | write/edit full content / LCS blowup | write/edit | S4 | 80 | gated_auto |
| M-P2-087 | atomicWrite temp name collision concurrent writers | ast/utils | S4 | 70 | gated_auto |
| M-P2-088 | Background process union not discriminated | background-store | S4 | 80 | gated_auto |
| M-P2-089 | Todo storage unchecked casts | `shared/todo.ts` | S4 | 78 | gated_auto |
| M-P2-090 | send_input / wait_ms / agentScope visibility test gaps | process tools tests | S4 | 90 | manual |
| M-P2-091 | CLAUDE.md documents non-existent `layers.ts` | CLAUDE.md | S4 | 100 | safe_auto |
| M-P2-092 | loadSkills mutates process-wide registry | skills/registry | S4, S6 | 80 | gated_auto |
| M-P2-093 | `hydrateSnapshot` drops buffered events when `live` is null | `useChat.ts:917` | S5 | 72 | gated_auto |
| M-P2-094 | Config session delete/create does not refresh ChatView list | ConfigView | S5 | 80 | gated_auto |
| M-P2-095 | New stream always yanks scroll to bottom | `ChatStream.tsx:184` | S5 | 75 | gated_auto |
| M-P2-096 | MCP server config stays `Record` with unchecked casts (renderer) | MCPServersTab | S5 | 80 | gated_auto |
| M-P2-097 | RAG number handler casts onto every RAGConfig field | RAGTab | S5 | 78 | gated_auto |
| M-P2-098 | OrchidAPI required on Window but renderer uses optional everywhere | hooks | S5 | 74 | advisory |
| M-P2-099 | Message list fully mounted; no virtualization/memo | ChatStream | S5 | 82 | gated_auto |
| M-P2-100 | smooth `scrollIntoView` every streamingContent change | ChatStream | S5 | 85 | gated_auto |
| M-P2-101 | `toolBlocks` in history deps forces O(n) rebuild on tool churn | ChatStream | S5 | 80 | gated_auto |
| M-P2-102 | Slash menu + palette duplicate selection/filter pipelines | InputArea + CommandPalette | S5 | 92 | manual |
| M-P2-103 | ChatView monolithic orchestrator (~1.1k LOC) | ChatView | S5 | 80 | manual |
| M-P2-104 | `orchid:theme-applied` dispatched with no product listeners | themes/index.ts | S5 | 95 | safe_auto |
| M-P2-105 | `useGlobalShortcuts` / ChatView orchestration / focus trap test gaps | keyboard + ChatView | S5 | 85 | manual |
| M-P2-106 | Roving-list test reimplements clamp math instead of hook | roving-list-index.test.ts | S5 | 80 | gated_auto |
| M-P2-107 | loadAgents/loadSkills mutate process-wide tool singleton | registries | S6 | 75 | gated_auto |
| M-P2-108 | docs/solutions Python-only; Electron domains unrepresented | docs/solutions | S1–S6 | 100 | advisory |
| M-P2-109 | Runtime tool registry WeakMap cache untested | tools/index.ts | S6 | 75 | manual |
| M-P2-110 | Agent invalid-tier skip untested | agents/registry | S6 | 100 | manual |
| M-P2-111 | Reserved internal agents only partially guarded in tests | agents/registry | S6 | 75 | manual |
| M-P2-112 | buildModelResults/buildSessionResults untested | commands/registry | S6 | 100 | manual |
| M-P2-113 | Command execute error paths untested | commands/registry | S6 | 75 | manual |
| M-P2-114 | File delete no first-class tool (shell only) | tools | S6 | 75 | manual |
| M-P2-115 | `rag_index` Decision-enum mild anti-pattern | tools/rag | S6 | 70 | advisory |

---

## P3 — Low (28)

| ID | Title | Primary file | Sections | Conf | Autofix |
|----|-------|--------------|----------|------|---------|
| M-P3-001 | Updater channel docs disagree with `IPC_CHANNELS` names | `updater.ts:10` | S1 | 100 | safe_auto |
| M-P3-002 | No IPC versioning/deprecation surface | `ipc.ts:718` | S1 | 50 | advisory |
| M-P3-003 | Updater check/download no concurrency/hang guard | `updater.ts:164` | S1 | 50 | gated_auto |
| M-P3-004 | No rate limits on expensive IPC (index, tool, chat) | `rag.ts:59` | S1 | 75 | advisory |
| M-P3-005 | Message factories omit `MessageType.ERROR` | message-factories.ts | S2 | 65 | gated_auto |
| M-P3-006 | `ApiMessage` untyped role/content unions | message.ts:121 | S2 | 65 | gated_auto |
| M-P3-007 | Duplicate `toApiMessages edge cases` describe block in tests | llm-orchestrator.test.ts | S2 | 75 | safe_auto |
| M-P3-008 | `wait_for_subagent` under-signals ownership/not-found (`isError`) | wait.ts:70 | S2 | 65 | gated_auto |
| M-P3-009 | XState is thin stream shell; docs imply full agentic loop | agent-machine + CLAUDE | S2 | 75 | advisory |
| M-P3-010 | Env numeric overrides can inject NaN | merge.ts:338 | S3 | 75 | safe_auto |
| M-P3-011 | Disconnect interrupt wins over late stream success (cost loss) | accounting store | S3 | 75 | advisory |
| M-P3-012 | `validateConfig` errors never enforced at runtime | loader.ts:294 | S3 | 70 | gated_auto |
| M-P3-013 | Provider create `modelIds` required in TS, defaulted in Zod | ipc.ts | S3 | 78 | gated_auto |
| M-P3-014 | Accounting types internal-only (no IPC) | accounting.ts | S3 | 70 | advisory |
| M-P3-015 | Stale U8 “until then” comment on config IPC | ipc/config.ts:5 | S3 | 100 | safe_auto |
| M-P3-016 | No permanent connection hard-delete API | connection-store | S3 | 100 | advisory |
| M-P3-017 | Interactive PTY uses user SHELL with full env | background-store | S4 | 50 | advisory |
| M-P3-018 | MCP error prefix-based detection fragile | manager.ts | S4 | 75 | gated_auto |
| M-P3-019 | drainAbort controllers unused | background-store | S4 | 65 | safe_auto |
| M-P3-020 | Runtime registry keyed by untyped `object` | tools/index.ts | S4 | 80 | gated_auto |
| M-P3-021 | Embedder non-null tensor assertions | embedder.ts | S4 | 72 | gated_auto |
| M-P3-022 | Skill catalog embedded in Zod `.describe()` | skill.ts | S4 | 65 | gated_auto |
| M-P3-023 | Todo notify createRequire electron | tools/index.ts | S4 | 70 | manual |
| M-P3-024 | MCP string `Error:` protocol vs structured isError | manager + orchestrator | S4 | 75 | gated_auto |
| M-P3-025 | `acceptChatEvent` can latch streamSessionId on first draft event | useChat | S5 | 55 | gated_auto |
| M-P3-026 | GeneralTab number handler ignores invalid/zero (UX snap-back) | GeneralTab | S5 | 70 | gated_auto |
| M-P3-027 | Custom DOM events use unchecked CustomEvent casts | App.tsx | S5 | 72 | gated_auto |
| M-P3-028 | `filter(Boolean) as Command[]` | CommandPalette | S5 | 68 | safe_auto |
| M-P3-029 | Vacuous keyboard shortcut tests (literal equality) | command-palette / preferences tests | S5, S6 | 100 | safe_auto |
| M-P3-030 | Silent agent skip on invalid frontmatter (no log) | agents/registry | S6 | 85 | gated_auto |
| M-P3-031 | shared/commands.ts overclaimed as command inventory | CLAUDE.md | S6 | 100 | safe_auto |
| M-P3-032 | Theme / working-set / activity chrome intentionally agent-out | — | S6 | — | advisory |

---

## Cross-section merge map (major)

| Master ID | Merged section rows |
|-----------|---------------------|
| M-P0-001 | S1#1, S3#12 (partial), S4#4 related |
| M-P0-004 | S1#2, S4#11 |
| M-P0-011 | S2#1, S4#49 |
| M-P0-012 | S1#9, S2#2 |
| M-P0-014 | S4#5 (+ S1 before-quit theme) |
| M-P0-017 | S2#19, S4#8 |
| M-P0-019 | S4#60, S6#1 |
| M-P0-020 | S4#37, S6#2 |
| M-P0-021 | S4#38, S6#3 |
| M-P0-023 | S4#62, S6#5 |
| M-P1-004 | S1#6, S2#31 |
| M-P1-010 | S1#13, S4#9 |
| M-P1-014 | S1#17, S6#17 |
| M-P1-019 | S1#22, S3#10 |
| M-P1-021 | S1#24, S3#15 |
| M-P1-029 | S2#8, S4 tool-timeout theme |
| M-P1-052 | S1#41, S3#12, S4#31 |
| M-P1-053 | S3#13, S6#7 |
| M-P1-054 | S3#14, S6#8/16 |
| M-P1-087 | S4#36, S6#24 |
| M-P2-006 | S1 cancel status, S5 chat.cancel |
| M-P2-021 | S1#50, S3#51-52, S4#59, S6#21 |
| M-P2-092 | S4#61, S6#22 |
| M-P2-108 | S1#57, S3#61, S4#63, S6#23 |

---

## Totals

| Severity | Unique findings | ID range |
|----------|-----------------|----------|
| **P0** | **24** | M-P0-001 … M-P0-024 |
| **P1** | **111** | M-P1-001 … M-P1-111 |
| **P2** | **115** | M-P2-001 … M-P2-115 |
| **P3** | **32** | M-P3-001 … M-P3-032 |
| **Total** | **282** | |

---

## Not in this table (by design)

- Residual-risk prose without a discrete finding ID (see each section’s Residual risks)
- Full testing-gap bullet lists (see each section; many gaps are also P1/P2 testing findings)
- Strengths / positive notes
- Suggested fix waves (see `SYNTHESIS.md`)

---

## Index by section (count of master IDs citing section)

| Section | Approx. unique contributions after merge |
|---------|------------------------------------------|
| S1 | ~58 primary |
| S2 | ~51 primary |
| S3 | ~61 primary |
| S4 | ~71 primary |
| S5 | ~35 primary |
| S6 | ~35 primary |

Overlaps mean sum > 282.

---

## Files

| Artifact | Role |
|----------|------|
| [S1](./S1-process-shell-ipc.md) … [S6](./S6-agent-native.md) | Section detail + evidence |
| [SYNTHESIS.md](./SYNTHESIS.md) | Top blockers + fix waves |
| **This file** | Complete deduplicated master table |

**Generated:** 2026-07-16 · Full re-read of all six section reports before merge.
