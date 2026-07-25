# Orchid Optimization and User Interface Review

**Review date:** 2026-07-24  
**Reviewed branch:** `feat/tool-permission-system`  
**Scope:** Maintained Electron application under `electron/`  
**Review type:** Report-only static audit with production build and targeted validation

## Executive Summary

The application has a sound overall architecture: heavy RAG and AST indexing work is
already moved to worker threads, provider and session data use shared renderer stores,
and many renderer subtrees are memoized. The remaining optimization opportunities are
concentrated in startup sequencing, long-session scaling, synchronous persistence,
and resource lifecycle management.

No source files were modified as part of the original audit. This document records
the findings and recommended implementation order.

## Severity Definitions

| Priority | Meaning |
| --- | --- |
| P0 | Critical failure, data loss, or security problem requiring immediate action |
| P1 | High-impact defect or performance problem likely to affect ordinary use |
| P2 | Meaningful issue that becomes visible under common growth or workload conditions |
| P3 | Lower-impact improvement, cleanup, or preventative optimization |

## Findings Overview

| ID | Priority | Area | Finding |
| --- | --- | --- | --- |
| F4 | P2 | Transcript scaling | Old chains are collapsed but not virtualized or aggregated |
| F5 | P2 | Persistence | Turn boundaries synchronously rewrite the complete session |
| F6 | P2 | Resource lifecycle | Short-lived RAG and AST stores can leave SQLite connections open |
| F8 | P3 | Startup state | Configuration and index status are fetched redundantly |
| F9 | P3 | Startup latency | Tool workers are initialized before the first application window |
| F10 | P3 | Renderer computation | Context usage is recomputed more often than necessary |
| F11 | P3 | Maintainability | Several UI modules and the shared component stylesheet are oversized |

---

## F4 — Long Transcripts Are Collapsed but Not Virtualized

**Priority:** P2  
**Area:** Long-session UI scalability

### Evidence

`CHAIN_COLLAPSE_THRESHOLD` limits fully mounted chain bodies to 20:

- [`electron/src/renderer/components/ChatStream.tsx`](electron/src/renderer/components/ChatStream.tsx#L53)

However, the history builder still iterates every chain. Each old chain is replaced by
an individual `collapsed-stub` item:

- [`electron/src/renderer/components/ChatStream.tsx`](electron/src/renderer/components/ChatStream.tsx#L571)

The resulting list is rendered as one mapped sequence:

- [`electron/src/renderer/components/ChatStream.tsx`](electron/src/renderer/components/ChatStream.tsx#L365)

For a 1,000-turn session, approximately 980 collapsed stub elements remain in the DOM.
The chain iteration and item allocation also remain O(n), even though most content is
visually collapsed.

### User Impact

Long-running project sessions can accumulate hundreds of turns. Likely symptoms are:

- Increasing session-load time.
- Slower transcript reconciliation.
- More memory retained by collapsed history.
- Slower scrolling through old turns.
- Larger costs when a memo dependency invalidates history.

### Recommendation

Use one or both of these approaches:

1. Aggregate old history into ranges, such as “Show 50 earlier turns.”
2. Virtualize transcript rows so only visible stubs and recent chains are mounted.

Keep the latest 20 chains fully mounted, but page older history in bounded groups.
Expanding a range should not mount every earlier turn at once.

### Suggested Verification

- Generate fixtures with 100, 500, and 1,000 chains.
- Measure session-open duration, rendered DOM node count, and scroll responsiveness.
- Verify live streaming remains pinned correctly after older history is loaded.

### Acceptance Criteria

- DOM node count remains bounded as chain count grows.
- Opening a 1,000-chain session does not render hundreds of collapsed stub elements.
- Expanding old history is incremental and reversible.

---

## F5 — Full Synchronous Session Rewrites at Turn Boundaries

**Priority:** P2  
**Area:** Main-process responsiveness and persistence scaling

### Evidence

`saveSession()` synchronously:

1. Updates the session row.
2. Deletes every chain row for the session.
3. Serializes and reinserts every chain and every chain's messages.

See [`electron/src/main/session/storage.ts`](electron/src/main/session/storage.ts#L327).

A complete save is performed when a chain starts:

- [`electron/src/main/session/manager.ts`](electron/src/main/session/manager.ts#L463)

A complete save is also performed when the active chain finishes:

- [`electron/src/main/session/manager.ts`](electron/src/main/session/manager.ts#L568)

These operations use synchronous `better-sqlite3` calls in the Electron main process.
The project already has a targeted `updateChain` persistence path for mid-turn message
updates, demonstrating that incremental writes are supported.

### User Impact

As session history grows, turn start and completion can take progressively longer.
Because persistence runs in the main process, the user may see:

- A short pause immediately after sending.
- A pause when a response completes.
- Delayed IPC handling or window responsiveness.
- Increasing cost across long-lived sessions.

The original audit did not run a native SQLite benchmark because the installed native
module was built for Electron's ABI rather than the shell Node ABI. The scaling issue
is nevertheless directly visible in the synchronous delete-and-reinsert algorithm.

### Recommendation

Replace full rewrites with incremental operations:

- On chain start: insert one new chain and update the session's
  `active_chain_id`/`updated_at`.
- On tool or message checkpoint: update only the active chain.
- On chain finish: update only that chain's status/messages/end time and clear
  `active_chain_id`.
- On rename, model, permission, or todo changes: update only the relevant session
  columns.
- Reserve full-session replacement for migrations or corruption recovery.

Prepare statements once per cached database connection where practical.

### Suggested Verification

- Add a benchmark using Electron's native runtime.
- Measure turn-start and turn-completion persistence for 20, 100, 250, and 1,000
  chains.
- Confirm persistence time depends mainly on the active chain, not total history.
- Add failure-injection tests around partial transactions.

### Acceptance Criteria

- Ordinary turn start and completion do not delete all session chains.
- Persistence cost is approximately constant with respect to historical chain count.
- Crash recovery and atomicity remain equivalent to the current transaction.

---

## F6 — RAG and AST Store Connections Are Not Consistently Disposed

**Priority:** P2  
**Area:** Resource lifecycle and long-running process stability

### Evidence

Both store classes cache an opened SQLite connection and explicitly document that
`dispose()` should be called when the store is no longer needed:

- [`electron/src/main/ast/store.ts`](electron/src/main/ast/store.ts#L103)
- [`electron/src/main/rag/store.ts`](electron/src/main/rag/store.ts#L271)

The AST status IPC handler creates a new store and returns its status without disposing
it:

- [`electron/src/main/ipc/ast.ts`](electron/src/main/ipc/ast.ts#L41)

RAG status does the same through `getStatus()`:

- [`electron/src/main/rag/indexer.ts`](electron/src/main/rag/indexer.ts#L511)

Other examples include:

- [`electron/src/main/tools/rag/search.ts`](electron/src/main/tools/rag/search.ts#L69)
- [`electron/src/main/tools/ast/find-symbol-references.ts`](electron/src/main/tools/ast/find-symbol-references.ts#L64)
- [`electron/src/main/tools/ast/rename-symbol.ts`](electron/src/main/tools/ast/rename-symbol.ts#L74)

By contrast, `ast_index` already uses the correct `try/finally` pattern:

- [`electron/src/main/tools/ast/index-tool.ts`](electron/src/main/tools/ast/index-tool.ts#L61)

### User Impact

The exact cleanup behavior may depend on garbage collection and the native module, but
cleanup is not deterministic. Repeated status refreshes and tool calls can retain:

- SQLite file descriptors.
- Native connection memory.
- WAL-related resources.
- File locks that complicate index clearing or replacement.

The chat UI invokes index status more than once during startup and again after
workspace or indexing changes, increasing the number of short-lived store instances.

### Recommendation

For one-shot operations, standardize this pattern:

```ts
const store = new ASTStore(projectPath);
try {
  return store.status();
} finally {
  store.dispose();
}
```

Alternatively, manage one store per project in a registry and dispose it when the
project runtime is superseded or the application shuts down. Do not mix unmanaged
one-shot stores and long-lived cached stores without an explicit ownership contract.

### Suggested Verification

- Add dispose expectations to RAG/AST IPC unit tests.
- Repeatedly call status and search while monitoring open file descriptors.
- Verify index clear/rebuild works after many status calls.

### Acceptance Criteria

- Every short-lived store is disposed through `finally`.
- Long-lived stores have an explicit owner and shutdown path.
- Unit tests fail if a one-shot IPC path omits disposal.

---

## F8 — Redundant Configuration and Status Fetches

**Priority:** P3  
**Area:** Startup efficiency and state ownership

### Evidence

`App` starts two independent functions that both call `config.get()`:

- One loads the theme.
- One checks onboarding status.

See [`electron/src/renderer/App.tsx`](electron/src/renderer/App.tsx#L27).

At the same time, the mounted `ChatView` performs another `config.get()`:

- [`electron/src/renderer/components/ChatView.tsx`](electron/src/renderer/components/ChatView.tsx#L202)

`ChatView` also calls `refreshIndex()` from the initial status effect and again from
the workspace-dependent effect on mount:

- [`electron/src/renderer/components/ChatView.tsx`](electron/src/renderer/components/ChatView.tsx#L862)
- [`electron/src/renderer/components/ChatView.tsx`](electron/src/renderer/components/ChatView.tsx#L867)

The configuration getter is currently an in-memory operation, so this is not a major
disk bottleneck. It is still duplicated IPC and produces multiple independent startup
state transitions.

### User Impact

- More renderer/main-process messages during startup.
- Additional renders as related configuration fields arrive separately.
- Harder-to-reason-about theme and onboarding sequencing.
- Duplicate RAG/AST status connections compound F6.

### Recommendation

Create a shared renderer bootstrap store containing:

- Effective configuration.
- Theme.
- Onboarding completion.
- Personality names if needed immediately.
- Initial workspace identity.

Load it once, then let `App`, `ChatView`, and onboarding subscribe to the same stable
snapshot. Coalesce index status refreshes by making the workspace effect the sole
initial trigger.

### Acceptance Criteria

- One effective configuration request is made during ordinary startup.
- Initial RAG/AST status is requested once per workspace.
- Theme and onboarding decisions derive from the same bootstrap snapshot.

---

## F9 — Tool Worker Pool Delays Window Creation

**Priority:** P3  
**Area:** Cold-start latency

### Evidence

The default tool worker pool size is two:

- [`electron/src/main/config/schema.ts`](electron/src/main/config/schema.ts#L120)

Application startup awaits worker-pool readiness before registering IPC and creating
the first window:

- [`electron/src/main/index.ts`](electron/src/main/index.ts#L260)
- [`electron/src/main/index.ts`](electron/src/main/index.ts#L287)

Each worker loads configuration and creates the complete built-in tool registry before
reporting ready:

- [`electron/src/main/tools/tool-worker.ts`](electron/src/main/tools/tool-worker.ts#L29)

### User Impact

Worker initialization adds to time before any window appears, even though users cannot
execute a tool before the renderer loads and they send a message.

The actual delay should be measured before assigning a hard latency target.

### Recommendation

- Create the window and register essential IPC first.
- Initialize the worker pool concurrently after first paint.
- Keep inline execution as the temporary fallback until workers are ready, or gate only
  the first tool execution rather than the entire window.
- Add startup timing marks around each initialization stage.

### Acceptance Criteria

- Worker readiness is not on the critical path to first window display.
- A message sent unusually early still executes tools correctly.
- Worker initialization failure continues to fall back safely.

---

## F10 — Context Usage Is Recomputed More Often Than Necessary

**Priority:** P3  
**Area:** Long-session renderer computation

### Evidence

`useChat` computes `contextBreakdown` from all messages and usage:

- [`electron/src/renderer/hooks/useChat.ts`](electron/src/renderer/hooks/useChat.ts#L416)

The returned value is not currently consumed by `ChatView`; the sidebar instead passes
the original messages and usage to `ContextGrid`.

Within `ContextGrid`, the stacked bar and legend each independently call
`computeBreakdown()`:

- [`electron/src/renderer/components/ContextGrid.tsx`](electron/src/renderer/components/ContextGrid.tsx#L248)
- [`electron/src/renderer/components/ContextGrid.tsx`](electron/src/renderer/components/ContextGrid.tsx#L348)

Fallback calculation scans the messages several times using filters and reductions:

- [`electron/src/renderer/components/ContextGrid.tsx`](electron/src/renderer/components/ContextGrid.tsx#L121)

`cumulativeUsageFromMessages()` also resums persisted message usage whenever
`currentTurnUsage` changes:

- [`electron/src/renderer/hooks/useChat.ts`](electron/src/renderer/hooks/useChat.ts#L422)

### User Impact

This is small for short sessions but grows with message count. It contributes to
sidebar and usage-update cost in long conversations.

### Recommendation

- Remove the unused `contextBreakdown` calculation or use it as the shared source.
- Compute one `TokenBreakdown` in `ContextGrid` and pass it to the bar and legend.
- Memoize persisted message usage only on `messages`.
- Add current-turn usage to that cached persisted total separately.
- Replace multiple filter/reduce passes with one message traversal where fallback
  estimation is required.

### Acceptance Criteria

- Context breakdown is computed once per relevant input snapshot.
- Current-turn usage changes do not rescan all persisted messages.

---

## F11 — Oversized UI Modules Increase Optimization Risk

**Priority:** P3  
**Area:** Maintainability and performance ownership

### Evidence

Current approximate file sizes:

| File | Lines |
| --- | ---: |
| `styles/components.css` | 2,259 |
| `hooks/useChat.ts` | 1,377 |
| `components/ChatStream.tsx` | 1,337 |
| `components/ChatView.tsx` | 1,225 |
| `components/Sidebar.tsx` | 1,084 |

The project instructions specifically recommend splitting `components.css` by surface
after it crosses approximately 2,000 lines.

Large modules are not automatically slow, but they make it harder to:

- Establish narrow memoization boundaries.
- Lazy-load optional surfaces.
- Test rendering and state transitions in isolation.
- Identify ownership of high-frequency state.
- Prevent unrelated changes from invalidating large components.

### Recommendation

Split by stable product boundaries rather than extracting generic helpers:

- `ChatView`: shell/navigation orchestration, active-chat surface, modal/overlay state.
- `ChatStream`: history construction, live-tail construction, transcript viewport.
- `Sidebar`: todos, subagents, context/usage, workspace index, MCP.
- `useChat`: event affinity, stream accumulator, hydration, commands.
- `components.css`: chat, config, onboarding, provider, and session surface files.

Preserve the existing primitive styling contract and cascade order while splitting
CSS.

---

## Recommended Implementation Order

### Phase 1 — Startup

1. Introduce one bootstrap configuration snapshot.
2. Move worker-pool readiness off the first-window critical path.
3. Add startup performance marks and bundle-size reporting.

### Phase 2 — Long-Running Session Stability

1. Replace full session rewrites with incremental chain persistence.
2. Standardize RAG/AST store ownership and disposal.
3. Aggregate or virtualize old transcript history.
4. Consolidate context and cumulative-usage computation.

### Phase 3 — Structural Cleanup

1. Split oversized UI modules along the boundaries above.
2. Split `components.css` while preserving cascade behavior.
3. Add performance budgets to CI only after representative baselines exist.

## Suggested Performance Budgets

These should be finalized using measurements on supported hardware:

| Metric | Suggested initial target |
| --- | --- |
| Transcript DOM size | Bounded independently of total chain count |
| Turn-boundary persistence | Approximately constant with historical chain count |

## Validation Performed

The following checks passed during the audit:

```text
npm run build:renderer
npm run typecheck
npm run lint
npx vitest run \
  tests/unit/chat-rendering-contract.test.ts \
  tests/integration/chat-sidebar.test.ts \
  tests/integration/renderer-motion-contract.test.ts
```

Results:

- Production renderer build passed.
- TypeScript typecheck passed.
- ESLint passed.
- Three focused test files passed.
- 112 focused tests passed.

## Review Limitations

- This was primarily a source-level audit, not a Chrome Performance panel capture.
- No representative provider stream was profiled in a packaged Electron build.
- No visual smoke test across all themes and supported window sizes was performed.
- The full native test suite was not run as part of this report.
- Persistence timing was not benchmarked because the installed `better-sqlite3`
  binary targeted Electron's ABI rather than the shell Node runtime.

These limitations do not invalidate the direct algorithmic and layout findings, but
runtime measurements should be captured before and after implementation to quantify
the gains.
