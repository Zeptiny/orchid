// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentEvent, SubagentSnapshot } from '../../src/shared/types/ipc';
import type {
  SubagentDeltaEvent,
  SubagentLiveProjection,
  SubagentSummary,
} from '../../src/shared/types/subagent';
import { useSubagents } from '../../src/renderer/hooks/useSubagents';

const sessionId = '11111111-1111-4111-8111-111111111111';

const row: SubagentSummary = {
  id: 'one',
  agent_name: 'Explorer',
  agent_type: 'explorer',
  agent_tier: 'bloom',
  agentRole: 'explorer',
  task: 'Inspect the repository',
  status: 'running',
  chain_id: 'chain-one',
  start_time: '2026-01-01T00:00:00.000Z',
  end_time: null,
  parentChainIndex: 0,
  usage: null,
};

const runLive: SubagentLiveProjection = {
  sessionId,
  subagentId: 'one',
  runId: 'run-9',
  sequence: 1,
  state: 'running',
  segments: [],
  toolCalls: [],
  usage: null,
  result: null,
  error: null,
  compactionProgress: null,
};

function snapshot(revision: number, live: SubagentLiveProjection[] = []): SubagentSnapshot {
  return { sessionId, sessionRevision: revision, records: [row], live };
}

function wrongRunDelta(sequence: number): SubagentDeltaEvent {
  return {
    sessionId,
    subagentId: 'one',
    runId: 'run-9',
    sequence,
    sessionRevision: sequence,
    type: 'text_delta',
    segmentId: 'seg-text',
    append: `work-${sequence}`,
  };
}

function runDelta(sequence: number, append: string): SubagentDeltaEvent {
  return {
    sessionId,
    subagentId: 'one',
    runId: 'run-9',
    sequence,
    sessionRevision: sequence,
    type: 'text_delta',
    segmentId: 'seg-text',
    append,
  };
}

/** Snapshot mock resolving one manually-controlled deferred per call. */
function createSnapshotQueue() {
  const pending: Array<(value: SubagentSnapshot) => void> = [];
  const snapshotFn = vi.fn(
    () => new Promise<SubagentSnapshot>((resolve) => { pending.push(resolve); }),
  );
  const resolveNext = (value: SubagentSnapshot): void => {
    const resolve = pending.shift();
    if (resolve) resolve(value);
  };
  return { snapshotFn, resolveNext };
}

function installOrchid(snapshotFn: ReturnType<typeof createSnapshotQueue>['snapshotFn']): (event: SubagentEvent) => void {
  let listener: ((event: SubagentEvent) => void) | null = null;
  window.orchid = {
    config: { get: vi.fn().mockResolvedValue({ subagents: { hydration_buffer_kb: 256 } }) },
    session: { onSubagentsChanged: () => () => undefined },
    subagents: {
      snapshot: snapshotFn,
      detail: vi.fn(),
      onEvent: (cb: (event: SubagentEvent) => void) => {
        listener = cb;
        return () => { listener = null; };
      },
    },
  } as never;
  return (event) => { listener?.(event); };
}

describe('useSubagents seed-hint self-heal', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('retries the bounded reseed when a stale snapshot omits the hinted run', async () => {
    const queue = createSnapshotQueue();
    const emit = installOrchid(queue.snapshotFn);
    const { result } = renderHook(() => useSubagents(sessionId));

    // A wrong-run delta arrives while the initial hydrate is still loading:
    // it buffers, then replays after the seed.
    await waitFor(() => expect(queue.snapshotFn).toHaveBeenCalledTimes(1));
    act(() => emit({ sessionId, events: [wrongRunDelta(1)] }));

    // The landing snapshot omits the run: the replay re-raises the hint, and
    // hydrate's post-seed check drives one retry.
    await act(async () => { queue.resolveNext(snapshot(4)); });
    await waitFor(() => expect(queue.snapshotFn).toHaveBeenCalledTimes(2));

    // The retry's snapshot carries the run: seeded, hint cleared, streaming.
    await act(async () => { queue.resolveNext(snapshot(5, [runLive])); });
    await waitFor(() => expect(result.current.getLive('one')?.runId).toBe('run-9'));

    // The dropped wrong-run text is gone by design (snapshots never carry
    // it); post-seed content for the now-known run streams normally.
    act(() => emit({ sessionId, events: [runDelta(2, ' more')] }));
    await waitFor(() => expect(result.current.getLive('one')?.segments.at(-1)).toMatchObject({ content: ' more' }));
    expect(queue.snapshotFn).toHaveBeenCalledTimes(2);
  });

  it('stops after the reseed budget and clears hints so a later run can re-heal', async () => {
    const queue = createSnapshotQueue();
    const emit = installOrchid(queue.snapshotFn);

    const { result } = renderHook(() => useSubagents(sessionId));
    await waitFor(() => expect(queue.snapshotFn).toHaveBeenCalledTimes(1));
    // Each loading window buffers one fresh wrong-run delta, so every seed's
    // replay re-raises the hint: initial + 3 retries = 4 snapshot calls.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      act(() => emit({ sessionId, events: [wrongRunDelta(attempt)] }));
      await act(async () => { queue.resolveNext(snapshot(4 + attempt)); });
      const expectedCalls = attempt + 1;
      if (attempt < 4) {
        await waitFor(() => expect(queue.snapshotFn).toHaveBeenCalledTimes(expectedCalls));
      } else {
        // The last attempt hits the budget: no further hydrate fires.
        await act(async () => { await Promise.resolve(); });
        expect(queue.snapshotFn).toHaveBeenCalledTimes(4);
      }
    }
    expect(result.current.state.status).toBe('ready');
    expect(result.current.getLive('one')).toBeNull();

    // The exhausted hints were cleared: a fresh wrong-run delta re-raises one
    // (observable as one more hydrate) instead of being swallowed by the
    // once-per-subagent guard.
    await act(async () => { await Promise.resolve(); });
    expect(queue.snapshotFn).toHaveBeenCalledTimes(4);
    act(() => emit({ sessionId, events: [wrongRunDelta(10)] }));
    await waitFor(() => expect(queue.snapshotFn).toHaveBeenCalledTimes(5));
    await act(async () => { queue.resolveNext(snapshot(10, [runLive])); });
    await waitFor(() => expect(result.current.getLive('one')?.runId).toBe('run-9'));
  });
});
