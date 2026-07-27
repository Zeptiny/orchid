import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_EVENT_CHANNELS, ALLOWED_INVOKE_CHANNELS, IPC_CHANNELS, type SubagentEvent } from '../../src/shared/types/ipc';
import {
  legacySubagentEventSchema,
  subagentDeltaEventSchema,
  subagentEventSchema,
  subagentEventWireSchema,
  subagentSnapshotSchema,
} from '../../src/shared/types/ipc-schemas';
import { SubagentDeltaEventType, type SubagentDeltaEvent } from '../../src/shared/types/subagent';
import { subagentSnapshotSchema as requestSchema } from '../../src/main/ipc/payload-schemas';
import { createSubagentPersistenceScheduler } from '../../src/main/agents/persist-subagent-chains';
import {
  createSubagentDeltaBatcher,
  createSubagentEventCoalescer,
  deliverSubagentChange,
  deliverSubagentDeltaEvent,
  mergeSubagentRecords,
} from '../../src/main/ipc/subagents';
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
    expect(legacySubagentEventSchema.safeParse(event).success).toBe(true);

    const stringOnly = structuredClone(event) as Record<string, unknown>;
    const projection = stringOnly.projection as { toolCalls: Array<Record<string, unknown>> };
    delete projection.toolCalls[0].toolResult;
    projection.toolCalls[0].result = 'cancelled by parent';
    expect(legacySubagentEventSchema.safeParse(stringOnly).success).toBe(false);
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
    expect(legacySubagentEventSchema.safeParse(event).success).toBe(true);
    expect(legacySubagentEventSchema.safeParse({ ...event, type: 'unknown' }).success).toBe(false);
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

  it('keeps the legacy projection event valid on the transitional wire schema', () => {
    const legacy = { ...change(1), type: 'projection' };
    expect(subagentEventWireSchema.safeParse(legacy).success).toBe(true);
    expect(subagentEventWireSchema.safeParse({ sessionId: session, events: deltas }).success).toBe(true);
    expect(subagentEventWireSchema.safeParse({ sessionId: session, events: [{ type: 'nope' }] }).success).toBe(false);
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
});
