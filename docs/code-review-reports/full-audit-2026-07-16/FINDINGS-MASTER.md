# Full Audit 2026-07-16 — Master Findings Table

**Source:** S1–S6 section reports (re-read in full)  
**Mode:** audit + remediation tracking · **Branch:** `fix/full-audit-2026-07-16`  
**Dedup rules:** Same root cause / same primary fix site → one master row. Cross-section corroboration listed in **Sections**. Severity = highest reported. Confidence = max. Autofix = most conservative when mixed.

**Totals after cross-section dedup:** **24 P0 · 111 P1 · 115 P2 · 32 P3 = 282 unique findings**  
**Remediation (this branch):** **16 P0 fixed** · **all safe_auto fixed** · **P1 researched:** 100 open→ 89 still open · 10 partial · 1 fixed-on-verify · **Open P0 001–008 deferred**

Section raw tables (before cross-dedup) had ~320+ row citations; cross-section merges collapsed repeated root causes into single master IDs.

---

## How to read

| Column | Meaning |
|--------|---------|
| **ID** | Stable master id `M-P{sev}-{nnn}` |
| **Sections** | Which audit sections reported it (`S1`…`S6`) |
| **Primary file** | Best single location for navigation |
| **Autofix** | `safe_auto` · `gated_auto` · `manual` · `advisory` |
| **Status** | `open` · `partial` · `fixed` |

Protected paths (`docs/brainstorms|plans|solutions`) were never flagged for deletion.

---

## P0 — Critical (24)

Index table, then full write-ups (Why it Matters · Evidence · Suggested Fix).  
**Status:** `fixed` = remediated on `fix/full-audit-2026-07-16`; `open` = still outstanding.

| ID | Title | Primary file | Sections | Conf | Autofix | Status |
|----|-------|--------------|----------|------|---------|--------|
| M-P0-001 | `config:save` → MCP stdio RCE | `main/ipc/config.ts:148` | S1, S3, S4 | 100 | manual | open |
| M-P0-002 | Project MCP auto-spawn | project-registry + transport | S4, S1 | 90 | manual | open |
| M-P0-003 | No FS path sandbox | `tools/types.ts:89` | S4 | 100 | manual | open |
| M-P0-004 | `tool:execute` absolute reads | `main/ipc/tool.ts:36` | S1, S4 | 100 | manual | open |
| M-P0-005 | Unrestricted shell RCE | `execute-command.ts:222` | S4 | 100 | manual | open |
| M-P0-006 | `web_fetch` SSRF | `tools/web/fetch.ts:87` | S4 | 100 | manual | open |
| M-P0-007 | Env-auth secret exfil | `providers/index.ts:160` | S3 | 75 | manual | open |
| M-P0-008 | `allowInsecureHttp` dropped | `compatible.ts:63` + index.ts | S3 | 100 | gated_auto | open |
| M-P0-009 | submit_api_key ∥ disconnect race | `ipc/providers.ts` | S3 | 85 | manual | fixed |
| M-P0-010 | validateConnection re-enables disabled | `ipc/providers.ts` | S3 | 90 | manual | fixed |
| M-P0-011 | Unbounded `wait_for_subagent` | `agents/manager.ts:264` | S2, S4 | 100 | gated_auto | fixed |
| M-P0-012 | Esc orphans subagents | `ipc/chat.ts` | S1, S2 | 92 | gated_auto | fixed |
| M-P0-013 | Cross-session waiter flush | `tools/subagent/interrupt.ts` | S2 | 90 | manual | fixed |
| M-P0-014 | Quit doesn’t kill bg process groups | `main/index.ts:314` | S4, S1 | 92 | gated_auto | fixed |
| M-P0-015 | MCP startup timeout false-connected | `mcp/manager.ts:153` | S4 | 88 | gated_auto | fixed |
| M-P0-016 | Tool timeout abandons detached shells | `tool-dispatch` + execute | S4 | 90 | gated_auto | fixed |
| M-P0-017 | Agent path skips Zod validate | `llm/tool-dispatch.ts:144` | S2, S4 | 88 | gated_auto | fixed |
| M-P0-018 | Dual `useSession()` Config vs Chat | `ConfigView.tsx:53` | S5 | 92 | manual | fixed |
| M-P0-019 | Incomplete skill/agent seed | `skills/registry.ts:190` | S4, S6 | 100 | gated_auto | fixed |
| M-P0-020 | Empty `allowed_tools` semantics split | `tools/registry.ts:49` | S4, S6 | 100 | gated_auto | fixed |
| M-P0-021 | No `list_mcp_resources` | tools/mcp + manager | S4, S6 | 100 | manual | fixed |
| M-P0-022 | `read_mcp_resource` not on general | `general/AGENT.md` | S6 | 90 | safe_auto | fixed |
| M-P0-023 | No AST index management tool | tools/ast | S4, S6 | 100 | manual | fixed |
| M-P0-024 | Session lifecycle UI-only | commands + session IPC | S6, S1 | 100 | manual | fixed |

**Related product orphan (S6 P0 map, tracked as P1):** config/providers agent CRUD gap → **M-P1-053**.

### M-P0-001 — `config:save` → MCP stdio RCE

- **Status:** open
- **Primary:** `electron/src/main/ipc/config.ts:148` · **Sections:** S1, S3, S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** A compromised or buggy renderer can turn a settings write into main-process code execution: config is persisted, project MCP managers are invalidated, and the next chat turn (or MCP status path) spawns the attacker-chosen command with full user privileges.
- **Evidence:** `configSaveSchema` allows free-form `mcp_servers` nested records; after save, `clearProjectRuntimeRegistry` / `invalidateAllProjectMCPManagers`; `ProjectMCPManagerRegistry` → `startAll` → `StdioClientTransport({ command, args, env, cwd })` with no allowlist, confirmation, or path confinement; same path used by intentional UI (`MCPServersTab`) without a privileged gate.
- **Suggested fix:** Dedicated audited MCP IPC; native confirmation before persist/start; absolute-path allowlist for commands; https-only + SSRF guards for URL transports; never auto-start newly saved servers without confirmation.

### M-P0-002 — Project `.orchid.json` MCP auto-spawn

- **Status:** open
- **Primary:** `mcp/transport.ts` + project-registry + config merge · **Sections:** S4, S1 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Home + project config deep-merge means a cloned repo’s `.orchid` / project MCP map can introduce a malicious server that runs when the project is bound—stdio spawn as the desktop user without a trust prompt.
- **Evidence:** Config merge includes `mcp_servers` from project layer; `ProjectMCPManagerRegistry` sets cwd to `projectDir` and starts every configured server; `createTransport` spawns `command`/`args`/`env` with no binary allowlist; validation only checks name regex and non-empty command; manager documents no sandboxing.
- **Suggested fix:** Never auto-start project-supplied MCP commands without explicit user consent UI; pin allowlisted commands; isolate env; treat project `mcp_servers` as untrusted until approved.

### M-P0-003 — Filesystem tools have no project path sandbox

- **Status:** open
- **Primary:** `electron/src/main/tools/types.ts:89` · **Sections:** S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Any agent turn (or prompt injection) can read/write/enumerate arbitrary absolute paths outside the bound workspace—secrets, SSH keys, other projects, system files. Primary agent-tool boundary is open by design (deferred R20).
- **Evidence:** `resolveToolPath()` keeps absolute paths absolute and only `path.resolve`/`normalize`—no realpath containment under `ctx.cwd`; read/write/edit/glob/read_directory/grep all use it; security notes in filesystem tools document R20 deferral; contrast: `defs/paths.ts` already has realpath containment unused by tools.
- **Suggested fix:** `assertPathInProject(cwd, userPath)` with realpath of cwd + candidate; reject if outside; apply to all FS, search, AST path tools, and `execute_command` working_directory.

### M-P0-004 — `tool:execute` absolute path exfiltration

- **Status:** open
- **Primary:** `electron/src/main/ipc/tool.ts:36` · **Sections:** S1, S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Renderer-facing “safe” tools still allow absolute reads. Compromised renderer can exfiltrate SSH keys, vault material, cookies, etc. without the agent loop.
- **Evidence:** `RENDERER_ALLOWED_TOOLS` includes read/read_directory/glob/grep; handlers use same unrestricted `resolveToolPath`; `read.ts` documents unrestricted absolute paths; attack: `tool:execute({ name: 'read', args: { file_path: '/home/user/.ssh/id_rsa' } })`.
- **Suggested fix:** On IPC-initiated `tool:execute` only: realpath + require under bound `cwd` (optional explicit home-config allowlist). Keep agent-turn policy separate if broader FS access is product-required.

### M-P0-005 — `execute_command` unrestricted shell RCE

- **Status:** open
- **Primary:** `electron/src/main/tools/process/execute-command.ts:222` · **Sections:** S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Prompt injection or a malicious model response can run arbitrary shell as the logged-in user with full privileges and full `process.env` (API keys, tokens), plus optional cwd escape.
- **Evidence:** Default `shell=true` → `/bin/sh -c command`; background path same; `env = { ...process.env, ...ENV_SUPPRESSION }` only sets NO_COLOR/TERM/PAGER; `working_directory` via unrestricted `resolveToolPath`; no confirmation, allowlist, or capability split.
- **Suggested fix:** Force cwd under project realpath; scrub sensitive env for children; optional approval/allowlist for high-risk patterns; prefer `shell=false` + argv for known tools; document residual risk if full shell remains product intent.

### M-P0-006 — `web_fetch` classic SSRF

- **Status:** open
- **Primary:** `electron/src/main/tools/web/fetch.ts:87` · **Sections:** S4 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Agent (or prompt injection) can force main process to request localhost, RFC1918, link-local, and cloud metadata (e.g. 169.254.169.254), exfiltrating credentials or probing internal services; `redirect:'follow'` can bounce public → internal.
- **Evidence:** `validateUrl` only checks non-empty + http/https; no private IP/localhost/metadata checks; `fetch(..., { redirect: 'follow' })` with no post-redirect revalidation; body up to 10 MiB returned to the model.
- **Suggested fix:** Block private/reserved ranges after DNS resolve (and re-check after each redirect hop); deny localhost/link-local/metadata hostnames; prefer `redirect:'manual'` or re-validate Location; optional public-only mode.

### M-P0-007 — Env-auth + generic endpoint secret exfil

- **Status:** open
- **Primary:** `electron/src/main/providers/index.ts:160` · **Sections:** S3 · **Conf:** 75 · **Autofix:** manual
- **Why it matters:** Environment auth reads any `process.env` value matching the user-supplied variable name and sends it as the API key to a fully user-controlled generic endpoint—compromised renderer can bind e.g. `OPENAI_API_KEY` / AWS tokens to an attacker URL.
- **Evidence:** `resolveCredential`: `process.env[connection.credential.variable]` with no allowlist; `environmentVariableSchema` only `/^[A-Z_][A-Z0-9_]*$/`; generic drivers allow custom endpoints; IPC create/update accept env var + endpoint; adapter posts apiKey to user baseURL.
- **Suggested fix:** Restrict env variable names to per-provider allowlist (or known provider keys); for generic endpoints block private/metadata hosts by default; refuse environment-auth + non-allowlisted hosts; prefer vault keys for custom endpoints.

### M-P0-008 — `allowInsecureHttp` dropped on request path

- **Status:** open
- **Primary:** `drivers/compatible.ts:63` + `providers/index.ts:176` · **Sections:** S3 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Users who explicitly allow non-loopback HTTP can create/store credentials (IPC honors the flag) but chat/embed resolution re-validates without it—ready connections hard-fail at runtime; LAN/self-hosted HTTP is false-ready.
- **Evidence:** IPC/registry validate with `allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true`; `resolveCredential` calls bare `validateGenericEndpoint(endpoint)`; `createCompatibleLanguageModel` re-validates without the flag; tests cover flag in isolation, not E2E resolve/execution.
- **Suggested fix:** Thread `{ allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true }` through `resolveCredential` and `createCompatibleLanguageModel` (or trust registry-validated endpoint once).

### M-P0-009 — Concurrent submit_api_key + disconnect leaves live key

- **Status:** fixed · Per-connection mutex on submit/disconnect/disable/enable/update/validate; CAS vault cleanup after submit
- **Primary:** `electron/src/main/ipc/providers.ts` · **Sections:** S3 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Independent handlers with no shared connection-level mutex; interleaving can leave a usable vault handle while UI reports disconnected (or reverse)—credentials not durably removed.
- **Evidence:** `PROVIDERS_DISCONNECT` and `PROVIDERS_SUBMIT_API_KEY` only serialize their own store; constructed sequence: disconnect deletes vault → submit writes new key → disconnect marks disconnected → submit updates handle + may validate ready; vault and connection write locks are independent.
- **Suggested fix:** Per-connection mutation lock spanning vault + connection-store for submit/update/disconnect/disable/enable/validate; or CAS that re-deletes vault after final connection write.

### M-P0-010 — validateConnection re-enables disabled/disconnected

- **Status:** fixed · Validate re-reads under lock; never overwrites `disabled`/`disconnected`
- **Primary:** `electron/src/main/ipc/providers.ts` (validate path) · **Sections:** S3 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Concurrent validate/submit with disable/disconnect can overwrite terminal health back to `ready`/`needs_attention`, defeating user intent for new turns.
- **Evidence:** `validateConnection` short-circuits only on snapshot health then always `connections.update({ health: ready|needs_attention })`; CREATE/UPDATE/SUBMIT/ENABLE end in validate after earlier read; concurrent DISABLE/DISCONNECT then validate’s update under ConnectionStore lock overwrites terminal health.
- **Suggested fix:** Conditional health transitions inside connection write lock (only draft|needs_attention|ready may become ready; never overwrite disabled/disconnected unless explicit enable/reconnect); pass expected prior health/generation.

### M-P0-011 — `wait_for_subagent` can hang forever

- **Status:** fixed · 300s wait budget; timeout returns `isError` with still-running snapshot; does **not** cancel subagents
- **Primary:** `agents/manager.ts:264` + tool-dispatch + wait · **Sections:** S2, S4 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Hung or never-completing subagent blocks the parent indefinitely; UI stays “working”; background children keep consuming quota; neither tool timeout nor stream idle recovery can unblock.
- **Evidence:** `manager.wait()` awaits waiters with no max wait/deadline/AbortSignal; `TOOLS_WITHOUT_TIMEOUT` includes `wait_for_subagent`; orchestrator `pauseIdleForTool()` clears idle timer for whole tool window; wait handler awaits `manager.wait` with no outer timeout.
- **Suggested fix:** Config-backed `timeoutMs` on `SubagentManager.wait()`; accept AbortSignal so parent cancel unblocks; fail tool with `isError`; never unbounded.

### M-P0-012 — Esc-cancel + interrupt timeout orphans subagents

- **Status:** fixed · 3-phase Esc kept; interrupt TIMEOUT after Esc2 calls `cancelRunning(sessionId)` before dispose
- **Primary:** `main/ipc/chat.ts` + interrupt-machine · **Sections:** S1, S2 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Second Esc finalizes main INTERRUPTED without `cancelRunning`; 5s timeout disposes main only—children keep tools/LLM/persist while UI thinks the turn is over. `forceStop` cancels children; Esc path inconsistent.
- **Evidence:** Second Esc sets `agentCancelled`, finalizes, advances to confirmSubagents, does not call `cancelRunning`; timeout → idle + `disposeActiveAgent` only; `cancelRunning` only on third Esc / forceAbort / forceStop.
- **Suggested fix:** On agent cancel and dispose-after-`agentCancelled`, always `cancelRunning(sessionId)` (match `forceStopSession`).

### M-P0-013 — Cross-session waiter flush

- **Status:** fixed · Removed process-wide `flushStateCallbacks` from interrupt tool
- **Primary:** `tools/subagent/interrupt.ts` + `agents/manager.ts` · **Sections:** S2 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Session B’s interrupt can unblock Session A’s blocked `wait_for_subagent` while A’s children still run—parent A continues on incomplete/empty results (cross-session timing side channel).
- **Evidence:** Session A waits on A1; Session B `interrupt_subagents` → `cancelRunning(B)` then `flushStateCallbacks()`; flush iterates **all** process-wide records and resolves every pending waiter, including A1 still non-terminal; wait returns incomplete record.
- **Suggested fix:** Remove `flushStateCallbacks` from interrupt path, or only flush waiters for records just made terminal / matching calling `sessionId`.

### M-P0-014 — App quit never terminates background process groups

- **Status:** fixed · `before-quit` + `quitAndInstall` terminate/clear background store
- **Primary:** `main/index.ts:314` + background-store · **Sections:** S4, S1 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Detached shells/builds/PTYs survive Electron exit, holding ports/files/CPU and confusing the next session.
- **Evidence:** `before-quit` cleans MCP, IPC, config, logging but never `getBackgroundStore().terminateAll()`/`clear()`; background spawns use `detached: true` process groups; detached children survive Electron exit.
- **Suggested fix:** In before-quit (and hard-exit paths), `terminateAll()`, await short drain, force SIGKILL remaining PIDs before `app.exit`.

### M-P0-015 — MCP startup timeout false-connected

- **Status:** fixed · Overall timeout full teardown; no connected ghosts; clear clients/tools/uri map
- **Primary:** `mcp/manager.ts:153` · **Sections:** S4 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** Partial MCP startup (slow later server) closes healthy earlier servers, then tools hit dead transports while status still reports connected—silent tool failures and possible orphaned stdio children.
- **Evidence:** On overall timeout, `startAll` awaits `_awaitRunner()` which stops and `client.close()`s every entry in `_clients`; status for already-connected servers remains `connected`; `_clearDisconnectedState` only drops non-connected entries; tools stay registered against closed clients.
- **Suggested fix:** On overall timeout, do not shut down the whole runner if any server is already connected—only abort remaining connects; or after forced teardown mark all failed and clear `_clients`/`_tools`/`_uriMap` entirely.

### M-P0-016 — Tool-dispatch timeout abandons detached shells

- **Status:** fixed · Outer timeout AbortSignal; kill live `ChildProcess` process group (no bare-PID delayed kill)
- **Primary:** `llm/tool-dispatch.ts` + execute-command · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Outer tool timeout rejects the Promise without killing the detached process group—children keep running; agent retries → more orphans; resource exhaustion outside the agent loop.
- **Evidence:** `execute_command` spawns `detached: true`; `runWithToolTimeout` only Promise.races the handler and does not signal the child; long-running payload + ~60s outer timeout leaves process group alive; SIGTERM only if execute_command’s own timeout wins the race.
- **Suggested fix:** On tool timeout, kill process group for foreground spawns; track PIDs in turn-scoped registry; reaper tied to tool cancellation.

### M-P0-017 — Agent tool path never runs Zod validation

- **Status:** fixed · `registry.validate` before handler; handlers receive parsed data
- **Primary:** `llm/tool-dispatch.ts:144` · **Sections:** S2, S4 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** IPC validates tool args; agent loop does not. Malformed LLM args reach handlers via `input as XInput`—type checker off on the primary execution path; Zod schemas exist but are unused there.
- **Evidence:** `executeToolCall` JSON-parses args and calls `registered.handler(args, toolCtx)` without `registry.validate()`; IPC `tool:execute` does validate; handlers cast `unknown` input; registry `validate()` unused on agent path.
- **Suggested fix:** Call `registry.validate(name, args)` in `executeToolCall` and pass `validation.data`; prefer generic `ToolHandler<T>` / `z.infer` so casts disappear.

### M-P0-018 — Dual `useSession()` Config vs Chat

- **Status:** fixed · Shared module session store (`useSyncExternalStore`); Config and Chat share one state
- **Primary:** `renderer/ConfigView.tsx:53` + ChatView + useSession · **Sections:** S5 · **Conf:** 92 · **Autofix:** manual
- **Why it matters:** App keeps ChatView mounted under Config, but ConfigView mounts a second independent `useSession()`. Selecting/creating/deleting/rebinding from Config left rail only mutates Config’s local state—ChatView can show the old conversation or chat against a deleted/stale selection until full reload.
- **Evidence:** App keeps ChatView mounted while ConfigView open (`hidden`); ConfigView and ChatView each call `useSession()` with no shared store; Config `handleSessionSelect` only `session.load` then `onClose`—never ChatView’s switch/hydrate paths; no `session:active-changed` reconciliation across instances.
- **Suggested fix:** Lift session state to a single shared store (like `useProviders`), or forward Config session actions into ChatView handlers; do not dual-mount `useSession()` for navigation while ChatView remains mounted.

### M-P0-019 — Incomplete skill/agent seedDefaults

- **Status:** fixed · Recursive seed + fill missing scripts/references/assets without clobbering user md
- **Primary:** `skills/registry.ts:190` (+ agents) · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** First-run seed into `~/.orchid/skills/` leaves skill bodies without resource trees; skill tool resolves scripts/references/assets under skill dir—seeded installs get resource-not-found and broken workflows (compound, plan, resolve-pr-feedback, etc.).
- **Evidence:** `seedDefaults` only `copyFileSync` for SKILL.md/AGENT.md; 13 default skills ship refs/scripts/assets; `executeResourceRead` requires those subdirs under `skill.location`; parity tests load from full source tree, never seeded home.
- **Suggested fix:** Recursive copy of skill/agent subdirs on seed (or read-through to bundled defaults); integration test: seed temp home → load → skill resource reads succeed; re-seed missing resources without clobbering user-edited SKILL.md.

### M-P0-020 — Empty `allowed_tools` semantics split

- **Status:** fixed · Canonical empty = none; removed subagent empty→`*` coercion
- **Primary:** `tools/registry.ts:49` · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Empty allowlist is either “no tools” or “all tools” depending on path—silent tool starvation or accidental over-grant.
- **Evidence:** `ToolRegistry.filter([])` returns `[]`; `tools/index.ts` comment claims empty means all tools for normal subagents; `subagent-runner` coerces empty → `['*']`; main `buildToolMap` / streamChat uses raw `filter` with no empty→`*`; web-fetch AGENT.md has `allowed_tools: []`.
- **Suggested fix:** Single canonical helper `resolveAllowedToolPatterns` (empty ≡ all OR empty ≡ none); use in filter, buildToolMap, subagent-runner, and definitions UI; align comments + frontmatter.

### M-P0-021 — No `list_mcp_resources`

- **Status:** fixed · `list_mcp_resources` tool + `MCPManager.listResources()`
- **Primary:** tools/mcp + manager · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** MCP resources are enumerated into `_uriMap` at connect but never exposed as a list tool—agents must already know URIs; incomplete agent-native resource use.
- **Evidence:** Manager `listResources` only fills `_uriMap`; only tool is `read_mcp_resource(uri)`; no list_mcp_resources / list_mcp_servers tools; no resource URI injection into dynamic prompt.
- **Suggested fix:** `list_mcp_resources` returning `{uri, server, name?, description?}` from the same map; inject summary into dynamic system prompt.

### M-P0-022 — `read_mcp_resource` not on general agent

- **Status:** fixed · Added to general `allowed_tools` (re-seed home agent to pick up)
- **Primary:** `agents/defaults/general/AGENT.md` · **Sections:** S6 · **Conf:** 90 · **Autofix:** safe_auto
- **Why it matters:** Tool is registered and parity inventory expects it, but main agent allowlist omits it—general cannot read MCP resources even when URIs are known.
- **Evidence:** Tool registered in `tools/mcp/resource.ts` + `tools/index.ts`; parity expects `read_mcp_resource`; general `allowed_tools` lists `mcp::context7::*` / `mcp::example::*` but not `read_mcp_resource`.
- **Suggested fix:** Add `read_mcp_resource` to general (and any agent that should use MCP data); prefer coherent `mcp::*` + resource allowlist.

### M-P0-023 — No AST index management tool

- **Status:** fixed · `ast_index` tool (`status|index|clear`) registered + on general
- **Primary:** tools/ast · **Sections:** S4, S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** UI has `/ast index` and RAG has `rag_index` (status|index|clear); agents cannot force rebuild, clear, or inspect AST status mid-turn—stale index after large refactors is a silent failure mode.
- **Evidence:** AST tools are skeleton/function/refs/rename/replace only; some call `ensureIndexed` as side effect; RAG has `rag_index` action enum; AST IPC has status/index; no tool wrapper.
- **Suggested fix:** Add `ast_index` tool mirroring `rag_index` (status|index|clear), reusing indexer APIs.

### M-P0-024 — Session lifecycle + model change UI-only

- **Status:** fixed · session_list/create/load/rename/delete/change_model tools + general allowlist
- **Primary:** commands + session IPC · **Sections:** S6, S1 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Core multi-session product (`/new`, `/sessions`, `/rename`, `/delete`, `/model`) is UI/IPC-only—agent cannot create, switch, rename, delete sessions or change session model mid-session.
- **Evidence:** `renderer/commands/registry.ts` defines session/model commands; `session:*` IPC; no session_list/create/load/rename/delete or session_change_model tools; coding tools do not rebind session selection.
- **Suggested fix:** Session primitives over same `SessionManager` as UI (`session_list`, `session_create`, `session_load`, `session_rename`, `session_delete`, `session_change_model` with typed selection); emit existing `SESSION_*` events for UI refresh.

---

## P1 — High (98)

| ID | Title | Primary file | Sections | Conf | Autofix | Status |
|----|-------|--------------|----------|------|---------|--------|
| M-P1-001 | `bgcmd:snapshot` has no session/window ownership check | `main/ipc/chat.ts:1733` | S1 | 100 | gated_auto | open |
| M-P1-002 | `session:change_model` reports success on no-op | `main/ipc/session.ts:304` | S1 | 100 | safe_auto | fixed |
| M-P1-003 | `session:rename` always emits renamed on no-op | `main/ipc/session.ts:285` | S1 | 100 | safe_auto | fixed |
| M-P1-004 | `unregisterChatIPC` tears down agents without releasing MCP leases | `main/ipc/chat.ts:1762` | S1, S2 | 100 | safe_auto | fixed |
| M-P1-005 | macOS signed-build detection uses build-time env vars at runtime | `main/index.ts:277` | S1 | 100 | gated_auto | open |
| M-P1-006 | macOS `activate` recreates window without rebinding updater `mainWindowRef` | `main/index.ts:306` | S1 | 75 | gated_auto | open |
| M-P1-007 | `chat:send` with `sessionId` re-selects session mid-flight (selection steal) | `main/ipc/chat.ts:577` | S1 | 75 | gated_auto | open |
| M-P1-008 | `before-quit` always `preventDefault` without re-entrancy/deadline | `main/index.ts:314` | S1 | 75 | gated_auto | open |
| M-P1-009 | Graceful shutdown can hang: `FileLogger.close` has no timeout | `main/index.ts` + `logging.ts` | S1 | 75 | gated_auto | open |
| M-P1-010 | MCP SSE `url` from config enables main-process SSRF | `mcp/transport.ts:32` | S1, S4 | 75 | gated_auto | open |
| M-P1-011 | `session:set_workspace` binds any absolute readable dir without dialog | `main/ipc/session.ts:355` | S1 | 100 | gated_auto | open |
| M-P1-012 | Composition: `set_workspace` + `tool:execute` rebinds cwd then reads secrets | session + tool IPC | S1 | 100 | manual | open |
| M-P1-013 | Concurrent draft `chat:send` creates duplicate sessions / dual streams | `main/ipc/chat.ts:563` | S1 | 75 | manual | open |
| M-P1-014 | Updater events allowlisted/emitted but never on `OrchidAPI`/preload | `preload/index.ts:360` | S1, S6 | 100 | manual | open |
| M-P1-015 | Preload event listeners trust unchecked `as Event` casts | `preload/index.ts:118` | S1 | 100 | gated_auto | open |
| M-P1-016 | `invoke()` return type is an unchecked `Promise` cast | `preload/index.ts:84` | S1 | 100 | gated_auto | open |
| M-P1-017 | Allowlists are `readonly string[]` instead of `IPCChannel` literals | `shared/types/ipc.ts:838` | S1 | 100 | safe_auto | fixed |
| M-P1-018 | `ChatSendResult` is open `status`/`kind` strings, not a closed union | `shared/types/ipc.ts:512` | S1 | 100 | manual | open |
| M-P1-019 | `ConfigSaveMessage` is `Partial<Config>` but runtime is tombstone PATCH | `shared/types/ipc.ts:247` | S1, S3 | 92 | manual | open |
| M-P1-020 | `chat.ts` is a ~1779-line god module | `main/ipc/chat.ts:1` | S1 | 100 | manual | open |
| M-P1-021 | `providers` IPC imports `main/index` → circular dependency | `main/ipc/providers.ts:30` | S1, S3 | 100 | gated_auto | open |
| M-P1-022 | app-shell IPC Zod tests reimplement weaker schemas than production | `tests/integration/app-shell.test.ts:142` | S1 | 100 | gated_auto | open |
| M-P1-023 | Critical IPC modules lack dedicated handler tests | `electron/tests/unit` | S1 | 100 | manual | partial |
| M-P1-024 | No first-class agent-native command surface for full UI capability set | `shared/commands.ts` + tools | S1, S6 | 85 | advisory | open |
| M-P1-025 | `JSON.parse` on history tool_calls can crash entire stream turn | `llm/orchestrator.ts:249` | S2 | 100 | safe_auto | fixed |
| M-P1-026 | Subagent final result ignores tool-only work (empty wait payload) | `agents/manager.ts:463` | S2 | 100 | gated_auto | open |
| M-P1-027 | Interrupted subagent drops in-flight partial assistant text | `agents/manager.ts:533` | S2 | 75 | gated_auto | open |
| M-P1-028 | `toApiMessages` match-set keeps filtered-out tool_call ids | `llm/history.ts:167` | S2 | 75 | gated_auto | open |
| M-P1-029 | Tool timeout does not cancel underlying work | `llm/tool-dispatch.ts:270` | S2, S4 | 100 | gated_auto | partial |
| M-P1-030 | Retry backoff sleep ignores abort/cancel | `llm/middleware/retry.ts:43` | S2 | 100 | gated_auto | open |
| M-P1-031 | Retry only covers `doStream()` setup, not mid-stream drops | `llm/middleware/retry.ts:86` | S2 | 75 | manual | open |
| M-P1-032 | Conversation history unbounded; full re-send every turn | session + history + orchestrator | S2 | 90 | manual | open |
| M-P1-033 | Every chain/subagent persist rewrites full pretty-printed session JSON + fsync | `session/storage.ts` | S2 | 85 | manual | open |
| M-P1-034 | SubagentManager never prunes records (process lifetime) | `agents/manager.ts` | S2 | 93 | gated_auto | open |
| M-P1-035 | Subagent tool events → debounced full-session rewrites of all chains | wire-subagents + persist | S2 | 80 | gated_auto | open |
| M-P1-036 | Subagent `Chain.sessionId` is subagent id, not session UUID | `agents/manager.ts:656` | S2 | 90 | gated_auto | open |
| M-P1-037 | Asymmetric restore: subagents → INTERRUPTED; chains keep ACTIVE | `shared/types/chain.ts` | S2 | 85 | gated_auto | open |
| M-P1-038 | Dual SubagentRecord / status enums + third `SubagentState` prompt DTO | manager + subagent.ts + system-prompt | S2 | 90 | manual | open |
| M-P1-039 | Explicit `any` tool map disables type checking at LLM tool boundary | `orchestrator.ts:726` | S2 | 92 | gated_auto | open |
| M-P1-040 | Unsafe double cast Zod→AI SDK in context-snapshot | `context-snapshot.ts:32` | S2 | 88 | gated_auto | open |
| M-P1-041 | `fullStream` / `onStepFinish` cast away SDK discriminants | `orchestrator.ts:411` | S2 | 80 | gated_auto | open |
| M-P1-042 | Cancelled turns leave in-flight tools running (no abortSignal) | tool-dispatch + orchestrator | S2 | 85 | gated_auto | partial |
| M-P1-043 | CLAUDE.md documents non-existent agent modules | `electron/CLAUDE.md` | S2, S6 | 100 | safe_auto | fixed |
| M-P1-044 | Tier override affects model selection but not `Agent.tier` on record | `tools/subagent/delegate.ts:107` | S2 | 75 | gated_auto | open |
| M-P1-045 | Unscoped subagent persist falls back to active session | `persist-subagent-chains.ts:47` | S2 | 75 | gated_auto | open |
| M-P1-046 | HTTPS custom endpoints: no destination allowlist (credential SSRF) | `drivers/compatible.ts:21` | S3 | 75 | manual | open |
| M-P1-047 | Loopback check treats any hostname starting with `127.` as local | `drivers/compatible.ts:17` | S3 | 100 | safe_auto | fixed |
| M-P1-048 | Vault + connection mutations multi-step without joint atomicity | `main/ipc/providers.ts:631` | S3 | 85 | manual | partial |
| M-P1-049 | `submit_api_key` binds vault origin from stale snapshot while endpoint mutates | `main/ipc/providers.ts` | S3 | 85 | manual | fixed |
| M-P1-050 | Invalid home config fails closed by quitting entire app | `config/loader.ts:215` | S3 | 85 | gated_auto | open |
| M-P1-051 | Dual model resolution: incomplete custom models allowed at resolve, rejected at gate | `providers/resolver.ts:70` | S3 | 88 | gated_auto | open |
| M-P1-052 | `mcp_servers` untyped nested bag on Config / IPC boundary | `ipc-boundary.ts:114` | S1, S3, S4 | 88 | manual | open |
| M-P1-053 | Agent has ~0% action parity on provider/config ops | tools + system-prompt | S3, S6 | 100 | manual | open |
| M-P1-054 | Context starvation: no provider/config (and little product state) in system prompt | `llm/system-prompt.ts` | S3, S6 | 100 | gated_auto | open |
| M-P1-055 | `providers:update` builds candidate via `as ProviderConnection` | `main/ipc/providers.ts:607` | S1, S3 | 78 | gated_auto | open |
| M-P1-056 | Config dual source: hand-written `Config` vs Zod schema | `config/schema.ts` | S3 | 82 | manual | open |
| M-P1-057 | Accounting middleware `wrapGenerate` completely untested | `accounting/middleware.ts:111` | S3 | 90 | manual | open |
| M-P1-058 | Provider IPC `validate` / `enable` / `status_refresh` untested | `main/ipc/providers.ts:651` | S3 | 88 | manual | partial |
| M-P1-059 | Vault fail-closed/corruption paths largely untested | `credentials/vault.ts` | S3 | 85 | manual | partial |
| M-P1-060 | Accounting store singleton init/fail-closed API untested | `accounting/store.ts:356` | S3 | 85 | manual | open |
| M-P1-061 | Middleware cost evidence (headers + Neuralwatt) never exercised | `accounting/middleware.ts:60` | S3 | 82 | manual | open |
| M-P1-062 | Child processes inherit full `process.env` (secret leak) | background-store / execute | S4 | 75 | gated_auto | open |
| M-P1-063 | AST `rename_symbol` requires `file_path` but never uses it | `tools/ast/rename-symbol.ts:21` | S4 | 95 | gated_auto | open |
| M-P1-064 | RAG partial-path index deletes all other indexed files | `rag/indexer.ts:386` | S4 | 90 | gated_auto | open |
| M-P1-065 | `rag_search` always local ONNX; index may use API embedder | `tools/rag/search.ts:72` | S4 | 90 | gated_auto | open |
| M-P1-066 | `read_mcp_resource` treats MCP error strings as success | `tools/mcp/resource.ts:60` | S4 | 90 | gated_auto | open |
| M-P1-067 | MCP runner shutdown abandons hung `client.close` after 3s | `mcp/manager.ts:497` | S4 | 82 | gated_auto | open |
| M-P1-068 | HF model download fetch has no timeout | `rag/embedder.ts:572` | S4 | 95 | gated_auto | open |
| M-P1-069 | AST/RAG index workers no overall timeout/cancel | `ast/indexer.ts:376` | S4 | 85 | gated_auto | open |
| M-P1-070 | Foreground `waitForExit` unbounded after kill | `execute-command.ts:299` | S4 | 80 | gated_auto | open |
| M-P1-071 | RAG SQLite no `busy_timeout` (AST has 5000) | `rag/store.ts:244` | S4 | 78 | safe_auto | fixed |
| M-P1-072 | RAG holds full vector corpus as `number[][]` | rag indexer + store | S4 | 90 | manual | partial |
| M-P1-073 | `glob` fully sync + unbounded matches | `tools/filesystem/glob.ts` | S4 | 92 | gated_auto | open |
| M-P1-074 | `grep` full-tree full-file load, no size bound | `tools/search/grep.ts` | S4 | 88 | gated_auto | open |
| M-P1-075 | AST stores every reference; tools return unbounded | ast store + tools | S4 | 85 | gated_auto | open |
| M-P1-076 | Main RAG search cache stale after worker reindex | `rag/store.ts` cache | S4 | 80 | gated_auto | open |
| M-P1-077 | Concurrent AST rename partial multi-file write | `rename-symbol.ts` | S4 | 75 | gated_auto | open |
| M-P1-078 | Explicit `any` in `zodToJsonSchema` conversion | `tools/registry.ts:84` | S4 | 95 | gated_auto | open |
| M-P1-079 | Tree-sitter surface entirely `any`-typed | `ast/parser.ts:34` | S4 | 92 | gated_auto | open |
| M-P1-080 | Fallback MCP manager partial object cast to full MCPManager | `tools/index.ts:67` | S4 | 90 | gated_auto | open |
| M-P1-081 | MCP tool inputs passthrough Zod | `mcp/manager.ts:656` | S4 | 85 | gated_auto | open |
| M-P1-082 | MCP config untyped Record cast at project boundary | `mcp/project-registry.ts:18` | S4 | 82 | manual | open |
| M-P1-083 | Interactive PTY path untested | process tools | S4 | 90 | manual | open |
| M-P1-084 | `rag_index` / `rag_search` handlers never executed in tests | tools/rag | S4 | 93 | manual | open |
| M-P1-085 | AST indexing uses live `getConfig()`, not frozen project runtime | `ast/indexer.ts:217` | S4 | 90 | gated_auto | open |
| M-P1-086 | `getBuiltinToolRegistryForRuntime` caches first options forever | `tools/index.ts:284` | S4 | 80 | gated_auto | open |
| M-P1-087 | MCP allowlist naive regex vs minimatch for builtins | `llm/orchestrator.ts:784` | S4, S6 | 85 | gated_auto | open |
| M-P1-088 | Composer `isSendingRef` sticks after silent send gates | `renderer/InputArea.tsx:383` | S5 | 100 | gated_auto | open |
| M-P1-089 | Esc/cancel has no mutual exclusion across stages | `renderer/hooks/useChat.ts:757` | S5 | 75 | gated_auto | open |
| M-P1-090 | `chat.send` catch leaves optimistic bubble + half-stream state | `renderer/hooks/useChat.ts:748` | S5 | 78 | gated_auto | open |
| M-P1-091 | GeneralTab cannot set `llm_stream_retries` to 0 | `Preferences/GeneralTab.tsx:64` | S5 | 95 | safe_auto | fixed |
| M-P1-092 | RAGTab cannot set `chunk_overlap` to 0 | `Preferences/RAGTab.tsx:80` | S5 | 93 | safe_auto | fixed |
| M-P1-093 | Config draft is untyped `Record` with cast-to-Config | `ConfigView.tsx:65` | S5 | 90 | gated_auto | open |
| M-P1-094 | `orchid:config-updated` treats `default_model` as ModelSelection without narrowing | `ChatView.tsx:181` | S5 | 82 | gated_auto | open |
| M-P1-095 | 100ms elapsed ticker rebuilds full chat history every tick | `useChat.ts:317` + ChatStream | S5 | 95 | gated_auto | partial |
| M-P1-096 | Unbatched per-token stream updates thrash ChatView tree | `useChat.ts:342` | S5 | 92 | gated_auto | partial |
| M-P1-097 | Streaming assistant fully re-parses markdown every chunk | `MarkdownContent.tsx:91` | S5 | 90 | gated_auto | open |
| M-P1-098 | Command palette navigation dispatches dead `orchid:navigate` | `CommandPalette.tsx:345` | S5 | 100 | gated_auto | open |
| M-P1-099 | Domain hook `useChat` imports UI `ContextGrid` for pure math | `useChat.ts:29` | S5 | 88 | gated_auto | open |
| M-P1-100 | `useChat` / `useSession` / `useSessionTabs` behavioral surface almost untested | renderer hooks + tests | S5 | 90 | manual | open |
| M-P1-101 | Preferences/onboarding tests assert mocks/booleans, not ConfigView | `preferences-onboarding.test.ts` | S5 | 95 | manual | open |
| M-P1-102 | Omitted `allowed_skills` defaults to `['*']` for several default agents | `agents/registry.ts:87` | S6 | 100 | gated_auto | open |
| M-P1-103 | Skill discovery claimed in system prompt but prompt injects no skill inventory | system-prompt + skill.ts | S6 | 100 | gated_auto | open |
| M-P1-104 | general AGENT.md identity: “terminal-based coding agent” in Electron desktop | `general/AGENT.md:39` | S6 | 100 | safe_auto | fixed |
| M-P1-105 | Command palette actions without agent tools (/cd, /model, /sessions, …) | `renderer/commands/registry.ts` | S6 | 85 | manual | partial |
| M-P1-106 | Workspace rebind (`/cd`) no agent equivalent | session IPC | S6 | 100 | manual | open |
| M-P1-107 | Personality switch UI-only | commands | S6 | 100 | manual | open |
| M-P1-108 | Definition CRUD (agents/skills/personalities) UI-only | defs IPC | S6 | 100 | manual | open |
| M-P1-109 | General MCP allowlist hard-coded to context7/example | `general/AGENT.md` | S6 | 75 | gated_auto | open |
| M-P1-110 | system-prompt branches largely untested | `llm/system-prompt.ts` | S6 | 100 | manual | open |
| M-P1-111 | web-fetch summarizer production wiring untested | `tools/index.ts` | S6 | 75 | manual | open |

*Note: M-P1-053/054/014/024/043/087/052 are cross-section merges; original S3 “config agent orphan P0” is M-P1-053.*


### P1 write-ups (verified 2026-07-16)

Status: `open` = still present · `partial` = mitigated but residual · `fixed` = no longer applies on this branch.

### M-P1-001 — `bgcmd:snapshot` has no session/window ownership check

- **Status:** open
- **Primary:** `main/ipc/chat.ts:1733` · **Sections:** S1 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Any renderer that can invoke bgcmd:snapshot can read background command output by numeric commandId alone. Background processes are session-scoped elsewhere, so missing ownership lets one window/session observe another's command tails (and exit codes).
- **Evidence:** `electron/src/main/ipc/chat.ts` validates only `{ commandId, lastN }` and calls `store.snapshot` with no sessionId/windowId. Store has visibility helpers (`getVisible` / `isVisible` by sessionId + agentScopeId) in background-store, unused here.
- **Suggested fix:** Require sessionId (or resolve from active window session), call getVisible/isVisible, return empty/not-found on mismatch.

### M-P1-005 — macOS signed-build detection uses build-time env vars at runtime

- **Status:** open
- **Primary:** `main/index.ts:277` · **Sections:** S1 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Auto-update gating on macOS depends on "signed build," but runtime checks build-time env vars that are usually absent in installed apps. Signed production builds can be treated as unsigned (or the reverse if env is leaked), so auto-update policy is wrong.
- **Evidence:** `electron/src/main/index.ts` — isSigned = app.isPackaged && darwin ? !!(process.env.CODESIGN_CERT || process.env.CSC_NAME) : app.isPackaged, then initUpdater({ signed: isSigned }).
- **Suggested fix:** Detect signing at runtime (codesign -dv / package-time flag baked into release), not CSC_* env.

### M-P1-006 — macOS `activate` recreates window without rebinding updater `mainWindowRef`

- **Status:** open
- **Primary:** `main/index.ts:306` · **Sections:** S1 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** On macOS, closing the last window keeps the app alive. Dock activate recreates a window but never rebinds the updater's cached window, so update status/progress/error events go nowhere after recreate.
- **Evidence:** activate only createWindow() (index.ts). initUpdater sets mainWindowRef once at startup (updater.ts). No setMainWindow/re-init on recreate; sendToRenderer uses stale/null mainWindowRef.
- **Suggested fix:** On createWindow after activate, call setUpdaterWindow(mainWindow) (or re-initUpdater safely).

### M-P1-007 — `chat:send` with `sessionId` re-selects session mid-flight (selection steal)

- **Status:** open
- **Primary:** `main/ipc/chat.ts:577` · **Sections:** S1 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Sending with sessionId forces switchTo for that window even if the user is viewing another session. Mid-flight sends from background tabs can steal selection and confuse UI/history binding.
- **Evidence:** ensureActiveSession in chat.ts: if requestedSessionId and active?.id !== requestedSessionId, manager.switchTo(requestedSessionId, windowId). Used by chat:send.
- **Suggested fix:** Resolve session by id without changing window active selection (or only switch when explicitly intended); stream/persist by sessionId only.

### M-P1-008 — `before-quit` always `preventDefault` without re-entrancy/deadline

- **Status:** open
- **Primary:** `main/index.ts:314` · **Sections:** S1 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Every before-quit always preventDefaults and runs async cleanup. A second quit signal can re-enter cleanup while the first is still awaiting (bg drain, logger, MCP), causing double teardown or a stuck app that never reaches app.exit.
- **Evidence:** index.ts before-quit — no isQuitting / re-entrancy guard; always event.preventDefault() then long await chain ending in app.exit.
- **Suggested fix:** if (isQuitting) return; else set flag; optional hard deadline setTimeout → app.exit(1); only preventDefault on first entry.

### M-P1-009 — Graceful shutdown can hang: `FileLogger.close` has no timeout

- **Status:** open
- **Primary:** ``main/index.ts` + `logging.ts`` · **Sections:** S1 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Shutdown awaits log stream end with no timeout. A stuck/broken write stream blocks the rest of teardown (IPC unregister, MCP shutdown, app.exit).
- **Evidence:** FileLogger.close (logging.ts) is new Promise resolved only on s.end callback — no timeout/reject. before-quit await closeFileLogging().
- **Suggested fix:** Race close() with a short timeout; force-destroy stream on timeout; continue shutdown.

### M-P1-010 — MCP SSE `url` from config enables main-process SSRF

- **Status:** open
- **Primary:** `mcp/transport.ts:32` · **Sections:** S1, S4 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Config-driven MCP SSE URLs are opened from the main process with user privileges. Malicious/project config can probe localhost/metadata/internal networks (SSRF), especially with custom headers.
- **Evidence:** createTransport (mcp/transport.ts) — if (config.url) new SSEClientTransport(new URL(config.url), { requestInit: headers }). No scheme/host/IP allowlist. MCPServerConfig.url is free-form.
- **Suggested fix:** https-only (or explicit allowlist); block private/link-local/metadata ranges; optional user confirmation for remote MCP.

### M-P1-011 — `session:set_workspace` binds any absolute readable dir without dialog

- **Status:** open
- **Primary:** `main/ipc/session.ts:355` · **Sections:** S1 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Programmatic workspace bind accepts any absolute readable directory without a native dialog or path allowlist. Compromised renderer can rebind cwd to sensitive trees (home, keys dir) and make subsequent tools operate there.
- **Evidence:** session:set_workspace → bindProjectDirectory → requireValidProjectDirectory which only checks absolute + exists + dir + R_OK|X_OK. No user dialog, no home/project allowlist.
- **Suggested fix:** Restrict to user-picked dirs / sticky history / explicit allowlist; or require dialog confirmation for non-test builds; mark IPC test-only if possible.

### M-P1-012 — Composition: `set_workspace` + `tool:execute` rebinds cwd then reads secrets

- **Status:** open
- **Primary:** `session + tool IPC` · **Sections:** S1 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Combining set_workspace with tool:execute read tools lets a renderer rebind workspace then read secrets under the new cwd (and absolute paths remain a separate P0). Composition multiplies impact without needing the agent loop.
- **Evidence:** set_workspace binds any valid absolute dir. tool:execute resolves cwd via resolveBoundProjectPath and runs allowlisted read/glob/grep.
- **Suggested fix:** Fix 011 + sandbox IPC tool paths under bound cwd (align with M-P0-004); treat set_workspace as privileged.

### M-P1-013 — Concurrent draft `chat:send` creates duplicate sessions / dual streams

- **Status:** open
- **Primary:** `main/ipc/chat.ts:563` · **Sections:** S1 · **Conf:** 75 · **Autofix:** manual
- **Why it matters:** Concurrent first sends from draft mode each create a new session before any per-session busy lock applies, producing duplicate sessions and dual streams for one user action.
- **Evidence:** sessionsStarting is keyed by sessionId after ensureActiveSession. Draft path with no active creates via manager.create with no window/draft-level mutex. Two parallel chat:send without sessionId both see no active → two creates.
- **Suggested fix:** Window/draft start lock (or single-flight on windowId) before create; reuse in-flight create promise.

### M-P1-014 — Updater events allowlisted/emitted but never on `OrchidAPI`/preload

- **Status:** open
- **Primary:** `preload/index.ts:360` · **Sections:** S1, S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Updater push channels are allowlisted and emitted from main, but preload/OrchidAPI never expose listeners, so the UI cannot subscribe to update lifecycle events.
- **Evidence:** Channels in IPC_CHANNELS + ALLOWED_EVENT_CHANNELS. Main emits via updater.ts. Preload orchidAPI ends at bgCmd with no updater namespace. OrchidAPI interface has no updater methods.
- **Suggested fix:** Add orchid.updater.onStatus/onProgress/onError (+ optional invoke check) wired through preload and types.

### M-P1-015 — Preload event listeners trust unchecked `as Event` casts

- **Status:** open
- **Primary:** `preload/index.ts:118` · **Sections:** S1 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Event payloads are force-cast to typed events with no runtime validation. Malformed main payloads become typed lies in the renderer and can throw or corrupt UI state.
- **Evidence:** Preload pattern e.g. callback(args[0] as ChatChunkEvent) and same for other on* handlers (preload/index.ts).
- **Suggested fix:** Zod (or shared) parse at preload boundary; drop/log invalid events.

### M-P1-016 — `invoke()` return type is an unchecked `Promise` cast

- **Status:** open
- **Primary:** `preload/index.ts:84` · **Sections:** S1 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** invoke casts the Electron promise to Promise<T> without validating results. TypeScript safety ends at the cast; runtime shape drift is silent until UI breaks.
- **Evidence:** preload/index.ts — return ipcRenderer.invoke(channel, ...args) as Promise<T>.
- **Suggested fix:** Channel→schema map; parse on resolve (at least for high-risk channels); or typed IPC helpers with zod.

### M-P1-018 — `ChatSendResult` is open `status`/`kind` strings, not a closed union

- **Status:** open
- **Primary:** `shared/types/ipc.ts:512` · **Sections:** S1 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Open status/kind strings prevent exhaustiveness checking. Callers cannot safely switch on results; typos and new kinds won't be caught at compile time.
- **Evidence:** ChatSendResult (ipc.ts) uses status: string and kind?: string. Runtime kinds are closed in practice (session_not_found, unbound_workspace, provider_required, session_busy, …, status: 'started').
- **Suggested fix:** Discriminated union: { status: 'started'; sessionId; turnId } | { status: 'error'; kind: ChatSendErrorKind; error: string }.

### M-P1-019 — `ConfigSaveMessage` is `Partial<Config>` but runtime is tombstone PATCH

- **Status:** open
- **Primary:** `shared/types/ipc.ts:247` · **Sections:** S1, S3 · **Conf:** 92 · **Autofix:** manual
- **Why it matters:** Types say Partial<Config> (no null deletes) while main merge treats null as tombstones. Renderers and tests can believe invalid shapes are type-safe, and TypeScript won't model delete semantics.
- **Evidence:** ConfigSaveMessage.updates: Partial<Config>. Runtime configSaveSchema is z.record(z.string(), z.unknown()); merge docs null tombstones.
- **Suggested fix:** ConfigPatch type with explicit null tombstones / deep-partial input matching ConfigDeepPartialInput; align preload + Zod.

### M-P1-020 — `chat.ts` is a ~1779-line god module

- **Status:** open
- **Primary:** `main/ipc/chat.ts:1` · **Sections:** S1 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** A ~1.8k-line module owns send/cancel/stop/snapshot/bgcmd, actor lifecycle, persistence, and activity — hard to test, review, and change without regressions.
- **Evidence:** electron/src/main/ipc/chat.ts is ~1787 lines; single file from schemas through agent loop through unregister.
- **Suggested fix:** Split: handlers vs active-agent lifecycle vs ensureActiveSession vs stream/persist vs bgcmd; keep thin IPC registration.

### M-P1-021 — `providers` IPC imports `main/index` → circular dependency

- **Status:** open
- **Primary:** `main/ipc/providers.ts:30` · **Sections:** S1, S3 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Providers IPC imports the app entry module for store getters, creating a circular dependency with main/index (which registers IPC). Risk of partial initialization / hard-to-debug load order bugs.
- **Evidence:** providers.ts imports getProviderCatalogStore, getProviderConnectionStore, getProviderCredentialVault, getProviderStatusService from '../index'. Those getters are defined/exported on index.ts.
- **Suggested fix:** Move getters to providers/runtime-context.ts (or similar) with no import of index; have index init that module.

### M-P1-022 — app-shell IPC Zod tests reimplement weaker schemas than production

- **Status:** open
- **Primary:** `tests/integration/app-shell.test.ts:142` · **Sections:** S1 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Integration tests re-declare weaker Zod schemas, so they can pass while production rejects real payloads (or accept invalid ones prod would reject)—false confidence.
- **Evidence:** app-shell.test.ts — local z.object({ message, sessionId: z.string().optional() }) vs prod sessionId: z.string().uuid().optional(); config test uses string default_model vs typed selection; not importing production schemas.
- **Suggested fix:** Export/import real IPC schemas from main (or shared) and assert against those.

### M-P1-023 — Critical IPC modules lack dedicated handler tests

- **Status:** partial
- **Primary:** `electron/tests/unit` · **Sections:** S1 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Several IPC surfaces have unit coverage, but not all critical handlers. Gaps leave regressions in tool/mcp/rag/ast (and ownership checks) uncaught.
- **Evidence:** Present: chat-ipc, config-ipc, provider-ipc, session-*-ipc under electron/tests/unit/. IPC modules include tool.ts, mcp.ts, rag.ts, ast.ts — no dedicated tool-ipc / mcp-ipc / rag-ipc / ast-ipc handler tests (only channel presence in app-shell and non-IPC tool/mcp unit tests).
- **Suggested fix:** Add handler-level tests per IPC module (allowlist, zod, ownership, error shapes), prioritizing tool, mcp, chat ownership, session:set_workspace.

### M-P1-024 — No first-class agent-native command surface for full UI capability set

- **Status:** open
- **Primary:** ``shared/commands.ts` + tools` · **Sections:** S1, S6 · **Conf:** 85 · **Autofix:** advisory
- **Why it matters:** Agents cannot drive the full product surface that the UI/command palette can; parity gaps keep config, navigation, and shell features human-only.
- **Evidence:** shared/commands.ts is palette types only; renderer owns execute. Session tools landed under M-P0-024, but no unified agent-native command inventory for the full UI set.
- **Suggested fix:** Publish a shared capability registry (slash + tool + IPC) and add tools for remaining high-priority UI actions.

### M-P1-026 — Subagent final result ignores tool-only work (empty wait payload)

- **Status:** open
- **Primary:** `agents/manager.ts:463` · **Sections:** S2 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Tool-only subagents complete with empty result; parent wait_for_subagent gets a useless payload and may re-delegate or fail silently.
- **Evidence:** agents/manager.ts only appends content to resultText; sets record.result = resultText || record.result then markCompleted — tool_result text never enters result.
- **Suggested fix:** On completion, synthesize result from final assistant text, last tool outputs, or a chain summary when resultText is empty.

### M-P1-027 — Interrupted subagent drops in-flight partial assistant text

- **Status:** open
- **Primary:** `agents/manager.ts:533` · **Sections:** S2 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Esc/interrupt loses in-flight assistant deltas; waiters and persisted chains miss partial progress.
- **Evidence:** cancelOne marks terminal + finalizes before flush. Abort path only keeps partial text if !TERMINAL_STATES.has(record.state) — already terminal, so flush never runs.
- **Suggested fix:** Flush responseText into chain/result before marking INTERRUPTED, or drop the terminal guard on the abort flush path.

### M-P1-028 — `toApiMessages` match-set keeps filtered-out tool_call ids

- **Status:** open
- **Primary:** `llm/history.ts:167` · **Sections:** S2 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Match-set can include filtered-out tool_call ids → orphaned tool results or provider 400s.
- **Evidence:** llm/history.ts emits only surviving tool_calls, but rebuilds lastAssistantToolCallIds from unfiltered msg.tool_calls.
- **Suggested fix:** Set lastAssistantToolCallIds from the surviving set (or empty when all dropped).

### M-P1-029 — Tool timeout does not cancel underlying work

- **Status:** partial
- **Primary:** `llm/tool-dispatch.ts:270` · **Sections:** S2, S4 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Timed-out tools can keep burning CPU/IO/network if work ignores abort. Process path improved by M-P0-016; most other tools still ignore abortSignal.
- **Evidence:** tool-dispatch + withTimeout aborts controller; execute-command honors ctx.abortSignal. Most other tools (fs/ast/rag/mcp) never read abortSignal.
- **Suggested fix:** Require cooperative cancel for long tools; pass AbortSignal into MCP/fetch/indexers; document noTimeout exceptions.

### M-P1-030 — Retry backoff sleep ignores abort/cancel

- **Status:** open
- **Primary:** `llm/middleware/retry.ts:43` · **Sections:** S2 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Cancel during retry backoff still sleeps full delay; turn feels hung after Esc.
- **Evidence:** llm/middleware/retry.ts plain setTimeout sleep; await sleep(delayMs) with no abort wiring.
- **Suggested fix:** Abortable sleep tied to stream/turn AbortSignal; reject/throw on abort mid-backoff.

### M-P1-031 — Retry only covers `doStream()` setup, not mid-stream drops

- **Status:** open
- **Primary:** `llm/middleware/retry.ts:86` · **Sections:** S2 · **Conf:** 75 · **Autofix:** manual
- **Why it matters:** Transient mid-stream drops after doStream() returns are not retried; only setup failures are.
- **Evidence:** retry.ts retries only around await doStream(); stream is returned after pipeThrough — mid-stream errors bypass the while-loop.
- **Suggested fix:** Retry policy for pre-content stream failures (or idle reconnect) with content-delivered guard preserved.

### M-P1-032 — Conversation history unbounded; full re-send every turn

- **Status:** open
- **Primary:** `session + history + orchestrator` · **Sections:** S2 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Full history re-sent every turn → token cost, latency, and context overflow on long sessions.
- **Evidence:** orchestrator.ts toApiMessages(messages) with no window/budget; no truncation/summarization in history/session path.
- **Suggested fix:** Context budget + sliding window / summarization before API conversion.

### M-P1-033 — Every chain/subagent persist rewrites full pretty-printed session JSON + fsync

- **Status:** open
- **Primary:** `session/storage.ts` · **Sections:** S2 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Frequent full pretty JSON + double fsync on every chain/subagent persist is a main-process I/O bottleneck.
- **Evidence:** storage.ts → atomicWriteJson; config/loader.ts JSON.stringify(data, null, 2) + fsync file + parent dir.
- **Suggested fix:** Compact JSON for hot path, debounce coalescing, optional async write queue, avoid parent-dir fsync every mid-stream tick.

### M-P1-034 — SubagentManager never prunes records (process lifetime)

- **Status:** open
- **Primary:** `agents/manager.ts` · **Sections:** S2 · **Conf:** 93 · **Autofix:** gated_auto
- **Why it matters:** SubagentManager Map grows for process lifetime → memory leak and slower wait/list scans.
- **Evidence:** manager.ts Map; set on spawn; no delete/prune on complete/fail/session delete (only get/set/values).
- **Suggested fix:** Prune terminal records after persist TTL or on session close; cap retained history.

### M-P1-035 — Subagent tool events → debounced full-session rewrites of all chains

- **Status:** open
- **Primary:** `wire-subagents + persist` · **Sections:** S2 · **Conf:** 80 · **Autofix:** gated_auto
- **Why it matters:** Each tool event rewrites full session JSON (all chains) after 250ms debounce → disk storm under tool-heavy subagents.
- **Evidence:** manager _notify on tool_call/result; wire-subagents 250ms debounce → persistSubagentChains → full saveSession.
- **Suggested fix:** Persist only on terminal/step boundaries; dirty-flag single owner session; skip mid-tool message churn.

### M-P1-036 — Subagent `Chain.sessionId` is subagent id, not session UUID

- **Status:** open
- **Primary:** `agents/manager.ts:656` · **Sections:** S2 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Wrong Chain.sessionId breaks ownership, restore, and any session-scoped queries on nested chains.
- **Evidence:** manager makeEmptyChain(sessionKey, …) sets sessionId: sessionKey; spawn passes subagent id, not parent session UUID (record.sessionId is separate).
- **Suggested fix:** makeEmptyChain(parentSessionId, …) using options.sessionId / record.sessionId.

### M-P1-037 — Asymmetric restore: subagents → INTERRUPTED; chains keep ACTIVE

- **Status:** open
- **Primary:** `shared/types/chain.ts` · **Sections:** S2 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** Cold load leaves chains ACTIVE while subagents become INTERRUPTED → inconsistent resume UI and write targets.
- **Evidence:** Subagents: PENDING/RUNNING → INTERRUPTED on restore. Chains: keep active as ACTIVE (no freeze-on-restore).
- **Suggested fix:** On restore, map ACTIVE/running chains → INTERRUPTED (or COMPLETED) like subagents.

### M-P1-038 — Dual SubagentRecord / status enums + third `SubagentState` prompt DTO

- **Status:** open
- **Primary:** `manager + subagent.ts + system-prompt` · **Sections:** S2 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Dual records + third prompt DTO drift status/field names and complicate IPC/prompt correctness.
- **Evidence:** Runtime manager SubagentState; domain shared/types/subagent SubagentStatus; prompt DTO system-prompt SubagentState.
- **Suggested fix:** One domain model + thin runtime wrapper; shared status enum; map once at boundaries.

### M-P1-039 — Explicit `any` tool map disables type checking at LLM tool boundary

- **Status:** open
- **Primary:** `orchestrator.ts:726` · **Sections:** S2 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** any tool map disables compile-time checks at the LLM tool boundary.
- **Evidence:** orchestrator.ts Record<string, any> with eslint disable; return asserted as Record<string, Tool>.
- **Suggested fix:** Typed Tool map / helper factory that avoids deep instantiation without any.

### M-P1-040 — Unsafe double cast Zod→AI SDK in context-snapshot

- **Status:** open
- **Primary:** `context-snapshot.ts:32` · **Sections:** S2 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** Unsafe Zod↔SDK casts can mis-measure context or throw on schema shape changes.
- **Evidence:** context-snapshot.ts as unknown as { safeParse? } then zodToJsonSchema(tool.inputSchema as never).
- **Suggested fix:** Narrow via Zod/SDK type guards or store JSON Schema at tool registration.

### M-P1-041 — `fullStream` / `onStepFinish` cast away SDK discriminants

- **Status:** open
- **Primary:** `orchestrator.ts:411` · **Sections:** S2 · **Conf:** 80 · **Autofix:** gated_auto
- **Why it matters:** Casting away stream discriminants hides SDK shape breaks and mis-handles parts.
- **Evidence:** orchestrator.ts toolCalls cast; toolResults cast; chunk as Record<string, unknown> on fullStream.
- **Suggested fix:** Switch on typed part.type unions from AI SDK; avoid Record erase.

### M-P1-042 — Cancelled turns leave in-flight tools running (no abortSignal)

- **Status:** partial
- **Primary:** `tool-dispatch + orchestrator` · **Sections:** S2 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** Cancel can stop the stream while in-flight tools continue (esp. non-process tools). Process path improved; most tools still ignore abort.
- **Evidence:** Parent signal now flows orchestrator → tool-dispatch combined abort. Honored by execute-command + wait; not by most other tools.
- **Suggested fix:** Propagate abort into all long-running handlers; on turn cancel, abort tool ctx and await settle with timeout.

### M-P1-044 — Tier override affects model selection but not `Agent.tier` on record

- **Status:** open
- **Primary:** `tools/subagent/delegate.ts:107` · **Sections:** S2 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Tier override changes model selection but persisted Agent.tier / chain agentTier stay defaults → wrong attribution/UI.
- **Evidence:** delegate.ts resolves resolvedTier for getTierModelSelection but spawn passes original agent unchanged; display string uses override, record does not.
- **Suggested fix:** Spawn with { ...agent, tier: resolvedTier } (or explicit tier field on record).

### M-P1-045 — Unscoped subagent persist falls back to active session

- **Status:** open
- **Primary:** `persist-subagent-chains.ts:47` · **Sections:** S2 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Unscoped records can pollute the active session after a switch.
- **Evidence:** persist-subagent-chains unscoped → syncSubagentChains(unscoped) with no id; session/manager falls back to selectedSessionId().
- **Suggested fix:** Refuse unscoped persist in production; require sessionId at spawn; drop or quarantine null-owner records.

### M-P1-046 — HTTPS custom endpoints: no destination allowlist (credential SSRF)

- **Status:** open
- **Primary:** `drivers/compatible.ts:21` · **Sections:** S3 · **Conf:** 75 · **Autofix:** manual
- **Why it matters:** Stored API keys for generic HTTPS endpoints can be posted to any host (cloud metadata, LAN, attacker-controlled), i.e. credential SSRF.
- **Evidence:** validateGenericEndpoint in drivers/compatible.ts only checks scheme/creds/query and non-loopback HTTP confirmation. No private/link-local/metadata host block for https:.
- **Suggested fix:** Default-deny private/reserved destinations for generic endpoints; optional explicit allowlist; refuse env-auth + non-allowlisted hosts.

### M-P1-048 — Vault + connection mutations multi-step without joint atomicity

- **Status:** partial
- **Primary:** `main/ipc/providers.ts:631` · **Sections:** S3 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Vault + connection writes are still multi-step; a mid-sequence failure can leave secret without matching connection state (or reverse). Concurrency races mitigated by M-P0-009 mutex.
- **Evidence:** withConnectionMutationLock around submit/update/disconnect/disable/enable/validate. Still sequential: submit vault then connections.update; disconnect vault delete then update. No joint commit/rollback on second-step failure.
- **Suggested fix:** Single mutate connection + vault unit with compensating delete/restore, or transactional store; fault-injection tests.

### M-P1-049 — `submit_api_key` binds vault origin from stale snapshot while endpoint mutates

- **Status:** fixed
- **Primary:** `main/ipc/providers.ts` · **Sections:** S3 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Concurrent endpoint change during submit could bind the vault secret to the wrong origin. Concurrent stale-origin race fixed by per-connection lock + re-read under lock (M-P0-009).
- **Evidence:** PROVIDERS_SUBMIT_API_KEY runs entirely under withConnectionMutationLock, re-reads connection, binds via credentialBinding under that lock. PROVIDERS_UPDATE uses same per-connection chain.
- **Suggested fix:** Keep lock; optional regression test submit ∥ update-endpoint. Residual multi-step failure is 048.

### M-P1-050 — Invalid home config fails closed by quitting entire app

- **Status:** open
- **Primary:** `config/loader.ts:215` · **Sections:** S3 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** One bad ~/.orchid/config.json can prevent the app from starting at all.
- **Evidence:** loadConfigWithDiagnostics uses configSchema.parse(merged) — throws on invalid shape. Startup: ConfigManager.load → app.whenReady catch → app.quit(). No quarantine/defaults fallback for home layer.
- **Suggested fix:** On home schema failure: quarantine file, load defaults, surface diagnostic UI; only quit on unrecoverable IO.

### M-P1-051 — Dual model resolution: incomplete custom models allowed at resolve, rejected at gate

- **Status:** open
- **Primary:** `providers/resolver.ts:70` · **Sections:** S3 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** Resolver can treat incomplete custom model ids as resolved while IPC gate rejects them — inconsistent UX and late failures.
- **Evidence:** Gate requireStaticConnectionSupport requires full customModels entry when allowsCustomModels. Resolver: if allowsCustomModels && modelIds.includes, synthesizes bare { id, displayName, protocol }.
- **Suggested fix:** Align: reject incomplete custom models in resolver (same rule as gate), or allow incomplete only with explicit defaults in both paths.

### M-P1-052 — `mcp_servers` untyped nested bag on Config / IPC boundary

- **Status:** open
- **Primary:** `ipc-boundary.ts:114` · **Sections:** S1, S3, S4 · **Conf:** 88 · **Autofix:** manual
- **Why it matters:** Untyped mcp_servers bag is the IPC/config path that feeds process spawn (RCE surface with S1 P0).
- **Evidence:** Config.mcp_servers: Record<string, Record<string, unknown>>; Zod same; MCPServerConfig is structural + index signature. Validation only name/command shape.
- **Suggested fix:** Strict Zod MCPServerConfig (stdio | sse) at save/load; typed IPC; no free-form nested bag.

### M-P1-053 — Agent has ~0% action parity on provider/config ops

- **Status:** open
- **Primary:** `tools + system-prompt` · **Sections:** S3, S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Agent cannot manage providers/config; only UI/IPC can — ~0% action parity for that product surface.
- **Evidence:** Tools under main/tools/: session CRUD/model tools exist; no provider_* / config_* tools. Provider mutations only via registerProviderIPC / config IPC.
- **Suggested fix:** Agent tools wrapping list/create/update/validate/disconnect + config get/patch (with same vault/lock gates as IPC).

### M-P1-054 — Context starvation: no provider/config (and little product state) in system prompt

- **Status:** open
- **Primary:** `llm/system-prompt.ts` · **Sections:** S3, S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Without provider/config in the prompt, the agent cannot reason about connections, models, or settings state.
- **Evidence:** SystemPromptContext = cwd/tree/subagents/todos/bgcmds only. Dynamic prompt emits those blocks only; no providers/config inventory.
- **Suggested fix:** Inject redacted connection list, default/tier models, and key config flags into dynamic prompt (or a dedicated tool + prompt pointer).

### M-P1-055 — `providers:update` builds candidate via `as ProviderConnection`

- **Status:** open
- **Primary:** `main/ipc/providers.ts:607` · **Sections:** S1, S3 · **Conf:** 78 · **Autofix:** gated_auto
- **Why it matters:** Type assertion can hide incomplete patches and skip real structural validation of the candidate connection.
- **Evidence:** const candidate = { ...existing, ...patch } as ProviderConnection (ipc/providers.ts); then requireStaticConnectionSupport(candidate). Not schema-parsed as full ProviderConnection.
- **Suggested fix:** Build via Zod/satisfies ProviderConnection without cast; parse full candidate object.

### M-P1-056 — Config dual source: hand-written `Config` vs Zod schema

- **Status:** open
- **Primary:** `config/schema.ts` · **Sections:** S3 · **Conf:** 82 · **Autofix:** manual
- **Why it matters:** Hand-written Config and Zod can drift; types claim fields Zod may not enforce (and reverse).
- **Evidence:** Interface Config in ipc-boundary.ts; runtime schema in schema.ts with export type { Config } from ipc-boundary. defaults() is configSchema.parse({}) cast to that interface — dual sources.
- **Suggested fix:** export type Config = z.infer<typeof configSchema> (single source); keep IPC re-export.

### M-P1-057 — Accounting middleware `wrapGenerate` completely untested

- **Status:** open
- **Primary:** `accounting/middleware.ts:111` · **Sections:** S3 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** wrapGenerate is production accounting path for non-stream calls; untested regressions lose cost/ledger correctness.
- **Evidence:** Middleware implements wrapGenerate. Integration tests only exercise wrapStream; doGenerate stubbed "not used".
- **Suggested fix:** Mirror wrapStream tests for wrapGenerate success/fail/abort/ledger-unavailable.

### M-P1-058 — Provider IPC `validate` / `enable` / `status_refresh` untested

- **Status:** partial
- **Primary:** `main/ipc/providers.ts:651` · **Sections:** S3 · **Conf:** 88 · **Autofix:** manual
- **Why it matters:** enable/status_refresh are user-facing lifecycle paths; untested branches regress health/status UX. validate has some coverage.
- **Evidence:** PROVIDERS_VALIDATE covered (race + already-disabled) in provider-ipc.test.ts. No test hits PROVIDERS_ENABLE or PROVIDERS_STATUS_REFRESH.
- **Suggested fix:** Unit tests: enable from disabled; enable blocked when disconnected; status_refresh success/error coalescing.

### M-P1-059 — Vault fail-closed/corruption paths largely untested

- **Status:** partial
- **Primary:** `credentials/vault.ts` · **Sections:** S3 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Fail-closed vault on corrupt storage/decrypt is security-critical; sparse tests leave holes.
- **Evidence:** Tests cover encrypt, basic_text unavailable, binding, replace, delete. No tests for corrupt credentials.json, decrypt throw, isEncryptionAvailable()===false alone, or partial document recovery.
- **Suggested fix:** Inject corrupt file / decrypt failures; assert no plaintext leak and hard fail on read/store.

### M-P1-060 — Accounting store singleton init/fail-closed API untested

- **Status:** open
- **Primary:** `accounting/store.ts:356` · **Sections:** S3 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Provider turns must fail closed if the ledger singleton never initialized; untested API can silently regress.
- **Evidence:** initializeProviderAccountingStore / getProviderAccountingStore throw when unset. Unit tests only construct new ProviderAccountingStore(...); no singleton init/get/reset/fail-closed cases.
- **Suggested fix:** Tests: get before init throws; init failure stored and rethrown; reset clears.

### M-P1-061 — Middleware cost evidence (headers + Neuralwatt) never exercised

- **Status:** open
- **Primary:** `accounting/middleware.ts:60` · **Sections:** S3 · **Conf:** 82 · **Autofix:** manual
- **Why it matters:** Reported cost headers / Neuralwatt evidence drive calculateAttemptCost; untested middleware path → wrong or missing cost attribution.
- **Evidence:** evidenceFor + allowlisted cost headers + Neuralwatt branch used from wrapGenerate/wrapStream. Attempt-accounting tests pass response: { headers: {} } only. Neuralwatt header parsing tested on driver, not through accounting middleware.
- **Suggested fix:** Middleware tests with x-request-cost-usd and providerId: 'neuralwatt' headers/rawUsage asserting ledger cost/evidence.

### M-P1-062 — Child processes inherit full `process.env` (secret leak)

- **Status:** open
- **Primary:** `background-store / execute` · **Sections:** S4 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Child commands inherit the full Electron main env (API keys, tokens, secrets) with only cosmetic overrides.
- **Evidence:** background-store and execute-command use { ...process.env, ...ENV_SUPPRESSION } / PTY_ENV_SUPPRESSION (only NO_COLOR/TERM/PAGER).
- **Suggested fix:** Build a sanitized allowlist env (PATH, HOME, locale, project-needed vars); never spread full process.env.

### M-P1-063 — AST `rename_symbol` requires `file_path` but never uses it

- **Status:** open
- **Primary:** `tools/ast/rename-symbol.ts:21` · **Sections:** S4 · **Conf:** 95 · **Autofix:** gated_auto
- **Why it matters:** Schema advertises file_path but handler ignores it → wrong renames / misleading tool contract.
- **Evidence:** rename-symbol.ts requires file_path; handler only uses old_name/new_name; getSymbolsByName(old_name,'both') is project-wide.
- **Suggested fix:** Filter symbols by file_path (like find-symbol-references) or drop the field from the schema.

### M-P1-064 — RAG partial-path index deletes all other indexed files

- **Status:** open
- **Primary:** `rag/indexer.ts:386` · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Partial-path index treats non-listed files as deleted and wipes them from the index.
- **Evidence:** discoverFiles with paths only returns those paths; cleanup deletes any stored path not in currentRels (rag/indexer.ts).
- **Suggested fix:** Skip global delete-orphan pass when paths is a partial subset; only update/delete within that subset.

### M-P1-065 — `rag_search` always local ONNX; index may use API embedder

- **Status:** open
- **Primary:** `tools/rag/search.ts:72` · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Index may use API embeddings while search always embeds with local ONNX → dimension/space mismatch, empty/bad results.
- **Evidence:** Index: createEmbedderFromConfig() can return ApiEmbedder when embedding_api_model set. Search: always new Embedder({ model: cfg.rag.embedding_model }).
- **Suggested fix:** Use createEmbedderFromConfig() (or same frozen selection) in rag_search.

### M-P1-066 — `read_mcp_resource` treats MCP error strings as success

- **Status:** open
- **Primary:** `tools/mcp/resource.ts:60` · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** MCP failures surface as successful tool results (Error: ... text without isError).
- **Evidence:** manager.readResource returns `Error: ...` strings on failure; resource.ts only sets isError in catch, not when content starts with Error:.
- **Suggested fix:** Throw from readResource or check content.startsWith('Error:') / structured error (as MCP tool handlers do).

### M-P1-067 — MCP runner shutdown abandons hung `client.close` after 3s

- **Status:** open
- **Primary:** `mcp/manager.ts:497` · **Sections:** S4 · **Conf:** 82 · **Autofix:** gated_auto
- **Why it matters:** Hung client.close() is abandoned after 3s; processes/handles can leak.
- **Evidence:** Shutdown awaits runner with 3s race; runner closes clients without per-close timeout; on timeout runner is nulled while close may still hang.
- **Suggested fix:** Per-client close timeout + force-kill transport/child; track orphaned runners.

### M-P1-068 — HF model download fetch has no timeout

- **Status:** open
- **Primary:** `rag/embedder.ts:572` · **Sections:** S4 · **Conf:** 95 · **Autofix:** gated_auto
- **Why it matters:** HF model download can hang forever on stall.
- **Evidence:** downloadFile uses bare fetch(url) with no AbortSignal (embedder.ts); API embed path has 30s timeout but HF download does not.
- **Suggested fix:** AbortSignal.timeout(...) (or AbortController) on fetch + stream read idle timeout.

### M-P1-069 — AST/RAG index workers no overall timeout/cancel

- **Status:** open
- **Primary:** `ast/indexer.ts:376` · **Sections:** S4 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** AST/RAG workers have no wall-clock timeout or cancel; stuck workers pin CPU/memory.
- **Evidence:** runIndexInWorker only settles on message/error/exit — no timer, no abort (ast/indexer.ts, rag/indexer.ts).
- **Suggested fix:** Overall timeout + worker.terminate(); optional cancel token from IPC.

### M-P1-070 — Foreground `waitForExit` unbounded after kill

- **Status:** open
- **Primary:** `execute-command.ts:299` · **Sections:** S4 · **Conf:** 80 · **Autofix:** gated_auto
- **Why it matters:** After kill, tool can hang forever if exit never fires.
- **Evidence:** waitForExit only listens for exit/error with no timeout (execute-command.ts); used after kill.
- **Suggested fix:** Promise.race with timeout; force-resolve and log if process never exits.

### M-P1-072 — RAG holds full vector corpus as `number[][]`

- **Status:** partial
- **Primary:** `rag indexer + store` · **Sections:** S4 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Full corpus as number[][] during index/batch can OOM large projects. Search path uses compact Float32Array.
- **Evidence:** VectorState.vectors: number[][]; loadVectorState loads full arrays; search cache uses compact Float32Array — indexing path still full JS arrays.
- **Suggested fix:** Keep vectors as Float32Array (or mmap/disk-backed) through batch index; avoid number[][] copies.

### M-P1-073 — `glob` fully sync + unbounded matches

- **Status:** open
- **Primary:** `tools/filesystem/glob.ts` · **Sections:** S4 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Sync recursive glob with no max matches can block the main process and explode memory.
- **Evidence:** globSync/walkGlob fully sync, unbounded results (glob.ts); handler returns all matches.
- **Suggested fix:** Cap matches, async walk with yield, hard max + truncate notice.

### M-P1-074 — `grep` full-tree full-file load, no size bound

- **Status:** open
- **Primary:** `tools/search/grep.ts` · **Sections:** S4 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** Full-tree walk + full-file readFileSync with no file-size bound can OOM/hang.
- **Evidence:** collectFiles walks entire tree; searchFileSync reads whole file; only max_results and per-file 10s timeout, no size limit.
- **Suggested fix:** Max file size skip, streaming line read, optional overall match budget earlier in walk.

### M-P1-075 — AST stores every reference; tools return unbounded

- **Status:** open
- **Primary:** `ast store + tools` · **Sections:** S4 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** Common symbols can return huge unbounded result sets to the LLM.
- **Evidence:** getSymbolsByName selects all rows; find-symbol-references and rename-symbol return/process full lists with no limit.
- **Suggested fix:** SQL LIMIT + tool-level max with truncation metadata.

### M-P1-076 — Main RAG search cache stale after worker reindex

- **Status:** open
- **Primary:** ``rag/store.ts` cache` · **Sections:** S4 · **Conf:** 80 · **Autofix:** gated_auto
- **Why it matters:** Worker reindex updates disk; main-process search cache stays stale.
- **Evidence:** _searchCache is process-static (store.ts); worker invalidates only its own process map; main runIndexInWorker does not call RAGStore.clearCache() after success.
- **Suggested fix:** After worker result, RAGStore.clearCache() (or invalidate by dbPath) on main.

### M-P1-077 — Concurrent AST rename partial multi-file write

- **Status:** open
- **Primary:** `rename-symbol.ts` · **Sections:** S4 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Multi-file rename can partially apply; concurrent renames can interleave.
- **Evidence:** Phase 2 writes file-by-file with no rollback (rename-symbol.ts); no project-level lock; mid-loop failures leave earlier files written.
- **Suggested fix:** Write to temps then rename-commit; or transactional backup/rollback; serialize renames per project.

### M-P1-078 — Explicit `any` in `zodToJsonSchema` conversion

- **Status:** open
- **Primary:** `tools/registry.ts:84` · **Sections:** S4 · **Conf:** 95 · **Autofix:** gated_auto
- **Why it matters:** as any hides schema conversion errors and weakens type safety at the LLM boundary.
- **Evidence:** zodToJsonSchema(definition.inputSchema as any) (tools/registry.ts).
- **Suggested fix:** Type-safe wrapper / correct generic for zod-to-json-schema without any.

### M-P1-079 — Tree-sitter surface entirely `any`-typed

- **Status:** open
- **Primary:** `ast/parser.ts:34` · **Sections:** S4 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Entire tree-sitter surface is any → no compile-time safety for node/query APIs.
- **Evidence:** TreeSitterTree/Node/Language/Query = any (ast/parser.ts).
- **Suggested fix:** Use web-tree-sitter exported types / thin typed facades.

### M-P1-080 — Fallback MCP manager partial object cast to full MCPManager

- **Status:** open
- **Primary:** `tools/index.ts:67` · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Partial object cast as full MCPManager can throw or misbehave if more methods are called later.
- **Evidence:** fallbackMcpManager = { getResourceServer, listResources, readResource } as unknown as MCPManager (tools/index.ts).
- **Suggested fix:** Real null-object implementing the used interface, or optional MCPManager | null with guards.

### M-P1-081 — MCP tool inputs passthrough Zod

- **Status:** open
- **Primary:** `mcp/manager.ts:656` · **Sections:** S4 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** MCP tool args are not validated client-side; bad shapes go straight to servers.
- **Evidence:** _jsonSchemaToZod returns z.object({}).passthrough() (mcp/manager.ts).
- **Suggested fix:** Convert JSON Schema → Zod (library) or lightweight required-key checks before call.

### M-P1-082 — MCP config untyped Record cast at project boundary

- **Status:** open
- **Primary:** `mcp/project-registry.ts:18` · **Sections:** S4 · **Conf:** 82 · **Autofix:** manual
- **Why it matters:** Untyped Record + cast at project boundary can pass invalid MCP server configs into the manager.
- **Evidence:** Config schema: mcp_servers: z.record(z.string(), z.record(z.string(), z.unknown())); cast (config as MCPServerConfig) in project-registry.ts.
- **Suggested fix:** Zod-parse each server with a proper mcpServerConfigSchema at load/runtime boundary.

### M-P1-083 — Interactive PTY path untested

- **Status:** open
- **Primary:** `process tools` · **Sections:** S4 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Interactive PTY path is production code with almost no behavioral tests.
- **Evidence:** PTY spawn path in background-store.ts; tests only fake interactive: true entries or reject non-interactive send_input — no real node-pty I/O tests.
- **Suggested fix:** Integration tests with short interactive commands + send_input / exit / kill.

### M-P1-084 — `rag_index` / `rag_search` handlers never executed in tests

- **Status:** open
- **Primary:** `tools/rag` · **Sections:** S4 · **Conf:** 93 · **Autofix:** manual
- **Why it matters:** RAG tool handlers are unexercised → regressions in search/index flow go unnoticed.
- **Evidence:** Parity only checks definition/schema/handler presence; no ragSearchHandler(...) / ragIndexHandler(...) execution found.
- **Suggested fix:** Unit tests with fixture project + mock embedder for index/search/status/clear.

### M-P1-085 — AST indexing uses live `getConfig()`, not frozen project runtime

- **Status:** open
- **Primary:** `ast/indexer.ts:217` · **Sections:** S4 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Live getConfig() mid-index can pick up config changes from another project/session.
- **Evidence:** AST runIndexProjectImpl uses getConfig(); no frozen runtime config param (unlike RAG which accepts config?: Config).
- **Suggested fix:** Pass frozen Config from project runtime into AST index (mirror RAG worker startData.config).

### M-P1-086 — `getBuiltinToolRegistryForRuntime` caches first options forever

- **Status:** open
- **Primary:** `tools/index.ts:284` · **Sections:** S4 · **Conf:** 80 · **Autofix:** gated_auto
- **Why it matters:** First options for a runtime object are cached forever; later MCP/agents/skills updates ignored.
- **Evidence:** WeakMap<object, ToolRegistry>; hit returns cached without re-merging options (tools/index.ts).
- **Suggested fix:** Key by runtime + options fingerprint, or only cache when options are empty/default; invalidate on MCP acquire.

### M-P1-087 — MCP allowlist naive regex vs minimatch for builtins

- **Status:** open
- **Primary:** `llm/orchestrator.ts:784` · **Sections:** S4, S6 · **Conf:** 85 · **Autofix:** gated_auto
- **Why it matters:** MCP allowlist uses naive *→.* regex; builtins use minimatch → inconsistent matching (e.g. path separators, **).
- **Evidence:** MCP: pattern.replace(/\*/g, '.*') (orchestrator.ts); builtins: minimatch (tools/registry.ts).
- **Suggested fix:** Use minimatch (same as ToolRegistry.filter) for MCP tool allowlisting.

### M-P1-088 — Composer `isSendingRef` sticks after silent send gates

- **Status:** open
- **Primary:** `renderer/InputArea.tsx:383` · **Sections:** S5 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Composer can permanently refuse further sends if isSendingRef is set true and never cleared. Silent early-returns from onSend leave the ref stuck when status never transitions.
- **Evidence:** InputArea.tsx sets isSendingRef=true then await onSend; only clears on catch. Clear path is useEffect when status==='idle'. If useChat.send returns early without changing status, the effect does not re-fire and the composer stays locked.
- **Suggested fix:** Clear isSendingRef in a finally after onSend, or have send always return a settled result and reset the ref on every non-stream path.

### M-P1-089 — Esc/cancel has no mutual exclusion across stages

- **Status:** open
- **Primary:** `renderer/hooks/useChat.ts:757` · **Sections:** S5 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** Multi-stage Esc can race concurrent chat.cancel invokes and skip/double-apply stages, corrupting interrupt UI and tool-block state.
- **Evidence:** useChat.ts cancel has no in-flight mutex; each Esc awaits IPC independently. Stages advance only from response status with no serialization of overlapping calls.
- **Suggested fix:** Add cancelInFlightRef (or a small queue) so only one cancel request runs; ignore/coalesce Esc while pending.

### M-P1-090 — `chat.send` catch leaves optimistic bubble + half-stream state

- **Status:** open
- **Primary:** `renderer/hooks/useChat.ts:748` · **Sections:** S5 · **Conf:** 78 · **Autofix:** gated_auto
- **Why it matters:** IPC throw leaves an optimistic user bubble, status='error', and half-initialized stream clocks/segments without rollback.
- **Evidence:** Optimistic append in useChat; structured result.status==='error' rolls back bubble; bare catch only sets error/status and does not drop the bubble or clear stream timers/segments.
- **Suggested fix:** Share one rollback helper for structured error and catch (remove optimistic msg, clear streamStartTime/elapsed/segments, reset refs).

### M-P1-093 — Config draft is untyped `Record` with cast-to-Config

- **Status:** open
- **Primary:** `ConfigView.tsx:65` · **Sections:** S5 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Untyped draft + cast bypasses Config shape; bad partials can ship until main-process validation, with weak UI-side safety.
- **Evidence:** ConfigView.tsx useState<Record<string, unknown>>({}); { ...originalConfig, ...draft } as Config; save updates as Partial<Config>.
- **Suggested fix:** Type draft as Partial<Config> (or Zod-parsed patches) and validate before save/display.

### M-P1-094 — `orchid:config-updated` treats `default_model` as ModelSelection without narrowing

- **Status:** open
- **Primary:** `ChatView.tsx:181` · **Sections:** S5 · **Conf:** 82 · **Autofix:** gated_auto
- **Why it matters:** Invalid default_model payloads become trusted ModelSelection state and can break model picker/session selection.
- **Evidence:** ChatView.tsx setDefaultSelection(detail.default_model as ModelSelection | null) with no modelSelectionSchema.safeParse. Schema exists at shared/types/provider.ts.
- **Suggested fix:** Parse with modelSelectionSchema.safeParse (null on failure) before setDefaultSelection.

### M-P1-095 — 100ms elapsed ticker rebuilds full chat history every tick

- **Status:** partial
- **Primary:** ``useChat.ts:317` + ChatStream` · **Sections:** S5 · **Conf:** 95 · **Autofix:** gated_auto
- **Why it matters:** 10 Hz elapsed updates still recompute full committed history via elapsedSeconds in history memo deps, hurting long sessions. Live tail split mitigates some thrash.
- **Evidence:** Ticker useChat.ts 100ms. ChatStream history useMemo depends on elapsedSeconds even though live tail is split.
- **Suggested fix:** Keep elapsed only on live/footer path; remove from history rebuild inputs (or pass via ref/context to the active footer).

### M-P1-096 — Unbatched per-token stream updates thrash ChatView tree

- **Status:** partial
- **Primary:** `useChat.ts:342` · **Sections:** S5 · **Conf:** 92 · **Autofix:** gated_auto
- **Why it matters:** Every token still does multiple React state updates in the chat hook, thrashing subscribers even with ChatStream history/live split.
- **Evidence:** useChat.ts — each chunk: setStreamingContent + applyStreamSegments → setStreamSegments. No rAF/batch coalesce. ChatStream mitigates full-list rebuild but parent state churn remains.
- **Suggested fix:** Coalesce chunk/thinking updates on rAF or a short throttle; single setState with combined payload.

### M-P1-097 — Streaming assistant fully re-parses markdown every chunk

- **Status:** open
- **Primary:** `MarkdownContent.tsx:91` · **Sections:** S5 · **Conf:** 90 · **Autofix:** gated_auto
- **Why it matters:** Full markdown+GFM+highlight pipeline on every content change is expensive during streaming.
- **Evidence:** MarkdownContent.tsx — useMemo(..., [content]) still fully re-runs ReactMarkdown + remark-gfm + rehype-highlight whenever content grows.
- **Suggested fix:** Stream as plain text (or incremental parser); parse markdown only on finalize / debounce; optional virtualized code blocks.

### M-P1-098 — Command palette navigation dispatches dead `orchid:navigate`

- **Status:** open
- **Primary:** `CommandPalette.tsx:345` · **Sections:** S5 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Palette navigation actions appear to work but no-op — dead product surface.
- **Evidence:** CommandPalette.tsx dispatches orchid:navigate. Repo-wide grep: only that emit; no addEventListener('orchid:navigate').
- **Suggested fix:** Wire listener to Sidebar/section openers, or remove/replace navigation actions with real callbacks.

### M-P1-099 — Domain hook `useChat` imports UI `ContextGrid` for pure math

- **Status:** open
- **Primary:** `useChat.ts:29` · **Sections:** S5 · **Conf:** 88 · **Autofix:** gated_auto
- **Why it matters:** Domain hook depends on a UI component module, coupling layers and risking circular deps/bundle noise.
- **Evidence:** useChat.ts imports computeContextBreakdown / ContextBreakdown from ../components/ContextGrid. Pure math still lives in ContextGrid.tsx.
- **Suggested fix:** Move pure helpers to shared/ or renderer/lib/context-breakdown.ts; keep ContextGrid presentational.

### M-P1-100 — `useChat` / `useSession` / `useSessionTabs` behavioral surface almost untested

- **Status:** open
- **Primary:** `renderer hooks + tests` · **Sections:** S5 · **Conf:** 90 · **Autofix:** manual
- **Why it matters:** Core chat/session UX (send/cancel/stream/error/switch) has almost no behavioral tests; regressions ship easily.
- **Evidence:** Only pure affinity helpers tested (use-chat-affinity.test.ts). use-session-cache.test.ts covers cache, not tabs/CRUD UX. Integration chat-sidebar largely asserts files exist.
- **Suggested fix:** RTL/hook tests for send gates, cancel stages, catch rollback, session switch affinity, tab close.

### M-P1-101 — Preferences/onboarding tests assert mocks/booleans, not ConfigView

- **Status:** open
- **Primary:** `preferences-onboarding.test.ts` · **Sections:** S5 · **Conf:** 95 · **Autofix:** manual
- **Why it matters:** Preferences/onboarding coverage does not exercise ConfigView behavior, so UI regressions are invisible.
- **Evidence:** preferences-onboarding.test.ts — defaults, mock config.get/save, file-existence checks, CSS class presence; no component render/interaction of ConfigView draft/save.
- **Suggested fix:** Component tests for load→edit draft→save, dirty dialog, MCP restart gate.

### M-P1-102 — Omitted `allowed_skills` defaults to `['*']` for several default agents

- **Status:** open
- **Primary:** `agents/registry.ts:87` · **Sections:** S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Omitted allowed_skills becomes full skill access (['*']), widening capability for agents that never opted in.
- **Evidence:** agents/registry.ts getStringArray(metadata, 'allowed_skills', ['*']). Agents missing key: explorer, web-fetch, web-researcher, agent-native-reviewer, scope-guardian-reviewer, spec-flow-analyzer.
- **Suggested fix:** Default to [] when omitted; require explicit ['*'] or listed skills; add frontmatter to those six agents.

### M-P1-103 — Skill discovery claimed in system prompt but prompt injects no skill inventory

- **Status:** open
- **Primary:** `system-prompt + skill.ts` · **Sections:** S6 · **Conf:** 100 · **Autofix:** gated_auto
- **Why it matters:** Model is told inventory lives in the system prompt, but inventory is only in the skill tool schema — discovery path is inconsistent/misleading.
- **Evidence:** general/AGENT.md "tool lists all available skills"; skill.ts description says skills are listed in the system prompt while inventory is only in inputSchema name describe. system-prompt.ts has no skill list injection.
- **Suggested fix:** Align copy (tool description only) and/or inject a compact skill inventory into dynamic system prompt.

### M-P1-105 — Command palette actions without agent tools (/cd, /model, /sessions, …)

- **Status:** partial
- **Primary:** `renderer/commands/registry.ts` · **Sections:** S6 · **Conf:** 85 · **Autofix:** manual
- **Why it matters:** Agents cannot fully drive UI command-palette workflows; automation/agent-native parity is incomplete. Session tools landed under M-P0-024.
- **Evidence:** Session tools exist: session_list/create/load/rename/delete/change_model. Palette still has /cd, /model, /sessions, /personality. No agent tools for cwd rebind, personality, or definition CRUD.
- **Suggested fix:** Add missing agent tools (cwd, personality) or document intentional UI-only surface; map palette actions to tools where product wants agent parity.

### M-P1-106 — Workspace rebind (`/cd`) no agent equivalent

- **Status:** open
- **Primary:** `session IPC` · **Sections:** S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Workspace rebind is a core product action (/cd / session workspace IPC) with no agent equivalent.
- **Evidence:** /cd in commands/registry.ts. IPC session:set_workspace exists. No session_change_cwd (or similar) in tool registry tool names.
- **Suggested fix:** Add a gated session_set_workspace / change_cwd tool with validation + abort-in-flight semantics matching UI rebind.

### M-P1-107 — Personality switch UI-only

- **Status:** open
- **Primary:** `commands` · **Sections:** S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Personality is config-driven behavior agents cannot switch mid-session autonomously.
- **Evidence:** UI: palette /personality + ChatView config.save({ personality }). No personality tool under src/main/tools/.
- **Suggested fix:** Agent tool wrapping config/personality update with same persistence and prompt-reload rules as UI.

### M-P1-108 — Definition CRUD (agents/skills/personalities) UI-only

- **Status:** open
- **Primary:** `defs IPC` · **Sections:** S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** Agents/skills/personalities CRUD is Settings-only; agents cannot maintain definitions.
- **Evidence:** UI/IPC: definitions.list, personality:save/delete. No create/update/delete agent tools in src/main/tools/.
- **Suggested fix:** Optional manage tools behind allowlist, or accept as intentional human-only and document.

### M-P1-109 — General MCP allowlist hard-coded to context7/example

- **Status:** open
- **Primary:** `general/AGENT.md` · **Sections:** S6 · **Conf:** 75 · **Autofix:** gated_auto
- **Why it matters:** General agent only allows two hard-coded MCP server globs; user-configured MCP tools stay unreachable by name allowlist.
- **Evidence:** general/AGENT.md mcp::context7::*, mcp::example::* only (plus read_mcp_resource / list_mcp_resources). No dynamic expansion from configured servers.
- **Suggested fix:** Allow mcp::* (or config-driven patterns) for general; keep tighter lists on subagents.

### M-P1-110 — system-prompt branches largely untested

- **Status:** open
- **Primary:** `llm/system-prompt.ts` · **Sections:** S6 · **Conf:** 100 · **Autofix:** manual
- **Why it matters:** OS/static/dynamic prompt branches are security- and behavior-critical with thin coverage.
- **Evidence:** system-prompt.ts has OS branches and dynamic sections (tree/subagents/todos/bg cmds). Tests: build-prompt-context.test.ts one happy path; no dedicated unit suite for OS/escape/branch matrix.
- **Suggested fix:** Unit tests for static OS strings, XML escaping, empty/partial dynamic sections.

### M-P1-111 — web-fetch summarizer production wiring untested

- **Status:** open
- **Primary:** `tools/index.ts` · **Sections:** S6 · **Conf:** 75 · **Autofix:** manual
- **Why it matters:** Production summarize path (spawn web-fetch agent via SubagentManager) can break without tests catching wiring/runtime requirements.
- **Evidence:** Production: tools/index.ts buildWebFetchSummarizer + register. Tests: todo-web-tools injects mock summarize or asserts missing callback; no test of buildWebFetchSummarizer / manager spawn path.
- **Suggested fix:** Unit-test summarizer builder (missing agent → undefined; spawn/wait success/error; requires sessionId+projectRuntime).


---

## P2 — Moderate (89)

| ID | Title | Primary file | Sections | Conf | Autofix | Status |
|----|-------|--------------|----------|------|---------|--------|
| M-P2-001 | Stream error path never completes activity to terminal idle | `chat.ts:1499` | S1 | 50 | advisory | open |
| M-P2-002 | Auto-update `signed` gate ineffective on non-macOS packaged builds | `index.ts:277` | S1 | 50 | gated_auto | open |
| M-P2-003 | `quitAndInstall` strips all `before-quit` cleanup | `updater.ts:202` | S1 | 75 | gated_auto | open |
| M-P2-004 | `tool:execute` has no timeout or abort | `tool.ts:113` | S1 | 75 | gated_auto | open |
| M-P2-005 | RAG/AST index IPC has no cancel/abort once started | `ipc/rag.ts:58` | S1 | 50 | manual | open |
| M-P2-006 | Cancel/stop status kinds untyped (`status: string`) | `ipc.ts` / OrchidAPI | S1, S5 | 100 | manual | open |
| M-P2-007 | `session:change_model` response richer than OrchidAPI documents | `ipc.ts:614` | S1 | 100 | manual | open |
| M-P2-008 | `ChatStateEvent.state` widened to `string` vs closed snapshot union | `ipc.ts:172` | S1 | 100 | manual | open |
| M-P2-009 | Inconsistent IPC error shapes (throw vs structured vs soft-success) | multi IPC | S1, S3 | 82 | manual | open |
| M-P2-010 | Definition save Zod accepts names `DEFINITION_NAME_PATTERN` later rejects | `ipc/definitions.ts:31` | S1 | 75 | manual | open |
| M-P2-011 | `config:save` double `unknown` cast for merge | `ipc/config.ts:166` | S1 | 75 | gated_auto | open |
| M-P2-012 | Status-bearing IPC results mostly `{ status: string }` | `ipc.ts:555` | S1 | 75 | manual | open |
| M-P2-013 | Unbounded `chat:send` message size | `chat.ts:79` | S1 | 75 | gated_auto | open |
| M-P2-014 | Definition save unbounded `system_prompt`/content | `definitions.ts:33` | S1 | 75 | gated_auto | open |
| M-P2-015 | `chat:stop`/`chat:cancel` any `sessionId` without ownership | `chat.ts:1589` | S1 | 75 | gated_auto | open |
| M-P2-016 | `bgcmd:snapshot` `lastN` has no upper bound | `chat.ts:99` | S1 | 75 | safe_auto | fixed |
| M-P2-017 | `chat-history` params/docs still say `windowId`, callers use `sessionId` | `chat-history.ts:10` | S1 | 100 | safe_auto | fixed |
| M-P2-018 | IPC Zod schemas private; no shared export for contract tests | `main/ipc/` | S1 | 100 | manual | open |
| M-P2-019 | `providers.ts` second large mixed-concern module (~801 lines) | `ipc/providers.ts` | S1, S3 | 75 | manual | open |
| M-P2-020 | Allowlist completeness tests partial vs full `IPC_CHANNELS` | `app-shell.test.ts:80` | S1 | 100 | gated_auto | open |
| M-P2-021 | `electron/CLAUDE.md` documents non-existent IPC modules / wrong paths | `electron/CLAUDE.md` | S1, S3, S4, S6 | 100 | safe_auto | fixed |
| M-P2-022 | `tool:execute` no IPC tests and no renderer consumers | `ipc/tool.ts` | S1 | 75 | manual | open |
| M-P2-023 | XState snapshot context repeatedly asserted as `AgentContext` | `chat.ts:300` | S1 | 50 | gated_auto | open |
| M-P2-024 | `ActiveAgent.abortController` never wired to stream AbortController | `ipc/chat.ts:1035` | S2 | 75 | gated_auto | open |
| M-P2-025 | Esc phase 2 does not cancel subagents until third Esc (design + orphaning) | `chat.ts:1638` | S2 | 75 | advisory | open |
| M-P2-026 | Agent machine ERROR nulls abortController while invoke races | `agent-machine.ts:394` | S2 | 50 | gated_auto | open |
| M-P2-027 | Provider-quirks mid-stream suppression cannot see stream errors | `provider-quirks.ts:99` | S2 | 75 | gated_auto | open |
| M-P2-028 | Throttle timer can fire after stream teardown | `throttle.ts:80` | S2 | 75 | safe_auto | fixed |
| M-P2-029 | `toolsInFlight` can stick if tool-result never arrives | `orchestrator.ts:346` | S2 | 75 | gated_auto | open |
| M-P2-030 | No concurrency/spawn-rate limit on `delegate_to_subagent` | delegate + manager | S2 | 80 | gated_auto | open |
| M-P2-031 | `wait_for_subagent` injects full result without offload | `wait.ts` | S2 | 72 | gated_auto | open |
| M-P2-032 | Historical THINKING fully replayed every request | `history.ts` | S2 | 70 | gated_auto | open |
| M-P2-033 | Two public SubagentRecord shapes (runtime vs domain) | manager vs shared | S2 | 80 | manual | open |
| M-P2-034 | Domain SubagentRecord mixes snake_case and camelCase | `subagent.ts:29` | S2 | 75 | manual | open |
| M-P2-035 | `subagentRecordSchema` incomplete vs type | `subagent.ts:61` | S2 | 70 | manual | open |
| M-P2-036 | Domain agent type/tier plain `string` | `subagent.ts:32` | S2 | 82 | gated_auto | open |
| M-P2-037 | Enum narrowing via Set + assertion | `agents/registry.ts:96` | S2 | 78 | gated_auto | open |
| M-P2-038 | Session load trusts `JSON.parse` cast | `session/storage.ts:224` | S2 | 72 | gated_auto | open |
| M-P2-039 | Mid-turn cancel: tool_call without tool_result until filter drops | chat + history | S2 | 78 | gated_auto | open |
| M-P2-040 | Overlapping chat:send after hydrate can abort just-started peer turn | `chat.ts` | S2 | 72 | gated_auto | open |
| M-P2-041 | God-modules: orchestrator ~930 + session/agent managers | multi | S2 | 75 | manual | open |
| M-P2-042 | Tool handlers type assertions vs Zod parse | subagent tools | S2 | 65 | gated_auto | open |
| M-P2-043 | Log redaction misses non-`sk-` key formats | `logging.ts:55` | S3 | 50 | safe_auto | fixed |
| M-P2-044 | `storeApiKey` appends generations (orphan secrets) | `vault.ts:331` | S3 | 100 | gated_auto | open |
| M-P2-045 | Session cost totals attach global `unknownCount` to every currency row | `accounting/store.ts:329` | S3 | 100 | safe_auto | fixed |
| M-P2-046 | Stream attempt can finalize succeeded without finish usage | `accounting/middleware.ts:201` | S3 | 75 | gated_auto | open |
| M-P2-047 | `config:save` persists values `validateConfig` rejects | `ipc/config.ts:171` | S3 | 75 | gated_auto | open |
| M-P2-048 | ProviderStatusCache `put()` no write serialization | `status/cache.ts:162` | S3 | 85 | gated_auto | open |
| M-P2-049 | Status refresh coalescing ignores manual vs automatic | `status/service.ts:140` | S3 | 80 | gated_auto | open |
| M-P2-050 | Corrupt config JSON silently treated as empty layer | `loader.ts:49` | S3 | 75 | gated_auto | open |
| M-P2-051 | `config:save` rejects `providers` while types/tombstones still treat it writable | multi | S3 | 88 | manual | open |
| M-P2-052 | `ProviderStatusView.data` unversioned open bag | `ipc.ts:311` | S1, S3 | 72 | manual | open |
| M-P2-053 | `FrozenProviderRequestSnapshot.protocol` is `string` | `accounting.ts:59` | S3 | 85 | gated_auto | open |
| M-P2-054 | Accounting provenance bags open `unknown` | `accounting.ts:37` | S3 | 76 | manual | open |
| M-P2-055 | SQLite rows cast to `AttemptRow` without row Zod | `accounting/store.ts:282` | S3 | 74 | gated_auto | open |
| M-P2-056 | Config validation blanket unknown casts | `validation.ts:113` | S3 | 72 | gated_auto | open |
| M-P2-057 | `environmentVariable!` non-null assertion | `ipc/providers.ts:549` | S3 | 70 | gated_auto | open |
| M-P2-058 | Connection rules triplicated (IPC / resolver / registry) | multi | S3 | 75 | manual | open |
| M-P2-059 | Fresh driver registry on every `services()` | `ipc/providers.ts:148` | S3 | 75 | safe_auto | fixed |
| M-P2-060 | `deepMergeProviderDict` name obsolete | `config/merge.ts:76` | S3 | 75 | safe_auto | fixed |
| M-P2-061 | Empty `providers` config field permanent shim | `schema.ts:41` | S3 | 75 | manual | open |
| M-P2-062 | Zod and `validateConfig` duplicate constraints | `validation.ts:89` | S3 | 75 | manual | open |
| M-P2-063 | `customModels` can override catalog model metadata for same id | `resolver.ts` | S3 | 85 | gated_auto | open |
| M-P2-064 | Disconnect deletes vault before health flips (race window) | `ipc/providers.ts` | S3 | 75 | gated_auto | open |
| M-P2-065 | Resolver lifecycle unavailability reasons untested | `resolver.ts` | S3 | 80 | manual | open |
| M-P2-066 | Config IPC `model_metadata` / `list_personalities` / unknown-key untested | `ipc/config.ts` | S3 | 78 | manual | open |
| M-P2-067 | Catalog transport/coalescing under-tested | catalog updater | S3 | 75 | manual | open |
| M-P2-068 | Cost formula reasoning branches under-tested | `cost.ts` | S3 | 75 | manual | open |
| M-P2-069 | Docs: `connections.json` vs actual `providers.json` | CLAUDE.md vs store | S3 | 80 | safe_auto | fixed |
| M-P2-070 | Docs: project config path `.orchid/config.json` vs `.orchid.json` | CLAUDE.md vs loader | S3 | 80 | safe_auto | fixed |
| M-P2-071 | `config:model_metadata` skips Zod at IPC boundary | `ipc/config.ts:128` | S3 | 90 | gated_auto | open |
| M-P2-072 | Skill resource path no realpath (symlink escape) | `skill/skill.ts:202` | S4 | 75 | gated_auto | open |
| M-P2-073 | AST rename write without containment | `rename-symbol.ts:111` | S4 | 50 | gated_auto | open |
| M-P2-074 | web_fetch unescaped URL/title in XML | `fetch.ts:341` | S4 | 50 | safe_auto | fixed |
| M-P2-075 | Glob/grep from `/` when absolute directory_path | multi | S4 | 75 | gated_auto | open |
| M-P2-076 | ensureIndexed waiters after failed concurrent index | `ast/indexer.ts:123` | S4 | 88 | gated_auto | open |
| M-P2-077 | Sticky `default_project_dir` memory vs disk abort | `workspace.ts:89` | S4 | 85 | gated_auto | open |
| M-P2-078 | RAG `readAndHash` ignores frozen config for max_file_size | `indexer.ts:597` | S4 | 82 | gated_auto | open |
| M-P2-079 | AST `initializedProjects` never re-indexes if DB cleared | `indexer.ts:156` | S4 | 80 | gated_auto | open |
| M-P2-080 | grep concurrent can exceed max_results | `grep.ts:261` | S4 | 78 | gated_auto | open |
| M-P2-081 | background_command_idle_timeout never kills idle processes | background-store | S4 | 72 | advisory | open |
| M-P2-082 | HeadTailBuffer Buffer.concat every append | head-tail-buffer | S4 | 82 | gated_auto | open |
| M-P2-083 | RAG/AST discovery Promise.all fan-out | indexers | S4 | 78 | gated_auto | open |
| M-P2-084 | MCP sequential server startup | manager.ts | S4 | 76 | gated_auto | open |
| M-P2-085 | callTool timeout does not cancel server work | manager.ts | S4 | 75 | gated_auto | open |
| M-P2-086 | write/edit full content / LCS blowup | write/edit | S4 | 80 | gated_auto | open |
| M-P2-087 | atomicWrite temp name collision concurrent writers | ast/utils | S4 | 70 | gated_auto | open |
| M-P2-088 | Background process union not discriminated | background-store | S4 | 80 | gated_auto | open |
| M-P2-089 | Todo storage unchecked casts | `shared/todo.ts` | S4 | 78 | gated_auto | open |
| M-P2-090 | send_input / wait_ms / agentScope visibility test gaps | process tools tests | S4 | 90 | manual | open |
| M-P2-091 | CLAUDE.md documents non-existent `layers.ts` | CLAUDE.md | S4 | 100 | safe_auto | fixed |
| M-P2-092 | loadSkills mutates process-wide registry | skills/registry | S4, S6 | 80 | gated_auto | open |
| M-P2-093 | `hydrateSnapshot` drops buffered events when `live` is null | `useChat.ts:917` | S5 | 72 | gated_auto | open |
| M-P2-094 | Config session delete/create does not refresh ChatView list | ConfigView | S5 | 80 | gated_auto | open |
| M-P2-095 | New stream always yanks scroll to bottom | `ChatStream.tsx:184` | S5 | 75 | gated_auto | open |
| M-P2-096 | MCP server config stays `Record` with unchecked casts (renderer) | MCPServersTab | S5 | 80 | gated_auto | open |
| M-P2-097 | RAG number handler casts onto every RAGConfig field | RAGTab | S5 | 78 | gated_auto | open |
| M-P2-098 | OrchidAPI required on Window but renderer uses optional everywhere | hooks | S5 | 74 | advisory | open |
| M-P2-099 | Message list fully mounted; no virtualization/memo | ChatStream | S5 | 82 | gated_auto | open |
| M-P2-100 | smooth `scrollIntoView` every streamingContent change | ChatStream | S5 | 85 | gated_auto | open |
| M-P2-101 | `toolBlocks` in history deps forces O(n) rebuild on tool churn | ChatStream | S5 | 80 | gated_auto | open |
| M-P2-102 | Slash menu + palette duplicate selection/filter pipelines | InputArea + CommandPalette | S5 | 92 | manual | open |
| M-P2-103 | ChatView monolithic orchestrator (~1.1k LOC) | ChatView | S5 | 80 | manual | open |
| M-P2-104 | `orchid:theme-applied` dispatched with no product listeners | themes/index.ts | S5 | 95 | safe_auto | fixed |
| M-P2-105 | `useGlobalShortcuts` / ChatView orchestration / focus trap test gaps | keyboard + ChatView | S5 | 85 | manual | open |
| M-P2-106 | Roving-list test reimplements clamp math instead of hook | roving-list-index.test.ts | S5 | 80 | gated_auto | open |
| M-P2-107 | loadAgents/loadSkills mutate process-wide tool singleton | registries | S6 | 75 | gated_auto | open |
| M-P2-108 | docs/solutions Python-only; Electron domains unrepresented | docs/solutions | S1–S6 | 100 | advisory | open |
| M-P2-109 | Runtime tool registry WeakMap cache untested | tools/index.ts | S6 | 75 | manual | open |
| M-P2-110 | Agent invalid-tier skip untested | agents/registry | S6 | 100 | manual | open |
| M-P2-111 | Reserved internal agents only partially guarded in tests | agents/registry | S6 | 75 | manual | open |
| M-P2-112 | buildModelResults/buildSessionResults untested | commands/registry | S6 | 100 | manual | open |
| M-P2-113 | Command execute error paths untested | commands/registry | S6 | 75 | manual | open |
| M-P2-114 | File delete no first-class tool (shell only) | tools | S6 | 75 | manual | open |
| M-P2-115 | `rag_index` Decision-enum mild anti-pattern | tools/rag | S6 | 70 | advisory | open |

---

## P3 — Low (28)

| ID | Title | Primary file | Sections | Conf | Autofix | Status |
|----|-------|--------------|----------|------|---------|--------|
| M-P3-001 | Updater channel docs disagree with `IPC_CHANNELS` names | `updater.ts:10` | S1 | 100 | safe_auto | fixed |
| M-P3-002 | No IPC versioning/deprecation surface | `ipc.ts:718` | S1 | 50 | advisory | open |
| M-P3-003 | Updater check/download no concurrency/hang guard | `updater.ts:164` | S1 | 50 | gated_auto | open |
| M-P3-004 | No rate limits on expensive IPC (index, tool, chat) | `rag.ts:59` | S1 | 75 | advisory | open |
| M-P3-005 | Message factories omit `MessageType.ERROR` | message-factories.ts | S2 | 65 | gated_auto | open |
| M-P3-006 | `ApiMessage` untyped role/content unions | message.ts:121 | S2 | 65 | gated_auto | open |
| M-P3-007 | Duplicate `toApiMessages edge cases` describe block in tests | llm-orchestrator.test.ts | S2 | 75 | safe_auto | fixed |
| M-P3-008 | `wait_for_subagent` under-signals ownership/not-found (`isError`) | wait.ts:70 | S2 | 65 | gated_auto | open |
| M-P3-009 | XState is thin stream shell; docs imply full agentic loop | agent-machine + CLAUDE | S2 | 75 | advisory | open |
| M-P3-010 | Env numeric overrides can inject NaN | merge.ts:338 | S3 | 75 | safe_auto | fixed |
| M-P3-011 | Disconnect interrupt wins over late stream success (cost loss) | accounting store | S3 | 75 | advisory | open |
| M-P3-012 | `validateConfig` errors never enforced at runtime | loader.ts:294 | S3 | 70 | gated_auto | open |
| M-P3-013 | Provider create `modelIds` required in TS, defaulted in Zod | ipc.ts | S3 | 78 | gated_auto | open |
| M-P3-014 | Accounting types internal-only (no IPC) | accounting.ts | S3 | 70 | advisory | open |
| M-P3-015 | Stale U8 “until then” comment on config IPC | ipc/config.ts:5 | S3 | 100 | safe_auto | fixed |
| M-P3-016 | No permanent connection hard-delete API | connection-store | S3 | 100 | advisory | open |
| M-P3-017 | Interactive PTY uses user SHELL with full env | background-store | S4 | 50 | advisory | open |
| M-P3-018 | MCP error prefix-based detection fragile | manager.ts | S4 | 75 | gated_auto | open |
| M-P3-019 | drainAbort controllers unused | background-store | S4 | 65 | safe_auto | fixed |
| M-P3-020 | Runtime registry keyed by untyped `object` | tools/index.ts | S4 | 80 | gated_auto | open |
| M-P3-021 | Embedder non-null tensor assertions | embedder.ts | S4 | 72 | gated_auto | open |
| M-P3-022 | Skill catalog embedded in Zod `.describe()` | skill.ts | S4 | 65 | gated_auto | open |
| M-P3-023 | Todo notify createRequire electron | tools/index.ts | S4 | 70 | manual | open |
| M-P3-024 | MCP string `Error:` protocol vs structured isError | manager + orchestrator | S4 | 75 | gated_auto | open |
| M-P3-025 | `acceptChatEvent` can latch streamSessionId on first draft event | useChat | S5 | 55 | gated_auto | open |
| M-P3-026 | GeneralTab number handler ignores invalid/zero (UX snap-back) | GeneralTab | S5 | 70 | gated_auto | open |
| M-P3-027 | Custom DOM events use unchecked CustomEvent casts | App.tsx | S5 | 72 | gated_auto | open |
| M-P3-028 | `filter(Boolean) as Command[]` | CommandPalette | S5 | 68 | safe_auto | fixed |
| M-P3-029 | Vacuous keyboard shortcut tests (literal equality) | command-palette / preferences tests | S5, S6 | 100 | safe_auto | fixed |
| M-P3-030 | Silent agent skip on invalid frontmatter (no log) | agents/registry | S6 | 85 | gated_auto | open |
| M-P3-031 | shared/commands.ts overclaimed as command inventory | CLAUDE.md | S6 | 100 | safe_auto | fixed |
| M-P3-032 | Theme / working-set / activity chrome intentionally agent-out | — | S6 | — | advisory | open |

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

| Severity | Unique findings | ID range | Fixed (this branch) | Open |
|----------|-----------------|----------|---------------------|------|
| **P0** | **24** | M-P0-001 … M-P0-024 | **16** (009–024) | **8** (001–008) |
| **P1** | **111** | M-P1-001 … M-P1-111 | **12** fixed · **10** partial | **89** open |
| **P2** | **115** | M-P2-001 … M-P2-115 | **13** (safe_auto) | **102** |
| **P3** | **32** | M-P3-001 … M-P3-032 | **8** (safe_auto) | **24** |
| **Total** | **282** | | **49** fixed · **10** partial | **223** open |

All `safe_auto` findings are **fixed** on this branch. Remaining open items are `gated_auto` / `manual` / `advisory`.

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
**Remediation update:** 2026-07-16 · M-P0-009…024 fixed · all safe_auto fixed · all remaining open P1s verified with Why/Evidence/Suggested fix write-ups (89 open · 10 partial · 1 fixed-on-verify).
