/**
 * Private plumbing shared by the analytics query modules — the aggregate
 * views in `analytics-queries.ts` and the drill-downs in
 * `analytics-detail-queries.ts`. Holds the dependency-injection seam, Decimal
 * cost streaming, date filters, row iteration, usage/snapshot parsers, the
 * TTFT/TPS latency reduction, session-name resolution, and the shared
 * per-attempt projection. Everything here is internal to the analytics
 * backend; the public query surface stays importable from
 * `analytics-queries.ts`, which re-exports the detail queries and name
 * resolvers.
 */
import Decimal from 'decimal.js';
import type { SqliteDatabase } from '../../utils/sqlite';
import { getProviderAccountingStore } from './store';
import { getSessionNames } from '../../session/storage';
import type {
  AnalyticsTimeRange,
  AttemptDetail,
  CurrencyTotal,
} from '../../../shared/types/analytics';

/** Default page size for list queries. */
export const DEFAULT_LIMIT = 1000;

export const COST_ROW_CONDITIONS = [
  "cost_state IN ('reported','calculated')",
  'currency IS NOT NULL',
  'cost_amount IS NOT NULL',
];

/** Chunk size for bulk session-name lookups — one IN(...) per batch stays well
 * below the SQLite bound-variable limit even for very long picker lists. */
const SESSION_NAME_BATCH = 500;

export type DecimalTotal = { amount: Decimal; count: number };

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

export function getDb(ctx?: AnalyticsQueryContext): SqliteDatabase {
  return ctx?.db ?? getProviderAccountingStore().getDatabase();
}

/**
 * Resolve session names from the accounting ledger's `session_names` tombstone
 * table only. Tombstones are readable from any accounting.db connection (the
 * analytics worker included), unlike live sessions.db names — the worker
 * resolves tombstones itself and the main process live-patches on top.
 * Fail-soft (table missing, db locked → empty map).
 */
export function resolveTombstoneNames(
  db: SqliteDatabase,
  sessionIds: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  if (sessionIds.length === 0) return names;
  try {
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT session_id, name FROM session_names WHERE session_id IN (${placeholders})`,
    ).all(...sessionIds) as Array<{ session_id: string; name: string }>;
    for (const row of rows) {
      names.set(row.session_id, row.name);
    }
  } catch { /* tombstone table missing or db locked — skip */ }
  return names;
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
): Map<string, string> {
  const names = new Map<string, string>();
  try {
    for (const [id, name] of getSessionNames(sessionIds)) {
      names.set(id, name);
    }
  } catch { /* session DB unavailable */ }
  const missing = sessionIds.filter((id) => !names.has(id));
  for (const [id, name] of resolveTombstoneNames(db, missing)) {
    names.set(id, name);
  }
  return names;
}

/**
 * Run a session-name resolver over arbitrarily long id lists in batches.
 * Drill-down pickers may list every session in range, and a single IN(...)
 * with thousands of placeholders would risk the SQLite variable cap; per-batch
 * failures degrade to unresolved names instead of failing the whole query.
 */
export function resolveManySessionNames(
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
 * The session-name resolver for a query context: the injected resolver when
 * the query runs in the worker (tombstone-only; the runner live-patches on
 * top), otherwise live sessions.db names with a tombstone fallback against
 * the given accounting db.
 */
export function sessionNameResolver(
  ctx: AnalyticsQueryContext | undefined,
  db: SqliteDatabase,
): (sessionIds: readonly string[]) => Map<string, string> {
  return ctx?.resolveSessionNames
    ?? ((ids: readonly string[]) => resolveSessionNamesWithFallback(db, ids));
}

/**
 * Stream raw rows from a prepared statement. Cost aggregation must never use
 * GROUP_CONCAT: SQLite silently truncates the concatenated string for large
 * groups, corrupting totals. Rows are accumulated into Decimal sums in JS.
 */
export function iterateRows<T>(db: SqliteDatabase, sql: string, params: ReadonlyArray<string | number>): IterableIterator<T> {
  return db.prepare(sql).iterate(...params) as IterableIterator<T>;
}

export function parseCostAmount(costAmount: string): Decimal | null {
  try {
    return new Decimal(costAmount);
  } catch {
    return null;
  }
}

export function bumpCurrencyTotal(map: Map<string, DecimalTotal>, key: string, amount: Decimal | null): void {
  const entry = map.get(key) ?? { amount: new Decimal(0), count: 0 };
  entry.count++;
  if (amount) entry.amount = entry.amount.add(amount);
  map.set(key, entry);
}

export function nestedCurrencyMap(
  map: Map<string, Map<string, DecimalTotal>>,
  key: string,
): Map<string, DecimalTotal> {
  const inner = map.get(key) ?? new Map<string, DecimalTotal>();
  map.set(key, inner);
  return inner;
}

export function toCurrencyTotals(map: Map<string, DecimalTotal> | undefined): CurrencyTotal[] {
  if (!map) return [];
  return [...map.entries()]
    .map(([currency, entry]) => ({ currency, amount: entry.amount.toFixed(), recordCount: entry.count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export function parseUsage(usageJson: string | null): {
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
export type ParsedUsage = ReturnType<typeof parseUsage>;

export function parseSnapshotConnectionName(snapshotJson: string): string | null {
  try {
    const s = JSON.parse(snapshotJson) as Record<string, unknown>;
    return typeof s.connectionName === 'string' ? s.connectionName : null;
  } catch { return null; }
}

export function parseSnapshotProviderName(snapshotJson: string): string | null {
  try {
    const s = JSON.parse(snapshotJson) as Record<string, unknown>;
    return typeof s.providerDisplayName === 'string' ? s.providerDisplayName : null;
  } catch { return null; }
}

export function parseSnapshotModelDisplayName(snapshotJson: string): string | null {
  try {
    const s = JSON.parse(snapshotJson) as Record<string, unknown>;
    return typeof s.modelDisplayName === 'string' ? s.modelDisplayName : null;
  } catch { return null; }
}

export function sumCosts(rows: Array<{ currency: string | null; cost_amount: string | null; cost_state: string }>): {
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

export function buildDateFilter(timeRange: AnalyticsTimeRange | undefined, column = 'started_at'): {
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

export function whereClause(existingConditions: string[], dateClause: string): string {
  const all = [...existingConditions, dateClause].filter(Boolean);
  return all.length > 0 ? `WHERE ${all.join(' AND ')}` : '';
}

// ── First-token latency (TTFT) / token throughput (TPS) ──────────────────────

/** Raw latency sample per attempt: started → first token, and the generation window after it. */
export type LatencyRow = {
  model_id: string;
  provider_id: string;
  connection_id: string;
  started_at: string;
  first_token_at: string;
  completed_at: string;
  outcome: string;
  output_tokens: number | null;
};

/** Minimal columns {@link recordLatencySample} consumes. */
export type LatencySampleRow = Pick<LatencyRow, 'started_at' | 'first_token_at' | 'completed_at' | 'outcome' | 'output_tokens'>;

export type LatencySamples = {
  ttftMs: number[];
  outputTokens: number;
  generationSeconds: number;
};

export function emptyLatencySamples(): LatencySamples {
  return { ttftMs: [], outputTokens: 0, generationSeconds: 0 };
}

/** Nearest-rank percentile over an ascending-sorted array; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/**
 * Column list shared by every latency-row SELECT (started/first-token stamps,
 * outcome, and the output-token count). `alias` prefixes the
 * provider_attempts columns when the query joins them under a name (e.g.
 * `pa.`), so the first_token_at/completed_at gating below stays defined once.
 */
export function latencyRowColumns(alias = ''): string {
  return `${alias}started_at, ${alias}first_token_at, ${alias}completed_at, ${alias}outcome,
      json_extract(${alias}usage_json, '$.outputTokens') as output_tokens`;
}

/**
 * Gating shared by every latency-row SELECT: only attempts that streamed a
 * first token and were finalized carry a usable generation window.
 */
export function latencyRowGating(alias = ''): string[] {
  return [`${alias}first_token_at IS NOT NULL`, `${alias}completed_at IS NOT NULL`];
}

/**
 * Stream attempts that stamped a first token — per-attempt timestamps must be
 * reduced in JS, not GROUP_CONCAT (see {@link iterateRows}). Same date filter
 * as the caller's other queries.
 */
export function iterateLatencyRows(
  db: SqliteDatabase,
  dateFilter: { clause: string; params: string[] },
): IterableIterator<LatencyRow> {
  return iterateRows<LatencyRow>(db, `
    SELECT model_id, provider_id, connection_id, ${latencyRowColumns()}
    FROM provider_attempts
    ${whereClause(latencyRowGating(), dateFilter.clause)}
  `, dateFilter.params);
}

export function recordLatencySample(
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
    // Only succeeded attempts rate tokens: crash-recovered/disconnected rows
    // carry a sentinel completed_at (recovery time — possibly hours after the
    // last token; see store.recoverPending), which would massively dilute the
    // token-weighted ratio (#159). TTFT above still counts — a token WAS
    // delivered before the attempt ended.
    if (row.outcome === 'succeeded') {
      samples.outputTokens += row.output_tokens;
      samples.generationSeconds += generationMs / 1000;
    }
  }
  return ttftMs;
}

/** Get-or-create a per-key sample bucket (mirrors nestedCurrencyMap). */
export function latencySamplesFor(map: Map<string, LatencySamples>, key: string): LatencySamples {
  const samples = map.get(key) ?? emptyLatencySamples();
  map.set(key, samples);
  return samples;
}

/**
 * TTFT distribution plus token-weighted throughput. TPS is total output tokens
 * over total generation seconds (not an average of per-attempt rates).
 */
export function summarizeLatency(samples: LatencySamples | undefined): {
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

// ── Shared per-attempt projection ─────────────────────────────────────────────

/**
 * Row shape behind {@link AttemptDetail}. Shared by session detail and model
 * detail so both surfaces return identical attempt projections.
 */
export type AttemptDetailRow = {
  attempt_id: string; chain_id: string | null; turn_id: string | null;
  provider_id: string; model_id: string; connection_id: string; outcome: string;
  cost_state: string; cost_amount: string | null; currency: string | null; usage_json: string | null;
  started_at: string; completed_at: string | null; first_token_at: string | null;
  agent_scope: string | null; agent_name: string | null; agent_tier: string | null;
  error: string | null; snapshot_json: string;
};

/** Project one provider_attempts row into the shared AttemptDetail shape. */
export function toAttemptDetail(r: AttemptDetailRow, u: ParsedUsage): AttemptDetail {
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
    // Generation window must be positive to rate tokens, and only succeeded
    // attempts rate them at all — crash-recovered rows carry a sentinel
    // completed_at that would produce a bogus rate (see recordLatencySample).
    tokensPerSecond: generationMs > 0 && r.outcome === 'succeeded'
      ? Math.round((u.outputTokens / (generationMs / 1000)) * 10) / 10
      : null,
    agentScope: r.agent_scope,
    agentName: r.agent_name,
    agentTier: r.agent_tier,
    error: r.error,
  };
}
