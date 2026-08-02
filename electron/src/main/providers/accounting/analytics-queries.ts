import Decimal from 'decimal.js';
import type { SqliteDatabase } from '../../utils/sqlite';
import {
  getProviderAccountingStore,
} from './store';
import {
  getToolAttemptStore,
} from './tool-attempt-store';
import {
  getContextSnapshotStore,
} from './context-snapshot-store';
import {
  getSubagentAttributionStore,
} from './subagent-attribution-store';
import type {
  OverviewResult,
  SessionSummary,
  SessionDetailResult,
  ModelsResult,
  ConnectionBreakdown,
  ToolsResult,
  SubagentsResult,
  ContextResult,
  CurrencyTotal,
  TimeSeriesPoint,
  ToolCallDetail,
} from '../../../shared/types/analytics';
import type { SubagentAttributionRecord } from '../../../shared/types/accounting';
import { getSessionNames } from '../../session/storage';

const DEFAULT_LIMIT = 1000;

function getDb(): SqliteDatabase {
  return getProviderAccountingStore().getDatabase();
}

function parseUsage(usageJson: string | null): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
} {
  if (!usageJson) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  try {
    const u = JSON.parse(usageJson) as Record<string, unknown>;
    return {
      inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
      outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
      cacheReadTokens: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
      cacheWriteTokens: typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0,
      reasoningTokens: typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
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

function sumCosts(rows: Array<{ currency: string | null; cost_amount: string | null; cost_state: string }>): {
  currencies: CurrencyTotal[];
  unknownCount: number;
} {
  const sums = new Map<string, { amount: Decimal; count: number }>();
  let unknownCount = 0;
  for (const row of rows) {
    if (row.cost_state !== 'reported' && row.cost_state !== 'calculated') { unknownCount++; continue; }
    if (!row.currency || !row.cost_amount) { unknownCount++; continue; }
    try {
      const entry = sums.get(row.currency) ?? { amount: new Decimal(0), count: 0 };
      entry.amount = entry.amount.add(new Decimal(row.cost_amount));
      entry.count++;
      sums.set(row.currency, entry);
    } catch { unknownCount++; }
  }
  return {
    currencies: [...sums.entries()].map(([currency, e]) => ({ currency, amount: e.amount.toFixed(), recordCount: e.count })),
    unknownCount,
  };
}

function timeBucket(startedAt: string): string {
  return startedAt.slice(0, 10);
}

export function getOverview(): OverviewResult {
  const db = getDb();

  const stats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      COUNT(DISTINCT session_id) as sessions
    FROM provider_attempts
  `).get() as { total: number; succeeded: number; failed: number; interrupted: number; sessions: number };

  const tokens = db.prepare(`
    SELECT
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) as cache_write_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens
    FROM provider_attempts WHERE usage_json IS NOT NULL
  `).get() as {
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_write_tokens: number; reasoning_tokens: number;
  };

  const costRows = db.prepare(`
    SELECT currency, SUM(cost_amount) as amount, COUNT(*) as record_count
    FROM provider_attempts
    WHERE cost_state IN ('reported','calculated') AND currency IS NOT NULL AND cost_amount IS NOT NULL
    GROUP BY currency
  `).all() as Array<{ currency: string; amount: number; record_count: number }>;

  const totalCost: CurrencyTotal[] = costRows.map((r) => ({
    currency: r.currency,
    amount: String(r.amount),
    recordCount: r.record_count,
  }));

  const unknownRow = db.prepare(`
    SELECT COUNT(*) as count FROM provider_attempts
    WHERE cost_state = 'unknown' OR currency IS NULL OR cost_amount IS NULL
  `).get() as { count: number };

  const tsRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date,
      COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheReadTokens')), 0) as cache_read_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.cacheWriteTokens')), 0) as cache_write_tokens,
      COALESCE(SUM(json_extract(usage_json, '$.reasoningTokens')), 0) as reasoning_tokens,
      SUM(CASE WHEN cost_state IN ('reported','calculated') AND currency IS NOT NULL AND cost_amount IS NOT NULL THEN CAST(cost_amount AS REAL) ELSE 0 END) as cost
    FROM provider_attempts GROUP BY date ORDER BY date
  `).all() as Array<{
    date: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
    cost: number;
  }>;

  const timeSeries: TimeSeriesPoint[] = tsRows.map((r) => ({
    date: r.date,
    cost: String(r.cost),
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
  }));

  const spendByModelRows = db.prepare(`
    SELECT model_id, currency, SUM(cost_amount) as cost
    FROM provider_attempts
    WHERE cost_state IN ('reported','calculated') AND currency IS NOT NULL AND cost_amount IS NOT NULL
    GROUP BY model_id, currency
  `).all() as Array<{ model_id: string; currency: string; cost: number }>;

  const spendByModel = spendByModelRows.map((r) => ({
    modelId: r.model_id,
    cost: String(r.cost),
    currency: r.currency,
  }));

  const spendByProviderRows = db.prepare(`
    SELECT provider_id, currency, SUM(cost_amount) as cost
    FROM provider_attempts
    WHERE cost_state IN ('reported','calculated') AND currency IS NOT NULL AND cost_amount IS NOT NULL
    GROUP BY provider_id, currency
  `).all() as Array<{ provider_id: string; currency: string; cost: number }>;

  const spendByProvider = spendByProviderRows.map((r) => ({
    providerId: r.provider_id,
    cost: String(r.cost),
    currency: r.currency,
  }));

  const outcomeRows = db.prepare(`
    SELECT outcome, COUNT(*) as count FROM provider_attempts GROUP BY outcome
  `).all() as Array<{ outcome: string; count: number }>;
  const outcomeDistribution = outcomeRows.map((r) => ({ outcome: r.outcome, count: r.count }));

  const costSourceRows = db.prepare(`
    SELECT cost_state, COUNT(*) as count FROM provider_attempts GROUP BY cost_state
  `).all() as Array<{ cost_state: string; count: number }>;
  const costSourceDistribution = costSourceRows.map((r) => ({ source: r.cost_state, count: r.count }));

  const tierRows = db.prepare(`
    SELECT agent_tier, COUNT(*) as count FROM provider_attempts WHERE agent_tier IS NOT NULL GROUP BY agent_tier
  `).all() as Array<{ agent_tier: string; count: number }>;
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
      unknownCostCount: unknownRow.count,
      totalSessions: stats.sessions,
    },
    spendOverTime: timeSeries,
    tokenUsageOverTime: timeSeries,
    spendByModel,
    spendByProvider,
    outcomeDistribution,
    costSourceDistribution,
    agentTierDistribution,
  };
}

export function getSessions(limit = DEFAULT_LIMIT): readonly SessionSummary[] {
  const db = getDb();

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
    FROM provider_attempts GROUP BY session_id ORDER BY first_attempt DESC LIMIT ?
  `).all(limit) as Array<{
    session_id: string; attempts: number; succeeded: number; failed: number; interrupted: number;
    first_attempt: string; last_attempt: string | null;
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    models: string | null;
  }>;

  const subagentRows = db.prepare(`
    SELECT session_id, COUNT(*) as count FROM subagent_attribution GROUP BY session_id
  `).all() as Array<{ session_id: string; count: number }>;
  const subagentMap = new Map<string, number>();
  for (const r of subagentRows) {
    subagentMap.set(r.session_id, r.count);
  }

  const costRows = db.prepare(`
    SELECT session_id, currency, SUM(cost_amount) as amount, COUNT(*) as record_count
    FROM provider_attempts
    WHERE cost_state IN ('reported','calculated') AND currency IS NOT NULL AND cost_amount IS NOT NULL
    GROUP BY session_id, currency
  `).all() as Array<{ session_id: string; currency: string; amount: number; record_count: number }>;
  const costMap = new Map<string, CurrencyTotal[]>();
  for (const r of costRows) {
    const arr = costMap.get(r.session_id) ?? [];
    arr.push({ currency: r.currency, amount: String(r.amount), recordCount: r.record_count });
    costMap.set(r.session_id, arr);
  }

  const sessionIds = sessions.map((s) => s.session_id);
  let nameMap = new Map<string, string>();
  try {
    nameMap = getSessionNames(sessionIds);
  } catch { /* session DB unavailable */ }

  return sessions.map((s) => ({
    sessionId: s.session_id,
    sessionName: nameMap.get(s.session_id) ?? null,
    totalCost: costMap.get(s.session_id) ?? [],
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
}

export function getSessionDetail(sessionId: string): SessionDetailResult {
  const db = getDb();
  const rows = db.prepare(`
    SELECT attempt_id, chain_id, turn_id, provider_id, model_id, outcome,
      cost_state, cost_amount, currency, usage_json, started_at, completed_at,
      agent_scope, agent_name, agent_tier, error, snapshot_json
    FROM provider_attempts WHERE session_id = ? ORDER BY started_at ASC
  `).all(sessionId) as Array<{
    attempt_id: string; chain_id: string | null; turn_id: string | null;
    provider_id: string; model_id: string; outcome: string;
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
      outcome: r.outcome,
      costAmount: r.cost_amount,
      currency: r.currency,
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      cacheReadTokens: u.cacheReadTokens ?? null,
      cacheWriteTokens: u.cacheWriteTokens ?? null,
      reasoningTokens: u.reasoningTokens ?? null,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      latencyMs: r.completed_at ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime() : null,
      agentScope: r.agent_scope,
      agentName: r.agent_name,
      agentTier: r.agent_tier,
      error: r.error,
    };
  });

  const chainMap = new Map<string, { agentName: string | null; agentTier: string | null; cost: Decimal; input: number; output: number; attempts: number; succeeded: number; failed: number; interrupted: number }>();
  for (const { row: r, usage: u } of parsedRows) {
    const key = r.chain_id ?? '__main__';
    const chain = chainMap.get(key) ?? { agentName: r.agent_name, agentTier: r.agent_tier, cost: new Decimal(0), input: 0, output: 0, attempts: 0, succeeded: 0, failed: 0, interrupted: 0 };
    chain.input += u.inputTokens; chain.output += u.outputTokens; chain.attempts++;
    if (r.outcome === 'succeeded') chain.succeeded++;
    else if (r.outcome === 'failed') chain.failed++;
    else if (r.outcome === 'interrupted') chain.interrupted++;
    if (r.cost_amount && r.currency && (r.cost_state === 'reported' || r.cost_state === 'calculated')) { try { chain.cost = chain.cost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
    chainMap.set(key, chain);
  }
  const chains = [...chainMap.entries()].map(([chainId, c]) => ({
    chainId: chainId === '__main__' ? null : chainId,
    agentName: c.agentName,
    agentTier: c.agentTier,
    totalCost: c.cost.toFixed(),
    inputTokens: c.input,
    outputTokens: c.output,
    attempts: c.attempts,
    succeeded: c.succeeded,
    failed: c.failed,
    interrupted: c.interrupted,
  }));

  let toolCalls: ToolCallDetail[] = [];
  try {
    const toolStore = getToolAttemptStore();
    const toolRows = toolStore.listBySession(sessionId);
    toolCalls = toolRows.map((t) => ({
      toolAttemptId: t.toolAttemptId,
      toolName: t.toolName,
      toolSource: t.toolSource,
      mcpServerName: t.mcpServerName,
      toolFamily: t.toolFamily,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      durationMs: t.completedAt ? new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime() : null,
      outcome: t.outcome,
      resultSizeBytes: t.resultSizeBytes,
      offloaded: t.offloaded,
      timedOut: t.timedOut,
      agentScope: t.agentScope,
    }));
  } catch { /* store unavailable */ }

  let subagentRows: readonly SubagentAttributionRecord[] = [];
  try {
    const subagentStore = getSubagentAttributionStore();
    subagentRows = subagentStore.listBySession(sessionId);
  } catch { /* store unavailable */ }

  const subagents = subagentRows.map((sa) => {
    const saAttempts = parsedRows.filter(({ row: r }) => r.chain_id === sa.chainId);
    let saCost = new Decimal(0);
    let saInput = 0, saOutput = 0;
    for (const { usage: u, row: r } of saAttempts) {
      saInput += u.inputTokens; saOutput += u.outputTokens;
      if (r.cost_amount && r.currency && (r.cost_state === 'reported' || r.cost_state === 'calculated')) { try { saCost = saCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
    }
    return {
      subagentId: sa.subagentId,
      agentName: sa.agentName,
      agentType: sa.agentType,
      agentTier: sa.agentTier,
      modelId: sa.modelId,
      status: sa.status,
      totalCost: saCost.toFixed(),
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
      lastAttempt: rows.length > 0 ? rows[rows.length - 1].completed_at : null,
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

export function getModels(): ModelsResult {
  const db = getDb();
  const modelRows = db.prepare(`
    SELECT model_id, provider_id, snapshot_json,
      COUNT(*) as attempts,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      MIN(started_at) as first_used,
      MAX(completed_at) as last_used
    FROM provider_attempts GROUP BY model_id, provider_id ORDER BY first_used DESC
  `).all() as Array<{
    model_id: string; provider_id: string; snapshot_json: string;
    attempts: number; succeeded: number; failed: number; interrupted: number;
    first_used: string; last_used: string | null;
  }>;

  const models = modelRows.map((m) => {
    const tokenRows = db.prepare('SELECT usage_json, cost_state, cost_amount, currency FROM provider_attempts WHERE model_id = ? AND provider_id = ?').all(m.model_id, m.provider_id) as Array<{
      usage_json: string | null; cost_state: string; cost_amount: string | null; currency: string | null;
    }>;
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0;
    let totalCost = new Decimal(0);
    for (const r of tokenRows) {
      const u = parseUsage(r.usage_json);
      inputTokens += u.inputTokens; outputTokens += u.outputTokens;
      cacheReadTokens += u.cacheReadTokens; cacheWriteTokens += u.cacheWriteTokens;
      reasoningTokens += u.reasoningTokens;
      if (r.cost_amount && r.currency && (r.cost_state === 'reported' || r.cost_state === 'calculated')) { try { totalCost = totalCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
    }
    return {
      modelId: m.model_id,
      providerId: m.provider_id,
      connectionName: parseSnapshotConnectionName(m.snapshot_json),
      totalCost: totalCost.toFixed(),
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
      attempts: m.attempts,
      succeeded: m.succeeded,
      failed: m.failed,
      interrupted: m.interrupted,
      firstUsed: m.first_used,
      lastUsed: m.last_used,
    };
  });

  const providerRows = db.prepare(`
    SELECT connection_id, provider_id,
      COUNT(*) as attempts,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      COUNT(DISTINCT model_id) as model_count,
      MIN(started_at) as first_used,
      MAX(completed_at) as last_used
    FROM provider_attempts GROUP BY connection_id ORDER BY first_used DESC
  `).all() as Array<{
    connection_id: string; provider_id: string; attempts: number; succeeded: number; failed: number;
    interrupted: number; model_count: number; first_used: string; last_used: string | null;
  }>;

  const connections: ConnectionBreakdown[] = providerRows.map((c) => {
    const detailRows = db.prepare('SELECT usage_json, cost_amount, currency, cost_state, snapshot_json, started_at FROM provider_attempts WHERE connection_id = ? ORDER BY started_at DESC').all(c.connection_id) as Array<{
      usage_json: string | null; cost_amount: string | null; currency: string | null; cost_state: string; snapshot_json: string; started_at: string;
    }>;
    let totalCost = new Decimal(0);
    let totalInput = 0, totalOutput = 0;
    let connectionName: string | null = null;
    let providerDisplayName: string | null = null;
    for (const r of detailRows) {
      if (!connectionName) connectionName = parseSnapshotConnectionName(r.snapshot_json);
      if (!providerDisplayName) providerDisplayName = parseSnapshotProviderName(r.snapshot_json);
      const u = parseUsage(r.usage_json);
      totalInput += u.inputTokens; totalOutput += u.outputTokens;
      if (r.cost_amount && r.currency && (r.cost_state === 'reported' || r.cost_state === 'calculated')) { try { totalCost = totalCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
    }
    return {
      connectionId: c.connection_id,
      connectionName,
      providerId: c.provider_id,
      providerDisplayName,
      totalCost: totalCost.toFixed(),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      attempts: c.attempts,
      succeeded: c.succeeded,
      failed: c.failed,
      interrupted: c.interrupted,
      modelCount: c.model_count,
      firstUsed: c.first_used,
      lastUsed: c.last_used,
    };
  });

  const tsRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date, model_id, connection_id, cost_amount, currency, cost_state
    FROM provider_attempts WHERE cost_state IN ('reported','calculated') ORDER BY date
  `).all() as Array<{ date: string; model_id: string; connection_id: string; cost_amount: string; currency: string; cost_state: string }>;

  const modelTsMap = new Map<string, Map<string, Decimal>>();
  const connectionTsMap = new Map<string, Map<string, Decimal>>();
  for (const r of tsRows) {
    if (!r.currency || !r.cost_amount) continue;
    try {
      const modelMap = modelTsMap.get(r.model_id) ?? new Map<string, Decimal>();
      const modelVal = modelMap.get(r.date) ?? new Decimal(0);
      modelMap.set(r.date, modelVal.add(new Decimal(r.cost_amount)));
      modelTsMap.set(r.model_id, modelMap);

      const connMap = connectionTsMap.get(r.connection_id) ?? new Map<string, Decimal>();
      const connVal = connMap.get(r.date) ?? new Decimal(0);
      connMap.set(r.date, connVal.add(new Decimal(r.cost_amount)));
      connectionTsMap.set(r.connection_id, connMap);
    } catch { /* skip */ }
  }

  const costPerModelOverTime: TimeSeriesPoint[] = [];
  for (const [, dateMap] of modelTsMap) {
    for (const [date, cost] of dateMap) {
      costPerModelOverTime.push({ date, cost: cost.toFixed(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    }
  }
  costPerModelOverTime.sort((a, b) => a.date.localeCompare(b.date));

  const costPerConnectionOverTime: TimeSeriesPoint[] = [];
  for (const [, dateMap] of connectionTsMap) {
    for (const [date, cost] of dateMap) {
      costPerConnectionOverTime.push({ date, cost: cost.toFixed(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    }
  }
  costPerConnectionOverTime.sort((a, b) => a.date.localeCompare(b.date));

  return { models, connections, costPerModelOverTime, costPerConnectionOverTime };
}

export function getTools(): ToolsResult {
  const toolStore = getToolAttemptStore();
  const allTools = toolStore.listAll(DEFAULT_LIMIT);

  const toolMap = new Map<string, {
    toolName: string; toolSource: string; mcpServerName: string | null; toolFamily: string;
    invocations: number; complete: number; error: number; cancelled: number; timedOut: number;
    totalDurationMs: number; durationCount: number; totalResultSize: number; resultSizeCount: number; offloadedCount: number;
  }>();

  for (const t of allTools) {
    const key = t.toolName;
    const entry = toolMap.get(key) ?? {
      toolName: t.toolName, toolSource: t.toolSource, mcpServerName: t.mcpServerName, toolFamily: t.toolFamily,
      invocations: 0, complete: 0, error: 0, cancelled: 0, timedOut: 0,
      totalDurationMs: 0, durationCount: 0, totalResultSize: 0, resultSizeCount: 0, offloadedCount: 0,
    };
    entry.invocations++;
    if (t.outcome === 'complete' || t.outcome === 'partial' || t.outcome === 'empty') entry.complete++;
    else if (t.outcome === 'error') entry.error++;
    else if (t.outcome === 'cancelled') entry.cancelled++;
    if (t.timedOut) entry.timedOut++;
    if (t.completedAt) {
      entry.totalDurationMs += new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime();
      entry.durationCount++;
    }
    if (t.resultSizeBytes != null) { entry.totalResultSize += t.resultSizeBytes; entry.resultSizeCount++; }
    if (t.offloaded) entry.offloadedCount++;
    toolMap.set(key, entry);
  }

  const tools = [...toolMap.values()].map((t) => ({
    toolName: t.toolName,
    toolSource: t.toolSource,
    mcpServerName: t.mcpServerName,
    toolFamily: t.toolFamily,
    invocations: t.invocations,
    complete: t.complete,
    error: t.error,
    cancelled: t.cancelled,
    timedOut: t.timedOut,
    avgDurationMs: t.durationCount > 0 ? Math.round(t.totalDurationMs / t.durationCount) : null,
    avgResultSizeBytes: t.resultSizeCount > 0 ? Math.round(t.totalResultSize / t.resultSizeCount) : null,
    offloadRate: t.invocations > 0 ? t.offloadedCount / t.invocations : 0,
  }));

  const outcomeCounts = new Map<string, number>();
  for (const t of allTools) {
    outcomeCounts.set(t.outcome, (outcomeCounts.get(t.outcome) ?? 0) + 1);
  }
  const outcomeDistribution = [...outcomeCounts.entries()].map(([outcome, count]) => ({ outcome, count }));

  const invocationsOverTime: { date: string; toolName: string; count: number }[] = [];
  const dateToolMap = new Map<string, Map<string, number>>();
  for (const t of allTools) {
    const date = timeBucket(t.startedAt);
    const dayMap = dateToolMap.get(date) ?? new Map<string, number>();
    dayMap.set(t.toolName, (dayMap.get(t.toolName) ?? 0) + 1);
    dateToolMap.set(date, dayMap);
  }
  for (const [date, toolMap2] of dateToolMap) {
    for (const [toolName, count] of toolMap2) {
      invocationsOverTime.push({ date, toolName, count });
    }
  }
  invocationsOverTime.sort((a, b) => a.date.localeCompare(b.date));

  return { tools, invocationsOverTime, outcomeDistribution };
}

export function getSubagents(): SubagentsResult {
  const subagentStore = getSubagentAttributionStore();
  const allSubagents = subagentStore.listAll(DEFAULT_LIMIT);
  const db = getDb();

  const chainIds = [...new Set(allSubagents.map((sa) => sa.chainId))];

  const chainAggMap = new Map<string, { inputTokens: number; outputTokens: number; totalCost: number; attempts: number }>();
  const chainCurrencyMap = new Map<string, Map<string, number>>();

  if (chainIds.length > 0) {
    const placeholders = chainIds.map(() => '?').join(',');

    const chainRows = db.prepare(`
      SELECT chain_id,
        COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) as input_tokens,
        COALESCE(SUM(json_extract(usage_json, '$.outputTokens')), 0) as output_tokens,
        SUM(CASE WHEN cost_state IN ('reported','calculated') AND cost_amount IS NOT NULL THEN CAST(cost_amount AS REAL) ELSE 0 END) as total_cost,
        COUNT(*) as attempts
      FROM provider_attempts WHERE chain_id IN (${placeholders}) GROUP BY chain_id
    `).all(...chainIds) as Array<{
      chain_id: string; input_tokens: number; output_tokens: number; total_cost: number; attempts: number;
    }>;

    for (const r of chainRows) {
      chainAggMap.set(r.chain_id, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        totalCost: r.total_cost,
        attempts: r.attempts,
      });
    }

    const chainCurrencyRows = db.prepare(`
      SELECT chain_id, currency, SUM(cost_amount) as cost
      FROM provider_attempts
      WHERE cost_state IN ('reported','calculated') AND cost_amount IS NOT NULL AND currency IS NOT NULL AND chain_id IN (${placeholders})
      GROUP BY chain_id, currency
    `).all(...chainIds) as Array<{ chain_id: string; currency: string; cost: number }>;

    for (const r of chainCurrencyRows) {
      const currMap = chainCurrencyMap.get(r.chain_id) ?? new Map<string, number>();
      currMap.set(r.currency, (currMap.get(r.currency) ?? 0) + r.cost);
      chainCurrencyMap.set(r.chain_id, currMap);
    }
  }

  const summaryMap = new Map<string, {
    agentName: string; agentType: string; agentTier: string;
    models: Set<string>; invocations: number;
    totalCost: number; inputTokens: number; outputTokens: number; attempts: number;
    completed: number; failed: number; interrupted: number;
    totalDurationMs: number; durationCount: number;
  }>();

  for (const sa of allSubagents) {
    const key = `${sa.agentName}:${sa.agentTier}:${sa.agentType}`;
    const entry = summaryMap.get(key) ?? {
      agentName: sa.agentName, agentType: sa.agentType, agentTier: sa.agentTier,
      models: new Set<string>(), invocations: 0,
      totalCost: 0, inputTokens: 0, outputTokens: 0, attempts: 0,
      completed: 0, failed: 0, interrupted: 0,
      totalDurationMs: 0, durationCount: 0,
    };
    entry.invocations++;
    entry.models.add(sa.modelId);
    if (sa.status === 'completed') entry.completed++;
    else if (sa.status === 'failed') entry.failed++;
    else if (sa.status === 'interrupted') entry.interrupted++;
    if (sa.completedAt) {
      entry.totalDurationMs += new Date(sa.completedAt).getTime() - new Date(sa.startedAt).getTime();
      entry.durationCount++;
    }

    const agg = chainAggMap.get(sa.chainId);
    if (agg) {
      entry.inputTokens += agg.inputTokens;
      entry.outputTokens += agg.outputTokens;
      entry.totalCost += agg.totalCost;
      entry.attempts += agg.attempts;
    }
    summaryMap.set(key, entry);
  }

  const summaries = [...summaryMap.values()].map((s) => ({
    agentName: s.agentName,
    agentType: s.agentType,
    agentTier: s.agentTier,
    modelsUsed: [...s.models],
    invocations: s.invocations,
    totalCost: String(s.totalCost),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    attempts: s.attempts,
    completed: s.completed,
    failed: s.failed,
    interrupted: s.interrupted,
    avgDurationMs: s.durationCount > 0 ? Math.round(s.totalDurationMs / s.durationCount) : null,
  }));

  const agentNameCostMap = new Map<string, Map<string, number>>();
  const agentTierCostMap = new Map<string, Map<string, number>>();

  for (const sa of allSubagents) {
    const chainCurrencies = chainCurrencyMap.get(sa.chainId);
    if (!chainCurrencies) continue;
    for (const [currency, cost] of chainCurrencies) {
      const nameMap = agentNameCostMap.get(sa.agentName) ?? new Map<string, number>();
      nameMap.set(currency, (nameMap.get(currency) ?? 0) + cost);
      agentNameCostMap.set(sa.agentName, nameMap);

      const tierMap = agentTierCostMap.get(sa.agentTier) ?? new Map<string, number>();
      tierMap.set(currency, (tierMap.get(currency) ?? 0) + cost);
      agentTierCostMap.set(sa.agentTier, tierMap);
    }
  }

  const costByAgentName: { agentName: string; cost: string; currency: string }[] = [];
  for (const [agentName, currMap] of agentNameCostMap) {
    for (const [currency, cost] of currMap) {
      if (cost > 0) costByAgentName.push({ agentName, cost: String(cost), currency });
    }
  }

  const costByAgentTier: { tier: string; cost: string; currency: string }[] = [];
  for (const [tier, currMap] of agentTierCostMap) {
    for (const [currency, cost] of currMap) {
      if (cost > 0) costByAgentTier.push({ tier, cost: String(cost), currency });
    }
  }

  const outcomeCounts = new Map<string, number>();
  for (const sa of allSubagents) {
    outcomeCounts.set(sa.status, (outcomeCounts.get(sa.status) ?? 0) + 1);
  }
  const outcomeDistribution = [...outcomeCounts.entries()].map(([status, count]) => ({ status, count }));

  return { summaries, costByAgentName, costByAgentTier, outcomeDistribution };
}

export function getContext(sessionId?: string): ContextResult {
  const snapshotStore = getContextSnapshotStore();
  const snapshots = sessionId ? snapshotStore.listBySession(sessionId) : snapshotStore.listAll(DEFAULT_LIMIT);

  let systemTokens = 0, toolsTokens = 0, toolUseTokens = 0, userTokens = 0, assistantTokens = 0;
  const results = snapshots.map((s) => {
    systemTokens += s.systemTokens;
    toolsTokens += s.toolsTokens;
    toolUseTokens += s.toolUseTokens;
    userTokens += s.userTokens;
    assistantTokens += s.assistantTokens;
    return {
      snapshotId: s.snapshotId,
      sessionId: s.sessionId,
      chainId: s.chainId,
      turnId: s.turnId,
      capturedAt: s.capturedAt,
      usedTokens: s.usedTokens,
      systemTokens: s.systemTokens,
      toolsTokens: s.toolsTokens,
      toolUseTokens: s.toolUseTokens,
      userTokens: s.userTokens,
      assistantTokens: s.assistantTokens,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
    };
  });

  const count = snapshots.length || 1;
  return {
    snapshots: results,
    avgBreakdown: {
      systemTokens: Math.round(systemTokens / count),
      toolsTokens: Math.round(toolsTokens / count),
      toolUseTokens: Math.round(toolUseTokens / count),
      userTokens: Math.round(userTokens / count),
      assistantTokens: Math.round(assistantTokens / count),
    },
  };
}
