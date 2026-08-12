import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
import { applyAccountingSchemaMigrations } from '../../src/main/providers/accounting/schema';
import { getContext } from '../../src/main/providers/accounting/analytics-queries';
import {
  runContextQuery,
  disposeAnalyticsWorkerPool,
} from '../../src/main/providers/accounting/analytics-query-runner';
import { _clearDbCache } from '../../src/main/session/storage';

let tempDir: string;
let dbPath: string;
let providerStore: ProviderAccountingStore;
let snapshotStore: ContextSnapshotStore;

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
});

afterEach(() => {
  resetProviderAccountingStore();
  resetContextSnapshotStore();
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
});
