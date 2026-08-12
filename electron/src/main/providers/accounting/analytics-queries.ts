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
  AnalyticsTimeRange,
} from '../../../shared/types/analytics';
import type { SubagentAttributionRecord } from '../../../shared/types/accounting';
import type { QuotaOverviewEntry } from '../../../shared/types/analytics';
import { providerQuotaSchema } from '../../../shared/types/provider-facets';
import { getSessionNames } from '../../session/storage';
import { getProviderStatusService } from '../runtime-context';

const DEFAULT_LIMIT = 1000;
const CONTEXT_TOP_SESSIONS = 5;
const CONTEXT_TOP_SUBAGENTS = 5;
const CONTEXT_MAX_POINTS_PER_SERIES = 500;

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
  /** Resolve session names for the top-N session ids. Defaults to `getSessionNames`. */
  resolveSessionNames?: (sessionIds: readonly string[]) => Map<string, string>;
}

function getDb(ctx?: AnalyticsQueryContext): SqliteDatabase {
  return ctx?.db ?? getProviderAccountingStore().getDatabase();
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
 */
function getQuotaOverview(): QuotaOverviewEntry[] {
  try {
    const status = getProviderStatusService();
    const entries: QuotaOverviewEntry[] = [];
    for (const observation of status.list()) {
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

export function getSessions(limit = DEFAULT_LIMIT, timeRange?: AnalyticsTimeRange): SessionsResult {
  const db = getDb();
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
    FROM provider_attempts ${whereClause([], dateFilter.clause)} GROUP BY session_id ORDER BY first_attempt DESC LIMIT ?
  `).all(...dateFilter.params, limit) as Array<{
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
  let nameMap = new Map<string, string>();
  try {
    nameMap = getSessionNames(sessionIds);
  } catch { /* session DB unavailable */ }

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
  return { sessions: results, totalSessions: total.count, truncated: total.count > results.length };
}

export function getSessionDetail(sessionId: string, timeRange?: AnalyticsTimeRange): SessionDetailResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);
  const rows = db.prepare(`
    SELECT attempt_id, chain_id, turn_id, provider_id, model_id, connection_id, outcome,
      cost_state, cost_amount, currency, usage_json, started_at, completed_at,
      agent_scope, agent_name, agent_tier, error, snapshot_json
    FROM provider_attempts ${whereClause(['session_id = ?'], dateFilter.clause)} ORDER BY started_at ASC
  `).all(sessionId, ...dateFilter.params) as Array<{
    attempt_id: string; chain_id: string | null; turn_id: string | null;
    provider_id: string; model_id: string; connection_id: string; outcome: string;
    cost_state: string; cost_amount: string | null; currency: string | null; usage_json: string | null;
    started_at: string; completed_at: string | null;
    agent_scope: string | null; agent_name: string | null; agent_tier: string | null;
    error: string | null; snapshot_json: string;
  }>;

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
      agentScope: r.agent_scope,
      agentName: r.agent_name,
      agentTier: r.agent_tier,
      error: r.error,
    };
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
    const nameMap = getSessionNames([sessionId]);
    sessionName = nameMap.get(sessionId) ?? null;
  } catch { /* session DB unavailable */ }

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
export function getSubagents(timeRange?: AnalyticsTimeRange): SubagentsResult {
  const db = getDb();
  const dateFilter = buildDateFilter(timeRange);
  const filteredSubagents = `SELECT * FROM subagent_attribution ${whereClause([], dateFilter.clause)}`;
  const filteredAttempts = `SELECT * FROM provider_attempts ${whereClause([], dateFilter.clause)}`;
  const summaryRows = db.prepare(`
    WITH filtered_sa AS (${filteredSubagents}),
    chain_usage AS (
      SELECT chain_id,
        COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
        COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
        COUNT(*) as attempts
      FROM (${filteredAttempts}) WHERE chain_id IS NOT NULL GROUP BY chain_id
    )
    SELECT sa.agent_name, sa.agent_type, sa.agent_tier,
      GROUP_CONCAT(DISTINCT sa.model_id) as models,
      COUNT(*) as invocations,
      COALESCE(SUM(cu.input_tokens), 0) as input_tokens,
      COALESCE(SUM(cu.output_tokens), 0) as output_tokens,
      COALESCE(SUM(cu.attempts), 0) as attempts,
      COALESCE(SUM(CASE WHEN sa.status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN sa.status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COALESCE(SUM(CASE WHEN sa.status = 'interrupted' THEN 1 ELSE 0 END), 0) as interrupted,
      AVG(CASE WHEN sa.completed_at IS NOT NULL THEN (julianday(sa.completed_at) - julianday(sa.started_at)) * 86400000 END) as avg_duration_ms
    FROM filtered_sa sa LEFT JOIN chain_usage cu ON cu.chain_id = sa.chain_id
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
    WITH filtered_sa AS (${filteredSubagents})
    SELECT sa.agent_name, sa.agent_type, sa.agent_tier, pa.currency, pa.cost_amount
    FROM filtered_sa sa JOIN (${filteredAttempts}) pa ON pa.chain_id = sa.chain_id
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
      COALESCE(AVG(assistant_tokens), 0) as assistant_tokens
    FROM context_snapshots ${where}
  `).get(...params) as {
    total: number; used_tokens: number; system_tokens: number; tools_tokens: number;
    tool_use_tokens: number; user_tokens: number; assistant_tokens: number;
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
    nameMap = (ctx.resolveSessionNames ?? getSessionNames)(topSessionRows.map((r) => r.session_id));
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
    },
  };
}
