// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRecord, SubagentSummary } from '../../src/shared/types/subagent';
import { useSubagents } from '../../src/renderer/hooks/useSubagents';

const sessionId = '11111111-1111-4111-8111-111111111111';

const summary: SubagentSummary = {
  id: 'subagent-selected',
  agent_name: 'Explorer',
  agent_type: 'explorer',
  agent_tier: 'bloom',
  agentRole: 'explorer',
  task: 'Inspect the repository',
  status: 'completed',
  chain_id: 'chain-selected',
  start_time: '2026-01-01T00:00:00.000Z',
  end_time: '2026-01-01T00:00:01.000Z',
  parentChainIndex: 0,
  usage: null,
};

const transcript = {
  ...summary,
  result: 'done',
  error: null,
  closed: false,
  chain: {
    id: summary.chain_id,
    sessionId,
    messages: [],
    status: 'completed',
    selection: null,
    modelLabel: null,
    agentName: 'explorer',
    agentType: 'subagent',
    agentTier: 'bloom',
    subagentRecord: null,
    startTime: summary.start_time,
    endTime: summary.end_time,
  },
} as SubagentRecord;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function transcriptFor(row: SubagentSummary): SubagentRecord {
  return {
    ...transcript,
    id: row.id,
    agent_name: row.agent_name,
    task: row.task,
    chain_id: row.chain_id,
    chain: { ...transcript.chain, id: row.chain_id },
  };
}

describe('useSubagents lazy transcript hydration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads summaries first and fetches only the selected transcript', async () => {
    const detail = vi.fn().mockResolvedValue({
      sessionId,
      subagentId: summary.id,
      record: transcript,
    });
    window.orchid = {
      config: { get: vi.fn().mockResolvedValue({ subagents: { hydration_buffer_kb: 256 } }) },
      session: { onSubagentsChanged: () => () => undefined },
      subagents: {
        snapshot: vi.fn().mockResolvedValue({
          sessionId,
          sessionRevision: 1,
          records: [summary],
          live: [],
        }),
        detail,
        onEvent: () => () => undefined,
      },
    } as never;

    const { result } = renderHook(() => useSubagents(sessionId));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(detail).not.toHaveBeenCalled();
    expect(result.current.subagents[0]).not.toHaveProperty('chain');

    act(() => result.current.select(summary.id));

    await waitFor(() => expect(result.current.transcript.status).toBe('ready'));
    expect(detail).toHaveBeenCalledOnce();
    expect(detail).toHaveBeenCalledWith({ sessionId, subagentId: summary.id });
    expect(result.current.transcript).toEqual({ status: 'ready', record: transcript });
  });

  it('ignores a late transcript response after another row is selected', async () => {
    const second = {
      ...summary,
      id: 'subagent-second',
      agent_name: 'Worker',
      chain_id: 'chain-second',
      task: 'Implement the fix',
    };
    const firstRequest = deferred<{
      sessionId: string;
      subagentId: string;
      record: SubagentRecord;
    }>();
    const secondRequest = deferred<{
      sessionId: string;
      subagentId: string;
      record: SubagentRecord;
    }>();
    const detail = vi.fn(({ subagentId }: { subagentId: string }) => (
      subagentId === summary.id ? firstRequest.promise : secondRequest.promise
    ));
    window.orchid = {
      config: { get: vi.fn().mockResolvedValue({ subagents: { hydration_buffer_kb: 256 } }) },
      session: { onSubagentsChanged: () => () => undefined },
      subagents: {
        snapshot: vi.fn().mockResolvedValue({
          sessionId,
          sessionRevision: 1,
          records: [summary, second],
          live: [],
        }),
        detail,
        onEvent: () => () => undefined,
      },
    } as never;

    const { result } = renderHook(() => useSubagents(sessionId));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => result.current.select(summary.id));
    await waitFor(() => expect(detail).toHaveBeenCalledWith({ sessionId, subagentId: summary.id }));
    act(() => result.current.select(second.id));
    await waitFor(() => expect(detail).toHaveBeenCalledWith({ sessionId, subagentId: second.id }));

    await act(async () => {
      secondRequest.resolve({ sessionId, subagentId: second.id, record: transcriptFor(second) });
    });
    await waitFor(() => expect(result.current.transcript).toEqual({
      status: 'ready',
      record: transcriptFor(second),
    }));

    await act(async () => {
      firstRequest.resolve({ sessionId, subagentId: summary.id, record: transcript });
    });
    expect(result.current.transcript).toEqual({
      status: 'ready',
      record: transcriptFor(second),
    });
  });
});
