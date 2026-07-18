import { describe, expect, it } from 'vitest';
import type { SubagentEvent, SubagentSnapshot } from '../../src/shared/types/ipc';
import type { SubagentRecord, SubagentLiveProjection } from '../../src/shared/types/subagent';
import {
  acceptSubagentEvent,
  beginSubagentSnapshotRefresh,
  bindSubagentSession,
  createSubagentStreamState,
  groupSubagents,
  isSubagentSnapshotAffine,
  resolveSubagentSelection,
  seedSubagentSnapshot,
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

function projection(id: string, runId: string, sequence: number, state: SubagentLiveProjection['state'] = 'running'): SubagentLiveProjection {
  return {
    sessionId: sessionA, subagentId: id, runId, sequence, state,
    segments: [{ kind: 'text', id: `${id}-text`, content: `text-${sequence}` }],
    toolCalls: [], usage: null, result: null, error: null,
  };
}

function event(sessionId: string, id: string, runId: string, sequence: number, state: SubagentLiveProjection['state'] = 'running'): SubagentEvent {
  return { sessionId, subagentId: id, runId, sequence, type: 'projection', projection: { ...projection(id, runId, sequence, state), sessionId } };
}

function snapshot(sessionId: string, records: SubagentRecord[], live: SubagentLiveProjection[] = []): SubagentSnapshot {
  return { sessionId, records, live: live.map((item) => ({ ...item, sessionId })) };
}

describe('subagent live snapshot/event reducer', () => {
  it('groups running and ended records newest first', () => {
    const result = groupSubagents([
      record('old-ended', 'completed', '2026-01-01T00:00:01Z'),
      record('new-running', 'running', '2026-01-01T00:00:03Z'),
      record('new-ended', 'failed', '2026-01-01T00:00:04Z'),
      record('old-running', 'pending', '2026-01-01T00:00:02Z'),
    ]);
    expect(result.running.map((item) => item.id)).toEqual(['new-running', 'old-running']);
    expect(result.ended.map((item) => item.id)).toEqual(['new-ended', 'old-ended']);
  });

  it('resolves requested, existing, then newest running/ended selection', () => {
    const records = [record('ended', 'completed', '2026-01-01T00:00:04Z'), record('running', 'running', '2026-01-01T00:00:03Z')];
    expect(resolveSubagentSelection(records, { sessionId: sessionA, requestedId: 'ended' })).toBe('ended');
    expect(resolveSubagentSelection(records, { sessionId: sessionA, requestedId: 'missing' })).toBe('running');
    expect(resolveSubagentSelection(records, { sessionId: sessionA, existingId: 'ended', existingSessionId: sessionA })).toBe('ended');
  });

  it('applies only matching content and terminal projections', () => {
    let state = seedSubagentSnapshot(bindSubagentSession(createSubagentStreamState(), sessionA), snapshot(sessionA, [record('one', 'running')], [projection('one', 'run-1', 1)]));
    state = acceptSubagentEvent(state, event(sessionA, 'one', 'run-1', 2));
    expect(state.live.get('one')?.sequence).toBe(2);
    expect(state.live.get('one')?.segments[0]).toMatchObject({ content: 'text-2' });
    state = acceptSubagentEvent(state, event(sessionA, 'one', 'run-1', 3, 'completed'));
    expect(state.live.has('one')).toBe(false);
    expect(state.records[0].status).toBe('completed');
  });

  it('seeds an unknown run from event metadata after an empty hydration', () => {
    let state = seedSubagentSnapshot(
      bindSubagentSession(createSubagentStreamState(), sessionA),
      snapshot(sessionA, []),
    );
    const seeded = record('new-run', 'running');
    const liveEvent = {
      ...event(sessionA, 'new-run', 'run-new', 1),
      record: seeded,
    };
    state = acceptSubagentEvent(state, liveEvent);
    expect(state.records.map((item) => item.id)).toEqual(['new-run']);
    expect(state.records[0].status).toBe('running');
    expect(state.live.get('new-run')?.segments[0].id).toBe('new-run-text');
    expect(state.highWater.get('new-run')).toBe(1);
  });

  it('uses the terminal event record to preserve durable transcript continuity', () => {
    let state = seedSubagentSnapshot(
      bindSubagentSession(createSubagentStreamState(), sessionA),
      snapshot(sessionA, []),
    );
    const terminalRecord = {
      ...record('terminal', 'completed'),
      chain: { messages: [{ id: 'durable', content: 'finished' }] } as SubagentRecord['chain'],
    };
    state = acceptSubagentEvent(state, {
      ...event(sessionA, 'terminal', 'run-terminal', 2, 'completed'),
      record: terminalRecord,
    });
    expect(state.records[0].chain.messages[0]).toMatchObject({ id: 'durable', content: 'finished' });
    expect(state.live.has('terminal')).toBe(false);
  });

  it('rejects duplicate, out-of-order, wrong-run, and wrong-subagent events', () => {
    let state = seedSubagentSnapshot(bindSubagentSession(createSubagentStreamState(), sessionA), snapshot(sessionA, [record('one', 'running')], [projection('one', 'run-1', 3)]));
    const original = state;
    expect(acceptSubagentEvent(state, event(sessionA, 'one', 'run-1', 3))).toBe(original);
    expect(acceptSubagentEvent(state, event(sessionA, 'one', 'run-1', 2))).toBe(original);
    expect(acceptSubagentEvent(state, event(sessionA, 'one', 'run-2', 4))).toBe(original);
    expect(acceptSubagentEvent(state, event(sessionA, 'other', 'run-1', 4))).toBe(original);
  });

  it('buffers target-session events across a session rebind and replays newer B events only', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    state = seedSubagentSnapshot(state, snapshot(sessionA, [record('a', 'running')], [projection('a', 'run-a', 2)]));
    state = bindSubagentSession(state, sessionB);
    state = acceptSubagentEvent(state, event(sessionA, 'a', 'run-a', 3));
    state = acceptSubagentEvent(state, event(sessionB, 'b', 'run-b', 1));
    expect(state.buffered).toHaveLength(1);
    state = seedSubagentSnapshot(state, snapshot(sessionB, [record('b', 'running')], [projection('b', 'run-b', 0)]));
    expect(state.live.get('b')?.sequence).toBe(1);
    expect(state.records.map((item) => item.id)).toEqual(['b']);
  });

  it('discards a superseded snapshot response by generation affinity', () => {
    let state = bindSubagentSession(createSubagentStreamState(), sessionA);
    state = bindSubagentSession(state, sessionB);
    expect(seedSubagentSnapshot(state, snapshot(sessionA, [record('a', 'completed')]))).toBe(state);
    expect(state.records).toHaveLength(0);
  });

  it('keeps selection through terminal handoff without retaining live state', () => {
    let state = seedSubagentSnapshot(bindSubagentSession(createSubagentStreamState(), sessionA), snapshot(sessionA, [record('one', 'running')], [projection('one', 'run-1', 1)]));
    state = acceptSubagentEvent(state, event(sessionA, 'one', 'run-1', 2, 'completed'));
    expect(resolveSubagentSelection(state.records, { sessionId: sessionA, existingId: 'one', existingSessionId: sessionA })).toBe('one');
    expect(state.live.has('one')).toBe(false);
  });

  it('clears prior-session rows and represents explicit loading/error states', () => {
    let state = seedSubagentSnapshot(bindSubagentSession(createSubagentStreamState(), sessionA), snapshot(sessionA, [record('a', 'completed')]));
    state = bindSubagentSession(state, sessionB);
    expect(state.records).toHaveLength(0);
    expect(state.hydration).toBe('loading');
    state = { ...state, hydration: 'error', error: 'retryable' };
    expect(state.error).toBe('retryable');
  });

  it('rejects a stale retry response after the current binding advances', () => {
    let state = seedSubagentSnapshot(bindSubagentSession(createSubagentStreamState(), sessionA), snapshot(sessionA, [record('a', 'completed')]));
    const oldGeneration = state.generation;
    state = bindSubagentSession(state, sessionA);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, [record('old', 'completed')]), oldGeneration)).toBe(false);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, [record('new', 'completed')]), state.generation)).toBe(true);
  });

  it('refreshes the same session without blanking rows and accepts the fresh durable snapshot', () => {
    const stale = record('one', 'running');
    let state = seedSubagentSnapshot(
      bindSubagentSession(createSubagentStreamState(), sessionA),
      snapshot(sessionA, [stale], [projection('one', 'run-1', 1)]),
    );
    const generation = state.generation;
    state = beginSubagentSnapshotRefresh(state, sessionA);
    expect(state.hydration).toBe('loading');
    expect(state.records).toEqual([stale]);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, []), state.generation)).toBe(true);
    state = acceptSubagentEvent(state, event(sessionA, 'one', 'run-1', 2));
    const fresh = { ...record('one', 'completed'), chain: { messages: [{ role: 'assistant', content: 'durable' }] } as SubagentRecord['chain'] };
    state = seedSubagentSnapshot(state, snapshot(sessionA, [fresh], [projection('one', 'run-1', 1)]));
    expect(state.generation).toBe(generation + 1);
    expect(state.records[0].chain.messages).toEqual([{ role: 'assistant', content: 'durable' }]);
    expect(state.live.get('one')?.sequence).toBe(2);
  });

  it('supersedes an older same-session refresh before a session switch', () => {
    let state = seedSubagentSnapshot(bindSubagentSession(createSubagentStreamState(), sessionA), snapshot(sessionA, [record('a', 'completed')]));
    state = beginSubagentSnapshotRefresh(state, sessionA);
    const oldGeneration = state.generation;
    state = beginSubagentSnapshotRefresh(state, sessionA);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, [record('old', 'completed')]), oldGeneration)).toBe(false);
    state = bindSubagentSession(state, sessionB);
    expect(isSubagentSnapshotAffine(state, snapshot(sessionA, [record('late', 'completed')]), state.generation)).toBe(false);
  });
});
