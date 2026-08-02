import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentAttributionStore } from '../../src/main/providers/accounting/subagent-attribution-store';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function makeStore(now?: () => Date): SubagentAttributionStore {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-subagent-attribution-'));
  return new SubagentAttributionStore({ dbPath: path.join(tempDir, 'accounting.db'), now });
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

const BASE_ATTRIBUTION = {
  sessionId: 'session-1',
  chainId: 'chain-1',
  parentChainId: 'parent-chain-1',
  agentName: 'researcher',
  agentType: 'subagent',
  agentTier: 'bloom',
  modelId: 'claude-sonnet-4',
  connectionId: 'conn-123',
};

describe('SubagentAttributionStore', () => {
  it('inserts a running attribution and finalizes it as completed', () => {
    const store = makeStore();
    const id = store.insert({ ...BASE_ATTRIBUTION, attributionId: 'attr-1', subagentId: 'sub-1' });
    expect(id).toBe('attr-1');

    const ok = store.finalize('sub-1', { status: 'completed' });
    expect(ok).toBe(true);

    const rows = store.listBySession('session-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attributionId: 'attr-1',
      subagentId: 'sub-1',
      status: 'completed',
      completedAt: expect.any(String),
    });
  });

  it('returns false when finalizing an already-finalized row (idempotency guard)', () => {
    const store = makeStore();
    store.insert({ ...BASE_ATTRIBUTION, subagentId: 'sub-1' });

    const first = store.finalize('sub-1', { status: 'completed' });
    expect(first).toBe(true);

    const second = store.finalize('sub-1', { status: 'failed' });
    expect(second).toBe(false);

    // The first status is preserved — the second finalize is a no-op.
    expect(store.listAll()[0].status).toBe('completed');
  });

  it('marks running rows as interrupted with completed_at via recoverPending', () => {
    const store = makeStore();
    store.insert({ ...BASE_ATTRIBUTION, subagentId: 'sub-1' });
    store.insert({ ...BASE_ATTRIBUTION, subagentId: 'sub-2' });

    const count = store.recoverPending();
    expect(count).toBe(2);

    const rows = store.listAll();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('interrupted');
      expect(row.completedAt).not.toBeNull();
    }
  });

  it('returns only rows for the requested session ordered by started_at ASC via listBySession', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    store.insert({ ...BASE_ATTRIBUTION, attributionId: 'a-1', subagentId: 's-1', sessionId: 'session-a' });
    store.insert({ ...BASE_ATTRIBUTION, attributionId: 'a-2', subagentId: 's-2', sessionId: 'session-b' });
    store.insert({ ...BASE_ATTRIBUTION, attributionId: 'a-3', subagentId: 's-3', sessionId: 'session-a' });

    const aRows = store.listBySession('session-a');
    expect(aRows).toHaveLength(2);
    // ASC: earliest first.
    expect(aRows.map((r) => r.attributionId)).toEqual(['a-1', 'a-3']);

    const bRows = store.listBySession('session-b');
    expect(bRows).toHaveLength(1);
    expect(bRows[0].attributionId).toBe('a-2');
  });

  it('returns all rows ordered by started_at DESC with a limit via listAll', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    for (let i = 1; i <= 5; i++) {
      store.insert({ ...BASE_ATTRIBUTION, attributionId: `a-${i}`, subagentId: `s-${i}` });
    }

    const all = store.listAll();
    expect(all).toHaveLength(5);
    // DESC: most recent first.
    expect(all.map((r) => r.attributionId)).toEqual(['a-5', 'a-4', 'a-3', 'a-2', 'a-1']);

    const limited = store.listAll(2);
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.attributionId)).toEqual(['a-5', 'a-4']);
  });

  it('returns only rows for the requested agent name via getByAgentName', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    store.insert({ ...BASE_ATTRIBUTION, attributionId: 'a-1', subagentId: 's-1', agentName: 'researcher' });
    store.insert({ ...BASE_ATTRIBUTION, attributionId: 'a-2', subagentId: 's-2', agentName: 'coder' });
    store.insert({ ...BASE_ATTRIBUTION, attributionId: 'a-3', subagentId: 's-3', agentName: 'researcher' });

    const researcherRows = store.getByAgentName('researcher');
    expect(researcherRows).toHaveLength(2);
    // DESC: most recent first.
    expect(researcherRows.map((r) => r.attributionId)).toEqual(['a-3', 'a-1']);

    const coderRows = store.getByAgentName('coder');
    expect(coderRows).toHaveLength(1);
    expect(coderRows[0].attributionId).toBe('a-2');
  });

  it('persists all attribution fields correctly', () => {
    const store = makeStore();
    store.insert({
      attributionId: 'attr-1',
      subagentId: 'sub-1',
      sessionId: 'session-1',
      chainId: 'chain-1',
      parentChainId: 'parent-chain-1',
      agentName: 'researcher',
      agentType: 'subagent',
      agentTier: 'bloom',
      modelId: 'claude-sonnet-4',
      connectionId: 'conn-123',
    });

    const row = store.listAll()[0];
    expect(row).toMatchObject({
      attributionId: 'attr-1',
      subagentId: 'sub-1',
      sessionId: 'session-1',
      chainId: 'chain-1',
      parentChainId: 'parent-chain-1',
      agentName: 'researcher',
      agentType: 'subagent',
      agentTier: 'bloom',
      modelId: 'claude-sonnet-4',
      connectionId: 'conn-123',
    });
  });
});
