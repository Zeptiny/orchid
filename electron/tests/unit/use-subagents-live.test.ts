import { describe, expect, it } from 'vitest';
import type { SubagentEvent, SubagentSnapshot } from '../../src/shared/types/ipc';
import type { Usage } from '../../src/shared/types/message';
import type {
  SubagentDeltaEvent,
  SubagentLiveProjection,
  SubagentRecord,
  SubagentSpawnedEvent,
  SubagentTerminalEvent,
} from '../../src/shared/types/subagent';
import { estimateDeltaBytes } from '../../src/shared/types/subagent';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import {
  deriveSubagentUsageSummary,
  EMPTY_SUBAGENT_USAGE_SUMMARY,
  subagentUsageSummaryEquals,
  type SubagentUsageSource,
} from '../../src/shared/usage';
import { buildSubagentDetail } from '../../src/renderer/hooks/useSubagents';
import {
  applyDeltaBatch,
  beginSubagentSnapshotRefresh,
  bindSubagentSession,
  createSubagentStreamState,
  groupSubagents,
  isSubagentSnapshotAffine,
  resolveSubagentSelection,
  seedSubagentSnapshot,
  type SubagentStreamState,
} from '../../src/renderer/utils/subagent-stream';

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';

function record(id: string, status: SubagentRecord['status'], start = '2026-01-01T00:00:00.000Z'): SubagentRecord {
  return {
    id, agent_name: id, agent_type: 'subagent', agent_tier: 'bloom', task: id,
    status, chain_id: `${id}-chain`, start_time: start, end_time: null,
    result: null, error: null, parentChainIndex: null, chain: { messages: [] } as SubagentRecord['chain'],
  };
}

function projection(overrides: Partial<SubagentLiveProjection> & { subagentId: string }): SubagentLiveProjection {
  return {
    sessionId: sessionA, runId: 'run-1', sequence: 0, state: 'running',
    segments: [], toolCalls: [], usage: null, result: null, error: null,
    ...overrides,
  };
}

interface DeltaFactoryOptions {
  sessionId?: string;
  subagentId?: string;
  runId?: string;
  sessionRevision?: number;
}

function deltaBase(options: DeltaFactoryOptions = {}) {
  return {
    sessionId: options.sessionId ?? sessionA,
    subagentId: options.subagentId ?? 'one',
    runId: options.runId ?? 'run-1',
    sessionRevision: options.sessionRevision ?? 0,
  };
}

function spawned(id: string, runId: string, rec: SubagentRecord, sequence = 0, revision = 0): SubagentSpawnedEvent {
  return { ...deltaBase({ subagentId: id, runId, sessionRevision: revision }), sequence, type: 'spawned', record: rec, usage: null };
}

function terminal(
  id: string,
  runId: string,
  rec: SubagentRecord,
  sequence: number,
  usage: Usage | null = null,
  revision = 0,
): SubagentTerminalEvent {
  return {
    ...deltaBase({ subagentId: id, runId, sessionRevision: revision }),
    sequence, type: 'terminal', record: rec, state: rec.status as SubagentTerminalEvent['state'], usage,
  };
}

function textDelta(sequence: number, append: string, options: DeltaFactoryOptions & { segmentId?: string } = {}): SubagentDeltaEvent {
  return { ...deltaBase(options), sequence, type: 'text_delta', segmentId: options.segmentId ?? 'seg-text', append };
}

function batch(events: SubagentDeltaEvent[], sessionId = sessionA): SubagentEvent {
  return { sessionId, events };
}

function snapshot(sessionId: string, sessionRevision: number, records: SubagentRecord[], live: SubagentLiveProjection[] = []): SubagentSnapshot {
  return { sessionId, sessionRevision, records, live: live.map((item) => ({ ...item, sessionId })) };
}

/** Bound session → loading → seeded (hydration resolved). */
function seeded(
  sessionId: string,
  revision: number,
  records: SubagentRecord[] = [],
  live: SubagentLiveProjection[] = [],
): SubagentStreamState {
  return seedSubagentSnapshot(
    bindSubagentSession(createSubagentStreamState(), sessionId),
    snapshot(sessionId, revision, records, live),
  );
}

describe('subagent list grouping and selection', () => {
  it('groups running and ended records newest first', () => {
    const result = groupSubagents([
      record('old-ended', 'completed', '2026-01-01T00:00:01Z'),
      record('new-running', 'running', '2026-01-01T00:00:03Z'),
      record('new-ended', 'failed', '2026-01-01T00:00:04Z'),
      record('old-running', 'pending', '2026-01-01T00:00:02Z'),
    ]);
    expect(result.queued).toEqual([]);
    expect(result.running.map((item) => item.id)).toEqual(['new-running', 'old-running']);
    expect(result.ended.map((item) => item.id)).toEqual(['new-ended', 'old-ended']);
  });

  it('groups queued records distinctly from running and ended', () => {
    const result = groupSubagents([
      record('queued-old', 'queued', '2026-01-01T00:00:01Z'),
      record('running-one', 'running', '2026-01-01T00:00:02Z'),
      record('queued-new', 'queued', '2026-01-01T00:00:03Z'),
      record('ended-one', 'interrupted', '2026-01-01T00:00:04Z'),
    ]);
    expect(result.queued.map((item) => item.id)).toEqual(['queued-new', 'queued-old']);
    expect(result.running.map((item) => item.id)).toEqual(['running-one']);
    expect(result.ended.map((item) => item.id)).toEqual(['ended-one']);
  });

  it('resolves requested or existing selection without selecting a row by default', () => {
    const records = [record('ended', 'completed', '2026-01-01T00:00:04Z'), record('running', 'running', '2026-01-01T00:00:03Z')];
    expect(resolveSubagentSelection(records, { sessionId: sessionA, requestedId: 'ended' })).toBe('ended');
    expect(resolveSubagentSelection(records, { sessionId: sessionA })).toBeNull();
    expect(resolveSubagentSelection(records, { sessionId: sessionA, requestedId: 'missing' })).toBeNull();
    expect(resolveSubagentSelection(records, { sessionId: sessionA, existingId: 'ended', existingSessionId: sessionA })).toBe('ended');
  });

  it('preserves an explicit empty selection across snapshot refreshes', () => {
    const records = [record('running', 'running')];
    expect(resolveSubagentSelection(records, {
      sessionId: sessionA,
      requestedId: null,
      existingId: null,
      existingSessionId: sessionA,
    })).toBeNull();
  });
});

describe('subagent delta application', () => {
  it('seeds an unknown run from a spawned delta and assembles appends into one projection', () => {
    let state = seeded(sessionA, 0);
    state = applyDeltaBatch(state, batch([
      spawned('one', 'run-1', record('one', 'pending')),
      textDelta(1, 'Hello '),
      textDelta(2, 'world'),
    ]));
    expect(state.records.map((item) => item.id)).toEqual(['one']);
    const live = state.live.get('one');
    expect(live).toMatchObject({ runId: 'run-1', sequence: 2, state: 'running' });
    expect(live?.segments).toEqual([{ kind: 'text', id: 'seg-text', content: 'Hello world' }]);
    expect(state.highWater.get('one')).toBe(2);
    expect(state.runs.get('one')).toBe('run-1');
  });

  it('seeds queued spawns as queued and promotes the draft on the first content delta', () => {
    let state = seeded(sessionA, 0);
    state = applyDeltaBatch(state, batch([spawned('one', 'run-1', record('one', 'queued'))]));
    expect(state.records.map((item) => item.status)).toEqual(['queued']);
    expect(state.live.get('one')).toMatchObject({ runId: 'run-1', state: 'queued' });

    // Admission carries no delta; the first content delta proves the run started.
    state = applyDeltaBatch(state, batch([textDelta(1, 'working')]));
    expect(state.live.get('one')).toMatchObject({ sequence: 1, state: 'running' });
    expect(state.live.get('one')?.segments).toEqual([{ kind: 'text', id: 'seg-text', content: 'working' }]);
  });

  it('seeds queued live projections from snapshots so post-admission deltas apply', () => {
    const state = seeded(
      sessionA,
      1,
      [record('one', 'queued')],
      [projection({ subagentId: 'one', state: 'queued' })],
    );
    expect(state.live.get('one')?.state).toBe('queued');

    const next = applyDeltaBatch(state, batch([textDelta(1, 'admitted')]));
    expect(next.live.get('one')?.state).toBe('running');
    expect(next.live.get('one')?.segments).toEqual([{ kind: 'text', id: 'seg-text', content: 'admitted' }]);
  });

  it('ignores record-carrying deltas whose record id does not match the subagent', () => {
    const empty = seeded(sessionA, 0);
    const mismatchedSpawn = { ...spawned('one', 'run-1', record('other', 'pending')), subagentId: 'one' };
    expect(applyDeltaBatch(empty, batch([mismatchedSpawn]))).toBe(empty);
    expect(empty.records).toHaveLength(0);

    const state = seeded(sessionA, 3, [record('one', 'running')], [projection({ subagentId: 'one', sequence: 3 })]);
    const mismatchedTerminal = { ...terminal('one', 'run-1', record('other', 'completed'), 4), subagentId: 'one' };
    expect(applyDeltaBatch(state, batch([mismatchedTerminal]))).toBe(state);
    expect(state.records[0].status).toBe('running');
  });

  it('keeps records referentially stable across 100 text deltas; changes on spawned and terminal only', () => {
    let state = seeded(sessionA, 0);
    const empty = state.records;
    state = applyDeltaBatch(state, batch([spawned('one', 'run-1', record('one', 'pending'))]));
    expect(state.records).not.toBe(empty);
    const seededRecords = state.records;
    const seededLive = state.live;
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      state = applyDeltaBatch(state, batch([textDelta(sequence, `chunk-${sequence} `)]));
      expect(state.records).toBe(seededRecords);
    }
    expect(state.live).not.toBe(seededLive);
    expect(state.live.get('one')?.sequence).toBe(100);
    expect(state.highWater.get('one')).toBe(100);

    const done = { ...record('one', 'completed'), end_time: '2026-01-01T00:01:40.000Z', result: 'done' };
    state = applyDeltaBatch(state, batch([terminal('one', 'run-1', done, 101)]));
    expect(state.records).not.toBe(seededRecords);
    expect(state.records[0]).toBe(done);
    expect(state.live.has('one')).toBe(false);
  });

  it('drops sequence regressions, wrong runs, unknown runs, and mismatched seeds without state change', () => {
    const state = seeded(sessionA, 3, [record('one', 'running')], [projection({ subagentId: 'one', sequence: 3 })]);
    expect(applyDeltaBatch(state, batch([textDelta(3, 'dup')]))).toBe(state);
    expect(applyDeltaBatch(state, batch([textDelta(2, 'old')]))).toBe(state);
    expect(applyDeltaBatch(state, batch([textDelta(4, 'wrong-run', { runId: 'run-2' })]))).toBe(state);
    expect(applyDeltaBatch(state, batch([textDelta(1, 'unknown', { subagentId: 'other' })]))).toBe(state);

    const mixed = applyDeltaBatch(state, batch([textDelta(2, 'stale'), textDelta(4, 'fresh')]));
    expect(mixed).not.toBe(state);
    expect(mixed.live.get('one')?.segments.at(-1)).toMatchObject({ content: 'fresh' });
    expect(mixed.highWater.get('one')).toBe(4);
  });

  it('assembles tool lifecycle upserts across generating args, running, and result', () => {
    const canonical = createCanonicalToolResult('generic', { status: 'complete', data: { value: 'done' } });
    let state = seeded(sessionA, 0, [record('one', 'running')], [projection({ subagentId: 'one', sequence: 0 })]);
    state = applyDeltaBatch(state, batch([
      {
        ...deltaBase(), sequence: 1, type: 'tool_start', segmentId: 'seg-tool', toolCallId: 'call-1',
        toolName: 'read', status: 'generating', args: '', startedAt: '2026-01-01T00:00:01.000Z',
      } as SubagentDeltaEvent,
      { ...deltaBase(), sequence: 2, type: 'tool_args_delta', toolCallId: 'call-1', append: '{"pa' } as SubagentDeltaEvent,
    ]));
    state = applyDeltaBatch(state, batch([
      { ...deltaBase(), sequence: 3, type: 'tool_args_delta', toolCallId: 'call-1', append: 'th"}' } as SubagentDeltaEvent,
      {
        ...deltaBase(), sequence: 4, type: 'tool_start', segmentId: 'seg-tool', toolCallId: 'call-1',
        toolName: 'read', status: 'running', args: '{"path":1}', startedAt: '2026-01-01T00:00:01.000Z',
      } as SubagentDeltaEvent,
      {
        ...deltaBase(), sequence: 5, type: 'tool_result', toolCallId: 'call-1', status: 'complete',
        content: 'done', toolResult: canonical, finishedAt: '2026-01-01T00:00:02.000Z',
      } as SubagentDeltaEvent,
    ]));

    const live = state.live.get('one');
    expect(live?.segments).toEqual([{ kind: 'tool', id: 'seg-tool', toolCallId: 'call-1' }]);
    expect(live?.toolCalls).toEqual([{
      toolCallId: 'call-1', toolName: 'read', status: 'complete',
      // The manager overwrites partial args with the finalized args at running.
      partialArgs: '{"path":1}', args: '{"path":1}',
      content: 'done', toolResult: canonical,
      startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:02.000Z',
    }]);
  });

  it('terminal removes the live entry and replaces the record with the authoritative durable record', () => {
    const usage: Usage = { prompt_tokens: 7, cached_tokens: 1, completion_tokens: 3, total_tokens: 10 };
    const done: SubagentRecord = {
      ...record('one', 'completed'),
      end_time: '2026-01-01T00:00:05.000Z',
      result: 'finished',
      chain: { messages: [{ usage }] } as SubagentRecord['chain'],
    };
    let state = seeded(sessionA, 3, [record('one', 'running')], [projection({ subagentId: 'one', sequence: 3 })]);
    state = applyDeltaBatch(state, batch([terminal('one', 'run-1', done, 4, usage)]));

    expect(state.live.has('one')).toBe(false);
    expect(state.records[0]).toBe(done);
    expect(state.records[0].status).toBe('completed');
    const detail = buildSubagentDetail(state.records[0], Date.parse('2026-01-01T00:00:06.000Z'), state.live.get('one') ?? null);
    expect(detail.result).toBe('finished');
    expect(detail.usage).toEqual(usage);
    expect(detail.isRunning).toBe(false);
  });
});

describe('delta/snapshot parity', () => {
  const id = 'one';
  const runId = 'run-1';
  const seed = record(id, 'pending');
  const canonical = createCanonicalToolResult('generic', { status: 'complete', data: { value: 'done' } });

  interface ParityScenario {
    name: string;
    deltas: SubagentDeltaEvent[];
    live: SubagentLiveProjection;
  }

  const scenarios: ParityScenario[] = [
    {
      name: 'text only',
      deltas: [textDelta(1, 'Hello '), textDelta(2, 'world')],
      live: projection({
        subagentId: id, sequence: 2,
        segments: [{ kind: 'text', id: 'seg-text', content: 'Hello world' }],
      }),
    },
    {
      name: 'text and thinking interleaved',
      deltas: [
        textDelta(1, 'a', { segmentId: 'seg-text' }),
        { ...deltaBase({ subagentId: id, runId }), sequence: 2, type: 'thinking_delta', segmentId: 'seg-think', append: 'hmm' },
        textDelta(3, 'b', { segmentId: 'seg-text' }),
      ],
      live: projection({
        subagentId: id, sequence: 3,
        segments: [
          { kind: 'text', id: 'seg-text', content: 'ab' },
          { kind: 'thinking', id: 'seg-think', content: 'hmm' },
        ],
      }),
    },
    {
      name: 'tool lifecycle with args deltas before running',
      deltas: [
        {
          ...deltaBase({ subagentId: id, runId }), sequence: 1, type: 'tool_start', segmentId: 'seg-tool',
          toolCallId: 'call-1', toolName: 'read', status: 'generating', args: '', startedAt: '2026-01-01T00:00:01.000Z',
        },
        { ...deltaBase({ subagentId: id, runId }), sequence: 2, type: 'tool_args_delta', toolCallId: 'call-1', append: '{"pa' },
        { ...deltaBase({ subagentId: id, runId }), sequence: 3, type: 'tool_args_delta', toolCallId: 'call-1', append: 'th"}' },
        {
          ...deltaBase({ subagentId: id, runId }), sequence: 4, type: 'tool_start', segmentId: 'seg-tool',
          toolCallId: 'call-1', toolName: 'read', status: 'running', args: '{"path":1}', startedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          ...deltaBase({ subagentId: id, runId }), sequence: 5, type: 'tool_result', toolCallId: 'call-1',
          status: 'complete', content: 'done', toolResult: canonical, finishedAt: '2026-01-01T00:00:02.000Z',
        },
      ],
      live: projection({
        subagentId: id, sequence: 5,
        segments: [{ kind: 'tool', id: 'seg-tool', toolCallId: 'call-1' }],
        toolCalls: [{
          toolCallId: 'call-1', toolName: 'read', status: 'complete',
          partialArgs: '{"path":1}', args: '{"path":1}',
          content: 'done', toolResult: canonical,
          startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:02.000Z',
        }],
      }),
    },
    {
      name: 'tool start directly at running without args deltas',
      deltas: [
        {
          ...deltaBase({ subagentId: id, runId }), sequence: 1, type: 'tool_start', segmentId: 'seg-tool',
          toolCallId: 'call-1', toolName: 'exec', status: 'generating', args: '', startedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          ...deltaBase({ subagentId: id, runId }), sequence: 2, type: 'tool_start', segmentId: 'seg-tool',
          toolCallId: 'call-1', toolName: 'exec', status: 'running', args: '{}', startedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          ...deltaBase({ subagentId: id, runId }), sequence: 3, type: 'tool_result', toolCallId: 'call-1',
          status: 'complete', content: 'done', toolResult: canonical, finishedAt: '2026-01-01T00:00:02.000Z',
        },
      ],
      live: projection({
        subagentId: id, sequence: 3,
        segments: [{ kind: 'tool', id: 'seg-tool', toolCallId: 'call-1' }],
        toolCalls: [{
          toolCallId: 'call-1', toolName: 'exec', status: 'complete',
          partialArgs: '{}', args: '{}',
          content: 'done', toolResult: canonical,
          startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:02.000Z',
        }],
      }),
    },
    {
      name: 'usage deltas between text deltas',
      deltas: [
        textDelta(1, 'a'),
        { ...deltaBase({ subagentId: id, runId }), sequence: 2, type: 'usage', usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1, total_tokens: 2 } },
        textDelta(3, 'b'),
        { ...deltaBase({ subagentId: id, runId }), sequence: 4, type: 'usage', usage: { prompt_tokens: 3, cached_tokens: 1, completion_tokens: 2, total_tokens: 5 } },
      ],
      live: projection({
        subagentId: id, sequence: 4,
        segments: [{ kind: 'text', id: 'seg-text', content: 'ab' }],
        usage: { prompt_tokens: 3, cached_tokens: 1, completion_tokens: 2, total_tokens: 5 },
      }),
    },
  ];

  for (const scenario of scenarios) {
    it(`assembles live state deep-equal to a snapshot at the same revision: ${scenario.name}`, () => {
      const revision = 10;
      const fromDeltas = applyDeltaBatch(
        seeded(sessionA, 0),
        batch([spawned(id, runId, seed, 0, 1), ...scenario.deltas.map((delta) => ({ ...delta, sessionRevision: revision }))]),
      );
      const fromSnapshot = seeded(sessionA, revision, [record(id, 'running')], [scenario.live]);

      expect(fromDeltas.live).toEqual(fromSnapshot.live);
      expect(fromDeltas.highWater).toEqual(fromSnapshot.highWater);
      expect(fromDeltas.runs).toEqual(fromSnapshot.runs);
    });
  }

  it('splits one logical stream across batches with the same parity result', () => {
    const revision = 10;
    const scenario = scenarios[2];
    let state = seeded(sessionA, 0);
    state = applyDeltaBatch(state, batch([spawned(id, runId, seed, 0, 1), ...scenario.deltas.slice(0, 3)]));
    state = applyDeltaBatch(state, batch(scenario.deltas.slice(3)));
    const fromSnapshot = seeded(sessionA, revision, [record(id, 'running')], [scenario.live]);
    expect(state.live).toEqual(fromSnapshot.live);
  });

  it('reaches terminal parity: live entry removed, record replaced at the same revision', () => {
    const usage: Usage = { prompt_tokens: 3, cached_tokens: 0, completion_tokens: 2, total_tokens: 5 };
    const done: SubagentRecord = {
      ...record(id, 'completed'),
      end_time: '2026-01-01T00:00:05.000Z',
      result: 'finished',
      chain: { messages: [{ usage }] } as SubagentRecord['chain'],
    };
    const revision = 12;
    const fromDeltas = applyDeltaBatch(
      seeded(sessionA, 0),
      batch([
        spawned(id, runId, seed, 0, 1),
        { ...textDelta(1, 'work'), sessionRevision: revision - 1 },
        { ...terminal(id, runId, done, 2, usage), sessionRevision: revision },
      ]),
    );
    const terminalProjection = projection({
      subagentId: id, sequence: 2, state: 'completed', usage, result: 'finished',
    });
    const fromSnapshot = seeded(sessionA, revision, [done], [terminalProjection]);

    expect(fromDeltas.live).toEqual(fromSnapshot.live);
    expect(fromDeltas.live.has(id)).toBe(false);
    expect(fromDeltas.records).toEqual(fromSnapshot.records);
    expect(fromDeltas.highWater).toEqual(fromSnapshot.highWater);
    expect(fromDeltas.runs).toEqual(fromSnapshot.runs);
  });
});

describe('hydration buffering and reseed floor', () => {
  it('buffers target-session events across a session rebind and replays newer events only', () => {
    let state = seeded(sessionA, 2, [record('a', 'running')], [projection({ subagentId: 'a', runId: 'run-a', sequence: 2 })]);
    state = bindSubagentSession(state, sessionB);
    state = applyDeltaBatch(state, batch([textDelta(3, 'stale', { sessionId: sessionA, subagentId: 'a', runId: 'run-a' })], sessionA));
    state = applyDeltaBatch(state, batch([textDelta(1, 'new', { sessionId: sessionB, subagentId: 'b', runId: 'run-b' })], sessionB));
    expect(state.buffered).toHaveLength(1);
    state = seedSubagentSnapshot(state, snapshot(sessionB, 1, [record('b', 'running')], [
      projection({ subagentId: 'b', runId: 'run-b', sequence: 0, sessionId: sessionB }),
    ]));
    expect(state.live.get('b')?.sequence).toBe(1);
    expect(state.live.get('b')?.segments).toEqual([{ kind: 'text', id: 'seg-text', content: 'new' }]);
    expect(state.records.map((item) => item.id)).toEqual(['b']);
  });

  it('deduplicates redelivered buffered events without state change', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    const event = textDelta(1, 'a', { sessionRevision: 1 });
    state = applyDeltaBatch(state, batch([event]));
    expect(state.buffered).toHaveLength(1);
    expect(applyDeltaBatch(state, batch([event]))).toBe(state);
  });

  it('discards buffered events past the byte bound and records the newest revision as the floor', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    const first = textDelta(1, 'x'.repeat(1500), { sessionRevision: 5 });
    state = applyDeltaBatch(state, batch([first]), { hydrationBufferBytes: 2048 });
    expect(state.buffered).toHaveLength(1);
    expect(state.bufferedBytes).toBe(estimateDeltaBytes(first));
    expect(state.reseedFloor).toBeNull();

    const second = textDelta(2, 'y'.repeat(1500), { sessionRevision: 7 });
    const third = textDelta(3, 'z', { sessionRevision: 6 });
    state = applyDeltaBatch(state, batch([second, third]), { hydrationBufferBytes: 2048 });
    expect(state.buffered).toHaveLength(0);
    expect(state.bufferedBytes).toBe(0);
    expect(state.reseedFloor).toBe(7);
    expect(state.hydration).toBe('loading');
  });

  it('rejects a below-floor snapshot without state change', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    state = applyDeltaBatch(
      state,
      batch([textDelta(1, 'x'.repeat(1500), { sessionRevision: 5 }), textDelta(2, 'y'.repeat(1500), { sessionRevision: 7 })]),
      { hydrationBufferBytes: 2048 },
    );
    expect(state.reseedFloor).toBe(7);
    expect(seedSubagentSnapshot(state, snapshot(sessionA, 6, [record('one', 'running')]))).toBe(state);
    expect(state.records).toHaveLength(0);
    expect(state.hydration).toBe('loading');
  });

  it('seeds from a snapshot at the floor and preserves newer in-flight deltas', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    state = applyDeltaBatch(
      state,
      batch([textDelta(1, 'x'.repeat(1500), { sessionRevision: 5 }), textDelta(2, 'y'.repeat(1500), { sessionRevision: 7 })]),
      { hydrationBufferBytes: 2048 },
    );
    expect(state.reseedFloor).toBe(7);

    // Newer events keep buffering after the overflow.
    state = applyDeltaBatch(state, batch([textDelta(3, 'c', { sessionRevision: 8 })]), { hydrationBufferBytes: 2048 });
    expect(state.buffered).toHaveLength(1);
    expect(state.reseedFloor).toBe(7);

    const seededProjection = projection({
      subagentId: 'one', sequence: 2,
      segments: [{ kind: 'text', id: 'seg-text', content: 'ab' }],
    });
    state = seedSubagentSnapshot(state, snapshot(sessionA, 7, [record('one', 'running')], [seededProjection]));
    expect(state.reseedFloor).toBeNull();
    expect(state.hydration).toBe('ready');
    expect(state.live.get('one')?.segments).toEqual([{ kind: 'text', id: 'seg-text', content: 'abc' }]);
    expect(state.live.get('one')?.sequence).toBe(3);
    expect(state.highWater.get('one')).toBe(3);
  });

  it('raises the floor when a later buffer cycle overflows again', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    state = applyDeltaBatch(
      state,
      batch([textDelta(1, 'x'.repeat(1500), { sessionRevision: 5 })]),
      { hydrationBufferBytes: 1024 },
    );
    expect(state.reseedFloor).toBe(5);
    state = applyDeltaBatch(
      state,
      batch([textDelta(2, 'y'.repeat(1500), { sessionRevision: 9 })]),
      { hydrationBufferBytes: 1024 },
    );
    expect(state.reseedFloor).toBe(9);
    expect(seedSubagentSnapshot(state, snapshot(sessionA, 8, []))).toBe(state);
    expect(seedSubagentSnapshot(state, snapshot(sessionA, 9, [])).reseedFloor).toBeNull();
  });
});

describe('snapshot hydration guards', () => {
  it('discards a superseded snapshot response by generation affinity', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    state = bindSubagentSession(state, sessionB);
    expect(seedSubagentSnapshot(state, snapshot(sessionA, 0, [record('a', 'completed')]))).toBe(state);
    expect(state.records).toHaveLength(0);
  });

  it('keeps selection through terminal handoff without retaining live state', () => {
    let state = seeded(sessionA, 1, [record('one', 'running')], [projection({ subagentId: 'one', sequence: 1 })]);
    const done = record('one', 'completed');
    state = applyDeltaBatch(state, batch([terminal('one', 'run-1', done, 2)]));
    expect(resolveSubagentSelection(state.records, { sessionId: sessionA, existingId: 'one', existingSessionId: sessionA })).toBe('one');
    expect(state.live.has('one')).toBe(false);
  });

  it('clears prior-session rows and represents explicit loading/error states', () => {
    let state = seeded(sessionA, 0, [record('a', 'completed')]);
    state = bindSubagentSession(state, sessionB);
    expect(state.records).toHaveLength(0);
    expect(state.hydration).toBe('loading');
    state = { ...state, hydration: 'error', error: 'retryable' };
    expect(state.error).toBe('retryable');
  });

  it('rejects a stale retry response after the current binding advances', () => {
    let state = seeded(sessionA, 0, [record('a', 'completed')]);
    const oldGeneration = state.generation;
    state = bindSubagentSession(state, sessionA);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, 0, [record('old', 'completed')]), oldGeneration)).toBe(false);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, 1, [record('new', 'completed')]), state.generation)).toBe(true);
  });

  it('refreshes the same session without blanking rows and accepts the fresh durable snapshot', () => {
    const stale = record('one', 'running');
    let state = seeded(sessionA, 1, [stale], [projection({ subagentId: 'one', sequence: 1 })]);
    const generation = state.generation;
    state = beginSubagentSnapshotRefresh(state, sessionA);
    expect(state.hydration).toBe('loading');
    expect(state.records).toEqual([stale]);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, 2, []), state.generation)).toBe(true);
    state = applyDeltaBatch(state, batch([textDelta(2, 'more', { sessionRevision: 2 })]));
    const fresh = { ...record('one', 'completed'), chain: { messages: [{ role: 'assistant', content: 'durable' }] } as SubagentRecord['chain'] };
    state = seedSubagentSnapshot(state, snapshot(sessionA, 2, [fresh], [projection({ subagentId: 'one', sequence: 1 })]));
    expect(state.generation).toBe(generation + 1);
    expect(state.records[0].chain.messages).toEqual([{ role: 'assistant', content: 'durable' }]);
    expect(state.live.get('one')?.sequence).toBe(2);
  });

  it('supersedes an older same-session refresh before a session switch', () => {
    let state = seeded(sessionA, 0, [record('a', 'completed')]);
    state = beginSubagentSnapshotRefresh(state, sessionA);
    const oldGeneration = state.generation;
    state = beginSubagentSnapshotRefresh(state, sessionA);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, 1, [record('old', 'completed')]), oldGeneration)).toBe(false);
    state = bindSubagentSession(state, sessionB);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, 1, [record('late', 'completed')]), state.generation)).toBe(false);
  });
});

describe('subagent usage summary identity (U5 history input)', () => {
  const tokenUsage = (prompt: number, completion: number): Usage => ({
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cached_tokens: 0,
  });

  const sourceWithUsage = (parentChainIndex: number | null, usage: Usage): SubagentUsageSource => ({
    parentChainIndex,
    chain: { messages: [{ usage }] } as SubagentUsageSource['chain'],
  });

  it('keeps summary identity across 100 text deltas and usage-free record churn', () => {
    expect(deriveSubagentUsageSummary([])).toBe(EMPTY_SUBAGENT_USAGE_SUMMARY);

    let state = seeded(sessionA, 0);
    let summary = deriveSubagentUsageSummary(state.records);
    state = applyDeltaBatch(state, batch([spawned('one', 'run-1', record('one', 'pending'))]));
    summary = deriveSubagentUsageSummary(state.records, summary);
    expect(summary).toBe(EMPTY_SUBAGENT_USAGE_SUMMARY);

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      state = applyDeltaBatch(state, batch([textDelta(sequence, `chunk-${sequence} `)]));
      expect(deriveSubagentUsageSummary(state.records, summary)).toBe(summary);
    }

    // A terminal without durable usage still leaves the history input untouched.
    state = applyDeltaBatch(state, batch([terminal('one', 'run-1', record('one', 'completed'), 101)]));
    expect(deriveSubagentUsageSummary(state.records, summary)).toBe(summary);
  });

  it('moves identity exactly once when durable usage lands, then holds', () => {
    const runUsage = tokenUsage(7, 3);
    let state = seeded(sessionA, 1, [record('one', 'running')], [projection({ subagentId: 'one', sequence: 1 })]);
    const summary = deriveSubagentUsageSummary(state.records);

    // Live usage deltas update projections only — the history input must not move.
    state = applyDeltaBatch(state, batch([
      { ...deltaBase(), sequence: 2, type: 'usage', usage: runUsage },
    ]));
    expect(state.live.get('one')?.usage).toEqual(runUsage);
    expect(deriveSubagentUsageSummary(state.records, summary)).toBe(summary);

    const done: SubagentRecord = {
      ...record('one', 'completed'),
      end_time: '2026-01-01T00:00:05.000Z',
      chain: { messages: [{ usage: runUsage }] } as SubagentRecord['chain'],
    };
    state = applyDeltaBatch(state, batch([terminal('one', 'run-1', done, 3, runUsage)]));
    const updated = deriveSubagentUsageSummary(state.records, summary);
    expect(updated).not.toBe(summary);
    expect(updated.byParentChain.get(-1)).toEqual(runUsage);
    expect(updated.total).toEqual(runUsage);

    // A snapshot reseed with equal numbers keeps the new identity.
    const reseeded = seedSubagentSnapshot(state, snapshot(sessionA, 4, [done]));
    expect(deriveSubagentUsageSummary(reseeded.records, updated)).toBe(updated);
  });

  it('attributes usage by parentChainIndex and treats equal numbers as identical', () => {
    const summary = deriveSubagentUsageSummary([sourceWithUsage(2, tokenUsage(10, 5))]);
    expect(summary.byParentChain.get(2)).toEqual(tokenUsage(10, 5));
    expect(summary.total).toEqual(tokenUsage(10, 5));

    // Same numbers from freshly computed records → identity preserved.
    expect(deriveSubagentUsageSummary([sourceWithUsage(2, { ...tokenUsage(10, 5) })], summary)).toBe(summary);

    const grown = deriveSubagentUsageSummary([
      sourceWithUsage(2, tokenUsage(10, 5)),
      sourceWithUsage(2, tokenUsage(1, 1)),
    ], summary);
    expect(grown).not.toBe(summary);
    expect(grown.byParentChain.get(2)).toEqual(tokenUsage(11, 6));
    expect(grown.total).toEqual(tokenUsage(11, 6));
  });

  it('compares summaries by numbers and keys, not by object identity', () => {
    const a = deriveSubagentUsageSummary([sourceWithUsage(1, tokenUsage(2, 2))]);
    const b = deriveSubagentUsageSummary([sourceWithUsage(1, tokenUsage(2, 2))]);
    expect(a).not.toBe(b);
    expect(subagentUsageSummaryEquals(a, b)).toBe(true);

    const otherKey = deriveSubagentUsageSummary([sourceWithUsage(9, tokenUsage(2, 2))]);
    expect(subagentUsageSummaryEquals(a, otherKey)).toBe(false);
  });
});
