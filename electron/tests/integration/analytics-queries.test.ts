import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenProviderRequestSnapshot, NormalizedProviderUsage } from '../../src/shared/types/accounting';
import type { AttemptCostResolution } from '../../src/main/providers/accounting/cost';
import {
  initializeProviderAccountingStore,
  resetProviderAccountingStore,
  type ProviderAccountingStore,
} from '../../src/main/providers/accounting/store';
import {
  initializeToolAttemptStore,
  resetToolAttemptStore,
  type ToolAttemptStore,
} from '../../src/main/providers/accounting/tool-attempt-store';
import {
  initializeContextSnapshotStore,
  resetContextSnapshotStore,
  type ContextSnapshotStore,
} from '../../src/main/providers/accounting/context-snapshot-store';
import {
  initializeSubagentAttributionStore,
  resetSubagentAttributionStore,
  type SubagentAttributionStore,
} from '../../src/main/providers/accounting/subagent-attribution-store';
import {
  getOverview,
  getSessions,
  getSessionDetail,
  getModels,
  getTools,
  getSubagents,
  getContext,
} from '../../src/main/providers/accounting/analytics-queries';
import { _clearDbCache } from '../../src/main/session/storage';
import type { ConnectionStore } from '../../src/main/providers/connection-store';
import type { ProviderStatusObservation } from '../../src/main/providers/status/cache';
import type { ProviderStatusService } from '../../src/main/providers/status/service';
import {
  resetProviderRuntimeContext,
  setProviderConnectionStore,
  setProviderStatusService,
} from '../../src/main/providers/runtime-context';

// ─── Shared state ─────────────────────────────────────────────────────────────

let tempDir: string;
let dbPath: string;
let providerStore: ProviderAccountingStore;
let toolStore: ToolAttemptStore;
let snapshotStore: ContextSnapshotStore;
let attributionStore: SubagentAttributionStore;
let clockMs: number;

/** Clock that advances 1 second on each call so started_at ≠ completed_at. */
function clock(): Date {
  const d = new Date(clockMs);
  clockMs += 1000;
  return d;
}

// ─── Snapshot factories ───────────────────────────────────────────────────────

const ANTHROPIC_CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const OPENAI_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

function anthropicSnapshot(modelId = 'claude-test'): FrozenProviderRequestSnapshot {
  return {
    providerId: 'anthropic',
    providerDisplayName: 'Anthropic',
    connectionId: ANTHROPIC_CONNECTION_ID,
    connectionName: 'Work',
    modelId,
    modelDisplayName: 'Claude Test',
    protocol: 'anthropic-messages',
    modelSource: 'catalog',
    catalogVersion: 1,
    catalogSource: 'bundled',
    catalogObservedAt: '2026-07-12T00:00:00.000Z',
    fieldProvenance: {},
    statusObservation: null,
    pricing: {
      currency: 'USD',
      effectiveAt: '2026-07-12T00:00:00.000Z',
      rates: {
        input: { amount: '5', per: 1_000_000, unit: 'tokens' },
        output: { amount: '25', per: 1_000_000, unit: 'tokens' },
      },
      inclusion: { cacheRead: 'subset-of-input', cacheWrite: 'unknown', reasoning: 'unknown' },
      provenance: {},
    },
  };
}

function openaiSnapshot(): FrozenProviderRequestSnapshot {
  return {
    providerId: 'openai',
    providerDisplayName: 'OpenAI',
    connectionId: OPENAI_CONNECTION_ID,
    connectionName: 'Personal',
    modelId: 'gpt-test',
    protocol: 'openai-compatible',
    modelSource: 'catalog',
    catalogVersion: 1,
    catalogSource: 'bundled',
    catalogObservedAt: '2026-07-12T00:00:00.000Z',
    fieldProvenance: {},
    statusObservation: null,
    pricing: {
      currency: 'USD',
      effectiveAt: '2026-07-12T00:00:00.000Z',
      rates: {
        input: { amount: '10', per: 1_000_000, unit: 'tokens' },
        output: { amount: '30', per: 1_000_000, unit: 'tokens' },
      },
      inclusion: { cacheRead: 'subset-of-input', cacheWrite: 'unknown', reasoning: 'unknown' },
      provenance: {},
    },
  };
}

// ─── Cost helpers ─────────────────────────────────────────────────────────────

function calculatedCost(amount: string, currency = 'USD'): AttemptCostResolution {
  return { state: 'calculated', source: 'token-formula', currency, amount };
}

function reportedCost(amount: string, currency = 'USD'): AttemptCostResolution {
  return { state: 'reported', source: 'provider-reported', currency, amount };
}

function unknownCost(reason: string): AttemptCostResolution {
  return { state: 'unknown', source: 'unknown', reason };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedProviderAttempt(opts: {
  attemptId: string;
  sessionId: string;
  chainId: string | null;
  turnId: string | null;
  outcome: 'succeeded' | 'failed' | 'interrupted';
  usage: NormalizedProviderUsage | null;
  cost: AttemptCostResolution;
  agentTier?: string | null;
  agentName?: string | null;
  agentScope?: string | null;
  snapshot?: FrozenProviderRequestSnapshot;
}): void {
  providerStore.insertPending({
    attemptId: opts.attemptId,
    sessionId: opts.sessionId,
    chainId: opts.chainId,
    turnId: opts.turnId,
    sdkCallId: `sdk-${opts.attemptId}`,
    snapshot: opts.snapshot ?? anthropicSnapshot(),
    agentScope: opts.agentScope ?? null,
    agentName: opts.agentName ?? null,
    agentTier: opts.agentTier ?? null,
    agentType: null,
  });
  providerStore.finalize(opts.attemptId, {
    outcome: opts.outcome,
    usage: opts.usage,
    providerEvidence: {},
    cost: opts.cost,
    error: opts.outcome === 'failed' ? 'test error' : undefined,
  });
}

function seedToolAttempt(opts: {
  toolAttemptId: string;
  sessionId: string;
  chainId: string | null;
  turnId: string | null;
  toolName: string;
  toolSource: 'builtin' | 'mcp';
  toolFamily: string;
  outcome: 'complete' | 'partial' | 'empty' | 'error' | 'cancelled';
  resultSizeBytes: number | null;
  offloaded?: boolean;
  timedOut?: boolean;
  error?: string;
}): void {
  toolStore.insertPending({
    toolAttemptId: opts.toolAttemptId,
    sessionId: opts.sessionId,
    chainId: opts.chainId,
    turnId: opts.turnId,
    providerAttemptId: null,
    toolCallId: `call-${opts.toolAttemptId}`,
    toolName: opts.toolName,
    toolSource: opts.toolSource,
    mcpServerName: null,
    toolFamily: opts.toolFamily,
    timeoutSeconds: null,
    agentScope: null,
  });
  toolStore.finalize(opts.toolAttemptId, {
    outcome: opts.outcome,
    resultSizeBytes: opts.resultSizeBytes,
    offloaded: opts.offloaded ?? false,
    timedOut: opts.timedOut ?? false,
    error: opts.error,
  });
}

function seedSubagentAttribution(opts: {
  subagentId: string;
  sessionId: string;
  chainId: string;
  agentName: string;
  agentType: string;
  agentTier: string;
  modelId: string;
  connectionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  parentChainId?: string | null;
}): void {
  attributionStore.insert({
    subagentId: opts.subagentId,
    sessionId: opts.sessionId,
    chainId: opts.chainId,
    parentChainId: opts.parentChainId ?? null,
    agentName: opts.agentName,
    agentType: opts.agentType,
    agentTier: opts.agentTier,
    modelId: opts.modelId,
    connectionId: opts.connectionId,
  });
  attributionStore.finalize(opts.subagentId, {
    status: opts.status,
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-analytics-'));
  dbPath = path.join(tempDir, 'accounting.db');
  clockMs = new Date('2026-07-12T10:00:00.000Z').getTime();

  providerStore = initializeProviderAccountingStore({ dbPath, now: clock });
  toolStore = initializeToolAttemptStore({ dbPath, now: clock });
  snapshotStore = initializeContextSnapshotStore({ dbPath, now: clock });
  attributionStore = initializeSubagentAttributionStore({ dbPath, now: clock });
});

afterEach(() => {
  resetProviderAccountingStore();
  resetToolAttemptStore();
  resetContextSnapshotStore();
  resetSubagentAttributionStore();
  resetProviderRuntimeContext();
  _clearDbCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('analytics-queries', () => {
  describe('empty database', () => {
    it('returns zero/empty results from all 7 functions without errors', () => {
      const overview = getOverview();
      expect(overview.stats.totalAttempts).toBe(0);
      expect(overview.stats.succeededAttempts).toBe(0);
      expect(overview.stats.failedAttempts).toBe(0);
      expect(overview.stats.totalInputTokens).toBe(0);
      expect(overview.stats.totalOutputTokens).toBe(0);
      expect(overview.stats.totalCost).toHaveLength(0);
      expect(overview.stats.unknownCostCount).toBe(0);
      expect(overview.stats.totalSessions).toBe(0);
      expect(overview.spendOverTime).toHaveLength(0);
      expect(overview.spendByModel).toHaveLength(0);
      expect(overview.spendByProvider).toHaveLength(0);
      expect(overview.outcomeDistribution).toHaveLength(0);

      const sessions = getSessions();
      expect(sessions.sessions).toHaveLength(0);
      expect(sessions.totalSessions).toBe(0);
      expect(sessions.truncated).toBe(false);

      const detail = getSessionDetail('nonexistent');
      expect(detail.summary.attemptCount).toBe(0);
      expect(detail.attempts).toHaveLength(0);
      expect(detail.chains).toHaveLength(0);
      expect(detail.toolCalls).toHaveLength(0);
      expect(detail.subagents).toHaveLength(0);

      const models = getModels();
      expect(models.models).toHaveLength(0);
      expect(models.connections).toHaveLength(0);
      expect(models.costPerModelOverTime).toHaveLength(0);
      expect(models.costPerConnectionOverTime).toHaveLength(0);

      const tools = getTools();
      expect(tools.tools).toHaveLength(0);
      expect(tools.outcomeDistribution).toHaveLength(0);
      expect(tools.invocationsOverTime).toHaveLength(0);

      const subagents = getSubagents();
      expect(subagents.summaries).toHaveLength(0);
      expect(subagents.costByAgentName).toHaveLength(0);
      expect(subagents.costByAgentTier).toHaveLength(0);
      expect(subagents.outcomeDistribution).toHaveLength(0);
      expect(subagents.invocationsOverTime).toHaveLength(0);

      const context = getContext();
      expect(context.totalSnapshots).toBe(0);
      expect(context.topSessions).toHaveLength(0);
      expect(context.topSubagents).toHaveLength(0);
      expect(context.totalSubagentCount).toBe(0);
      expect(context.avgBreakdown.systemTokens).toBe(0);
      expect(context.avgBreakdown.toolsTokens).toBe(0);
    });
  });

  // ── getOverview ─────────────────────────────────────────────────────────────

  describe('getOverview', () => {
    it('returns aggregate stats, time series, spend, and distributions', () => {
      // 3 attempts: 2 succeeded (with cost), 1 failed (unknown cost)
      seedProviderAttempt({
        attemptId: 'att-1', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded',
        usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('1'),
        agentTier: 'main',
      });
      seedProviderAttempt({
        attemptId: 'att-2', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'succeeded',
        usage: { inputTokens: 2000, outputTokens: 1000 },
        cost: calculatedCost('2'),
        agentTier: 'main',
      });
      seedProviderAttempt({
        attemptId: 'att-3', sessionId: 'sess-2', chainId: null, turnId: 'turn-3',
        outcome: 'failed',
        usage: null,
        cost: unknownCost('no usage'),
        agentTier: 'main',
      });

      const result = getOverview();

      // Stats
      expect(result.stats.totalAttempts).toBe(3);
      expect(result.stats.succeededAttempts).toBe(2);
      expect(result.stats.failedAttempts).toBe(1);
      expect(result.stats.interruptedAttempts).toBe(0);
      expect(result.stats.totalSessions).toBe(2);
      expect(result.stats.totalInputTokens).toBe(3000);
      expect(result.stats.totalOutputTokens).toBe(1500);
      expect(result.stats.totalCacheReadTokens).toBe(0);
      expect(result.stats.totalCacheWriteTokens).toBe(0);
      expect(result.stats.totalReasoningTokens).toBe(0);
      expect(result.stats.unknownCostCount).toBe(1);

      // Total cost (only calculated costs summed)
      expect(result.stats.totalCost).toHaveLength(1);
      expect(result.stats.totalCost[0].currency).toBe('USD');
      expect(result.stats.totalCost[0].amount).toBe('3');
      expect(result.stats.totalCost[0].recordCount).toBe(2);

      // Time series — all on the same date
      expect(result.spendOverTime).toHaveLength(1);
      expect(result.spendOverTime[0].date).toBe('2026-07-12');
      expect(result.spendOverTime[0].cost).toBe('3');
      expect(result.spendOverTime[0].currency).toBe('USD');
      expect(result.tokenUsageOverTime[0].inputTokens).toBe(3000);
      expect(result.tokenUsageOverTime[0].outputTokens).toBe(1500);

      // Spend by model
      expect(result.spendByModel).toHaveLength(1);
      expect(result.spendByModel[0]).toEqual({ modelId: 'claude-test', providerId: 'anthropic', cost: '3', currency: 'USD' });

      // Spend by provider
      expect(result.spendByProvider).toHaveLength(1);
      expect(result.spendByProvider[0]).toEqual({ providerId: 'anthropic', cost: '3', currency: 'USD' });

      // Outcome distribution
      expect(result.outcomeDistribution).toContainEqual({ outcome: 'succeeded', count: 2 });
      expect(result.outcomeDistribution).toContainEqual({ outcome: 'failed', count: 1 });

      // Cost source distribution
      expect(result.costSourceDistribution).toContainEqual({ source: 'token-formula', count: 2 });
      expect(result.costSourceDistribution).toContainEqual({ source: 'unknown', count: 1 });

      // Agent tier distribution
      expect(result.agentTierDistribution).toContainEqual({ tier: 'main', count: 3 });
    });

    it('keeps currencies separate in spend time series and reports usage coverage', () => {
      seedProviderAttempt({
        attemptId: 'usd-attempt', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 },
        cost: calculatedCost('1', 'USD'),
      });
      seedProviderAttempt({
        attemptId: 'eur-attempt', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'succeeded', usage: null,
        cost: calculatedCost('2', 'EUR'),
      });

      const result = getOverview();

      expect(result.spendOverTime).toEqual([
        { date: '2026-07-12', currency: 'EUR', cost: '2' },
        { date: '2026-07-12', currency: 'USD', cost: '1' },
      ]);
      expect(result.stats.knownUsageCount).toBe(1);
      expect(result.stats.unknownUsageCount).toBe(1);
      expect(result.tokenUsageOverTime[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    });

    it('groups costSourceDistribution by the cost_source column', () => {
      seedProviderAttempt({
        attemptId: 'att-reported', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 },
        cost: reportedCost('1'),
      });
      seedProviderAttempt({
        attemptId: 'att-calculated', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 },
        cost: calculatedCost('2'),
      });
      seedProviderAttempt({
        attemptId: 'att-unknown', sessionId: 'sess-1', chainId: null, turnId: 'turn-3',
        outcome: 'failed', usage: null,
        cost: unknownCost('no usage'),
      });

      const result = getOverview();
      expect(result.costSourceDistribution).toContainEqual({ source: 'provider-reported', count: 1 });
      expect(result.costSourceDistribution).toContainEqual({ source: 'token-formula', count: 1 });
      expect(result.costSourceDistribution).toContainEqual({ source: 'unknown', count: 1 });
      expect(result.costSourceDistribution).not.toContainEqual({ source: 'reported', count: 1 });
      expect(result.costSourceDistribution).not.toContainEqual({ source: 'calculated', count: 1 });
    });

    it('sorts spendByModel and spendByProvider descending by numeric cost', () => {
      seedProviderAttempt({
        attemptId: 'att-small', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 1, outputTokens: 1 },
        cost: calculatedCost('1'), snapshot: anthropicSnapshot('model-small'),
      });
      seedProviderAttempt({
        attemptId: 'att-big', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'succeeded', usage: { inputTokens: 1, outputTokens: 1 },
        cost: calculatedCost('30'), snapshot: anthropicSnapshot('model-big'),
      });
      seedProviderAttempt({
        attemptId: 'att-mid', sessionId: 'sess-1', chainId: null, turnId: 'turn-3',
        outcome: 'succeeded', usage: { inputTokens: 1, outputTokens: 1 },
        cost: calculatedCost('5'), snapshot: openaiSnapshot(),
      });

      const result = getOverview();
      expect(result.spendByModel.map((s) => ({ modelId: s.modelId, cost: s.cost }))).toEqual([
        { modelId: 'model-big', cost: '30' },
        { modelId: 'gpt-test', cost: '5' },
        { modelId: 'model-small', cost: '1' },
      ]);
      expect(result.spendByProvider.map((s) => ({ providerId: s.providerId, cost: s.cost }))).toEqual([
        { providerId: 'anthropic', cost: '31' },
        { providerId: 'openai', cost: '5' },
      ]);
    });
  });

  // ── Quota overview (connection gating) ─────────────────────────────────────

  describe('quotaByProvider connection gating', () => {
    function quotaObservation(providerId: string, connectionId?: string): ProviderStatusObservation {
      return {
        providerId,
        ...(connectionId ? { connectionId } : {}),
        observedAt: '2026-07-12T10:00:00.000Z',
        providerUpdatedAt: null,
        availability: 'available',
        stale: false,
        data: {
          quota: {
            observedAt: '2026-07-12T10:00:00.000Z',
            balances: [{ label: 'Credits remaining', amount: '12.5', unit: 'USD' }],
            subscription: null,
            allowances: [{ label: 'API key', state: 'available' }],
          },
        },
      };
    }

    function fakeStatusService(observations: readonly ProviderStatusObservation[]): ProviderStatusService {
      return { list: () => observations } as unknown as ProviderStatusService;
    }

    function fakeConnectionStore(providerIds: readonly string[]): ConnectionStore {
      return { listProviderIdsSync: () => new Set(providerIds) } as unknown as ConnectionStore;
    }

    it('hides cached quota for providers with no configured connection', () => {
      setProviderStatusService(fakeStatusService([
        quotaObservation('lilac'),
        quotaObservation('neuralwatt', 'conn-1'),
      ]));
      setProviderConnectionStore(fakeConnectionStore(['neuralwatt']));

      const result = getOverview();
      expect(result.quotaByProvider).toHaveLength(1);
      expect(result.quotaByProvider[0].providerId).toBe('neuralwatt');
      expect(result.quotaByProvider[0].connectionId).toBe('conn-1');
    });

    it('shows no quota cards when no connections are configured', () => {
      setProviderStatusService(fakeStatusService([
        quotaObservation('lilac'),
        quotaObservation('neuralwatt', 'conn-1'),
      ]));
      setProviderConnectionStore(fakeConnectionStore([]));

      const result = getOverview();
      expect(result.quotaByProvider).toHaveLength(0);
    });

    it('shows a provider-wide observation when a connection exists for that provider', () => {
      setProviderStatusService(fakeStatusService([quotaObservation('lilac')]));
      setProviderConnectionStore(fakeConnectionStore(['lilac']));

      const result = getOverview();
      expect(result.quotaByProvider).toHaveLength(1);
      expect(result.quotaByProvider[0].providerId).toBe('lilac');
      expect(result.quotaByProvider[0].connectionId).toBeNull();
    });
  });

  // ── getSessions ─────────────────────────────────────────────────────────────

  describe('getSessions', () => {
    it('returns per-session breakdown with costs, tokens, models, and subagent count', () => {
      // Session 1: 2 succeeded attempts
      seedProviderAttempt({
        attemptId: 'att-1', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded',
        usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('1'),
        agentTier: 'main',
      });
      seedProviderAttempt({
        attemptId: 'att-2', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'succeeded',
        usage: { inputTokens: 2000, outputTokens: 1000 },
        cost: calculatedCost('2'),
        agentTier: 'main',
      });
      // Session 2: 1 failed attempt (no usage, unknown cost)
      seedProviderAttempt({
        attemptId: 'att-3', sessionId: 'sess-2', chainId: null, turnId: 'turn-3',
        outcome: 'failed',
        usage: null,
        cost: unknownCost('no usage'),
        agentTier: 'main',
      });

      const sessions = getSessions(100);
      expect(sessions.sessions).toHaveLength(2);
      expect(sessions.totalSessions).toBe(2);
      expect(sessions.truncated).toBe(false);

      // Session 1
      const s1 = sessions.sessions.find((s) => s.sessionId === 'sess-1')!;
      expect(s1.attempts).toBe(2);
      expect(s1.succeeded).toBe(2);
      expect(s1.failed).toBe(0);
      expect(s1.interrupted).toBe(0);
      expect(s1.inputTokens).toBe(3000);
      expect(s1.outputTokens).toBe(1500);
      expect(s1.cacheReadTokens).toBe(0);
      expect(s1.totalTokens).toBe(4500);
      expect(s1.modelsUsed).toEqual(['claude-test']);
      expect(s1.subagentCount).toBe(0);
      expect(s1.firstAttempt).not.toBeNull();
      expect(s1.lastAttempt).not.toBeNull();
      expect(s1.totalCost).toHaveLength(1);
      expect(s1.totalCost[0]).toEqual({ currency: 'USD', amount: '3', recordCount: 2 });

      // Session 2
      const s2 = sessions.sessions.find((s) => s.sessionId === 'sess-2')!;
      expect(s2.attempts).toBe(1);
      expect(s2.succeeded).toBe(0);
      expect(s2.failed).toBe(1);
      expect(s2.inputTokens).toBe(0);
      expect(s2.outputTokens).toBe(0);
      expect(s2.totalTokens).toBe(0);
      expect(s2.modelsUsed).toEqual(['claude-test']);
      expect(s2.subagentCount).toBe(0);
      expect(s2.totalCost).toHaveLength(0);

      const limited = getSessions(1);
      expect(limited.sessions).toHaveLength(1);
      expect(limited.totalSessions).toBe(2);
      expect(limited.truncated).toBe(true);
    });
  });

  // ── getSessionDetail ───────────────────────────────────────────────────────

  describe('getSessionDetail', () => {
    it('returns full session detail with chains, attempts, tool calls, and subagents', () => {
      // Main-chain attempt
      seedProviderAttempt({
        attemptId: 'att-1', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded',
        usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('1'),
        agentTier: 'main',
        agentName: 'main-agent',
        agentScope: 'main',
      });
      // Subagent-chain attempt
      seedProviderAttempt({
        attemptId: 'att-2', sessionId: 'sess-1', chainId: 'chain-sub-1', turnId: 'turn-2',
        outcome: 'succeeded',
        usage: { inputTokens: 500, outputTokens: 250 },
        cost: calculatedCost('1'),
        agentTier: 'sprout',
        agentName: 'sub-agent-1',
        agentScope: 'subagent',
      });

      // Tool calls
      seedToolAttempt({
        toolAttemptId: 'tool-1', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        toolName: 'read', toolSource: 'builtin', toolFamily: 'filesystem',
        outcome: 'complete', resultSizeBytes: 1024, offloaded: true,
      });
      seedToolAttempt({
        toolAttemptId: 'tool-2', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        toolName: 'grep', toolSource: 'builtin', toolFamily: 'search',
        outcome: 'error', resultSizeBytes: null, error: 'pattern not found',
      });

      // Subagent attribution
      seedSubagentAttribution({
        subagentId: 'sub-1', sessionId: 'sess-1', chainId: 'chain-sub-1',
        agentName: 'sub-agent-1', agentType: 'subagent', agentTier: 'sprout',
        modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed', parentChainId: null,
      });

      const detail = getSessionDetail('sess-1');

      expect(detail.sessionId).toBe('sess-1');

      // Summary
      expect(detail.summary.attemptCount).toBe(2);
      expect(detail.summary.succeeded).toBe(2);
      expect(detail.summary.failed).toBe(0);
      expect(detail.summary.interrupted).toBe(0);
      expect(detail.summary.totalInputTokens).toBe(1500);
      expect(detail.summary.totalOutputTokens).toBe(750);
      expect(detail.summary.totalCacheReadTokens).toBe(0);
      expect(detail.summary.modelsUsed).toEqual(['claude-test']);
      expect(detail.summary.providersUsed).toEqual(['anthropic']);
      expect(detail.summary.subagentCount).toBe(1);
      expect(detail.summary.firstAttempt).not.toBeNull();
      expect(detail.summary.lastAttempt).not.toBeNull();

      // Summary cost
      expect(detail.summary.totalCost).toHaveLength(1);
      expect(detail.summary.totalCost[0].currency).toBe('USD');
      expect(detail.summary.totalCost[0].amount).toBe('2');
      expect(detail.summary.totalCost[0].recordCount).toBe(2);

      // Attempts
      expect(detail.attempts).toHaveLength(2);
      const att1 = detail.attempts.find((a) => a.attemptId === 'att-1')!;
      expect(att1.modelId).toBe('claude-test');
      expect(att1.modelDisplayName).toBe('Claude Test');
      expect(att1.providerId).toBe('anthropic');
      expect(att1.connectionId).toBe(ANTHROPIC_CONNECTION_ID);
      expect(att1.connectionName).toBe('Work');
      expect(att1.outcome).toBe('succeeded');
      expect(att1.costState).toBe('calculated');
      expect(att1.inputTokens).toBe(1000);
      expect(att1.outputTokens).toBe(500);
      expect(att1.chainId).toBeNull();
      expect(att1.agentName).toBe('main-agent');
      expect(att1.agentTier).toBe('main');
      expect(att1.latencyMs).toBe(1000);
      expect(att1.error).toBeNull();

      const att2 = detail.attempts.find((a) => a.attemptId === 'att-2')!;
      expect(att2.chainId).toBe('chain-sub-1');
      expect(att2.agentName).toBe('sub-agent-1');
      expect(att2.agentTier).toBe('sprout');
      expect(att2.inputTokens).toBe(500);
      expect(att2.outputTokens).toBe(250);
      expect(att2.latencyMs).toBe(1000);

      // Chains — main (null) + chain-sub-1
      expect(detail.chains).toHaveLength(2);
      const mainChain = detail.chains.find((c) => c.chainId === null)!;
      expect(mainChain.attempts).toBe(1);
      expect(mainChain.inputTokens).toBe(1000);
      expect(mainChain.outputTokens).toBe(500);
      expect(mainChain.succeeded).toBe(1);
      expect(mainChain.totalCost).toEqual([{ currency: 'USD', amount: '1', recordCount: 1 }]);

      const subChain = detail.chains.find((c) => c.chainId === 'chain-sub-1')!;
      expect(subChain.attempts).toBe(1);
      expect(subChain.agentName).toBe('sub-agent-1');
      expect(subChain.agentTier).toBe('sprout');
      expect(subChain.inputTokens).toBe(500);
      expect(subChain.outputTokens).toBe(250);
      expect(subChain.totalCost).toEqual([{ currency: 'USD', amount: '1', recordCount: 1 }]);

      // Tool calls
      expect(detail.toolCalls).toHaveLength(2);
      const tc1 = detail.toolCalls.find((t) => t.toolAttemptId === 'tool-1')!;
      expect(tc1.toolName).toBe('read');
      expect(tc1.toolFamily).toBe('filesystem');
      expect(tc1.outcome).toBe('complete');
      expect(tc1.resultSizeBytes).toBe(1024);
      expect(tc1.offloaded).toBe(true);
      expect(tc1.timedOut).toBe(false);
      expect(tc1.durationMs).toBe(1000);

      const tc2 = detail.toolCalls.find((t) => t.toolAttemptId === 'tool-2')!;
      expect(tc2.toolName).toBe('grep');
      expect(tc2.outcome).toBe('error');
      expect(tc2.resultSizeBytes).toBeNull();
      expect(tc2.offloaded).toBe(false);

      // Subagents
      expect(detail.subagents).toHaveLength(1);
      const sa = detail.subagents[0];
      expect(sa.subagentId).toBe('sub-1');
      expect(sa.agentName).toBe('sub-agent-1');
      expect(sa.agentType).toBe('subagent');
      expect(sa.agentTier).toBe('sprout');
      expect(sa.modelId).toBe('claude-test');
      expect(sa.status).toBe('completed');
      expect(sa.attempts).toBe(1);
      expect(sa.inputTokens).toBe(500);
      expect(sa.outputTokens).toBe(250);
      expect(sa.totalCost).toEqual([{ currency: 'USD', amount: '1', recordCount: 1 }]);
      expect(sa.completedAt).not.toBeNull();
    });

    it('applies the selected time range to attempts, tools, and subagents', () => {
      seedProviderAttempt({
        attemptId: 'old-attempt', sessionId: 'sess-1', chainId: 'old-chain', turnId: 'old-turn',
        outcome: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 }, cost: calculatedCost('1'),
      });
      seedToolAttempt({
        toolAttemptId: 'old-tool', sessionId: 'sess-1', chainId: 'old-chain', turnId: 'old-turn',
        toolName: 'read', toolSource: 'builtin', toolFamily: 'filesystem', outcome: 'complete', resultSizeBytes: 10,
      });
      seedSubagentAttribution({
        subagentId: 'old-subagent', sessionId: 'sess-1', chainId: 'old-chain', agentName: 'old',
        agentType: 'worker', agentTier: 'sprout', modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });

      clockMs = new Date('2026-07-15T10:00:00.000Z').getTime();
      seedProviderAttempt({
        attemptId: 'new-attempt', sessionId: 'sess-1', chainId: 'new-chain', turnId: 'new-turn',
        outcome: 'succeeded', usage: { inputTokens: 20, outputTokens: 10 }, cost: calculatedCost('2'),
      });
      seedToolAttempt({
        toolAttemptId: 'new-tool', sessionId: 'sess-1', chainId: 'new-chain', turnId: 'new-turn',
        toolName: 'grep', toolSource: 'builtin', toolFamily: 'search', outcome: 'complete', resultSizeBytes: 20,
      });
      seedSubagentAttribution({
        subagentId: 'new-subagent', sessionId: 'sess-1', chainId: 'new-chain', agentName: 'new',
        agentType: 'worker', agentTier: 'sprout', modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });

      const detail = getSessionDetail('sess-1', {
        startDate: '2026-07-15T00:00:00.000Z',
        endDate: '2026-07-15T23:59:59.999Z',
      });

      expect(detail.attempts.map((attempt) => attempt.attemptId)).toEqual(['new-attempt']);
      expect(detail.toolCalls.map((tool) => tool.toolAttemptId)).toEqual(['new-tool']);
      expect(detail.subagents.map((subagent) => subagent.subagentId)).toEqual(['new-subagent']);
    });

    it('computes summary.lastAttempt as the max non-null completed_at', () => {
      seedProviderAttempt({
        attemptId: 'att-done', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 },
        cost: calculatedCost('1'),
      });
      providerStore.insertPending({
        attemptId: 'att-pending',
        sessionId: 'sess-1',
        chainId: null,
        turnId: 'turn-2',
        sdkCallId: 'sdk-att-pending',
        snapshot: anthropicSnapshot(),
        agentScope: null,
        agentName: null,
        agentTier: null,
        agentType: null,
      });

      const detail = getSessionDetail('sess-1');
      expect(detail.summary.attemptCount).toBe(2);
      const completed = detail.attempts.find((a) => a.attemptId === 'att-done')!;
      const pending = detail.attempts.find((a) => a.attemptId === 'att-pending')!;
      expect(completed.completedAt).not.toBeNull();
      expect(pending.completedAt).toBeNull();
      expect(detail.summary.lastAttempt).toBe(completed.completedAt);
    });
  });

  // ── Native units (R8 / AE7) ─────────────────────────────────────────────────

  describe('native-unit accounting', () => {
    const NEURALWATT_CONNECTION_ID = '33333333-3333-4333-8333-333333333333';

    function neuralwattSnapshot(): FrozenProviderRequestSnapshot {
      return {
        providerId: 'neuralwatt',
        providerDisplayName: 'Neuralwatt',
        connectionId: NEURALWATT_CONNECTION_ID,
        connectionName: 'NW',
        modelId: 'nw-glm',
        protocol: 'openai-compatible',
        modelSource: 'catalog',
        catalogVersion: 1,
        catalogSource: 'bundled',
        catalogObservedAt: '2026-07-12T00:00:00.000Z',
        fieldProvenance: {},
        statusObservation: null,
        pricing: {
          currency: 'kWh',
          currencyUnit: { kind: 'non-fiat', unit: 'kWh', displayName: 'kilowatt-hour' },
          effectiveAt: '2026-07-12T00:00:00.000Z',
          rates: { energy: { amount: '0.05', per: 1, unit: 'energy' } },
          inclusion: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown' },
          provenance: {},
        },
      };
    }

    it('keeps kWh and USD cost buckets separate without merging or conversion', () => {
      seedProviderAttempt({
        attemptId: 'att-usd', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('2', 'USD'),
      });
      providerStore.insertPending({
        attemptId: 'att-kwh', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        sdkCallId: 'sdk-att-kwh', snapshot: neuralwattSnapshot(),
        agentScope: null, agentName: null, agentTier: null, agentType: null,
      });
      providerStore.finalize('att-kwh', {
        outcome: 'succeeded',
        usage: {
          inputTokens: 800, outputTokens: 200,
          energyKwhConsumed: '0.4', energyKwhCharged: '0.26', pricingMultiplier: '0.65',
        },
        providerEvidence: {},
        cost: { state: 'calculated', source: 'energy-formula', currency: 'kWh', amount: '0.013' },
      });

      const overview = getOverview();
      const buckets = new Map(overview.stats.totalCost.map((c) => [c.currency, c.amount]));
      expect(buckets.get('USD')).toBe('2');
      expect(buckets.get('kWh')).toBe('0.013');
      // AE7: two distinct buckets, never merged into one.
      expect(overview.stats.totalCost).toHaveLength(2);
    });

    it('retains native-unit evidence (consumed/charged/multiplier) on the attempt detail', () => {
      providerStore.insertPending({
        attemptId: 'att-kwh', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        sdkCallId: 'sdk-att-kwh', snapshot: neuralwattSnapshot(),
        agentScope: null, agentName: null, agentTier: null, agentType: null,
      });
      providerStore.finalize('att-kwh', {
        outcome: 'succeeded',
        usage: {
          inputTokens: 800, outputTokens: 200,
          energyKwhConsumed: '0.4', energyKwhCharged: '0.26', pricingMultiplier: '0.65',
        },
        providerEvidence: {},
        cost: { state: 'calculated', source: 'energy-formula', currency: 'kWh', amount: '0.013' },
      });

      const detail = getSessionDetail('sess-1');
      const attempt = detail.attempts.find((a) => a.attemptId === 'att-kwh')!;
      expect(attempt.currency).toBe('kWh');
      expect(attempt.energyKwhConsumed).toBe('0.4');
      expect(attempt.energyKwhCharged).toBe('0.26');
      expect(attempt.pricingMultiplier).toBe('0.65');
    });

    it('renders no energy evidence for a token-only attempt', () => {
      seedProviderAttempt({
        attemptId: 'att-usd', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('2', 'USD'),
      });
      const detail = getSessionDetail('sess-1');
      const attempt = detail.attempts.find((a) => a.attemptId === 'att-usd')!;
      expect(attempt.energyKwhConsumed).toBeNull();
      expect(attempt.energyKwhCharged).toBeNull();
      expect(attempt.pricingMultiplier).toBeNull();
    });
  });

  // ── getModels ───────────────────────────────────────────────────────────────

  describe('getModels', () => {
    it('returns per-model and per-connection breakdown with time series', () => {
      // Model claude-test (Anthropic): 2 attempts, 1 succeeded + 1 failed
      seedProviderAttempt({
        attemptId: 'att-1', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded',
        usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('1'),
        agentTier: 'main',
        snapshot: anthropicSnapshot('claude-test'),
      });
      seedProviderAttempt({
        attemptId: 'att-2', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'failed',
        usage: { inputTokens: 500, outputTokens: 0 },
        cost: unknownCost('error'),
        agentTier: 'main',
        snapshot: anthropicSnapshot('claude-test'),
      });
      // Model gpt-test (OpenAI): 1 succeeded attempt
      seedProviderAttempt({
        attemptId: 'att-3', sessionId: 'sess-1', chainId: null, turnId: 'turn-3',
        outcome: 'succeeded',
        usage: { inputTokens: 2000, outputTokens: 1000 },
        cost: calculatedCost('3'),
        agentTier: 'main',
        snapshot: openaiSnapshot(),
      });

      const result = getModels();

      // Models
      expect(result.models).toHaveLength(2);

      const claude = result.models.find((m) => m.modelId === 'claude-test')!;
      expect(claude.providerId).toBe('anthropic');
      expect(claude.modelDisplayName).toBe('Claude Test');
      expect(claude.connectionName).toBe('Work');
      expect(claude.attempts).toBe(2);
      expect(claude.succeeded).toBe(1);
      expect(claude.failed).toBe(1);
      expect(claude.inputTokens).toBe(1500);
      expect(claude.outputTokens).toBe(500);
      expect(claude.totalCost).toEqual([{ currency: 'USD', amount: '1', recordCount: 1 }]);

      const gpt = result.models.find((m) => m.modelId === 'gpt-test')!;
      expect(gpt.providerId).toBe('openai');
      // Legacy snapshots without a captured display name fall back to null.
      expect(gpt.modelDisplayName).toBeNull();
      expect(gpt.connectionName).toBe('Personal');
      expect(gpt.attempts).toBe(1);
      expect(gpt.succeeded).toBe(1);
      expect(gpt.inputTokens).toBe(2000);
      expect(gpt.outputTokens).toBe(1000);
      expect(gpt.totalCost).toEqual([{ currency: 'USD', amount: '3', recordCount: 1 }]);

      // Connections
      expect(result.connections).toHaveLength(2);

      const anthropicConn = result.connections.find((c) => c.connectionId === ANTHROPIC_CONNECTION_ID)!;
      expect(anthropicConn.connectionName).toBe('Work');
      expect(anthropicConn.providerDisplayName).toBe('Anthropic');
      expect(anthropicConn.attempts).toBe(2);
      expect(anthropicConn.succeeded).toBe(1);
      expect(anthropicConn.failed).toBe(1);
      expect(anthropicConn.modelCount).toBe(1);
      expect(anthropicConn.totalInputTokens).toBe(1500);
      expect(anthropicConn.totalOutputTokens).toBe(500);
      expect(anthropicConn.totalCost).toEqual([{ currency: 'USD', amount: '1', recordCount: 1 }]);

      const openaiConn = result.connections.find((c) => c.connectionId === OPENAI_CONNECTION_ID)!;
      expect(openaiConn.connectionName).toBe('Personal');
      expect(openaiConn.providerDisplayName).toBe('OpenAI');
      expect(openaiConn.attempts).toBe(1);
      expect(openaiConn.succeeded).toBe(1);
      expect(openaiConn.modelCount).toBe(1);
      expect(openaiConn.totalInputTokens).toBe(2000);
      expect(openaiConn.totalOutputTokens).toBe(1000);
      expect(openaiConn.totalCost).toEqual([{ currency: 'USD', amount: '3', recordCount: 1 }]);

      // Time series — 2 entries (one per model, same date)
      expect(result.costPerModelOverTime).toHaveLength(2);
      const modelCosts = result.costPerModelOverTime.map((p) => p.cost).sort();
      expect(modelCosts).toEqual(['1', '3']);
      expect(result.costPerModelOverTime[0].date).toBe('2026-07-12');

      // Connection time series — 2 entries
      expect(result.costPerConnectionOverTime).toHaveLength(2);
      const connCosts = result.costPerConnectionOverTime.map((p) => p.cost).sort();
      expect(connCosts).toEqual(['1', '3']);
    });

    it('preserves model, provider, connection, and currency identity for costs', () => {
      seedProviderAttempt({
        attemptId: 'usd-model', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        outcome: 'succeeded', usage: { inputTokens: 1, outputTokens: 1 },
        cost: calculatedCost('1', 'USD'), snapshot: anthropicSnapshot('shared-model'),
      });
      seedProviderAttempt({
        attemptId: 'eur-model', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        outcome: 'succeeded', usage: { inputTokens: 1, outputTokens: 1 },
        cost: calculatedCost('2', 'EUR'), snapshot: anthropicSnapshot('shared-model'),
      });

      const result = getModels();

      expect(result.models[0].totalCost).toEqual([
        { currency: 'EUR', amount: '2', recordCount: 1 },
        { currency: 'USD', amount: '1', recordCount: 1 },
      ]);
      expect(result.costPerModelOverTime).toEqual([
        expect.objectContaining({ modelId: 'shared-model', providerId: 'anthropic', currency: 'EUR', cost: '2' }),
        expect.objectContaining({ modelId: 'shared-model', providerId: 'anthropic', currency: 'USD', cost: '1' }),
      ]);
      expect(result.costPerConnectionOverTime[0]).toEqual(expect.objectContaining({
        connectionId: ANTHROPIC_CONNECTION_ID,
        currency: 'EUR',
      }));
    });
  });

  // ── getTools ────────────────────────────────────────────────────────────────

  describe('getTools', () => {
    it('returns tool usage summary, invocations over time, and outcome distribution', () => {
      // read: 2 invocations (1 complete + offloaded, 1 error)
      seedToolAttempt({
        toolAttemptId: 'tool-1', sessionId: 'sess-1', chainId: null, turnId: 'turn-1',
        toolName: 'read', toolSource: 'builtin', toolFamily: 'filesystem',
        outcome: 'complete', resultSizeBytes: 1024, offloaded: true,
      });
      seedToolAttempt({
        toolAttemptId: 'tool-2', sessionId: 'sess-1', chainId: null, turnId: 'turn-2',
        toolName: 'read', toolSource: 'builtin', toolFamily: 'filesystem',
        outcome: 'error', resultSizeBytes: null, error: 'file not found',
      });
      // grep: 1 invocation (complete)
      seedToolAttempt({
        toolAttemptId: 'tool-3', sessionId: 'sess-1', chainId: null, turnId: 'turn-3',
        toolName: 'grep', toolSource: 'builtin', toolFamily: 'search',
        outcome: 'complete', resultSizeBytes: 512,
      });

      const result = getTools();

      // Tool breakdowns
      expect(result.tools).toHaveLength(2);

      const readTool = result.tools.find((t) => t.toolName === 'read')!;
      expect(readTool.toolSource).toBe('builtin');
      expect(readTool.toolFamily).toBe('filesystem');
      expect(readTool.invocations).toBe(2);
      expect(readTool.complete).toBe(1);
      expect(readTool.error).toBe(1);
      expect(readTool.cancelled).toBe(0);
      expect(readTool.timedOut).toBe(0);
      expect(readTool.avgDurationMs).toBe(1000);
      expect(readTool.avgResultSizeBytes).toBe(1024); // only 1 has resultSizeBytes
      expect(readTool.offloadRate).toBe(0.5);

      const grepTool = result.tools.find((t) => t.toolName === 'grep')!;
      expect(grepTool.invocations).toBe(1);
      expect(grepTool.complete).toBe(1);
      expect(grepTool.error).toBe(0);
      expect(grepTool.avgDurationMs).toBe(1000);
      expect(grepTool.avgResultSizeBytes).toBe(512);
      expect(grepTool.offloadRate).toBe(0);

      // Outcome distribution
      expect(result.outcomeDistribution).toContainEqual({ outcome: 'complete', count: 2 });
      expect(result.outcomeDistribution).toContainEqual({ outcome: 'error', count: 1 });

      // Invocations over time
      expect(result.invocationsOverTime).toHaveLength(2);
      expect(result.invocationsOverTime).toContainEqual({ date: '2026-07-12', toolName: 'read', count: 2 });
      expect(result.invocationsOverTime).toContainEqual({ date: '2026-07-12', toolName: 'grep', count: 1 });
    });

    it('aggregates every matching row beyond the raw-detail limit', () => {
      for (let i = 0; i < 1001; i++) {
        seedToolAttempt({
          toolAttemptId: `tool-${i}`, sessionId: 'sess-1', chainId: null, turnId: `turn-${i}`,
          toolName: 'read', toolSource: 'builtin', toolFamily: 'filesystem',
          outcome: 'complete', resultSizeBytes: 1,
        });
      }

      const result = getTools();
      expect(result.tools[0].invocations).toBe(1001);
      expect(result.outcomeDistribution).toContainEqual({ outcome: 'complete', count: 1001 });
    });
  });

  // ── getSubagents ────────────────────────────────────────────────────────────

  describe('getSubagents', () => {
    it('returns subagent summaries, cost by agent name/tier, and outcome distribution', () => {
      // Provider attempts for subagent chains
      seedProviderAttempt({
        attemptId: 'att-1', sessionId: 'sess-1', chainId: 'chain-sub-1', turnId: 'turn-1',
        outcome: 'succeeded',
        usage: { inputTokens: 1000, outputTokens: 500 },
        cost: calculatedCost('1'),
        agentTier: 'sprout',
        agentName: 'researcher',
      });
      seedProviderAttempt({
        attemptId: 'att-2', sessionId: 'sess-1', chainId: 'chain-sub-2', turnId: 'turn-2',
        outcome: 'succeeded',
        usage: { inputTokens: 2000, outputTokens: 1000 },
        cost: calculatedCost('2'),
        agentTier: 'bloom',
        agentName: 'coder',
      });

      // Subagent attribution rows
      seedSubagentAttribution({
        subagentId: 'sub-1', sessionId: 'sess-1', chainId: 'chain-sub-1',
        agentName: 'researcher', agentType: 'subagent', agentTier: 'sprout',
        modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });
      seedSubagentAttribution({
        subagentId: 'sub-2', sessionId: 'sess-1', chainId: 'chain-sub-2',
        agentName: 'coder', agentType: 'subagent', agentTier: 'bloom',
        modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });

      const result = getSubagents();

      // Summaries
      expect(result.summaries).toHaveLength(2);

      const researcher = result.summaries.find((s) => s.agentName === 'researcher')!;
      expect(researcher.agentType).toBe('subagent');
      expect(researcher.agentTier).toBe('sprout');
      expect(researcher.invocations).toBe(1);
      expect(researcher.attempts).toBe(1);
      expect(researcher.inputTokens).toBe(1000);
      expect(researcher.outputTokens).toBe(500);
      expect(researcher.totalCost).toEqual([{ currency: 'USD', amount: '1', recordCount: 1 }]);
      expect(researcher.completed).toBe(1);
      expect(researcher.failed).toBe(0);
      expect(researcher.modelsUsed).toEqual(['claude-test']);
      expect(researcher.avgDurationMs).toBe(1000);

      const coder = result.summaries.find((s) => s.agentName === 'coder')!;
      expect(coder.agentTier).toBe('bloom');
      expect(coder.invocations).toBe(1);
      expect(coder.attempts).toBe(1);
      expect(coder.inputTokens).toBe(2000);
      expect(coder.outputTokens).toBe(1000);
      expect(coder.totalCost).toEqual([{ currency: 'USD', amount: '2', recordCount: 1 }]);
      expect(coder.completed).toBe(1);
      expect(coder.modelsUsed).toEqual(['claude-test']);

      // Cost by agent name
      expect(result.costByAgentName).toContainEqual({ agentName: 'researcher', cost: '1', currency: 'USD' });
      expect(result.costByAgentName).toContainEqual({ agentName: 'coder', cost: '2', currency: 'USD' });

      // Cost by agent tier
      expect(result.costByAgentTier).toContainEqual({ tier: 'sprout', cost: '1', currency: 'USD' });
      expect(result.costByAgentTier).toContainEqual({ tier: 'bloom', cost: '2', currency: 'USD' });

      // Outcome distribution
      expect(result.outcomeDistribution).toContainEqual({ status: 'completed', count: 2 });
    });

    it('aggregates every subagent attribution beyond 1,000 rows', () => {
      for (let i = 0; i < 1001; i++) {
        seedSubagentAttribution({
          subagentId: `subagent-${i}`, sessionId: 'sess-1', chainId: `chain-${i}`,
          agentName: 'researcher', agentType: 'worker', agentTier: 'sprout',
          modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID, status: 'completed',
        });
      }

      const result = getSubagents();
      expect(result.summaries[0].invocations).toBe(1001);
      expect(result.outcomeDistribution).toContainEqual({ status: 'completed', count: 1001 });
    });

    it('applies the same time range to attributions and their provider attempts', () => {
      seedProviderAttempt({
        attemptId: 'old-provider', sessionId: 'sess-1', chainId: 'old-chain', turnId: 'old-turn',
        outcome: 'succeeded', usage: { inputTokens: 10, outputTokens: 5 }, cost: calculatedCost('1'),
      });
      seedSubagentAttribution({
        subagentId: 'old-subagent', sessionId: 'sess-1', chainId: 'old-chain', agentName: 'researcher',
        agentType: 'worker', agentTier: 'sprout', modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });
      clockMs = new Date('2026-07-15T10:00:00.000Z').getTime();
      seedProviderAttempt({
        attemptId: 'new-provider', sessionId: 'sess-1', chainId: 'new-chain', turnId: 'new-turn',
        outcome: 'succeeded', usage: { inputTokens: 20, outputTokens: 10 }, cost: calculatedCost('2'),
      });
      seedSubagentAttribution({
        subagentId: 'new-subagent', sessionId: 'sess-1', chainId: 'new-chain', agentName: 'researcher',
        agentType: 'worker', agentTier: 'sprout', modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });

      const result = getSubagents({
        startDate: '2026-07-15T00:00:00.000Z',
        endDate: '2026-07-15T23:59:59.999Z',
      });

      expect(result.summaries).toHaveLength(1);
      expect(result.summaries[0].invocations).toBe(1);
      expect(result.summaries[0].inputTokens).toBe(20);
      expect(result.summaries[0].totalCost).toEqual([{ currency: 'USD', amount: '2', recordCount: 1 }]);
    });

    it('returns invocations over time grouped by day, ordered ascending, respecting the time range', () => {
      seedSubagentAttribution({
        subagentId: 'sub-a', sessionId: 'sess-1', chainId: 'chain-a',
        agentName: 'researcher', agentType: 'worker', agentTier: 'sprout',
        modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID, status: 'completed',
      });
      seedSubagentAttribution({
        subagentId: 'sub-b', sessionId: 'sess-1', chainId: 'chain-b',
        agentName: 'coder', agentType: 'worker', agentTier: 'bloom',
        modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID, status: 'completed',
      });
      clockMs = new Date('2026-07-15T10:00:00.000Z').getTime();
      seedSubagentAttribution({
        subagentId: 'sub-c', sessionId: 'sess-1', chainId: 'chain-c',
        agentName: 'researcher', agentType: 'worker', agentTier: 'sprout',
        modelId: 'claude-test', connectionId: ANTHROPIC_CONNECTION_ID, status: 'failed',
      });

      const result = getSubagents();
      expect(result.invocationsOverTime).toEqual([
        { date: '2026-07-12', count: 2 },
        { date: '2026-07-15', count: 1 },
      ]);

      const ranged = getSubagents({
        startDate: '2026-07-15T00:00:00.000Z',
        endDate: '2026-07-15T23:59:59.999Z',
      });
      expect(ranged.invocationsOverTime).toEqual([{ date: '2026-07-15', count: 1 }]);
    });
  });

  // ── getContext ──────────────────────────────────────────────────────────────

  describe('getContext', () => {
    it('returns top session series, totals, and average breakdown', () => {
      // providerAttemptId is null because there is no matching provider_attempts
      // row in this test (FK constraint: context_snapshots.provider_attempt_id
      // REFERENCES provider_attempts(attempt_id)).
      snapshotStore.insert({
        sessionId: 'sess-1', chainId: null, turnId: 'turn-1', providerAttemptId: null,
        inputTokens: 1000, outputTokens: 500, usedTokens: 1500,
        systemTokens: 200, toolsTokens: 100, toolUseTokens: 50,
        userTokens: 600, assistantTokens: 400,
      });
      snapshotStore.insert({
        sessionId: 'sess-1', chainId: null, turnId: 'turn-2', providerAttemptId: null,
        inputTokens: 2000, outputTokens: 1000, usedTokens: 3000,
        systemTokens: 400, toolsTokens: 200, toolUseTokens: 100,
        userTokens: 1200, assistantTokens: 800,
      });

      const result = getContext();
      expect(result.totalSnapshots).toBe(2);
      expect(result.totalSessionCount).toBe(1);
      expect(result.topSessions).toHaveLength(1);
      expect(result.topSubagents).toHaveLength(0);
      expect(result.totalSubagentCount).toBe(0);

      const series = result.topSessions[0];
      expect(series.sessionId).toBe('sess-1');
      expect(series.sessionName).toBeNull();
      expect(series.maxUsedTokens).toBe(3000);
      expect(series.points.map((p) => p.usedTokens)).toEqual([1500, 3000]);
      expect(series.points[0].capturedAt.localeCompare(series.points[1].capturedAt)).toBeLessThan(0);

      // Average breakdown
      expect(result.avgBreakdown.usedTokens).toBe(2250); // (1500 + 3000) / 2
      expect(result.avgBreakdown.systemTokens).toBe(300); // (200 + 400) / 2
      expect(result.avgBreakdown.toolsTokens).toBe(150); // (100 + 200) / 2
      expect(result.avgBreakdown.toolUseTokens).toBe(75); // (50 + 100) / 2
      expect(result.avgBreakdown.userTokens).toBe(900); // (600 + 1200) / 2
      expect(result.avgBreakdown.assistantTokens).toBe(600); // (400 + 800) / 2

      // Filtered by session
      const filtered = getContext('sess-1');
      expect(filtered.totalSnapshots).toBe(2);
      expect(filtered.topSessions).toHaveLength(1);
      expect(filtered.topSessions[0].sessionId).toBe('sess-1');
      expect(filtered.avgBreakdown.systemTokens).toBe(300);

      // Nonexistent session
      const empty = getContext('nonexistent');
      expect(empty.totalSnapshots).toBe(0);
      expect(empty.topSessions).toHaveLength(0);
      expect(empty.avgBreakdown.systemTokens).toBe(0);
      expect(empty.avgBreakdown.toolsTokens).toBe(0);
    });

    it('selects the top 5 sessions by max used tokens, ordered descending', () => {
      for (let i = 0; i < 6; i++) {
        snapshotStore.insert({
          sessionId: `sess-${i}`, chainId: null, turnId: 'turn-1', providerAttemptId: null,
          inputTokens: 0, outputTokens: 0, usedTokens: (i + 1) * 1000,
          systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
        });
      }

      const result = getContext();
      expect(result.totalSnapshots).toBe(6);
      expect(result.totalSessionCount).toBe(6);
      expect(result.topSessions).toHaveLength(5);
      expect(result.topSessions.map((s) => s.sessionId)).toEqual([
        'sess-5', 'sess-4', 'sess-3', 'sess-2', 'sess-1',
      ]);
      expect(result.topSessions.map((s) => s.maxUsedTokens)).toEqual([6000, 5000, 4000, 3000, 2000]);
    });

    it('computes averages across all rows and downsamples series beyond 500 points by stride, keeping the newest and peak points', () => {
      for (let i = 0; i < 1001; i++) {
        snapshotStore.insert({
          sessionId: 'sess-1', chainId: null, turnId: `turn-${i}`, providerAttemptId: null,
          inputTokens: i, outputTokens: 0, usedTokens: i,
          systemTokens: i, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
        });
      }

      const result = getContext();
      expect(result.totalSnapshots).toBe(1001);
      expect(result.totalSessionCount).toBe(1);
      expect(result.avgBreakdown.systemTokens).toBe(500);

      const series = result.topSessions[0];
      expect(series.maxUsedTokens).toBe(1000);
      const stride = Math.ceil(1001 / 500);
      const strideLength = Math.ceil(1001 / stride);
      expect(series.points.length).toBeLessThanOrEqual(502);
      expect(series.points).toHaveLength(strideLength + 1);
      expect(series.points.map((p) => p.usedTokens)).toEqual([
        ...Array.from({ length: strideLength }, (_, i) => i * stride),
        1000,
      ]);
      expect(series.points[series.points.length - 1].usedTokens).toBe(series.maxUsedTokens);
    });

    it('applies the time range to totals, top sessions, and series points', () => {
      snapshotStore.insert({
        sessionId: 'sess-1', chainId: null, turnId: 'turn-old', providerAttemptId: null,
        inputTokens: 0, outputTokens: 0, usedTokens: 100,
        systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
      });
      clockMs = new Date('2026-07-15T10:00:00.000Z').getTime();
      snapshotStore.insert({
        sessionId: 'sess-1', chainId: null, turnId: 'turn-new', providerAttemptId: null,
        inputTokens: 0, outputTokens: 0, usedTokens: 500,
        systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
      });
      snapshotStore.insert({
        sessionId: 'sess-2', chainId: null, turnId: 'turn-new', providerAttemptId: null,
        inputTokens: 0, outputTokens: 0, usedTokens: 900,
        systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
      });

      const result = getContext(undefined, {
        startDate: '2026-07-15T00:00:00.000Z',
        endDate: '2026-07-15T23:59:59.999Z',
      });
      expect(result.totalSnapshots).toBe(2);
      expect(result.totalSessionCount).toBe(2);
      expect(result.topSessions.map((s) => s.sessionId)).toEqual(['sess-2', 'sess-1']);
      expect(result.topSessions.map((s) => s.maxUsedTokens)).toEqual([900, 500]);
      for (const series of result.topSessions) {
        expect(series.points).toHaveLength(1);
        for (const point of series.points) {
          expect(point.capturedAt >= '2026-07-15T00:00:00.000Z').toBe(true);
          expect(point.capturedAt <= '2026-07-15T23:59:59.999Z').toBe(true);
        }
      }
    });

    it('splits main-agent and subagent snapshots into separate series', () => {
      seedSubagentAttribution({
        subagentId: 'sub-a',
        sessionId: 'sess-1',
        chainId: 'chain-sub-a',
        agentName: 'explorer',
        agentType: 'explorer',
        agentTier: 'sprout',
        modelId: 'claude-test',
        connectionId: ANTHROPIC_CONNECTION_ID,
        status: 'completed',
      });

      snapshotStore.insert({
        sessionId: 'sess-1', chainId: null, turnId: 'turn-main-1', providerAttemptId: null,
        inputTokens: 0, outputTokens: 0, usedTokens: 5000,
        systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
      });
      snapshotStore.insert({
        sessionId: 'sess-1', chainId: 'chain-sub-a', turnId: 'turn-sub-1', providerAttemptId: null,
        agentScope: 'sub-a',
        inputTokens: 0, outputTokens: 0, usedTokens: 800,
        systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
      });
      snapshotStore.insert({
        sessionId: 'sess-1', chainId: 'chain-sub-a', turnId: 'turn-sub-2', providerAttemptId: null,
        agentScope: 'sub-a',
        inputTokens: 0, outputTokens: 0, usedTokens: 1200,
        systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
      });

      const result = getContext();
      expect(result.totalSnapshots).toBe(3);
      expect(result.totalSessionCount).toBe(1);
      expect(result.totalSubagentCount).toBe(1);

      // Main-agent series excludes the subagent snapshots.
      expect(result.topSessions).toHaveLength(1);
      expect(result.topSessions[0].points.map((p) => p.usedTokens)).toEqual([5000]);

      // Subagent series is keyed by agent scope with attribution metadata.
      expect(result.topSubagents).toHaveLength(1);
      const sub = result.topSubagents[0];
      expect(sub.subagentId).toBe('sub-a');
      expect(sub.agentName).toBe('explorer');
      expect(sub.agentTier).toBe('sprout');
      expect(sub.maxUsedTokens).toBe(1200);
      expect(sub.points.map((p) => p.usedTokens)).toEqual([800, 1200]);

      // Session filter still scopes both series.
      const filtered = getContext('sess-1');
      expect(filtered.topSessions).toHaveLength(1);
      expect(filtered.topSubagents).toHaveLength(1);
    });

    it('selects the top 5 subagents by max used tokens, ordered descending', () => {
      for (let i = 0; i < 6; i++) {
        snapshotStore.insert({
          sessionId: 'sess-1', chainId: null, turnId: 'turn-1', providerAttemptId: null,
          agentScope: `sub-${i}`,
          inputTokens: 0, outputTokens: 0, usedTokens: (i + 1) * 100,
          systemTokens: 0, toolsTokens: 0, toolUseTokens: 0, userTokens: 0, assistantTokens: 0,
        });
      }

      const result = getContext();
      expect(result.totalSubagentCount).toBe(6);
      expect(result.topSubagents).toHaveLength(5);
      expect(result.topSubagents.map((s) => s.subagentId)).toEqual([
        'sub-5', 'sub-4', 'sub-3', 'sub-2', 'sub-1',
      ]);
      expect(result.topSubagents.map((s) => s.maxUsedTokens)).toEqual([600, 500, 400, 300, 200]);
      // Subagent scopes are not sessions: no main-agent series exist.
      expect(result.topSessions).toHaveLength(0);
      // Attribution lookup misses degrade to null names.
      expect(result.topSubagents[0].agentName).toBeNull();
      expect(result.topSubagents[0].agentTier).toBeNull();
    });
  });
});
