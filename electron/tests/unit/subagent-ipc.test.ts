import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_EVENT_CHANNELS, ALLOWED_INVOKE_CHANNELS, IPC_CHANNELS, type SubagentEvent } from '../../src/shared/types/ipc';
import {
  subagentDeltaEventSchema,
  subagentEventSchema,
  subagentSnapshotSchema,
} from '../../src/shared/types/ipc-schemas';
import { SubagentDeltaEventType, type SubagentDeltaEvent } from '../../src/shared/types/subagent';
import { subagentSnapshotSchema as requestSchema } from '../../src/main/ipc/payload-schemas';
import {
  createSubagentPersistenceScheduler,
  persistSubagentChains,
} from '../../src/main/agents/persist-subagent-chains';
import { SubagentPersistence } from '../../src/main/agents/subagent-persistence';
import {
  createSubagentDeltaBatcher as createIpcSubagentDeltaBatcher,
  deliverSubagentDeltaEvent as deliverIpcSubagentDeltaEvent,
  mergeSubagentRecords,
} from '../../src/main/ipc/subagents';
import {
  createSubagentDeltaBatcher,
  deliverSubagentDeltaEvent,
} from '../../src/main/agents/subagent-events';
import {
  broadcastSubagentsChanged,
  createSubagentDeltaHandler,
  createSubagentPersistenceWriteCallback,
} from '../../src/main/agents/wire-subagents';
import { runtimeToDomain } from '../../src/main/agents/manager';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

const uuid = '00000000-0000-4000-8000-000000000001';
const session = '00000000-0000-4000-8000-000000000002';
const activeByWebContents = vi.hoisted(() => new Map<string, { id: string }>());
const stubActiveSession = vi.hoisted(() => ({ current: null as { id: string } | null }));
const sessionManagerStub = vi.hoisted(() => ({ syncSubagentRecords: vi.fn() }));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => ({
    getActive: (owner?: string) =>
      (owner !== undefined ? activeByWebContents.get(owner) : stubActiveSession.current) ?? null,
    syncSubagentRecords: sessionManagerStub.syncSubagentRecords,
  }),
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => ({
    getActive: (owner?: string) =>
      (owner !== undefined ? activeByWebContents.get(owner) : stubActiveSession.current) ?? null,
    syncSubagentRecords: sessionManagerStub.syncSubagentRecords,
  }),
}));

const record = (id: string, status: string) => ({
  id, agent_name: 'agent', agent_type: 'subagent', agent_tier: 'bloom', task: id,
  status, chain_id: id, start_time: new Date(0).toISOString(), end_time: null,
  result: null, error: null, parentChainIndex: null, chain: {} as never,
}) as never;

const deltaBase = { sessionId: session, subagentId: 'subagent-1', runId: uuid, sessionRevision: 0 };

const textDelta = (sequence: number, append: string, segmentId = 'seg-1'): SubagentDeltaEvent => ({
  ...deltaBase, sequence, type: 'text_delta', segmentId, append,
});

const terminalDelta = (sequence: number): SubagentDeltaEvent => ({
  ...deltaBase, sequence, type: 'terminal',
  record: record('subagent-1', 'completed'), state: 'completed', usage: null,
});

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
    const projection = {
      sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence: 3,
      state: 'running', segments: [], usage: null, result: null, error: null,
      toolCalls: [{
        toolCallId: 'tool-cancelled',
        toolName: 'read',
        status: 'cancelled',
        partialArgs: '{}',
        args: '{}',
        content: 'cancelled by parent',
        toolResult: canonical,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
      }],
    };
    const snapshot = { sessionId: session, sessionRevision: 3, records: [], live: [projection] };
    expect(subagentSnapshotSchema.safeParse(snapshot).success).toBe(true);

    const stringOnly = structuredClone(snapshot) as { live: Array<{ toolCalls: Array<Record<string, unknown>> }> };
    delete stringOnly.live[0].toolCalls[0].toolResult;
    stringOnly.live[0].toolCalls[0].result = 'cancelled by parent';
    expect(subagentSnapshotSchema.safeParse(stringOnly).success).toBe(false);
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

  it('keeps live-delta helpers available from the IPC compatibility surface', () => {
    expect(createIpcSubagentDeltaBatcher).toBe(createSubagentDeltaBatcher);
    expect(deliverIpcSubagentDeltaEvent).toBe(deliverSubagentDeltaEvent);
  });

  it('snapshot continuity: evicted records still appear from stored rows when absent from runtime', () => {
    const evicted = record('evicted-1', 'completed');
    const active = record('active-1', 'running');
    // Runtime only has the active record; the evicted one was removed from the manager.
    const merged = mergeSubagentRecords([evicted, active], [active]);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.id === 'evicted-1')?.status).toBe('completed');
    expect(merged.find((item) => item.id === 'active-1')?.status).toBe('running');
  });

  it('targets batched delta envelopes only at non-destroyed windows owning the session', () => {
    const sent: unknown[] = [];
    const makeWindow = (id: string, destroyed = false) => ({
      isDestroyed: () => destroyed,
      webContents: { id, isDestroyed: () => destroyed, send: (...args: unknown[]) => sent.push(args) },
    }) as never;
    activeByWebContents.set('1', { id: session });
    activeByWebContents.set('2', { id: 'other-session' });
    const envelope: SubagentEvent = {
      sessionId: session,
      events: [{
        sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence: 1, sessionRevision: 0,
        type: 'text_delta', segmentId: 'seg-1', append: 'hi',
      }],
    };
    deliverSubagentDeltaEvent(envelope, [makeWindow('1'), makeWindow('2'), makeWindow('3', true)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([IPC_CHANNELS.SUBAGENTS_EVENT, envelope]);
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

  it('routes deltas to persistence: dirty on any delta, terminal rides a wave flush', () => {
    const writes: Array<[string, boolean]> = [];
    const delivered: SubagentEvent[] = [];
    const cleared: Array<[string, string]> = [];
    const scheduler = createSubagentPersistenceScheduler(
      (id, info) => writes.push([id, info.recovery]),
    );
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); });
    const handler = createSubagentDeltaHandler({
      markDirty: (sessionId) => scheduler.markDirty(sessionId),
      scheduleTerminalWave: (sessionId) => scheduler.scheduleWave(sessionId, 250),
      clearToolCallHistory: (sessionId, agentScopeId) => cleared.push([sessionId, agentScopeId]),
      queueDelta: (event) => batcher.queue(event),
      flushDeltas: () => batcher.flush(),
    });

    handler(textDelta(1, 'partial'));
    handler(textDelta(2, ' more'));
    vi.advanceTimersByTime(16);
    expect(delivered.map((envelope) => envelope.events.map((event) => event.sequence))).toEqual([[2]]);
    // The two appends dirtied the session once; the 2s checkpoint has not fired yet.
    expect(writes).toEqual([]);

    handler(terminalDelta(3));
    // Terminal flushes delivery synchronously; persistence waits for the wave window.
    expect(delivered).toHaveLength(2);
    expect(delivered[1].events.map((event) => event.type)).toEqual(['terminal']);
    expect(cleared).toEqual([[session, 'subagent-1']]);
    expect(writes).toEqual([]);

    vi.advanceTimersByTime(249);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([[session, false]]);

    // The wave flush cancelled the pending checkpoint; nothing more fires.
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([[session, false]]);
  });

  it('batches near-simultaneous terminal completions into exactly one wave flush', () => {
    const writes: Array<[string, boolean]> = [];
    const scheduler = createSubagentPersistenceScheduler(
      (id, info) => writes.push([id, info.recovery]),
    );
    const handler = createSubagentDeltaHandler({
      markDirty: (sessionId) => scheduler.markDirty(sessionId),
      scheduleTerminalWave: (sessionId) => scheduler.scheduleWave(sessionId, 250),
      clearToolCallHistory: () => {},
      queueDelta: () => {},
      flushDeltas: () => {},
    });

    handler(terminalDelta(1));
    handler({ ...terminalDelta(2), subagentId: 'subagent-2' });
    handler({ ...terminalDelta(3), subagentId: 'subagent-3' });

    vi.advanceTimersByTime(250);
    expect(writes).toEqual([[session, false]]);
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([[session, false]]);
  });

  it('reports recovery only on explicit recovery flushes', () => {
    const writes: Array<[string, boolean]> = [];
    const scheduler = createSubagentPersistenceScheduler(
      (id, info) => writes.push([id, info.recovery]),
    );

    scheduler.markDirty(session);
    vi.advanceTimersByTime(2000);
    expect(writes).toEqual([[session, false]]);

    scheduler.scheduleWave(session, 250);
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([[session, false], [session, false]]);

    scheduler.recover(session);
    expect(writes).toEqual([[session, false], [session, false], [session, true]]);

    // The recovery flag clears after a successful flush.
    scheduler.markDirty(session);
    vi.advanceTimersByTime(2000);
    expect(writes.at(-1)).toEqual([session, false]);
  });

  it('broadcasts SESSION_SUBAGENTS_CHANGED only on recovery flushes (R8)', () => {
    const writes: string[] = [];
    const broadcasts: string[] = [];
    const scheduler = createSubagentPersistenceScheduler(
      createSubagentPersistenceWriteCallback(
        (id) => writes.push(id),
        (id) => broadcasts.push(id),
      ),
    );

    scheduler.markDirty(session);
    vi.advanceTimersByTime(2000);
    scheduler.scheduleWave(session, 250);
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([session, session]);
    expect(broadcasts).toEqual([]);

    scheduler.recover(session);
    expect(writes).toEqual([session, session, session]);
    expect(broadcasts).toEqual([session]);
  });

  it('does not schedule a terminal wave while degraded', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => {
      writes.push(id);
      throw new Error('persistent storage failure');
    }, undefined, { maxRetries: 0 });

    scheduler.flush(session);
    expect(scheduler.isDegraded(session)).toBe(true);

    scheduler.scheduleWave(session, 250);
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([session]);
    expect(scheduler.hasPending(session)).toBe(true);
  });

  it('clears a pending wave when the session is deleted', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    scheduler.scheduleWave(session, 250);
    scheduler.clear(session);
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([]);
    expect(scheduler.hasPending(session)).toBe(false);
  });

  it('flushes wave-pending sessions on orderly shutdown', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    scheduler.scheduleWave(session, 250);
    scheduler.flushAll();
    expect(writes).toEqual([session]);
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([session]);
  });

  it('recoverAll reopens caller-supplied tracked sessions as recovery flushes', () => {
    const writes: Array<[string, boolean]> = [];
    const scheduler = createSubagentPersistenceScheduler(
      (id, info) => writes.push([id, info.recovery]),
    );
    const tracked = '00000000-0000-4000-8000-000000000009';

    scheduler.recoverAll([tracked]);
    expect(writes).toEqual([[tracked, true]]);
  });

  it('marks a session dirty on any delta and checkpoints once per debounce window', () => {
    const writes: string[] = [];
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    const handler = createSubagentDeltaHandler({
      markDirty: (sessionId) => scheduler.markDirty(sessionId),
      scheduleTerminalWave: (sessionId) => scheduler.scheduleWave(sessionId, 250),
      clearToolCallHistory: () => {},
      queueDelta: () => {},
      flushDeltas: () => {},
    });

    handler(textDelta(1, 'a'));
    handler(textDelta(2, 'b'));
    handler(textDelta(3, 'c'));
    vi.advanceTimersByTime(1999);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
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
    const delivered: SubagentEvent[] = [];
    const writes: string[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); });
    const scheduler = createSubagentPersistenceScheduler((id) => writes.push(id));
    batcher.queue(textDelta(1, 'pending'));
    scheduler.markDirty(session);
    batcher.flush();
    scheduler.flushAll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].events.map((event) => event.sequence)).toEqual([1]);
    expect(writes).toEqual([session]);
  });

  it('requires a validated snapshot result shape', () => {
    expect(subagentSnapshotSchema.safeParse({ sessionId: 'bad', sessionRevision: 0, records: [], live: [] }).success).toBe(false);
  });
});

describe('subagent delta event protocol (U1)', () => {
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cached_tokens: 0 };
  const base = { sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence: 1, sessionRevision: 0 };

  /** Exhaustive switch over the delta union; the `never` guard fails typecheck when a variant lacks a case. */
  function summarizeDelta(event: SubagentDeltaEvent): string {
    switch (event.type) {
      case SubagentDeltaEventType.SPAWNED: return `spawned:${event.record.id}`;
      case SubagentDeltaEventType.TEXT_DELTA: return `text:${event.segmentId}+${event.append}`;
      case SubagentDeltaEventType.THINKING_DELTA: return `thinking:${event.segmentId}+${event.append}`;
      case SubagentDeltaEventType.TOOL_START: return `tool_start:${event.toolCallId}:${event.status}`;
      case SubagentDeltaEventType.TOOL_ARGS_DELTA: return `tool_args:${event.toolCallId}+${event.append}`;
      case SubagentDeltaEventType.TOOL_RESULT: return `tool_result:${event.toolCallId}:${event.status}`;
      case SubagentDeltaEventType.USAGE: return `usage:${event.usage.total_tokens}`;
      case SubagentDeltaEventType.TERMINAL: return `terminal:${event.state}`;
      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled delta ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const canonical = createCanonicalToolResult('generic', { status: 'complete', data: { value: 'done' } });
  const deltas: SubagentDeltaEvent[] = [
    { ...base, type: 'spawned', record: record('subagent-1', 'running'), usage: null },
    { ...base, type: 'text_delta', segmentId: 'seg-text', append: 'hel', sequence: 2 },
    { ...base, type: 'thinking_delta', segmentId: 'seg-think', append: 'hmm', sequence: 3 },
    {
      ...base, type: 'tool_start', segmentId: 'seg-tool', toolCallId: 'call-1', toolName: 'read',
      status: 'generating', args: '', startedAt: new Date(0).toISOString(), sequence: 4,
    },
    { ...base, type: 'tool_args_delta', toolCallId: 'call-1', append: '{"path":', sequence: 5 },
    {
      ...base, type: 'tool_result', toolCallId: 'call-1', status: 'complete', content: 'done',
      toolResult: canonical, finishedAt: new Date(1).toISOString(), sequence: 6,
    },
    { ...base, type: 'usage', usage, sequence: 7 },
    { ...base, type: 'terminal', record: record('subagent-1', 'completed'), state: 'completed', usage, sequence: 8 },
  ];

  it('covers every delta variant in an exhaustive switch and validates each against the wire schema', () => {
    expect(deltas.map(summarizeDelta)).toEqual([
      'spawned:subagent-1',
      'text:seg-text+hel',
      'thinking:seg-think+hmm',
      'tool_start:call-1:generating',
      'tool_args:call-1+{"path":',
      'tool_result:call-1:complete',
      'usage:3',
      'terminal:completed',
    ]);
    for (const delta of deltas) {
      expect(subagentDeltaEventSchema.safeParse(delta).success).toBe(true);
    }
  });

  it('validates a batched envelope of deltas and rejects malformed members', () => {
    expect(subagentEventSchema.safeParse({ sessionId: session, events: deltas }).success).toBe(true);
    expect(subagentEventSchema.safeParse({ sessionId: session, events: [] }).success).toBe(true);
    const malformed = structuredClone(deltas[1]) as Record<string, unknown>;
    delete malformed.segmentId;
    expect(subagentEventSchema.safeParse({ sessionId: session, events: [malformed] }).success).toBe(false);
  });

  it('rejects deltas missing any shared base field', () => {
    for (const field of ['sessionId', 'subagentId', 'runId', 'sequence', 'sessionRevision'] as const) {
      const broken = structuredClone(deltas[1]) as Record<string, unknown>;
      delete broken[field];
      expect(subagentDeltaEventSchema.safeParse(broken).success).toBe(false);
    }
  });

  it('rejects negative or fractional sequence and sessionRevision', () => {
    expect(subagentDeltaEventSchema.safeParse({ ...deltas[1], sessionRevision: -1 }).success).toBe(false);
    expect(subagentDeltaEventSchema.safeParse({ ...deltas[1], sessionRevision: 1.5 }).success).toBe(false);
    expect(subagentDeltaEventSchema.safeParse({ ...deltas[1], sequence: -2 }).success).toBe(false);
  });

  it('rejects an unknown delta type discriminant', () => {
    expect(subagentDeltaEventSchema.safeParse({ ...base, type: 'exploded' }).success).toBe(false);
  });

  it('accepts a snapshot carrying sessionRevision and rejects missing or negative revisions', () => {
    const valid = { sessionId: session, sessionRevision: 0, records: [], live: [] };
    expect(subagentSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(subagentSnapshotSchema.safeParse({ sessionId: session, records: [], live: [] }).success).toBe(false);
    expect(subagentSnapshotSchema.safeParse({ ...valid, sessionRevision: -1 }).success).toBe(false);
  });

  it('accepts a spawned-delta envelope carrying a queued record (U7 admission queue)', () => {
    const queued = { ...base, type: 'spawned', record: record('subagent-queued', 'queued'), usage: null };
    expect(subagentEventSchema.safeParse({ sessionId: session, events: [queued] }).success).toBe(true);
  });

  it('accepts a snapshot with a queued record and a queued live projection (U7 admission queue)', () => {
    // Mirrors createSubagentSnapshot() for a QUEUED runtime record:
    // runtimeToDomain maps state QUEUED → record.status 'queued', and the
    // live projection is seeded with makeLiveProjection(..., 'queued').
    const snapshot = {
      sessionId: session,
      sessionRevision: 1,
      records: [record('subagent-queued', 'queued')],
      live: [{
        sessionId: session, subagentId: 'subagent-queued', runId: uuid, sequence: 0,
        state: 'queued', segments: [], toolCalls: [], usage: null, result: null, error: null,
      }],
    };
    expect(subagentSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('rejects a legacy projection event on the narrowed wire schema', () => {
    const legacy = {
      sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence: 1,
      type: 'projection',
      projection: {
        sessionId: session, subagentId: 'subagent-1', runId: uuid, sequence: 1,
        state: 'running', segments: [], toolCalls: [], usage: null, result: null, error: null,
      },
    };
    expect(subagentEventSchema.safeParse(legacy).success).toBe(false);
    expect(subagentEventSchema.safeParse({ sessionId: session, events: deltas }).success).toBe(true);
  });
});

describe('subagent delta batcher (U3)', () => {
  const baseFields = { sessionId: session, subagentId: 'subagent-1', runId: uuid, sessionRevision: 0 };

  const textDelta = (
    sequence: number,
    append: string,
    segmentId = 'seg-1',
    subagentId = 'subagent-1',
  ): SubagentDeltaEvent => ({
    ...baseFields, subagentId, sequence, type: 'text_delta', segmentId, append,
  });

  const usageDelta = (sequence: number, subagentId = 'subagent-1'): SubagentDeltaEvent => ({
    ...baseFields,
    subagentId,
    sequence,
    type: 'usage',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 },
  });

  const sequences = (delivered: readonly SubagentEvent[]) =>
    delivered.map((envelope) => envelope.events.map((event) => event.sequence));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('merges same-segment text appends within one window, keeping the last sequence and revision', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); });
    batcher.queue(textDelta(1, 'hel'));
    batcher.queue(textDelta(2, 'lo'));
    batcher.queue(usageDelta(3));
    batcher.queue({ ...textDelta(4, '!'), sessionRevision: 9 });
    batcher.queue({ ...baseFields, sequence: 5, type: 'thinking_delta', segmentId: 'seg-1', append: 'hmm' });
    batcher.queue(textDelta(6, '?', 'seg-2'));
    batcher.queue(textDelta(7, 'other', 'seg-1', 'subagent-2'));

    expect(delivered).toHaveLength(0);
    vi.advanceTimersByTime(16);

    expect(delivered).toHaveLength(1);
    const envelope = delivered[0];
    expect(envelope.sessionId).toBe(session);
    // The merged append lands at its last occurrence, keeping batch order monotonic.
    expect(envelope.events.map((event) => event.type)).toEqual([
      'usage', 'text_delta', 'thinking_delta', 'text_delta', 'text_delta',
    ]);
    expect(envelope.events[1]).toMatchObject({
      type: 'text_delta', segmentId: 'seg-1', append: 'hello!', sequence: 4, sessionRevision: 9,
    });
    // Different types, segments, and subagents never merge.
    expect(envelope.events[2]).toMatchObject({ type: 'thinking_delta', segmentId: 'seg-1', append: 'hmm', sequence: 5 });
    expect(envelope.events[3]).toMatchObject({ type: 'text_delta', segmentId: 'seg-2', append: '?', sequence: 6 });
    expect(envelope.events[4]).toMatchObject({ type: 'text_delta', subagentId: 'subagent-2', append: 'other', sequence: 7 });
  });

  it('caps each flush at the event budget and defers overflow in order to later flushes', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, {
      budgets: () => ({ maxPerFlush: 3, byteBudgetKb: 64 }),
    });
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      batcher.queue(usageDelta(sequence));
    }

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 3]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 3], [4, 5, 6]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);

    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(3);
  });

  it('defers deltas past the byte budget to the next flush in order', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, {
      budgets: () => ({ maxPerFlush: 200, byteBudgetKb: 1 }),
    });
    batcher.queue(textDelta(1, 'x'.repeat(600), 'seg-a'));
    batcher.queue(textDelta(2, 'y'.repeat(600), 'seg-b'));
    batcher.queue(textDelta(3, 'z'.repeat(600), 'seg-c'));

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1], [2]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1], [2], [3]]);

    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(3);
  });

  it('flushes a single delta larger than the whole byte budget instead of deferring it forever', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, {
      budgets: () => ({ maxPerFlush: 200, byteBudgetKb: 1 }),
    });
    batcher.queue(textDelta(1, 'x'.repeat(5000), 'seg-big'));
    batcher.queue(usageDelta(2));

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1], [2]]);
  });

  it('never defers spawned or terminal deltas behind a full budget', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, {
      budgets: () => ({ maxPerFlush: 2, byteBudgetKb: 1 }),
    });
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      batcher.queue(usageDelta(sequence));
    }
    batcher.queue({ ...baseFields, sequence: 5, type: 'spawned', record: record('subagent-1', 'running'), usage: null });
    batcher.queue({
      ...baseFields, sequence: 6, type: 'terminal', record: record('subagent-1', 'completed'), state: 'completed', usage: null,
    });

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 5, 6]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 5, 6], [3, 4]]);

    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(2);
  });

  it('does not charge exempt lifecycle deltas to the normal count or byte budgets', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, {
      budgets: () => ({ maxPerFlush: 2, byteBudgetKb: 1 }),
    });
    batcher.queue({
      ...baseFields,
      sequence: 1,
      type: 'spawned',
      record: { ...record('subagent-1', 'running'), task: 'x'.repeat(2_000) },
      usage: null,
    });
    batcher.queue({ ...baseFields, sequence: 2, type: 'status_changed', status: 'running' });
    batcher.queue({
      ...baseFields,
      sequence: 3,
      type: 'terminal',
      record: record('subagent-1', 'completed'),
      state: 'completed',
      usage: null,
    });
    batcher.queue(textDelta(4, 'a'.repeat(600), 'seg-a'));
    batcher.queue(usageDelta(5));
    batcher.queue(usageDelta(6));

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 3, 4, 5]]);

    vi.advanceTimersByTime(16);
    expect(sequences(delivered)).toEqual([[1, 2, 3, 4, 5], [6]]);
  });

  it('skips sessions with no eligible recipient without delivering or deferring their deltas', () => {
    const delivered: SubagentEvent[] = [];
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, {
      isEligible: (sessionId) => sessionId === session,
    });
    batcher.queue(usageDelta(1));
    batcher.queue({ ...usageDelta(2), sessionId: 'ineligible-session' });

    vi.advanceTimersByTime(16);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].sessionId).toBe(session);
    expect(sequences(delivered)).toEqual([[1]]);

    vi.advanceTimersByTime(100);
    expect(delivered).toHaveLength(1);
  });

  it('checks window eligibility once per distinct session per flush, not per event', () => {
    const delivered: SubagentEvent[] = [];
    const isEligible = vi.fn(() => true);
    const batcher = createSubagentDeltaBatcher((envelope) => { delivered.push(envelope); }, { isEligible });
    const secondSession = '00000000-0000-4000-8000-000000000004';
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      batcher.queue(usageDelta(sequence));
      batcher.queue({ ...usageDelta(sequence + 4), sessionId: secondSession });
    }

    vi.advanceTimersByTime(16);

    // 8 events across 2 sessions → 2 eligibility checks, not 8.
    expect(isEligible).toHaveBeenCalledTimes(2);
    expect(delivered).toHaveLength(2);
    expect(sequences(delivered)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
  });
});

// ===========================================================================
// Dirty-record checkpoint tracking (U6, R7/R9)
// ===========================================================================

describe('persistSubagentChains dirty tracking (U6)', () => {
  const sid = '00000000-0000-4000-8000-000000000010';

  /** Minimal runtime SubagentRecord; live state stays in the manager store. */
  const runtimeRecord = (id: string, sessionId: string | null, overrides: Record<string, unknown> = {}) => ({
    id,
    agent: { name: 'explorer', type: 'subagent', tier: 'bloom' },
    state: 'running',
    label: id,
    task: `task ${id}`,
    result: 'done',
    error: null,
    startTime: 0,
    endTime: 1,
    chain: { id: `chain-${id}`, sessionId, messages: [], status: 'completed' },
    usage: null,
    selection: null,
    parentChainIndex: null,
    sessionId,
    admitted: true,
    ...overrides,
  }) as never;

  const confirmSpy = vi.fn();
  const managerOf = (...rawRecords: unknown[]) => {
    const records = rawRecords as Array<{ id: string; sessionId: string | null; state: string; admitted?: boolean }>;
    const persistence = new SubagentPersistence(() => 25);
    for (const record of records) {
      persistence.register(record.id, record.sessionId, { admitted: record.admitted !== false });
    }
    return {
      allRecords: () => records,
      toDomainRecord: (runtime: never) => runtimeToDomain(runtime, { includeLiveTail: false }),
      checkpointCandidates: (sessionId: string, options: { recovery?: boolean; includeUnscoped?: boolean } = {}) => records.flatMap((record) => {
        if (record.sessionId !== sessionId && !(options.includeUnscoped && record.sessionId === null)) return [];
        const checkpoint = persistence.checkpointCandidate(
          record.id,
          sessionId,
          ['completed', 'failed', 'interrupted'].includes(record.state),
          options.recovery === true,
        );
        return checkpoint ? [{ record, checkpoint }] : [];
      }),
      confirmCheckpointCandidates: (candidates: never[]) => {
        confirmSpy(candidates);
        for (const candidate of candidates) persistence.confirmCheckpoint(candidate.checkpoint);
      },
      trackedPersistenceSessions: () => persistence.trackedSessions(),
      markDirty: (id: string) => persistence.markDirty(id),
    } as never;
  };

  beforeEach(() => {
    sessionManagerStub.syncSubagentRecords.mockReset();
    sessionManagerStub.syncSubagentRecords.mockImplementation(
      (sessionId: string) => ({ session: { id: sessionId }, bytes: 42 }),
    );
    confirmSpy.mockReset();
    stubActiveSession.current = null;
  });

  it('upserts only records dirtied since the last checkpoint', () => {
    const a = runtimeRecord('sub-a', sid);
    const b = runtimeRecord('sub-b', sid);
    const manager = managerOf(a, b);

    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(1);
    expect(sessionManagerStub.syncSubagentRecords.mock.calls[0][1].map((r: { id: string }) => r.id))
      .toEqual(['sub-a', 'sub-b']);

    // No new durable mutations → the second checkpoint writes nothing.
    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(1);

    // One record dirties → only that record is upserted.
    manager.markDirty('sub-b');
    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(2);
    expect(sessionManagerStub.syncSubagentRecords.mock.calls[1][1].map((r: { id: string }) => r.id))
      .toEqual(['sub-b']);
  });

  it('never upserts queued or pre-admission records (queued is runtime-only)', () => {
    const admitted = runtimeRecord('sub-admitted', sid, { queuedAt: 5, startedAt: 9 });
    const queued = runtimeRecord('sub-queued', sid, {
      state: 'queued', queuedAt: 5, startedAt: null, admitted: false,
    });
    const cancelledWhileQueued = runtimeRecord('sub-cancelled', sid, {
      state: 'interrupted', queuedAt: 5, startedAt: null, admitted: false,
    });
    const manager = managerOf(admitted, queued, cancelledWhileQueued);

    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(1);
    expect(sessionManagerStub.syncSubagentRecords.mock.calls[0][1].map((r: { id: string }) => r.id))
      .toEqual(['sub-admitted']);

    // Even a recovery flush must not write records that never reached admission.
    persistSubagentChains(manager, sid, { recovery: true });
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(2);
    expect(sessionManagerStub.syncSubagentRecords.mock.calls[1][1].map((r: { id: string }) => r.id))
      .toEqual(['sub-admitted']);
  });

  it('treats recovery flushes as all records dirty', () => {
    const a = runtimeRecord('sub-a', sid);
    const manager = managerOf(a);

    persistSubagentChains(manager, sid);
    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(1);

    persistSubagentChains(manager, sid, { recovery: true });
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(2);
    expect(manager.trackedPersistenceSessions()).toContain(sid);
  });

  it('keeps records dirty when the storage write fails (persist-first)', () => {
    const a = runtimeRecord('sub-a', sid);
    const manager = managerOf(a);
    sessionManagerStub.syncSubagentRecords.mockImplementationOnce(() => {
      throw new Error('storage rejected');
    });

    expect(() => persistSubagentChains(manager, sid)).toThrow(/storage rejected/);

    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(2);
  });

  it('does not mark records persisted when the session is unknown', () => {
    sessionManagerStub.syncSubagentRecords.mockReturnValue({ session: null, bytes: 0 });
    const a = runtimeRecord('sub-a', sid);
    const manager = managerOf(a);

    persistSubagentChains(manager, sid);
    persistSubagentChains(manager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(2);
  });

  it('keeps confirmed tracking scoped to one manager instance', () => {
    const a = runtimeRecord('sub-a', sid);
    const manager = managerOf(a);

    persistSubagentChains(manager, sid);
    expect(manager.trackedPersistenceSessions()).toContain(sid);
    const restoredManager = managerOf(a);
    expect(restoredManager.trackedPersistenceSessions()).not.toContain(sid);
    persistSubagentChains(restoredManager, sid);
    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(2);
    expect(restoredManager.trackedPersistenceSessions()).toContain(sid);
  });

  it('logs checkpoint bytes and duration (R9)', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      persistSubagentChains(managerOf(runtimeRecord('sub-a', sid)), sid);
      expect(debug).toHaveBeenCalledWith(
        expect.stringMatching(/\[subagents\] checkpoint session=.* records=1 bytes=42 durationMs=/),
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('falls back to the active session for unscoped records', () => {
    stubActiveSession.current = { id: sid };
    const unscoped = runtimeRecord('sub-unscoped', null);

    persistSubagentChains(managerOf(unscoped));

    expect(sessionManagerStub.syncSubagentRecords).toHaveBeenCalledTimes(1);
    expect(sessionManagerStub.syncSubagentRecords.mock.calls[0][0]).toBe(sid);
  });

  it('confirms terminal records persisted after successful flush (persist-first eviction)', () => {
    const terminal = runtimeRecord('sub-terminal', sid, { state: 'completed' });
    const running = runtimeRecord('sub-running', sid, { state: 'running' });
    const manager = managerOf(terminal, running);

    persistSubagentChains(manager, sid);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]
      .filter((candidate: { checkpoint: { terminal: boolean } }) => candidate.checkpoint.terminal)
      .map((candidate: { record: { id: string } }) => candidate.record.id))
      .toEqual(['sub-terminal']);
  });

  it('does NOT confirm records when the flush fails (no eviction on failure)', () => {
    sessionManagerStub.syncSubagentRecords.mockImplementation(() => {
      throw new Error('disk full');
    });
    const terminal = runtimeRecord('sub-terminal', sid, { state: 'completed' });
    const manager = managerOf(terminal);

    expect(() => persistSubagentChains(manager, sid)).toThrow('disk full');
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
