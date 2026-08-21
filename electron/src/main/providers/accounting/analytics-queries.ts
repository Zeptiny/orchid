import Decimal from 'decimal.js';
import type { SqliteDatabase } from '../../utils/sqlite';
import {
  getProviderAccountingStore,
} from './store';
import {
  getSubagentAttributionStore,
} from './subagent-attribution-store';
import type {
  OverviewResult,
  SessionsResult,
  SessionDetailResult,
  ModelsResult,
  ConnectionBreakdown,
  ToolsResult,
  SubagentsResult,
  ContextResult,
  ContextSessionSeries,
  ContextSubagentSeries,
  CurrencyTotal,
  TimeSeriesPoint,
  CostTimeSeriesPoint,
  ModelCostTimeSeriesPoint,
  ConnectionCostTimeSeriesPoint,
  ToolCallDetail,
  AttemptDetail,
  AnalyticsTimeRange,
  ModelDetailResult,
  TtftHistogramBucket,
  TtftOverTimePoint,
  SubagentAnalyticsDetailResult,
  ContextSessionDetailResult,
  ContextEvent,
  ContextJumpEvent,
} from '../../../shared/types/analytics';
import {
  CONTEXT_DETAIL_MAX_POINTS,
  SUBAGENT_DETAIL_MAX_INVOCATIONS,
  TTFT_BUCKET_MS,
} from '../../../shared/types/analytics';
import type { SubagentAttributionRecord } from '../../../shared/types/accounting';
import type { QuotaOverviewEntry } from '../../../shared/types/analytics';
import { providerQuotaSchema } from '../../../shared/types/provider-facets';
import { getSessionNames } from '../../session/storage';
import { getProviderConnectionStore, getProviderStatusService } from '../runtime-context';

const DEFAULT_LIMIT = 1000;
const CONTEXT_TOP_SESSIONS = 5;
const CONTEXT_TOP_SUBAGENTS = 5;
const CONTEXT_MAX_POINTS_PER_SERIES = 500;
const MODEL_DETAIL_TOP_SESSIONS = 10;
const MODEL_DETAIL_RECENT_ATTEMPTS = 50;
const TTFT_BUCKET_MAX_MS = 5000;
const CONTEXT_DETAIL_MAX_EVENTS = 10;
/** Chunk size for bulk session-name lookups — one IN(...) per batch stays well
 * below the SQLite bound-variable limit even for very long picker lists. */
const SESSION_NAME_BATCH = 500;

const COST_ROW_CONDITIONS = [
  "cost_state IN ('reported','calculated')",
  'currency IS NOT NULL',
  'cost_amount IS NOT NULL',
];

type DecimalTotal = { amount: Decimal; count: number };

/**
 * Dependency injection seam for query execution. Lets the worker thread run
 * analytics queries against its own SQLite connection and defer session-name
 * resolution to the main process (sessions.db stays main-process-owned).
 */
export interface AnalyticsQueryContext {
  /** Connection to accounting.db. Defaults to the main-process singleton. */
  db?: SqliteDatabase;
  /**
   * Resolve session names for the top-N session ids. Defaults to live
   * sessions.db names with a tombstone fallback for deleted sessions (see
   * {@link resolveSessionNamesWithFallback}).
   */
  resolveSessionNames?: (sessionIds: readonly string[]) => Map<string, string>;
}

function getDb(ctx?: AnalyticsQueryContext): SqliteDatabase {
  return ctx?.db ?? getProviderAccountingStore().getDatabase();
}

/**
 * Resolve session names with a tombstone fallback.
 *
 * Live sessions.db rows win: a session that still exists keeps its current
 * (possibly renamed) name. Ids not found there fall back to the
 * `session_names` tombstone table inside the given accounting db — the
 * ledger outlives the session, and the tombstone written at deletion time
 * preserves the last-known name for analytics. Both lookups are fail-soft
 * (sessions.db unavailable, tombstone table missing, locked db → skip).
 */
export function resolveSessionNamesWithFallback(
  db: SqliteDatabase,
  sessionIds: readonly string[],
): Map<string, string> {  const names = new Map<string, string>();
  try {
    for (const [id, name] of getSessionNames(sessionIds)) {
      names.set(id, name);
    }
  } catch { /* session DB unavailable */ }
  const missing = sessionIds.filter((id) => !names.has(id));
  if (missing.length === 0) return names;
  try {
    const placeholders = missing.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT session_id, name FROM session_names WHERE session_id IN (${placeholders})`,
    ).all(...missing) as Array<{ session_id: string; name: string }>;
    for (const row of rows) {
      names.set(row.session_id, row.name);
    }
  } catch { /* tombstone table missing or db locked — skip */ }
  return names;
}

/**
 * Run a session-name resolver over arbitrarily long id lists in batches.
 * Drill-down pickers may list every session in range, and a single IN(...)
 * with thousands of placeholders would risk the SQLite variable cap; per-batch
 * failures degrade to unresolved names instead of failing the whole query.
 */
function resolveManySessionNames(
  resolveNames: (ids: readonly string[]) => Map<string, string>,
  sessionIds: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (let i = 0; i < sessionIds.length; i += SESSION_NAME_BATCH) {
    try {
      for (const [id, name] of resolveNames(sessionIds.slice(i, i + SESSION_NAME_BATCH))) {
        names.set(id, name);
      }
    } catch { /* session name resolution failed for this batch */ }
  }
  return names;
}

/**
 * Stream raw rows from a prepared statement. Cost aggregation must never use
 * GROUP_CONCAT: SQLite silently truncates the concatenated string for large
 * groups, corrupting totals. Rows are accumulated into Decimal sums in JS.
 */
function iterateRows<T>(db: SqliteDatabase, sql: string, params: ReadonlyArray<string | number>): IterableIterator<T> {
  return db.prepare(sql).iterate(...params) as IterableIterator<T>;
}

function parseCostAmount(costAmount: string): Decimal | null {
  try {
    return new Decimal(costAmount);
  } catch {
    return null;
  }
}

function bumpCurrencyTotal(map: Map<string, DecimalTotal>, key: string, amount: Decimal | null): void {
  const entry = map.get(key) ?? { amount: new Decimal(0), count: 0 };
  entry.count++;
  if (amount) entry.amount = entry.amount.add(amount);
  map.set(key, entry);
}

function nestedCurrencyMap(
  map: Map<string, Map<string, DecimalTotal>>,
  key: string,
): Map<string, DecimalTotal> {
  const inner = map.get(key) ?? new Map<string, DecimalTotal>();
  map.set(key, inner);
  return inner;
}

function toCurrencyTotals(map: Map<string, DecimalTotal> | undefined): CurrencyTotal[] {
  if (!map) return [];
  return [...map.entries()]
    .map(([currency, entry]) => ({ currency, amount: entry.amount.toFixed(), recordCount: entry.count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function parseUsage(usageJson: string | null): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  energyKwhConsumed: string | null;
  energyKwhCharged: string | null;
  pricingMultiplier: string | null;
} {
  if (!usageJson) return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    energyKwhConsumed: null, energyKwhCharged: null, pricingMultiplier: null,
  };
  try {
    const u = JSON.parse(usageJson) as Record<string, unknown>;
    return {
      inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
      outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
      cacheReadTokens: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
      cacheWriteTokens: typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0,
      reasoningTokens: typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0,
      energyKwhConsumed: typeof u.energyKwhConsumed === 'string' ? u.energyKwhConsumed : null,
      energyKwhCharged: typeof u.energyKwhCharged === 'string' ? u.energyKwhCharged : null,
      pricingMultiplier: typeof u.pricingMultiplier === 'string' ? u.pricingMultiplier : null,
    };
  } catch {
    return {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      energyKwhConsumed: null, energyKwhCharged: null, pricingMultiplier: null,
    };
  }
}

/** Parsed usage_json shape returned by {@link parseUsage}. */
type ParsedUsage = ReturnType<typeof parseUsage>;

function parseSnapshotConnectionName(snapshotJson: string): string | null {
  try {
    const s = JSON.parse(snapshotJson) as Record<string, unknown>;
    return typeof s.connectionName === 'string' ? s.connectionName : null;
  } catch { return null; }
}

function parseSnapshotProviderName(snapshotJson: string): string | null {
  try {
    const s = JSON.parse(snapshotJson) as Record<string, unknown>;
    return typeof s.providerDisplayName === 'string' ? s.providerDisplayName : null;
  } catch { return null; }
}

function parseSnapshotModelDisplayName(snapshotJson: string): string | null {
  try {
    const s = JSON.parse(snapshotJson) as Record<string, unknown>;
    return typeof s.modelDisplayName === 'string' ? s.modelDisplayName : null;
  } catch { return null; }
}

/**
 * Read the latest typed quota observations from the status cache (R24). These
 * render in native units and are informational only; the ledger is never joined
 * against them, and an unavailable status service yields an empty list.
 *
 * Entries are gated on configured connections: quota is only shown for a
 * provider the user actually has a connection for. Without this gate, the
 * credential-free provider-wide sources (e.g. Lilac, scheduled unconditionally)
 * and persisted cache entries would surface quota for providers with no
 * connection — information that is irrelevant to the user.
 */
function getQuotaOverview(): QuotaOverviewEntry[] {
  try {
    const status = getProviderStatusService();
    const connectedProviders = getProviderConnectionStore().listProviderIdsSync();
    const entries: QuotaOverviewEntry[] = [];
    for (const observation of status.list()) {
      if (!connectedProviders.has(observation.providerId)) continue;
      const parsed = providerQuotaSchema.safeParse(observation.data['quota']);
      if (!parsed.success) continue;
      const quota = parsed.data;
      entries.push({
        providerId: observation.providerId,
        connectionId: observation.connectionId ?? null,
        observedAt: quota.observedAt,
        stale: observation.stale,
        balances: quota.balances.map((balance) => ({ ...balance })),
        subscription: quota.subscription === null
          ? null
          : {
            state: quota.subscription.state,
            displayName: quota.subscription.displayName ?? null,
            renewsAt: quota.subscription.renewsAt ?? null,
          },
        allowances: quota.allowances.map((allowance) => ({
          label: allowance.label,
          state: allowance.state,
          detail: allowance.detail ?? null,
        })),
      });
    }
    return entries.sort((a, b) => a.providerId.localeCompare(b.providerId));
  } catch {
    return [];
  }
}

function sumCosts(rows: Array<{ currency: string | null; cost_amount: string | null; cost_state: string }>): {
  currencies: CurrencyTotal[];
  unknownCount: number;
} {
  const sums = new Map<string, DecimalTotal>();
  let unknownCount = 0;
  for (const row of rows) {
    if (row.cost_state !== 'reported' && row.cost_state !== 'calculated') { unknownCount++; continue; }
    if (!row.currency || !row.cost_amount) { unknownCount++; continue; }
    const amount = parseCostAmount(row.cost_amount);
    if (!amount) { unknownCount++; continue; }
    const entry = sums.get(row.currency) ?? { amount: new Decimal(0), count: 0 };
    entry.amount = entry.amount.add(amount);
    entry.count++;
    sums.set(row.currency, entry);
  }
  return { currencies: toCurrencyTotals(sums), unknownCount };
}

function buildDateFilter(timeRange: AnalyticsTimeRange | undefined, column = 'started_at'): {
  clause: string;
  params: string[];
} {
  const conditions: string[] = [];
  const params: string[] = [];
  if (timeRange?.startDate) {
    conditions.push(`${column} >= ?`);
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    conditions.push(`${column} <= ?`);
    params.push(timeRange.endDate);
  }
  return { clause: conditions.join(' AND '), params };
}

function whereClause(existingConditions: string[], dateClause: string): string {
  const all = [...existingConditions, dateClause].filter(Boolean);
  return all.length > 0 ? `WHERE ${all.join(' AND ')}` : '';
}

// ── First-token latency (TTFT) / token throughput (TPS) ──────────────────────

/** Raw latency sample per attempt: started → first token, and the generation window after it. */
type LatencyRow = {
  model_id: string;
  provider_id: string;
  connection_id: string;
  started_at: string;
  first_token_at: string;
  completed_at: string;
  output_tokens: number | null;
};

/** Minimal columns {@link recordLatencySample} consumes. */
type LatencySampleRow = Pick<LatencyRow, 'started_at' | 'first_token_at' | 'completed_at' | 'output_tokens'>;

type LatencySamples = {
  ttftMs: number[];
  outputTokens: number;
  generationSeconds: number;
};

function emptyLatencySamples(): LatencySamples {
  return { ttftMs: [], outputTokens: 0, generationSeconds: 0 };
}

/** Nearest-rank percentile over an ascending-sorted array; null when empty. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/**
 * Stream attempts that stamped a first token — per-attempt timestamps must be
 * reduced in JS, not GROUP_CONCAT (see iterateRows). Same date filter as the
 * caller's other queries.
 */
function iterateLatencyRows(
  db: SqliteDatabase,
  dateFilter: { clause: string; params: string[] },
): IterableIterator<LatencyRow> {
  return iterateRows<LatencyRow>(db, `
    SELECT model_id, provider_id, connection_id, started_at, first_token_at, completed_at,
      json_extract(usage_json, '$.outputTokens') as output_tokens
    FROM provider_attempts
    ${whereClause(['first_token_at IS NOT NULL', 'completed_at IS NOT NULL'], dateFilter.clause)}
  `, dateFilter.params);
}

function recordLatencySample(
  samples: LatencySamples,
  row: LatencySampleRow,
): number {
  const ttftMs = new Date(row.first_token_at).getTime() - new Date(row.started_at).getTime();
  const generationMs = new Date(row.completed_at).getTime() - new Date(row.first_token_at).getTime();
  // Clock skew between the two wall-clock writes can produce negative TTFT;
  // such samples distort percentiles/histograms and are dropped (the raw
  // value is still returned for per-attempt display).
  if (ttftMs >= 0) samples.ttftMs.push(ttftMs);
  // Rows without a positive generation window or a known token count still
  // contribute TTFT but cannot rate tokens.
  if (generationMs > 0 && row.output_tokens !== null) {
    samples.outputTokens += row.output_tokens;
    samples.generationSeconds += generationMs / 1000;
  }
  return ttftMs;
}

/** Get-or-create a per-key sample bucket (mirrors nestedCurrencyMap). */
function latencySamplesFor(map: Map<string, LatencySamples>, key: string): LatencySamples {
  const samples = map.get(key) ?? emptyLatencySamples();
  map.set(key, samples);
  return samples;
}

/**
 * TTFT distribution plus token-weighted throughput. TPS is total output tokens
 * over total generation seconds (not an average of per-attempt rates).
 */
function summarizeLatency(samples: LatencySamples | undefined): {
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  avgTokensPerSecond: number | null;
} {
  if (!samples || samples.ttftMs.length === 0) {
    return { avgTtftMs: null, p50TtftMs: null, p95TtftMs: null, avgTokensPerSecond: null };
  }
  const sorted = [...samples.ttftMs].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    avgTtftMs: Math.round(sum / sorted.length),
    p50TtftMs: percentile(sorted, 50),
    p95TtftMs: percentile(sorted, 95),
    avgTokensPerSecond: samples.generationSeconds > 0
      ? Math.round((samples.outputTokens / samples.generationSeconds) * 10) / 10
      : null,
  };
}

export function getOverview(timeRange?: AnalyticsTimeRange): OverviewResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);

  const stats = db.prepare(`
    SELECT COUNT(*) as total,
      COALESCE(SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END), 0) as succeeded,
      COALESCE(SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END), 0) as interrupted,
      COUNT(DISTINCT session_id) as sessions,
      COALESCE(SUM(CASE WHEN usage_json IS NOT NULL THEN 1 ELSE 0 END), 0) as known_usage,
      COALESCE(SUM(CASE WHEN usage_json IS NULL THEN 1 ELSE 0 END), 0) as unknown_usage
    FROM provider_attempts ${whereClause([], dateFilter.clause)}
  `).get(...dateFilter.params) as {
    total: number; succeeded: number; failed: number; interrupted: number; sessions: number;
    known_usage: number; unknown_usage: number;
  };

  const tokens = db.prepare(`
    SELECT
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) as cache_write_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens
    FROM provider_attempts ${whereClause(['usage_json IS NOT NULL'], dateFilter.clause)}
  `).get(...dateFilter.params) as {
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_write_tokens: number; reasoning_tokens: number;
  };

  const totalCostMap = new Map<string, DecimalTotal>();
  for (const row of iterateRows<{ currency: string; cost_amount: string }>(db, `
    SELECT currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    bumpCurrencyTotal(totalCostMap, row.currency, parseCostAmount(row.cost_amount));
  }
  const totalCost = toCurrencyTotals(totalCostMap);

  const unknownCost = db.prepare(`
    SELECT COUNT(*) as count FROM provider_attempts
    ${whereClause(["NOT (cost_state IN ('reported','calculated') AND currency IS NOT NULL AND cost_amount IS NOT NULL)"], dateFilter.clause)}
  `).get(...dateFilter.params) as { count: number };

  const tokenRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) as cache_write_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens
    FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY date ORDER BY date
  `).all(...dateFilter.params) as Array<{
    date: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
  }>;

  const tokenUsageOverTime: TimeSeriesPoint[] = tokenRows.map((r) => ({
    date: r.date,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
  }));

  const spendOverTimeMap = new Map<string, { date: string; currency: string; amount: Decimal }>();
  for (const row of iterateRows<{ date: string; currency: string; cost_amount: string }>(db, `
    SELECT strftime('%Y-%m-%d', started_at) as date, currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    const key = `${row.date}\0${row.currency}`;
    const entry = spendOverTimeMap.get(key)
      ?? { date: row.date, currency: row.currency, amount: new Decimal(0) };
    entry.amount = entry.amount.add(parseCostAmount(row.cost_amount) ?? new Decimal(0));
    spendOverTimeMap.set(key, entry);
  }
  const spendOverTime: CostTimeSeriesPoint[] = [...spendOverTimeMap.values()]
    .map((entry) => ({ date: entry.date, currency: entry.currency, cost: entry.amount.toFixed() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency));

  const spendByModelMap = new Map<string, { modelId: string; providerId: string; currency: string; amount: Decimal }>();
  for (const row of iterateRows<{ model_id: string; provider_id: string; currency: string; cost_amount: string }>(db, `
    SELECT model_id, provider_id, currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    const key = `${row.model_id}\0${row.provider_id}\0${row.currency}`;
    const entry = spendByModelMap.get(key)
      ?? { modelId: row.model_id, providerId: row.provider_id, currency: row.currency, amount: new Decimal(0) };
    entry.amount = entry.amount.add(parseCostAmount(row.cost_amount) ?? new Decimal(0));
    spendByModelMap.set(key, entry);
  }
  const spendByModel = [...spendByModelMap.values()]
    .map((entry) => ({
      modelId: entry.modelId,
      providerId: entry.providerId,
      cost: entry.amount.toFixed(),
      currency: entry.currency,
    }))
    .sort((a, b) => Number(b.cost) - Number(a.cost));

  const spendByProviderMap = new Map<string, { providerId: string; currency: string; amount: Decimal }>();
  for (const row of iterateRows<{ provider_id: string; currency: string; cost_amount: string }>(db, `
    SELECT provider_id, currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    const key = `${row.provider_id}\0${row.currency}`;
    const entry = spendByProviderMap.get(key)
      ?? { providerId: row.provider_id, currency: row.currency, amount: new Decimal(0) };
    entry.amount = entry.amount.add(parseCostAmount(row.cost_amount) ?? new Decimal(0));
    spendByProviderMap.set(key, entry);
  }
  const spendByProvider = [...spendByProviderMap.values()]
    .map((entry) => ({
      providerId: entry.providerId,
      cost: entry.amount.toFixed(),
      currency: entry.currency,
    }))
    .sort((a, b) => Number(b.cost) - Number(a.cost));

  const outcomeRows = db.prepare(`
    SELECT outcome, COUNT(*) as count FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY outcome
  `).all(...dateFilter.params) as Array<{ outcome: string; count: number }>;
  const outcomeDistribution = outcomeRows.map((r) => ({ outcome: r.outcome, count: r.count }));

  const costSourceRows = db.prepare(`
    SELECT cost_source, COUNT(*) as count FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY cost_source
  `).all(...dateFilter.params) as Array<{ cost_source: string; count: number }>;
  const costSourceDistribution = costSourceRows.map((r) => ({ source: r.cost_source, count: r.count }));

  const tierRows = db.prepare(`
    SELECT agent_tier, COUNT(*) as count FROM provider_attempts ${whereClause(['agent_tier IS NOT NULL'], dateFilter.clause)} GROUP BY agent_tier
  `).all(...dateFilter.params) as Array<{ agent_tier: string; count: number }>;
  const agentTierDistribution = tierRows.map((r) => ({ tier: r.agent_tier, count: r.count }));

  // Overall (ungrouped) TTFT/TPS from attempts that stamped a first token.
  const overallLatency = emptyLatencySamples();
  for (const row of iterateLatencyRows(db, dateFilter)) {
    recordLatencySample(overallLatency, row);
  }
  const latency = summarizeLatency(overallLatency);

  return {
    stats: {
      totalCost,
      totalInputTokens: tokens.input_tokens,
      totalOutputTokens: tokens.output_tokens,
      totalCacheReadTokens: tokens.cache_read_tokens,
      totalCacheWriteTokens: tokens.cache_write_tokens,
      totalReasoningTokens: tokens.reasoning_tokens,
      totalAttempts: stats.total,
      succeededAttempts: stats.succeeded,
      failedAttempts: stats.failed,
      interruptedAttempts: stats.interrupted,
      unknownCostCount: unknownCost.count,
      knownUsageCount: stats.known_usage,
      unknownUsageCount: stats.unknown_usage,
      totalSessions: stats.sessions,
      avgTtftMs: latency.avgTtftMs,
      avgTokensPerSecond: latency.avgTokensPerSecond,
    },
    spendOverTime,
    tokenUsageOverTime,
    spendByModel,
    spendByProvider,
    outcomeDistribution,
    costSourceDistribution,
    agentTierDistribution,
    quotaByProvider: getQuotaOverview(),
  };
}

export function getSessions(
  limit = DEFAULT_LIMIT,
  timeRange?: AnalyticsTimeRange,
  offset = 0,
  ctx?: AnalyticsQueryContext,
): SessionsResult {
  const db = getDb(ctx);
  const dateFilter = buildDateFilter(timeRange);

  const sessions = db.prepare(`
    SELECT session_id,
      COUNT(*) as attempts,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      MIN(started_at) as first_attempt,
      MAX(completed_at) as last_attempt,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      GROUP_CONCAT(DISTINCT model_id) as models
    FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY session_id ORDER BY first_attempt DESC LIMIT ? OFFSET ?
  `).all(...dateFilter.params, limit, offset) as Array<{
    session_id: string; attempts: number; succeeded: number; failed: number; interrupted: number;
    first_attempt: string; last_attempt: string | null;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    models: string | null;
  }>;

  const subagentRows = db.prepare(`
    SELECT session_id, COUNT(*) as count FROM subagent_attribution ${whereClause([], buildDateFilter(timeRange).clause)} GROUP BY session_id
  `).all(...buildDateFilter(timeRange).params) as Array<{ session_id: string; count: number }>;
  const subagentMap = new Map<string, number>();
  for (const r of subagentRows) {
    subagentMap.set(r.session_id, r.count);
  }

  const costMap = new Map<string, Map<string, DecimalTotal>>();
  for (const row of iterateRows<{ session_id: string; currency: string; cost_amount: string }>(db, `
    SELECT session_id, currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    bumpCurrencyTotal(nestedCurrencyMap(costMap, row.session_id), row.currency, parseCostAmount(row.cost_amount));
  }

  const sessionIds = sessions.map((s) => s.session_id);
  const resolveNames = ctx?.resolveSessionNames
    ?? ((ids: readonly string[]) => resolveSessionNamesWithFallback(db, ids));
  let nameMap = new Map<string, string>();
  try {
    nameMap = resolveNames(sessionIds);
  } catch { /* session name resolution failed */ }

  const results = sessions.map((s) => ({
    sessionId: s.session_id,
    sessionName: nameMap.get(s.session_id) ?? null,
    totalCost: toCurrencyTotals(costMap.get(s.session_id)),
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    cacheReadTokens: s.cache_read_tokens,
    totalTokens: s.input_tokens + s.output_tokens,
    attempts: s.attempts,
    succeeded: s.succeeded,
    failed: s.failed,
    interrupted: s.interrupted,
    firstAttempt: s.first_attempt,
    lastAttempt: s.last_attempt,
    modelsUsed: s.models ? s.models.split(',') : [],
    subagentCount: subagentMap.get(s.session_id) ?? 0,
  }));
  const total = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as count
    FROM provider_attempts ${whereClause([], dateFilter.clause)}
  `).get(...dateFilter.params) as { count: number };
  // totalSessions counts every distinct session under the date filter (not
  // just this page), so truncated reflects rows beyond offset + this page.
  return {
    sessions: results,
    totalSessions: total.count,
    truncated: total.count > offset + results.length,
  };
}

/**
 * Row shape behind {@link AttemptDetail}. Shared by session detail and model
 * detail so both surfaces return identical attempt projections.
 */
type AttemptDetailRow = {
  attempt_id: string; chain_id: string | null; turn_id: string | null;
  provider_id: string; model_id: string; connection_id: string; outcome: string;
  cost_state: string; cost_amount: string | null; currency: string | null; usage_json: string | null;
  started_at: string; completed_at: string | null; first_token_at: string | null;
  agent_scope: string | null; agent_name: string | null; agent_tier: string | null;
  error: string | null; snapshot_json: string;
};

/** Project one provider_attempts row into the shared AttemptDetail shape. */
function toAttemptDetail(r: AttemptDetailRow, u: ParsedUsage): AttemptDetail {
  const firstTokenMs = r.first_token_at ? new Date(r.first_token_at).getTime() : null;
  const ttftMs = firstTokenMs !== null
    ? firstTokenMs - new Date(r.started_at).getTime()
    : null;
  const generationMs = firstTokenMs !== null && r.completed_at
    ? new Date(r.completed_at).getTime() - firstTokenMs
    : 0;

  return {
    attemptId: r.attempt_id,
    chainId: r.chain_id,
    turnId: r.turn_id,
    providerId: r.provider_id,
    modelId: r.model_id,
    modelDisplayName: parseSnapshotModelDisplayName(r.snapshot_json),
    connectionId: r.connection_id,
    connectionName: parseSnapshotConnectionName(r.snapshot_json),
    outcome: r.outcome,
    costState: r.cost_state,
    costAmount: r.cost_amount,
    currency: r.currency,
    inputTokens: u.inputTokens ?? null,
    outputTokens: u.outputTokens ?? null,
    cacheReadTokens: u.cacheReadTokens ?? null,
    cacheWriteTokens: u.cacheWriteTokens ?? null,
    reasoningTokens: u.reasoningTokens ?? null,
    energyKwhConsumed: u.energyKwhConsumed,
    energyKwhCharged: u.energyKwhCharged,
    pricingMultiplier: u.pricingMultiplier,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    latencyMs: r.completed_at ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime() : null,
    firstTokenAt: r.first_token_at,
    ttftMs,
    // Generation window must be positive to rate tokens.
    tokensPerSecond: generationMs > 0
      ? Math.round((u.outputTokens / (generationMs / 1000)) * 10) / 10
      : null,
    agentScope: r.agent_scope,
    agentName: r.agent_name,
    agentTier: r.agent_tier,
    error: r.error,
  };
}

export function getSessionDetail(sessionId: string, timeRange?: AnalyticsTimeRange): SessionDetailResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);
  const rows = db.prepare(`
    SELECT attempt_id, chain_id, turn_id, provider_id, model_id, connection_id, outcome,
      cost_state, cost_amount, currency, usage_json, started_at, completed_at, first_token_at,
      agent_scope, agent_name, agent_tier, error, snapshot_json
    FROM provider_attempts ${whereClause(['session_id = ?'], dateFilter.clause)} ORDER BY started_at ASC
  `).all(sessionId, ...dateFilter.params) as AttemptDetailRow[];

  const parsedRows = rows.map((r) => ({ row: r, usage: parseUsage(r.usage_json) }));

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  const models = new Set<string>();
  const providers = new Set<string>();
  let succeeded = 0, failed = 0, interrupted = 0;
  const costs = sumCosts(rows.map((r) => ({ currency: r.currency, cost_amount: r.cost_amount, cost_state: r.cost_state })));

  let lastAttempt: string | null = null;
  for (const r of rows) {
    if (r.completed_at !== null && (lastAttempt === null || r.completed_at > lastAttempt)) {
      lastAttempt = r.completed_at;
    }
  }

  const attempts = parsedRows.map(({ row: r, usage: u }) => {
    totalInput += u.inputTokens; totalOutput += u.outputTokens; totalCacheRead += u.cacheReadTokens;
    models.add(r.model_id); providers.add(r.provider_id);
    if (r.outcome === 'succeeded') succeeded++;
    else if (r.outcome === 'failed') failed++;
    else if (r.outcome === 'interrupted') interrupted++;

    return toAttemptDetail(r, u);
  });

  const chainMap = new Map<string, {
    agentName: string | null; agentTier: string | null;
    costs: Map<string, { amount: Decimal; count: number }>;
    input: number; output: number; attempts: number; succeeded: number; failed: number; interrupted: number;
  }>();
  for (const { row: r, usage: u } of parsedRows) {
    const key = r.chain_id ?? '__main__';
    const chain = chainMap.get(key) ?? {
      agentName: r.agent_name, agentTier: r.agent_tier, costs: new Map(),
      input: 0, output: 0, attempts: 0, succeeded: 0, failed: 0, interrupted: 0,
    };
    chain.input += u.inputTokens; chain.output += u.outputTokens; chain.attempts++;
    if (r.outcome === 'succeeded') chain.succeeded++;
    else if (r.outcome === 'failed') chain.failed++;
    else if (r.outcome === 'interrupted') chain.interrupted++;
    if (r.cost_amount && r.currency && (r.cost_state === 'reported' || r.cost_state === 'calculated')) {
      try {
        const entry = chain.costs.get(r.currency) ?? { amount: new Decimal(0), count: 0 };
        entry.amount = entry.amount.add(new Decimal(r.cost_amount));
        entry.count++;
        chain.costs.set(r.currency, entry);
      } catch { /* skip */ }
    }
    chainMap.set(key, chain);
  }
  const chains = [...chainMap.entries()].map(([chainId, c]) => ({
    chainId: chainId === '__main__' ? null : chainId,
    agentName: c.agentName,
    agentTier: c.agentTier,
    totalCost: [...c.costs.entries()]
      .map(([currency, value]) => ({ currency, amount: value.amount.toFixed(), recordCount: value.count }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    inputTokens: c.input,
    outputTokens: c.output,
    attempts: c.attempts,
    succeeded: c.succeeded,
    failed: c.failed,
    interrupted: c.interrupted,
  }));

  let toolCalls: ToolCallDetail[] = [];
  try {
    const toolDateFilter = buildDateFilter(timeRange);
    const toolRows = db.prepare(`
      SELECT * FROM tool_attempts
      ${whereClause(['session_id = ?'], toolDateFilter.clause)}
      ORDER BY started_at DESC
    `).all(sessionId, ...toolDateFilter.params) as Array<{
      tool_attempt_id: string; tool_name: string; tool_source: string; mcp_server_name: string | null;
      tool_family: string; started_at: string; completed_at: string | null; outcome: string;
      result_size_bytes: number | null; offloaded: number; timed_out: number; agent_scope: string | null;
    }>;
    toolCalls = toolRows.map((t) => ({
      toolAttemptId: t.tool_attempt_id,
      toolName: t.tool_name,
      toolSource: t.tool_source,
      mcpServerName: t.mcp_server_name,
      toolFamily: t.tool_family,
      startedAt: t.started_at,
      completedAt: t.completed_at,
      durationMs: t.completed_at ? new Date(t.completed_at).getTime() - new Date(t.started_at).getTime() : null,
      outcome: t.outcome,
      resultSizeBytes: t.result_size_bytes,
      offloaded: t.offloaded === 1,
      timedOut: t.timed_out === 1,
      agentScope: t.agent_scope,
    }));
  } catch { /* store unavailable */ }

  let subagentRows: readonly SubagentAttributionRecord[] = [];
  try {
    const subagentStore = getSubagentAttributionStore();
    subagentRows = subagentStore.listBySession(sessionId).filter((row) => (
      (!timeRange?.startDate || row.startedAt >= timeRange.startDate)
      && (!timeRange?.endDate || row.startedAt <= timeRange.endDate)
    ));
  } catch { /* store unavailable */ }

  const subagents = subagentRows.map((sa) => {
    const saAttempts = parsedRows.filter(({ row: r }) => r.chain_id === sa.chainId);
    let saInput = 0, saOutput = 0;
    for (const { usage: u } of saAttempts) {
      saInput += u.inputTokens; saOutput += u.outputTokens;
    }
    const saCosts = sumCosts(saAttempts.map(({ row: r }) => ({
      currency: r.currency,
      cost_amount: r.cost_amount,
      cost_state: r.cost_state,
    })));
    return {
      subagentId: sa.subagentId,
      agentName: sa.agentName,
      agentType: sa.agentType,
      agentTier: sa.agentTier,
      modelId: sa.modelId,
      status: sa.status,
      totalCost: saCosts.currencies,
      inputTokens: saInput,
      outputTokens: saOutput,
      attempts: saAttempts.length,
      startedAt: sa.startedAt,
      completedAt: sa.completedAt,
    };
  });

  let sessionName: string | null = null;
  try {
    const nameMap = resolveSessionNamesWithFallback(db, [sessionId]);
    sessionName = nameMap.get(sessionId) ?? null;
  } catch { /* session name resolution failed */ }

  return {
    sessionId,
    sessionName,
    summary: {
      totalCost: costs.currencies,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheReadTokens: totalCacheRead,
      attemptCount: rows.length,
      succeeded, failed, interrupted,
      firstAttempt: rows.length > 0 ? rows[0].started_at : null,
      lastAttempt,
      modelsUsed: [...models],
      providersUsed: [...providers],
      subagentCount: subagentRows.length,
    },
    chains,
    attempts,
    toolCalls,
    subagents,
  };
}

export function getModels(timeRange?: AnalyticsTimeRange): ModelsResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);

  // Single GROUP BY for model-level aggregates — token sums via SQL json_extract
  // (integers are safe in SQL), counts and dates included directly.
  const modelRows = db.prepare(`
    SELECT model_id, provider_id, connection_id, snapshot_json,
      COUNT(*) as attempts,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) as cache_write_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens,
      MIN(started_at) as first_used,
      MAX(completed_at) as last_used
    FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY model_id, provider_id, connection_id ORDER BY first_used DESC
  `).all(...dateFilter.params) as Array<{
    model_id: string; provider_id: string; connection_id: string; snapshot_json: string;
    attempts: number; succeeded: number; failed: number; interrupted: number;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_write_tokens: number; reasoning_tokens: number;
    first_used: string; last_used: string | null;
  }>;

  // Single GROUP BY for connection-level aggregates — includes token sums and
  // snapshot_json (arbitrary row; connection metadata is consistent per connection).
  const connectionRows = db.prepare(`
    SELECT connection_id, provider_id, snapshot_json,
      COUNT(*) as attempts,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      COUNT(DISTINCT model_id) as model_count,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      MIN(started_at) as first_used,
      MAX(completed_at) as last_used
    FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY connection_id ORDER BY first_used DESC
  `).all(...dateFilter.params) as Array<{
    connection_id: string; provider_id: string; snapshot_json: string;
    attempts: number; succeeded: number; failed: number; interrupted: number;
    model_count: number; input_tokens: number; output_tokens: number;
    first_used: string; last_used: string | null;
  }>;

  // Stream raw cost rows and aggregate with Decimal.js in JS — grouped by
  // (model_id, provider_id, connection_id), by connection_id, and overall.
  const modelCostMap = new Map<string, Map<string, DecimalTotal>>();
  const connectionCostMap = new Map<string, Map<string, DecimalTotal>>();
  const totalCostMap = new Map<string, DecimalTotal>();
  for (const row of iterateRows<{
    model_id: string; provider_id: string; connection_id: string; currency: string; cost_amount: string;
  }>(db, `
    SELECT model_id, provider_id, connection_id, currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    const amount = parseCostAmount(row.cost_amount);
    bumpCurrencyTotal(nestedCurrencyMap(modelCostMap, `${row.model_id}\0${row.provider_id}\0${row.connection_id}`), row.currency, amount);
    bumpCurrencyTotal(nestedCurrencyMap(connectionCostMap, row.connection_id), row.currency, amount);
    bumpCurrencyTotal(totalCostMap, row.currency, amount);
  }

  // Stream first-token latency rows — same grouping as the cost maps.
  const modelLatencyMap = new Map<string, LatencySamples>();
  const connectionLatencyMap = new Map<string, LatencySamples>();
  for (const row of iterateLatencyRows(db, dateFilter)) {
    recordLatencySample(latencySamplesFor(modelLatencyMap, `${row.model_id}\0${row.provider_id}\0${row.connection_id}`), row);
    recordLatencySample(latencySamplesFor(connectionLatencyMap, row.connection_id), row);
  }

  const models = modelRows.map((m) => ({
    modelId: m.model_id,
    modelDisplayName: parseSnapshotModelDisplayName(m.snapshot_json),
    providerId: m.provider_id,
    connectionId: m.connection_id,
    connectionName: parseSnapshotConnectionName(m.snapshot_json),
    totalCost: toCurrencyTotals(modelCostMap.get(`${m.model_id}\0${m.provider_id}\0${m.connection_id}`)),
    inputTokens: m.input_tokens,
    outputTokens: m.output_tokens,
    cacheReadTokens: m.cache_read_tokens,
    cacheWriteTokens: m.cache_write_tokens,
    reasoningTokens: m.reasoning_tokens,
    attempts: m.attempts,
    succeeded: m.succeeded,
    failed: m.failed,
    interrupted: m.interrupted,
    firstUsed: m.first_used,
    lastUsed: m.last_used,
    ...summarizeLatency(modelLatencyMap.get(`${m.model_id}\0${m.provider_id}\0${m.connection_id}`)),
  }));

  const connections: ConnectionBreakdown[] = connectionRows.map((c) => ({
    connectionId: c.connection_id,
    connectionName: parseSnapshotConnectionName(c.snapshot_json),
    providerId: c.provider_id,
    providerDisplayName: parseSnapshotProviderName(c.snapshot_json),
    totalCost: toCurrencyTotals(connectionCostMap.get(c.connection_id)),
    totalInputTokens: c.input_tokens,
    totalOutputTokens: c.output_tokens,
    attempts: c.attempts,
    succeeded: c.succeeded,
    failed: c.failed,
    interrupted: c.interrupted,
    modelCount: c.model_count,
    firstUsed: c.first_used,
    lastUsed: c.last_used,
    ...summarizeLatency(connectionLatencyMap.get(c.connection_id)),
  }));

  // Stream raw cost rows for the time series and aggregate per
  // (date, model, provider, connection, currency) and per
  // (date, connection, provider, currency) with Decimal.js in JS.
  const modelSeriesMap = new Map<string, {
    date: string; modelId: string; providerId: string; connectionId: string; currency: string; amount: Decimal;
  }>();
  const connectionSeriesMap = new Map<string, {
    date: string; connectionId: string; providerId: string; currency: string; amount: Decimal;
  }>();
  for (const row of iterateRows<{
    date: string; model_id: string; provider_id: string; connection_id: string; currency: string; cost_amount: string;
  }>(db, `
    SELECT strftime('%Y-%m-%d', started_at) as date, model_id, provider_id, connection_id, currency, cost_amount
    FROM provider_attempts
    ${whereClause(COST_ROW_CONDITIONS, dateFilter.clause)}
  `, dateFilter.params)) {
    const amount = parseCostAmount(row.cost_amount) ?? new Decimal(0);
    const modelKey = `${row.date}\0${row.model_id}\0${row.provider_id}\0${row.connection_id}\0${row.currency}`;
    const modelEntry = modelSeriesMap.get(modelKey) ?? {
      date: row.date, modelId: row.model_id, providerId: row.provider_id,
      connectionId: row.connection_id, currency: row.currency, amount: new Decimal(0),
    };
    modelEntry.amount = modelEntry.amount.add(amount);
    modelSeriesMap.set(modelKey, modelEntry);

    const connectionKey = `${row.date}\0${row.connection_id}\0${row.provider_id}\0${row.currency}`;
    const connectionEntry = connectionSeriesMap.get(connectionKey) ?? {
      date: row.date, connectionId: row.connection_id, providerId: row.provider_id,
      currency: row.currency, amount: new Decimal(0),
    };
    connectionEntry.amount = connectionEntry.amount.add(amount);
    connectionSeriesMap.set(connectionKey, connectionEntry);
  }

  const costPerModelOverTime: ModelCostTimeSeriesPoint[] = [...modelSeriesMap.values()]
    .map((entry) => ({
      date: entry.date,
      modelId: entry.modelId,
      providerId: entry.providerId,
      connectionId: entry.connectionId,
      currency: entry.currency,
      cost: entry.amount.toFixed(),
    }))
    .sort((a, b) => (
      a.date.localeCompare(b.date)
      || a.currency.localeCompare(b.currency)
      || a.providerId.localeCompare(b.providerId)
      || a.modelId.localeCompare(b.modelId)
      || a.connectionId.localeCompare(b.connectionId)
    ));

  const costPerConnectionOverTime: ConnectionCostTimeSeriesPoint[] = [...connectionSeriesMap.values()]
    .map((entry) => ({
      date: entry.date,
      connectionId: entry.connectionId,
      providerId: entry.providerId,
      currency: entry.currency,
      cost: entry.amount.toFixed(),
    }))
    .sort((a, b) => (
      a.date.localeCompare(b.date)
      || a.currency.localeCompare(b.currency)
      || a.providerId.localeCompare(b.providerId)
      || a.connectionId.localeCompare(b.connectionId)
    ));

  const totalCost = toCurrencyTotals(totalCostMap);

  return { totalCost, models, connections, costPerModelOverTime, costPerConnectionOverTime };
}

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
  for (const row of iterateRows<{
    date: string; started_at: string; first_token_at: string; completed_at: string; output_tokens: number | null;
  }>(db, `
    SELECT strftime('%Y-%m-%d', started_at) as date, started_at, first_token_at, completed_at,
      json_extract(usage_json, '$.outputTokens') as output_tokens
    FROM provider_attempts
    ${tripleWhere(['first_token_at IS NOT NULL', 'completed_at IS NOT NULL'])}
  `, [...tripleParams, ...dateFilter.params])) {
    const ttftMs = recordLatencySample(latencySamples, row);
    const day = dailyTtft.get(row.date) ?? [];
    day.push(ttftMs);
    dailyTtft.set(row.date, day);
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

  const resolveNames = ctx?.resolveSessionNames
    ?? ((ids: readonly string[]) => resolveSessionNamesWithFallback(db, ids));
  const nameMap = resolveManySessionNames(resolveNames, topSessionRows.map((r) => r.session_id));
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

export function getTools(timeRange?: AnalyticsTimeRange): ToolsResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);
  const tools = db.prepare(`
    SELECT tool_name, tool_source, mcp_server_name, tool_family,
      COUNT(*) as invocations,
      COALESCE(SUM(CASE WHEN outcome IN ('complete','partial','empty') THEN 1 ELSE 0 END), 0) as complete,
      COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) as error,
      COALESCE(SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END), 0) as cancelled,
      COALESCE(SUM(timed_out), 0) as timed_out,
      AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(started_at)) * 86400000 END) as avg_duration_ms,
      AVG(result_size_bytes) as avg_result_size_bytes,
      CAST(SUM(offloaded) AS REAL) / COUNT(*) as offload_rate
    FROM tool_attempts ${whereClause([], dateFilter.clause)}
    GROUP BY tool_name, tool_source, mcp_server_name, tool_family
    ORDER BY invocations DESC, tool_name
  `).all(...dateFilter.params) as Array<{
    tool_name: string; tool_source: 'builtin' | 'mcp'; mcp_server_name: string | null; tool_family: string;
    invocations: number; complete: number; error: number; cancelled: number; timed_out: number;
    avg_duration_ms: number | null; avg_result_size_bytes: number | null; offload_rate: number;
  }>;

  const outcomeDistribution = db.prepare(`
    SELECT outcome, COUNT(*) as count
    FROM tool_attempts ${whereClause([], dateFilter.clause)}
    GROUP BY outcome ORDER BY outcome
  `).all(...dateFilter.params) as Array<{ outcome: string; count: number }>;

  const invocationsOverTime = db.prepare(`
    WITH top_tools AS (
      SELECT tool_name
      FROM tool_attempts ${whereClause([], dateFilter.clause)}
      GROUP BY tool_name ORDER BY COUNT(*) DESC, tool_name LIMIT 8
    )
    SELECT strftime('%Y-%m-%d', started_at) as date,
      CASE WHEN tool_name IN (SELECT tool_name FROM top_tools) THEN tool_name ELSE 'Other' END as tool_name,
      COUNT(*) as count
    FROM tool_attempts ${whereClause([], dateFilter.clause)}
    GROUP BY date, CASE WHEN tool_name IN (SELECT tool_name FROM top_tools) THEN tool_name ELSE 'Other' END
    ORDER BY date, tool_name
  `).all(...dateFilter.params, ...dateFilter.params) as Array<{ date: string; tool_name: string; count: number }>;

  return {
    tools: tools.map((tool) => ({
      toolName: tool.tool_name,
      toolSource: tool.tool_source,
      mcpServerName: tool.mcp_server_name,
      toolFamily: tool.tool_family,
      invocations: tool.invocations,
      complete: tool.complete,
      error: tool.error,
      cancelled: tool.cancelled,
      timedOut: tool.timed_out,
      avgDurationMs: tool.avg_duration_ms === null ? null : Math.round(tool.avg_duration_ms),
      avgResultSizeBytes: tool.avg_result_size_bytes === null ? null : Math.round(tool.avg_result_size_bytes),
      offloadRate: tool.offload_rate,
    })),
    invocationsOverTime: invocationsOverTime.map((row) => ({ date: row.date, toolName: row.tool_name, count: row.count })),
    outcomeDistribution,
  };
}
// ── Subagent attribution ↔ attempt joins ──────────────────────────────────────

/**
 * Follow-up runs share one chain (record.chain.id is stable) while each run
 * inserts its own attribution row — so attempts must be attributed to the run
 * whose window contains them. Joining by chain alone would multiply usage,
 * cost, and latency once per run sharing the chain. The first run's window is
 * unbounded below so chain attempts recorded before the earliest attribution
 * row (e.g. recovery-reconstructed attributions) still count once.
 */
function subagentRunWindows(filteredSaCte: string): string {
  return `
    run_windows AS (
      SELECT sa.subagent_id, sa.agent_name, sa.agent_type, sa.agent_tier,
        sa.session_id, sa.chain_id, sa.model_id, sa.started_at, sa.completed_at, sa.status,
        LAG(sa.started_at) OVER (PARTITION BY sa.chain_id ORDER BY sa.started_at, sa.subagent_id) as prev_started_at,
        LEAD(sa.started_at) OVER (PARTITION BY sa.chain_id ORDER BY sa.started_at, sa.subagent_id) as next_started_at
      FROM (${filteredSaCte}) sa
    )`;
}

const ATTEMPT_RUN_WINDOW_JOIN = 'pa.chain_id = rw.chain_id'
  + ' AND (rw.prev_started_at IS NULL OR pa.started_at >= rw.started_at)'
  + ' AND (rw.next_started_at IS NULL OR pa.started_at < rw.next_started_at)';

/** Per-run usage sums: window-attributed attempts, one row per attribution run. */
function subagentRunUsage(filteredAttempts: string): string {
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

const RUN_USAGE_JOIN = 'ru.subagent_id = sa.subagent_id AND ru.chain_id = sa.chain_id AND ru.started_at = sa.started_at';

export function getSubagents(timeRange?: AnalyticsTimeRange): SubagentsResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);
  const filteredSubagents = `SELECT * FROM subagent_attribution ${whereClause([], dateFilter.clause)}`;
  const filteredAttempts = `SELECT * FROM provider_attempts ${whereClause([], dateFilter.clause)}`;
  const summaryRows = db.prepare(`
    WITH filtered_sa AS (${filteredSubagents}),
    ${subagentRunWindows('filtered_sa')},
    ${subagentRunUsage(filteredAttempts)}
    SELECT sa.agent_name, sa.agent_type, sa.agent_tier,
      GROUP_CONCAT(DISTINCT sa.model_id) as models,
      COUNT(*) as invocations,
      COALESCE(SUM(ru.input_tokens), 0) as input_tokens,
      COALESCE(SUM(ru.output_tokens), 0) as output_tokens,
      COALESCE(SUM(ru.attempts), 0) as attempts,
      COALESCE(SUM(CASE WHEN sa.status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN sa.status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN sa.status = 'interrupted' THEN 1 ELSE 0 END), 0) as interrupted,
      AVG(CASE WHEN sa.completed_at IS NOT NULL THEN (julianday(sa.completed_at) - julianday(sa.started_at)) * 86400000 END) as avg_duration_ms
    FROM filtered_sa sa JOIN run_usage ru ON ${RUN_USAGE_JOIN}
    GROUP BY sa.agent_name, sa.agent_type, sa.agent_tier
    ORDER BY invocations DESC, sa.agent_name
  `).all(...dateFilter.params, ...dateFilter.params) as Array<{
    agent_name: string; agent_type: string; agent_tier: string; models: string | null;
    invocations: number; input_tokens: number; output_tokens: number; attempts: number;
    completed: number; failed: number; interrupted: number; avg_duration_ms: number | null;
  }>;

  const summaryCostMap = new Map<string, Map<string, DecimalTotal>>();
  const agentNameCostMap = new Map<string, Map<string, Decimal>>();
  const agentTierCostMap = new Map<string, Map<string, Decimal>>();
  for (const row of iterateRows<{
    agent_name: string; agent_type: string; agent_tier: string; currency: string; cost_amount: string;
  }>(db, `
    WITH filtered_sa AS (${filteredSubagents}), ${subagentRunWindows('filtered_sa')}
    SELECT rw.agent_name, rw.agent_type, rw.agent_tier, pa.currency, pa.cost_amount
    FROM run_windows rw JOIN (${filteredAttempts}) pa ON ${ATTEMPT_RUN_WINDOW_JOIN}
    WHERE pa.cost_state IN ('reported','calculated') AND pa.currency IS NOT NULL AND pa.cost_amount IS NOT NULL
  `, [...dateFilter.params, ...dateFilter.params])) {
    const amount = parseCostAmount(row.cost_amount);
    bumpCurrencyTotal(
      nestedCurrencyMap(summaryCostMap, `${row.agent_name}\0${row.agent_type}\0${row.agent_tier}`),
      row.currency,
      amount,
    );
    if (amount) {
      const nameCosts = agentNameCostMap.get(row.agent_name) ?? new Map<string, Decimal>();
      nameCosts.set(row.currency, (nameCosts.get(row.currency) ?? new Decimal(0)).add(amount));
      agentNameCostMap.set(row.agent_name, nameCosts);
      const tierCosts = agentTierCostMap.get(row.agent_tier) ?? new Map<string, Decimal>();
      tierCosts.set(row.currency, (tierCosts.get(row.currency) ?? new Decimal(0)).add(amount));
      agentTierCostMap.set(row.agent_tier, tierCosts);
    }
  }

  const summaries = summaryRows.map((row) => ({
    agentName: row.agent_name,
    agentType: row.agent_type,
    agentTier: row.agent_tier,
    modelsUsed: row.models ? row.models.split(',') : [],
    invocations: row.invocations,
    totalCost: toCurrencyTotals(summaryCostMap.get(`${row.agent_name}\0${row.agent_type}\0${row.agent_tier}`)),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    attempts: row.attempts,
    completed: row.completed,
    failed: row.failed,
    interrupted: row.interrupted,
    avgDurationMs: row.avg_duration_ms === null ? null : Math.round(row.avg_duration_ms),
  }));

  const costByAgentName = [...agentNameCostMap.entries()]
    .flatMap(([agentName, costs]) => (
      [...costs.entries()].map(([currency, cost]) => ({ agentName, currency, cost: cost.toFixed() }))
    ))
    .sort((a, b) => a.agentName.localeCompare(b.agentName) || a.currency.localeCompare(b.currency));
  const costByAgentTier = [...agentTierCostMap.entries()]
    .flatMap(([tier, costs]) => (
      [...costs.entries()].map(([currency, cost]) => ({ tier, currency, cost: cost.toFixed() }))
    ))
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.currency.localeCompare(b.currency));
  const outcomeDistribution = db.prepare(`
    SELECT status, COUNT(*) as count FROM subagent_attribution
    ${whereClause([], dateFilter.clause)} GROUP BY status ORDER BY status
  `).all(...dateFilter.params) as Array<{ status: string; count: number }>;

  const invocationsOverTime = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date, COUNT(*) as count
    FROM subagent_attribution ${whereClause([], dateFilter.clause)}
    GROUP BY date ORDER BY date ASC
  `).all(...dateFilter.params) as Array<{ date: string; count: number }>;

  return {
    summaries,
    costByAgentName,
    costByAgentTier,
    outcomeDistribution,
    invocationsOverTime: invocationsOverTime.map((row) => ({ date: row.date, count: row.count })),
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
  for (const row of iterateRows<{
    started_at: string; first_token_at: string; completed_at: string; output_tokens: number | null;
  }>(db, `
    WITH filtered_sa AS (${filteredSubagents}), ${subagentRunWindows('filtered_sa')}
    SELECT pa.started_at, pa.first_token_at, pa.completed_at,
      json_extract(pa.usage_json, '$.outputTokens') as output_tokens
    FROM run_windows rw JOIN (${filteredAttempts}) pa ON ${ATTEMPT_RUN_WINDOW_JOIN}
    WHERE pa.first_token_at IS NOT NULL AND pa.completed_at IS NOT NULL
  `, joinParams)) {
    recordLatencySample(latencySamples, row);
  }
  const latency = summarizeLatency(latencySamples);

  const overTimeRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date, COUNT(*) as count
    FROM subagent_attribution ${whereClause(tripleConditions, dateFilter.clause)}
    GROUP BY date ORDER BY date ASC
  `).all(input.agentName, input.agentType, input.agentTier, ...dateFilter.params) as Array<{ date: string; count: number }>;

  const resolveNames = ctx?.resolveSessionNames
    ?? ((ids: readonly string[]) => resolveSessionNamesWithFallback(db, ids));
  const nameMap = resolveManySessionNames(resolveNames, invocationRows.map((r) => r.session_id));
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

export function getContext(sessionId?: string, timeRange?: AnalyticsTimeRange, ctx: AnalyticsQueryContext = {}): ContextResult {
  const db = getDb(ctx);
  const dateFilter = buildDateFilter(timeRange, 'captured_at');
  const conditions = sessionId ? ['session_id = ?'] : [];
  const params = sessionId ? [sessionId, ...dateFilter.params] : dateFilter.params;
  const where = whereClause(conditions, dateFilter.clause);
  const mainWhere = whereClause([...conditions, 'agent_scope IS NULL'], dateFilter.clause);
  const subagentWhere = whereClause([...conditions, 'agent_scope IS NOT NULL'], dateFilter.clause);
  const aggregate = db.prepare(`
    SELECT COUNT(*) as total,
      COALESCE(AVG(used_tokens), 0) as used_tokens,
      COALESCE(AVG(system_tokens), 0) as system_tokens,
      COALESCE(AVG(tools_tokens), 0) as tools_tokens,
      COALESCE(AVG(tool_use_tokens), 0) as tool_use_tokens,
      COALESCE(AVG(user_tokens), 0) as user_tokens,
      COALESCE(AVG(assistant_tokens), 0) as assistant_tokens,
      COALESCE(AVG(summary_tokens), 0) as summary_tokens
    FROM context_snapshots ${where}
  `).get(...params) as {
    total: number; used_tokens: number; system_tokens: number; tools_tokens: number;
    tool_use_tokens: number; user_tokens: number; assistant_tokens: number; summary_tokens: number;
  };

  const topSessionRows = db.prepare(`
    SELECT session_id, MAX(used_tokens) as max_used_tokens
    FROM context_snapshots ${mainWhere}
    GROUP BY session_id
    ORDER BY max_used_tokens DESC, session_id ASC
    LIMIT ?
  `).all(...params, CONTEXT_TOP_SESSIONS) as Array<{ session_id: string; max_used_tokens: number }>;

  let nameMap = new Map<string, string>();
  try {
    const resolveNames = ctx.resolveSessionNames
      ?? ((ids: readonly string[]) => resolveSessionNamesWithFallback(db, ids));
    nameMap = resolveNames(topSessionRows.map((r) => r.session_id));
  } catch (error) {
    console.warn('[analytics] Session name lookup failed', { error });
  }

  const sessionSeriesWhere = whereClause(['session_id = ?', 'agent_scope IS NULL'], dateFilter.clause);
  const sessionCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM context_snapshots ${sessionSeriesWhere}
  `);
  const sessionFullStmt = db.prepare(`
    SELECT captured_at, used_tokens
    FROM context_snapshots ${sessionSeriesWhere}
    ORDER BY captured_at ASC
  `);
  // Oversized series are stride-sampled in SQL so only the kept rows cross
  // into the main process: every stride-th row plus the newest snapshot and
  // the peak used_tokens snapshot (first peak wins on ties).
  const sessionSampledStmt = db.prepare(`
    WITH ordered AS (
      SELECT captured_at, used_tokens,
        row_number() OVER (ORDER BY captured_at ASC) AS rn
      FROM context_snapshots ${sessionSeriesWhere}
    )
    SELECT captured_at, used_tokens
    FROM ordered
    WHERE (rn - 1) % ? = 0
      OR rn = ?
      OR rn = (SELECT rn FROM ordered ORDER BY used_tokens DESC, rn ASC LIMIT 1)
    ORDER BY rn ASC
  `);
  const topSessions: ContextSessionSeries[] = topSessionRows.map((top) => {
    const { count } = sessionCountStmt.get(top.session_id, ...dateFilter.params) as { count: number };
    const rows = count <= CONTEXT_MAX_POINTS_PER_SERIES
      ? sessionFullStmt.all(top.session_id, ...dateFilter.params) as Array<{ captured_at: string; used_tokens: number }>
      : sessionSampledStmt.all(
          top.session_id,
          ...dateFilter.params,
          Math.ceil(count / CONTEXT_MAX_POINTS_PER_SERIES),
          count,
        ) as Array<{ captured_at: string; used_tokens: number }>;
    return {
      sessionId: top.session_id,
      sessionName: nameMap.get(top.session_id) ?? null,
      maxUsedTokens: top.max_used_tokens,
      points: rows.map((r) => ({ capturedAt: r.captured_at, usedTokens: r.used_tokens })),
    };
  });

  const topSubagentRows = db.prepare(`
    SELECT agent_scope, MAX(used_tokens) as max_used_tokens
    FROM context_snapshots ${subagentWhere}
    GROUP BY agent_scope
    ORDER BY max_used_tokens DESC, agent_scope ASC
    LIMIT ?
  `).all(...params, CONTEXT_TOP_SUBAGENTS) as Array<{ agent_scope: string; max_used_tokens: number }>;

  const subagentNameMap = new Map<string, { name: string; tier: string }>();
  if (topSubagentRows.length > 0) {
    try {
      const placeholders = topSubagentRows.map(() => '?').join(', ');
      const attributionRows = db.prepare(`
        SELECT subagent_id, agent_name, agent_tier
        FROM subagent_attribution
        WHERE subagent_id IN (${placeholders})
        GROUP BY subagent_id
      `).all(...topSubagentRows.map((r) => r.agent_scope)) as Array<{
        subagent_id: string; agent_name: string; agent_tier: string;
      }>;
      for (const row of attributionRows) {
        subagentNameMap.set(row.subagent_id, { name: row.agent_name, tier: row.agent_tier });
      }
    } catch (error) {
      console.warn('[analytics] Subagent name lookup failed', { error });
    }
  }

  const subagentSeriesWhere = whereClause(['agent_scope = ?'], dateFilter.clause);
  const subagentCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM context_snapshots ${subagentSeriesWhere}
  `);
  const subagentFullStmt = db.prepare(`
    SELECT captured_at, used_tokens
    FROM context_snapshots ${subagentSeriesWhere}
    ORDER BY captured_at ASC
  `);
  const subagentSampledStmt = db.prepare(`
    WITH ordered AS (
      SELECT captured_at, used_tokens,
        row_number() OVER (ORDER BY captured_at ASC) AS rn
      FROM context_snapshots ${subagentSeriesWhere}
    )
    SELECT captured_at, used_tokens
    FROM ordered
    WHERE (rn - 1) % ? = 0
      OR rn = ?
      OR rn = (SELECT rn FROM ordered ORDER BY used_tokens DESC, rn ASC LIMIT 1)
    ORDER BY rn ASC
  `);
  const topSubagents: ContextSubagentSeries[] = topSubagentRows.map((top) => {
    const { count } = subagentCountStmt.get(top.agent_scope, ...dateFilter.params) as { count: number };
    const rows = count <= CONTEXT_MAX_POINTS_PER_SERIES
      ? subagentFullStmt.all(top.agent_scope, ...dateFilter.params) as Array<{ captured_at: string; used_tokens: number }>
      : subagentSampledStmt.all(
          top.agent_scope,
          ...dateFilter.params,
          Math.ceil(count / CONTEXT_MAX_POINTS_PER_SERIES),
          count,
        ) as Array<{ captured_at: string; used_tokens: number }>;
    const meta = subagentNameMap.get(top.agent_scope);
    return {
      subagentId: top.agent_scope,
      agentName: meta?.name ?? null,
      agentTier: meta?.tier ?? null,
      maxUsedTokens: top.max_used_tokens,
      points: rows.map((r) => ({ capturedAt: r.captured_at, usedTokens: r.used_tokens })),
    };
  });

  const { count: totalSessionCount } = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as count FROM context_snapshots ${where}
  `).get(...params) as { count: number };

  const { count: totalSubagentCount } = db.prepare(`
    SELECT COUNT(DISTINCT agent_scope) as count FROM context_snapshots ${subagentWhere}
  `).get(...params) as { count: number };

  return {
    totalSnapshots: aggregate.total,
    totalSessionCount,
    topSessions,
    topSubagents,
    totalSubagentCount,
    avgBreakdown: {
      usedTokens: Math.round(aggregate.used_tokens),
      systemTokens: Math.round(aggregate.system_tokens),
      toolsTokens: Math.round(aggregate.tools_tokens),
      toolUseTokens: Math.round(aggregate.tool_use_tokens),
      userTokens: Math.round(aggregate.user_tokens),
      assistantTokens: Math.round(aggregate.assistant_tokens),
      summaryTokens: Math.round(aggregate.summary_tokens),
    },
  };
}

/**
 * Context drill-down for one session: a picker over every main-agent session
 * with snapshots in range, the full-fidelity main-agent snapshot series (no
 * stride sampling — capped at the most recent 2000 points), and a timeline of
 * contextual events (compactor attempts + largest used_tokens jumps).
 */
export function getContextSessionDetail(
  input: { sessionId: string; timeRange?: AnalyticsTimeRange },
  ctx?: AnalyticsQueryContext,
): ContextSessionDetailResult {
  const db = getDb(ctx);
  // Snapshots filter on captured_at; compaction attempts on started_at.
  const capturedFilter = buildDateFilter(input.timeRange, 'captured_at');
  const attemptFilter = buildDateFilter(input.timeRange);
  const resolveNames = ctx?.resolveSessionNames
    ?? ((ids: readonly string[]) => resolveSessionNamesWithFallback(db, ids));

  // Picker — every distinct main-agent session in range (ids + ints, so no cap).
  const pickerRows = db.prepare(`
    SELECT session_id, COUNT(*) as snapshot_count, MAX(used_tokens) as max_used_tokens
    FROM context_snapshots
    ${whereClause(['agent_scope IS NULL'], capturedFilter.clause)}
    GROUP BY session_id
    ORDER BY max_used_tokens DESC, session_id ASC
  `).all(...capturedFilter.params) as Array<{
    session_id: string; snapshot_count: number; max_used_tokens: number;
  }>;
  const pickerNameMap = resolveManySessionNames(resolveNames, pickerRows.map((r) => r.session_id));
  const sessions = pickerRows.map((r) => ({
    sessionId: r.session_id,
    sessionName: pickerNameMap.get(r.session_id) ?? null,
    snapshotCount: r.snapshot_count,
    maxUsedTokens: r.max_used_tokens,
  }));

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
    sessions,
    series,
    truncated: seriesCount > series.length,
    events,
  };
}
