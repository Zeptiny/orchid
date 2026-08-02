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
  ToolsResult,
  SubagentsResult,
  ContextResult,
  CurrencyTotal,
  TimeSeriesPoint,
} from '../../../shared/types/analytics';

const DEFAULT_LIMIT = 1000;

function getDb(): SqliteDatabase {
  return (getProviderAccountingStore() as unknown as { connection(): SqliteDatabase }).connection();
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

function costFromRow(currency: string | null, costAmount: string | null, costState: string): CurrencyTotal | null {
  if (!currency || !costAmount) return null;
  if (costState !== 'reported' && costState !== 'calculated') return null;
  return { currency, amount: costAmount, recordCount: 1 };
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
  const allRows = db.prepare('SELECT session_id, model_id, provider_id, outcome, cost_state, cost_amount, currency, usage_json, started_at, agent_tier FROM provider_attempts').all() as Array<{
    session_id: string; model_id: string; provider_id: string;
    outcome: string; cost_state: string; cost_amount: string | null; currency: string | null;
    usage_json: string | null; started_at: string; agent_tier: string | null;
  }>;

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalReasoning = 0;
  let succeeded = 0, failed = 0, interrupted = 0;
  const sessionIds = new Set<string>();
  const tierCounts = new Map<string, number>();
  const tsMap = new Map<string, { cost: Decimal; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }>();
  const modelCostMap = new Map<string, { cost: Decimal; currency: string }>();
  const providerCostMap = new Map<string, { cost: Decimal; currency: string }>();
  const costSourceCounts = new Map<string, number>();

  for (const row of allRows) {
    sessionIds.add(row.session_id);
    const usage = parseUsage(row.usage_json);
    totalInput += usage.inputTokens;
    totalOutput += usage.outputTokens;
    totalCacheRead += usage.cacheReadTokens;
    totalCacheWrite += usage.cacheWriteTokens;
    totalReasoning += usage.reasoningTokens;

    if (row.outcome === 'succeeded') succeeded++;
    else if (row.outcome === 'failed') failed++;
    else if (row.outcome === 'interrupted') interrupted++;

    if (row.agent_tier) tierCounts.set(row.agent_tier, (tierCounts.get(row.agent_tier) ?? 0) + 1);

    const bucket = timeBucket(row.started_at);
    const ts = tsMap.get(bucket) ?? { cost: new Decimal(0), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    ts.input += usage.inputTokens; ts.output += usage.outputTokens;
    ts.cacheRead += usage.cacheReadTokens; ts.cacheWrite += usage.cacheWriteTokens;
    ts.reasoning += usage.reasoningTokens;
    if (row.cost_state === 'reported' || row.cost_state === 'calculated') {
      if (row.currency && row.cost_amount) {
        try { ts.cost = ts.cost.add(new Decimal(row.cost_amount)); } catch { /* skip */ }
      }
    }
    tsMap.set(bucket, ts);

    costSourceCounts.set(row.cost_state, (costSourceCounts.get(row.cost_state) ?? 0) + 1);

    const modelKey = row.model_id;
    if ((row.cost_state === 'reported' || row.cost_state === 'calculated') && row.currency && row.cost_amount) {
      try {
        const mc = modelCostMap.get(modelKey) ?? { cost: new Decimal(0), currency: row.currency };
        mc.cost = mc.cost.add(new Decimal(row.cost_amount));
        modelCostMap.set(modelKey, mc);
      } catch { /* skip */ }
      const providerKey = row.provider_id;
      try {
        const pc = providerCostMap.get(providerKey) ?? { cost: new Decimal(0), currency: row.currency };
        pc.cost = pc.cost.add(new Decimal(row.cost_amount));
        providerCostMap.set(providerKey, pc);
      } catch { /* skip */ }
    }
  }

  const costSummary = sumCosts(allRows);

  const timeSeries: TimeSeriesPoint[] = [...tsMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, ts]) => ({
      date,
      cost: ts.cost.toFixed(),
      inputTokens: ts.input,
      outputTokens: ts.output,
      cacheReadTokens: ts.cacheRead,
      cacheWriteTokens: ts.cacheWrite,
      reasoningTokens: ts.reasoning,
    }));

  const total = allRows.length;

  return {
    stats: {
      totalCost: costSummary.currencies,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheWriteTokens: totalCacheWrite,
      totalReasoningTokens: totalReasoning,
      totalAttempts: total,
      succeededAttempts: succeeded,
      failedAttempts: failed,
      interruptedAttempts: interrupted,
      unknownCostCount: costSummary.unknownCount,
      totalSessions: sessionIds.size,
    },
    spendOverTime: timeSeries,
    tokenUsageOverTime: timeSeries,
    spendByModel: [...modelCostMap.entries()].map(([modelId, mc]) => ({ modelId, cost: mc.cost.toFixed(), currency: mc.currency })),
    spendByProvider: [...providerCostMap.entries()].map(([providerId, pc]) => ({ providerId, cost: pc.cost.toFixed(), currency: pc.currency })),
    outcomeDistribution: [
      { outcome: 'succeeded', count: succeeded },
      { outcome: 'failed', count: failed },
      { outcome: 'interrupted', count: interrupted },
    ],
    costSourceDistribution: [...costSourceCounts.entries()].map(([source, count]) => ({ source, count })),
    agentTierDistribution: [...tierCounts.entries()].map(([tier, count]) => ({ tier, count })),
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
      MAX(completed_at) as last_attempt
    FROM provider_attempts GROUP BY session_id ORDER BY first_attempt DESC LIMIT ?
  `).all(limit) as Array<{
    session_id: string; attempts: number; succeeded: number; failed: number; interrupted: number;
    first_attempt: string; last_attempt: string | null;
  }>;

  const subagentStore = getSubagentAttributionStore();

  return sessions.map((s) => {
    const rows = db.prepare(`
      SELECT usage_json, cost_state, cost_amount, currency, model_id FROM provider_attempts WHERE session_id = ?
    `).all(s.session_id) as Array<{
      usage_json: string | null; cost_state: string; cost_amount: string | null; currency: string | null; model_id: string;
    }>;

    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
    const models = new Set<string>();
    for (const r of rows) {
      const u = parseUsage(r.usage_json);
      inputTokens += u.inputTokens; outputTokens += u.outputTokens; cacheReadTokens += u.cacheReadTokens;
      models.add(r.model_id);
    }
    const costs = sumCosts(rows.map((r) => ({ currency: r.currency, cost_amount: r.cost_amount, cost_state: r.cost_state })));
    const subagents = subagentStore.listBySession(s.session_id);

    return {
      sessionId: s.session_id,
      totalCost: costs.currencies,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens,
      attempts: s.attempts,
      succeeded: s.succeeded,
      failed: s.failed,
      interrupted: s.interrupted,
      firstAttempt: s.first_attempt,
      lastAttempt: s.last_attempt,
      modelsUsed: [...models],
      subagentCount: subagents.length,
    };
  });
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

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  const models = new Set<string>();
  const providers = new Set<string>();
  let succeeded = 0, failed = 0, interrupted = 0;
  const costs = sumCosts(rows.map((r) => ({ currency: r.currency, cost_amount: r.cost_amount, cost_state: r.cost_state })));

  const attempts = rows.map((r) => {
    const u = parseUsage(r.usage_json);
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
      inputTokens: u.inputTokens || null,
      outputTokens: u.outputTokens || null,
      cacheReadTokens: u.cacheReadTokens || null,
      cacheWriteTokens: u.cacheWriteTokens || null,
      reasoningTokens: u.reasoningTokens || null,
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
  for (const r of rows) {
    const key = r.chain_id ?? '__main__';
    const chain = chainMap.get(key) ?? { agentName: r.agent_name, agentTier: r.agent_tier, cost: new Decimal(0), input: 0, output: 0, attempts: 0, succeeded: 0, failed: 0, interrupted: 0 };
    const u = parseUsage(r.usage_json);
    chain.input += u.inputTokens; chain.output += u.outputTokens; chain.attempts++;
    if (r.outcome === 'succeeded') chain.succeeded++;
    else if (r.outcome === 'failed') chain.failed++;
    else if (r.outcome === 'interrupted') chain.interrupted++;
    if ((r.cost_amount) && r.currency) { try { chain.cost = chain.cost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
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

  const toolStore = getToolAttemptStore();
  const toolRows = toolStore.listBySession(sessionId);
  const toolCalls = toolRows.map((t) => ({
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

  const subagentStore = getSubagentAttributionStore();
  const subagentRows = subagentStore.listBySession(sessionId);
  const subagents = subagentRows.map((sa) => {
    const saAttempts = rows.filter((r) => r.chain_id === sa.chainId);
    let saCost = new Decimal(0);
    let saInput = 0, saOutput = 0;
    for (const r of saAttempts) {
      const u = parseUsage(r.usage_json);
      saInput += u.inputTokens; saOutput += u.outputTokens;
      if (r.cost_amount && r.currency) { try { saCost = saCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
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

  return {
    sessionId,
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
    FROM provider_attempts GROUP BY model_id ORDER BY first_used DESC
  `).all() as Array<{
    model_id: string; provider_id: string; snapshot_json: string;
    attempts: number; succeeded: number; failed: number; interrupted: number;
    first_used: string; last_used: string | null;
  }>;

  const models = modelRows.map((m) => {
    const tokenRows = db.prepare('SELECT usage_json, cost_state, cost_amount, currency FROM provider_attempts WHERE model_id = ?').all(m.model_id) as Array<{
      usage_json: string | null; cost_state: string; cost_amount: string | null; currency: string | null;
    }>;
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0;
    let totalCost = new Decimal(0);
    for (const r of tokenRows) {
      const u = parseUsage(r.usage_json);
      inputTokens += u.inputTokens; outputTokens += u.outputTokens;
      cacheReadTokens += u.cacheReadTokens; cacheWriteTokens += u.cacheWriteTokens;
      reasoningTokens += u.reasoningTokens;
      if (r.cost_amount && r.currency) { try { totalCost = totalCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
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
    SELECT provider_id,
      COUNT(*) as attempts,
      SUM(CASE WHEN outcome='succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN outcome='interrupted' THEN 1 ELSE 0 END) as interrupted,
      COUNT(DISTINCT model_id) as model_count,
      COUNT(DISTINCT connection_id) as connection_count
    FROM provider_attempts GROUP BY provider_id
  `).all() as Array<{
    provider_id: string; attempts: number; succeeded: number; failed: number;
    interrupted: number; model_count: number; connection_count: number;
  }>;

  const providers = providerRows.map((p) => {
    const costRows = db.prepare('SELECT cost_amount, currency, cost_state, snapshot_json FROM provider_attempts WHERE provider_id = ?').all(p.provider_id) as Array<{
      cost_amount: string | null; currency: string | null; cost_state: string; snapshot_json: string;
    }>;
    let totalCost = new Decimal(0);
    let totalInput = 0, totalOutput = 0;
    let displayName: string | null = null;
    for (const r of costRows) {
      if (!displayName) displayName = parseSnapshotProviderName(r.snapshot_json);
      if (r.cost_amount && r.currency) { try { totalCost = totalCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
      const u = parseUsage(null);
      totalInput += u.inputTokens; totalOutput += u.outputTokens;
    }
    const tokenRows = db.prepare('SELECT usage_json FROM provider_attempts WHERE provider_id = ?').all(p.provider_id) as Array<{ usage_json: string | null }>;
    for (const r of tokenRows) {
      const u = parseUsage(r.usage_json);
      totalInput += u.inputTokens; totalOutput += u.outputTokens;
    }
    return {
      providerId: p.provider_id,
      providerDisplayName: displayName,
      totalCost: totalCost.toFixed(),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      attempts: p.attempts,
      modelCount: p.model_count,
      connectionCount: p.connection_count,
      failed: p.failed,
      interrupted: p.interrupted,
    };
  });

  const tsRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', started_at) as date, model_id, cost_amount, currency, cost_state
    FROM provider_attempts WHERE cost_state IN ('reported','calculated') ORDER BY date
  `).all() as Array<{ date: string; model_id: string; cost_amount: string; currency: string; cost_state: string }>;

  const modelTsMap = new Map<string, Map<string, Decimal>>();
  for (const r of tsRows) {
    if (!r.currency || !r.cost_amount) continue;
    const modelMap = modelTsMap.get(r.model_id) ?? new Map();
    try {
      const val = modelMap.get(r.date) ?? new Decimal(0);
      modelMap.set(r.date, val.add(new Decimal(r.cost_amount)));
      modelTsMap.set(r.model_id, modelMap);
    } catch { /* skip */ }
  }

  const costPerModelOverTime: TimeSeriesPoint[] = [];
  for (const [modelId, dateMap] of modelTsMap) {
    for (const [date, cost] of dateMap) {
      costPerModelOverTime.push({ date, cost: cost.toFixed(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
    }
  }
  costPerModelOverTime.sort((a, b) => a.date.localeCompare(b.date));

  return { models, providers, costPerModelOverTime, costPerProviderOverTime: [] };
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
    if (t.outcome === 'complete') entry.complete++;
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

  const summaryMap = new Map<string, {
    agentName: string; agentType: string; agentTier: string;
    models: Set<string>; invocations: number;
    totalCost: Decimal; inputTokens: number; outputTokens: number; attempts: number;
    completed: number; failed: number; interrupted: number;
    totalDurationMs: number; durationCount: number;
  }>();

  for (const sa of allSubagents) {
    const key = sa.agentName;
    const entry = summaryMap.get(key) ?? {
      agentName: sa.agentName, agentType: sa.agentType, agentTier: sa.agentTier,
      models: new Set<string>(), invocations: 0,
      totalCost: new Decimal(0), inputTokens: 0, outputTokens: 0, attempts: 0,
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

    const saAttempts = db.prepare('SELECT usage_json, cost_amount, currency FROM provider_attempts WHERE chain_id = ?').all(sa.chainId) as Array<{
      usage_json: string | null; cost_amount: string | null; currency: string | null;
    }>;
    for (const r of saAttempts) {
      const u = parseUsage(r.usage_json);
      entry.inputTokens += u.inputTokens; entry.outputTokens += u.outputTokens;
      if (r.cost_amount && r.currency) { try { entry.totalCost = entry.totalCost.add(new Decimal(r.cost_amount)); } catch { /* skip */ } }
    }
    entry.attempts += saAttempts.length;
    summaryMap.set(key, entry);
  }

  const summaries = [...summaryMap.values()].map((s) => ({
    agentName: s.agentName,
    agentType: s.agentType,
    agentTier: s.agentTier,
    modelsUsed: [...s.models],
    invocations: s.invocations,
    totalCost: s.totalCost.toFixed(),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    attempts: s.attempts,
    completed: s.completed,
    failed: s.failed,
    interrupted: s.interrupted,
    avgDurationMs: s.durationCount > 0 ? Math.round(s.totalDurationMs / s.durationCount) : null,
  }));

  const costByAgentName: { agentName: string; cost: string; currency: string }[] = [];
  const costByAgentTier: { tier: string; cost: string; currency: string }[] = [];
  const tierCostMap = new Map<string, Decimal>();
  for (const s of summaryMap.values()) {
    if (s.totalCost.greaterThan(0)) {
      costByAgentName.push({ agentName: s.agentName, cost: s.totalCost.toFixed(), currency: 'USD' });
    }
    const tc = tierCostMap.get(s.agentTier) ?? new Decimal(0);
    tierCostMap.set(s.agentTier, tc.add(s.totalCost));
  }
  for (const [tier, cost] of tierCostMap) {
    if (cost.greaterThan(0)) costByAgentTier.push({ tier, cost: cost.toFixed(), currency: 'USD' });
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
