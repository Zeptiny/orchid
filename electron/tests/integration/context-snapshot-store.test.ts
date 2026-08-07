import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextSnapshotStore } from '../../src/main/providers/accounting/context-snapshot-store';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function makeStore(now?: () => Date): ContextSnapshotStore {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-context-snapshot-'));
  return new ContextSnapshotStore({ dbPath: path.join(tempDir, 'accounting.db'), now });
}

/** Deterministic clock that advances 1 s on every call so timestamps are unique. */
function makeClock(): () => Date {
  let t = new Date('2026-01-01T00:00:00.000Z').getTime();
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

const BASE_SNAPSHOT = {
  sessionId: 'session-1',
  chainId: 'chain-1',
  turnId: 'turn-1',
  providerAttemptId: null,
  inputTokens: 100,
  outputTokens: 50,
  usedTokens: 150,
  systemTokens: 30,
  toolsTokens: 20,
  toolUseTokens: 10,
  userTokens: 40,
  assistantTokens: 50,
};

describe('ContextSnapshotStore', () => {
  it('inserts a context snapshot and returns a UUID', () => {
    const store = makeStore();
    const id = store.insert({ ...BASE_SNAPSHOT });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('returns only rows for the requested session ordered by captured_at ASC via listBySession', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    store.insert({ ...BASE_SNAPSHOT, snapshotId: 'snap-1', sessionId: 'session-a' });
    store.insert({ ...BASE_SNAPSHOT, snapshotId: 'snap-2', sessionId: 'session-b' });
    store.insert({ ...BASE_SNAPSHOT, snapshotId: 'snap-3', sessionId: 'session-a' });

    const aRows = store.listBySession('session-a');
    expect(aRows).toHaveLength(2);
    // ASC: earliest first.
    expect(aRows.map((r) => r.snapshotId)).toEqual(['snap-1', 'snap-3']);

    const bRows = store.listBySession('session-b');
    expect(bRows).toHaveLength(1);
    expect(bRows[0].snapshotId).toBe('snap-2');
  });

  it('returns all rows ordered by captured_at ASC with a limit via listAll', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    for (let i = 1; i <= 5; i++) {
      store.insert({ ...BASE_SNAPSHOT, snapshotId: `snap-${i}` });
    }

    const all = store.listAll();
    expect(all).toHaveLength(5);
    // ASC: earliest first.
    expect(all.map((r) => r.snapshotId)).toEqual(['snap-1', 'snap-2', 'snap-3', 'snap-4', 'snap-5']);

    const limited = store.listAll(2);
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.snapshotId)).toEqual(['snap-1', 'snap-2']);
  });

  it('uses an explicitly provided snapshotId', () => {
    const store = makeStore();
    const id = store.insert({ ...BASE_SNAPSHOT, snapshotId: 'my-custom-id' });
    expect(id).toBe('my-custom-id');
    expect(store.listAll()[0].snapshotId).toBe('my-custom-id');
  });

  it('persists all token fields correctly', () => {
    const store = makeStore();
    store.insert({
      ...BASE_SNAPSHOT,
      snapshotId: 'snap-1',
      inputTokens: 1000,
      outputTokens: 2000,
      usedTokens: 3000,
      systemTokens: 500,
      toolsTokens: 750,
      toolUseTokens: 250,
      userTokens: 100,
      assistantTokens: 200,
    });

    const row = store.listAll()[0];
    expect(row).toMatchObject({
      inputTokens: 1000,
      outputTokens: 2000,
      usedTokens: 3000,
      systemTokens: 500,
      toolsTokens: 750,
      toolUseTokens: 250,
      userTokens: 100,
      assistantTokens: 200,
    });
  });

  it('returns an empty array when no snapshots exist for the session', () => {
    const store = makeStore();
    expect(store.listBySession('nonexistent-session')).toEqual([]);
  });

  it('persists agentScope for subagent snapshots and defaults to null for the main agent', () => {
    const store = makeStore();
    store.insert({ ...BASE_SNAPSHOT, snapshotId: 'snap-main' });
    store.insert({ ...BASE_SNAPSHOT, snapshotId: 'snap-sub', agentScope: 'sub-123' });

    const rows = store.listAll();
    expect(rows.find((r) => r.snapshotId === 'snap-main')?.agentScope).toBeNull();
    expect(rows.find((r) => r.snapshotId === 'snap-sub')?.agentScope).toBe('sub-123');
  });

  it('migrates a legacy context_snapshots table missing the agent_scope column', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-context-snapshot-'));
    const legacyDbPath = path.join(tempDir, 'accounting.db');
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE context_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chain_id TEXT,
        turn_id TEXT,
        provider_attempt_id TEXT,
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
    `);
    legacyDb.close();

    const store = new ContextSnapshotStore({ dbPath: legacyDbPath });
    store.insert({ ...BASE_SNAPSHOT, snapshotId: 'snap-legacy', agentScope: 'sub-legacy' });
    expect(store.listAll()[0].agentScope).toBe('sub-legacy');
  });
});
