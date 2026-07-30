# Architectural Review — Orchid Electron

**Date:** 2026-07-29
**Scope:** Full codebase audit — main process, renderer, shared types, cross-cutting concerns
**Method:** Three parallel deep-dive audits (main process, renderer, cross-cutting) with file-level analysis

---

## Executive Summary

No rewrite needed. The macro architecture is sound — clean Electron security boundary, zero `any` types, well-governed styling, lean dependencies, behavioral tests. Problems are concentrated in four areas: two god modules in the main process, one god component in the renderer, and a misplaced singleton that creates a circular dependency knot. All fixable with targeted refactoring.

---

## Critical Findings

### C1. `ipc/chat.ts` — 920-line god function

**Location:** `electron/src/main/ipc/chat.ts:1176` (`registerChatIPC`)

The single largest maintainability risk. One function owns:
- Stream-event → IPC translation
- Snapshot projection (`snapshotForAgent` et al., lines 357–399)
- Abort/force-stop orchestration (lines 506–711)
- Persistence checkpointing (lines 949–1015)
- Auto-naming / title generation
- Actor lifecycle management

Nested closures span 600–736 lines (`releaseResources`, `flushResponseSegment`, `flushThinkingSegment`, `finalizeTurn`). Every chat feature touches this function.

**Suggestion:** Extract into focused modules:
- `chat/stream-translation.ts` — StreamEvent → IPC event mapping
- `chat/abort.ts` — cancel/force-stop orchestration
- `chat/checkpoint.ts` — persistence and snapshot projection
- `chat/title.ts` — auto-naming logic

The `registerChatIPC` function should become a thin wiring layer.

### C2. `agents/manager.ts` — 1,509-line god class

**Location:** `electron/src/main/agents/manager.ts:503` (`SubagentManager`)

~80 methods conflating six distinct responsibilities:
- **Admission control / queueing** — `getAdmissionLimits`, `_canAdmit`, `_admitFromQueue` (lines 165, 1380–1461)
- **Lifecycle state machine** — `spawn`, `markRunning/Completed/Failed`, `close`, `cancelOne/All/Running` (lines 549–1047)
- **Wait/settle predicate engine** — `wait`, `shouldReturn`, `settle`, `checkPredicate` (lines 840–934)
- **Live projection / delta streaming** — `_appendLiveText`, `_emitDelta`, `materializeLiveTail` (lines 1882–2093)
- **Persistence coordination** — `confirmRecordsPersisted`, `_markRecordDirty`, `hydrate` (lines 1198–1358)
- **Q&A flow** — `markQuestionPending`, `answerSubagentQuestion` (lines 1108–1183)

Plus 8 custom error classes (lines 220–340) and domain-mapping helpers (lines 2022–2122).

**Suggestion:** Split into:
- `agents/admission.ts` — queue, limits, admission control
- `agents/live-projection.ts` — delta streaming, live tail materialization
- `agents/wait-settle.ts` — predicate engine, settle logic
- `agents/errors.ts` — the 8 error classes (shared across modules)
- `agents/manager.ts` — lifecycle + Q&A only, composing the above

---

## Moderate Findings

### M1. SessionManager singleton lives in the IPC layer (circular dependency root cause)

**Location:** `electron/src/main/ipc/session.ts:49-60`

The canonical `SessionManager` is owned by the IPC layer. Domain modules that need sessions must import *upward* into IPC:
- `agents/subagent-runner.ts:14` → `../ipc/session`
- `tools/subagent/delegate.ts:23` → `../../ipc/session`
- `tools/index.ts:107-156` — uses `createRequire(__filename)` lazy-loads to avoid init deadlock

This creates a real circular dependency (`tools ↔ ipc/session`) and drives 3 of 6 layering violations.

**Suggestion:** Move the singleton to `session/service.ts` (or `session/index.ts`). IPC handlers import from there; domain modules import from there. The `createRequire` hacks in `tools/index.ts` become normal imports. One move, three violations resolved.

### M2. `ChatView.tsx` — 1,292-line god component

**Location:** `electron/src/renderer/components/ChatView.tsx:80-1292`

- 8 hooks instantiated
- 30+ `useState` calls
- 9 direct IPC calls (`window.orchid.mcp.status()`, `window.orchid.rag.status()`, etc.)
- Keyboard shortcuts, toast notifications, tab management, layout orchestration
- Children receive 12–22 props each (no React Context used anywhere)

Prop counts:
- `ChatStream` — 21 props
- `Sidebar` — 22 props
- `InputArea` — 18 props
- `LeftSidebar` — 17 props
- `Footer` — 12 props

**Suggestion:**
- Extract `useInspectorData` hook (MCP/RAG/AST status polling)
- Extract `useProviderSelection` hook (model resolution)
- Create a `ChatContext` provider to eliminate prop drilling
- Move keyboard shortcut handling to a dedicated hook
- ChatView becomes a layout shell that composes context providers

### M3. `useChat.ts` — 910-line monolith hook

**Location:** `electron/src/renderer/hooks/useChat.ts:455-1365`

14 `useState` + 15 `useRef` in a single function body. Combines IPC event subscription, stream buffering, session affinity, cancel serialization, usage tracking, elapsed time, and message commit logic.

**Suggestion:** Split into composable hooks:
- `useStreamBuffer` — chunk accumulation + RAF-batched flush
- `useCancelQueue` — cancel serialization
- `useUsageTracking` — token/elapsed time
- `useChat` — thin orchestrator composing the above

### M4. Untyped CustomEvent bus

**Locations:** 24 sites across 8 renderer files

All use `as CustomEvent<{...}>` casts with string event names. No central registry. A typo in an event name silently breaks communication.

Events: `orchid:open-settings`, `orchid:set-theme`, `orchid:config-updated`, `orchid:select-session`, `orchid:navigate`, `orchid:providers-updated`, `orchid:provider-selection-created`, `orchid:definitions-workspace-changed`

**Suggestion:** Create `renderer/events.ts` with a typed event map:
```typescript
interface OrchidEvents {
  'orchid:open-settings': { tab?: string };
  'orchid:set-theme': { theme: string };
  // ...
}
function emit<K extends keyof OrchidEvents>(name: K, detail: OrchidEvents[K]): void
function on<K extends keyof OrchidEvents>(name: K, handler: (detail: OrchidEvents[K]) => void): () => void
```

### M5. `components.css` exceeds documented split threshold

**Location:** `electron/src/renderer/styles/components.css` — 2,249 lines

AGENTS.md says: "Prefer splitting by surface area if it crosses ~2,000 lines."

**Suggestion:** Split by surface: `components-chat.css`, `components-config.css`, `components-onboarding.css`, `components-session.css`. Keep `components.css` as the import aggregator.

### M6. `shared/types/ipc.ts` at 1,341 lines

**Location:** `electron/src/shared/types/ipc.ts`

Combines ~60 message/event interfaces, the full `OrchidAPI` interface (~200 lines), `IPC_CHANNELS` constant (~140 entries), two allowlist arrays, and re-exports from 6 other files. De facto barrel for all IPC types.

**Suggestion:** Split into:
- `ipc-channels.ts` — channel name constants + allowlists
- `ipc-api.ts` — `OrchidAPI` interface
- `ipc-events.ts` — event payload interfaces
- `ipc.ts` — thin re-export barrel (if needed)

### M7. `ConfigPatch` manually mirrors config schema

**Location:** `electron/src/shared/types/ipc.ts:340-391`

37 hand-written optional fields that must stay in sync with `configSchema` in `config/schema.ts`. Adding a config field requires updating both.

**Suggestion:** Derive from Zod: `export type ConfigPatch = Partial<z.infer<typeof configSchema>>` or use `z.partial()`.

### M8. Duplicate `subagentRecordSchema` export name

**Locations:** `electron/src/shared/types/subagent.ts:299` and `electron/src/shared/types/ipc-schemas.ts:307`

Two different Zod schemas with the same export name. The domain-level one has no `chain` field; the IPC-level one adds `chain: z.unknown()` and `parentChainIndex`. Import confusion risk.

**Suggestion:** Rename the IPC-level one to `ipcSubagentRecordSchema`.

### M9. Tools call `getConfig()` directly instead of frozen context

**Locations (9 call sites):**
- `tools/process/execute-command.ts:16`
- `tools/process/read-output.ts:18`
- `tools/process/background-store.ts:14`
- `tools/search/grep.ts:12`
- `tools/types.ts:12`
- `tools/tool-worker.ts:2`
- `tools/web/fetch.ts:23`
- `tools/subagent/delegate.ts:22`
- `tools/index.ts:52`

Contradicts the documented "frozen `ToolExecutionContext`" principle. Tools should read config from the per-turn snapshot, not the process-wide mutable singleton.

**Suggestion:** Thread config through `ToolExecutionContext` and remove direct `getConfig()` imports from tool handlers.

---

## Minor Findings

| # | Finding | Location | Suggestion |
|---|---------|----------|------------|
| m1 | 4 deprecated type aliases with zero imports | `ast/indexer.ts:21`, `rag/indexer.ts:31`, `ast/store.ts:15`, `rag/store.ts:22` | Delete |
| m2 | `chat.css` dead file (10 lines, header-only) | `renderer/styles/chat.css` | Keep (growth-guarded by test) |
| m3 | Deprecated `providers` config field (~100 lines of sanitization code) | `config/schema.ts:54`, `config/loader.ts:66-128`, `config/validation.ts:80` | Schedule removal after migration guarantee |
| m4 | Dual `camelCase`/`snake_case` key support in storage dicts | `session.ts:63-88`, `chain.ts:85-109`, `subagent.ts:317-337` | Keep (Python compat), document sunset date |
| m5 | `Agent` vs `ManagedAgent` type duplication | `shared/types/agent.ts:42` vs `definitions.ts:27` | Use intersection: `ManagedAgent = Agent & { scope, path, overriddenByProject }` |
| m6 | `ChatStream.tsx` embeds 1,200+ lines of pure data transforms | `ChatStream.tsx:608-1395` | Extract to `utils/stream-building.ts` |
| m7 | Sidebar `IndexSection` owns IPC subscriptions | `Sidebar.tsx:597-649` | Move to a hook |
| m8 | 5 Preferences tabs call IPC directly (15 sites) | `AgentsTab`, `PersonalitiesTab`, `SkillsTab`, `PermissionsTab`, `ProjectConfigView` | Acceptable for now; extract if tabs grow |
| m9 | ESLint config minimal (no React, import, or a11y rules) | `eslint.config.mjs` | Add `eslint-plugin-react-hooks` at minimum |
| m10 | Only 10 `.test.tsx` files for 89 renderer components | `tests/` | Prioritize ChatView, Sidebar, ConfigView component tests |
| m11 | No E2E tests with real Electron | `tests/` | Add Playwright + Electron harness for IPC bridge + preload |
| m12 | 6 residual `#000` color-mix fallbacks in components.css | `components.css` | Trend to zero |
| m13 | Duplicated error-classification heuristics | `orchestrator.ts:1228` vs `error-classification.ts:34` | Consolidate into one classifier |
| m14 | Brittle sentinel matching in execute-command | `execute-command.ts:306,310` (`err.message === 'timeout'`) | Use typed error codes |
| m15 | ~16 silent `catch {}` blocks in tool-dispatch | `tool-dispatch.ts` (various) | Add structured logging or re-throw policy |

---

## Layering Violations Summary

| Violation | Evidence | Severity |
|-----------|----------|----------|
| Tool layer → IPC layer | `tools/subagent/delegate.ts:23` → `../../ipc/session` | Moderate |
| Domain (agents) → IPC layer | `agents/subagent-runner.ts:14` → `../ipc/session` | Moderate |
| Tool layer → global config singleton | 9 `getConfig()` call sites (see M9) | Moderate |
| Tool layer emits UI events / touches Electron | `tools/index.ts:142-147` (`BrowserWindow.getAllWindows()`) | Moderate |
| Tool layer → session storage | `tools/result-retrieval.ts:12` → `../session/storage` | Minor |
| LLM layer → agents | `llm/tool-dispatch.ts:36` imports value from `agents/manager` | Minor |

---

## What's Healthy (Do Not Change)

- **Electron security model** — contextIsolation, sandbox, channel allowlists, Zod validation at IPC boundary. Zero `any` types in renderer/preload/shared.
- **Styling architecture** — primitives-as-API, contract test enforcement, documented README, frozen `chat.css`. The healthiest subsystem.
- **Shared types organization** — clean domain separation, consistent `Interface → StorageDict → to/fromStorageDict()` patterns, no barrel coupling.
- **LLM layer isolation** — Electron-free, type-only cross-layer imports, clean middleware stack.
- **Test quality** — behavioral (not implementation-coupled), architecture property tests, style contract gate.
- **Dependency set** — 22 prod deps for LLM+MCP+RAG+AST+terminal+updater is lean. No abandoned packages.
- **Code hygiene** — zero TODO/FIXME/HACK comments across the entire `src/` tree.
- **Provider architecture** — code-owned drivers, encrypted vault, typed selections. No layering leaks.
- **MCP leasing** — per-project managers, no module-level singleton, clean lifecycle.

---

## Recommended Execution Order

| Priority | Action | Effort | Resolves |
|----------|--------|--------|----------|
| 1 | Move `SessionManager` singleton from `ipc/session.ts` → `session/` | Small (1–2h) | Circular dep, 3 layering violations, `createRequire` hacks |
| 2 | Extract `ChatView.tsx` into context providers + focused hooks | Medium (4–6h) | God component, prop drilling, data-fetching-in-layout |
| 3 | Split `registerChatIPC` into stream-translation / abort / checkpoint | Medium (4–6h) | #1 main-process bottleneck |
| 4 | Split `SubagentManager` into admission / projection / wait-settle | Medium (4–6h) | God class, testability |
| 5 | Extract `ChatStream.tsx` data transforms to utility module | Small (1–2h) | Low-risk clarity win |
| 6 | Create typed CustomEvent registry | Small (1h) | Silent string-typo bugs |
| 7 | Split `components.css` by surface area | Small (1h) | Documented debt |
| 8 | Split `shared/types/ipc.ts` into focused modules | Small (1–2h) | Type organization |
| 9 | Derive `ConfigPatch` from Zod schema | Small (30min) | Sync drift risk |
| 10 | Route tool config through `ToolExecutionContext` | Medium (3–4h) | Frozen-context invariant |

---

## File Size Reference

### Main Process — Top 10

| File | Lines |
|------|------:|
| `agents/manager.ts` | 2,122 |
| `ipc/chat.ts` | 2,120 |
| `llm/orchestrator.ts` | 1,262 |
| `llm/tool-dispatch.ts` | 1,029 |
| `session/manager.ts` | 930 |
| `ipc/providers.ts` | 909 |
| `session/storage.ts` | 860 |
| `tools/result.ts` | 806 |
| `mcp/manager.ts` | 734 |
| `ipc/session.ts` | 620 |

### Renderer — Top 10

| File | Lines |
|------|------:|
| `hooks/useChat.ts` | 1,551 |
| `components/ChatStream.tsx` | 1,395 |
| `components/ChatView.tsx` | 1,292 |
| `components/Sidebar.tsx` | 1,082 |
| `components/ConfigView.tsx` | 962 |
| `components/InputArea.tsx` | 811 |
| `components/Onboarding/OnboardingScreen.tsx` | 779 |
| `components/LeftSidebar.tsx` | 778 |
| `components/ProjectConfigView.tsx` | 762 |
| `components/CommandPalette.tsx` | 677 |
