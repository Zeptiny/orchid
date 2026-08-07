---
title: "feat: Analytics Page"
date: 2026-08-02
type: feat
status: draft
origin: docs/brainstorms/2026-08-02-analytics-page-requirements.md
---

# feat: Analytics Page

## Problem Frame

Orchid's provider accounting ledger (`accounting.db`) records every LLM API call with token counts, monetary cost, timing, and provider/model attribution — but this data has zero UI surface. Users cannot answer "how much have I spent?", "which model is most expensive?", or "what's my cache hit rate?" without manually querying SQLite. Additionally, tool-level metrics, agent tier distribution, context window growth, and subagent attribution are not collected at all.

This plan implements a full-screen Analytics page (like ConfigView) that surfaces existing accounting data and extends the telemetry layer to collect new metrics — all stored in `accounting.db`.

(See origin: `docs/brainstorms/2026-08-02-analytics-page-requirements.md`)

## Planning Decisions

- **Charting library: Recharts.** Added as a renderer dependency. Supports React 19, covers all needed chart types (line, bar, pie, stacked bar). The repo has no existing charting dependency.
- **Schema approach: extend, don't restructure.** Keep `provider_attempts` as-is with new columns added alongside. New tables (`tool_attempts`, `context_snapshots`, `subagent_attribution`) are added to the same DB. Restructuring `provider_attempts` into normalized tables would add complexity without clear benefit — the existing row-per-attempt model works well for analytics queries.
- **Telemetry collection timing: pending-then-finalize for tool_attempts** (mirrors the existing `provider_attempts` pattern — pending row before execution, finalize after). Context snapshots and subagent attribution are written at their natural completion points (after the step finishes / after the subagent completes).
- **IPC surface: dedicated analytics IPC module.** Follows the existing domain pattern (each domain has its own `ipc/<domain>.ts`). One module with per-view query handlers rather than a generic query channel — matches the existing convention and allows Zod-validated response schemas per view.
- **Pagination: client-side with a row cap.** Queries return all rows up to a configurable cap (default 1000). The renderer paginates client-side. Server-side pagination deferred.
- **Agent metadata threading:** Extend `ProviderAttemptAccountingContext` with optional `agentScope`, `agentName`, `agentType`, `agentTier` fields. The middleware already spreads `{ ...context }` into `insertPending`, so adding fields to the context interface + the two construction sites (`send.ts`, `subagent-runner.ts`) + the store's INSERT statement is the lowest-friction path.

## Scope Boundaries

- **In scope:** Schema extension, telemetry collection at four points, aggregate query methods, IPC surface, Analytics page with six tabs, Recharts integration.
- **Out of scope (deferred to TODO.md):** Neuralwatt/Lilac energy metrics, data export (CSV/JSON), live/real-time updates, server-side pagination, session JSON file reading.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA COLLECTION LAYER                        │
│                                                                      │
│  ipc/chat/send.ts ──── ProviderAttemptAccountingContext ──────────┐ │
│  agents/subagent-runner.ts ────── (extended with agent metadata) ──┤ │
│                          │                                          │ │
│          providers/accounting/middleware.ts                        │ │
│               insertPending → finalize                              │ │
│                          │                                          │ │
│  llm/tool-dispatch.ts ─── ToolAttemptStore (pending → finalize) ◄──┤ │
│  llm/orchestrator.ts ─── ContextSnapshotStore (post-step)           │ │
│  agents/manager.ts ──── SubagentAttributionStore (start → done)   │ │
│                          │                                          │ │
│                    accounting.db (single SQLite DB)                │ │
│  ┌──────────────────────┬───────────────┬────────────────────────┐ │ │
│  │ provider_attempts   │ tool_attempts │ context_snapshots       │ │ │
│  │ + agent_scope       │               │ subagent_attribution    │ │ │
│  │ + agent_name        │               │                         │ │ │
│  │ + agent_tier        │               │                         │ │ │
│  │ + agent_type        │               │                         │ │ │
│  └──────────────────────┴───────────────┴────────────────────────┘ │ │
└─────────────────────────────────────────────────────────────────────┘
                                      │
                    Aggregate Query Methods
                                      │
┌─────────────────────────────────────────────────────────────────────┐
│                           IPC LAYER                                  │
│  ipc/analytics.ts ── registerAnalyticsIPC() ── registered in        │
│  ipc/index.ts        Channels: analytics:overview,                  │
│                       analytics:sessions, analytics:session-detail, │
│                       analytics:models, analytics:tools,             │
│                       analytics:subagents, analytics:context        │
│  preload/index.ts ── window.orchid.analytics.*                      │
└─────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────────────────────────────────────┐
│                          RENDERER LAYER                             │
│  AppReady.tsx ── analyticsOpen state (mirrors configOpen)          │
│  LeftSidebar.tsx ── Analytics button (mirrors Settings button)    │
│  components/AnalyticsView.tsx ── full-screen page                  │
│    ├── OverviewTab.tsx    ├── SessionsTab.tsx                      │
│    ├── ModelsProvidersTab.tsx  ├── ToolsTab.tsx                    │
│    ├── SubagentsTab.tsx   ├── ContextTab.tsx                       │
│    └── SessionDetail.tsx (drill-down from Sessions)                │
│  hooks/useAnalytics.ts ── data fetching + state                    │
│  components/analytics/ ── StatCard, ChartCard, SortableTable        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Data Layer

### U1. Extend accounting schema, shared types, and store

**Goal:** Add new tables (`tool_attempts`, `context_snapshots`, `subagent_attribution`) and new columns on `provider_attempts` (`agent_scope`, `agent_name`, `agent_tier`, `agent_type`) to the accounting database schema and store.

**Requirements:** R5, R6 (see origin)

**Dependencies:** None

**Files:**
- `electron/src/main/providers/accounting/schema.ts` — add new tables + columns to schema SQL
- `electron/src/shared/types/accounting.ts` — add new types: `ToolAttemptRecord`, `ContextSnapshotRecord`, `SubagentAttributionRecord`; extend `ProviderAttemptRecord` with agent metadata fields
- `electron/src/main/providers/accounting/store.ts` — extend `InsertPendingAttemptInput` and `AttemptRow` with agent metadata; add new store classes or methods for tool attempts, context snapshots, subagent attribution; update `rowToRecord`
- `electron/src/main/providers/accounting/tool-attempt-store.ts` — new file: `ToolAttemptStore` class (pending → finalize pattern, mirrors `ProviderAccountingStore`)
- `electron/src/main/providers/accounting/context-snapshot-store.ts` — new file: `ContextSnapshotStore` class (simple insert)
- `electron/src/main/providers/accounting/subagent-attribution-store.ts` — new file: `SubagentAttributionStore` class (insert + finalize)

**Approach:**
- The schema is clean-slate (no migration). Bump `ACCOUNTING_SCHEMA_VERSION` to 2. Add new columns to the `provider_attempts` CREATE TABLE and the new table definitions to `ACCOUNTING_SCHEMA_SQL`.
- `ToolAttemptStore` mirrors `ProviderAttemptAccountingStore`: `insertPending` (before tool execution), `finalize` (after), `recoverPending` (crash recovery), `listBySession`, `listByTool`. Uses the same `SqliteDatabase` connection (same DB file).
- `ContextSnapshotStore` is a simple insert-only store — no pending/finalize needed since snapshots are complete when written.
- `SubagentAttributionStore` has `insert` (at subagent start) and `finalize` (at subagent completion — update status/timestamp).
- All new stores share the same `accounting.db` file path. Initialize them alongside `initializeProviderAccountingStore` in `electron/src/main/index.ts`.

**Patterns to follow:**
- `electron/src/main/providers/accounting/store.ts` — the `ProviderAccountingStore` class is the direct pattern for `ToolAttemptStore` (pending/finalize/recover, `connection()` lazy init, `json()` sanitizer)
- `electron/src/main/utils/sqlite.ts` — `openSqliteDb` with `recovery: 'preserve'`

**Test scenarios:**
- `electron/tests/integration/accounting-schema.test.ts` — verify new tables exist with correct columns and indexes
- `electron/tests/integration/tool-attempt-store.test.ts` — pending → finalize lifecycle; crash recovery marks pending as interrupted; `listBySession` / `listByTool` return correct rows
- `electron/tests/integration/context-snapshot-store.test.ts` — insert + query by session/turn
- `electron/tests/integration/subagent-attribution-store.test.ts` — insert → finalize lifecycle; query by session; query by agent name

**Verification:** Schema creates cleanly; all new store classes pass their integration tests; existing accounting tests still pass.

---

### U2. Telemetry — agent metadata on provider attempts

**Goal:** Thread `agent_scope`, `agent_name`, `agent_tier`, `agent_type` through the accounting context into `provider_attempts` rows.

**Requirements:** R7 (see origin)

**Dependencies:** U1

**Files:**
- `electron/src/main/providers/accounting/middleware.ts` — extend `ProviderAttemptAccountingContext` interface with optional `agentScope`, `agentName`, `agentType`, `agentTier`
- `electron/src/main/providers/accounting/store.ts` — extend `InsertPendingAttemptInput` to accept the new fields; update the `INSERT INTO provider_attempts` SQL to include the new columns; update `rowToRecord` to map them
- `electron/src/main/ipc/chat/send.ts` — add `agentScope: 'main'`, `agentName: agent.name`, `agentType: agent.type`, `agentTier: agent.tier` to the accounting context literal (around line 163)
- `electron/src/main/agents/subagent-runner.ts` — add `agentScope: params.agentScopeId`, `agentName: params.agent.name`, `agentType: params.agent.type`, `agentTier: params.agent.tier` to the accounting context literal (around line 172)
- `electron/src/main/ipc/chat/title.ts` — add agent metadata to the title generation accounting context (if applicable)

**Approach:**
- The middleware already spreads `{ ...context }` into `insertPending`, so adding fields to the context interface automatically flows them through. The store's `insertPending` must be updated to write the new columns.
- All new fields are optional (nullable in the DB) so existing call sites that don't provide them won't break.
- The `agentScope` for the main agent is the literal `'main'`; for subagents it's `params.agentScopeId` (the subagent record ID).

**Patterns to follow:**
- The existing `ProviderAttemptAccountingContext` construction in `send.ts:163-165` and `subagent-runner.ts:172-178`

**Test scenarios:**
- Extend `electron/tests/integration/provider-attempt-accounting.test.ts` — verify agent metadata is persisted on both main-agent and subagent attempt rows
- Verify rows with missing agent metadata (null) don't cause errors

**Verification:** A chat turn produces `provider_attempts` rows with `agent_scope = 'main'`, `agent_name = 'general'`, `agent_tier = 'bloom'` (or whatever the resolved tier is). A subagent turn produces rows with the subagent's agent name/type/tier.

---

### U3. Telemetry — tool attempts collection

**Goal:** Record every tool invocation in the `tool_attempts` table using a pending → finalize pattern at the `executeToolCall` dispatch layer.

**Requirements:** R8, R11, R12 (see origin)

**Dependencies:** U1

**Files:**
- `electron/src/main/llm/tool-dispatch.ts` — insert pending tool attempt before handler execution (before line ~347); finalize after the finalization pipeline (after line ~440). Capture: tool name, tool call ID, session/chain/turn IDs, provider attempt ID, tool source (builtin/mcp), MCP server name, tool family, timing, outcome, result size, offload status, timeout status, error.
- `electron/src/main/providers/accounting/tool-attempt-store.ts` — (created in U1) — add `getProviderToolAttemptStore()` singleton accessor + `initializeToolAttemptStore()` init function
- `electron/src/main/index.ts` — call `initializeToolAttemptStore()` alongside `initializeProviderAccountingStore()`

**Approach:**
- **Pending insertion point:** In `executeToolCall`, after permission/AGENTS.md checks pass and before the handler executes (around line 347). At this point, `request.name`, `request.id`, `options.sessionId`, `options.agentScopeId`, `registered.definition.resultFamily`, `registered.definition.category`, and the effective timeout are all available. The `provider_attempt_id` (the LLM call that triggered this tool) should be threaded from the orchestrator — add it to `ToolDispatchOptions` as an optional field.
- **Finalize point:** After the finalization pipeline completes (around line 440). At this point, `execution.canonical.status`, `execution.canonical.family`, `execution.agentProjection.content.length`, and `execution.agentProjection.retrieval?.kind` (offload indicator) are available.
- Tool source (builtin vs mcp): MCP tools have names prefixed with `mcp::` and are registered with `rawInputJsonSchema`. Check `registered.definition.rawInputJsonSchema !== undefined` or the tool name prefix. Extract MCP server name from the tool name (e.g. `mcp::context7::resolve-library-id` → server `context7`).
- **Non-blocking:** Telemetry failures must not break tool execution. Wrap insertion/finalization in try-catch and log warnings on failure (same pattern as AGENTS.md enforcement — degrade gracefully).

**Patterns to follow:**
- The pending → finalize pattern in `providers/accounting/middleware.ts` (`createAttemptAccountingMiddleware`)
- The graceful degradation pattern in `tool-dispatch.ts` AGENTS.md enforcement (lines 273-302)

**Test scenarios:**
- `electron/tests/integration/tool-attempt-telemetry.test.ts` — verify a tool call produces a pending then finalized row with correct tool name, outcome, timing, result size, offload status
- Verify MCP tool invocations are tagged with `tool_source = mcp` and the correct server name
- Verify timed-out tools have `timed_out = 1`
- Verify cancelled tools have `outcome = cancelled`
- Verify telemetry failure does not break tool execution

**Verification:** After a chat turn with tool calls, `tool_attempts` rows exist with correct metadata matching the tools that were invoked.

---

### U4. Telemetry — context snapshots and subagent attribution

**Goal:** Record context window state per turn in `context_snapshots`, and record subagent identity/lifecycle in `subagent_attribution`.

**Requirements:** R9, R10 (see origin)

**Dependencies:** U1

**Files:**
- `electron/src/main/llm/orchestrator.ts` — after `buildStepUsage` produces a `Usage` with `context` (around line 256), insert a context snapshot record. Available data: `sessionId`, `agentScopeId`, `accounting.chainId`, `accounting.turnId`, the `ContextSnapshot` fields, and `accounting.snapshot` for the provider attempt link.
- `electron/src/main/agents/subagent-runner.ts` — at the accounting context construction point (line ~172), insert a `subagent_attribution` row with: subagent ID (`params.agentScopeId`), session ID, chain ID, parent chain ID (from `params` — may need to thread from the delegating tool), agent name/type/tier, model ID (`selection.modelId`), connection ID (from `execution.snapshot.connectionId`), started_at.
- `electron/src/main/agents/manager.ts` — in `_applyAssemblerFinalization` (around line 1431-1445), finalize the subagent attribution row with status and completed_at.
- `electron/src/main/providers/accounting/context-snapshot-store.ts` — (created in U1) — add singleton accessor
- `electron/src/main/providers/accounting/subagent-attribution-store.ts` — (created in U1) — add singleton accessor
- `electron/src/main/index.ts` — initialize the new stores

**Approach:**
- **Context snapshots:** The `buildStepUsage` function already computes a `ContextSnapshot` per step. Insert it into the store right after it's computed. The `accounting` context provides `chainId`/`turnId`. Non-blocking (try-catch, log on failure).
- **Subagent attribution — insert:** At the point where the subagent's accounting context is built (`subagent-runner.ts:172`), insert the attribution row. The `parent_chain_id` needs to be threaded from the delegating `delegate_to_subagent` tool call — add it as an optional param to `SubagentStreamRunner` params.
- **Subagent attribution — finalize:** In `manager.ts` `_applyAssemblerFinalization`, update the attribution row with the final status (`completed`/`failed`/`interrupted`) and `completed_at` timestamp. The subagent ID (`record.id`) is the key.
- Both stores share the same `accounting.db` file.

**Patterns to follow:**
- The accounting context construction in `subagent-runner.ts:172-178`
- The finalization pattern in `manager.ts` `_applyAssemblerFinalization`

**Test scenarios:**
- `electron/tests/integration/context-snapshot-telemetry.test.ts` — verify context snapshots are inserted per LLM step with correct token breakdown
- `electron/tests/integration/subagent-attribution-telemetry.test.ts` — verify attribution row is inserted at subagent start and finalized at completion with correct status
- Verify telemetry failures do not break the orchestrator or subagent runner

**Verification:** After a chat turn, `context_snapshots` rows exist matching the number of LLM steps. After a subagent delegation, a `subagent_attribution` row exists with correct agent name/type/tier/model and is finalized with the correct status.

---

## Phase 2: Query & IPC Layer

### U5. Aggregate query methods

**Goal:** Add aggregate query methods to the accounting stores that power the analytics page's six tabs.

**Requirements:** R5, R6 (see origin — data source exclusivity from `accounting.db`)

**Dependencies:** U1, U2, U3, U4

**Files:**
- `electron/src/main/providers/accounting/store.ts` — add aggregate query methods to `ProviderAccountingStore`
- `electron/src/main/providers/accounting/tool-attempt-store.ts` — add aggregate query methods
- `electron/src/main/providers/accounting/context-snapshot-store.ts` — add query methods
- `electron/src/main/providers/accounting/subagent-attribution-store.ts` — add query methods
- `electron/src/shared/types/analytics.ts` — new file: result type interfaces for analytics queries (e.g. `OverviewStats`, `SessionSummary`, `ModelBreakdown`, `ToolBreakdown`, `SubagentBreakdown`, `ContextSnapshotSummary`)

**Approach:**
- **Overview stats:** Single query aggregating total cost (grouped by currency), total tokens (sum of `usage_json` fields), attempt counts by outcome, distinct session count, cache hit rate. Returns an `OverviewStats` object.
- **Time-series queries:** Group by day/week/month using SQLite `strftime` on `started_at`. Returns arrays of `{ date, cost, tokens }` for charts.
- **Per-session breakdown:** `GROUP BY session_id` with sums of cost/tokens, counts by outcome, min/max timestamps for duration.
- **Per-model/provider breakdown:** `GROUP BY model_id` / `GROUP BY provider_id` with similar aggregates.
- **Tool breakdown:** `GROUP BY tool_name` on `tool_attempts` with count, outcome distribution, avg duration, avg result size, offload rate.
- **Subagent breakdown:** Join `subagent_attribution` with `provider_attempts` on `chain_id` to compute per-agent-name cost/tokens/attempts.
- **Context snapshots:** Query by session for growth-over-time charts.
- All queries use prepared statements on the existing SQLite connection. Decimal arithmetic for costs uses `Decimal.js` (already a dependency).
- Row cap: queries that return per-row results (session list, attempt timeline, tool invocations) accept an optional `limit` parameter (default 1000).

**Patterns to follow:**
- The existing `totals()` private method in `store.ts` (lines 302-332) — uses `Decimal` for cost summation, handles unknown costs
- The `listAttempts()` method pattern

**Test scenarios:**
- `electron/tests/integration/analytics-queries.test.ts` — seed the store with known data, verify each aggregate query returns correct results
- Verify cost aggregation handles mixed currencies correctly
- Verify time-series grouping produces correct buckets
- Verify row cap is enforced
- Verify empty database returns zero/empty results without errors

**Verification:** All aggregate query methods return correctly computed results for seeded test data.

---

### U6. IPC surface

**Goal:** Add IPC channels for analytics queries, register handlers, and expose them via the preload bridge.

**Requirements:** R4 (on-demand data loading from the renderer)

**Dependencies:** U5

**Files:**
- `electron/src/shared/types/ipc.ts` — add `ANALYTICS_OVERVIEW`, `ANALYTICS_SESSIONS`, `ANALYTICS_SESSION_DETAIL`, `ANALYTICS_MODELS`, `ANALYTICS_TOOLS`, `ANALYTICS_SUBAGENTS`, `ANALYTICS_CONTEXT` to `IPC_CHANNELS`; add to `ALLOWED_INVOKE_CHANNELS`; add `analytics` member to `OrchidAPI` interface
- `electron/src/shared/types/ipc-schemas.ts` — add Zod schemas for analytics query params and response payloads
- `electron/src/main/ipc/analytics.ts` — new file: `registerAnalyticsIPC()` / `unregisterAnalyticsIPC()` — handlers for each channel, calling the aggregate query methods from U5
- `electron/src/main/ipc/index.ts` — call `registerAnalyticsIPC()` in `registerAllIPC()` and `unregisterAnalyticsIPC()` in `unregisterAllIPC()`
- `electron/src/preload/index.ts` — add `analytics` object to `orchidAPI` with methods mapping to the new channels

**Approach:**
- Seven invoke channels, one per analytics view:
  - `analytics:overview` — no params, returns `OverviewStats` + chart data arrays
  - `analytics:sessions` — optional `{ sortBy, sortDir, limit }`, returns `SessionSummary[]`
  - `analytics:session-detail` — `{ sessionId }`, returns full session detail (attempts, chains, tool calls, subagent breakdown)
  - `analytics:models` — no params, returns `ModelBreakdown[]` + `ProviderBreakdown[]` + chart data
  - `analytics:tools` — no params, returns `ToolBreakdown[]` + chart data
  - `analytics:subagents` — no params, returns `SubagentBreakdown[]` + chart data
  - `analytics:context` — optional `{ sessionId? }`, returns `ContextSnapshotSummary[]` + chart data
- Each handler validates input with Zod, calls the store query methods, validates output shape, returns the result.
- The preload `analytics` object exposes one method per channel: `analytics.overview()`, `analytics.sessions(params)`, etc.

**Patterns to follow:**
- `electron/src/main/ipc/providers.ts` — handler registration pattern (`ipcMain.handle`, Zod `safeParse`, `ipcMain.removeHandler`)
- `electron/src/main/ipc/index.ts` — registration/cleanup pattern
- `electron/src/preload/index.ts` — `invoke<T>()` pattern

**Test scenarios:**
- `electron/tests/unit/analytics-ipc.test.ts` — mock `ipcMain`, verify handlers are registered, verify they call the correct store methods, verify input validation rejects bad params
- Verify unregistered channels are not accessible
- Verify response shapes match the Zod schemas

**Verification:** `window.orchid.analytics.overview()` returns analytics data from the renderer. All seven channels are registered and callable.

---

## Phase 3: UI Layer

### U7. Analytics page shell + Overview tab

**Goal:** Create the Analytics page as a full-screen overlay (like ConfigView), wire it into AppReady, add an Analytics button to LeftSidebar, and implement the Overview tab with stat cards + charts.

**Requirements:** R1, R2, R3, R4, R13 (see origin)

**Dependencies:** U6

**Files:**
- `electron/package.json` — add `recharts` dependency
- `electron/src/renderer/AppReady.tsx` — add `analyticsOpen` state (mirrors `configOpen`); add lazy import for `AnalyticsView`; conditionally render `AnalyticsView` overlay (mirrors the ConfigView pattern); when analytics is open, chat is hidden
- `electron/src/renderer/components/LeftSidebar.tsx` — add `onOpenAnalytics?: () => void` prop; render an Analytics button alongside the Settings button in both collapsed and expanded states
- `electron/src/renderer/components/ChatView.tsx` — pass `onOpenAnalytics` to `LeftSidebar` (thread from AppReady)
- `electron/src/renderer/components/AnalyticsView.tsx` — new file: full-screen page with left tab navigation rail, header with refresh + close controls, and a main content area that renders the active tab. Mirrors ConfigView's shell structure.
- `electron/src/renderer/components/analytics/OverviewTab.tsx` — new file: stat cards row (8 cards) + charts grid (7 charts using Recharts)
- `electron/src/renderer/components/analytics/StatCard.tsx` — new file: reusable stat card component (label + value + optional subtext)
- `electron/src/renderer/components/analytics/ChartCard.tsx` — new file: reusable chart wrapper (title + Recharts component)
- `electron/src/renderer/components/analytics/SortableTable.tsx` — new file: reusable sortable table with column headers and row click handling
- `electron/src/renderer/hooks/useAnalytics.ts` — new file: data fetching hook that calls `window.orchid.analytics.*` methods, manages loading/error/refresh state

**Approach:**
- **AppReady pattern:** Add `const [analyticsOpen, setAnalyticsOpen] = useState(false)`. When `analyticsOpen` is true, render `<AnalyticsView>` as an overlay (same pattern as ConfigView — `<ErrorBoundary>` + `<Suspense>`). ChatView stays mounted underneath with `hidden` class. Add an `orchid:open-analytics` event handler (mirrors `orchid:open-settings`).
- **LeftSidebar:** Add `onOpenAnalytics` prop. In the collapsed rail, add an `<IconButton>` with a chart/analytics icon below the Settings button. In the expanded footer, add a `<Button>` beside Settings. Use existing UI primitives (Button, IconButton) per AGENTS.md styling rules.
- **AnalyticsView shell:** A grid layout with a left navigation rail (six tab buttons) and a main content area. The left rail uses the same `CollapseBlock` / tab pattern as ConfigView. A header bar with "Analytics" title, a refresh button, and a close button (Esc key). `useFocusTrap` for accessibility (same as ConfigView).
- **Overview tab:** Calls `window.orchid.analytics.overview()` on mount. Renders 8 `StatCard` components in a grid, then 7 `ChartCard` components (Recharts `LineChart`, `BarChart`, `PieChart`). Stat cards show formatted values (currency, token counts with k/M suffixes, percentages). Charts use the existing theme tokens for colors.
- **useAnalytics hook:** Generic hook: `useAnalytics<T>(fetcher: () => Promise<T>)` — manages `{ data, loading, error, refresh }`. Called per-tab with the appropriate fetcher.

**Patterns to follow:**
- `electron/src/renderer/components/ConfigView.tsx` — full-screen overlay shell, tab navigation, focus trap, close on Esc
- `electron/src/renderer/AppReady.tsx` — overlay mounting pattern (lazy import, conditional render, ChatView hidden underneath)
- `electron/src/renderer/components/LeftSidebar.tsx` — button placement pattern in collapsed/expanded states
- Existing UI primitives: `Button`, `IconButton`, `Alert`, `StateMessage`

**Test scenarios:**
- `electron/tests/integration/analytics-shell.test.tsx` — verify AnalyticsView renders when `analyticsOpen` is true; verify tab switching works; verify close button calls `onClose`
- `electron/tests/unit/overview-tab.test.tsx` — verify stat cards render with correct values from mock data; verify charts render without crashing
- Verify the Analytics button in LeftSidebar calls `onOpenAnalytics`

**Verification:** Clicking the Analytics button in the left sidebar opens the full-screen Analytics page. The Overview tab shows stat cards and charts. Esc or the close button returns to chat.

---

### U8. Sessions tab + Session Detail

**Goal:** Implement the Sessions tab (sortable session list table) and Session Detail drill-down view.

**Requirements:** R3 (see origin — Sessions tab + Session Detail)

**Dependencies:** U6, U7

**Files:**
- `electron/src/renderer/components/analytics/SessionsTab.tsx` — new file: sortable, paginated table of sessions. Columns per the requirements doc. Clicking a row navigates to Session Detail.
- `electron/src/renderer/components/analytics/SessionDetail.tsx` — new file: full session breakdown — summary card, per-chain table, per-attempt timeline table, token breakdown chart, cost-by-model chart, tool calls table, subagent breakdown panel. Has a back button to return to the session list.

**Approach:**
- **SessionsTab:** Calls `window.orchid.analytics.sessions()` on mount. Renders a `SortableTable` with 16 columns. Client-side sorting (click column header to sort). Client-side pagination (20 rows/page). The "Session ID" column is clickable and calls `onSelectSession(sessionId)`.
- **SessionDetail:** Calls `window.orchid.analytics.sessionDetail({ sessionId })` on mount. Renders:
  - Summary card (session ID, total cost, tokens, attempts, outcomes, duration, models, subagents)
  - Per-chain breakdown `SortableTable` (7 columns)
  - Per-attempt timeline `SortableTable` (15 columns)
  - Token breakdown pie chart (Recharts `PieChart`)
  - Cost by model bar chart (Recharts `BarChart`)
  - Tool calls `SortableTable` (10 columns)
  - Subagent breakdown `SortableTable` (10 columns) — clicking a row filters the per-attempt table to that subagent's chain
- A back button at the top returns to the Sessions tab.

**Patterns to follow:**
- The `SortableTable` component from U7
- ConfigView's tab content rendering pattern

**Test scenarios:**
- `electron/tests/unit/sessions-tab.test.tsx` — verify table renders with mock data; verify sorting changes row order; verify row click calls the select handler
- `electron/tests/unit/session-detail.test.tsx` — verify all sub-components render with mock data; verify back button works; verify subagent row click filters the attempt table

**Verification:** The Sessions tab shows a table of all sessions. Clicking a row opens Session Detail with all breakdown tables and charts. The back button returns to the session list.

---

### U9. Models & Providers + Tools tabs

**Goal:** Implement the Models & Providers tab and the Tools tab.

**Requirements:** R3 (see origin — Models & Providers tab, Tools tab)

**Dependencies:** U6, U7

**Files:**
- `electron/src/renderer/components/analytics/ModelsProvidersTab.tsx` — new file: per-model breakdown table (15 columns), per-provider breakdown table (9 columns), 3 charts (cost per model over time, token usage per model, cost per provider over time)
- `electron/src/renderer/components/analytics/ToolsTab.tsx` — new file: tool usage summary table (13 columns), 4 charts (invocations over time, duration distribution, outcome distribution, top tools by count), per-tool drill-down table

**Approach:**
- **ModelsProvidersTab:** Calls `window.orchid.analytics.models()` on mount. Renders two `SortableTable` components and 3 `ChartCard` components. The per-model table shows model ID, provider, connection, cost, token breakdown, attempts, avg cost, cache hit rate, error rate, first/last used.
- **ToolsTab:** Calls `window.orchid.analytics.tools()` on mount. Renders a `SortableTable` (13 columns) and 4 `ChartCard` components. Clicking a tool name filters a detail table showing individual tool invocations.

**Patterns to follow:**
- The `SortableTable` and `ChartCard` components from U7
- The Overview tab's chart rendering pattern

**Test scenarios:**
- `electron/tests/unit/models-providers-tab.test.tsx` — verify both tables render with mock data; verify sorting
- `electron/tests/unit/tools-tab.test.tsx` — verify table and charts render; verify tool name click filters the detail table

**Verification:** The Models & Providers tab shows per-model and per-provider tables with charts. The Tools tab shows tool usage analytics with charts and drill-down.

---

### U10. Subagents + Context tabs

**Goal:** Implement the Subagents tab and the Context tab.

**Requirements:** R3 (see origin — Subagents tab, Context tab)

**Dependencies:** U6, U7

**Files:**
- `electron/src/renderer/components/analytics/SubagentsTab.tsx` — new file: per-agent-name summary table (14 columns), 5 charts (cost per agent name, token usage per agent name, invocations over time, outcome distribution, cost by agent tier)
- `electron/src/renderer/components/analytics/ContextTab.tsx` — new file: context utilization table (11 columns), 3 charts (context growth per session, context breakdown, context fill % over time)

**Approach:**
- **SubagentsTab:** Calls `window.orchid.analytics.subagents()` on mount. Renders a `SortableTable` (14 columns) and 5 `ChartCard` components. The table groups by agent name and shows type, tier, models used, invocations, cost, tokens, outcome breakdown, averages.
- **ContextTab:** Calls `window.orchid.analytics.context()` on mount. Renders a `SortableTable` (11 columns) and 3 `ChartCard` components. The context growth chart uses a Recharts `LineChart` with one line per session (selectable via a dropdown). The fill % chart computes `used_tokens / max_context` where max_context comes from the model metadata in `snapshot_json`.

**Patterns to follow:**
- The `SortableTable` and `ChartCard` components from U7
- The Overview tab's chart rendering pattern

**Test scenarios:**
- `electron/tests/unit/subagents-tab.test.tsx` — verify table and charts render with mock data; verify sorting
- `electron/tests/unit/context-tab.test.tsx` — verify table and charts render; verify session selector filters the growth chart

**Verification:** The Subagents tab shows per-agent-name analytics with charts. The Context tab shows context utilization with growth and breakdown charts.

---

## Risks

- **Performance with large datasets.** Aggregate queries on `accounting.db` with thousands of attempts could be slow. Mitigation: add indexes on `started_at`, `model_id`, `provider_id`, `tool_name` in the new schema. Row caps on list queries. Defer to Phase 2 if needed.
- **Telemetry collection failure breaking tool execution.** All telemetry insertion points must be non-blocking (try-catch, log on failure). The existing AGENTS.md enforcement in `tool-dispatch.ts` already follows this pattern.
- **Recharts bundle size.** Recharts adds ~100KB gzipped to the renderer bundle. Acceptable for a feature-rich analytics page. Mitigation: lazy-load `AnalyticsView` (already planned via `lazy()` in AppReady).
- **Shared SQLite connection contention.** All new stores share `accounting.db`. SQLite handles concurrent reads well but writes are serialized. Telemetry writes are infrequent (one per tool call / LLM step) so contention is minimal. Use `WAL` journal mode (already set by `openSqliteDb`).

## Deferred Implementation Questions

- **Server-side pagination.** If client-side pagination is insufficient for large datasets, add `LIMIT/OFFSET` to list queries in a follow-up.
- **Data retention policy.** Should old analytics data be pruned after N days/months? Not needed for the initial version but worth considering for long-term DB size management.
- **Theme-aware chart colors.** Recharts needs explicit colors; the renderer has multiple themes. Chart colors should derive from CSS custom properties — this may require a custom theme mapping layer.
