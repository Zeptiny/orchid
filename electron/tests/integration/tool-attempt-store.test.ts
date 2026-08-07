import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolAttemptStore } from '../../src/main/providers/accounting/tool-attempt-store';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function makeStore(now?: () => Date): ToolAttemptStore {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-tool-attempt-'));
  return new ToolAttemptStore({ dbPath: path.join(tempDir, 'accounting.db'), now });
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

const BASE_PENDING = {
  sessionId: 'session-1',
  chainId: 'chain-1',
  turnId: 'turn-1',
  providerAttemptId: null,
  toolName: 'read',
  toolSource: 'builtin' as const,
  mcpServerName: null as string | null,
  toolFamily: 'filesystem',
  timeoutSeconds: 30,
  agentScope: 'main',
};

describe('ToolAttemptStore', () => {
  it('inserts a pending tool attempt and finalizes it with outcome=complete', () => {
    const store = makeStore();
    const id = store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-1', toolCallId: 'call-001' });
    expect(id).toBe('ta-1');

    const ok = store.finalize('ta-1', {
      outcome: 'complete',
      resultSizeBytes: 1024,
      offloaded: true,
      timedOut: false,
    });
    expect(ok).toBe(true);

    const rows = store.listBySession('session-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolAttemptId: 'ta-1',
      outcome: 'complete',
      completedAt: expect.any(String),
      resultSizeBytes: 1024,
      offloaded: true,
      timedOut: false,
    });
  });

  it('returns false when finalizing an already-finalized row (idempotency guard)', () => {
    const store = makeStore();
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-1', toolCallId: 'call-001' });

    const first = store.finalize('ta-1', {
      outcome: 'complete', resultSizeBytes: 0, offloaded: false, timedOut: false,
    });
    expect(first).toBe(true);

    const second = store.finalize('ta-1', {
      outcome: 'error', resultSizeBytes: 0, offloaded: false, timedOut: false,
    });
    expect(second).toBe(false);

    // The first outcome is preserved — the second finalize is a no-op.
    expect(store.listBySession('session-1')[0].outcome).toBe('complete');
  });

  it('marks pending rows as cancelled with an explanatory error via recoverPending', () => {
    const store = makeStore();
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-1', toolCallId: 'call-001' });
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-2', toolCallId: 'call-002' });

    const count = store.recoverPending();
    expect(count).toBe(2);

    const rows = store.listAll();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.outcome).toBe('cancelled');
      expect(row.error).toBe('Application exited before tool attempt completed');
      expect(row.completedAt).not.toBeNull();
    }
  });

  it('returns only rows for the requested session via listBySession', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-1', toolCallId: 'c1', sessionId: 'session-a' });
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-2', toolCallId: 'c2', sessionId: 'session-b' });
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-3', toolCallId: 'c3', sessionId: 'session-a' });

    const aRows = store.listBySession('session-a');
    expect(aRows).toHaveLength(2);
    expect(aRows.map((r) => r.toolAttemptId).sort()).toEqual(['ta-1', 'ta-3']);

    const bRows = store.listBySession('session-b');
    expect(bRows).toHaveLength(1);
    expect(bRows[0].toolAttemptId).toBe('ta-2');
  });

  it('returns only rows for the requested tool name via listByToolName', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-1', toolCallId: 'c1', toolName: 'read' });
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-2', toolCallId: 'c2', toolName: 'edit' });
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-3', toolCallId: 'c3', toolName: 'read' });

    const readRows = store.listByToolName('read');
    expect(readRows).toHaveLength(2);
    expect(readRows.map((r) => r.toolAttemptId).sort()).toEqual(['ta-1', 'ta-3']);

    const editRows = store.listByToolName('edit');
    expect(editRows).toHaveLength(1);
    expect(editRows[0].toolAttemptId).toBe('ta-2');
  });

  it('returns all rows ordered by started_at DESC with a limit via listAll', () => {
    const clock = makeClock();
    const store = makeStore(clock);
    for (let i = 1; i <= 5; i++) {
      store.insertPending({ ...BASE_PENDING, toolAttemptId: `ta-${i}`, toolCallId: `c${i}` });
    }

    const all = store.listAll();
    expect(all).toHaveLength(5);
    // Most recent first (ta-5 has the latest started_at).
    expect(all.map((r) => r.toolAttemptId)).toEqual(['ta-5', 'ta-4', 'ta-3', 'ta-2', 'ta-1']);

    const limited = store.listAll(2);
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.toolAttemptId)).toEqual(['ta-5', 'ta-4']);
  });

  it('persists MCP tool source and server name correctly', () => {
    const store = makeStore();
    store.insertPending({
      ...BASE_PENDING,
      toolAttemptId: 'ta-1',
      toolCallId: 'c1',
      toolName: 'mcp__context7__resolve',
      toolSource: 'mcp' as const,
      mcpServerName: 'context7',
    });

    const rows = store.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolSource: 'mcp',
      mcpServerName: 'context7',
      toolName: 'mcp__context7__resolve',
    });
  });

  it('stores and redacts the error message on finalize', () => {
    const store = makeStore();
    store.insertPending({ ...BASE_PENDING, toolAttemptId: 'ta-1', toolCallId: 'c1' });

    const ok = store.finalize('ta-1', {
      outcome: 'error',
      resultSizeBytes: 0,
      offloaded: false,
      timedOut: false,
      error: 'Connection refused: sk-abcdefghijklmnop123456 invalid',
    });
    expect(ok).toBe(true);

    const rows = store.listAll();
    expect(rows[0].error).not.toBeNull();
    expect(rows[0].error).not.toContain('sk-abcdefghijklmnop123456');
    expect(rows[0].error).toContain('[REDACTED]');
  });

  it('returns an empty array (not an error) when no rows exist for the session', () => {
    const store = makeStore();
    const rows = store.listBySession('nonexistent-session');
    expect(rows).toEqual([]);
  });
});
