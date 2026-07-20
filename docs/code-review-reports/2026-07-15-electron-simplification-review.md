# Electron simplification review — 2026-07-15

## Meta

| Field | Value |
|-------|--------|
| **Date** | 2026-07-15 (audit + partial fix) · **re-verified 2026-07-20** |
| **Branch (audit)** | `feat/provider-system-refactor` @ `1a46edd` (+ uncommitted simplification fixes) |
| **Re-verify branch** | `fix/full-audit-2026-07-16` (current tree under `electron/src/**`) |
| **Scope** | `electron/src/**` (maintained Electron app) |
| **Mode** | Audit → partial fix (2026-07-15) → **prune + re-verify open items (2026-07-20)** |
| **Method** | Adapted `ce-simplify-code` 3-lens pass (reuse / quality / efficiency) per unit |
| **Agents** | Pattern recognition (reuse), maintainability (quality), performance (efficiency); 2026-07-20 explore subagents re-checked open findings |
| **Related** | Complements [2026-07-13-dead-code-report.md](./2026-07-13-dead-code-report.md) (dead-code cleanup); this report focuses on **simplification** (dedupe, structure, efficiency) of live code |

### Fix / verify log

| When | What |
|------|------|
| **2026-07-15** | P0/P1 partial fix: net ~−280 lines in `electron/src` (24 files). `npm run typecheck`, `npm run lint`, focused unit suites (~372 tests) passed. |
| **2026-07-20** | Re-verified remaining open/partial/P2/P3/Hold findings against current tree. **Removed** findings confirmed fixed (including four that closed after the original fix pass). Updated partials with current evidence. |

#### Closed (removed from backlog)

| Status | IDs |
|--------|-----|
| **Fixed 2026-07-15** | SIMP-U3-001, U3-002, U3-003, U9-002, U3-010, U3-011, U3-012, U3-014, U3-015, U2-010, U2-011, U7-010, U7-012; U3-016 scope half (`normalizeAgentScopeId`) |
| **Fixed by 2026-07-20 re-verify** | SIMP-U7-013 (preload `on`/`onParsed`), SIMP-U7-020 (chat-history session-keyed naming), SIMP-U7-022 (cached driver registry), SIMP-U8-021 (shared `useSession` store) |

#### Still open after re-verify

| Status | IDs |
|--------|-----|
| **Open** | U2-001, U9-001, U3-013, U2-012, U4-010…013, U6-010…012, U7-011 (partial shell), U8-010 (partial maps), U9-010, remaining P2/P3/Hold (see below) |
| **Partial (remaining work)** | U3-016 not-found helper, U7-011 progress shells, U5-020 quirks mid-stream flag, U8-010/022 picker & IndexSection, U3-033/034, U5-031, U8-032, HOLD-003 |

### Exclusions

- `electron/src/main/skills/defaults/**`, `electron/src/main/agents/defaults/**`
- `node_modules/`, `dist/`, `release/`, build artifacts
- Docs, assets, retired Python prototype
- Architecture redesign, dependency upgrades, feature work, IPC contract changes

### Units

| Unit | Paths | Lenses |
|------|--------|--------|
| U1 | `shared/**` | reuse, quality, efficiency |
| U2 | `main/config`, `session`, `project`, `defs` | all three |
| U3 | `main/tools/**` | all three |
| U4 | `main/providers/**` | all three |
| U5 | `main/llm/**`, `main/agents/**` (code only) | all three |
| U6 | `main/mcp`, `rag`, `ast` | all three |
| U7 | `main/ipc/**`, `preload` | all three |
| U8 | `renderer/**` | all three |
| U9 | `main/index.ts`, logging, updater, utils, skills/registry | all three |

### Confidence & ranking rules

- Included findings generally have **confidence ≥ 70**
- **P0** — clear dead locals / unused wrappers / prototype pollution / obvious local dupes with existing helper
- **P1** — reuse existing in-tree helpers or extract one shared helper used 3+ times
- **P2** — local quality (stringly types, parameter bags, copy-paste shells) outside hot path
- **P3** — efficiency / hot-path; prefer characterization or measurement before large rewrites
- **Hold** — auth, provider resolve contracts, XState agent loop semantics, IPC allowlists, or medium+ risk without strong tests

---

## Executive summary

| Lens | Open findings (approx.) | Dominant themes | Notes |
|------|-------------------------|-----------------|-------|
| **Reuse** | ~15 open | RAG↔AST twin stacks, driver credential helpers, IPC shells, seedDefaults | Filesystem helpers + bound-path + flattenSessionMessages + preload event helpers **done** |
| **Quality** | ~14 open | Dual config sources, god modules, stringly types, middleware flags | Grep prototype + dead locals/wrapper + chat-history naming + driver registry cache **done** |
| **Efficiency** | ~22 open (several partial) | Full-file tool I/O, session JSON rewrite, stream IPC fan-out, React stream re-renders, RAG vector write | Mostly **untouched**; small partials on glob stats, write projection, subagent snapshot, per-turn schema build |

**Highest-value remaining clusters:**

1. **RAG/AST twin architecture** — shared walk/hash/worker/index-run controller  
2. **Provider driver boilerplate** — `apiKeyFor*`, OpenAI-compatible model factory, status JSON parsers, write locks, redact  
3. **RAG/AST IPC shells** — progress broadcast still twin; path resolve **done** via `resolveBoundProjectPath`  
4. **Stream hot path** — stop full `CHAT_STATE` per token; cache webContents; coalesce renderer updates  
5. **Session load amplification** — todos still full-disk reloads; session select multi-load  

**Clean areas (no high-confidence simplification needed):**  
`shared/usage.ts`, `agent-scope.ts`, `provider.ts` contracts, `resolver.ts`, `catalog/trust.ts`, `accounting/cost.ts`, `message-factories.ts`, `interrupt-machine.ts`, `mcp/transport.ts`, `rag/chunker.ts`, `logging.ts`, `esm-import.ts`, session-activity push pattern, ToolRegistry WeakMap cache for builtins.

**Also cleaner after fix passes:** `tools/filesystem/edit.ts` / `write.ts` (thin handlers), `tools/search/grep.ts` (no prototype pollution), `ipc/{rag,ast,tool,defs,mcp}` bound-path path, preload event parsing, provider IPC driver registry cache, shared `useSession` store.

---

## Priority backlog

### P0 — safe clarity wins

| ID | Status | Summary | Paths | Lens |
|----|--------|---------|-------|------|
| [SIMP-U2-001](#simp-u2-001) | Open | `hydrateProjectRuntime` is async identity | `project/runtime.ts` | quality |
| [SIMP-U9-001](#simp-u9-001) | Open | Updater IPC/UI surface unused (bridge dead) | `updater.ts`, preload, ipc types | quality |

### P1 — reuse existing helpers / extract once

| ID | Status | Summary | Paths | Lens |
|----|--------|---------|-------|------|
| [SIMP-U3-013](#simp-u3-013) | Open | Shared glob→regex | `glob.ts`, `grep.ts` | reuse |
| [SIMP-U3-016](#simp-u3-016) | Partial | Background cmd not-found helper | process tools | reuse |
| [SIMP-U2-012](#simp-u2-012) | Open | Definition listManaged* generic | `defs/manage.ts` | reuse |
| [SIMP-U4-010](#simp-u4-010) | Open | Shared `apiKeyForDriver` / embedding | all drivers | reuse |
| [SIMP-U4-011](#simp-u4-011) | Open | Shared write-lock utility | connection-store, vault | reuse |
| [SIMP-U4-012](#simp-u4-012) | Open | Shared status JSON coerce + redact | lilac, neuralwatt, cache, accounting | reuse |
| [SIMP-U4-013](#simp-u4-013) | Open | OpenAI-compatible model factory | compatible drivers | quality |
| [SIMP-U6-010](#simp-u6-010) | Open | RAG↔AST: walk, hash, worker, run tracker | rag + ast indexers | reuse |
| [SIMP-U6-011](#simp-u6-011) | Open | Shared `withTimeout` | mcp manager, tool-dispatch | reuse |
| [SIMP-U6-012](#simp-u6-012) | Open | Shared `sleep` | ast indexer, retry, background-store | reuse |
| [SIMP-U7-011](#simp-u7-011) | Partial | RAG/AST IPC shell extract | `ipc/rag.ts`, `ipc/ast.ts` | reuse |
| [SIMP-U8-010](#simp-u8-010) | Partial | Provider model picker maps hook | ChatView, TierModels, RAGTab | reuse |
| [SIMP-U9-010](#simp-u9-010) | Open | Shared seedDefaults for skills/agents | skills + agents registry | reuse |

### P2 — local quality

| ID | Status | Summary | Paths | Lens |
|----|--------|---------|-------|------|
| [SIMP-U1-020](#simp-u1-020) | Open | Tighten stringly IPC/theme/chain types | shared types, commands | quality |
| [SIMP-U2-020](#simp-u2-020) | Open | Drop Zod-duplicate checks in validateConfig | validation + schema | quality |
| [SIMP-U2-021](#simp-u2-021) | Open | Stop mutating live config for sticky default | workspace.ts | quality |
| [SIMP-U3-020](#simp-u3-020) | Open | Enum schemas for todo status / agent tier | todo, delegate | quality |
| [SIMP-U3-021](#simp-u3-021) | Open | Options bag for `executeCommand` | execute-command.ts | quality |
| [SIMP-U5-020](#simp-u5-020) | Partial | Dead mid-stream flags in quirks (retry improved) | middleware | quality |
| [SIMP-U5-021](#simp-u5-021) | Open | Dual timeout exemption sources | tool-dispatch | quality |
| [SIMP-U5-022](#simp-u5-022) | Open | BackgroundCommand.status ignored | build-prompt-context / system-prompt | quality |
| [SIMP-U5-023](#simp-u5-023) | Open | MCP allowlist via ToolRegistry/minimatch | orchestrator | quality |
| [SIMP-U5-024](#simp-u5-024) | Open | Prefer catalog over KNOWN_MODELS | model-metadata | quality |
| [SIMP-U7-021](#simp-u7-021) | Open | definitions IPC mutation helper | definitions.ts | quality |
| [SIMP-U8-020](#simp-u8-020) | Open | Dual theme/config ownership App vs ChatView | App, ChatView | quality |
| [SIMP-U8-022](#simp-u8-022) | Partial | IndexSection RAG/AST branch twin | Sidebar | reuse |

### P3 — efficiency (measure / characterize first)

| ID | Status | Summary | Paths | Lens |
|----|--------|---------|-------|------|
| [SIMP-U3-030](#simp-u3-030) | Open | read: full-file + double open for binary check | read.ts | efficiency |
| [SIMP-U3-031](#simp-u3-031) | Open | grep: unbounded path list; sync read; serial walk | grep.ts | efficiency |
| [SIMP-U3-032](#simp-u3-032) | Open | edit: full-file patch/diff every edit | edit.ts | efficiency |
| [SIMP-U3-033](#simp-u3-033) | Partial | glob: ~2× stat per path (was ~3×) | glob.ts | efficiency |
| [SIMP-U3-034](#simp-u3-034) | Partial | write still echoes full body (no line numbers) | write.ts | efficiency |
| [SIMP-U3-035](#simp-u3-035) | Open | HeadTailBuffer concat-on-append | head-tail-buffer.ts | efficiency |
| [SIMP-U2-030](#simp-u2-030) | Open | Full session JSON rewrite every chain update | session manager/storage | efficiency |
| [SIMP-U2-031](#simp-u2-031) | Open | existsSync then open TOCTOU | session storage | efficiency |
| [SIMP-U4-030](#simp-u4-030) | Open | Re-read providers.json every resolve | connection-store | efficiency |
| [SIMP-U4-031](#simp-u4-031) | Open | Rebuild provider definitions every get | catalog store | efficiency |
| [SIMP-U5-030](#simp-u5-030) | Open | Tool args stringify→parse roundtrip | orchestrator + tool-dispatch | efficiency |
| [SIMP-U5-031](#simp-u5-031) | Partial | zodToJsonSchema once per turn (not durable cache) | context-snapshot | efficiency |
| [SIMP-U5-032](#simp-u5-032) | Open | Agent machine string concat per chunk | agent-machine.ts | efficiency |
| [SIMP-U5-033](#simp-u5-033) | Open | sendTurnEvent scans all WebContents | chat.ts IPC | efficiency |
| [SIMP-U6-030](#simp-u6-030) | Open | MCP servers start sequentially | mcp/manager.ts | efficiency |
| [SIMP-U6-031](#simp-u6-031) | Open | RAG vector write path materializes number[][] | rag store/indexer | efficiency |
| [SIMP-U6-032](#simp-u6-032) | Open | AST ensureIndexed busy-poll sleep(100) | ast/indexer.ts | efficiency |
| [SIMP-U7-030](#simp-u7-030) | Open | CHAT_STATE every snapshot tick with full response | chat.ts | efficiency |
| [SIMP-U8-030](#simp-u8-030) | Open | Stream: dual setState per chunk; no rAF coalesce | useChat.ts | efficiency |
| [SIMP-U8-031](#simp-u8-031) | Open | 100ms elapsed ticker invalidates history memo | useChat, ChatStream | efficiency |
| [SIMP-U8-032](#simp-u8-032) | Partial | Todos full load; subagents use snapshot IPC | useTodos, useSubagents | efficiency |
| [SIMP-U8-033](#simp-u8-033) | Open | Triple main-process loads on session select | ChatView + hooks | efficiency |
| [SIMP-U8-034](#simp-u8-034) | Open | Live markdown reparse every token | MessageWidget | efficiency |
| [SIMP-U8-035](#simp-u8-035) | Open | bgCmd 200ms poll vs push | useLiveCommandOutput | efficiency |

### Hold — high behavior risk / weak isolation

| ID | Status | Why hold |
|----|--------|----------|
| [SIMP-HOLD-001](#simp-hold-001) | Open | Split chat.ts / useChat / ChatStream god modules — large behavior surface |
| [SIMP-HOLD-002](#simp-hold-002) | Open | StreamChatParams / ActiveAgent restructuring — cross-process contracts |
| [SIMP-HOLD-003](#simp-hold-003) | Partial | Require frozen turn config only (drop getConfig fallbacks) — may break edge call paths |
| [SIMP-HOLD-004](#simp-hold-004) | Open | Dual toolCall/result capture (fullStream + onStepFinish) — stream correctness |
| [SIMP-HOLD-005](#simp-hold-005) | Open | URL validation unify across vault/compatible/catalog — security-sensitive |

---

## Findings (canonical)

### SIMP-U2-001

- **Status:** Open (deferred — call sites/tests still treat as compatibility hook)  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / dead-code / low / 90  
- **Paths:** `electron/src/main/project/runtime.ts`  
- **Summary:** `hydrateProjectRuntime` is `async (runtime) => runtime`.  
- **Suggestion:** Remove helper and call sites, or implement real hydration when needed.  
- **Unit:** U2  

### SIMP-U9-001

- **Status:** Open (product choice: wire UI vs drop bridge)  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / dead-code / low / 94  
- **Paths:** `electron/src/main/updater.ts`, `electron/src/preload/index.ts`, `electron/src/shared/types/ipc.ts`  
- **Summary:** Updater emits status/progress/error and exports `downloadUpdate` / `quitAndInstall`; preload only exposes event listeners; no renderer consumer of `orchid.updater`.  
- **Suggestion:** Wire UI **or** drop unused public bridge until a consumer exists; keep headless check if desired.  
- **Unit:** U9  

### SIMP-U3-013

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / medium / 85  
- **Paths:** `tools/filesystem/glob.ts`, `tools/search/grep.ts`  
- **Summary:** Separate converters: `globToRegex` (grep) vs `globSegmentToRegex` (glob); not shared.  
- **Suggestion:** One helper or use existing `minimatch` dependency.  
- **Unit:** U3  

### SIMP-U3-016

- **Status:** **Partial** — `normalizeAgentScopeId` applied; not-found error blocks still duplicated  
- **Verified:** 2026-07-20 — **STILL_TRUE** (as partial)  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 88  
- **Paths:** `tools/process/read-output.ts`, `send-input.ts`, `terminate-command.ts`, `shared/types/agent-scope.ts`  
- **Summary:** Identical not-found error blocks remain (`Error: No background command with id ${id}.`).  
- **Suggestion:** Shared `notFoundResult(id)`.  
- **Unit:** U3  

### SIMP-U2-012

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 80  
- **Paths:** `defs/manage.ts`  
- **Summary:** `listManagedSkills` / `listManagedAgents` / `listManagedPersonalities` each implement global+project merge + per-type scanners.  
- **Suggestion:** Generic `listScopedEntries` / `listDefinitionEntries`.  
- **Unit:** U2  

### SIMP-U4-010

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 96  
- **Paths:** `providers/drivers/{native,compatible,opencode-go,neuralwatt,lilac}.ts`  
- **Summary:** Local `apiKeyForDriver` / embedding / `apiKeyForLilac` variants still copy-pasted with inconsistent empty-key behavior.  
- **Suggestion:** Shared `requireApiKey` / `optionalApiKey` on `DriverCredential`.  
- **Unit:** U4  

### SIMP-U4-011

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / medium / 94  
- **Paths:** `providers/connection-store.ts`, `providers/credentials/vault.ts`  
- **Summary:** Promise-chain write locks still duplicated (`withWriteLock` / `withVaultWriteLock`).  
- **Suggestion:** `withSerializedWrite(filePath, task)`.  
- **Unit:** U4  

### SIMP-U4-012

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 91  
- **Paths:** lilac, neuralwatt, `providers/index.ts`, status cache, accounting store  
- **Summary:** Local `record` / finite-number helpers; separate sensitive-key redaction in status cache vs accounting.  
- **Suggestion:** Shared status parse helpers + `redactSensitiveValue`.  
- **Unit:** U4  

### SIMP-U4-013

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / copy-paste / low / 88  
- **Paths:** compatible, lilac, neuralwatt, opencode-go drivers  
- **Summary:** `createOpenAICompatible({ name, baseURL, apiKey, fetch: createUnwrappingFetch() })(modelId)` repeated; no shared factory.  
- **Suggestion:** `createOpenAICompatibleModel({ name, baseURL, apiKey, modelId })`.  
- **Unit:** U4  

### SIMP-U6-010

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low–medium / 90–95  
- **Paths:** `rag/indexer.ts`, `ast/indexer.ts`, index-workers  
- **Summary:** Twin stacks for `activeIndexes`, worker lifecycle, progress, directory walk/skip dirs.  
- **Suggestion:** Shared walk/hash/worker-run-controller; domain filters stay local.  
- **Unit:** U6  

### SIMP-U6-011

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / inline-could-use-util / medium / 93  
- **Paths:** `mcp/manager.ts`, `llm/tool-dispatch.ts`  
- **Summary:** Private `_withTimeout` reimplements exported `withTimeout` race/timer pattern.  
- **Suggestion:** Share one timeout helper under `main/utils` or import tool-dispatch export.  
- **Unit:** U6  

### SIMP-U6-012

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 85  
- **Paths:** `ast/indexer.ts`, `llm/middleware/retry.ts`, `tools/process/background-store.ts`  
- **Summary:** Local `sleep(ms)` wrappers.  
- **Suggestion:** Single `main/utils/async.ts` `sleep`.  
- **Unit:** U6  

### SIMP-U7-011

- **Status:** **Partial** — path resolve shared; progress broadcast + empty shells still twin modules  
- **Verified:** 2026-07-20 — **STILL_TRUE** (as partial)  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 95  
- **Paths:** `ipc/rag.ts`, `ipc/ast.ts`  
- **Summary:** Nearly identical `broadcastProgress`, empty status shells, “no project” / “already in progress” result shells.  
- **Suggestion:** Shared bound-path + progress helpers; domain status/index only in each file.  
- **Unit:** U7  

### SIMP-U8-010

- **Status:** **Partial** — catalog shared via `useProviders().modelOptions`; per-surface filter/map still duplicated  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 93  
- **Paths:** ChatView, TierModelsTab, RAGTab, `provider-selection.ts`, `models.ts`  
- **Summary:** ChatView / TierModels / RAGTab each copy/filter options in local state/memos (full list vs text-gen vs embedding).  
- **Suggestion:** Hook/builder using existing `providerModelOptionKey` / modality filters.  
- **Unit:** U8  

### SIMP-U9-010

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 90  
- **Paths:** `skills/registry.ts`, `agents/registry.ts`  
- **Summary:** `seedDefaults` subdir copy-if-missing still duplicated (SKILL.md vs AGENT.md).  
- **Suggestion:** Shared `seedDefaultSubdirs(source, target, filename)`.  
- **Unit:** U9  

### SIMP-U1-020

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / stringly-typed / low / 78–85  
- **Paths:** `shared/types/chain.ts`, `subagent.ts`, `ipc.ts`, `commands.ts`, `ipc-boundary.ts`  
- **Summary:** `Chain.agentType`/`agentTier` and subagent fields still plain `string`; `CommandContext` still has string model APIs; theme still `string` despite `THEME_NAMES`.  
- **Suggestion:** Tighten types at boundaries without changing runtime wire format first.  
- **Unit:** U1  

### SIMP-U2-020

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / copy-paste / low / 82  
- **Paths:** `config/validation.ts`, `config/schema.ts`  
- **Summary:** `validateConfig` still re-runs range checks for fields Zod already constrains.  
- **Suggestion:** Keep cross-field rules only.  
- **Unit:** U2  

### SIMP-U2-021

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / leaky-abstraction / medium / 85  
- **Paths:** `project/workspace.ts`  
- **Summary:** `updateStickyDefaultProjectDir` still mutates live `getConfig()` object in place.  
- **Suggestion:** Write home file + reload/reset; treat config as immutable.  
- **Unit:** U2  

### SIMP-U3-020

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / stringly-typed / low / 85–90  
- **Paths:** todo tools, `subagent/delegate.ts`  
- **Summary:** Todo tools use `z.string()` + `parseTodoStatus`; delegate uses `tier: z.string()` then manual `AgentTier` set check.  
- **Suggestion:** `z.nativeEnum` / `z.enum` at schema boundary.  
- **Unit:** U3  

### SIMP-U3-021

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / parameter-sprawl / low / 88  
- **Paths:** `tools/process/execute-command.ts`  
- **Summary:** Seven positional args + options bag; handler still spreads positionally.  
- **Suggestion:** Single options object.  
- **Unit:** U3  

### SIMP-U5-020

- **Status:** **Partial** — retry mid-stream path improved; quirks mid-stream flag still dead  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** quality / dead-code / medium / 90–92  
- **Paths:** `llm/middleware/provider-quirks.ts`, `retry.ts`  
- **Summary:** `retry.ts` now tracks `contentDelivered` while reading. `provider-quirks.ts` still only catches around `doStream()` setup while setting `hasReceivedContent` inside the returned TransformStream, so the mid-stream benign-error suppress path remains structurally dead.  
- **Suggestion:** Fix quirks stream error path or delete misleading flag; document open-only quirks.  
- **Unit:** U5  

### SIMP-U5-021

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / redundant-state / low / 85  
- **Paths:** `llm/tool-dispatch.ts`  
- **Summary:** `runWithToolTimeout` still ORs `options.noTimeout` with hard-coded `TOOLS_WITHOUT_TIMEOUT`.  
- **Suggestion:** Prefer definition flag only.  
- **Unit:** U5  

### SIMP-U5-022

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / redundant-state / low / 90  
- **Paths:** `llm/build-prompt-context.ts`, `system-prompt.ts`  
- **Summary:** Background command `status` set from `exitCode` in context builder; system-prompt ignores `cmd.status` and re-derives from `exitCode`.  
- **Suggestion:** Single source of truth for status field.  
- **Unit:** U5  

### SIMP-U5-023

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / copy-paste / medium / 88  
- **Paths:** `llm/orchestrator.ts`, `tools/registry.ts`  
- **Summary:** MCP allowlist still uses ad-hoc `RegExp` with `*` → `.*`; builtins use `minimatch` in `ToolRegistry.filter`.  
- **Suggestion:** Shared allowed-tools matcher.  
- **Unit:** U5  

### SIMP-U5-024

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / leaky-abstraction / medium / 80  
- **Paths:** `llm/model-metadata.ts`, catalog schema  
- **Summary:** Hard-coded `KNOWN_MODELS` still independent of signed provider catalog.  
- **Suggestion:** Prefer catalog EffectiveModel; KNOWN_MODELS last resort only.  
- **Unit:** U5  

### SIMP-U7-021

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / copy-paste / low / 90  
- **Paths:** `ipc/definitions.ts`  
- **Summary:** Six near-identical save/delete handlers: `safeParse` → `projectDirFromEvent` → mutate → `reloadDefinitionRegistries`.  
- **Suggestion:** `withDefinitionMutation` helper.  
- **Unit:** U7  

### SIMP-U8-020

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / redundant-state / low / 82  
- **Paths:** `renderer/App.tsx`, `ChatView.tsx`  
- **Summary:** App loads theme via `config.get()` on mount; ChatView `loadConfig()` also calls `config.get()` and sets theme/personality/selection.  
- **Suggestion:** Lift to context or pass from App.  
- **Unit:** U8  

### SIMP-U8-022

- **Status:** **Partial** — `runIndex(kind)` unified; parallel rag/ast UI state remains  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 86  
- **Paths:** `renderer/components/Sidebar.tsx`  
- **Summary:** IndexSection still keeps parallel rag/ast busy/error/progress state and near-duplicated `onProgress` subscriptions.  
- **Suggestion:** Parameterized indexer controller state.  
- **Unit:** U8  

### SIMP-U3-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / overly-broad+unnecessary-work / low / 88–92  
- **Paths:** `tools/filesystem/read.ts`  
- **Summary:** Binary peek via `isBinaryFileSync` then full `readFileSync` + split before offset/limit slice.  
- **Suggestion:** Stream/line-scan window; single fd for peek+read.  
- **Unit:** U3  

### SIMP-U3-031

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / memory+hot-path / medium / 78–90  
- **Paths:** `tools/search/grep.ts`  
- **Summary:** `collectFiles` materializes full path list; search still sync full-file under semaphore. Parallelism does not remove collect-all or sync reads.  
- **Suggestion:** Incremental walk+search; async I/O or spawn ripgrep.  
- **Unit:** U3  

### SIMP-U3-032

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE** (implementation now uses jsdiff `structuredPatch` via `buildStructuredFileChange`)  
- **Lens / class / risk / confidence:** efficiency / hot-path / low / 82–88  
- **Paths:** `tools/filesystem/edit.ts`  
- **Summary:** Every edit still loads full content, replaces, then full old/new structured patch.  
- **Suggestion:** Local hunks / cheaper display path for large files.  
- **Unit:** U3  

### SIMP-U3-033

- **Status:** **Partial** — format no longer re-stats; walk + sort still ~2 stats/match  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 86  
- **Paths:** `tools/filesystem/glob.ts`  
- **Summary:** Walk `statSync`s leaves/dirs; sort re-`statSync`s for mtime/size; format reuses that data.  
- **Suggestion:** Capture mtime/type once in walk records.  
- **Unit:** U3  

### SIMP-U3-034

- **Status:** **Partial** — agent projection no longer numbers lines; still embeds full content  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** efficiency / overly-broad / low / 84  
- **Paths:** `tools/filesystem/write.ts`, `tools/result.ts`  
- **Summary:** `fileWriteAgentProjector` still embeds full `parsed.content` in XML.  
- **Suggestion:** Path + line count (+ optional head/tail).  
- **Unit:** U3  

### SIMP-U3-035

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / memory / low / 88  
- **Paths:** `tools/process/head-tail-buffer.ts`  
- **Summary:** `append` always does `Buffer.concat` under high output.  
- **Suggestion:** Chunk list / circular buffers; concat on snapshot.  
- **Unit:** U3  

### SIMP-U2-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / medium / 87  
- **Paths:** `session/manager.ts`, `session/storage.ts`  
- **Summary:** Chain updates call `replaceSession` + atomic full session JSON write every time.  
- **Suggestion:** Debounce mid-turn; or segmented/append-friendly storage.  
- **Unit:** U2  

### SIMP-U2-031

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / toctou / low / 80  
- **Paths:** `session/storage.ts`  
- **Summary:** `loadSession` still `existsSync` then `readFileSync`.  
- **Suggestion:** Operate and treat ENOENT as not-found.  
- **Unit:** U2  

### SIMP-U4-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / low / 92  
- **Paths:** `providers/connection-store.ts`, `providers/index.ts`  
- **Summary:** `list`/`get` re-read and Zod-parse `providers.json` every call; resolve always lists. No in-memory cache.  
- **Suggestion:** In-memory snapshot invalidated on write.  
- **Unit:** U4  

### SIMP-U4-031

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 90  
- **Paths:** `providers/catalog/store.ts`  
- **Summary:** Catalog snapshot cached; `getProviderDefinitions` still rebuilds via Zod map every call.  
- **Suggestion:** Cache derived view with catalog snapshot.  
- **Unit:** U4  

### SIMP-U5-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 88  
- **Paths:** `llm/orchestrator.ts`, `tool-dispatch.ts`  
- **Summary:** Tool execute still `JSON.stringify(args)` then `JSON.parse` in dispatch.  
- **Suggestion:** Pass parsed args through dispatch API.  
- **Unit:** U5  

### SIMP-U5-031

- **Status:** **Partial** — amortized once per streamChat tool map, not every dynamic snapshot  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 80–84  
- **Paths:** `llm/context-snapshot.ts`, `tools/registry.ts`  
- **Summary:** `createContextSnapshotBuilder` runs `zodToJsonSchema` once per builder (per turn tool map). Still no durable schema cache; `ToolRegistry.toJsonSchema()` converts all tools on each call.  
- **Suggestion:** Cache schema lengths at tool-map build / durable WeakMap.  
- **Unit:** U5  

### SIMP-U5-032

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / low / 86  
- **Paths:** `agents/xstate/agent-machine.ts`  
- **Summary:** CHUNK/THINKING still assign with `context.response + event.data` / `context.thinking + event.data`.  
- **Suggestion:** Chunk array + join on end; or mutate accumulator.  
- **Unit:** U5  

### SIMP-U5-033

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / medium / 91  
- **Paths:** `ipc/chat.ts`  
- **Summary:** `sendTurnEvent` always `getAllWebContents()`, filters by session ownership, then sends.  
- **Suggestion:** Session→WebContents subscriber map or cache on ActiveAgent.  
- **Unit:** U5/U7  

### SIMP-U6-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / missed-concurrency / medium / 83  
- **Paths:** `mcp/manager.ts`  
- **Summary:** MCP servers still connect sequentially (`for ... await this._connectServer`).  
- **Suggestion:** Bounded parallel connect under overall timeout.  
- **Unit:** U6  

### SIMP-U6-031

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / memory / medium / 88  
- **Paths:** `rag/store.ts`, `rag/indexer.ts`  
- **Summary:** Write path still uses `number[][]`; batch updates splice and rebuild. Search load has Float32Array path.  
- **Suggestion:** Float32 matrix / compact once at flush.  
- **Unit:** U6  

### SIMP-U6-032

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / other / low / 81  
- **Paths:** `ast/indexer.ts`  
- **Summary:** `ensureIndexed` still busy-waits with `while (...) { await sleep(100); }`.  
- **Suggestion:** Single-flight Promise per project key.  
- **Unit:** U6  

### SIMP-U7-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / low / 95  
- **Paths:** `ipc/chat.ts`  
- **Summary:** Actor subscribe still sends full `CHAT_STATE` (state, response, error, interrupt, cwd) on every snapshot tick.  
- **Suggestion:** Emit CHAT_STATE on discrete transitions only; chunks for incremental text.  
- **Unit:** U7  

### SIMP-U8-030

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / low / 92  
- **Paths:** `renderer/hooks/useChat.ts`  
- **Summary:** Per CHAT_CHUNK: `setStreamingContent` + `applyStreamSegments` → dual React updates; no rAF batching.  
- **Suggestion:** Ref accumulate; flush ≤1/frame.  
- **Unit:** U8  

### SIMP-U8-031

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path+no-op / low / 90–91  
- **Paths:** `useChat.ts`, `ChatStream.tsx`  
- **Summary:** 100ms elapsed ticker while streaming; `elapsedSeconds` still in history `useMemo` deps.  
- **Suggestion:** 1s footer-local tick; drop elapsed from history deps.  
- **Unit:** U8  

### SIMP-U8-032

- **Status:** **Partial** — subagents use snapshot IPC; todos still full session load  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / medium / 94  
- **Paths:** `useTodos.ts`, `useSubagents.ts`, session manager/IPC  
- **Summary:** Todos refresh still `session.load({ activate: false })` full parse. Subagents hydrate via `subagents.snapshot`. `applyFromSession` can skip a second peek.  
- **Suggestion:** Peek IPC from SessionManager cache or push partial payloads for todos.  
- **Unit:** U8  

### SIMP-U8-033

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 88  
- **Paths:** ChatView, useTodos, useSubagents  
- **Summary:** Session select still peeks `session.load` → `chat.getSnapshot` → activating `session.load` (three main-process round-trips).  
- **Suggestion:** Hydrate hooks from first load payload.  
- **Unit:** U8  

### SIMP-U8-034

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / hot-path / low / 86  
- **Paths:** `MessageWidget.tsx`, `MarkdownContent.tsx`  
- **Summary:** Streaming assistant/thought content still full `ReactMarkdown` on every content change.  
- **Suggestion:** Plain/pre during stream; MarkdownContent on commit.  
- **Unit:** U8  

### SIMP-U8-035

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / missed-concurrency / medium / 84  
- **Paths:** `useLiveCommandOutput.ts`, chat IPC  
- **Summary:** Still polls every `POLL_INTERVAL_MS = 200`.  
- **Suggestion:** Push tail/exit events; poll as fallback.  
- **Unit:** U8  

### SIMP-HOLD-001

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / other / medium / 83–88  
- **Paths:** `ipc/chat.ts` (~1870 LOC), `useChat.ts` (~1383), `ChatStream.tsx` (~1248)  
- **Summary:** Still three large undivided modules; sizes at or above review-era estimates.  
- **Suggestion:** Future multi-PR extract with characterization tests first.  
- **Unit:** U7/U8  

### SIMP-HOLD-002

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** quality / parameter-sprawl / low–medium / 74–88  
- **Paths:** `StreamChatParams` (~13 fields), `ActiveAgent` (~25 fields)  
- **Summary:** Large parameter/state bags; regrouping is design work.  
- **Unit:** U5/U7  

### SIMP-HOLD-003

- **Status:** **Partial** — turn path prefers `getToolConfig`; low-level `getConfig()` fallbacks remain  
- **Verified:** 2026-07-20 — **PARTIALLY_FIXED**  
- **Lens / class / risk / confidence:** quality / other / medium / 80  
- **Paths:** execute-command, grep, rag_search  
- **Summary:** Handlers pass `getToolConfig(ctx)`; process-global fallbacks remain on lower-level APIs (`timeout ?? getConfig().command_timeout`, grep max/ignored_dirs).  
- **Suggestion:** Drop silent live-config fallbacks only after all call paths freeze config.  
- **Unit:** U3  

### SIMP-HOLD-004

- **Status:** Open (documented dual path with dedup)  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** efficiency / unnecessary-work / medium / 76  
- **Paths:** `llm/orchestrator.ts`  
- **Summary:** Prefer fullStream; `onStepFinish` still fills pending tool arrays for textStream fallback; drain deduped by `toolCallId`. Dual sources remain.  
- **Unit:** U5  

### SIMP-HOLD-005

- **Status:** Open  
- **Verified:** 2026-07-20 — **STILL_TRUE**  
- **Lens / class / risk / confidence:** reuse / near-duplicate / medium / 80  
- **Paths:** vault, compatible driver, catalog updater  
- **Summary:** Three separate validators with divergent rules (vault HTTP origin; compatible loopback/insecure policy; catalog HTTPS-only).  
- **Suggestion:** Unify carefully (security).  
- **Unit:** U4  

---

## Cross-cutting themes

1. **Twin systems** — RAG vs AST (indexers, workers, IPC, Sidebar UI) still the largest open structural win. ~~Edit vs AST atomic write/diff~~ **consolidated**.  
2. **Provider stack boilerplate** — credential helpers, OpenAI-compatible construction, status parse, redact, write locks (**open**).  
3. **Config / tool context dual sources** — turn path uses `getToolConfig`; low-level APIs may still mix `getConfig()` fallbacks.  
4. **Stream amplification** — main accumulates full response, emits full CHAT_STATE, scans all windows; renderer dual-writes state and re-markdowns every token (**open**).  
5. **Session I/O amplification** — full JSON rewrite on chain updates; todos still full loads; session select multi-round-trip (**open**; subagents improved via snapshot IPC).  
6. **Stringly boundaries** — `parseTodoStatus` added; many schemas/types still free strings.  
7. **Dead / no-op residue** — hydrate identity + updater UI bridge remain; ~~registerBuiltTool, unused edit locals, isAppSigned, grep prototype, preload cast wrappers, chat-history naming, fresh driver registry, second useSession store~~ **cleared**.  

---

## Clean areas

| Area | Note |
|------|------|
| `shared/usage.ts`, `agent-scope.ts`, `provider.ts` | Focused contracts/helpers |
| `providers/resolver.ts`, `catalog/trust.ts`, `accounting/cost.ts` | Clear, non-duplicative |
| `llm/message-factories.ts`, `history.ts`, `response-unwrap.ts` | Intentional complexity, already shared |
| `agents/xstate/interrupt-machine.ts` | Small Esc machine |
| `mcp/transport.ts`, `mcp/project-registry.ts` lease model | Thin / intentional |
| `rag/chunker.ts` | Self-contained algorithm |
| ToolRegistry WeakMap + exact-match filter | Good caching |
| ConfigManager / ProjectRuntimeRegistry caches | Good |
| Status service TTL + in-flight coalesce | Good |
| Session list partial head parse | Good |
| useSessionActivity push merge | Good pattern to copy for todos |
| Shared `useSession` external store | ChatView + ConfigView share one store |
| Preload `on` / `onParsed` | Event subscription helpers done |
| `logging.ts`, `esm-import.ts` | Minimal |
| `tools/filesystem/edit.ts`, `write.ts` (post-fix) | Thin handlers over shared helpers |
| `shared/types/session.ts` `flattenSessionMessages` | Shared main + renderer history flatten |
| Provider IPC cached driver registry | Process-lifetime cache |

---

## Method notes

- **Audit phase:** 3-lens parallel review, report-only (no patches).  
- **Fix phase (2026-07-15):** Selected P0/P1 applied with typecheck + lint + focused unit tests.  
- **Re-verify phase (2026-07-20):** Four explore subagents re-checked all open/partial/P2/P3/Hold findings against `fix/full-audit-2026-07-16`. Fixed items removed from this document; partials annotated.  
- **Subagent mapping:** Reuse → `ce-pattern-recognition-specialist`; Quality → `ce-maintainability-reviewer`; Efficiency → `ce-performance-reviewer`.  
- Raw agent IDs were unit-local (`temp-reuse-NNN` etc.); this document renumbers to stable `SIMP-*` IDs.  
- Findings overlapping the 2026-07-13 dead-code report are cross-referenced rather than re-litigated as new dead code.  

---

## Recommended future fix batches (remaining)

| Batch | Scope | Suggested skill | Notes |
|-------|--------|-----------------|-------|
| A′ | Remaining P0: hydrate identity + updater bridge product decision | `ce-work` | Small |
| B′ | glob→regex share; process notFound helper; todo `z.nativeEnum` | `ce-simplify-code` / `ce-work` | Finish partials |
| C′ | RAG/AST IPC progress shell | `ce-work` | Bound-path + preload events **done** |
| D | Provider driver/auth/status/redact/write-lock helpers | `ce-work` | Open |
| E | RAG/AST shared indexer infrastructure | plan first — medium risk | Open |
| F | Stream path (CHAT_STATE, webContents cache, useChat rAF, elapsed deps, markdown defer) | `ce-work` + browser feel checks | Open |
| G | Session peek APIs for todos + reduce multi-load on select | `ce-work` | Subagents snapshot **done** |

---

## Appendix: inventory size

| Unit | Approx. TS/TSX files (ex defaults) |
|------|-------------------------------------|
| U1 shared | 17 |
| U2 config/session/project/defs | 15 |
| U3 tools | 36 |
| U4 providers | 21 |
| U5 llm+agents | 22 |
| U6 mcp/rag/ast | 13 |
| U7 ipc+preload | 13 |
| U8 renderer | ~70 |
| U9 entry | ~5 |
| **Total reviewed surface** | **~210 files** under `electron/src` |

---

*Report pruned 2026-07-20: fixed findings removed; open items re-verified against current codebase. No application code was modified by this re-verify pass.*
