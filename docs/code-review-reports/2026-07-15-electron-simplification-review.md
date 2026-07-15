# Electron simplification review — 2026-07-15

## Meta

| Field | Value |
|-------|--------|
| **Date** | 2026-07-15 |
| **Branch** | `feat/provider-system-refactor` @ `1a46edd` (+ uncommitted simplification fixes) |
| **Scope** | `electron/src/**` (maintained Electron app) |
| **Mode** | Audit (report) → **partial fix pass applied** (P0 + selected P1) |
| **Method** | Adapted `ce-simplify-code` 3-lens pass (reuse / quality / efficiency) per unit |
| **Agents** | Pattern recognition (reuse), maintainability (quality), performance (efficiency) |
| **Related** | Complements [2026-07-13-dead-code-report.md](./2026-07-13-dead-code-report.md) (dead-code cleanup); this report focuses on **simplification** (dedupe, structure, efficiency) of live code |

### Fix log (2026-07-15)

Partial implementation of P0/P1 after the audit. **Net ~−280 lines** in `electron/src` (24 files). Verification: `npm run typecheck`, `npm run lint`, focused unit suites (~372 tests) passed.

| Status | IDs |
|--------|-----|
| **Fixed** | SIMP-U3-001, U3-002, U3-003, U9-002, U3-010, U3-011, U3-012, U3-014, U3-015, U3-016 (scope half), U2-010, U2-011, U7-010, U7-012 |
| **Partial** | SIMP-U7-011 (path resolve shared; RAG/AST IPC progress shells still twin), SIMP-U3-016 (not-found still copy-pasted) |
| **Open (deferred)** | U2-001 hydrate identity, U9-001 updater bridge, U3-013 glob→regex, U2-012 listManaged*, U4-*, U5-*, U6-*, U7-013, U8-*, U9-010, all P2/P3/Hold |

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

| Lens | Merged findings (approx.) | Dominant themes | Post-fix |
|------|---------------------------|-----------------|-----------|
| **Reuse** | ~40 raw → ~22 canonical | Atomic write/diff, RAG↔AST twin stacks, driver credential helpers, IPC bound-path, provider picker maps | Filesystem helpers + bound-path + flattenSessionMessages **done** |
| **Quality** | ~50 raw → ~20 canonical | Prototype pollution, dead middleware flags, dual config sources, god modules (chat IPC / useChat) | Grep prototype + dead locals/wrapper **done** |
| **Efficiency** | ~40 raw → ~18 canonical | Full-file tool I/O, session JSON rewrite, stream IPC fan-out, React stream re-renders, RAG vector write path | **Untouched** (still open) |

**Highest-value remaining clusters:**

1. ~~**Filesystem tool helpers**~~ — **done** (`atomicWrite` / `generateDiff` / binary detect shared via `tools/ast/utils`)  
2. **RAG/AST twin architecture** — shared walk/hash/worker/index-run controller  
3. **Provider driver boilerplate** — `apiKeyFor*`, OpenAI-compatible model factory, status JSON parsers, write locks, redact  
4. **RAG/AST IPC shells** — progress broadcast still twin; path resolve **done** via `resolveBoundProjectPath`  
5. **Stream hot path** — stop full `CHAT_STATE` per token; cache webContents; coalesce renderer updates  
6. **Session load amplification** — todos/subagents full-disk reloads on every refresh  

**Clean areas (no high-confidence simplification needed):**  
`shared/usage.ts`, `agent-scope.ts`, `provider.ts` contracts, `resolver.ts`, `catalog/trust.ts`, `accounting/cost.ts`, `message-factories.ts`, `interrupt-machine.ts`, `mcp/transport.ts`, `rag/chunker.ts`, `logging.ts`, `esm-import.ts`, session-activity push pattern, ToolRegistry WeakMap cache for builtins.

**Also cleaner after fix pass:** `tools/filesystem/edit.ts` / `write.ts` (thin handlers), `tools/search/grep.ts` (no prototype pollution), `ipc/{rag,ast,tool,defs,mcp}` bound-path path.

---

## Priority backlog

### P0 — safe clarity wins

| ID | Status | Summary | Paths | Lens |
|----|--------|---------|-------|------|
| [SIMP-U3-001](#simp-u3-001) | **Fixed** | Dead locals `_maxLen` / `_replacements` in edit | `tools/filesystem/edit.ts` | quality |
| [SIMP-U3-002](#simp-u3-002) | **Fixed** | Drop no-op `registerBuiltTool` wrapper | `tools/index.ts` | quality |
| [SIMP-U3-003](#simp-u3-003) | **Fixed** | Remove `String.prototype.rstrip` pollution in grep | `tools/search/grep.ts` | quality/reuse |
| [SIMP-U2-001](#simp-u2-001) | Open | `hydrateProjectRuntime` is async identity | `project/runtime.ts` | quality |
| [SIMP-U9-001](#simp-u9-001) | Open | Updater IPC/UI surface unused (bridge dead) | `updater.ts`, preload, ipc types | quality |
| [SIMP-U9-002](#simp-u9-002) | **Fixed** | `isAppSigned()` pass-through only | `updater.ts` | quality |

### P1 — reuse existing helpers / extract once

| ID | Status | Summary | Paths | Lens |
|----|--------|---------|-------|------|
| [SIMP-U3-010](#simp-u3-010) | **Fixed** | Single `atomicWrite` for edit/write/AST | tools filesystem + `ast/utils` | reuse |
| [SIMP-U3-011](#simp-u3-011) | **Fixed** | Single unified-diff / LCS stack | `edit.ts`, `ast/utils.ts` | reuse |
| [SIMP-U3-012](#simp-u3-012) | **Fixed** | Shared binary detection | `read.ts`, `grep.ts` | reuse |
| [SIMP-U3-013](#simp-u3-013) | Open | Shared glob→regex | `glob.ts`, `grep.ts` | reuse |
| [SIMP-U3-014](#simp-u3-014) | **Fixed** | `getToolConfig` in rag_search | `rag/search.ts` | reuse |
| [SIMP-U3-015](#simp-u3-015) | **Fixed** | Todo status parse once | `todo/update.ts`, `list.ts` | reuse/quality |
| [SIMP-U3-016](#simp-u3-016) | **Partial** | Background cmd tools: scope + not-found | process tools | reuse |
| [SIMP-U2-010](#simp-u2-010) | **Fixed** | `isPlainObject` in workspace sticky parse | `workspace.ts`, `merge.ts` | reuse |
| [SIMP-U2-011](#simp-u2-011) | **Fixed** | `mergeLayers` single apply-loop | `config/merge.ts` | reuse |
| [SIMP-U2-012](#simp-u2-012) | Open | Definition listManaged* generic | `defs/manage.ts` | reuse |
| [SIMP-U4-010](#simp-u4-010) | Open | Shared `apiKeyForDriver` / embedding | all drivers | reuse |
| [SIMP-U4-011](#simp-u4-011) | Open | Shared write-lock utility | connection-store, vault | reuse |
| [SIMP-U4-012](#simp-u4-012) | Open | Shared status JSON coerce + redact | lilac, neuralwatt, cache, accounting | reuse |
| [SIMP-U4-013](#simp-u4-013) | Open | OpenAI-compatible model factory | compatible drivers | quality |
| [SIMP-U6-010](#simp-u6-010) | Open | RAG↔AST: walk, hash, worker, run tracker | rag + ast indexers | reuse |
| [SIMP-U6-011](#simp-u6-011) | Open | Shared `withTimeout` | mcp manager, tool-dispatch | reuse |
| [SIMP-U6-012](#simp-u6-012) | Open | Shared `sleep` | ast indexer, retry, background-store | reuse |
| [SIMP-U7-010](#simp-u7-010) | **Fixed** | `resolveBoundProjectPath` for IPC | rag/ast/tool/defs/mcp | reuse |
| [SIMP-U7-011](#simp-u7-011) | **Partial** | RAG/AST IPC shell extract | `ipc/rag.ts`, `ipc/ast.ts` | reuse |
| [SIMP-U7-012](#simp-u7-012) | **Fixed** | Shared `flattenSessionMessages` | session IPC + ChatView | reuse |
| [SIMP-U7-013](#simp-u7-013) | Open | Preload `onEvent<T>` | `preload/index.ts` | reuse |
| [SIMP-U8-010](#simp-u8-010) | Open | Provider model picker maps hook | ChatView, TierModels, RAGTab | reuse |
| [SIMP-U9-010](#simp-u9-010) | Open | Shared seedDefaults for skills/agents | skills + agents registry | reuse |

### P2 — local quality

| ID | Summary | Paths | Lens |
|----|---------|-------|------|
| [SIMP-U1-020](#simp-u1-020) | Tighten stringly IPC/theme/chain types | shared types, commands | quality |
| [SIMP-U2-020](#simp-u2-020) | Drop Zod-duplicate checks in validateConfig | validation + schema | quality |
| [SIMP-U2-021](#simp-u2-021) | Stop mutating live config for sticky default | workspace.ts | quality |
| [SIMP-U3-020](#simp-u3-020) | Enum schemas for todo status / agent tier | todo, delegate | quality |
| [SIMP-U3-021](#simp-u3-021) | Options bag for `executeCommand` | execute-command.ts | quality |
| [SIMP-U5-020](#simp-u5-020) | Dead mid-stream flags in quirks/retry | middleware | quality |
| [SIMP-U5-021](#simp-u5-021) | Dual timeout exemption sources | tool-dispatch | quality |
| [SIMP-U5-022](#simp-u5-022) | BackgroundCommand.status ignored | build-prompt-context / system-prompt | quality |
| [SIMP-U5-023](#simp-u5-023) | MCP allowlist via ToolRegistry/minimatch | orchestrator | quality |
| [SIMP-U5-024](#simp-u5-024) | Prefer catalog over KNOWN_MODELS | model-metadata | quality |
| [SIMP-U7-020](#simp-u7-020) | chat-history named window but keyed by session | chat-history.ts | quality |
| [SIMP-U7-021](#simp-u7-021) | definitions IPC mutation helper | definitions.ts | quality |
| [SIMP-U7-022](#simp-u7-022) | Reuse ProviderDriverRegistry instance in IPC | providers.ts IPC | quality |
| [SIMP-U8-020](#simp-u8-020) | Dual theme/config ownership App vs ChatView | App, ChatView | quality |
| [SIMP-U8-021](#simp-u8-021) | Second useSession in ConfigView | ConfigView | quality |
| [SIMP-U8-022](#simp-u8-022) | IndexSection RAG/AST branch twin | Sidebar | reuse |

### P3 — efficiency (measure / characterize first)

| ID | Summary | Paths | Lens |
|----|---------|-------|------|
| [SIMP-U3-030](#simp-u3-030) | read: full-file + double open for binary check | read.ts | efficiency |
| [SIMP-U3-031](#simp-u3-031) | grep: unbounded path list; sync read; serial walk | grep.ts | efficiency |
| [SIMP-U3-032](#simp-u3-032) | edit: full LCS DP every edit; triple match scan | edit.ts | efficiency |
| [SIMP-U3-033](#simp-u3-033) | glob: up to 3× stat per path | glob.ts | efficiency |
| [SIMP-U3-034](#simp-u3-034) | write echoes full numbered body | write.ts | efficiency |
| [SIMP-U3-035](#simp-u3-035) | HeadTailBuffer concat-on-append | head-tail-buffer.ts | efficiency |
| [SIMP-U2-030](#simp-u2-030) | Full session JSON rewrite every chain update | session manager/storage | efficiency |
| [SIMP-U2-031](#simp-u2-031) | existsSync then open TOCTOU | session storage | efficiency |
| [SIMP-U4-030](#simp-u4-030) | Re-read providers.json every resolve | connection-store | efficiency |
| [SIMP-U4-031](#simp-u4-031) | Rebuild provider definitions every get | catalog store | efficiency |
| [SIMP-U5-030](#simp-u5-030) | Tool args stringify→parse roundtrip | orchestrator + tool-dispatch | efficiency |
| [SIMP-U5-031](#simp-u5-031) | zodToJsonSchema every context snapshot | context-snapshot | efficiency |
| [SIMP-U5-032](#simp-u5-032) | Agent machine string concat per chunk | agent-machine.ts | efficiency |
| [SIMP-U5-033](#simp-u5-033) | sendTurnEvent scans all WebContents | chat.ts IPC | efficiency |
| [SIMP-U6-030](#simp-u6-030) | MCP servers start sequentially | mcp/manager.ts | efficiency |
| [SIMP-U6-031](#simp-u6-031) | RAG vector write path materializes number[][] | rag store/indexer | efficiency |
| [SIMP-U6-032](#simp-u6-032) | AST ensureIndexed busy-poll sleep(100) | ast/indexer.ts | efficiency |
| [SIMP-U7-030](#simp-u7-030) | CHAT_STATE every snapshot tick with full response | chat.ts | efficiency |
| [SIMP-U8-030](#simp-u8-030) | Stream: dual setState per chunk; no rAF coalesce | useChat.ts | efficiency |
| [SIMP-U8-031](#simp-u8-031) | 100ms elapsed ticker invalidates history memo | useChat, ChatStream | efficiency |
| [SIMP-U8-032](#simp-u8-032) | Todos/subagents full session.load peeks | useTodos, useSubagents | efficiency |
| [SIMP-U8-033](#simp-u8-033) | Triple full session load on select | ChatView + hooks | efficiency |
| [SIMP-U8-034](#simp-u8-034) | Live markdown reparse every token | MessageWidget | efficiency |
| [SIMP-U8-035](#simp-u8-035) | bgCmd 200ms poll vs push | useLiveCommandOutput | efficiency |

### Hold — high behavior risk / weak isolation

| ID | Why hold |
|----|----------|
| [SIMP-HOLD-001](#simp-hold-001) | Split chat.ts / useChat / ChatStream god modules — large behavior surface |
| [SIMP-HOLD-002](#simp-hold-002) | StreamChatParams / ActiveAgent restructuring — cross-process contracts |
| [SIMP-HOLD-003](#simp-hold-003) | Require frozen turn config only (drop getConfig fallbacks) — may break edge call paths |
| [SIMP-HOLD-004](#simp-hold-004) | Dual toolCall/result capture (fullStream + onStepFinish) — stream correctness |
| [SIMP-HOLD-005](#simp-hold-005) | URL validation unify across vault/compatible/catalog — security-sensitive |

---

## Findings (canonical)

### SIMP-U3-001

- **Status:** **Fixed** (2026-07-15) — dead locals removed with edit rewrite onto shared helpers  
- **Lens / class / risk / confidence:** quality / dead-code / low / 100  
- **Paths:** `electron/src/main/tools/filesystem/edit.ts`  
- **Summary:** Unused locals `_maxLen` and `_replacements` are computed and never read.  
- **Suggestion:** Delete both assignments.  
- **Resolution:** Locals gone; edit handler uses shared `atomicWrite` / `generateDiff`.  
- **Unit:** U3  

### SIMP-U3-002

- **Status:** **Fixed** (2026-07-15) — direct `registry.register(...)`  
- **Lens / class / risk / confidence:** quality / other / low / 95  
- **Paths:** `electron/src/main/tools/index.ts`  
- **Summary:** `registerBuiltTool` is a one-line pass-through to `registry.register`.  
- **Suggestion:** Call `registry.register` directly.  
- **Unit:** U3  

### SIMP-U3-003

- **Status:** **Fixed** (2026-07-15) — inline `.replace(/\s+$/, '')`; prototype extension removed  
- **Lens / class / risk / confidence:** quality+reuse / leaky-abstraction / medium / 98  
- **Paths:** `electron/src/main/tools/search/grep.ts`  
- **Summary:** Grep patches `String.prototype.rstrip` globally for one format line.  
- **Suggestion:** Local `rstrip(s)` or `s.replace(/\s+$/, '')`; remove prototype extension.  
- **Unit:** U3  

### SIMP-U2-001

- **Status:** Open (deferred — call sites/tests still treat as compatibility hook)  
- **Lens / class / risk / confidence:** quality / dead-code / low / 90  
- **Paths:** `electron/src/main/project/runtime.ts`  
- **Summary:** `hydrateProjectRuntime` is `async (runtime) => runtime`.  
- **Suggestion:** Remove helper and call sites, or implement real hydration when needed.  
- **Unit:** U2  

### SIMP-U9-001

- **Status:** Open (product choice: wire UI vs drop bridge)  
- **Lens / class / risk / confidence:** quality / dead-code / low / 94  
- **Paths:** `electron/src/main/updater.ts`, `electron/src/preload/index.ts`, `electron/src/shared/types/ipc.ts`  
- **Summary:** Updater emits events and exports download/install APIs with no preload/renderer consumer (also noted in dead-code report).  
- **Suggestion:** Wire UI **or** drop unused public bridge until a consumer exists; keep headless check if desired.  
- **Unit:** U9  

### SIMP-U9-002

- **Status:** **Fixed** (2026-07-15) — call site uses `isSigned` directly; helper removed  
- **Lens / class / risk / confidence:** quality / other / low / 90  
- **Paths:** `electron/src/main/updater.ts`  
- **Summary:** `isAppSigned()` only returns module-level `isSigned`.  
- **Suggestion:** Inline flag or implement real detection.  
- **Unit:** U9  

### SIMP-U3-010

- **Status:** **Fixed** (2026-07-15) — `atomicWrite` from `tools/ast/utils` (mkdir + mode preserve); edit/write import it  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 95  
- **Paths:** `tools/filesystem/edit.ts`, `tools/filesystem/write.ts`, `tools/ast/utils.ts`  
- **Summary:** Three near-identical `atomicWrite` (tmp + fsync + rename + parent fsync).  
- **Suggestion:** Keep one export (prefer `ast/utils` or a tiny `tools/fs-atomic.ts`) and import everywhere.  
- **Unit:** U3  

### SIMP-U3-011

- **Status:** **Fixed** (2026-07-15) — edit imports `generateDiff` / `countDiffChanges` from `ast/utils`  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 95  
- **Paths:** `tools/filesystem/edit.ts`, `tools/ast/utils.ts`  
- **Summary:** LCS unified-diff + `countDiffChanges` duplicated.  
- **Suggestion:** Single `generateDiff` / `countDiffChanges` import in edit.  
- **Unit:** U3  

### SIMP-U3-012

- **Status:** **Fixed** (2026-07-15) — `isBinaryFileSync` / `isBinaryFile` in `ast/utils`; read + grep use them  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 92  
- **Paths:** `tools/filesystem/read.ts`, `tools/search/grep.ts`  
- **Summary:** 8KB null-byte binary detection twice (sync vs async).  
- **Suggestion:** Shared `isBinaryFile` (sync + async wrappers).  
- **Unit:** U3  

### SIMP-U3-013

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / medium / 85  
- **Paths:** `tools/filesystem/glob.ts`, `tools/search/grep.ts`  
- **Summary:** Separate glob→regex converters for `*` / `?`.  
- **Suggestion:** One helper or use existing `minimatch` dependency.  
- **Unit:** U3  

### SIMP-U3-014

- **Status:** **Fixed** (2026-07-15) — `getToolConfig(ctx)`  
- **Lens / class / risk / confidence:** reuse / inline-could-use-util / low / 95  
- **Paths:** `tools/rag/search.ts`, `tools/types.ts`  
- **Summary:** rag_search inlines `projectRuntime?.config ?? getConfig()` instead of `getToolConfig(ctx)`.  
- **Suggestion:** Call `getToolConfig(ctx)`.  
- **Unit:** U3  

### SIMP-U3-015

- **Status:** **Fixed** (2026-07-15) — `parseTodoStatus` in `shared/types/todo.ts`; used by update/list. Schema still free `z.string()` (optional follow-up: `z.nativeEnum`)  
- **Lens / class / risk / confidence:** reuse+quality / near-duplicate+stringly / low / 93  
- **Paths:** `tools/todo/update.ts`, `tools/todo/list.ts`  
- **Summary:** Status uppercasing + `TodoStatus` membership copy-pasted; schemas use free `z.string()`.  
- **Suggestion:** `parseTodoStatus` + `z.nativeEnum(TodoStatus)`.  
- **Unit:** U3  

### SIMP-U3-016

- **Status:** **Partial** — `normalizeAgentScopeId` applied; not-found error blocks still duplicated  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 88  
- **Paths:** `tools/process/read-output.ts`, `send-input.ts`, `terminate-command.ts`, `shared/types/agent-scope.ts`  
- **Summary:** Hardcoded `agentScopeId ?? 'main'` and identical not-found error blocks.  
- **Suggestion:** `normalizeAgentScopeId` + shared `notFoundResult(id)`.  
- **Unit:** U3  

### SIMP-U2-010

- **Status:** **Fixed** (2026-07-15) — `isPlainObject` from `config/merge`  
- **Lens / class / risk / confidence:** reuse / inline-could-use-util / low / 90  
- **Paths:** `project/workspace.ts`, `config/merge.ts`  
- **Summary:** Sticky-default JSON parse reimplements plain-object check.  
- **Suggestion:** Import `isPlainObject` from `config/merge`.  
- **Unit:** U2  

### SIMP-U2-011

- **Status:** **Fixed** (2026-07-15) — `applyLayerOverrides(merged, layer)` for home + project  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 88  
- **Paths:** `config/merge.ts`  
- **Summary:** `mergeLayers` home and project loops are nearly identical.  
- **Suggestion:** `applyLayerOverrides(merged, layer)` once per layer.  
- **Unit:** U2  

### SIMP-U2-012

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 80  
- **Paths:** `defs/manage.ts`  
- **Summary:** listManaged skills/agents/personalities share global+project merge skeleton.  
- **Suggestion:** Generic `listScopedEntries` / `listDefinitionEntries`.  
- **Unit:** U2  

### SIMP-U4-010

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 96  
- **Paths:** `providers/drivers/{native,compatible,opencode-go,neuralwatt,lilac}.ts`  
- **Summary:** `apiKeyForDriver` / embedding / lilac variants copy-pasted with inconsistent empty-key behavior.  
- **Suggestion:** Shared `requireApiKey` / `optionalApiKey` on `DriverCredential`.  
- **Unit:** U4  

### SIMP-U4-011

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / medium / 94  
- **Paths:** `providers/connection-store.ts`, `providers/credentials/vault.ts`  
- **Summary:** Promise-chain write locks duplicated.  
- **Suggestion:** `withSerializedWrite(filePath, task)`.  
- **Unit:** U4  

### SIMP-U4-012

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 91  
- **Paths:** lilac, neuralwatt, `providers/index.ts`, status cache, accounting store  
- **Summary:** record/finiteNumber parsers and sensitive-key redaction trees duplicated.  
- **Suggestion:** Shared status parse helpers + `redactSensitiveValue`.  
- **Unit:** U4  

### SIMP-U4-013

- **Status:** Open  
- **Lens / class / risk / confidence:** quality / copy-paste / low / 88  
- **Paths:** compatible, lilac, neuralwatt, opencode-go drivers  
- **Summary:** OpenAI-compatible `LanguageModel` construction repeated (importESM + createOpenAICompatible + unwrapping fetch).  
- **Suggestion:** `createOpenAICompatibleModel({ name, baseURL, apiKey, modelId })`.  
- **Unit:** U4  

### SIMP-U6-010

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low–medium / 90–95  
- **Paths:** `rag/indexer.ts`, `ast/indexer.ts`, index-workers  
- **Summary:** Twin stacks for `readAndHash`, worker lifecycle, activeIndexes tracker, directory walk/skip dirs, worker bootstrap.  
- **Suggestion:** Shared walk/hash/worker-run-controller; domain filters stay local.  
- **Unit:** U6  

### SIMP-U6-011

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / inline-could-use-util / medium / 93  
- **Paths:** `mcp/manager.ts`, `llm/tool-dispatch.ts`  
- **Summary:** Private `_withTimeout` reimplements exported `withTimeout`.  
- **Suggestion:** Share one timeout helper under `main/utils` or import tool-dispatch export.  
- **Unit:** U6  

### SIMP-U6-012

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 85  
- **Paths:** `ast/indexer.ts`, `llm/middleware/retry.ts`, `tools/process/background-store.ts`  
- **Summary:** Local `sleep(ms)` wrappers.  
- **Suggestion:** Single `main/utils/async.ts` `sleep`.  
- **Unit:** U6  

### SIMP-U7-010

- **Status:** **Fixed** (2026-07-15) — `resolveBoundProjectPath` in `ipc/session.ts`; used by rag/ast/tool/defs/mcp  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 96  
- **Paths:** `ipc/rag.ts`, `ast.ts`, `definitions.ts`, `tool.ts`, `mcp.ts`, `project/workspace.ts`  
- **Summary:** Bound project resolve reimplemented per IPC module.  
- **Suggestion:** Export `resolveBoundProjectPath(windowId)` beside `resolveWindowWorkspace`.  
- **Unit:** U7  

### SIMP-U7-011

- **Status:** **Partial** — path resolve shared; progress broadcast + empty shells still twin modules  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 95  
- **Paths:** `ipc/rag.ts`, `ipc/ast.ts`  
- **Summary:** Near-copy IPC modules (path, progress broadcast, empty shells, force schema).  
- **Suggestion:** Shared bound-path + progress helpers; domain status/index only in each file.  
- **Unit:** U7  

### SIMP-U7-012

- **Status:** **Fixed** (2026-07-15) — `flattenSessionMessages` in `shared/types/session.ts`; main re-exports; ChatView imports  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 98  
- **Paths:** `ipc/session.ts`, `renderer/components/ChatView.tsx`  
- **Summary:** Identical `chains.flatMap(c => [...c.messages])`.  
- **Suggestion:** Shared `flattenSessionMessages` in `shared/`.  
- **Unit:** U7  

### SIMP-U7-013

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 88  
- **Paths:** `preload/index.ts`  
- **Summary:** Dozens of `on(channel, args[0] as T)` wrappers.  
- **Suggestion:** `onEvent<T>(channel, cb)`.  
- **Unit:** U7  

### SIMP-U8-010

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 93  
- **Paths:** ChatView, TierModelsTab, RAGTab, `provider-selection.ts`, `models.ts`  
- **Summary:** modelList fetch, providers-updated, key/label/detail maps rebuilt three times.  
- **Suggestion:** Hook/builder using existing `providerModelOptionKey` / modality filters.  
- **Unit:** U8  

### SIMP-U9-010

- **Status:** Open  
- **Lens / class / risk / confidence:** reuse / duplicate-helper / low / 90  
- **Paths:** `skills/registry.ts`, `agents/registry.ts`  
- **Summary:** `seedDefaults` subdir copy-if-missing duplicated (SKILL.md vs AGENT.md).  
- **Suggestion:** Shared `seedDefaultSubdirs(source, target, filename)`.  
- **Unit:** U9  

### SIMP-U1-020

- **Lens / class / risk / confidence:** quality / stringly-typed / low / 78–85  
- **Paths:** `shared/types/chain.ts`, `subagent.ts`, `ipc.ts`, `commands.ts`, `ipc-boundary.ts`  
- **Summary:** Plain `string` where `AgentType`/`AgentTier`/`ChatSnapshotState`/`THEME_NAMES` exist; CommandContext still has string model APIs.  
- **Suggestion:** Tighten types at boundaries without changing runtime wire format first.  
- **Unit:** U1  

### SIMP-U2-020

- **Lens / class / risk / confidence:** quality / copy-paste / low / 82  
- **Paths:** `config/validation.ts`, `config/schema.ts`  
- **Summary:** validateConfig re-checks ranges Zod already enforces.  
- **Suggestion:** Keep cross-field rules only.  
- **Unit:** U2  

### SIMP-U2-021

- **Lens / class / risk / confidence:** quality / leaky-abstraction / medium / 85  
- **Paths:** `project/workspace.ts`  
- **Summary:** Sticky default mutates live `getConfig()` object in place.  
- **Suggestion:** Write home file + reload/reset; treat config as immutable.  
- **Unit:** U2  

### SIMP-U3-020

- **Lens / class / risk / confidence:** quality / stringly-typed / low / 85–90  
- **Paths:** todo tools, `subagent/delegate.ts`  
- **Summary:** Free strings then manual enum validation for status/tier.  
- **Suggestion:** `z.nativeEnum` at schema boundary.  
- **Unit:** U3  

### SIMP-U3-021

- **Lens / class / risk / confidence:** quality / parameter-sprawl / low / 88  
- **Paths:** `tools/process/execute-command.ts`  
- **Summary:** Seven positional args + options bag.  
- **Suggestion:** Single options object.  
- **Unit:** U3  

### SIMP-U5-020

- **Lens / class / risk / confidence:** quality / dead-code / medium / 90–92  
- **Paths:** `llm/middleware/provider-quirks.ts`, `retry.ts`  
- **Summary:** Mid-stream `hasReceivedContent` / `contentDelivered` guards are structurally unreachable for stream-body errors (catch only wraps `doStream` open).  
- **Suggestion:** Fix stream error path or delete misleading flags; document open-only retry/quirks.  
- **Unit:** U5  

### SIMP-U5-021

- **Lens / class / risk / confidence:** quality / redundant-state / low / 85  
- **Paths:** `llm/tool-dispatch.ts`  
- **Summary:** Timeout exemption dual-sourced (`TOOLS_WITHOUT_TIMEOUT` names + `definition.noTimeout`).  
- **Suggestion:** Prefer definition flag only.  
- **Unit:** U5  

### SIMP-U5-022

- **Lens / class / risk / confidence:** quality / redundant-state / low / 90  
- **Paths:** `llm/build-prompt-context.ts`, `system-prompt.ts`  
- **Summary:** Background command `status` computed then ignored; system-prompt re-derives from exitCode.  
- **Suggestion:** Single source of truth for status field.  
- **Unit:** U5  

### SIMP-U5-023

- **Lens / class / risk / confidence:** quality / copy-paste / medium / 88  
- **Paths:** `llm/orchestrator.ts`, `tools/registry.ts`  
- **Summary:** MCP allowlist uses weaker ad-hoc regex vs ToolRegistry/minimatch for builtins.  
- **Suggestion:** Shared allowed-tools matcher.  
- **Unit:** U5  

### SIMP-U5-024

- **Lens / class / risk / confidence:** quality / leaky-abstraction / medium / 80  
- **Paths:** `llm/model-metadata.ts`, catalog schema  
- **Summary:** Hard-coded `KNOWN_MODELS` drifts from signed catalog limits.  
- **Suggestion:** Prefer catalog EffectiveModel; KNOWN_MODELS last resort only.  
- **Unit:** U5  

### SIMP-U7-020

- **Lens / class / risk / confidence:** quality / leaky-abstraction / low / 92  
- **Paths:** `ipc/chat-history.ts`  
- **Summary:** Named/documented per-window but keyed by sessionId.  
- **Suggestion:** Rename to session chat history API.  
- **Unit:** U7  

### SIMP-U7-021

- **Lens / class / risk / confidence:** quality / copy-paste / low / 90  
- **Paths:** `ipc/definitions.ts`  
- **Summary:** Six save/delete handlers share parse→mutate→reload skeleton.  
- **Suggestion:** `withDefinitionMutation` helper.  
- **Unit:** U7  

### SIMP-U7-022

- **Lens / class / risk / confidence:** quality / other / low / 85  
- **Paths:** `ipc/providers.ts`  
- **Summary:** `services()` builds a fresh `ProviderDriverRegistry` every IPC call.  
- **Suggestion:** Reuse process-wide registry from ProviderRuntime.  
- **Unit:** U7  

### SIMP-U8-020

- **Lens / class / risk / confidence:** quality / redundant-state / low / 82  
- **Paths:** `renderer/App.tsx`, `ChatView.tsx`  
- **Summary:** Theme/config loaded in App and again in ChatView.  
- **Suggestion:** Lift to context or pass from App.  
- **Unit:** U8  

### SIMP-U8-021

- **Lens / class / risk / confidence:** quality / redundant-state / low / 84  
- **Paths:** `ConfigView.tsx`, `ChatView.tsx`  
- **Summary:** ConfigView mounts second `useSession()` while ChatView already has one.  
- **Suggestion:** Pass workspace props / shared session context.  
- **Unit:** U8  

### SIMP-U8-022

- **Lens / class / risk / confidence:** reuse / near-duplicate / low / 86  
- **Paths:** `renderer/components/Sidebar.tsx`  
- **Summary:** IndexSection RAG vs AST progress/runIndex nearly line-for-line.  
- **Suggestion:** Parameterized indexer controller.  
- **Unit:** U8  

### SIMP-U3-030

- **Lens / class / risk / confidence:** efficiency / overly-broad+unnecessary-work / low / 88–92  
- **Paths:** `tools/filesystem/read.ts`  
- **Summary:** Full-file read+split for offset/limit window; binary peek then full re-open.  
- **Suggestion:** Stream/line-scan window; single fd for peek+read.  
- **Unit:** U3  

### SIMP-U3-031

- **Lens / class / risk / confidence:** efficiency / memory+hot-path / medium / 78–90  
- **Paths:** `tools/search/grep.ts`  
- **Summary:** Collects all paths before search; serial walk; sync full-file search; timeout cannot interrupt sync work.  
- **Suggestion:** Incremental walk+search; async I/O or spawn ripgrep.  
- **Unit:** U3  

### SIMP-U3-032

- **Lens / class / risk / confidence:** efficiency / hot-path / low / 82–88  
- **Paths:** `tools/filesystem/edit.ts`  
- **Summary:** Full-file LCS DP for every edit display; multi-pass match count.  
- **Suggestion:** Local hunks / linear diff; single-pass count.  
- **Unit:** U3  

### SIMP-U3-033

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 86  
- **Paths:** `tools/filesystem/glob.ts`  
- **Summary:** Stat during walk, sort, and format (up to 3×).  
- **Suggestion:** Capture mtime/type once in walk records.  
- **Unit:** U3  

### SIMP-U3-034

- **Lens / class / risk / confidence:** efficiency / overly-broad / low / 84  
- **Paths:** `tools/filesystem/write.ts`  
- **Summary:** Tool result echoes full numbered file body.  
- **Suggestion:** Path + line count (+ optional head/tail).  
- **Unit:** U3  

### SIMP-U3-035

- **Lens / class / risk / confidence:** efficiency / memory / low / 88  
- **Paths:** `tools/process/head-tail-buffer.ts`  
- **Summary:** `Buffer.concat` on every append under high output.  
- **Suggestion:** Chunk list / circular buffers; concat on snapshot.  
- **Unit:** U3  

### SIMP-U2-030

- **Lens / class / risk / confidence:** efficiency / hot-path / medium / 87  
- **Paths:** `session/manager.ts`, `session/storage.ts`  
- **Summary:** Chain updates rewrite entire session JSON atomically every time.  
- **Suggestion:** Debounce mid-turn; or segmented/append-friendly storage.  
- **Unit:** U2  

### SIMP-U2-031

- **Lens / class / risk / confidence:** efficiency / toctou / low / 80  
- **Paths:** `session/storage.ts`  
- **Summary:** `existsSync` then open/unlink.  
- **Suggestion:** Operate and treat ENOENT as not-found.  
- **Unit:** U2  

### SIMP-U4-030

- **Lens / class / risk / confidence:** efficiency / hot-path / low / 92  
- **Paths:** `providers/connection-store.ts`, `providers/index.ts`  
- **Summary:** Every resolve re-reads and parses `providers.json`.  
- **Suggestion:** In-memory snapshot invalidated on write.  
- **Unit:** U4  

### SIMP-U4-031

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 90  
- **Paths:** `providers/catalog/store.ts`  
- **Summary:** `getProviderDefinitions` rebuilds via Zod map every call.  
- **Suggestion:** Cache derived view with catalog snapshot.  
- **Unit:** U4  

### SIMP-U5-030

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 88  
- **Paths:** `llm/orchestrator.ts`, `tool-dispatch.ts`  
- **Summary:** Tool execute stringifies args then parses again.  
- **Suggestion:** Pass parsed args through dispatch API.  
- **Unit:** U5  

### SIMP-U5-031

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 80–84  
- **Paths:** `llm/context-snapshot.ts`, `tools/registry.ts`  
- **Summary:** `zodToJsonSchema` per tool on every context snapshot.  
- **Suggestion:** Cache schema lengths at tool-map build.  
- **Unit:** U5  

### SIMP-U5-032

- **Lens / class / risk / confidence:** efficiency / hot-path / low / 86  
- **Paths:** `agents/xstate/agent-machine.ts`  
- **Summary:** Immutable string concatenation on every CHUNK/THINKING.  
- **Suggestion:** Chunk array + join on end; or mutate accumulator.  
- **Unit:** U5  

### SIMP-U5-033

- **Lens / class / risk / confidence:** efficiency / hot-path / medium / 91  
- **Paths:** `ipc/chat.ts`  
- **Summary:** Every stream event scans `getAllWebContents` + session ownership.  
- **Suggestion:** Session→WebContents subscriber map or cache on ActiveAgent.  
- **Unit:** U5/U7  

### SIMP-U6-030

- **Lens / class / risk / confidence:** efficiency / missed-concurrency / medium / 83  
- **Paths:** `mcp/manager.ts`  
- **Summary:** MCP servers connect sequentially.  
- **Suggestion:** Bounded parallel connect under overall timeout.  
- **Unit:** U6  

### SIMP-U6-031

- **Lens / class / risk / confidence:** efficiency / memory / medium / 88  
- **Paths:** `rag/store.ts`, `rag/indexer.ts`  
- **Summary:** Index write path materializes full `number[][]` and per-file splice rebuilds.  
- **Suggestion:** Float32 matrix / compact once at flush (search path already better).  
- **Unit:** U6  

### SIMP-U6-032

- **Lens / class / risk / confidence:** efficiency / other / low / 81  
- **Paths:** `ast/indexer.ts`  
- **Summary:** `ensureIndexed` busy-waits with `sleep(100)`.  
- **Suggestion:** Single-flight Promise per project key.  
- **Unit:** U6  

### SIMP-U7-030

- **Lens / class / risk / confidence:** efficiency / hot-path / low / 95  
- **Paths:** `ipc/chat.ts`  
- **Summary:** Actor subscribe emits full `CHAT_STATE` (including full response) every snapshot tick while chunks already stream.  
- **Suggestion:** Emit CHAT_STATE on discrete transitions only; chunks for incremental text.  
- **Unit:** U7  

### SIMP-U8-030

- **Lens / class / risk / confidence:** efficiency / hot-path / low / 92  
- **Paths:** `renderer/hooks/useChat.ts`  
- **Summary:** Each CHAT_CHUNK does dual React updates (content + full segments copy) without rAF coalesce.  
- **Suggestion:** Ref accumulate; flush ≤1/frame.  
- **Unit:** U8  

### SIMP-U8-031

- **Lens / class / risk / confidence:** efficiency / hot-path+no-op / low / 90–91  
- **Paths:** `useChat.ts`, `ChatStream.tsx`  
- **Summary:** 100ms elapsed ticker re-renders shell; history memo deps include `elapsedSeconds` despite “stable history” comment.  
- **Suggestion:** 1s footer-local tick; drop elapsed from history deps.  
- **Unit:** U8  

### SIMP-U8-032

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / medium / 94  
- **Paths:** `useTodos.ts`, `useSubagents.ts`, session manager/IPC  
- **Summary:** Refresh via `session.load(activate:false)` always full disk parse; ignores live cache.  
- **Suggestion:** Peek IPC from SessionManager cache or push partial payloads.  
- **Unit:** U8  

### SIMP-U8-033

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / low / 88  
- **Paths:** ChatView, useTodos, useSubagents  
- **Summary:** Session select loads full session thrice (chat + todos + subagents).  
- **Suggestion:** Hydrate hooks from first load payload.  
- **Unit:** U8  

### SIMP-U8-034

- **Lens / class / risk / confidence:** efficiency / hot-path / low / 86  
- **Paths:** `MessageWidget.tsx`, `MarkdownContent.tsx`  
- **Summary:** Full markdown+highlight parse every streaming content change.  
- **Suggestion:** Plain/pre during stream; MarkdownContent on commit.  
- **Unit:** U8  

### SIMP-U8-035

- **Lens / class / risk / confidence:** efficiency / missed-concurrency / medium / 84  
- **Paths:** `useLiveCommandOutput.ts`, chat IPC  
- **Summary:** 200ms IPC poll for bg command UI while main owns live buffers.  
- **Suggestion:** Push tail/exit events; poll as fallback.  
- **Unit:** U8  

### SIMP-HOLD-001

- **Lens / class / risk / confidence:** quality / other / medium / 83–88  
- **Paths:** `ipc/chat.ts` (~1.7k), `useChat.ts` (~1k), `ChatStream.tsx` (~1.2k)  
- **Summary:** God-module splits recommended but high regression surface.  
- **Suggestion:** Future multi-PR extract with characterization tests first.  
- **Unit:** U7/U8  

### SIMP-HOLD-002

- **Lens / class / risk / confidence:** quality / parameter-sprawl / low–medium / 74–88  
- **Paths:** `StreamChatParams`, `ActiveAgent`  
- **Summary:** Large parameter/state bags; regrouping is design work.  
- **Unit:** U5/U7  

### SIMP-HOLD-003

- **Lens / class / risk / confidence:** quality / other / medium / 80  
- **Paths:** execute-command, grep, rag_search  
- **Summary:** Dropping silent `getConfig()` fallbacks requires frozen context everywhere.  
- **Unit:** U3  

### SIMP-HOLD-004

- **Lens / class / risk / confidence:** efficiency / unnecessary-work / medium / 76  
- **Paths:** `llm/orchestrator.ts`  
- **Summary:** Dual tool event capture (fullStream + onStepFinish) may be correctness scaffolding.  
- **Unit:** U5  

### SIMP-HOLD-005

- **Lens / class / risk / confidence:** reuse / near-duplicate / medium / 80  
- **Paths:** vault, compatible driver, catalog updater  
- **Summary:** URL origin validation three ways — unify carefully (security).  
- **Unit:** U4  

---

## Cross-cutting themes

1. **Twin systems** — RAG vs AST (indexers, workers, IPC, Sidebar UI) still the largest open structural win. ~~Edit vs AST atomic write/diff~~ **consolidated**.  
2. **Provider stack boilerplate** — credential helpers, OpenAI-compatible construction, status parse, redact, write locks (**open**).  
3. **Config / tool context dual sources** — rag_search now uses `getToolConfig`; other tools may still mix `getConfig()` fallbacks.  
4. **Stream amplification** — main accumulates full response, emits full CHAT_STATE, scans all windows; renderer dual-writes state and re-markdowns every token (**open**).  
5. **Session I/O amplification** — full JSON rewrite on chain updates; multiple full loads for sidebar widgets (**open**).  
6. **Stringly boundaries** — `parseTodoStatus` added; many schemas/types still free strings.  
7. **Dead / no-op residue** — hydrate identity + updater UI bridge remain; ~~registerBuiltTool, unused edit locals, isAppSigned pass-through, grep prototype~~ **cleared**.  

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
| useSessionActivity push merge | Good pattern to copy for todos/subagents |
| `logging.ts`, `esm-import.ts` | Minimal |
| `tools/filesystem/edit.ts`, `write.ts` (post-fix) | Thin handlers over shared `ast/utils` |
| `shared/types/session.ts` `flattenSessionMessages` | Shared main + renderer history flatten |

---

## Method notes

- **Audit phase:** 3-lens parallel review, report-only (no patches).  
- **Fix phase (same day):** Selected P0/P1 applied with typecheck + lint + focused unit tests.  
- **Subagent mapping:** Reuse → `ce-pattern-recognition-specialist`; Quality → `ce-maintainability-reviewer`; Efficiency → `ce-performance-reviewer`.  
- **U7–U9 reuse** was re-run after an initial cancelled dispatch.  
- Raw agent IDs were unit-local (`temp-reuse-NNN` etc.); this document renumbers to stable `SIMP-*` IDs.  
- Findings overlapping the 2026-07-13 dead-code report are cross-referenced rather than re-litigated as new dead code.  

---

## Recommended future fix batches (remaining)

| Batch | Scope | Suggested skill | Notes |
|-------|--------|-----------------|-------|
| A′ | Remaining P0: hydrate identity + updater bridge product decision | `ce-work` | Small |
| B′ | glob→regex share; process notFound helper; todo `z.nativeEnum` | `ce-simplify-code` / `ce-work` | Finish partials |
| C′ | RAG/AST IPC progress shell + preload `onEvent` | `ce-work` | Bound-path + flatten **done** |
| D | Provider driver/auth/status/redact/write-lock helpers | `ce-work` | Open |
| E | RAG/AST shared indexer infrastructure | plan first — medium risk | Open |
| F | Stream path (CHAT_STATE, webContents cache, useChat rAF, elapsed deps, markdown defer) | `ce-work` + browser feel checks | Open |
| G | Session peek APIs for todos/subagents + reduce triple-load | `ce-work` | Open |

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

*End of report. No code was modified by this review.*
