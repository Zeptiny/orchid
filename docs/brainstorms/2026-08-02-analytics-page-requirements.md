---
title: Analytics Page
date: 2026-08-02
type: requirements
status: confirmed
---

# Analytics Page

## Summary

A full-screen analytics page — like ConfigView — that surfaces cost, usage, and operational telemetry from the provider accounting database. The page provides a global overview (spend, token trends, model distribution, outcome rates) with drill-down into individual sessions. The accounting schema is extended with new telemetry tables so all analytics data lives in a single database. The page loads on-demand snapshots; no live streaming.

---

## Problem Frame

Orchid already collects rich cost and usage data in the provider accounting ledger (`accounting.db`) — every LLM API call gets a durable row with token counts, monetary cost, timing, provider/model attribution, and outcome. But this data has zero UI surface: no IPC channel exposes it, no renderer component reads it. The sidebar shows only a cumulative token counter for the active session.

The user cannot answer questions like "how much have I spent this month?", "which model is most expensive per session?", "what's my cache hit rate?", or "how often do tool calls fail?" without manually querying the SQLite database. Additionally, several valuable metrics — tool-level attribution, agent tier distribution, context window growth — aren't collected at all.

---

## Data Schema

All data lives in `accounting.db`. The schema is clean-slate — no migration constraints.

### Table: `provider_attempts` (existing, may be redesigned)

Every LLM API call attempt (including retries and AI SDK tool-loop steps).

| Column | Type | Description |
|---|---|---|
| `attempt_id` | TEXT PK | Unique ID per API call attempt |
| `sdk_call_id` | TEXT | AI SDK call ID |
| `session_id` | TEXT | Session the call belongs to |
| `chain_id` | TEXT (nullable) | Chain within the session |
| `turn_id` | TEXT (nullable) | Turn within the session |
| `provider_id` | TEXT | Provider identifier (e.g. `openai`, `anthropic`) |
| `connection_id` | TEXT | UUID of the provider connection |
| `model_id` | TEXT | Model identifier (e.g. `gpt-4o`) |
| `protocol` | TEXT | Provider protocol type |
| `snapshot_json` | TEXT | Frozen request context — provider display name, connection name, model source, catalog version/source, full pricing snapshot (rates, inclusion semantics, provenance), field provenance, status observation |
| `outcome` | TEXT | `pending` / `succeeded` / `failed` / `interrupted` |
| `started_at` | TEXT (ISO) | When the API call started |
| `completed_at` | TEXT (ISO, nullable) | When the API call finished |
| `usage_json` | TEXT (nullable) | Normalized token usage (see below) |
| `provider_evidence_json` | TEXT | Allowlisted response headers, raw usage, provider-specific billing evidence |
| `cost_state` | TEXT | `reported` / `calculated` / `unknown` |
| `cost_source` | TEXT | `provider-reported` / `token-formula` / `energy-formula` / `unknown` |
| `currency` | TEXT (nullable) | 3-letter currency code |
| `cost_amount` | TEXT (nullable) | Decimal-string monetary cost |
| `error` | TEXT (nullable) | Redacted error message |
| **NEW** `agent_scope` | TEXT | `main` or subagent scope ID — distinguishes main-agent calls from subagent calls |
| **NEW** `agent_name` | TEXT (nullable) | Agent definition name (e.g. `general`, `reviewer`, `implementer`); null for main-agent calls unless the main agent name should also be tracked |
| **NEW** `agent_tier` | TEXT | Resolved model tier: `seed` / `sprout` / `bloom` / `crown` |
| **NEW** `agent_type` | TEXT (nullable) | Agent type from definition (e.g. `subagent`, `crown`, `bloom`) |

#### `usage_json` contains (NormalizedProviderUsage):

| Field | Description |
|---|---|
| `inputTokens` | Total input/prompt tokens |
| `outputTokens` | Total output/completion tokens |
| `totalTokens` | Sum of input + output |
| `cacheReadTokens` | Cache-read token count |
| `cacheWriteTokens` | Cache-write token count |
| `reasoningTokens` | Reasoning/thinking token count |

### Table: `tool_attempts` (NEW)

Every tool invocation — collected at the `executeToolCall` dispatch layer in `tool-dispatch.ts`.

| Column | Type | Description |
|---|---|---|
| `tool_attempt_id` | TEXT PK | Unique ID per tool invocation |
| `session_id` | TEXT | Session the tool call belongs to |
| `chain_id` | TEXT (nullable) | Chain within the session |
| `turn_id` | TEXT (nullable) | Turn within the session |
| `provider_attempt_id` | TEXT (nullable) | FK → `provider_attempts.attempt_id` — the LLM call that triggered this tool |
| `tool_call_id` | TEXT | The AI SDK tool call ID |
| `tool_name` | TEXT | Tool name (e.g. `read`, `edit`, `execute_command`, `delegate_to_subagent`) |
| `tool_source` | TEXT | `builtin` or `mcp` |
| `mcp_server_name` | TEXT (nullable) | MCP server name (when `tool_source = mcp`) |
| `tool_family` | TEXT | Result family: `file-change` / `file-write` / `file-content` / `directory-entries` / `search-results` / `generic` |
| `started_at` | TEXT (ISO) | When the tool started executing |
| `completed_at` | TEXT (ISO, nullable) | When the tool finished |
| `outcome` | TEXT | `complete` / `partial` / `empty` / `error` / `cancelled` |
| `result_size_bytes` | INTEGER (nullable) | Size of the agent-projected result content in bytes |
| `offloaded` | INTEGER | 0 or 1 — whether the result was offloaded to a cache file |
| `timeout_seconds` | INTEGER (nullable) | Effective timeout applied |
| `timed_out` | INTEGER | 0 or 1 — whether the tool timed out |
| `agent_scope` | TEXT | `main` or subagent scope ID |
| `error` | TEXT (nullable) | Redacted error message (when outcome is `error`) |

### Table: `context_snapshots` (NEW)

Context window state per turn — replaces the current per-message `ContextSnapshot` (which lives in session JSON) with a durable analytics record. Collected at the orchestrator where `buildContextSnapshot` is called.

| Column | Type | Description |
|---|---|---|
| `snapshot_id` | TEXT PK | Unique ID |
| `session_id` | TEXT | Session ID |
| `chain_id` | TEXT (nullable) | Chain within the session |
| `turn_id` | TEXT (nullable) | Turn within the session |
| `provider_attempt_id` | TEXT (nullable) | FK → `provider_attempts.attempt_id` |
| `captured_at` | TEXT (ISO) | When the snapshot was taken |
| `input_tokens` | INTEGER | Provider-reported aggregate input tokens |
| `output_tokens` | INTEGER | Provider-reported aggregate output tokens |
| `used_tokens` | INTEGER | Total used context tokens |
| `system_tokens` | INTEGER | Estimated system prompt tokens |
| `tools_tokens` | INTEGER | Estimated tool definition tokens |
| `tool_use_tokens` | INTEGER | Estimated tool result tokens in context |
| `user_tokens` | INTEGER | Estimated user message tokens |
| `assistant_tokens` | INTEGER | Estimated assistant message tokens |

### Table: `subagent_attribution` (NEW)

Links subagent LLM calls to their parent session and subagent identity. Populated when a subagent turn starts (in `subagent-runner.ts`).

| Column | Type | Description |
|---|---|---|
| `attribution_id` | TEXT PK | Unique ID |
| `subagent_id` | TEXT | Subagent record ID (the `agentScopeId`) |
| `session_id` | TEXT | Parent session ID |
| `chain_id` | TEXT | The subagent's chain ID (links to `provider_attempts.chain_id`) |
| `parent_chain_id` | TEXT (nullable) | The parent chain that spawned this subagent |
| `agent_name` | TEXT | Agent definition name (e.g. `reviewer`, `implementer`) |
| `agent_type` | TEXT | Agent type from definition (e.g. `crown`, `bloom`) |
| `agent_tier` | TEXT | Resolved model tier: `seed` / `sprout` / `bloom` / `crown` |
| `model_id` | TEXT | Resolved model ID (from the frozen selection) |
| `connection_id` | TEXT | Resolved connection ID |
| `started_at` | TEXT (ISO) | When the subagent started |
| `completed_at` | TEXT (ISO, nullable) | When the subagent finished |
| `status` | TEXT | `running` / `completed` / `failed` / `interrupted` |

---

## Page Structure

The Analytics page is a full-screen overlay like ConfigView. It has a left navigation rail (tab list) and a main content area. The left session sidebar from ChatView remains visible; the right inspector sidebar is not shown.

### Tabs

| Tab | Name | Description |
|---|---|---|
| 1 | **Overview** | Global stat cards + charts (cost, tokens, trends, distributions) |
| 2 | **Sessions** | Sortable per-session table with drill-down into Session Detail |
| 3 | **Models & Providers** | Per-model and per-provider breakdown tables + charts |
| 4 | **Tools** | Tool usage analytics (frequency, duration, success rate, result size) |
| 5 | **Subagents** | Per-subagent-name and per-agent-type breakdown |
| 6 | **Context** | Context window utilization over time, per session/turn |

---

## Tab 1: Overview

### Stat cards (top row)

| Card | Query source | Description |
|---|---|---|
| Total spend | `provider_attempts.cost_amount` (sum, grouped by currency) | Sum of known costs across all currencies, with unknown-count caveat |
| Total tokens | `usage_json.inputTokens + outputTokens` | Input + output tokens across all attempts |
| Total API calls | `provider_attempts` count | Succeeded / failed / interrupted breakdown shown as subtext |
| Avg cost / session | total spend / distinct `session_id` count | Average monetary cost per session |
| Avg tokens / session | total tokens / distinct `session_id` count | Average token usage per session |
| Cache hit rate | `sum(cacheReadTokens) / sum(inputTokens)` | Percentage of input tokens served from cache |
| Error rate | `(failed + interrupted) / total` attempts | Percentage of attempts that didn't succeed |
| Total sessions | distinct `session_id` count | Total number of sessions with attempts |

### Charts

| Chart | Type | Query source | Description |
|---|---|---|---|
| Spend over time | Line chart | `cost_amount` grouped by day/week/month | Trend of spending over time, with toggle for granularity (day/week/month) |
| Token usage over time | Stacked bar chart | `usage_json` fields grouped by day | Stacked: input / output / cache-read / cache-write / reasoning |
| Spend by model | Bar chart | `cost_amount` grouped by `model_id` | Horizontal bars sorted by spend descending |
| Spend by provider | Bar chart | `cost_amount` grouped by `provider_id` | Horizontal bars sorted by spend descending |
| Outcome distribution | Pie/donut chart | `outcome` counts | Succeeded / failed / interrupted |
| Cost source distribution | Pie/donut chart | `cost_source` counts | Provider-reported / calculated / unknown |
| Agent tier distribution | Bar chart | `agent_tier` counts on `provider_attempts` | seed / sprout / bloom / crown call counts |

---

## Tab 2: Sessions

### Session list table

Sortable, paginated table of all sessions that have `provider_attempts` rows.

| Column | Query source | Description |
|---|---|---|
| Session ID | `session_id` | Truncated UUID (clicking navigates to Session Detail) |
| Total cost | `cost_amount` sum for session | Formatted with currency |
| Input tokens | `usage_json.inputTokens` sum | |
| Output tokens | `usage_json.outputTokens` sum | |
| Total tokens | input + output | |
| Cache tokens | `cacheReadTokens` sum | |
| Attempts | row count | Total API calls |
| Succeeded | count where `outcome = succeeded` | |
| Failed | count where `outcome = failed` | |
| Interrupted | count where `outcome = interrupted` | |
| First attempt | `MIN(started_at)` | Session start (first API call) |
| Last attempt | `MAX(completed_at)` | Session end (last API call completion) |
| Duration | `MAX(completed_at) - MIN(started_at)` | Wall-clock duration |
| Models used | distinct `model_id` | Comma-separated or count badge |
| Subagents | count from `subagent_attribution` | Number of subagent invocations |

### Session Detail (drill-down)

Shown when a session row is clicked. Replaces the session table with a detail view.

**Summary card:**
- Session ID, total cost, total tokens, attempt count, outcome breakdown, duration, models used, providers used, subagent count

**Per-chain breakdown table:**

| Column | Description |
|---|---|
| Chain ID | `chain_id` (or "main" for null) |
| Agent name | `agent_name` (from `provider_attempts` or `subagent_attribution`) |
| Agent tier | `agent_tier` |
| Cost | `cost_amount` sum for this chain |
| Tokens | input + output sum |
| Attempts | row count |
| Outcome | succeeded/failed/interrupted counts |

**Per-attempt timeline table:**

| Column | Description |
|---|---|
| Attempt ID | `attempt_id` (truncated) |
| Started at | `started_at` |
| Model | `model_id` |
| Provider | `provider_id` |
| Outcome | `outcome` |
| Cost | `cost_amount` + `currency` |
| Input tokens | `usage_json.inputTokens` |
| Output tokens | `usage_json.outputTokens` |
| Cache read | `cacheReadTokens` |
| Cache write | `cacheWriteTokens` |
| Reasoning | `reasoningTokens` |
| Latency | `completed_at - started_at` (ms) |
| Agent scope | `main` or subagent ID |
| Agent name | `agent_name` |
| Error | `error` (when outcome is failed/interrupted) |

**Token breakdown chart:** Stacked bar or pie for this session — input / output / cache-read / cache-write / reasoning.

**Cost breakdown by model chart:** Bar chart — `cost_amount` grouped by `model_id` within this session.

**Tool calls table** (for this session, from `tool_attempts`):

| Column | Description |
|---|---|
| Tool name | `tool_name` |
| Source | `builtin` / `mcp` |
| MCP server | `mcp_server_name` (when applicable) |
| Started at | `started_at` |
| Duration | `completed_at - started_at` |
| Outcome | `complete` / `partial` / `empty` / `error` / `cancelled` |
| Result size | `result_size_bytes` |
| Offloaded | yes/no |
| Timed out | yes/no |
| Agent scope | `main` or subagent ID |

**Subagent breakdown panel** (R13a — for this session, from `subagent_attribution`):

| Column | Description |
|---|---|
| Subagent ID | `subagent_id` (truncated) |
| Agent name | `agent_name` (e.g. `reviewer`, `implementer`) |
| Agent type | `agent_type` |
| Agent tier | `agent_tier` |
| Model | `model_id` |
| Status | `running` / `completed` / `failed` / `interrupted` |
| Cost | sum of `provider_attempts.cost_amount` where `chain_id` matches |
| Tokens | sum of input + output tokens for matching attempts |
| Attempts | count of matching `provider_attempts` rows |
| Duration | `completed_at - started_at` |

Clicking a subagent row drills into that subagent's individual attempts (filtered per-attempt timeline).

---

## Tab 3: Models & Providers

### Per-model breakdown table

| Column | Description |
|---|---|
| Model ID | `model_id` |
| Provider | `provider_id` |
| Connection | `connection_id` (or display name from `snapshot_json.connectionName`) |
| Total cost | `cost_amount` sum |
| Input tokens | sum |
| Output tokens | sum |
| Cache read tokens | sum |
| Cache write tokens | sum |
| Reasoning tokens | sum |
| Attempts | count |
| Avg cost / attempt | total cost / attempt count |
| Cache hit rate | `sum(cacheReadTokens) / sum(inputTokens)` |
| Error rate | `(failed + interrupted) / total` |
| First used | `MIN(started_at)` |
| Last used | `MAX(completed_at)` |

### Per-provider breakdown table

| Column | Description |
|---|---|
| Provider ID | `provider_id` |
| Provider name | `snapshot_json.providerDisplayName` |
| Total cost | `cost_amount` sum |
| Total tokens | input + output sum |
| Attempts | count |
| Models | distinct `model_id` count |
| Connections | distinct `connection_id` count |
| Error rate | `(failed + interrupted) / total` |

### Charts

| Chart | Type | Description |
|---|---|---|
| Cost per model over time | Multi-line chart | One line per model, cost over time |
| Token usage per model | Grouped bar chart | Input/output/cache tokens per model |
| Cost per provider over time | Multi-line chart | One line per provider |

---

## Tab 4: Tools

### Tool usage summary table (from `tool_attempts`)

| Column | Description |
|---|---|
| Tool name | `tool_name` |
| Source | `builtin` / `mcp` |
| MCP server | `mcp_server_name` (when applicable) |
| Tool family | `tool_family` |
| Invocations | count |
| Complete | count where `outcome = complete` |
| Error | count where `outcome = error` |
| Cancelled | count where `outcome = cancelled` |
| Timeout | count where `timed_out = 1` |
| Success rate | `complete / total` |
| Avg duration | `AVG(completed_at - started_at)` |
| Avg result size | `AVG(result_size_bytes)` |
| Offload rate | `sum(offloaded) / total` |

### Charts

| Chart | Type | Description |
|---|---|---|
| Tool invocations over time | Stacked bar chart | Stacked by tool name, grouped by day |
| Tool duration distribution | Bar chart | Average duration per tool name |
| Tool outcome distribution | Pie/donut chart | complete / partial / empty / error / cancelled |
| Top tools by invocation count | Horizontal bar chart | Top 10 most-invoked tools |

### Tool detail (drill-down per tool name)

Filtered per-attempt table showing each individual invocation with timestamp, session, duration, outcome, result size, error.

---

## Tab 5: Subagents

### Per-agent-name summary table (from `subagent_attribution` + `provider_attempts`)

| Column | Description |
|---|---|
| Agent name | `agent_name` (e.g. `reviewer`, `implementer`) |
| Agent type | `agent_type` |
| Agent tier | `agent_tier` |
| Model(s) used | distinct `model_id` (from `provider_attempts` joined on `chain_id`) |
| Invocations | count of `subagent_attribution` rows |
| Total cost | sum of `cost_amount` for matching attempts |
| Total tokens | sum of input + output tokens |
| Attempts | count of `provider_attempts` rows linked |
| Completed | count where `status = completed` |
| Failed | count where `status = failed` |
| Interrupted | count where `status = interrupted` |
| Avg cost / invocation | total cost / invocation count |
| Avg tokens / invocation | total tokens / invocation count |
| Avg duration | `AVG(completed_at - started_at)` |

### Charts

| Chart | Type | Description |
|---|---|---|
| Cost per agent name | Bar chart | Total cost grouped by `agent_name` |
| Token usage per agent name | Grouped bar chart | Input/output tokens per agent name |
| Subagent invocations over time | Line chart | Count of subagent spawns over time |
| Subagent outcome distribution | Pie/donut chart | completed / failed / interrupted |
| Cost by agent tier | Bar chart | Total cost grouped by `agent_tier` |

---

## Tab 6: Context

### Context utilization table (from `context_snapshots`)

| Column | Description |
|---|---|
| Session ID | `session_id` |
| Chain ID | `chain_id` |
| Turn ID | `turn_id` |
| Captured at | `captured_at` |
| Used tokens | `used_tokens` |
| System | `system_tokens` |
| Tools | `tools_tokens` |
| Tool results | `tool_use_tokens` |
| User messages | `user_tokens` |
| Assistant messages | `assistant_tokens` |
| Input tokens | `input_tokens` |
| Output tokens | `output_tokens` |

### Charts

| Chart | Type | Description |
|---|---|---|
| Context growth per session | Line chart | `used_tokens` over `captured_at`, one line per session (selectable) |
| Context breakdown | Stacked bar chart | Average breakdown: system / tools / tool-results / user / assistant |
| Context fill % over time | Line chart | `used_tokens / max_context` (max from model metadata in `snapshot_json`) |

---

## Requirements

### Page and navigation

- R1. A full-screen Analytics page renders as a top-level view (like ConfigView), accessed via a button in the left sidebar and/or a keyboard shortcut / command palette entry.
- R2. The left session sidebar remains visible and functional when the Analytics page is open. The right inspector sidebar is not shown (it is chat-only).
- R3. The page has a left navigation rail with six tabs: Overview, Sessions, Models & Providers, Tools, Subagents, Context. The Overview tab is the landing view.
- R4. The page loads data on-demand when opened (or when switching tabs). There is no live streaming or auto-refresh. A manual refresh control re-queries the database.

### Data source

- R5. All analytics data is sourced exclusively from the accounting database (`accounting.db`). The page does not read session JSON files.
- R6. The accounting schema is extended with new telemetry tables (`tool_attempts`, `context_snapshots`, `subagent_attribution`) and new columns on `provider_attempts` (`agent_scope`, `agent_name`, `agent_tier`, `agent_type`). The existing `provider_attempts` table may be redesigned freely — there are no migration constraints on existing data.

### Telemetry collection

- R7. `provider_attempts` is extended with `agent_scope`, `agent_name`, `agent_tier`, `agent_type` columns. These are populated when the accounting context is created (in `ipc/chat/send.ts` for main agent, `agents/subagent-runner.ts` for subagents). The tier and agent name/type are already resolved at the call site; they just need to be written to the row.
- R8. A `tool_attempts` table records every tool invocation at the `executeToolCall` dispatch layer (`tool-dispatch.ts`). The tool name, tool call ID, session/chain/turn IDs, the triggering `provider_attempt_id`, tool source (builtin/mcp), MCP server name, tool family, timing, outcome, result size, offload status, timeout status, and error are recorded. A pending row is inserted before execution and finalized after, mirroring the existing `provider_attempts` pattern.
- R9. A `context_snapshots` table records context window state per turn at the orchestrator layer where `buildContextSnapshot` is called. Total used tokens, system/tools/tool-results/user/assistant token estimates, and provider-reported input/output tokens are recorded.
- R10. A `subagent_attribution` table links subagent LLM calls to their parent session and subagent identity (subagent ID, agent name, agent type, agent tier, parent chain ID, model ID, connection ID, lifecycle timestamps, status). This is populated when a subagent turn starts in `subagent-runner.ts`.
- R11. MCP tool invocations are recorded in `tool_attempts` (R8) with `tool_source = mcp` and the MCP server name.
- R12. File edit operations (`edit`, `write`, `apply_patch`) and command executions (`execute_command`) are recorded in `tool_attempts` (R8). No separate table is needed.

### Visualizations

- R13. A charting library is added to the renderer dependencies (the repo currently has none). The page uses stat cards (number + label), bar/line/pie charts, and sparklines for trend indicators. Sortable tables handle detailed breakdowns.

### Non-goals

- R14. No data export (CSV/JSON) in the initial version.
- R15. No live/real-time updates. The page is snapshot-based with manual refresh.
- R16. No modification of the right inspector sidebar or its existing Usage panel.
- R17. No reading of session JSON files for analytics. All data comes from the accounting database.
- R18. No Neuralwatt/Lilac-specific telemetry or energy metrics in the initial version (deferred to TODO.md). The initial scope targets standard token-based providers only.

---

## Key Decisions

- **Single database.** All analytics and telemetry data lives in `accounting.db`. No separate analytics database. The schema is extended with new tables and columns; the existing `provider_attempts` table may be redesigned freely.
- **Clean slate.** No migration concerns. The accounting schema can be restructured without preserving existing data or shapes.
- **On-demand snapshots.** The page queries the database when opened and on manual refresh. No IPC event streams, no live token/cost ticking.
- **Full-screen page like ConfigView.** The left session sidebar stays; the right inspector sidebar is chat-only and untouched.
- **Comprehensive telemetry (Approach 3).** Surface all existing accounting data plus collect new metrics: tool-level attribution, agent tier usage, subagent attribution, context snapshots, MCP usage, file edit/command frequency.
- **Charts + tables.** Stat cards and charts for at-a-glance overview; sortable tables for precise drill-down. A charting library will be added.
- **Exclusive DB sourcing.** The page reads only from the accounting database, not session JSON files. Metrics currently derivable only from session files (context snapshots, message counts) must be collected into the DB instead.
- **Generic providers only (initial version).** Neuralwatt/Lilac-specific telemetry (energy metrics, account quotas) is deferred. The initial scope targets standard token-based providers.
- **Six-tab structure.** Overview, Sessions, Models & Providers, Tools, Subagents, Context — each with dedicated stat cards, charts, and tables. Session Detail is a drill-down from the Sessions tab.

---

## Key Flows

- F1. Open Analytics from the left sidebar
  - **Trigger:** User clicks an Analytics button in the left sidebar (or uses a keyboard shortcut / command palette).
  - **Steps:** The Analytics page replaces the center pane (like ConfigView). The left sidebar remains. The Overview tab loads by default — stat cards and charts render from the on-demand snapshot of `accounting.db`.
  - **Outcome:** User sees global spend, token usage, trends, and breakdowns.
  - **Covered by:** R1, R2, R3, R4

- F2. Drill into a session
  - **Trigger:** User clicks a row in the Sessions tab table.
  - **Steps:** Session Detail view loads: summary card, per-chain breakdown, per-attempt timeline, token breakdown chart, cost-by-model chart, tool calls table, and subagent breakdown panel — all from the database snapshot for that `session_id`.
  - **Outcome:** User sees exactly how a session accrued cost and tokens, which models were used, which attempts failed, tool/subagent breakdowns.
  - **Covered by:** R3, R4

- F3. Drill into a subagent
  - **Trigger:** User clicks a subagent row in the Session Detail's subagent breakdown panel, or clicks a row in the Subagents tab.
  - **Steps:** Filtered per-attempt timeline showing that subagent's individual LLM calls.
  - **Outcome:** User sees per-subagent cost, tokens, model, and outcome details.
  - **Covered by:** R10

- F4. Switch tabs
  - **Trigger:** User clicks a tab in the left navigation rail.
  - **Steps:** The selected tab loads its data on-demand from `accounting.db`. Previous tab state is discarded (no caching across tabs in the initial version).
  - **Outcome:** User sees the selected analytics view.
  - **Covered by:** R3, R4

- F5. Refresh data
  - **Trigger:** User clicks the refresh control on the Analytics page.
  - **Steps:** The page re-queries `accounting.db` and re-renders the current tab with the latest data.
  - **Outcome:** The page reflects any new API calls, tool executions, or sessions since the last load.
  - **Covered by:** R4

- F6. Close Analytics and return to chat
  - **Trigger:** User clicks a close/back button or uses the keyboard shortcut.
  - **Steps:** The Analytics page unmounts; the center pane returns to the chat view. The right inspector sidebar reappears.
  - **Outcome:** User is back in the chat session.
  - **Covered by:** R1, R2

---

## Outstanding Questions

- **Charting library choice.** The repo has no charting dependency. Planning should evaluate lightweight options (Recharts, visx, or custom SVG). The choice affects bundle size and rendering approach.
- **Schema redesign scope.** Since the schema is clean-slate, should `provider_attempts` be restructured (e.g., normalized into separate tables for snapshots, pricing, usage) or kept as-is with new columns/tables added alongside?
- **Telemetry collection timing.** Should the new telemetry tables be populated synchronously during tool execution / LLM calls (like the existing pending-then-finalize pattern), or written asynchronously after completion?
- **IPC surface.** New IPC channels are needed to query analytics data from the renderer. Should there be one generic query channel with parameters, or dedicated channels per tab/view?
- **Pagination.** Some tables (per-session, per-attempt) could grow large. Should the initial version implement server-side pagination, or load all rows and paginate client-side?
