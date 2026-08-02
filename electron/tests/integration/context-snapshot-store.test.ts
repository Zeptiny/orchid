import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
});
