import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_EVENT_CHANNELS, ALLOWED_INVOKE_CHANNELS, IPC_CHANNELS } from '../../src/shared/types/ipc';
import { subagentSnapshotSchema, subagentEventSchema } from '../../src/shared/types/ipc-schemas';
import { subagentSnapshotSchema as requestSchema } from '../../src/main/ipc/payload-schemas';
import { createSubagentPersistenceScheduler } from '../../src/main/agents/persist-subagent-chains';
import { createSubagentEventCoalescer, deliverSubagentChange, mergeSubagentRecords } from '../../src/main/ipc/subagents';
import { broadcastSubagentsChanged } from '../../src/main/agents/wire-subagents';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

const uuid = '00000000-0000-4000-8000-000000000001';
const session = '00000000-0000-4000-8000-000000000002';
const activeByWebContents = vi.hoisted(() => new Map<string, { id: string }>());

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => ({ getActive: (owner: string) => activeByWebContents.get(owner) ?? null }),
}));

const change = (sequence: number, state: 'running' | 'completed' = 'running') => ({
  sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence,
  projection: {
    sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence,
    state, segments: [], toolCalls: [], usage: null, result: null, error: null,
  },
});

const record = (id: string, status: string) => ({
  id, agent_name: 'agent', agent_type: 'subagent', agent_tier: 'bloom', task: id,
  status, chain_id: id, start_time: new Date(0).toISOString(), end_time: null,
  result: null, error: null, parentChainIndex: null, chain: {} as never,
}) as never;

describe('subagent IPC boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    activeByWebContents.clear();
  });

  afterEach(() => vi.useRealTimers());

  it('requires a UUID session snapshot request', () => {
    expect(requestSchema.safeParse({}).success).toBe(false);
    expect(requestSchema.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false);
    expect(requestSchema.safeParse({ sessionId: uuid }).success).toBe(true);
  });

  it('keeps the new invoke/event channels allowlisted exactly once', () => {
    expect(ALLOWED_INVOKE_CHANNELS.filter((channel) => channel === IPC_CHANNELS.SUBAGENTS_SNAPSHOT)).toHaveLength(1);
    expect(ALLOWED_EVENT_CHANNELS.filter((channel) => channel === IPC_CHANNELS.SUBAGENTS_EVENT)).toHaveLength(1);
  });

  it('accepts canonical terminal tool snapshots and rejects terminal string-only snapshots', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'cancelled',
      data: { value: 'cancelled by parent' },
    });
    const canonicalChange = change(3);
    canonicalChange.projection.toolCalls = [{
      toolCallId: 'tool-cancelled',
      toolName: 'read',
      status: 'cancelled',
      partialArgs: '{}',
      args: '{}',
      content: 'cancelled by parent',
      toolResult: canonical,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
    }];
    const event = {
      ...canonicalChange,
      type: 'projection',
    };
    expect(subagentEventSchema.safeParse(event).success).toBe(true);

    const stringOnly = structuredClone(event) as Record<string, unknown>;
    const projection = stringOnly.projection as { toolCalls: Array<Record<string, unknown>> };
    delete projection.toolCalls[0].toolResult;
    projection.toolCalls[0].result = 'cancelled by parent';
    expect(subagentEventSchema.safeParse(stringOnly).success).toBe(false);
  });

  it('merges stored and runtime records with runtime precedence', () => {
    const stored = record('same', 'completed');
    const ended = record('ended', 'failed');
    const runtime = { ...record('same', 'running'), task: 'live task' };
    const merged = mergeSubagentRecords([stored, ended], [runtime]);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.id === 'same')?.status).toBe('running');
    expect(merged.find((item) => item.id === 'ended')?.status).toBe('failed');
  });

  it('targets only non-destroyed windows owning the event session', () => {
    const sent: unknown[] = [];
    const makeWindow = (id: string, destroyed = false) => ({
      isDestroyed: () => destroyed,
      webContents: { id, isDestroyed: () => destroyed, send: (...args: unknown[]) => sent.push(args) },
    }) as never;
    activeByWebContents.set('1', { id: session });
    activeByWebContents.set('2', { id: 'other-session' });
    deliverSubagentChange(change(1) as never, [makeWindow('1'), makeWindow('2'), makeWindow('3', true)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([IPC_CHANNELS.SUBAGENTS_EVENT, expect.objectContaining({ sessionId: session, sequence: 1 })]);
  });

  it('targets durable broadcasts only at windows owning the flushed session', () => {
    const sent: unknown[] = [];
    const makeWindow = (id: string, destroyed = false) => ({
      isDestroyed: () => destroyed,
      webContents: { id, isDestroyed: () => destroyed, send: (...args: unknown[]) => sent.push([id, ...args]) },
    }) as never;
    activeByWebContents.set('1', { id: session });
    activeByWebContents.set('2', { id: 'other-session' });

    broadcastSubagentsChanged(session, [makeWindow('1'), makeWindow('2'), makeWindow('3', true)]);

    expect(sent).toEqual([['1', IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED]]);
  });

  it('coalesces continuous live chunks within 50ms', () => {
    const delivered: unknown[] = [];
    const coalescer = createSubagentEventCoalescer((item) => delivered.push(item));
    coalescer.queue(change(1));
    coalescer.queue(change(2));
    expect(delivered).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(delivered).toHaveLength(1);
    expect((delivered[0] as { sequence: number }).sequence).toBe(2);
  });

  it('checkpoints live chunks by two seconds without one write per chunk', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    scheduler.markDirty(session);
    scheduler.markDirty(session);
    scheduler.markDirty(session);
    vi.advanceTimersByTime(1999);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([session]);
  });

  it('terminal flush cancels the pending checkpoint and sends immediately', () => {
    const writes: string[] = [];
    const delivered: unknown[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    const coalescer = createSubagentEventCoalescer((item) => delivered.push(item));
    scheduler.markDirty(session);
    coalescer.queue(change(1));
    coalescer.queue(change(2, 'completed'));
    coalescer.flush();
    scheduler.flush(session);
    vi.advanceTimersByTime(2000);
    expect(delivered).toHaveLength(1);
    expect((delivered[0] as { sequence: number }).sequence).toBe(2);
    expect(writes).toEqual([session]);
  });

  it('retains dirty follow-up work when a write re-enters', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      if (writes.length === 1) scheduler.markDirty(id);
    });
    scheduler.markDirty(session);
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([session]);
    vi.runOnlyPendingTimers();
    expect(writes).toEqual([session, session]);
  });

  it('retains dirty state and retries a failed write with bounded backoff', () => {
    const writes: string[] = [];
    let attempts = 0;
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      attempts += 1;
      if (attempts < 3) throw new Error('temporary persistence failure');
    });
    scheduler.markDirty(session);
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([session]);
    expect(scheduler.hasPending(session)).toBe(true);
    vi.advanceTimersByTime(99);
    expect(writes).toEqual([session]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([session, session]);
    vi.advanceTimersByTime(199);
    expect(writes).toEqual([session, session]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([session, session, session]);
    expect(scheduler.hasPending(session)).toBe(false);
  });

  it('opens a per-session breaker after the retry budget is exhausted', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      throw new Error('persistent storage failure');
    }, undefined, { maxRetries: 2 });

    scheduler.flush(session);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(200);

    expect(writes).toEqual([session, session, session]);
    expect(scheduler.isDegraded(session)).toBe(true);
    expect(scheduler.hasPending(session)).toBe(true);
    vi.runOnlyPendingTimers();
    expect(writes).toEqual([session, session, session]);
  });

  it('does not reset an active retry budget for interleaved live updates', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      throw new Error('persistent storage failure');
    }, undefined, { maxRetries: 1 });

    scheduler.flush(session);
    scheduler.markDirty(session);
    vi.advanceTimersByTime(100);

    expect(writes).toEqual([session, session]);
    expect(scheduler.isDegraded(session)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(writes).toEqual([session, session]);
  });

  it('does not block checkpoints for other sessions when one is degraded', () => {
    const otherSession = '00000000-0000-4000-8000-000000000003';
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      if (id === session) throw new Error('persistent storage failure');
    }, undefined, { maxRetries: 0 });

    scheduler.flush(session);
    scheduler.flush(otherSession);

    expect(scheduler.isDegraded(session)).toBe(true);
    expect(scheduler.isDegraded(otherSession)).toBe(false);
    expect(writes).toEqual([session, otherSession]);
  });

  it('reopens a degraded session for new durable activity and explicit recovery', () => {
    const writes: string[] = [];
    let fail = true;
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      if (fail) throw new Error('persistent storage failure');
    }, undefined, { maxRetries: 0 });

    scheduler.flush(session);
    expect(scheduler.isDegraded(session)).toBe(true);

    fail = false;
    scheduler.markDirty(session);
    vi.advanceTimersByTime(2000);
    expect(scheduler.isDegraded(session)).toBe(false);

    fail = true;
    scheduler.flush(session);
    expect(scheduler.isDegraded(session)).toBe(true);
    fail = false;
    scheduler.recover(session);
    expect(scheduler.isDegraded(session)).toBe(false);
    expect(writes).toHaveLength(4);
  });

  it('clears per-session retry state and timers when disposed or deleted', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));

    scheduler.markDirty(session);
    scheduler.clear(session);
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([]);
    expect(scheduler.hasPending(session)).toBe(false);

    scheduler.markDirty(session);
    scheduler.dispose();
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([]);
    expect(scheduler.hasPending(session)).toBe(false);
  });

  it('flushes pending event and persistence work for orderly shutdown', () => {
    const delivered: unknown[] = [];
    const writes: string[] = [];
    const coalescer = createSubagentEventCoalescer((item) => delivered.push(item));
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    coalescer.queue(change(1));
    scheduler.markDirty(session);
    coalescer.flush();
    scheduler.flushAll();
    expect(delivered).toHaveLength(1);
    expect(writes).toEqual([session]);
  });

  it('validates discriminated projection events and rejects malformed data', () => {
    const event = { ...change(1), type: 'projection' };
    expect(subagentEventSchema.safeParse(event).success).toBe(true);
    expect(subagentEventSchema.safeParse({ ...event, type: 'unknown' }).success).toBe(false);
  });

  it('requires a validated snapshot result shape', () => {
    expect(subagentSnapshotSchema.safeParse({ sessionId: 'bad', records: [], live: [] }).success).toBe(false);
  });
});
