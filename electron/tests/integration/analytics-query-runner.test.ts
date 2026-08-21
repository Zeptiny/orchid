import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { FrozenProviderRequestSnapshot } from '../../src/shared/types/accounting';
import {
  initializeProviderAccountingStore,
  resetProviderAccountingStore,
  type ProviderAccountingStore,
} from '../../src/main/providers/accounting/store';
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
import { applyAccountingSchemaMigrations } from '../../src/main/providers/accounting/schema';
import {
  getContext,
  getContextSessionDetail,
  getContextSessionList,
  getModelDetail,
  getOverview,
  getSubagentDetail,
} from '../../src/main/providers/accounting/analytics-queries';
import {
  runAnalyticsQuery,
  runContextQuery,
  disposeAnalyticsWorkerPool,
} from '../../src/main/providers/accounting/analytics-query-runner';
import type { ContextSessionsResult } from '../../src/shared/types/analytics';
import { _clearDbCache } from '../../src/main/session/storage';

// Controllable live-session-name source for live-wins assertions. While empty
// every lookup falls through to the real sessions.db, so all other tests keep
// production behavior.
const { liveSessionNames } = vi.hoisted(() => ({ liveSessionNames: new Map<string, string>() }));

vi.mock('../../src/main/session/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/session/storage')>();
  return {
    ...actual,
    getSessionNames: (ids: readonly string[]) => (
      liveSessionNames.size > 0
        ? new Map(ids.flatMap((id) => (liveSessionNames.has(id) ? [[id, liveSessionNames.get(id)!] as const] : [])))
        : actual.getSessionNames(ids)
    ),
  };
});

let tempDir: string;
let dbPath: string;
let providerStore: ProviderAccountingStore;
let snapshotStore: ContextSnapshotStore;
let attributionStore: SubagentAttributionStore;

function indexNames(db: Database.Database, table: string): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
  ).all(table) as Array<{ name: string }>).map((row) => row.name);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-analytics-runner-'));
  dbPath = path.join(tempDir, 'accounting.db');
  providerStore = initializeProviderAccountingStore({ dbPath });
  snapshotStore = initializeContextSnapshotStore({ dbPath });
  attributionStore = initializeSubagentAttributionStore({ dbPath });
  liveSessionNames.clear();
});

afterEach(() => {
  resetProviderAccountingStore();
  resetContextSnapshotStore();
  resetSubagentAttributionStore();
  disposeAnalyticsWorkerPool();
  _clearDbCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('analytics context covering indexes', () => {
  it('creates the covering indexes and drops the narrow agent_scope index', () => {
    const db = providerStore.getDatabase();
    const names = indexNames(db, 'context_snapshots');
    expect(names).toContain('idx_context_snapshots_scope_session_tokens');
    expect(names).toContain('idx_context_snapshots_agent_scope_tokens');
    expect(names).not.toContain('idx_context_snapshots_agent_scope');
  });

  it('upgrades a legacy schema (agent_scope column + narrow index) to the covering indexes', () => {
    const legacyPath = path.join(tempDir, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE context_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chain_id TEXT,
        turn_id TEXT,
        provider_attempt_id TEXT,
        agent_scope TEXT,
        captured_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        system_tokens INTEGER NOT NULL DEFAULT 0,
        tools_tokens INTEGER NOT NULL DEFAULT 0,
        tool_use_tokens INTEGER NOT NULL DEFAULT 0,
        user_tokens INTEGER NOT NULL DEFAULT 0,
        assistant_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_context_snapshots_agent_scope ON context_snapshots(agent_scope, captured_at);
    `);
    legacy.close();

    const db = new Database(legacyPath);
    applyAccountingSchemaMigrations(db);
    const names = indexNames(db, 'context_snapshots');
    expect(names).toContain('idx_context_snapshots_scope_session_tokens');
    expect(names).toContain('idx_context_snapshots_agent_scope_tokens');
    expect(names).not.toContain('idx_context_snapshots_agent_scope');
    db.close();
  });
});

describe('getContext with injected query context (worker path)', () => {
  it('runs against an injected connection with a no-op name resolver', () => {
    snapshotStore.insert({
      sessionId: 'sess-1', chainId: null, turnId: 'turn-1', providerAttemptId: null,
      inputTokens: 1000, outputTokens: 500, usedTokens: 1500,
      systemTokens: 200, toolsTokens: 100, toolUseTokens: 50,
      userTokens: 600, assistantTokens: 400,
    });

    const result = getContext(undefined, undefined, {
      db: providerStore.getDatabase(),
      resolveSessionNames: () => new Map(),
    });
    expect(result.totalSnapshots).toBe(1);
    expect(result.topSessions).toHaveLength(1);
    expect(result.topSessions[0].sessionName).toBeNull();
    expect(result.topSessions[0].maxUsedTokens).toBe(1500);
    expect(result.avgBreakdown.usedTokens).toBe(1500);
  });
});

describe('runContextQuery', () => {
  it('falls back to inline execution and matches getContext results', async () => {
    snapshotStore.insert({
      sessionId: 'sess-1', chainId: null, turnId: 'turn-1', providerAttemptId: null,
      inputTokens: 1000, outputTokens: 500, usedTokens: 1500,
      systemTokens: 200, toolsTokens: 100, toolUseTokens: 50,
      userTokens: 600, assistantTokens: 400,
    });

    const [workerResult, direct] = await Promise.all([
      runContextQuery(),
      Promise.resolve(getContext()),
    ]);
    expect(workerResult.totalSnapshots).toBe(direct.totalSnapshots);
    expect(workerResult.topSessions.map((s) => s.sessionId)).toEqual(direct.topSessions.map((s) => s.sessionId));
    expect(workerResult.topSessions[0].maxUsedTokens).toBe(1500);
    expect(workerResult.avgBreakdown).toEqual(direct.avgBreakdown);
  });

  it('resolves deleted-session names from accounting tombstones (worker or inline path)', async () => {
    snapshotStore.insert({
      sessionId: 'sess-deleted', chainId: null, turnId: 'turn-1', providerAttemptId: null,
      inputTokens: 1000, outputTokens: 500, usedTokens: 1500,
      systemTokens: 200, toolsTokens: 100, toolUseTokens: 50,
      userTokens: 600, assistantTokens: 400,
    });
    providerStore.upsertSessionNameTombstone('sess-deleted', 'Old Name');

    const result = await runContextQuery();
    expect(result.topSessions).toHaveLength(1);
    expect(result.topSessions[0].sessionId).toBe('sess-deleted');
    expect(result.topSessions[0].sessionName).toBe('Old Name');
  });
});

// ── runAnalyticsQuery — detail kinds ─────────────────────────────────────────
// The worker script does not exist under vitest, so these exercise the inline
// fallback path and assert it is indistinguishable from the direct query call
// (the same parity contract the worker path must uphold).

const MODEL_TRIPLE = {
  modelId: 'claude-test',
  providerId: 'anthropic',
  connectionId: '11111111-1111-4111-8111-111111111111',
};

const SUBAGENT_TRIPLE = { agentName: 'agent-x', agentType: 'task', agentTier: 'sub' };

function seedSnapshotFactory(): FrozenProviderRequestSnapshot {
  return {
    providerId: MODEL_TRIPLE.providerId,
    providerDisplayName: 'Anthropic',
    connectionId: MODEL_TRIPLE.connectionId,
    connectionName: 'Work',
    modelId: MODEL_TRIPLE.modelId,
    modelDisplayName: 'Claude Test',
    protocol: 'anthropic-messages',
    modelSource: 'catalog',
    catalogVersion: 1,
    catalogSource: 'bundled',
    catalogObservedAt: '2026-07-12T00:00:00.000Z',
    fieldProvenance: {},
    statusObservation: null,
    pricing: null,
  };
}

function seedProviderAttempt(opts: {
  attemptId: string;
  sessionId: string;
  chainId: string | null;
  agentName?: string | null;
  agentTier?: string | null;
  agentScope?: string | null;
  /** Stamp a first token between started_at and completed_at (streamed attempt). */
  firstToken?: boolean;
}): void {
  providerStore.insertPending({
    attemptId: opts.attemptId,
    sessionId: opts.sessionId,
    chainId: opts.chainId,
    turnId: null,
    sdkCallId: `sdk-${opts.attemptId}`,
    snapshot: seedSnapshotFactory(),
    agentScope: opts.agentScope ?? null,
    agentName: opts.agentName ?? null,
    agentTier: opts.agentTier ?? null,
    agentType: null,
  });
  if (opts.firstToken) providerStore.markFirstToken(opts.attemptId);
  providerStore.finalize(opts.attemptId, {
    outcome: 'succeeded',
    usage: { inputTokens: 100, outputTokens: 50 },
    providerEvidence: {},
    cost: { state: 'calculated', source: 'token-formula', currency: 'USD', amount: '1' },
  });
}

/** Attempts + subagent attribution + context snapshots for the parity fixture. */
function seedDetailFixture(): void {
  // att-1 streams (first token between started_at and completed_at) so the
  // TTFT, TPS, histogram, and time-series latency projections are exercised.
  seedProviderAttempt({ attemptId: 'att-1', sessionId: 'sess-a', chainId: 'chain-1', agentName: 'agent-x', agentTier: 'sub', agentScope: 'sub-1', firstToken: true });
  seedProviderAttempt({ attemptId: 'att-2', sessionId: 'sess-a', chainId: null });
  seedProviderAttempt({ attemptId: 'att-3', sessionId: 'sess-deleted', chainId: null });
  attributionStore.insert({
    subagentId: 'sub-1',
    sessionId: 'sess-a',
    chainId: 'chain-1',
    parentChainId: null,
    agentName: SUBAGENT_TRIPLE.agentName,
    agentType: SUBAGENT_TRIPLE.agentType,
    agentTier: SUBAGENT_TRIPLE.agentTier,
    modelId: MODEL_TRIPLE.modelId,
    connectionId: MODEL_TRIPLE.connectionId,
  });
  attributionStore.finalize('sub-1', { status: 'completed' });
  for (const [i, used] of [1000, 2000, 3000].entries()) {
    snapshotStore.insert({
      sessionId: 'sess-a', chainId: null, turnId: `turn-${i}`, providerAttemptId: null,
      inputTokens: 500, outputTokens: used - 500, usedTokens: used,
      systemTokens: 200, toolsTokens: 100, toolUseTokens: 50,
      userTokens: 400, assistantTokens: 250,
    });
  }
  snapshotStore.insert({
    sessionId: 'sess-deleted', chainId: null, turnId: 'turn-x', providerAttemptId: null,
    inputTokens: 1000, outputTokens: 500, usedTokens: 1500,
    systemTokens: 200, toolsTokens: 100, toolUseTokens: 50,
    userTokens: 600, assistantTokens: 400,
  });
}

describe('runAnalyticsQuery (detail kinds)', () => {
  it('returns results equal to the direct query call for every detail kind', async () => {
    seedDetailFixture();
    const timeRange = { startDate: '2000-01-01T00:00:00.000Z', endDate: '2100-01-01T00:00:00.000Z' };

    expect(await runAnalyticsQuery('overview', { timeRange }))
      .toEqual(getOverview(timeRange));
    expect(await runAnalyticsQuery('model_detail', { modelDetail: MODEL_TRIPLE, timeRange }))
      .toEqual(getModelDetail({ ...MODEL_TRIPLE, timeRange }));
    expect(await runAnalyticsQuery('subagent_detail', { subagentDetail: SUBAGENT_TRIPLE, timeRange }))
      .toEqual(getSubagentDetail({ ...SUBAGENT_TRIPLE, timeRange }));
    expect(await runAnalyticsQuery('context_session_detail', { sessionId: 'sess-a', timeRange }))
      .toEqual(getContextSessionDetail({ sessionId: 'sess-a', timeRange }));
    expect(await runAnalyticsQuery('context_sessions', { timeRange }))
      .toEqual(getContextSessionList(timeRange));
  });

  it('serves the session picker from the dedicated context_sessions query', async () => {
    seedDetailFixture();

    const result = (await runAnalyticsQuery('context_sessions')) as ContextSessionsResult;
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(['sess-a', 'sess-deleted']);
    expect(result.sessions[0].snapshotCount).toBe(3);
    expect(result.sessions[0].maxUsedTokens).toBe(3000);
    expect(result.sessions[1].snapshotCount).toBe(1);
    expect(result.sessions[1].maxUsedTokens).toBe(1500);
  });

  it('resolves deleted-session names from accounting tombstones (context_sessions)', async () => {
    seedDetailFixture();
    providerStore.upsertSessionNameTombstone('sess-deleted', 'Old Name');

    const result = (await runAnalyticsQuery('context_sessions')) as ContextSessionsResult;
    const deleted = result.sessions.find((entry) => entry.sessionId === 'sess-deleted');
    expect(deleted?.sessionName).toBe('Old Name');
  });

  it('prefers live sessions.db names over tombstones (live-wins)', async () => {
    liveSessionNames.set('sess-a', 'Fresh Name');
    try {
      seedDetailFixture();
      providerStore.upsertSessionNameTombstone('sess-a', 'Stale Tombstone');

      const [viaRunner, direct] = await Promise.all([
        runAnalyticsQuery('context_sessions'),
        Promise.resolve(getContextSessionList()),
      ]);
      const runnerEntry = (viaRunner as ContextSessionsResult).sessions.find((entry) => entry.sessionId === 'sess-a');
      const directEntry = direct.sessions.find((entry) => entry.sessionId === 'sess-a');
      expect(runnerEntry?.sessionName).toBe('Fresh Name');
      expect(directEntry?.sessionName).toBe('Fresh Name');
    } finally {
      liveSessionNames.clear();
    }
  });
});
