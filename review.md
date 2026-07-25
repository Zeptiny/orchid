# Orchid Optimization and User Interface Review

**Review date:** 2026-07-24  
**Reviewed branch:** `feat/tool-permission-system`  
**Scope:** Maintained Electron application under `electron/`  
**Review type:** Report-only static audit with production build and targeted validation

## Executive Summary

The application has a sound overall architecture: heavy RAG and AST indexing work is
already moved to worker threads, provider and session data use shared renderer stores,
and many renderer subtrees are memoized. The remaining optimization opportunities are
concentrated in narrow-window behavior, startup loading, long-session scaling, and
synchronous persistence.

The most important remaining finding is that the application window may be resized to
800 pixels even though the expanded three-column shell requires at least 1,020 pixels.
Because the root hides overflow, part of the interface can become inaccessible at
supported window sizes.

The production renderer currently builds as a single 1.053 MB minified JavaScript
chunk (286.74 KB gzip). Route-level code splitting would reduce startup parsing and
memory use, particularly for settings and onboarding surfaces that are not needed in
every session.

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
| F2 | P1 | Responsive UI | Supported window sizes are narrower than the shell's minimum layout |
| F3 | P2 | Startup | The renderer ships as one large JavaScript chunk |
| F4 | P2 | Transcript scaling | Old chains are collapsed but not virtualized or aggregated |
| F5 | P2 | Persistence | Turn boundaries synchronously rewrite the complete session |
| F6 | P2 | Resource lifecycle | Short-lived RAG and AST stores can leave SQLite connections open |
| F7 | P2 | Hidden UI | Chat rendering continues while Settings hides the chat surface |
| F8 | P3 | Startup state | Configuration and index status are fetched redundantly |
| F9 | P3 | Startup latency | Tool workers are initialized before the first application window |
| F10 | P3 | Renderer computation | Context usage is recomputed more often than necessary |
| F11 | P3 | Maintainability | Several UI modules and the shared component stylesheet are oversized |

---

## F2 — Narrow Windows Can Clip the Three-Panel Interface

**Priority:** P1  
**Area:** Responsive layout and UI accessibility

### Evidence

The `BrowserWindow` allows a minimum width of 800 pixels:

- [`electron/src/main/index.ts`](electron/src/main/index.ts#L184)

The expanded application shell requires:

- Left rail: 260 pixels
- Center: minimum 460 pixels
- Right inspector: 300 pixels

Total minimum expanded width: **1,020 pixels**

See:

- [`electron/src/renderer/components/ChatView.tsx`](electron/src/renderer/components/ChatView.tsx#L971)
- [`electron/src/renderer/styles/exceptions.css`](electron/src/renderer/styles/exceptions.css#L92)

The application roots use hidden overflow. The responsive rule below 980 pixels only
sets `min-width: 0`; it does not change the grid tracks, collapse either sidebar, or
turn a sidebar into an overlay:

- [`electron/src/renderer/styles/components.css`](electron/src/renderer/styles/components.css#L1734)

### User Impact

At widths between 800 and 1,019 pixels, the CSS grid cannot satisfy all three tracks.
Depending on Chromium's grid resolution, this can compress, overflow, or clip parts of
the shell. Since overflow is hidden, controls in the right inspector or center chat
may become unreachable rather than horizontally scrollable.

This is especially relevant on:

- Small laptops.
- Tiled window-manager layouts.
- Half-screen window snapping.
- High display scaling.

### Recommendation

Prefer responsive behavior over increasing the window minimum:

- Below approximately 1,020 pixels, automatically collapse the right inspector.
- At a narrower breakpoint, collapse the left session rail.
- Allow either panel to open as an overlay drawer when space is constrained.
- Keep the central transcript at a usable minimum width.
- Preserve the existing manual collapse controls and keyboard shortcuts.

As a short-term safeguard, raising `minWidth` to 1,020 would prevent the broken state,
but it would make the application less useful on smaller screens.

### Suggested Verification

Test the shell at:

- 800×600
- 900×700
- 1,020×700
- 1,200×800
- 150% and 200% display scaling

At every size, verify that:

- The composer and send/cancel controls remain reachable.
- Session navigation remains available.
- The inspector can be opened and closed.
- No content is clipped without an alternative navigation path.

### Acceptance Criteria

- Every width accepted by `BrowserWindow.minWidth` produces a fully operable shell.
- Sidebars never push required center controls outside the visible window.
- Automatic responsive collapse does not overwrite the user's stored preference once
  adequate space returns.

---

## F3 — Single Large Renderer Bundle

**Priority:** P2  
**Area:** Startup time and renderer memory

### Evidence

The production build generated:

```text
dist/renderer/assets/index-*.js    1,052.89 kB
gzip size                            286.74 kB
```

Vite emitted its large-chunk warning.

There are no renderer `React.lazy()` or dynamic `import()` boundaries. The root
statically imports Settings and Onboarding:

- [`electron/src/renderer/App.tsx`](electron/src/renderer/App.tsx#L6)

`ChatView` statically imports project configuration, command palette, shortcut help,
and the full subagent view:

- [`electron/src/renderer/components/ChatView.tsx`](electron/src/renderer/components/ChatView.tsx#L29)

`ConfigView` statically imports every settings tab:

- [`electron/src/renderer/components/ConfigView.tsx`](electron/src/renderer/components/ConfigView.tsx#L11)

### User Impact

Because this is Electron, network download size is not the main concern. The costs are:

- JavaScript parsing and compilation on every application launch.
- Module initialization for surfaces the user may not open.
- Higher initial renderer memory.
- More work before the first interactive chat screen.

### Recommendation

Introduce lazy boundaries in this order:

1. `ConfigView`
2. `OnboardingScreen`
3. `ProjectConfigView`
4. `SubagentView`
5. Individual settings tabs
6. Provider connection wizard and model-management dialogs

The first-run decision should be resolved from one bootstrap configuration read. Once
the application knows whether onboarding is required, it can load the appropriate
surface instead of eagerly loading both onboarding and the complete chat shell.

Use small loading placeholders that match the target surface dimensions to avoid
layout movement.

### Suggested Verification

- Compare production bundle output before and after splitting.
- Record time to renderer first paint and first interaction.
- Confirm opening a lazy surface does not introduce a blank frame.
- Confirm settings tab switching still preserves unsaved draft state.

### Acceptance Criteria

- The initial chat JavaScript chunk is materially smaller.
- Settings and onboarding compile into separate chunks.
- Lazy loading does not reset chat, session, or configuration state.

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

## F7 — Hidden Chat Continues Performing Renderer Work

**Priority:** P2  
**Area:** Settings interaction and background rendering

### Evidence

When Settings opens, the application intentionally keeps `ChatView` mounted to
preserve session and draft state. It only applies the `hidden` class:

- [`electron/src/renderer/App.tsx`](electron/src/renderer/App.tsx#L108)

This prevents layout and paint for the hidden subtree, but React hooks, IPC event
subscriptions, streaming state updates, transcript construction, Markdown parsing,
and timers continue to run.

The same general concern applies when onboarding covers the chat surface.

### User Impact

If a response continues while the user is in Settings:

- CPU remains devoted to an invisible transcript.
- Configuration interaction may feel less responsive.
- Large hidden streaming responses still pay Markdown and transcript preparation
  costs.

### Recommendation

Separate chat runtime state from visible chat presentation:

- Keep IPC subscriptions and authoritative live state in a shared store.
- Pass an `isVisible`/`isActive` flag to the chat surface.
- When hidden, avoid rendering `ChatStream`, `Sidebar`, and other expensive transcript
  consumers.
- On return, render once from the current snapshot and anchor scroll position.

If React's offscreen capabilities are adopted later, confirm that they actually defer
the relevant work in the Electron/React version in use.

### Acceptance Criteria

- Background chat continues correctly while Settings is open.
- Hidden transcript components do not parse or highlight each streaming update.
- Returning to chat displays the complete current response without replaying every
  intermediate chunk.

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

### Phase 1 — Responsive Shell

1. Define responsive sidebar behavior.
2. Implement automatic collapse or overlay drawers below 1,020 pixels.
3. Test all supported minimum sizes and display scaling.

### Phase 2 — Startup

1. Introduce one bootstrap configuration snapshot.
2. Lazy-load Settings, onboarding, project configuration, and subagent surfaces.
3. Move worker-pool readiness off the first-window critical path.
4. Add startup performance marks and bundle-size reporting.

### Phase 3 — Long-Running Session Stability

1. Replace full session rewrites with incremental chain persistence.
2. Standardize RAG/AST store ownership and disposal.
3. Aggregate or virtualize old transcript history.
4. Consolidate context and cumulative-usage computation.

### Phase 4 — Structural Cleanup

1. Split oversized UI modules along the boundaries above.
2. Split `components.css` while preserving cascade behavior.
3. Add performance budgets to CI only after representative baselines exist.

## Suggested Performance Budgets

These should be finalized using measurements on supported hardware:

| Metric | Suggested initial target |
| --- | --- |
| Initial renderer JavaScript | Material reduction from the current 1.053 MB chunk |
| Transcript DOM size | Bounded independently of total chain count |
| Turn-boundary persistence | Approximately constant with historical chain count |
| Supported minimum width | No clipped or unreachable controls at 800 px |

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
- The production build emitted a large-chunk warning.

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
