# Dead Code Investigation Report

**Date:** 2026-07-13
**Branch:** `feat/provider-system-refactor`
**Scope:** `electron/src/**`, `electron/scripts/**`, `electron/package.json`, `electron/package-lock.json`, and related tests/config
**Mode:** Investigation plus serial cleanup; each verified removal is recorded in the Fix log
**Verified against:** `cbb14b1` (`feat/provider-system-refactor`) after direct production-reachability review

## Method

| Layer | Source |
|-------|--------|
| Mechanical | `npx knip` (files, exports, types, deps) + `npx depcheck` |
| Verification | Direct import/call-site tracing from Electron main, preload, renderer, worker, Vite, and package-script entry points |
| Agent A | Main process (config, defs, session, project, rag, ast, mcp, personality, …) |
| Agent B | Tools / agents / skills / commands / XState |
| Agent C | Providers / LLM |
| Agent D | IPC + preload bridge |
| Agent E | Renderer UI |
| Agent F | Shared types + package.json deps |

**Confidence:** high = no production reachability; medium = test-only / dual-path / optional API; low = speculative.

---

## Executive summary

| Cluster | Confidence | Scale | Disposition (non-binding) |
|---------|------------|-------|---------------------------|
| **ToolRail + Monaco/xterm widgets** (unmounted UI island) | high | 9 TS/TSX files + ~626 CSS lines + 3 deps | wire up **or** remove |
| **XState legacy:** `toolExecuting`, `sessionMachine`, `subagentMachine` | high | 2 whole machines + dead state | archive/remove if SubagentManager is permanent |
| **IPC:** `agent:list` / `agent:spawn` entire stack | high | 1 module + preload + types | remove |
| **Updater UI bridge** (main still runs headless) | high | preload/IPC surface | wire banner **or** drop bridge |
| **Migration residue:** keychain, runtime config, project layers apply | high | several modules | remove / finish migration |
| **LLM:** `cleanup.ts`, unused error class zoo | high | 1 module + exports | remove / consolidate |
| **Shared Zod schemas + selected storage serializers** unused | high | many exports | remove only verified subset; preserve live session persistence |
| **Barrels** never imported | high | many `index.ts` | remove or use consistently |
| Knip “unused files” that are **false positives** | — | workers, preload entry, theme CSS | **do not remove** |

**No unregistered built-in tools.** All 27 tools and all agent/skill default packs are discoverable/registered.

## Verification update — current code

The original findings were rechecked against the current production entry points. The report is substantially correct, but the word "dead" covers several different cases:

- **Production-dead:** no path from a shipped entry point reaches the code.
- **Test-only:** reachable from tests but not from the shipped application.
- **Unused export:** the containing module may be live; only the named export is unused.
- **Resolved:** the code was removed after the report was generated.
- **Live / false positive:** reached through a build entry, dynamic path, worker, or runtime discovery.

Absence claims below were verified with repository-wide symbol/import searches in `electron/src` and then checked against tests and build scripts. Line numbers refer to `cbb14b1`.

### Verified disposition and evidence

### Fix log

| Issue | Change | Verification |
|-------|--------|--------------|
| B-07 | Removed the unreferenced `toolError`, `toolSuccess`, and their unused `StructuredToolResult` return type from `electron/src/main/tools/result.ts`. | Repository-wide symbol search found no remaining exact references; `cd electron && npm run typecheck` passed. |
| D-07 | Removed the unreferenced `DiscoveredModel` interface from `electron/src/shared/types/ipc-boundary.ts` and its barrel re-export from `shared/types/ipc.ts`. | Repository-wide symbol search found no remaining exact references; `cd electron && npm run typecheck` passed. |
| B-06 / E-09 / F-10 | Removed the production-dead `electron/src/main/commands/registry.ts`; updated parity/integration tests to exercise the live renderer registry instead. | No `main/commands/registry` references remain; the two command test files pass (70 tests), and `cd electron && npm run typecheck` passed. |
| D-01–D-03 / D-06 | Removed the obsolete `agent:list` / `agent:spawn` main IPC handler, preload methods, shared payload/result types, channel constants, and allowlist entries; retained live `agent.save` / `agent.delete`. | No obsolete agent IPC symbols or references remain; `cd electron && npm test -- --run tests/integration/app-shell.test.ts` passed (44 tests), and `cd electron && npm run typecheck` passed. |
| C-01 / C-12 | Removed the test-only `electron/src/main/llm/cleanup.ts` module and its dedicated cleanup tests; retained the live restore reconciliation in `shared/types/chain.ts`. | No obsolete cleanup symbols or imports remain; `cd electron && npm test -- --run tests/unit/llm-orchestrator.test.ts` passed (57 tests), and `cd electron && npm run typecheck` passed. |
| A-01 / A-02 | Removed the test-only legacy `electron/src/main/config/keychain.ts` and `config/runtime.ts` modules, their dedicated unit tests, and stale test mocks/comments; credential storage remains in `providers/credentials/vault.ts`. | No legacy imports or symbols remain; architecture-validation and chat IPC tests passed (22 passed, 20 skipped), and `cd electron && npm run typecheck` passed. |
| A-03 / A-04 | Removed the unwired `main/project/layers.ts` apply/reset/getter path, its barrel exports, and layer-only tests/mocks; config diagnostics/personality listing now use explicit home-only fallbacks. | No project-layer symbols or imports remain; config/definition/session/chat IPC tests passed (31 passed, 20 skipped), and `cd electron && npm run typecheck` passed. |
| A-06 | Removed superseded global personality registry mutators/accessors (`replacePersonalityRegistry`, `listPersonalities`, `appendPersonality`, `resetPersonalityRegistry`, `getPersonality`) and their test-only coverage; retained live file loading, names listing, seeding, and project-runtime reads. | No superseded personality symbols remain; personality/project/config/definition tests passed (25 tests), and `cd electron && npm run typecheck` passed. |
| A-07 | Removed the unwired AST/RAG single-file `updateFile` exports, the post-write callback registry, callback invocations from write/edit/AST mutation tools, and callback-only tests. | Static search found no callback/updateFile references; filesystem tests passed (65 tests) and `cd electron && npm run typecheck` passed. AST/RAG suites were attempted but 30 tests failed before exercising this change because the installed `better-sqlite3` binary targets Node ABI 148 while this runtime requires ABI 137. |
| A-09 / A-10 | Removed test-only `isModelAvailable` and `clearTokenizerCache` exports; retained live `downloadModel` / `getModelDir` path and moved tokenizer tests to fresh module loading for isolation. | No dead helper references remain; tokenizer tests passed (6 tests), and `cd electron && npm run typecheck` passed. |
| A-11 / F-01 | Removed the confirmed-unused public barrels under `main/{session,project,mcp,ast}`, `main/tools/{filesystem,mcp,process,skill,subagent,todo,web}`, and `shared/types`; preserved live `tools/ast/index.ts` and `tools/rag/index.ts`. | No direct imports of the removed barrels remain; tool/domain tests passed (100 tests), and `cd electron && npm run typecheck` passed. |
| A-12 | Removed the unused `mcpServerConfigSchema` runtime validator and replaced the live inferred type with an explicit `MCPServerConfig` interface; preserved `MCPServerStatus` types and name validation. | No `mcpServerConfigSchema` references remain; MCP/project registry tests passed (85 tests), and `cd electron && npm run typecheck` passed. |
| A-16 | Removed the unreferenced `ConfigManager.save` singleton method and its no-op unit test; config persistence remains on the live config IPC/loader path. | No `ConfigManager.save` references remain; `cd electron && npm test -- --run tests/unit/config.test.ts` passed (91 tests), and `cd electron && npm run typecheck` passed. |
| A-18 | Removed the unreferenced `SessionManager` accounting accessors (`getProviderCostTotals`, `getChainProviderCostTotals`), `saveActive`, and deprecated `syncActiveChain` wrapper, plus their test-only coverage/mocks. | No exact dead-method references remain; `cd electron && npm test -- --run tests/unit/session-persistence.test.ts tests/unit/chat-ipc.test.ts` passed (89 passed, 20 skipped), and `cd electron && npm run typecheck` passed. |
| C-02 / C-13 | Removed the unused `classifyError`/`ClassifiedError` middleware surface, its private classification helpers, re-export, and classification-only tests; preserved provider resolution and transient retry detection. | No exact `classifyError` or `ClassifiedError` references remain; `cd electron && npm test -- --run tests/unit/llm-middleware.test.ts` passed (24 tests), and `cd electron && npm run typecheck` passed. |
| C-03 | Removed the unconstructed local `APIError` subclass hierarchy and simplified `isTransientError` to the live status-code/message checks; updated retry tests to use provider-shaped errors. | No local API error subclass references remain; `cd electron && npm test -- --run tests/unit/llm-middleware.test.ts` passed (17 tests), and `cd electron && npm run typecheck` passed. |
| C-04–C-07 | Removed unused `shouldOffloadToolOutput`, `getKnownModelIds`, `ToolInfo`, and `_resetProviderRuntimeForTests` exports; retained live offload constants, metadata resolution/cache, and provider runtime reset. | No exact dead-export references remain; focused middleware/metadata/prompt/config tests passed (31 tests), and `cd electron && npm run typecheck` passed. |
| C-09 | Removed the test-only `ConnectionStore.remove` method and its removal assertion; retained the live list/get/create/update store surface. | No `ConnectionStore.remove`/`store.remove` references remain; `cd electron && npm test -- --run tests/unit/provider-connection-store.test.ts` passed (5 tests), and `cd electron && npm run typecheck` passed. |
| F-02 | Removed the never-parsed domain Zod schemas (`message`, `chain`, `session`, `agent`, `skill`, and `todo`) and schema-only dependencies; retained live storage deserializers and context/tool-call validation. | No exact removed schema references remain; domain/session/message tests passed (125 tests), and `cd electron && npm run typecheck` passed. |
| F-03 / F-04 | Removed unused agent/skill storage dictionary types and serializers; retained live file-based agent/skill registries and domain types. | No exact agent/skill serializer references remain; agent/skill/project/domain tests passed (114 tests), and `cd electron && npm run typecheck` passed. |
| F-05 | Removed the unused shared `ToolResult` interface/schema/storage serializers; retained live `ToolCall` storage validation and message/tool normalization paths. | No exact shared ToolResult references remain; domain/factory/normalization tests passed (49 tests), and `cd electron && npm run typecheck` passed. |
| F-06 | Removed the test-only `validateTodoTransition` wrapper; retained `VALID_TRANSITIONS` and the live TodoStore validation path. | No `validateTodoTransition` references remain; domain/todo tests passed (68 tests), and `cd electron && npm run typecheck` passed. |
| B-01 | Removed the unreachable `toolExecuting` XState state, its `currentToolCall` context, and the dead chat activity-phase branch; provider-managed tool events remain informational in `streaming`. | No `toolExecuting` or `currentToolCall` references remain; XState/chat architecture tests passed (51 passed, 20 skipped), and `cd electron && npm run typecheck` passed. |
| B-02 | Removed the uninvoked `toolExecActor`, `ToolExecInput`, agent-machine `executeFn` input/context, and production chat execute stub; the legacy session-machine seam is tracked with B-03. | No `toolExecActor`/`ToolExecInput` references remain; XState/chat architecture tests passed (51 passed, 20 skipped), and `cd electron && npm run typecheck` passed. |
| B-05 | Removed the unhandled `TOOL_ERROR` event interface and its agent/subagent union entries; provider/tool failures continue through the live `TOOL_RESULT`/`ERROR` events. | No `TOOL_ERROR`/`ToolErrorEvent` references remain; XState/architecture tests passed (46 tests), and `cd electron && npm run typecheck` passed. |
| B-03 / B-04 / B-10 | Removed the production-dead `sessionMachine` and `subagentMachine` files, their test-only coverage, and session/subagent XState event unions; retained `SubagentManager`/`subagent-runner`. | No legacy machine/event references remain; XState/architecture tests passed (35 tests), and `cd electron && npm run typecheck` passed. |
| D-04 / D-05 | Removed the unused updater preload API, updater IPC handler module/registration, invoke channels/allowlist entries, and bridge-only payload types; retained headless main updater state/events and startup checks. | No updater bridge/API/handler references remain; auto-update/app-shell/chat tests passed (73 passed, 20 skipped), and `cd electron && npm run typecheck` passed. |
| D-08 | Removed the unused global MCP manager reference accessors and their IPC barrel re-exports; retained project-scoped MCP status resolution. | No `setMCPManagerRef`/`getMCPManagerRef` references remain; app-shell and architecture tests passed (59 tests), and `cd electron && npm run typecheck` passed. |
| E-03 | Removed the unused `useTheme` export and orphaned theme-context state/effects; retained live theme application and config persistence. | No `useTheme`/theme-context references remain; `cd electron && npm run typecheck` passed. |
| E-06 | Removed the superseded date-primary session grouping helper, `DateGroup` type, date utility, and test-only coverage; retained project/workspace grouping. | No `groupSessionsByDate`/`DateGroup` references remain; `cd electron && npm test -- --run tests/unit/session-workspace-sidebar.test.ts` passed (15 tests), and `cd electron && npm run typecheck` passed. |
| E-07 | Removed the unused `isSettledToolStatus` helper and deprecated `foldConsecutiveGroupableTools` implementation with its test-only coverage; retained live `foldActivityRuns` grouping. | No `isSettledToolStatus`/`foldConsecutiveGroupableTools` references remain; `cd electron && npm test -- --run tests/unit/tool-grouping.test.ts` passed (17 tests), and `cd electron && npm run typecheck` passed. |
| E-08 | Removed the unused renderer command lookup exports `getCommand`, `getCommandNames`, and `isCommand`; retained the live `COMMANDS` registry and production consumers. | No removed helper references remain; parity and command-palette integration tests passed (62 tests), and `cd electron && npm run typecheck` passed. |
| E-01 | Removed the unmounted ToolRail component island, its hook/types/barrel, and island-only integration tests; preserved the live `LiveCommandInline` component. | No ToolRail/widget/hook references remain in `src` or `tests`; only `LiveCommandInline.tsx` remains in the directory. App-shell and tool-grouping tests passed (61 tests), and `cd electron && npm run typecheck` passed. |
| E-02 | Removed the orphaned ToolRail/widget CSS block and empty `.chat-main.tool-rail-open` modifier; retained the live chat and onboarding styles. | No ToolRail/widget selectors remain in `src` or `tests`; app-shell and command-palette tests passed (99 tests), and `cd electron && npm run typecheck` passed. |
| F-12 | Removed the unused Monaco/xterm dev dependencies and their lockfile-only transitive packages after deleting the ToolRail island. | No removed package names remain in `package.json`, `package-lock.json`, `src`, or `tests`; `cd electron && npm test -- --run tests/integration/app-shell.test.ts tests/integration/command-palette.test.ts` passed (99 tests), and `cd electron && npm run typecheck` passed. A pre-existing local `node_modules` install reports the removed packages as extraneous until pruned. |
| F-11 | Removed the orphaned `electron/.prettierrc` and unused Prettier dev dependency/lock entry; no formatting script or editor integration was present. | No Prettier/config references remain in the scoped source, tests, scripts, or package manifests; `cd electron && npm test -- --run tests/integration/app-shell.test.ts tests/unit/config.test.ts` passed (135 tests), and `cd electron && npm run typecheck` passed. |

| IDs | Disposition | Detailed evidence |
|-----|-------------|-------------------|
| E-01 | **Fixed — removed unmounted ToolRail component island** | `ToolRail` began at `electron/src/renderer/components/ToolWidgets/ToolRail.tsx:35`; its component dependencies, `useToolRail` hook, types/barrel, and island-only tests had no production caller. They are removed. Do **not** remove `LiveCommandInline.tsx`: it is imported by `MessageWidget.tsx:17` and rendered at `MessageWidget.tsx:186`. |
| E-02 | **Fixed — removed orphaned ToolRail/widget CSS** | The ToolRail CSS block formerly ran from `electron/src/renderer/styles/chat.css:1407` through the generic widget block ending before onboarding at line 2033 (~626 lines), plus the empty `.chat-main.tool-rail-open` modifier at line 28. These selectors are removed. |
| F-12 | **Fixed — removed ToolRail-only dependencies** | `@monaco-editor/react` was imported only by the removed `DiffWidget`; `@xterm/xterm` and `@xterm/addon-fit` only by the removed `TerminalWidget`. Their declarations and lockfile entries (including Monaco/xterm transitive-only packages) are removed. A local pre-existing `node_modules` install may still show them as extraneous until pruned. |
| D-10 | **Resolved with E-01 removal** | The dead `TerminalWidget` path that invoked renderer tool `send_input` was removed with the unmounted ToolRail island. No live renderer path depends on that allowlist gap. |
| B-01 | **Fixed — removed unreachable toolExecuting state** | The machine handled provider tool calls as informational in `streaming`; no transition targeted `toolExecuting`. The state, current tool context, and chat activity branch are removed. |
| B-02 | **Fixed — removed dead tool execution actor/stub** | `toolExecActor`, its input type, the agent-machine execute callback, and the production chat stub had no reachable caller and are removed. The legacy session-machine execute seam remains only with the test-only machine tracked under B-03. |
| B-05 | **Fixed — removed unused event type** | `TOOL_ERROR` existed only in the event surface with no sender or state handler; the interface and union entries are removed. |
| B-03 / B-04 / B-10 | **Fixed — removed test-only legacy machines/events** | `sessionMachine` and `subagentMachine` had no production importers; their files, tests, and session/subagent event unions are removed. The live subagent implementation remains `SubagentManager` plus `agents/subagent-runner.ts`, wired through `wireSubagentRuntime()`. |
| D-01–D-03, D-06 | **Fixed — removed dead IPC round-trip; live definition APIs retained** | The former handler `main/ipc/agent.ts` registered `agent:list` / `agent:spawn` at lines 24 and 29, and the preload exposed them at lines 268-273. The handler file, preload methods, `AgentSpawnMessage`/`AgentSpawnResult` types, `IPC_CHANNELS.AGENT_LIST`/`AGENT_SPAWN`, and allowlist entries are now removed. `agent.save` / `agent.delete` remain at the preload namespace and `main/ipc/definitions.ts`. |
| D-04, D-05 | **Fixed — removed dead updater renderer/IPC bridge** | No renderer consumed the updater API. The preload surface, main IPC wrapper/registration, invoke channels, allowlist entries, and bridge-only payload types are removed; main updater state/events and packaged startup checks remain live. |
| D-07, F-08 | **Fixed — removed unused type** | `DiscoveredModel` was declared at `shared/types/ipc-boundary.ts:73` and re-exported at `shared/types/ipc.ts:67`; both declarations are now removed. There were no fields, functions, or renderer consumers. |
| D-08 | **Fixed — removed unused global MCP manager accessors** | `setMCPManagerRef` and `getMCPManagerRef` were defined in `main/ipc/mcp.ts` and re-exported by `main/ipc/index.ts` without callers. Those accessors and the backing global are removed; the project-scoped MCP registry remains live and separate. |
| A-01, A-02 | **Fixed — removed test-only migration residue** | `config/keychain.ts` had no production importer and was used only by `tests/unit/keychain.test.ts:50`; `config/runtime.ts:9` was imported only by `tests/unit/runtime-config.test.ts:21`. Both modules and their dedicated tests are removed. `CredentialVault` remains the live provider credential path. |
| A-03, A-04 | **Fixed — removed production-dead apply path and made fallbacks explicit** | `applyWorkspaceProjectLayers` formerly started at `main/project/layers.ts:97` with no production caller, while `getLastAppliedProjectDir` at `layers.ts:33` stayed `null`. `main/project/layers.ts` and its barrel exports are removed; `main/ipc/config.ts` now passes `HOME_CONFIG_DIR` for diagnostics and calls `loadPersonalities()` home-only. Project overlays remain owned by the live immutable runtime in `main/project/runtime.ts:78-101`. |
| A-06 | **Fixed — removed superseded global registry surface** | `replacePersonalityRegistry` (`personality/registry.ts:166`), `listPersonalities` (`:188`), `appendPersonality` (`:202`), `resetPersonalityRegistry` (`:223`), and the test-only `getPersonality` accessor are removed with their test coverage. The module remains live: `readPersonalities` (`:106`) feeds project runtime, while `loadPersonalities` (`:140`) and `listPersonalityNames` (`:181`) feed startup/config UI. |
| A-07 | **Fixed — removed unwired incremental indexing path** | AST and RAG single-file functions formerly started at `main/ast/indexer.ts:136` and `main/rag/indexer.ts:516`; the callback registry formerly lived at `tools/filesystem/callbacks.ts:1-63`, with production triggers but no production registration. Those exports, the registry, write/edit/AST callback calls, and callback-only tests are removed. Full project indexing remains live. |
| A-09, A-10 | **Fixed — removed test-only embedder helpers; live model path retained** | `isModelAvailable` at `main/rag/embedder.ts:653` had no production caller, and `clearTokenizerCache` at `embedder.ts:992` was test-only. Both exports and their tests are removed. `downloadModel` at `embedder.ts:518` remains live through first-use model resolution at `embedder.ts:892`, and `getModelDir` remains its storage-path helper at `embedder.ts:526`. |
| A-11 | **Fixed — removed unused barrels while preserving live tool indexes** | No production module imported `main/session/index.ts:1`, `main/project/index.ts:1`, `main/mcp/index.ts:1`, `main/ast/index.ts:1`, `shared/types/index.ts:1`, or `tools/{filesystem,mcp,process,skill,subagent,todo,web}/index.ts:1`; those files are removed. `main/tools/index.ts:24` and `:35` still import live `tools/rag/index.ts` and `tools/ast/index.ts`, which remain. |
| A-12 | **Fixed — removed unused runtime schema; preserved live type** | `mcpServerConfigSchema` formerly began at `main/mcp/schema.ts:40` and was never parsed. It is removed; `MCPServerConfig` is now an explicit structural interface in `schema.ts`, still consumed by `mcp/manager.ts`, `mcp/transport.ts`, and `mcp/project-registry.ts`. `isValidServerName` and status type re-exports remain live. |
| A-16 | **Fixed — removed unreferenced config persistence method** | `ConfigManager.save` at `main/config/loader.ts:305` had only the no-op unit test at `tests/unit/config.test.ts:847`; the method, test, and stale usage comment are removed. Config IPC writes through the live loader/atomic-write path. |
| A-18 | **Fixed — removed unreferenced session methods** | `getProviderCostTotals`, `getChainProviderCostTotals`, `saveActive`, and `syncActiveChain` had no production callers; only test coverage/mocks referenced them. The methods and stale tests/mocks are removed, while live `listSaved` and `persistTurn` remain. |
| C-01, C-12 | **Fixed — removed test-only duplicate module** | The former `llm/cleanup.ts` exports at lines 32, 76, 137, and 157 were imported only by `tests/unit/llm-orchestrator.test.ts:43-47` and are now removed along with their dedicated tests. The live restore path remains `shared/types/chain.ts:179`, invoked at `chain.ts:280`. |
| C-02, C-13 | **Fixed — removed unused user-facing classifier** | `classifyError` and `ClassifiedError` had no production caller; their 13-branch implementation, private helpers, re-export, and tests are removed. `ProviderResolutionError` and `isTransientError` remain live. |
| C-03 | **Fixed — removed unconstructed local API error hierarchy** | The local `APIError` subclasses were never constructed by production code. Their class-based retry branch is removed; status-code and native-message detection remains live and covered by middleware tests. |
| C-04–C-07 | **Fixed — removed unused exports** | `shouldOffloadToolOutput`, `getKnownModelIds`, `ToolInfo`, and `_resetProviderRuntimeForTests` had no consumers outside their export surfaces and are removed. The underlying offload constants, metadata resolution/cache, and provider runtime reset remain live. |
| C-09 | **Fixed — removed test-only connection removal method** | `ConnectionStore.remove` had no production caller; IPC permits only `list`, `get`, `create`, and `update`, and provider runtime uses `list`. The method and its test-only assertion are removed; the store and remaining methods remain live. |
| C-11 | **Confirmed live compatibility metadata path — leave in place** | `resolveModelMetadata` is defined at `main/llm/model-metadata.ts:251`, registered by config IPC at `main/ipc/config.ts:132-136`, exposed by preload at `preload/index.ts:156-157`, and consumed by `renderer/components/ModelPicker.tsx:95-102` and `ChatView.tsx:679-684`. Config saves also invalidate its cache at `main/ipc/config.ts:186-187`. This is a live fallback alongside the provider catalog, not dead duplication. Only `getKnownModelIds` from the module is unused (C-05). |
| F-01 | **Fixed — removed unused shared-types barrel** | `shared/types/index.ts:1` had no production or test import and is removed. |
| F-02 | **Fixed — removed never-parsed domain schemas** | Runtime-unconsumed `messageSchema`, `chainSchema`, `sessionSchema`, `agentSchema`, `skillSchema`, and `todoSchema` plus their schema-only dependencies are removed. Live context/tool-call validation and storage deserializers remain. |
| F-03 / F-04 | **Fixed — removed unused agent/skill serializers** | `AgentStorageDict`/`agentToStorageDict`/`agentFromStorageDict` and `SkillStorageDict`/`skillToStorageDict`/`skillFromStorageDict` had no consumers and are removed. |
| F-05 | **Fixed — removed unused shared tool-result serializers** | The shared `ToolResult` interface/schema/storage helpers had no consumers and are removed; live tool-result messages and main normalization remain. |
| F-06 | **Fixed — removed duplicated todo transition helper** | `validateTodoTransition` had only unit-test callers and duplicated the inline `VALID_TRANSITIONS` check in `tools/todo/store.ts`; the helper and tests are removed while the live table/store path remains. |
| B-06, E-08, E-09, F-10 | **B-06 fixed — removed duplicate main registry; renderer surface retained** | The former main `COMMANDS` definition at `main/commands/registry.ts:160` was imported only by parity/integration tests. `main/commands/registry.ts` is now removed, and those tests import the live renderer registry at `renderer/commands/registry.ts:50`. The renderer registry remains consumed by `InputArea.tsx:16` and `CommandPalette.tsx:8`; its lookup helpers at `renderer/commands/registry.ts:212-221` remain test-only/unused exports and are tracked separately under E-08. |
| B-07 | **Fixed — removed unused helpers and return type** | `toolError`, `toolSuccess`, and `StructuredToolResult` were removed from `main/tools/result.ts`. The live result surface now starts with `NormalizedToolResult` at `result.ts:12`, `normalizeToolHandlerResult` at `result.ts:22`, and `parseToolExecuteOutput` at `result.ts:54`. No exact symbol references remain in `src` or `tests`. |
| E-03 | **Fixed — removed unused theme hook/context** | `useTheme` and its orphaned context state had no consumer and are removed; `applyTheme` remains live. |
| E-06 | **Fixed — removed superseded date grouping helper** | `groupSessionsByDate` and its date-only support had no renderer consumer; project/workspace grouping remains live. |
| E-07 | **Fixed — removed obsolete tool-grouping helpers** | `isSettledToolStatus` at `renderer/utils/tool-grouping.ts:89` had no references. Deprecated `foldConsecutiveGroupableTools` at line 174 was test-only (`tests/unit/tool-grouping.test.ts:7,120`); both are removed with their test-only coverage. The live replacement is `foldActivityRuns` at `tool-grouping.ts:235`. |
| E-08 | **Fixed — removed test-only renderer command lookup helpers** | `getCommand`, `getCommandNames`, and `isCommand` at `renderer/commands/registry.ts:212-221` had no production callers. The exports and helper-only tests are removed; production UI continues to consume `COMMANDS` directly, while behavior tests use local `COMMANDS.find` lookups. |
| E-05 | **Resolved after original report** | `collectModelsFromProviders` and `collectEmbeddingModelsFromProviders` were removed from `renderer/utils/models.ts` by commit `cbb14b1` after this report was generated. They no longer exist at current HEAD, so this item is complete rather than an outstanding cleanup. |
| E-10, E-11 | **Advisory, not a deletion proof** | The icon registry begins at `renderer/components/Icon.tsx:60`; several keys have no current literal/dynamic producer, but this is a small extensibility surface and was only medium confidence. Shortcut definitions consumed by `ShortcutsHelp` are live documentation behavior even when no global keyboard handler uses them. |
| F-11 | **Fixed — removed orphaned formatting config/dependency** | The tracked `electron/.prettierrc` had no script or editor integration, and `prettier` had no invocation. Both the config and dev dependency/lock entry are removed. |
| F-12 | **Fixed — removed ToolRail-only dependencies** | `@monaco-editor/react` was imported only by the removed `DiffWidget`; `@xterm/xterm` and `@xterm/addon-fit` only by the removed `TerminalWidget`. Their declarations and lockfile entries (including Monaco/xterm transitive-only packages) are removed. A local pre-existing `node_modules` install may still show them as extraneous until pruned. |
| F-13 | **Confirmed live dependencies** | `zod-to-json-schema` is imported by production at `main/tools/registry.ts:8` and `main/llm/context-snapshot.ts:2` but is not a direct dependency; it currently resolves transitively through `@modelcontextprotocol/sdk`. Keep `@electron/rebuild`: `scripts/rebuild-native.sh:31` invokes it. |
| Knip false positives | **Confirmed live** | Preload is the explicit esbuild entry at `scripts/build-preload.js:10`; AST/RAG workers are constructed at `main/ast/indexer.ts:434` and `main/rag/indexer.ts:458`; themes are emitted by `vite.config.ts:14-18` and loaded at `renderer/themes/index.ts:40`; tree-sitter WASM is resolved at `main/ast/parser.ts:197`; AI SDK provider packages are dynamically loaded, for example `providers/drivers/native.ts:27,35,43,51`. |
| B-11, B-12 | **Confirmed live/discoverable** | Built-in registration runs at `main/tools/index.ts:225-275`, including five AST tools through `tools/ast/index.ts:36-42`, totaling 27. Bundled defaults contain 26 `AGENT.md` and 15 `SKILL.md` entries and are path-discovered. Skill seeding is incomplete as noted: `skills/registry.ts:190-211` copies only `SKILL.md`; agent seeding similarly copies only `AGENT.md` at `agents/registry.ts:116-137`. |

### Corrections and safe cleanup boundaries

1. Treat `E-05` as already resolved by `cbb14b1`.
2. Do not delete all of `ToolWidgets/`; `LiveCommandInline.tsx` is live. Delete only the files listed under E-01 if the ToolRail product path is abandoned.
3. Do not delete `error-classification.ts`; remove only its unused classifier/classes or consolidate while preserving `ProviderResolutionError` and `isTransientError`.
4. Do not delete shared persistence serializers wholesale. Agent/skill/tool-result helpers are unused, while message/chain/session/todo/subagent serialization is active session-storage code.
5. Do not delete the personality registry wholesale. Only the superseded global helpers are dead; project-runtime reads and settings name listing are live.
6. Do not treat every `index.ts` under tools as an unused barrel. `tools/ast/index.ts` and `tools/rag/index.ts` are production registration modules.
7. Do not remove `llm/model-metadata.ts` as refactor duplication; renderer model limits and capabilities still use its config IPC path.
8. `agent:list` / `agent:spawn` are dead, but `agent.save` / `agent.delete` share the same preload namespace and are live.
9. The exact Knip/Depcheck aggregate counts were not rerun during this verification because neither package is installed in the checkout. The high-value findings above were independently verified through direct reachability and entry-point tracing.

---

## 1. Highest-value dead islands

### 1.1 ToolRail feature (never mounted) — Agents E + F + knip

Live tool UX is `ToolCallBlock` / `ToolActivityGroup` / `LiveCommandInline` only.

| ID | Location | Kind | Conf. |
|----|----------|------|-------|
| E-01 | `renderer/components/ToolWidgets/{ToolRail,ToolWidgetContainer,DiffWidget,TerminalWidget,FilePreview,ResultsTable,index,types}` | unused-file / unmounted | high |
| E-01 | `renderer/hooks/useToolRail.ts` | unused-file | high |
| E-02 | `renderer/styles/chat.css` (`.tool-rail*`, `.tool-widget-*`) | unused-style (~600 lines) | high |
| F-12 | `@monaco-editor/react`, `@xterm/xterm`, `@xterm/addon-fit` | effectively unused-deps (only ToolRail importers) | high |

**Caveat:** `tests/integration/tool-widgets.test.ts` asserts file existence, not mount. Product choice: finish rail **or** delete island.

**Related broken path (D-10):** `TerminalWidget` calls `tool.execute({ name: 'send_input' })` but `RENDERER_ALLOWED_TOOLS` does not include `send_input` — interactive terminal would fail even if mounted.

---

### 1.2 XState parallel design unused in production — Agent B

| ID | Location | Kind | Conf. |
|----|----------|------|-------|
| B-01 | `agents/xstate/agent-machine.ts` → `toolExecuting` state | unreachable-state | high |
| B-02 | `toolExecActor` + production `executeFn` stub in `ipc/chat.ts` | dead-runtime-path | high |
| B-03 | `agents/xstate/session-machine.ts` | unused-file (prod) | high |
| B-04 | `agents/xstate/subagent-machine.ts` | unused-file (prod) | high |
| B-05 | `TOOL_ERROR` event | unused-export | high |
| B-10 | Session spawn/complete XState events | unused with B-03 | medium |

**Live machines:** `agentMachine` (minus toolExecuting), `interruptMachine`, `SubagentManager` + `subagent-runner`.

---

### 1.3 Dead IPC surfaces — Agent D

| ID | Location | Kind | Conf. |
|----|----------|------|-------|
| D-01–D-03 | `main/ipc/agent.ts` (`agent:list`, `agent:spawn`) + preload + types | unused full stack | high |
| D-04–D-05 | `window.orchid.updater.*` + event types | unused UI bridge; main auto-updater still runs | high |
| D-06 | `AgentSpawnMessage` / `AgentSpawnResult` | unused types | high |
| D-07 / F-08 | `DiscoveredModel` | unused type | high |
| D-08 | `setMCPManagerRef` / `getMCPManagerRef` | unused after project MCP | high |

**Not dead:** main↔preload channel **symmetry** is complete — no orphan channel strings on one side only. Deadness is “registered + never called from renderer.”

---

### 1.4 Migration residue (main) — Agent A

| ID | Location | Kind | Conf. |
|----|----------|------|-------|
| A-01 | `config/keychain.ts` | **Removed** — unused-file (tests only; superseded by vault) | high |
| A-02 | `config/runtime.ts` | **Removed** — unused-file (tests only) | high |
| A-03–A-04 | `project/layers.ts` apply/reset + always-null `getLastAppliedProjectDir` | **Removed** — unused apply path / zombie IPC inputs | high |
| A-06 | Global personality registry mutators/accessors superseded by project runtime | **Removed** — unused-export/test-only surface | high |
| A-07 | RAG/AST `updateFile` + never-registered post-write callbacks | **Removed** — unfinished feature with no production registration | high |

---

### 1.5 LLM dead module + dual classifiers — Agent C

| ID | Location | Kind | Conf. |
|----|----------|------|-------|
| C-01 / C-12 | `llm/cleanup.ts` | **Removed** — test-only duplicate of live chain reconciliation | high |
| C-02 / C-13 | `classifyError` middleware | unused; live paths use orchestrator + chat classifiers | high |
| C-03 | Typed `APIError` subclasses | never constructed in app | high |
| C-04–C-07 | `shouldOffloadToolOutput`, `getKnownModelIds`, `ToolInfo`, `_resetProviderRuntimeForTests` | unused-export | high |

**Not dead (refactor dual paths):** all provider drivers registered; catalog/runtime live; `model-metadata` still used as fallback (C-11).

---

## 2. Shared types dead surface — Agent F + knip

| ID | Location | Kind | Conf. |
|----|----------|------|-------|
| F-01 | `shared/types/index.ts` | unused barrel | high |
| F-02 | Domain Zod schemas (`messageSchema`, `chainSchema`, `sessionSchema`, `agentSchema`, `skillSchema`, `todoSchema`, …) | never `.parse()`'d | high |
| F-03–F-04 | Agent/skill `*StorageDict` + serializers | unused | high |
| F-05 | `ToolResult` / storage helpers in `shared/types/tool.ts` | unused (runtime uses main tools result) | high |
| F-06 | `validateTodoTransition` | tests only; store inlines logic | high |

**Live shared files:** `commands.ts`, `usage.ts` (most exports), `frontmatter.ts`, provider/IPC/session/chain types used on hot paths.

---

## 3. Commands / tools / skills — Agent B

| Finding | Status |
|---------|--------|
| Built-in tools (27) | All registered — **no orphans** |
| Agent defaults (26) / skill defaults (15) | Path-discovered — **not dead** |
| Renderer `COMMANDS` | All live via palette/slash |
| `main/commands/registry.ts` | **Removed** — production-dead parity mirror (B-06 / E-09 / F-10) |
| `toolError` / `toolSuccess` helpers | Unused exports (B-07) |

**Product note (not pure dead code):** skill `seedDefaults` copies only `SKILL.md` / `AGENT.md`, not `references/`/`scripts`/`assets` — seed incompleteness, not undiscoverable packs.

---

## 4. Renderer leftovers (smaller) — Agent E

| ID | Item | Conf. |
|----|------|-------|
| E-03 | `export function useTheme` in `App.tsx` | high |
| E-05 | `collectModelsFromProviders` / `collectEmbeddingModelsFromProviders` | **resolved** — removed by `cbb14b1` after this report was generated |
| E-06 | Date-primary session helpers superseded by project sidebar | high |
| E-07 | `isSettledToolStatus`, deprecated `foldConsecutiveGroupableTools` | high |
| E-08 | `getCommand` / `getCommandNames` / `isCommand` | high |
| E-10 | ~13 unused Icon map keys | medium |
| E-11 | Shortcut registry entries that only feed ShortcutsHelp | medium (docs, not dead) |
| Themes CSS | All five themes live via `applyTheme` dynamic href | **not dead** |

---

## 5. Knip mechanical results (filtered)

### 5.1 Unused files knip reported (28)

| Knip path | Verdict |
|-----------|---------|
| `ast/index-worker.ts`, `rag/index-worker.ts` | **False positive** — loaded via `new Worker(.../index-worker.js)` path string |
| `preload/index.ts` | **False positive** — Electron preload entry (esbuild), not TS-imported |
| `themes/*.css` (5 files) | **False positive** — loaded as `./themes/${name}.css` at runtime |
| ToolWidgets + `useToolRail` (knip list) | **True positive** — matches E-01 |
| Barrels: `main/{session,project,mcp,ast}/index.ts`, `tools/{filesystem,mcp,process,skill,subagent,todo,web}/index.ts`, `shared/types/index.ts` | **Removed** as unused barrels; implementations still live via deep imports. **Excluded and retained** live `tools/ast/index.ts` and `tools/rag/index.ts`, imported at `main/tools/index.ts:35,24`. |

### 5.2 Unused exports / types

Knip listed **~163 unused exports** and **~155 unused exported types**. Agents independently confirmed the high-value subset (keychain, cleanup, XState, IPC, shared Zod, etc.). Many remaining hits are:

- Zod input types next to tool schemas (export for typing only)
- Re-exports from barrels
- Test seams (`_reset*`, class exports for unit tests)
- IPC message interfaces used only by typing the preload API surface

Treat bulk knip export/type lists as a **triage backlog**, not auto-delete.

### 5.3 Dependencies

#### Knip

| Package | Knip says | Verdict |
|---------|-----------|---------|
| `@vscode/tree-sitter-wasm` | unused dep | **False positive** — resolved by path in `ast/parser.ts` for grammar WASM |
| `@electron/rebuild` | unused devDep | **Likely false** — used by `scripts/rebuild-native.sh` / package scripts, not imports |
| `@monaco-editor/react`, `@xterm/*` | unused | **Effectively true** iff ToolRail stays unmounted |
| `prettier` | unused | **True** — no config/script |

#### Depcheck

| Package | Depcheck says | Verdict |
|---------|---------------|---------|
| `@ai-sdk/anthropic|google|openai|openai-compatible|xai` | unused | **False positive** — dynamic `importESM` in drivers |
| `daisyui`, `tailwindcss` | unused | **False positive** — `@plugin "daisyui"` / Vite Tailwind, not JS imports |
| `prettier` | unused | **True** |
| Missing: `zod-to-json-schema` | missing dep | **True gap** — imported in `llm/context-snapshot.ts`, `tools/registry.ts` (transitive today) |

---

## 6. What is intentionally *not* dead

- Path-loaded defaults: `agents/defaults`, `skills/defaults`, `personality/defaults`, `ast/queries` (via `copy-defaults` + seeders)
- Optional `onnxruntime-node` (dynamic import in embedder)
- Catalog scripts under `scripts/provider-catalog/*`
- Provider dual metadata path (catalog + `model-metadata`) on this refactor branch
- All registered provider drivers
- Full chat/session/providers/definitions IPC used by renderer

---

## 7. Cleanup status and remaining decisions

The high-confidence cleanup items above were handled serially and are recorded in the Fix log. Remaining decisions are intentionally not removals: keep the live provider metadata compatibility path (`C-11`), keep dynamic provider packages and runtime-discovered assets (`F-13`/false positives), and decide separately whether to add a direct `zod-to-json-schema` dependency for packaging clarity.

---

## 8. Finding index (by agent)

### Agent A — Main (selected high confidence)

A-01 keychain module · A-02 runtime.ts · A-03/A-04 layers apply + null lastApplied · A-06 personality mutators · A-07 updateFile unwired · A-09/A-10 embedder helpers · A-11 barrels · A-12 mcpServerConfigSchema · A-16 ConfigManager.save · A-18 SessionManager dead methods

### Agent B — Tools/agents

B-01 toolExecuting · B-02 toolExecActor · B-03 sessionMachine · B-04 subagentMachine · B-05 TOOL_ERROR · B-06 main commands registry · B-07 toolError/Success · B-11 packs alive · B-12 tools all registered

### Agent C — Providers/LLM

C-01 cleanup.ts · C-02–C-03 error classification · C-04–C-07 stray exports · C-09 ConnectionStore.remove · C-11 dual metadata (leave)

### Agent D — IPC

D-01–D-03 agent IPC · D-04–D-05 updater UI · D-07 DiscoveredModel · D-08 MCP ref · D-10 send_input allowlist gap

### Agent E — Renderer

E-01–E-02 ToolRail island · E-03–E-04/E-06–E-08 smaller exports · E-05 resolved by `cbb14b1` · E-12 themes live

### Agent F — Shared/deps

F-01–F-06 shared dead surface · F-10 main commands dupe · F-11 prettier · F-12 Monaco/xterm · F-13 other deps live

---

## 9. Final verification

- `cd electron && npm run typecheck` passed after the final D-08 removal, and `git diff --check` passed.
- The full Vitest run reached 93 files: 87 passed, 20 tests were skipped, and 6 files reported 48 failures. Every failure was caused by the pre-existing `better-sqlite3` native binary mismatch (installed Node ABI 148 versus this runtime's ABI 137), before the affected AST/RAG/accounting behavior could run.
- Focused suites for each serial cleanup item passed; the Fix log records the exact command and test count for every removal.

## 10. Artifacts

- Knip raw: run `cd electron && npx knip`
- Depcheck raw: run `cd electron && npx depcheck`
- Agents: six parallel read-only explore agents (A–F), 2026-07-13

**Original investigation was read-only. Subsequent source removals are recorded in the Fix log above; no unverified fixes are implied.**
