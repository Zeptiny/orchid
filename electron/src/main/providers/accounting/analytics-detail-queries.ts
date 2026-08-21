/**
 * Analytics drill-down queries — the heavy per-triple/per-session views routed
 * through the worker thread by default (see analytics-query-runner.ts):
 * the model explorer, the subagent explorer, and the Context session
 * drill-down + picker. All of these stay re-exported from
 * `analytics-queries.ts`, the stable import surface for the worker, runner,
 * IPC, and tests. This module also owns the subagent attribution ↔ attempt
 * run-window join fragments shared with the aggregate `getSubagents` view.
 */
import Decimal from 'decimal.js';
import {
  CONTEXT_DETAIL_MAX_POINTS,
  SUBAGENT_DETAIL_MAX_INVOCATIONS,
  TTFT_BUCKET_MAX_MS,
  TTFT_BUCKET_MS,
} from '../../../shared/types/analytics';
import type {
  AnalyticsTimeRange,
  ModelDetailResult,
  TtftHistogramBucket,
  TtftOverTimePoint,
  SubagentAnalyticsDetailResult,
  ContextSessionDetailResult,
  ContextSessionsResult,
  ContextEvent,
  ContextJumpEvent,
} from '../../../shared/types/analytics';
import {
  COST_ROW_CONDITIONS,
  DecimalTotal,
  type AnalyticsQueryContext,
  type AttemptDetailRow,
  type LatencySampleRow,
  bumpCurrencyTotal,
  buildDateFilter,
  emptyLatencySamples,
  getDb,
  iterateRows,
  latencyRowColumns,
  latencyRowGating,
  nestedCurrencyMap,
  parseCostAmount,
  parseUsage,
  percentile,
  recordLatencySample,
  resolveManySessionNames,
  sessionNameResolver,
  summarizeLatency,
  toAttemptDetail,
  toCurrencyTotals,
  whereClause,
} from './analytics-query-shared';

const MODEL_DETAIL_TOP_SESSIONS = 10;
const MODEL_DETAIL_RECENT_ATTEMPTS = 50;
const CONTEXT_DETAIL_MAX_EVENTS = 10;

// ── Subagent attribution ↔ attempt joins ──────────────────────────────────────

/**
 * Follow-up runs share one chain (record.chain.id is stable) while each run
 * inserts its own attribution row — so attempts must be attributed to the run
 * whose window contains them. Joining by chain alone would multiply usage,
 * cost, and latency once per run sharing the chain. The first run's window is
 * unbounded below so chain attempts recorded before the earliest attribution
 * row (e.g. recovery-reconstructed attributions) still count once.
 */
export function subagentRunWindows(filteredSaCte: string): string {
  return `
    run_windows AS (
      SELECT sa.subagent_id, sa.agent_name, sa.agent_type, sa.agent_tier,
        sa.session_id, sa.chain_id, sa.model_id, sa.started_at, sa.completed_at, sa.status,
        LAG(sa.started_at) OVER (PARTITION BY sa.chain_id ORDER BY sa.started_at, sa.subagent_id) as prev_started_at,
        LEAD(sa.started_at) OVER (PARTITION BY sa.chain_id ORDER BY sa.started_at, sa.subagent_id) as next_started_at
      FROM (${filteredSaCte}) sa
    )`;
}

export const ATTEMPT_RUN_WINDOW_JOIN = 'pa.chain_id = rw.chain_id'
  + ' AND (rw.prev_started_at IS NULL OR pa.started_at >= rw.started_at)'
  + ' AND (rw.next_started_at IS NULL OR pa.started_at < rw.next_started_at)';

/** Per-run usage sums: window-attributed attempts, one row per attribution run. */
export function subagentRunUsage(filteredAttempts: string): string {
  return `
    run_usage AS (
      SELECT rw.subagent_id, rw.chain_id, rw.started_at, rw.model_id,
        COUNT(pa.attempt_id) as attempts,
        COALESCE(SUM(json_extract(pa.usage_json, '$.inputTokens')), 0) as input_tokens,
        COALESCE(SUM(json_extract(pa.usage_json, '$.outputTokens')), 0) as output_tokens
      FROM run_windows rw LEFT JOIN (${filteredAttempts}) pa ON ${ATTEMPT_RUN_WINDOW_JOIN}
      GROUP BY rw.subagent_id, rw.chain_id, rw.started_at, rw.model_id
    )`;
}

export const RUN_USAGE_JOIN = 'ru.subagent_id = sa.subagent_id AND ru.chain_id = sa.chain_id AND ru.started_at = sa.started_at';

/**
 * Model explorer drill-down for one (model_id, provider_id, connection_id)
 * triple: stat aggregates, TTFT distribution + daily percentiles, stacked net
 * token series, daily cost, top sessions, and the most recent attempts.
 */
export function getModelDetail(
  input: { modelId: string; providerId: string; connectionId: string; timeRange?: AnalyticsTimeRange },
  ctx?: AnalyticsQueryContext,
): ModelDetailResult {
  const db = getDb(ctx);
  const dateFilter = buildDateFilter(input.timeRange);
  // Every query below is scoped to the triple, then the shared date filter.
  const tripleConditions = ['model_id = ?', 'provider_id = ?', 'connection_id = ?'];
  const tripleParams: string[] = [input.modelId, input.providerId, input.connectionId];
  const tripleWhere = (extraConditions: readonly string[] = []) =>
    whereClause([...tripleConditions, ...extraConditions], dateFilter.clause);

  const stats = db.prepare(`
    SELECT COUNT(*) as attempts,
      COALESCE(SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END), 0) as succeeded,
      COALESCE(SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END), 0) as interrupted,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) as cache_write_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens,
      MIN(started_at) as first_used,
      MAX(completed_at) as last_used
    FROM provider_attempts ${tripleWhere()}
  `).get(...tripleParams, ...dateFilter.params) as {
    attempts: number; succeeded: number; failed: number; interrupted: number;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_write_tokens: number; reasoning_tokens: number;
    first_used: string; last_used: string | null;
  };

  const totalCostMap = new Map<string, DecimalTotal>();
  for (const row of iterateRows<{ currency: string; cost_amount: string }>(db, `
    SELECT currency, cost_amount
    FROM provider_attempts
    ${tripleWhere(COST_ROW_CONDITIONS)}
  `, [...tripleParams, ...dateFilter.params])) {
    bumpCurrencyTotal(totalCostMap, row.currency, parseCostAmount(row.cost_amount));
  }

  // One pass over the first-token rows feeds the overall summary, the
  // histogram, and the daily percentile series.
  const latencySamples = emptyLatencySamples();
  const dailyTtft = new Map<string, number[]>();
  for (const row of iterateRows<LatencySampleRow & { date: string }>(db, `
    SELECT strftime('%Y-%m-%d', started_at) as date, ${latencyRowColumns()}
    FROM provider_attempts
    ${tripleWhere(latencyRowGating())}
  `, [...tripleParams, ...dateFilter.params])) {
    const ttftMs = recordLatencySample(latencySamples, row);
    // Same validity rule as the aggregate: clock-skewed (negative) or
    // non-finite spans are dropped from the daily percentiles too.
    if (Number.isFinite(ttftMs) && ttftMs >= 0) {
      const day = dailyTtft.get(row.date) ?? [];
      day.push(ttftMs);
      dailyTtft.set(row.date, day);
    }
  }
  const latency = summarizeLatency(latencySamples);

  const histogramMap = new Map<number, number>();
  for (const ttftMs of latencySamples.ttftMs) {
    const bucketMs = Math.min(
      TTFT_BUCKET_MAX_MS,
      Math.floor(ttftMs / TTFT_BUCKET_MS) * TTFT_BUCKET_MS,
    );
    histogramMap.set(bucketMs, (histogramMap.get(bucketMs) ?? 0) + 1);
  }
  const ttftHistogram: TtftHistogramBucket[] = [...histogramMap.entries()]
    .map(([bucketMs, count]) => ({ bucketMs, count }))
    .sort((a, b) => a.bucketMs - b.bucketMs);

  const ttftOverTime: TtftOverTimePoint[] = [...dailyTtft.keys()].sort((a, b) => a.localeCompare(b))
    .map((date) => {
      const sorted = [...dailyTtft.get(date)!].sort((a, b) => a - b);
      return {
        date,
        medianTtftMs: percentile(sorted, 50) ?? 0,
        p95TtftMs: percentile(sorted, 95) ?? 0,
        attempts: sorted.length,
      };
    });

  // Stacked net-token series — net values strip the cache/reasoning share so
  // the four buckets never double-count (clamped at 0 in SQL). json_extract is
  // COALESCEd because SQLite's scalar MAX() returns NULL when any argument is
  // NULL — a missing usage key must count as 0, not drop the whole row.
  const tokenRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date,
      COALESCE(SUM(MAX(0, COALESCE(json_extract(usage_json, '$.inputTokens'), 0) - COALESCE(json_extract(usage_json, '$.cacheReadTokens'), 0))), 0) as net_input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(MAX(0, COALESCE(json_extract(usage_json, '$.outputTokens'), 0) - COALESCE(json_extract(usage_json, '$.reasoningTokens'), 0))), 0) as net_output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens
    FROM provider_attempts ${tripleWhere()} GROUP BY date ORDER BY date ASC
  `).all(...tripleParams, ...dateFilter.params) as Array<{
    date: string; net_input_tokens: number; cache_read_tokens: number;
    net_output_tokens: number; reasoning_tokens: number;
  }>;
  const tokensOverTime = tokenRows.map((r) => ({
    date: r.date,
    netInputTokens: r.net_input_tokens,
    cacheReadTokens: r.cache_read_tokens,
    netOutputTokens: r.net_output_tokens,
    reasoningTokens: r.reasoning_tokens,
  }));

  const costByDateMap = new Map<string, { date: string; currency: string; amount: Decimal }>();
  for (const row of iterateRows<{ date: string; currency: string; cost_amount: string }>(db, `
    SELECT strftime('%Y-%m-%d', started_at) as date, currency, cost_amount
    FROM provider_attempts
    ${tripleWhere(COST_ROW_CONDITIONS)}
  `, [...tripleParams, ...dateFilter.params])) {
    const key = `${row.date}\0${row.currency}`;
    const entry = costByDateMap.get(key) ?? { date: row.date, currency: row.currency, amount: new Decimal(0) };
    entry.amount = entry.amount.add(parseCostAmount(row.cost_amount) ?? new Decimal(0));
    costByDateMap.set(key, entry);
  }
  const costOverTime = [...costByDateMap.values()]
    .map((entry) => ({ date: entry.date, currency: entry.currency, cost: entry.amount.toFixed() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency));

  const topSessionRows = db.prepare(`
    SELECT session_id,
      COUNT(*) as attempts,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens
    FROM provider_attempts ${tripleWhere()}
    GROUP BY session_id
    ORDER BY attempts DESC, session_id ASC
    LIMIT ?
  `).all(...tripleParams, ...dateFilter.params, MODEL_DETAIL_TOP_SESSIONS) as Array<{
    session_id: string; attempts: number; input_tokens: number; output_tokens: number;
  }>;

  const sessionCostMap = new Map<string, Map<string, DecimalTotal>>();
  for (const row of iterateRows<{ session_id: string; currency: string; cost_amount: string }>(db, `
    SELECT session_id, currency, cost_amount
    FROM provider_attempts
    ${tripleWhere(COST_ROW_CONDITIONS)}
  `, [...tripleParams, ...dateFilter.params])) {
    bumpCurrencyTotal(nestedCurrencyMap(sessionCostMap, row.session_id), row.currency, parseCostAmount(row.cost_amount));
  }

  const nameMap = resolveManySessionNames(
    sessionNameResolver(ctx, db),
    topSessionRows.map((r) => r.session_id),
  );
  const topSessions = topSessionRows.map((r) => ({
    sessionId: r.session_id,
    sessionName: nameMap.get(r.session_id) ?? null,
    attempts: r.attempts,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalCost: toCurrencyTotals(sessionCostMap.get(r.session_id)),
  }));

  const recentRows = db.prepare(`
    SELECT attempt_id, chain_id, turn_id, provider_id, model_id, connection_id, outcome,
      cost_state, cost_amount, currency, usage_json, started_at, completed_at, first_token_at,
      agent_scope, agent_name, agent_tier, error, snapshot_json
    FROM provider_attempts ${tripleWhere()} ORDER BY started_at DESC LIMIT ?
  `).all(...tripleParams, ...dateFilter.params, MODEL_DETAIL_RECENT_ATTEMPTS) as AttemptDetailRow[];
  const recentAttempts = recentRows.map((r) => toAttemptDetail(r, parseUsage(r.usage_json)));

  return {
    modelId: input.modelId,
    providerId: input.providerId,
    connectionId: input.connectionId,
    stats: {
      attempts: stats.attempts,
      succeeded: stats.succeeded,
      failed: stats.failed,
      interrupted: stats.interrupted,
      inputTokens: stats.input_tokens,
      outputTokens: stats.output_tokens,
      cacheReadTokens: stats.cache_read_tokens,
      cacheWriteTokens: stats.cache_write_tokens,
      reasoningTokens: stats.reasoning_tokens,
      totalCost: toCurrencyTotals(totalCostMap),
      firstUsed: stats.first_used,
      lastUsed: stats.last_used,
      avgTtftMs: latency.avgTtftMs,
      p50TtftMs: latency.p50TtftMs,
      p95TtftMs: latency.p95TtftMs,
      avgTokensPerSecond: latency.avgTokensPerSecond,
    },
    ttftHistogram,
    ttftOverTime,
    tokensOverTime,
    costOverTime,
    topSessions,
    recentAttempts,
  };
}

/**
 * Subagent explorer drill-down for one (agent_name, agent_type, agent_tier)
 * triple: one invocation row per attribution entry (chain-joined attempts,
 * tokens, Decimal-streamed costs), a summary with latency over the joined
 * attempts, per-model usage, and daily invocation counts.
 */
export function getSubagentDetail(
  input: { agentName: string; agentType: string; agentTier: string; timeRange?: AnalyticsTimeRange },
  ctx?: AnalyticsQueryContext,
): SubagentAnalyticsDetailResult {
  const db = getDb(ctx);
  const dateFilter = buildDateFilter(input.timeRange);
  // Same join shape as getSubagents: attribution rows for the triple, with
  // attempts attributed to their run's window (see subagentRunWindows).
  const tripleConditions = ['agent_name = ?', 'agent_type = ?', 'agent_tier = ?'];
  const filteredSubagents = `SELECT * FROM subagent_attribution ${whereClause(tripleConditions, dateFilter.clause)}`;
  const filteredAttempts = `SELECT * FROM provider_attempts ${whereClause([], dateFilter.clause)}`;
  // filtered_sa binds the triple + date params, run_usage re-binds the date
  // params — same parameter layout getSubagents uses.
  const joinParams = [input.agentName, input.agentType, input.agentTier, ...dateFilter.params, ...dateFilter.params];

  const invocationRows = db.prepare(`
    WITH filtered_sa AS (${filteredSubagents}),
    ${subagentRunWindows('filtered_sa')},
    ${subagentRunUsage(filteredAttempts)}
    SELECT sa.subagent_id, sa.session_id, sa.chain_id, sa.model_id, sa.status,
      sa.started_at, sa.completed_at,
      COALESCE(ru.attempts, 0) as attempts,
      COALESCE(ru.input_tokens, 0) as input_tokens,
      COALESCE(ru.output_tokens, 0) as output_tokens
    FROM filtered_sa sa JOIN run_usage ru ON ${RUN_USAGE_JOIN}
    ORDER BY sa.started_at DESC, sa.subagent_id ASC
    LIMIT ?
  `).all(...joinParams, SUBAGENT_DETAIL_MAX_INVOCATIONS) as Array<{
    subagent_id: string; session_id: string; chain_id: string; model_id: string; status: string;
    started_at: string; completed_at: string | null;
    attempts: number; input_tokens: number; output_tokens: number;
  }>;

  const { count: totalInvocations } = db.prepare(`
    SELECT COUNT(*) as count FROM subagent_attribution
    ${whereClause(tripleConditions, dateFilter.clause)}
  `).get(input.agentName, input.agentType, input.agentTier, ...dateFilter.params) as { count: number };

  const summaryRow = db.prepare(`
    WITH filtered_sa AS (${filteredSubagents}),
    ${subagentRunWindows('filtered_sa')},
    ${subagentRunUsage(filteredAttempts)}
    SELECT COUNT(*) as invocations,
      COALESCE(SUM(CASE WHEN sa.status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN sa.status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN sa.status = 'interrupted' THEN 1 ELSE 0 END), 0) as interrupted,
      COALESCE(SUM(ru.attempts), 0) as attempts,
      COALESCE(SUM(ru.input_tokens), 0) as input_tokens,
      COALESCE(SUM(ru.output_tokens), 0) as output_tokens,
      AVG(CASE WHEN sa.completed_at IS NOT NULL THEN (julianday(sa.completed_at) - julianday(sa.started_at)) * 86400000 END) as avg_duration_ms
    FROM filtered_sa sa JOIN run_usage ru ON ${RUN_USAGE_JOIN}
  `).get(...joinParams) as {
    invocations: number; completed: number; failed: number; interrupted: number;
    attempts: number; input_tokens: number; output_tokens: number; avg_duration_ms: number | null;
  };

  // Costs are attributed per run window (subagent_id can repeat for follow-up
  // runs sharing one chain), aggregated per model and overall from the stream.
  const runCostMap = new Map<string, Map<string, DecimalTotal>>();
  const modelCostMap = new Map<string, Map<string, DecimalTotal>>();
  const totalCostMap = new Map<string, DecimalTotal>();
  for (const row of iterateRows<{
    chain_id: string; started_at: string; model_id: string; currency: string; cost_amount: string;
  }>(db, `
    WITH filtered_sa AS (${filteredSubagents}), ${subagentRunWindows('filtered_sa')}
    SELECT rw.chain_id, rw.started_at, rw.model_id, pa.currency, pa.cost_amount
    FROM run_windows rw JOIN (${filteredAttempts}) pa ON ${ATTEMPT_RUN_WINDOW_JOIN}
    WHERE pa.cost_state IN ('reported','calculated') AND pa.currency IS NOT NULL AND pa.cost_amount IS NOT NULL
  `, joinParams)) {
    const amount = parseCostAmount(row.cost_amount);
    bumpCurrencyTotal(nestedCurrencyMap(runCostMap, `${row.chain_id}\0${row.started_at}`), row.currency, amount);
    bumpCurrencyTotal(nestedCurrencyMap(modelCostMap, row.model_id), row.currency, amount);
    bumpCurrencyTotal(totalCostMap, row.currency, amount);
  }

  const modelRows = db.prepare(`
    WITH filtered_sa AS (${filteredSubagents}),
    ${subagentRunWindows('filtered_sa')},
    ${subagentRunUsage(filteredAttempts)}
    SELECT sa.model_id,
      COALESCE(SUM(ru.attempts), 0) as attempts,
      COALESCE(SUM(ru.input_tokens), 0) as input_tokens,
      COALESCE(SUM(ru.output_tokens), 0) as output_tokens
    FROM filtered_sa sa JOIN run_usage ru ON ${RUN_USAGE_JOIN}
    GROUP BY sa.model_id ORDER BY attempts DESC, sa.model_id ASC
  `).all(...joinParams) as Array<{
    model_id: string; attempts: number; input_tokens: number; output_tokens: number;
  }>;
  const modelsUsed = modelRows.map((row) => ({
    modelId: row.model_id,
    attempts: row.attempts,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalCost: toCurrencyTotals(modelCostMap.get(row.model_id)),
  }));

  const latencySamples = emptyLatencySamples();
  for (const row of iterateRows<LatencySampleRow>(db, `
    WITH filtered_sa AS (${filteredSubagents}), ${subagentRunWindows('filtered_sa')}
    SELECT ${latencyRowColumns('pa.')}
    FROM run_windows rw JOIN (${filteredAttempts}) pa ON ${ATTEMPT_RUN_WINDOW_JOIN}
    ${whereClause(latencyRowGating('pa.'), '')}
  `, joinParams)) {
    recordLatencySample(latencySamples, row);
  }
  const latency = summarizeLatency(latencySamples);

  const overTimeRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date, COUNT(*) as count
    FROM subagent_attribution ${whereClause(tripleConditions, dateFilter.clause)}
    GROUP BY date ORDER BY date ASC
  `).all(input.agentName, input.agentType, input.agentTier, ...dateFilter.params) as Array<{ date: string; count: number }>;

  const nameMap = resolveManySessionNames(
    sessionNameResolver(ctx, db),
    invocationRows.map((r) => r.session_id),
  );
  const invocations = invocationRows.map((r) => ({
    subagentId: r.subagent_id,
    sessionId: r.session_id,
    sessionName: nameMap.get(r.session_id) ?? null,
    chainId: r.chain_id,
    modelId: r.model_id,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    durationMs: r.completed_at
      ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
      : null,
    attempts: r.attempts,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalCost: toCurrencyTotals(runCostMap.get(`${r.chain_id}\0${r.started_at}`)),
  }));

  return {
    agentName: input.agentName,
    agentType: input.agentType,
    agentTier: input.agentTier,
    invocations,
    truncated: totalInvocations > invocationRows.length,
    summary: {
      invocations: summaryRow.invocations,
      completed: summaryRow.completed,
      failed: summaryRow.failed,
      interrupted: summaryRow.interrupted,
      attempts: summaryRow.attempts,
      inputTokens: summaryRow.input_tokens,
      outputTokens: summaryRow.output_tokens,
      totalCost: toCurrencyTotals(totalCostMap),
      avgDurationMs: summaryRow.avg_duration_ms === null ? null : Math.round(summaryRow.avg_duration_ms),
      avgTtftMs: latency.avgTtftMs,
      p50TtftMs: latency.p50TtftMs,
      p95TtftMs: latency.p95TtftMs,
      avgTokensPerSecond: latency.avgTokensPerSecond,
    },
    modelsUsed,
    invocationsOverTime: overTimeRows.map((row) => ({ date: row.date, count: row.count })),
  };
}

/**
 * Context session picker: every distinct main-agent session with snapshots in
 * range (ids + ints, so no cap). Standalone from the drill-down so switching
 * sessions does not recompute the picker.
 */
export function getContextSessionList(
  timeRange?: AnalyticsTimeRange,
  ctx: AnalyticsQueryContext = {},
): ContextSessionsResult {
  const db = getDb(ctx);
  const capturedFilter = buildDateFilter(timeRange, 'captured_at');
  const resolveNames = sessionNameResolver(ctx, db);

  const pickerRows = db.prepare(`
    SELECT session_id, COUNT(*) as snapshot_count, MAX(used_tokens) as max_used_tokens
    FROM context_snapshots
    ${whereClause(['agent_scope IS NULL'], capturedFilter.clause)}
    GROUP BY session_id
    ORDER BY max_used_tokens DESC, session_id ASC
  `).all(...capturedFilter.params) as Array<{
    session_id: string; snapshot_count: number; max_used_tokens: number;
  }>;
  const nameMap = resolveManySessionNames(resolveNames, pickerRows.map((r) => r.session_id));
  return {
    sessions: pickerRows.map((r) => ({
      sessionId: r.session_id,
      sessionName: nameMap.get(r.session_id) ?? null,
      snapshotCount: r.snapshot_count,
      maxUsedTokens: r.max_used_tokens,
    })),
  };
}

/**
 * Context drill-down for one session: the full-fidelity main-agent snapshot
 * series (no stride sampling — capped at the most recent 2000 points) and a
 * timeline of contextual events (compactor attempts + largest used_tokens
 * jumps). The session picker lives in {@link getContextSessionList}.
 */
export function getContextSessionDetail(
  input: { sessionId: string; timeRange?: AnalyticsTimeRange },
  ctx?: AnalyticsQueryContext,
): ContextSessionDetailResult {
  const db = getDb(ctx);
  // Snapshots filter on captured_at; compaction attempts on started_at.
  const capturedFilter = buildDateFilter(input.timeRange, 'captured_at');
  const attemptFilter = buildDateFilter(input.timeRange);
  const resolveNames = sessionNameResolver(ctx, db);

  const { count: seriesCount } = db.prepare(`
    SELECT COUNT(*) as count FROM context_snapshots
    ${whereClause(['session_id = ?', 'agent_scope IS NULL'], capturedFilter.clause)}
  `).get(input.sessionId, ...capturedFilter.params) as { count: number };

  type SeriesRow = {
    captured_at: string; used_tokens: number; system_tokens: number; tools_tokens: number;
    tool_use_tokens: number; user_tokens: number; assistant_tokens: number; summary_tokens: number;
    turn_id: string | null; provider_attempt_id: string | null;
  };
  // Newest-first in SQL to bound the scan, replayed oldest-first for the chart.
  const seriesRows = db.prepare(`
    SELECT captured_at, used_tokens, system_tokens, tools_tokens, tool_use_tokens,
      user_tokens, assistant_tokens, summary_tokens, turn_id, provider_attempt_id
    FROM context_snapshots
    ${whereClause(['session_id = ?', 'agent_scope IS NULL'], capturedFilter.clause)}
    ORDER BY captured_at DESC LIMIT ?
  `).all(input.sessionId, ...capturedFilter.params, CONTEXT_DETAIL_MAX_POINTS) as SeriesRow[];
  seriesRows.reverse();
  const series = seriesRows.map((r) => ({
    capturedAt: r.captured_at,
    usedTokens: r.used_tokens,
    systemTokens: r.system_tokens,
    toolsTokens: r.tools_tokens,
    toolUseTokens: r.tool_use_tokens,
    userTokens: r.user_tokens,
    assistantTokens: r.assistant_tokens,
    summaryTokens: r.summary_tokens,
    turnId: r.turn_id,
    providerAttemptId: r.provider_attempt_id,
  }));

  // Compaction runs live in the ledger as compactor attempts for the session.
  // Exact internal names only — a user-defined agent named "compactor-*"
  // must not masquerade as a compaction event (names source: compaction/
  // summarize.ts + apply.ts).
  const COMPACTOR_AGENT_NAMES = "('compactor','compactor-selective','compactor-subagent','compactor-subagent-selective')";
  const compactionRows = db.prepare(`
    SELECT started_at, agent_name,
      json_extract(usage_json, '$.inputTokens') as input_tokens,
      json_extract(usage_json, '$.outputTokens') as output_tokens
    FROM provider_attempts
    ${whereClause(['session_id = ?', `agent_name IN ${COMPACTOR_AGENT_NAMES}`], attemptFilter.clause)}
    ORDER BY started_at ASC
  `).all(input.sessionId, ...attemptFilter.params) as Array<{
    started_at: string; agent_name: string; input_tokens: number | null; output_tokens: number | null;
  }>;

  // Largest positive deltas between consecutive series points, with per-segment
  // attribution for the same pair of points.
  const jumpCandidates: ContextJumpEvent[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const point = series[i];
    const deltaTokens = point.usedTokens - prev.usedTokens;
    if (deltaTokens <= 0) continue;
    jumpCandidates.push({
      type: 'jump',
      at: point.capturedAt,
      deltaTokens,
      fromTokens: prev.usedTokens,
      toTokens: point.usedTokens,
      segmentDeltas: {
        system: point.systemTokens - prev.systemTokens,
        tools: point.toolsTokens - prev.toolsTokens,
        toolUse: point.toolUseTokens - prev.toolUseTokens,
        user: point.userTokens - prev.userTokens,
        assistant: point.assistantTokens - prev.assistantTokens,
        summary: point.summaryTokens - prev.summaryTokens,
      },
    });
  }
  const largestJumps = jumpCandidates
    .sort((a, b) => b.deltaTokens - a.deltaTokens || a.at.localeCompare(b.at))
    .slice(0, CONTEXT_DETAIL_MAX_EVENTS);

  // Interleave compactions and jumps chronologically for the timeline.
  const events: ContextEvent[] = [
    ...compactionRows.map((r) => ({
      type: 'compaction' as const,
      at: r.started_at,
      agentName: r.agent_name,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    })),
    ...largestJumps,
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    sessionId: input.sessionId,
    sessionName: resolveManySessionNames(resolveNames, [input.sessionId]).get(input.sessionId) ?? null,
    series,
    truncated: seriesCount > series.length,
    events,
  };
}
