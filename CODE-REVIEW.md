# Orchid — Full Application Code Review

| | |
|---|---|
| **Date** | 2026-08-03 |
| **Branch** | `review/full-app-code-review` (based on `feat/analytics-page` @ `ab69828`) |
| **Scope** | Entire application — ~93.7k LOC source under `electron/src/` + ~70.9k LOC tests under `electron/tests/` |
| **Method** | 9 parallel domain reviewers + 4 cross-cutting reviewers (Wave 2), each instructed to verify every claim against actual code; findings merged/deduped by orchestrator |

---

## 1. Baseline quality gates (measured, pre-review)

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run test` | ✅ **223 files / 3260 tests, all passing** (12.8s) |

The codebase compiles strict, lints clean, and has a genuinely large passing test suite. Findings below are behavioral/architectural, not hygiene failures.

---

## 2. Executive summary

**Overall health: good internals, weak trust boundary for untrusted projects.** The in-app security-critical subsystems (credential vault, signed catalog, permission gating, IPC validation) are unusually disciplined and repeatedly verified clean across reviewers. But the wave-2 cross-cutting security review found that **the project-config layer is fully attacker-controlled**: a cloned repository's `.orchid.json` can rewrite permission rules and auto-launch MCP servers with no consent surface, and the repo's `AGENTS.md` is auto-injected into the model — together a complete clone → code-execution chain (§4.1). All three top wave-1 findings were independently re-traced and **confirmed** (§4.4).

| # | Finding | Severity | Domain |
|---|---------|----------|--------|
| E1 | Project `.orchid.json` `permissions` are merged and honored verbatim — a cloned repo can auto-allow `execute_command` / out-of-workspace writes / MCP tools, defeating every approval mode | **CRITICAL** | Project trust |
| E2 | Project `.orchid.json` `mcp_servers` are spawned automatically on first use — no consent, no allowlist; clone-a-repo → arbitrary code execution | **CRITICAL** | Project trust |
| E3 | `session:set_workspace` lets renderer code rebind the workspace to any readable dir with no dialog, then renderer-allowlisted tools (`read`, `grep`, `glob`, `read_directory`) auto-allow reads "inside" it — a compromised renderer reads `~/.ssh/id_rsa` with zero user interaction | **high** | IPC/consent |
| E4 | Malformed model tool-input JSON persists a tool_call whose args can't re-parse; `toModelMessages` drops the call but keeps the tool result → orphan tool result → provider 400 on **every** subsequent turn of that session | **high** | LLM history |
| E5 | Renderer turn-affinity adoption race: sending a draft message while another session streams hijacks the new chat's projection (wrong text shown, composer locked for the whole turn) | **high** | Renderer |
| E6 | Strict config schema + documented legacy `providers` key: any existing config.json containing it throws from every `loadConfig()` — startup crash risk on upgrade | **high** | Config |

Recurring secondary themes:

- **Symlink semantics are inconsistent and sometimes unsafe across file mutators** (`edit`/`write` destroy the link; `apply_patch` writes through it; `glob` follows directory links without cycle detection or containment).
- **Self-limiting-tool exemptions from output offloading have byte-size holes** (one long line in `read` can dump megabytes inline).
- **Interrupted/recovery paths in indexing are fail-silent rather than fail-loud** (RAG/AST delete entries on transient I/O errors).
- **Cross-instance safety**: no `app.requestSingleInstanceLock()`; JSON stores serialize only within one process (lost updates possible with two instances).
- **Unbounded growth pockets**: session runtime caches never evicted, accounting ledger has no retention policy, renderer rAF batching unbounded while hidden.
- **Doc/config drift**: `background_command_idle_timeout` doesn't terminate anything; onboarding upgrade path documented but removed; dead `UPDATER_*` channels; zero-caller `flushStateCallbacks`.

The test suite is strong on the hardest paths (eager-execution exactly-once, offloading, AGENTS.md enforcement, vault/catalog trust, ledger, session DB recovery) but has real holes in the **chat cancel/stop IPC handlers**, the **`atomicWriteJson` primitive** (mocked everywhere), and the **RAG store SQL** (mock-emulated, never run against real SQLite).

---

## 3. Findings by domain

### 3.1 IPC / Preload boundary security

**Health:** unusually good — every `ipcMain.handle` Zod-validates before use, channel registry ↔ preload allowlists are in exact 1:1 parity both directions, renderer isolation flags are fully enforced, provider responses are redacted by construction. The gaps are about *what a valid, schema-conformant call may do*, not validation mechanics.

**F1.1 — high / high — `src/main/ipc/session.ts:460-470` (with `src/main/ipc/tool.ts:32-46`, `src/shared/types/permission.ts:66-72`)**
`session:set_workspace` binds *any* existing readable absolute directory as the window workspace with no dialog and no confirmation, and rewrites the sticky `default_project_dir`. Renderer-allowlisted `tool:execute` tools classify paths as `inside:'allow'` relative to the bound workspace. Attack chain for any code executing in the renderer: `session.setWorkspace({cwd:'/home/user/.ssh'})` → `tool.execute({name:'read', args:{file_path:'id_rsa'}})` → auto-allowed → key material returned, zero user interaction. This bypasses both consent mechanisms built for exactly this decision (native picker; `outside:'ask'` scope gate). The channel's own comment says "tests / programmatic" yet it ships in the production allowlist.
*Fix:* gate to non-packaged/test mode, restrict to already-known directories, or demote renderer-originated `tool:execute` to `ask` after rebind to a new directory.

**F1.2 — medium / high — `src/main/ipc/payload-schemas.ts:73-85` + `src/main/config/schema.ts:176-189`**
`config:save` accepts any config key with `z.unknown()` values, including `mcp_servers` (free-form command/args/env) and `permissions` (global tool rules). A compromised renderer can write `mcp_servers: {evil:{command:'/bin/sh',...}}` → arbitrary process execution on next `chat:send`, or `permissions: {execute_command:'allow'}` to globally silence the approval gate. Contradicts the stated threat model in `tool.ts` ("prevents a compromised renderer from ... executing arbitrary commands").
*Fix:* strict MCPServerConfig schema at the boundary for `mcp_servers`; OS-level confirmation for `mcp_servers`/`permissions` changes (mirror the `confirm:true` pattern used by `providers:disconnect/delete`).

**F1.3 — low / high — `payload-schemas.ts:14,142-145`; `ipc/definitions.ts:33-57`**
Missing upper bounds: session rename string, skill/agent/personality content, chat message length are unbounded → disk-fill and oversized-payload vectors. All other numeric fields are properly bounded; this is inconsistency, not pattern.
*Fix:* `.max()` caps consistent with UI limits.

**F1.4 — low / medium — `ipc/analytics.ts:44,57,68,80,92,104,117`; `ipc/permission.ts:150`; `ipc/chat/send.ts:457`**
Analytics handlers rethrow raw SQLite/query errors (DB paths, internals) to renderer; `readConfigLayer` and chat-send hydration also leak raw messages. No credential material involved — main-process internals disclosure only.
*Fix:* generic message to renderer, detail to file logger.

*Residual (verified, not findings):* renderer `tool:execute` with bound workspace but no active session creates an unanswerable approval entry that fails closed on timeout (safe, but dialog dead); preload invoke results rely on TS casts not parsing (main is trusted, no escalation); `UPDATER_*` channels declared but inert; symlink TOCTOU in scope classification requires local filesystem access (out of scope).

*Verified clean:* webPreferences isolation; channel↔allowlist parity; per-handler Zod validation; provider DTO redaction; definition save/delete realpath containment; prototype-pollution-hardened config merge; ask_question/permission ownership checks; bgcmd cross-session denial.

---

### 3.2 Agent orchestration (XState + Subagents)

**Health: solid.** No critical/high defects. Cancellation is single-threaded and flag-guarded against double-finalize; admission limits are atomic (fully synchronous check-then-act); persistence is transactional SQLite with exact-revision confirmations; delta batching never drops/reorders terminal events. Note: the machine documented as `idle→streaming→toolExecuting→idle` actually runs tools inside the `streaming` invoke (no `toolExecuting` state) — all audited races resolve cleanly under the real design.

**F2.1 — medium / medium — `src/main/agents/registry.ts:65`**
`loadAgentsFromDir` calls `fs.statSync(subDir)` per `readdirSync` entry without try/catch. A broken symlink or concurrently-deleted dir throws ENOENT and kills the **entire** agent registry load (including healthy home agents), surfacing as `runtime_hydration_failed` on every `chat:send`.
*Fix:* `statSync(..., {throwIfNoEntry:false})` or try/catch-and-continue, matching the existing readFileSync guard below it.

**F2.2 — low / high — `manager.ts:1062-1086`, `wire-subagents.ts:57-66`**
After `purgeSession`, a settling runner's `finally` emits a terminal delta → handler re-creates persistence-scheduler state for the deleted session (violating `scheduler.clear`'s contract). Resulting flush is a harmless no-op, but the session re-enters `dirty` until dispose.
*Fix:* skip `markDirty`/`scheduleTerminalWave` when the session no longer exists.

**F2.3 — low / medium — `subagent-lifecycle.ts:119`, `manager.ts:940-967`**
Lifecycle `transition()` only sets `clearQuestion` for follow-up/interrupt; `fail`/`complete` leave a pending question's promise and map entry behind. Currently latent (all terminating paths are interrupt-shaped), but a future `markFailed` mid-question would surface the question forever and let `answer_subagent` "succeed" against a dead subagent.
*Fix:* `clearQuestion:true` for all terminal transitions; filter non-RUNNING records from `getPendingQuestions`.

**F2.4 — low / high — `manager.ts:823-833`**
`flushStateCallbacks()` resolves *every* waiter across all sessions — directly contradicting the session-isolation invariant the interrupt tool documents (M-P0-013). Zero callers today, but a loaded gun.
*Fix:* delete, or scope to a sessionId with ownership enforcement.

**F2.5 — low / high — `tools/subagent/interrupt.ts:73-84`**
Per-id branch pushes to `cancelled` without checking `cancelOne`'s boolean return (currently can't misreport within the synchronous tick; cosmetic decoupling).

*Verified clean:* machine transition logic; Esc two-phase sequencing + 5s reset; cancel/stop finalization guards; admission queue math + cap re-checks; persistence scheduler retry/breaker/recovery; revision gating; SQLite upsert atomicity; delta merge/order/deferral; retention eviction; wait()/question settlement; session-delete and app-quit teardown ordering; restore migration.

---

### 3.3 LLM streaming & orchestration

**Health:** core machinery unusually well-built — eager exactly-once memoization, idle-watchdog pause/resume accounting, and tool-call/result pairing all hold up under line-by-line tracing; cancel/teardown ordering is correct. Two real defects at the edges.

**F3.1 — high / high — `src/main/llm/model-messages.ts:45-60` (with `stream/sdk-event-adapter.ts:187-199`, `ipc/chat/send.ts:383-417`)**
When a model emits unparseable tool-input JSON, the AI SDK sets `input` to the raw string; Orchid persists a `tool_call` with those args and a non-excluded `tool_result`. Next turn, `toModelMessages` silently drops tool calls whose arguments fail `JSON.parse` but keeps the matching `role:'tool'` message → **orphan tool result** → provider 400 on every later send in that session until hand-edited.
*Fix:* make `toModelMessages` symmetric (skip tool results whose call was dropped), or rewrite persisted args to valid JSON at the `sdkInputError` boundary, or persist such error results as `excludeFromModel`.

**F3.2 — medium / medium — `src/main/llm/tool-dispatch.ts:1124-1128`**
Offload cache slug keys on `toolCallId.slice(0,8)` — correct for UUIDs, but Anthropic IDs are `toolu_01…` (first 8 chars effectively constant), so every offloaded output of a given tool writes to the **same file**; an earlier pointer (persisted as the tool result and replayed later) then resolves to a *newer* call's content — silently wrong context for edits.
*Fix:* hash the full toolCallId (same pattern as `toProviderMcpToolName`) or append a per-session counter.

**F3.3 — medium / medium — `src/main/llm/stream/eager-tool-bridge.ts:225-262`, `orchestrator.ts:348-352`**
If the provider stream fails mid-step after a tool's input completed, the eagerly-launched mutation runs to completion even though the SDK would never have executed it; the turn shows an error and nothing is persisted, so the model never learns of the side effect.
*Fix:* document as accepted tradeoff, or persist a synthetic `cancelled` record for launched-but-undelivered tools.

**F3.4 — low / high — `middleware/error-classification.ts:40-55`**
`isTransientError` uses bare substrings `'500'`, `'429'`, `'timeout'` — context-overflow messages containing "128500 tokens" match `'500'` and get retried up to 3× (cost/quota waste on deterministic failures).
*Fix:* prefer structured statusCode; anchor message matching on word boundaries/known phrases.

**F3.5 — low / medium — `stream/normalized-stream.ts:135-156`, `tool-dispatch.ts:83-85`**
On the rarely-used textStream fallback path, `onStepFinish`-queued tool events never pause the idle watchdog, so a legitimate long tool (e.g. `wait_for_subagent` 305s budget) can be idle-aborted at the 300s default.
*Fix:* pause/resume around fallback tool execution.

*Verified clean:* generator teardown & timer/listener hygiene; exactly-once eager guarantee; no tool re-execution across retries; `toApiMessages` pairing/orphan filtering/coalescing incl. cancelled turns; renderer event ordering & dedup; offload threshold comparison & write-verify; user-cancel short-circuits eager launches before handlers run.

---

### 3.4 Tool system

**Health:** core is good — canonical result envelopes, symlink-aware permission gating, atomic writes, worker-pool timeout/cancel plumbing, bounded background output buffers. Defects cluster in dead/bypassable enforcement mechanisms, fact-reporting errors, and size-control holes in "self-limiting" tools.

**F4.1 — medium / high — `src/main/tools/search/grep.ts:253-263`**
`grep_per_file_timeout` **can never fire**: it races `Promise.resolve().then(() => searchFileSync(...))` against `setTimeout` — the sync search always completes before any timer callback runs. A catastrophic-backtracking pattern blocks the worker until the outer dispatch timeout hard-kills it (~30s pool degradation each hit).
*Fix:* enforce structurally (dedicated worker + terminate, or chunked scanning).

**F4.2 — medium / high — `src/main/tools/filesystem/glob.ts:99-119, 150-196`**
glob `**` follows symlinked directories (uses `statSync`, not `lstat`) with no cycle detection, no match cap, and no containment: (a) symlink cycle → stack overflow, every `**` glob in that repo fails; (b) symlinks escape the search root and escaped paths reach the LLM without a permission prompt (gate only checks the `directory_path` argument); (c) unbounded result size (`limitReached` hard-coded `false`).
*Fix:* `lstat`/Dirent + visited inode set; cap matches like grep; report symlink escapes.

**F4.3 — medium / high — `src/main/tools/process/execute-command.ts:332-341`**
Signal-killed children report **exit code 0 / complete**: `proc.exitCode ?? 0` — Node leaves `exitCode` null when a process dies via signal. Segfaults/OOM-kills read as success to the agent.
*Fix:* when `exitCode === null`, report `signalCode` and non-zero outcome (128+signum).

**F4.4 — medium / high — `src/main/tools/filesystem/read.ts:148-164` + `llm/middleware/provider-quirks.ts:30-38`**
`read` caps line count but not bytes, yet is exempt from output offloading — a minified 5MB single-line file is returned fully inline into the provider context.
*Fix:* per-line/result byte budget in the handler (with partial+retrieval), or drop the exemption when exceeded.

**F4.5 — medium / medium — `src/main/tools/web/fetch.ts:76-94, 266-274, 304-310`**
SSRF + OOM: scheme-only URL validation (no loopback/private/link-local/metadata blocking), redirects followed without re-validation, and the entire body is buffered before the size cap is checked.
*Fix:* resolve and reject internal ranges on initial URL and each redirect hop; stream body with byte-counter abort.

**F4.6 — medium / medium — `src/main/tools/filesystem/apply-patch.ts:260-264, 217-229, 365-371`**
Containment check is lexical, then `symlinkSafeWrite` deliberately writes through symlinks to targets anywhere (`Update File: repo-link` → `~/.ssh/authorized_keys`). Default permissions (`ask`) mitigate, but project config `permissions:{apply_patch:'allow'}` or allow-all session modes reopen the escape. Inconsistent with edit/write (which replace the link).
*Fix:* after realpath, verify target still contained, or refuse symlinked targets.

**F4.7 — low / high — `src/main/tools/result.ts:644-664, 697-721`**
Projector-synthesized `rerun` guidance for >100-entry complete results drops input parameters (`include_pattern`, `case_insensitive`, `max_results`, `max_depth`) — the advised rerun reproduces the identical capped view; entries beyond 100 are unreachable and the agent can loop.
*Fix:* carry full validated input into synthesized rerun + narrowing instruction.

**F4.8 — low / high — `src/main/index.ts:270-280` + `tools/process/background-store.ts:296-303`**
`background_command_idle_timeout` (900s) never terminates idle background commands — it only flips stdin ownership USER→AGENT. Up to 64 forgotten processes live until app exit, contrary to the documented "Background cmd timeout" semantics.
*Fix:* sweep+terminate AGENT-owned idle entries, or rename/re-document the setting.

**F4.9 — low / medium — `tools/process/background-store.ts:341-354`**
`terminate` on interactive (PTY) commands kills only the direct shell pid (`pty.kill`), leaking the process tree; non-interactive path correctly kills the process group.
*Fix:* kill PTY session/process group or track the tree.

**F4.10 — low / high — `tools/filesystem/edit.ts:75,135`, `write.ts:66-71`, `ast/utils.ts:48-89`**
`edit`/`write` on a symlink silently **destroy the link** (atomic rename replaces it) instead of writing the target; result reports success, agent believes the target changed. Mutator families disagree on symlink semantics (`apply_patch` writes through). Mitigated under default `ask`, silent under allow-all.
*Fix:* detect `lstat().isSymbolicLink()` and either write through the resolved target or fail explicitly — and make all mutators agree.

*Residual:* whole-file `readFileSync` with no size cap in read/edit/grep (worker OOM, pool recovers); gate→handler symlink TOCTOU; `atomicWrite` tmp-name collision for same-millisecond writes; `get_function` embeds unescaped error text; grep `include_pattern: []` throws generic `handler_exception`.

*Verified clean:* registry validate/filter/exactly-once; dispatch timeout/abort/worker-cancel plumbing & handler-exception containment; permission-gate scope resolution incl. renderer allowlist; read_directory lstat walk; edit/apply_patch match semantics; result-retrieval atomic writes; HeadTailBuffer caps & LRU; send_input/read_output guards; todo transitions; skill resource traversal guard; subagent wait ownership filtering.

---

### 3.5 Providers, credentials & accounting

**Health:** unusually disciplined. Secrets stay in a safeStorage-encrypted vault behind opaque handles (OS-keychain/DPAPI-bound, 0600 file/0700 dir); the catalog trust chain verifies exact signed bytes with no unsigned fallback; the ledger is append-only with idempotent finalization and fail-closed corruption handling. No path logs/persists/IPC-returns an API key in cleartext. Weaknesses are operational.

**F5.1 — medium / high — `src/main/utils/write-lock.ts:7-35`, `providers/credentials/vault.ts:263-286`, `providers/connection-store.ts:117-136`**
`withSerializedWrite` serializes read-modify-write **within one process only**, and nothing calls `app.requestSingleInstanceLock()`. Two concurrent Orchid instances against the same `~/.orchid/` can lose updates silently (connection or vault entry vanishes); catalog version monotonicity can regress cross-instance. SQLite ledger unaffected (WAL + busy_timeout).
*Fix:* `requestSingleInstanceLock()` at startup, or cross-process file lock around RMW cycles.

**F5.2 — medium / high — `providers/index.ts:195-197`, `drivers/compatible.ts:64` vs `drivers/registry.ts:77-79`, `ipc/providers.ts:492-495`**
Generic-endpoint validation duplicated at four sites with **divergent options**: `resolveCredential`/model construction ignore `allowInsecureHttp` while registry/IPC binding honor it. A confirmed insecure-HTTP generic connection reports `health:'ready'` but every chat send fails. Fail-closed, but a live inconsistency bug and a standing hazard (four-site duplication).
*Fix:* one shared `validateConnectionEndpoint(connection)` used everywhere.

**F5.3 — low / high — `providers/accounting/schema.ts:12-45`, `store.ts:19`, `middleware.ts:195,236`**
Ledger has no retention/rotation/compaction; every attempt (incl. retries and up to 100 tool-loop steps/turn) inserts a row with full snapshot JSON. Query time grows linearly forever.
*Fix:* time-based archival/rollup; append-only invariant only requires finalized rows never mutated, not never archived.

**F5.4 — low / high — `providers/credentials/vault.ts:189-196, 288-306`**
One corrupted/schema-drifted vault entry makes **every** credential unreadable (whole-document strict parse, no quarantine). Fail-closed and leak-safe, but recovery = delete the whole vault.
*Fix:* move corrupt file aside and start empty, or parse/quarantine per-entry.

**F5.5 — low / medium — `providers/catalog/store.ts:116-147`**
Catalog version monotonicity is enforced only against local state; if `provider-catalog.json` is deleted, an on-origin attacker could replay an older signed catalog within its validity window. Currently dormant (release keyring empty → updater never runs; bundled catalog only).
*Fix:* when release keys land, add a minimum-accepted-version floor.

**F5.6 — low / high — `ipc/providers.ts:834-841`, `credentials/vault.ts:254-286`**
Crash between vault write and connection-store update leaves an orphaned encrypted vault entry; nothing ever GCs vault entries for deleted connections. Not exploitable (random UUID handles + full binding checks), but dead blobs accumulate.
*Fix:* startup GC of vault entries whose connectionId no longer exists.

*Verified clean:* secrets-in-logs/IPC/ledger redaction; vault key handling & file hardening; atomic JSON writes; credential binding enforcement; catalog signature path & no-unsigned-fallback; ledger idempotent finalize + crash recovery; code-owned driver origins; status redaction; connection-deletion credential cleanup.

---

### 3.6 Config, session, workspace & AGENTS.md

**Health:** good — config writes atomic (tmp+fsync+rename) and serialized; sessions on SQLite with transactions and corruption recovery; resolver symlink containment sound. Notable defects below.

**F6.1 — medium / high — `src/main/ipc/config.ts:135-148` (+ `config/loader.ts:162,387-397`)**
`config:save` persists the **merged + env-overridden** config snapshot into `~/.orchid/config.json` (takes `getConfig()` cache, which already applied `applyEnvOverrides()`). Launching with `ORCHID_MAX_TOOL_STEPS=5` once, then toggling any preference, bakes `max_tool_steps:5` permanently into the home config. Every other home-config writer correctly patches only its layer.
*Fix:* read-modify-write the raw home file, or strip env/project-sourced values before persisting.

**F6.2 — medium / high — `src/main/tools/ast/rename-symbol.ts:60-73` vs `agents-md/enforce.ts:92` + `permissions/resolver.ts:49-54`**
`rename_symbol` renames across **every** indexed project file but ignores its `file_path` argument; AGENTS.md enforcement and permission gating evaluate only `args.file_path`. Under `enforce_on_write:'block'`, a rename gated by one read AGENTS.md silently mutates files governed by unread nested instruction files; under `warn`/`inject` the warning names the wrong file.
*Fix:* enforce on the union of actual target files, or make the tool honor `file_path`.

**F6.3 — medium / high — `src/main/ipc/chat/session.ts:62-80`**
When the bound workspace directory no longer exists (moved/unmounted), `chat:send` rejects with a raw error instead of the structured `unbound_workspace` result — `resolveWindowWorkspace` returns non-null cwd with `status:'missing'`, only null/empty is checked, then `requireCanonicalProjectDirectory` throws with no catch upstream.
*Fix:* check `workspace.status === 'valid'` and return the structured unbound error.

**F6.4 — low / high — `config/loader.ts:44-52, 144-165`**
Asymmetric broken-config handling: malformed JSON silently resets to defaults (and the next save overwrites the possibly-recoverable file); valid JSON with one bad value hard-fails startup with no quarantine.
*Fix:* back up + log on corrupt load; consider per-field salvage.

**F6.5 — low / high — `config/merge.ts:118-122, 178-186`**
Null-tombstone protection is inconsistent: `rag`/`mcp_servers`/`tier_models` are protected from `{key: null}` deletion; `agents_md`/`subagents`/`permissions`/`tier_reasoning_effort` are not — saving null silently resets whole preference blocks to schema defaults.
*Fix:* protect all nested objects uniformly or validate tombstones against field nullability.

**F6.6 — low / high — `config/schema.ts:210-215` vs commit `b197ffa`**
Documented onboarding upgrade ("existing installs missing the key load as true") was deleted by the legacy-code removal commit and nothing replaces it — pre-feature installs re-trigger first-run onboarding. Doc/behavior drift.
*Fix:* restore minimal upgrade pass or fix schema comment + AGENTS.md.

**F6.7 — low / high — `session/manager.ts:119-126, 152-163, 393-397`**
Session runtime caches (`_sessions` full histories, `_todoStores`, `_agentsMdStores`) grow for every session ever touched and are only pruned on explicit delete — monotonic memory growth in long-running processes.
*Fix:* LRU-evict non-selected session snapshots (SQLite reload on demand already supported).

**F6.8 — low / high — `project/workspace.ts:85-116`**
`updateStickyDefaultProjectDir` mutates the in-memory config **before** validating/reading the home file and skips cache invalidation on failure — workspace views show a sticky default that was never persisted until restart.
*Fix:* read/validate first, mutate cache after successful write (or roll back).

*Residual:* defs `atomicWriteText` lacks O_EXCL/O_NOFOLLOW (same-user TOCTOU only); enforcement Phase-A→handler TOCTOU inherent to advisory design; per-window maps leak one small entry per reopen cycle; case-insensitive alias tie-breaks on readdir order.

*Verified clean:* resolver walk bounds + symlink containment + alias precedence; atomic config writes + write-lock serialization; SQLite session transactions + chain recovery + corruption move-aside; workspace resolution with no `process.cwd()` default; root seeding idempotency; auto-naming rename race guard; defs name validation + containment; apply_patch multi-file path extraction; delete-vs-finalize ordering.

---

### 3.7 RAG, AST & MCP reliability

**Health:** fair-to-good. Worker-thread isolation, bounded retries, download timeouts, WAL+busy_timeout, MCP per-call timeouts and lease lifecycle are solid; no confirmed unhandled-rejection paths. Remaining findings are watchdog/cancel gaps, fail-silent recovery modes, and teardown races.

**F7.2 — medium / high — `ast/indexer.ts:413-457` vs `rag/indexer.ts:526-538`**
AST index worker has **no idle watchdog and no cancel** (its RAG twin has both). A hung worker wedges the AST subsystem until app restart: `isIndexing` true forever, all later `ast:index` shares the hung promise, symbol tools hang until tool timeout.
*Fix:* port the RAG watchdog + add `cancelIndex` for AST.

**F7.3 — medium / high — `rag/indexer.ts:666-683, 326-331`; `ast/indexer.ts:509-524, 297-300, 315-319, 346-352`**
Transient file errors silently delete files from indexes: any read error (EMFILE, transient I/O) → null → treated as "file gone" → `deleteByFile(Batch)`. AST additionally deletes symbols of files whose extraction threw. fd-exhaustion bursts quietly strip entries with no visible signal.
*Fix:* distinguish "unreadable" from "deleted" (stat separately); keep stale entries + record errors.

**F7.4 — medium / medium — `mcp/manager.ts:205-211, 465-474, 610-628` + `index.ts:418`**
MCP teardown race: `_awaitRunner()` gives up after 3s then `_clients.clear()`; if the runner's finally-close-loop hasn't run, it later snapshots an empty map and connected clients are never closed — stdio child processes survive app exit.
*Fix:* `_awaitRunner` snapshots+closes remaining clients itself after timeout.

**F7.5 — low / high — `mcp/manager.ts`**
Server death never detected: no `client.onclose` handler; a crashed MCP server stays `connected` in status, every tool call fails individually until restart/config change.
*Fix:* onclose → mark failed/disconnected, drop tools, optional bounded reconnect.

**F7.6 — low / medium — `rag/store.ts:303-311, 313-333` vs `utils/sqlite.ts:63-77`**
RAG corruption recovery permanently deletes the DB where the shared util moves it aside for salvage; `no such table` (e.g. partial schema from disk-full) triggers unrecoverable deletion of a salvageable index.
*Fix:* `moveCorruptDbAside`; rebuild only on true corruption-class errors.

**F7.7 — low / medium — `ast/parser.ts:21-25` + `ipc/index.ts:38-54`**
`require('web-tree-sitter')` at module load in the startup chain with no try/catch — broken install crashes main at boot instead of degrading (unlike better-sqlite3/onnxruntime which produce actionable errors).
*Fix:* lazy-load inside `ensureInitialized()`.

**F7.8 — low / high — `rag/store.ts:121-166, 785-790`**
Switching `rag.embedding_model` produces a mixed-dimension `vectors.npy` (rows truncated/NaN-padded silently); surfaces only at query time.
*Fix:* store/compare embedding dimension at index time; auto-force full reindex on change.

**F7.9 — low / high — `ast/store.ts:144, 175`**
`pragma foreign_keys` toggled OFF→ON without try/finally — a thrown transaction leaves FK enforcement off for the store instance's lifetime.
*Fix:* try/finally.

*Verified clean:* RAG cancel semantics; per-project single-flight; SQLite WAL + busy_timeout + handle disposal; ABI-failure messages; model download atomicity/timeouts/abort; embedder retry; MCP per-call timeout + abort propagation; lease lifecycle; binary/empty/huge-file handling; search-cache OOM caps; worker error/unhandled-rejection handling; esm-import.

---

### 3.8 Renderer (React UI)

**Health:** good — **no XSS surface** (react-markdown without raw HTML, zero `dangerouslySetInnerHTML`, tool output inert text/JSON); listener/interval hygiene consistently correct; session switching defended by generation/affinity gates; subagent delta handling robust. Problems cluster around the turn-affinity model trusting *when* events arrive.

**F8.1 — high / high — `src/renderer/hooks/useChat.ts:191-194, 506-509, 572-584` + `src/shared/chat/turn-projection.ts:234-247`**
Draft-send adoption hijack: `send()` resets affinity before awaiting `chat.send`; with `selectedSessionId` null (draft), the adoption branch adopts the *first event of any session* arriving during the await. If session B is streaming in the background, B's chunks land in the draft's fresh projection and pin its turnId; the send resolution then fixes affinity to new session C but never re-seeds the projection → all of C's events rejected by turnId/sequence checks. New chat pane shows B's text, composer locked for the whole turn, snapping to C only at `done`.
*Fix:* don't adopt unknown-session events while a send is in flight (require explicit binding), or re-`begin` when the resolved turnId differs from the projection's.

**F8.3 — medium / high — `src/renderer/AppReady.tsx:150-166`, `ChatView.tsx:1001-1021, 1173-1191`, `App.tsx:15-26`**
No error boundary around the chat surface: Config/Analytics/Onboarding have their own boundaries, but ChatView (always mounted) and lazy ProjectConfigView/SubagentView (Suspense doesn't catch errors) don't. A transcript render error replaces the entire UI with the fatal fallback, losing in-memory state.
*Fix:* wrap ChatView in an ErrorBoundary that remounts just the chat subtree.

**F8.4 — low / high — `src/renderer/hooks/useChat.ts:405-413, 424-429, 458-463`**
`pendingFrameActionsRef` accumulates deltas without bound while the window is hidden (rAF throttled); flushes only on lifecycle events. Long backgrounded responses queue every delta, then replay in one giant dispatch on refocus.
*Fix:* fallback timer coalescer or cap-and-flush.

**F8.5 — medium / medium — `useChat.ts:191-199, 424-444`, `main/ipc/chat.ts:108-149`, `main/ipc/chat/abort.ts:146-173, 229-241`**
Late terminal event for a previous turn could steal turn affinity mid-send (same root cause as F8.1). Currently unreachable because main emits terminal events synchronously before the invoke reply — but nothing in the renderer enforces this; future async finalization reopens it.
*Fix:* same re-`begin` fix as F8.1 closes both.

*Residual:* deleting a streaming session from the Analytics/LeftSidebar path bypasses ChatView teardown (transcript stays painted); hydration buffers bounded by in-flight IPC duration; composer send-lock sticks if main never emits a terminal event.

*Verified clean:* XSS posture (react-markdown v10, no rehype-raw, default urlTransform, rel=noopener links); every subscription/interval has cleanup; stale-response guards everywhere; subagent hydration byte cap + reseed floor; auto-scroll suspend/resume; analytics pagination clamps; divide-by-zero guards; queue FIFO logic.

---

### 3.9 Test suite quality & coverage

**Health:** genuinely strong where it counts most — eager exactly-once, offloading, AGENTS.md enforcement/injection, provider trust, ledger, session DB recovery all have deep behavior-level tests with real files/SQLite/keypairs. Zero snapshots, zero skips, FS confined to mkdtemp, no wall-clock flakiness.

**Coverage gaps (ranked by risk):**

| # | Risk | Untested path | Why it matters |
|---|------|---------------|----------------|
| T1 | high | `ipc/chat.ts:90-151` (`chat:cancel` handler) | Entire two-phase Esc flow — phase branching, partial-history persistence, bg-command termination, subagent cancellation — never executed; only the channel name appears in an allowlist test |
| T2 | high | `ipc/chat/abort.ts:185-249` (`forceStopSession`) + `chat:stop` | Three branches (no agent / finalized / active-with-partial) called from stop, session delete, and workspace rebind — zero test references |
| T3 | high | `config/loader.ts:57-140` (`atomicWriteJson`) | The single write primitive for config.json/providers.json/permission layers; every consumer test mocks it — crash-safety and 0600 permissions have zero direct coverage |
| T4 | medium | `rag/store.ts` SQL | Never runs against real SQLite — a hand-rolled shim pattern-matches SQL strings and re-implements store semantics; schema drift passes silently (AST store, by contrast, uses real SQLite) |
| T5 | medium | `MarkdownContent.tsx` XSS behavior | No test asserts raw-HTML suppression or `javascript:` href filtering; enabling rehype-raw would pass the whole suite |
| T6 | medium | `useChat.ts` send-failure path | "Covered" only by regex-counting source text; no behavioral test ever makes `chat.send` reject |
| T7 | medium | `useSessionTabs`, `useAnalytics`, `useTodos`, `useTimeRange` | No behavioral tests |
| T8 | medium-low | `ipc/definitions.ts` (196 lines) | Listing handlers unverified at the IPC boundary |
| T9 | low | `rag/index-worker.ts`, `ast/index-worker.ts` packaging | Worker entry glue has no packaging test (tool-worker's does) |

**Quality findings:**
- ~12 tests of the form `expect(fs.existsSync('ChatStream.tsx')).toBe(true)` cannot fail short of file deletion (chat-sidebar, command-palette, app-shell) — false confidence.
- `chat-rendering-contract.test.ts:261-282` asserts behavior by counting string occurrences in `useChat.ts` source — brittle and unable to detect logic regressions.
- RAG better-sqlite3 mock hard-codes current SQL substrings (mock-coupled both directions).
- `llm-orchestrator.test.ts:1006-1014` hand-duplicates `TOOLS_WITHOUT_OUTPUT_OFFLOAD` instead of importing it.

---

## 4. Cross-cutting review (Wave 2)

### 4.1 Security (permissions subsystem, logging, updater, skills)

**Health:** the permission evaluator/approval machinery is fail-closed (denials on timeout/abort/parse failure, unclassified tools denied), but the *inputs* to the gate are not trustworthy: a project's `.orchid.json` can rewrite permission rules and auto-start MCP servers with no consent model, turning any cloned repo into a zero-click/one-click RCE vector.

**F9.1 — CRITICAL / high — `src/main/config/merge.ts:257-283` + `src/main/llm/tool-dispatch.ts:250` + `src/main/permissions/resolver.ts:187-191`**
Project `.orchid.json` can escalate permissions. The merge applies any schema key from the project layer — including `permissions` — and the gate uses that merged config verbatim. Attack: victim clones a repo containing `.orchid.json` with `"permissions": {"execute_command": "allow"}` (or write outside-scope allow, or `mcp::evil::*: allow`); any chat turn — steered by the repo's own auto-injected AGENTS.md — runs shell commands with **no approval prompt**. Project `allow` rules also defeat `decide-for-me`/`ask-when-flagged` session modes via `passesRiskClassFloor`. No workspace-trust/consent surface exists anywhere. Distinct from F1.2 (renderer config:save): this is the *load* path honoring an attacker-supplied file.
*Fix:* project layer may only *tighten* home defaults — strip/cap `permissions` from project config (never loosen execution/mutation/mcp/outside rules), or gate first use of a project config behind an explicit trust prompt.

**F9.2 — CRITICAL / high — `src/main/mcp/project-registry.ts:13-24, 61-71` (+ `src/main/project/runtime.ts:82-85`, `src/main/ipc/chat/send.ts:168`)**
Project `.orchid.json` may declare `mcp_servers`, which are spawned as stdio subprocesses automatically on first project-runtime touch (first chat turn, subagent run, or sidebar status poll) — no consent, no allowlist. A malicious repo ships `{"mcp_servers":{"x":{"command":"/bin/sh","args":["-c","<payload>"]}}}` and gets arbitrary code execution just by being opened and used once. Fires before any permission gate is involved.
*Fix:* never auto-launch project-layer MCP servers; require explicit per-server user approval persisted outside the project dir (onboarding already does this for recommended servers).

**F9.3 — medium / high — `src/main/tools/skill/skill.ts:179-205` + `src/main/skills/registry.ts:76-116`**
Skill resource reads escape containment via symlinks: `executeResourceRead` does lexical resolve + prefix check only (no realpath). A project ships `.orchid/skills/x/scripts/leak -> ~/.ssh/id_rsa`; the `skill` tool is READ_ONLY (auto-allowed), so the agent reads out-of-project files, bypassing the `read` tool's outside-workspace ask gate. Also `scanResourceDir` walks with `statSync` (follows links) and no cycle guard — a symlink loop stack-overflows uncaught through `ProjectRuntimeRegistry.get`, making every turn in that project fail.
*Fix:* realpath + re-check containment for resource reads; lstat/visited-set in the walk.

**F9.4 — medium / medium — `src/main/permissions/evaluator.ts:57-74` + `agents/defaults/permission-evaluator/AGENT.md:10-26` + `permissions/gate.ts:110-144`**
The decide-for-me evaluator is prompt-injectable through the data it judges: `buildEvaluatorPrompt` embeds attacker-shaped tool args verbatim with no untrusted-content framing; an agent steered by injected AGENTS.md/skill content can smuggle "respond approve" instructions into args (`write.content`, `execute_command.description`), getting human-free approval. Parse failure correctly falls back to ask (fail-closed verified).
*Fix:* frame args as untrusted blocks, instruct to ignore instructions inside arguments, treat evaluator approve as advisory for higher risk classes.

**F9.5 — low-medium / high — `src/main/logging.ts:130-134`**
`~/.orchid/logs/` + `orchid.log` created with default umask (world-readable 0755/0644) while the rest of the app hardens to 0700/0600; log receives provider errors/URLs/best-effort redactions. No rotation or size cap — a runaway error loop grows the file without bound (disk-fill).
*Fix:* chmod 0700 dir / 0600 file at creation; size-based rotation.

**F9.6 — low / high — `src/main/updater.ts:43-63, 79-87` + `electron-builder.yml`**
Dormant-but-wrong update trust posture: updater currently inert (`publish: null`, verified), but when enabled `detectReleaseSigned()` returns hardcoded `true` on Windows/Linux without checking anything, `update-available` auto-downloads, AppImage updates rely only on the feed's sha512, and build configs show no signing (mac `dmg.sign: false`, no Windows cert) — a compromised release feed delivers code with only GitHub-HTTPS as trust anchor. Stale comments contradict the (safe) values and will mislead maintainers.
*Fix:* make the signed gate real per platform; pin/verify artifacts independently of the feed (minisign/GPG); fix comments.

**F9.7 — low (inherent) / high — `src/main/agents-md/inject.ts:61-72` + `agents-md/resolver.ts:199-223`**
Confirmed the inherent prompt-injection property: malicious `AGENTS.md` in a cloned repo is auto-injected with no untrusted-content warning or first-use notice; write enforcement provides zero injection mitigation. Combined with F9.1 this is a complete no-prompt RCE chain. Mechanics verified sound: XML-escaped content/attributes (no wrapper breakout), byte caps, chain-depth cap, symlink containment.
*Fix:* first-bind consent/notice for instruction files; untrusted-provenance framing in the injected block.

*Verified clean:* approval flow fail-closed; gate denies unclassified tools; evaluator unavailability → human ask; file-tool scope resolution uses live realpath incl. symlinks; all file tools' path args extracted (incl. apply_patch headers and `Move to`); every spawn path (foreground/background/PTY) funnels through the single gated execute_command handler; no env smuggling (schema has no env arg); renderer tool:execute allowlist exactly six read-only tools; eager execution routes through the same single checkPermission site; no secrets logged at call sites; skill/agents-md XML escaped; frontmatter parsed by minimal custom parser (no YAML gadgets); project agents cannot shadow home INTERNAL agents (protects built-in evaluator); no file watchers (reloads IPC-driven, names pattern-validated, all def paths realpath-contained).

---

### 4.2 Performance & scalability

**Health:** streaming hot path largely well-engineered (RAF batching, delta coalescing, history/live-tail memo split, chain-collapse), but undermined by whole-session fan-out; main-process analytics run ~10 synchronous full-ledger scans; session hydration is eager and full.

**F10.1 — high / high — `main/ipc/chat/persist.ts:106-140`, `send.ts:343-347`, `events.ts:112-121`, `session/storage.ts:243-245, 770-784`, `renderer/hooks/useSession.ts:249-262`**
Whole-session `SESSION_UPDATED` broadcast on every checkpoint: each usage change (debounced 300ms) JSON-stringifies the *entire active chain* for SQLite, then structured-clones the *entire session* (all chains, messages, subagent records) to every window. Renderer adopts `event.session` wholesale → every object identity changes → `MessageWidget` memo fails, `ToolCallBlock`/`ToolActivityGroup` aren't memoized, history rebuild re-runs. O(all messages), 1-3×/sec during busy agent loops; visible jank at ~1-2k messages with active tool steps.
*Fix:* chain-scoped diffs (chain id + messages + status) merged by id to preserve identity; consider checkpoint-on-turn-end only.

**F10.2 — medium / high — `renderer/utils/stream-building.ts:73-106`, `ChatStream.tsx:213-226, 280-285`**
Per-streaming-frame dedupe builds `` `${type}\0${content}` `` string keys over **all** visible history items and copies the entire history array each frame — allocates the combined size of all visible assistant text per frame (hundreds of KB/frame in tool-heavy turns → dropped frames, GC churn).
*Fix:* dedupe by existing segment/message ids, or only against the trailing history slice; render history and live tail as separate sibling containers.

**F10.3 — medium / high — `main/providers/accounting/analytics-queries.ts:172-337, 371-378, 662-676, 724-747`, `ipc/analytics.ts:36-46`**
Opening Usage/Analytics runs ~10 synchronous full-table passes over the unbounded ledger (json_extract token sums + JS Decimal aggregation) inside `ipcMain.handle` — at ~100k+ attempts this stalls the entire main process for seconds. Default queries are unbounded by date so the start-time index isn't used.
*Fix:* default date range, SQL GROUP BY aggregation, daily rollup tables, or move to worker/readonly connection.

**F10.4 — medium / high — `main/rag/store.ts:1019-1083`, `main/tools/rag/search.ts:79-100`, `rag/embedder.ts:440-447`**
Each `rag_search` recomputes vector norms for **every stored row** (double FLOPs) in pure JS on the main event loop (~19M multiply-adds/query at 50k×384 → tens-to-100ms+ stall mid-agent-loop), constructs a `new Embedder()` per call, and runs a throwaway warmup inference per instance.
*Fix:* precompute row norms at matrix load; shared query embedder; optionally worker scoring.

**F10.5 — medium / high — `main/session/storage.ts:627-708, 271-295`**
Opening a session deserializes **every** chain's messages_json + subagent records in one pass, though the UI collapses all but the last 20 chains to stubs. Several MB of parse + normalization per tab switch for large sessions.
*Fix:* lazy per-chain hydration (metadata first, messages on expand), or store a preview column.

**F10.6 — low / high — `main/ast/indexer.ts:283-292, 321-330`, `rag/indexer.ts:313-322, 366-375`, `Sidebar.tsx:624-644`**
Indexing progress amplification: two all-window broadcasts per file, unthrottled; a 15k-file project ≈ 30k broadcasts + 60k sidebar state updates per run. AST indexing also auto-triggers mid-session via `ensureIndexed`, competing with live chat.
*Fix:* coalesce/throttle (≥100ms or 1% increments) before broadcasting.

**F10.7 — low / medium — `main/rag/store.ts:616-682, 687-710`**
Incremental indexing rebuilds the entire vector state per changed file (splice shifts + full idToIndex rebuild) — O(files × total chunks); delays re-index completion on large repos with frequent partial re-indexes.
*Fix:* mark-and-compact once at end of run.

**F10.8 — low / high — `main/tools/process/head-tail-buffer.ts:93-99, 156-176`**
Every live-output snapshot concats+decodes+splits the entire ≤512KiB tail just to keep the last N lines — at 5 polls/sec per widget this is O(tail bytes) main-thread work per poll for high-output commands.
*Fix:* scan backward for N newlines before decoding; memoize on (tailLength, lastN).

**F10.9 — low / medium — `renderer/components/ChatStream.tsx:186-208`, `utils/stream-building.ts:180-198`**
History memo invalidated by inputs it doesn't use: `messages` prop is a dependency but never read; `subagentUsage` changes identity on every ~1s usage tick per active subagent, re-running build→fold→reconciliation during multi-subagent runs (compounds F10.1).
*Fix:* drop `messages` from deps; keep usage out of the history memo.

**F10.10 — low / medium — `main/index.ts:99-119, 339-342`**
macOS packaged builds run synchronous `spawnSync('codesign', ...)` (5s timeout) inline right when the renderer starts issuing IPC — stalls all IPC during that window.
*Fix:* async execFile, earlier startup stage, or cached verdict.

*Verified clean:* turn-projection reducer (RAF batching, coalescing, watermarks); subagent event fan-out budgeting; session SQLite indexes + targeted writes; AST store indexes + transactional bulk inserts; RAG search cache LRU (entries + bytes); per-turn history conversion runs once per streamChat (not per step); staged startup; background store LRU + 1MiB caps; prompt-context directory-tree TTL cache.

---

### 4.3 Architecture & design integrity

**Health:** process layering is genuinely clean (no renderer↔main bypass, no preload leaks) and there is no dead-file problem. The risks: tools layer re-couples to live singletons and Electron windows (violating the codebase's own frozen-context invariant), cross-cutting primitives duplicated 3-8×, and AGENTS.md drift well beyond the known items.

**F11.1 — high / high — `src/main/tools/index.ts:126-148`**
`notifyTodosChanged()` calls `BrowserWindow.getAllWindows()` + `webContents.send` directly from the tools layer via dynamic `require('electron')` with eslint-disable — tools are supposed to operate under a frozen context and emit results, not drive UI fan-out. Makes todo tools untestable without Electron.
*Fix:* injected `onTodosChanged` callback in `registerBuiltinTools`; wire broadcast in ipc/.

**F11.2 — high / high — `src/main/tools/index.ts:108, 128, 129`; `src/main/tools/subagent/delegate.ts:117-126`**
Frozen `ToolExecutionContext` invariant broken: `createSessionTodoStoreResolver` calls `getSessionManager()` per todo call with live *active-session* fallback; `notifyTodosChanged` falls back to `manager.getActive()?.id`; delegate reads live session chain state. Session switch mid-turn can persist todos to the wrong session.
*Fix:* resolve TodoStore + parent-chain metadata once at turn start and carry in context.

**F11.3 — medium / high — `permissions/resolver.ts:69-112`; `agents-md/resolver.ts:37, 54-95`**
Path canonicalization + containment duplicated across permissions/ and agents-md/ (mirrored code, acknowledged in comments) — a symlink-handling fix in one won't propagate to the other, though both guard the same filesystem.
*Fix:* single `utils/path-canonical.ts` used by both (+ `defs/paths.ts` isUnderRoot as third variant).

**F11.4 — medium / high — `config/loader.ts:57-109`, `defs/paths.ts:184-193`, `rag/embedder.ts:601-717`, `rag/store.ts:163-165`, `tools/ast/utils.ts:58-69`, `tools/result-retrieval.ts:69-83`, `tools/web/fetch.ts:174-183`**
Atomic write (tmp+rename) reimplemented ~8× with divergent guarantees (tmp naming, cleanup, permission bits); only config/loader's has fsync + chmod 600 + parent-dir fsync. `rag/store.ts`'s non-unique `.tmp` is crash-unsafe under concurrent writers.
*Fix:* promote the config/loader pattern to `utils/atomic-write.ts` and migrate.

**F11.5 — medium / high — `ipc/chat/stream.ts:14-36`, `llm/middleware/error-classification.ts:32-45`, `providers/status/service.ts:83`**
Three parallel error-classification taxonomies with overlapping-but-different string heuristics; retry decisions can disagree with user-facing error kinds; new provider phrasings need up to three edits.
*Fix:* one classifier producing a typed ErrorClass; chat/status layers map from it.

**F11.6 — medium / high — `tools/result.ts:644-666, 696-710`; `search/grep.ts:192-194`; `config/schema.ts:156`**
Projectors hard-cap at magic 100 entries while `grep_max_results` has no schema maximum and the tool accepts uncapped `max_results` — setting 500 yields a canonical 500-match result the agent only ever sees 100 of (and offloading can't rescue exempt tools). Contradicts the "projectors must not truncate" contract.
*Fix:* drive projection bound from resolved max_results, or cap the schema; fix the doc invariant.

**F11.7 — high / high — AGENTS.md vs code**
Drift beyond known items: (a) `shared/types/index.ts` documented but doesn't exist; (b) styling section documents `chat.css` as growth-guarded dead file — it's gone, and the split (`components-chat.css` 732, `components-config.css` 431, `components-session.css` 127) is undocumented; `components.css` is 968 lines not "~1,963"; `motion.css` missing; (c) the entire `permissions/` subsystem, `ipc/chat/` (9 files), `llm/stream/`, `session/{db,schema,singleton}.ts`, `shared/{chat,serialization}` absent from the documented tree; (d) ~20 config keys missing from the config table (`permissions`, `approval_timeout`, `subagent_wait_timeout`, `web_fetch_*`, `bg_prompt_*`, `max_background_processes`, `llm_retry_backoff_*`, ...).
*Fix:* regenerate tree/table from code.

**F11.8 — high / high — AGENTS.md:396 vs `src/main/config/schema.ts:235` (`.strict()`); `config/loader.ts:164`**
Documented legacy `providers` config field is incompatible with the strict schema: the key no longer exists, the schema is `.strict()`, and nothing strips/migrates it — any pre-existing `~/.orchid/config.json` containing `"providers"` throws a ZodError from **every** `loadConfig()` call, including first config read at startup, with no try/catch or fallback. Startup crash risk for upgrading users.
*Fix:* load-time migration dropping `providers`, or `.passthrough()`/`.catch()` with warning; then update docs.

**F11.9 — medium-high / high — `permissions/gate.ts:18-20, 98-105`; `rag/chunker.ts:12, 129`; `rag/embedder.ts:324, 414, 736`; `rag/indexer.ts:213`**
Subsystem boundary erosion: `permissions/gate.ts` runs its LLM evaluator through `getProviderRuntime()` + `createMiddlewareStack()` while being consumed by llm/tool-dispatch and agents-md (near-circular llm↔permissions); RAG depends on the global config singleton via hidden dynamic `require('../config/loader')` in three places (import-cycle dodge). ast/ and mcp/ are comparatively clean.
*Fix:* inject Config and an Evaluator/model-invocation port; move permission LLM evaluator behind an interface supplied by the llm layer.

**F11.10 — medium / high — `agents/manager.ts` (1,626 LOC), `rag/embedder.ts` (1,135), `shared/types/ipc.ts` (1,408), `ChatView.tsx` (1,240), `llm/tool-dispatch.ts` (1,128), `ipc/providers.ts` (1,047)**
God-modules: embedder mixes download + ONNX sessions + API fallback + file caching; ChatView mixes layout + keyboard map + sidebar orchestration + view switching; ipc.ts concentrates every channel constant, payload type, API interface, and both allowlists — any IPC change touches it.
*Fix:* split embedder; extract ChatView concerns into hooks; split ipc.ts into channels/api/allowlists.

*Verified clean:* renderer never bypasses preload (zero ipcRenderer/require('electron'); all via window.orchid with allowlist enforcement); no main→renderer/preload import edges; no dead files at scale (only 3 runtime workers loaded by path); no dead config keys (13 newest all have live consumers); `process.cwd()` never a product workspace default; middleware stack matches docs; Sidebar + LeftSidebar dual-rail is intentional.

---

### 4.4 Adversarial scenario verification

Independent re-tracing of the three highest-impact wave-1 findings against the actual code — **all three CONFIRMED**:

| Finding | Verdict | Key evidence |
|---|---|---|
| A. F1.1 `session:set_workspace` consent bypass | **CONFIRMED** | `ipc/session.ts:460-470` binds with no dialog (validation is only absolute/exists/R_OK|X_OK — `project/path.ts:43-111`, no project marker); `ipc/tool.ts:52-113` allows read/grep/glob with cwd = bound workspace; `permissions/resolver.ts:120-138` classifies inside as `allow` per `FILE_TOOL_DEFAULTS` (`shared/types/permission.ts:66-73`) |
| B. F3.1 orphan tool result → permanent 400 | **CONFIRMED** | `model-messages.ts:45-60` drops unparseable-args tool calls; `:76-93` converts every TOOL message unconditionally → orphan; `history.ts:99-162` pairs by id only; poison source `stream/sdk-event-adapter.ts:187-200` persisted at `ipc/chat/send.ts:395-418` (status `error` ≠ `cancelled`, not excluded); 400 is non-transient → no retry, session poisoned until hand-edited |
| C. F8.1 draft-send projection hijack | **CONFIRMED** | `useChat.ts:505-509` — draft send leaves both affinity ids null during the await; adoption branch `:191-194` takes the first event from any session (background sessions reach it — `ipc/chat/events.ts:64-84`); reducer identity guard (`shared/chat/turn-projection.ts:234-240`) then rejects the real session's events; post-await rebind fixes affinity but not the polluted projection |

**Scenarios traced that the system handles correctly:**
1. **kill -9 mid-session-write → restart: HANDLED.** WAL-mode SQLite, transactional turn writes; recovery sets stale ACTIVE chains to INTERRUPTED in one transaction; individually corrupt rows skipped without failing load; dangling tool_calls filtered by the pairing invariant on next replay.
2. **Parent session deleted while subagent mid-stream: HANDLED.** `cancelRunning` → interrupt lifecycle clears pending questions and resolves waiters; renderer overlay settles; scheduler purge prevents late terminal-wave row recreation; straggler flushes no-op on missing session rows.

**Bonus cross-subsystem findings surfaced during tracing:**

**F12.1 — medium / high — `ipc/chat/send.ts:87`, `ipc/chat/abort.ts:87-100`**
Two windows on one session: the second `chat:send` silently force-aborts the first window's turn with **no terminal event** — window 1 stays stuck in `streaming`, and its Esc then cancels window 2's turn.
*Fix:* emit a terminal event to the displaced window (or reject the second send).

**F12.2 — medium / high — `ipc/session.ts:91-129`**
Workspace rebind does **not** abort in-flight chat despite documented behavior ("intentional rebind aborts in-flight chat") — no abort call in the bind path.
*Fix:* call the same force-stop path used by session delete, or fix the documentation.

**F12.3 — low / high — `ipc/providers.ts:834-841, 915-919`**
Crash windows in provider submit/disconnect: submit crash leaves an orphaned vault entry (known, F5.6); the reverse window in disconnect leaves a dangling credential handle that hard-fails turns with "Unknown credential handle" until re-auth.
*Fix:* startup reconciliation of handles↔connections in both directions.

---

## 5. Consolidated recommendations (priority order)

### P0 — fix before next release (trust boundary)
1. **Project-layer trust model** (F9.1, F9.2): strip `permissions` and `mcp_servers` from `.orchid.json` merging (or make them tighten-only), and require explicit per-server approval for project-defined MCP servers. Combined with auto-injected AGENTS.md, the current state is a clone-a-repo → code-execution chain.
2. **`session:set_workspace` gating** (F1.1): restrict to known directories / non-packaged mode, or demote renderer tool:execute to `ask` after programmatic rebind.
3. **`config:save` hardening** (F1.2): strict MCPServerConfig validation + confirmation for security-critical keys.
4. **Strict-schema legacy crash** (F11.8): migrate/strip unknown keys (notably legacy `providers`) at load instead of throwing from every `loadConfig()`.

### P1 — correctness bugs with durable user impact
5. **Session-poisoning orphan tool result** (F3.1): symmetric drop in `toModelMessages` or sanitize at the sdkInputError boundary.
6. **Renderer hijack** (F8.1): explicit turn binding on send resolution.
7. **Signal-killed exit codes** (F4.3), **config:save env baking** (F6.1), **missing-workspace structured error** (F6.3), **two-window silent abort** (F12.1), **rebind abort drift** (F12.2).

### P2 — safety mechanisms that are dead or bypassable
8. grep per-file timeout (F4.1), glob symlink walk (F4.2), apply_patch symlink write-through (F4.6), edit/write symlink destruction (F4.10), skill resource symlink escape (F9.3), read byte-budget hole (F4.4), web_fetch SSRF/OOM (F4.5).

### P3 — operational & scaling
9. Single-instance lock (F5.1); ledger retention + analytics SQL aggregation (F5.3, F10.3); session cache eviction (F6.7); chain-scoped SESSION_UPDATED diffs (F10.1); lazy session hydration (F10.5); MCP onclose + teardown race (F7.4, F7.5); AST watchdog/cancel (F7.2); log permissions + rotation (F9.5); updater signing posture (F9.6).

### P4 — structural debt
10. Shared primitives: one atomic-write, one path-canonicalize, one error classifier (F11.3, F11.4, F11.5); tools layer off Electron windows + frozen-context invariant restored (F11.1, F11.2); AGENTS.md regeneration (F11.7); god-module splits (F11.10); projector/config limit consistency (F11.6).

### Tests to add (from §3.9)
- `chat:cancel` / `chat:stop` / `forceStopSession` handler suites (T1, T2) — the two-phase Esc flow is currently untested end-to-end.
- Direct `atomicWriteJson` tests (T3) — crash safety and 0600 permissions of the app's core persistence primitive.
- Real-SQLite RAG store tests (T4); behavioral MarkdownContent XSS tests (T5); behavioral useChat send-failure tests (T6); remaining renderer-hook behavioral tests (T7).

---

## 6. Appendix — review roster

| Wave | Reviewer | Domain | Status |
|---|---|---|---|
| 1 | security-reviewer | IPC/preload boundary | ✅ 4 findings |
| 1 | correctness-reviewer | Agent orchestration (XState + subagents) | ✅ 5 findings |
| 1 | correctness-reviewer | LLM streaming & orchestration | ✅ 5 findings |
| 1 | correctness-reviewer | Tool system | ✅ 10 findings |
| 1 | data-integrity-guardian | Providers, credentials & accounting | ✅ 6 findings |
| 1 | correctness-reviewer | Config, session, workspace, AGENTS.md | ✅ 8 findings |
| 1 | reliability-reviewer | RAG, AST, MCP | ✅ 8 findings |
| 1 | correctness-reviewer | Renderer (React UI) | ✅ 4 findings |
| 1 | testing-reviewer | Test suite quality & coverage | ✅ 9 gaps + 4 quality findings |
| 2 | security-reviewer | Permissions, logging, updater, skills | ✅ 7 findings (2 critical) |
| 2 | performance-reviewer | Hot paths, scaling, SQLite patterns | ✅ 10 findings |
| 2 | architecture-strategist | Layering, duplication, doc drift | ✅ 10 findings |
| 2 | adversarial-reviewer | Scenario tracing + finding verification | ✅ 3/3 confirmed + 3 bonus |

**Orchestrator spot-verification:** F1.1 (session.ts:459-470 handler + comment), F4.3 (execute-command.ts:334 `?? 0`), and F6.1 (config.ts:139-148 merged-view write) were additionally re-verified directly by the orchestrator.

**Totals:** 93 findings and gaps across 13 reviewer passes — 2 critical, 8 high-severity findings (+3 high-risk coverage gaps), 34 medium, 36 low — with extensive verified-clean inventories per domain (each section's "verified clean" list is part of the audit record).
