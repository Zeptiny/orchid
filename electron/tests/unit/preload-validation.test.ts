/**
 * Preload boundary validation for SUBAGENTS_EVENT.
 *
 * Deltas have no retry path: envelope-level (atomic) validation used to drop a
 * whole budgeted flush when one member was malformed, losing co-batched
 * terminal handoffs for unrelated subagents and leaving the renderer stuck
 * running. The boundary now validates the envelope shell atomically but each
 * `events[]` member individually, delivering the valid subset and logging the
 * dropped members' types/ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type OrchidAPI, type SubagentEvent } from '../../src/shared/types/ipc';

type IpcEventHandler = (event: unknown, ...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcEventHandler>();
  return {
    handlers,
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: {
      on: vi.fn((channel: string, handler: IpcEventHandler) => {
        handlers.set(channel, handler);
      }),
      removeListener: vi.fn(),
      invoke: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
}));

const SESSION_ID = '6b7ed8a2-3f3f-4c4f-9b3a-9f0a1b2c3d4e';

function textDelta(sequence: number): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    subagentId: 'sub-1',
    runId: 'run-1',
    sequence,
    sessionRevision: sequence,
    type: 'text_delta',
    segmentId: 'seg-1',
    append: `chunk ${sequence}`,
  };
}

function terminalEvent(sequence: number): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    subagentId: 'sub-2',
    runId: 'run-2',
    sequence,
    sessionRevision: sequence,
    type: 'terminal',
    record: {
      id: 'sub-2',
      agent_name: 'Explorer',
      agent_type: 'explorer',
      agent_tier: 'bloom',
      task: 'Inspect the project',
      status: 'completed',
      chain_id: 'chain-1',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:05.000Z',
      result: 'done',
      error: null,
      parentChainIndex: null,
      chain: { messages: [] },
    },
    state: 'completed',
    usage: null,
  };
}

describe('preload SUBAGENTS_EVENT validation', () => {
  let received: SubagentEvent[];

  beforeEach(async () => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    electronMock.ipcRenderer.removeListener.mockReset();
    await import('../../src/preload/index');
    const exposed = electronMock.contextBridge.exposeInMainWorld.mock.calls
      .find(([name]) => name === 'orchid');
    if (!exposed) throw new Error('preload did not expose window.orchid');
    const api = exposed[1] as OrchidAPI;
    received = [];
    api.subagents.onEvent((event) => received.push(event));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function emit(payload: unknown): void {
    const handler = electronMock.handlers.get(IPC_CHANNELS.SUBAGENTS_EVENT);
    if (!handler) throw new Error('no SUBAGENTS_EVENT listener registered');
    handler({}, payload);
  }

  it('delivers the valid members of a partially malformed batch and warns about the dropped one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const malformed = {
      sessionId: SESSION_ID,
      subagentId: 'sub-3',
      type: 'text_delta',
      // missing runId, sequence, sessionRevision, segmentId, append
    };

    emit({ sessionId: SESSION_ID, events: [textDelta(1), malformed, terminalEvent(2)] });

    expect(received).toHaveLength(1);
    expect(received[0]?.sessionId).toBe(SESSION_ID);
    expect(received[0]?.events.map((event) => event.type)).toEqual(['text_delta', 'terminal']);
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0]?.map(String).join(' ') ?? '';
    expect(warning).toContain('text_delta');
    expect(warning).toContain('sub-3');
  });

  it('delivers a fully valid envelope atomically without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    emit({ sessionId: SESSION_ID, events: [textDelta(1), terminalEvent(2)] });

    expect(received).toHaveLength(1);
    expect(received[0]?.events).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops the whole batch when the envelope shell is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    emit({ events: [textDelta(1), terminalEvent(2)] });

    expect(received).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('preload startup validation', () => {
  beforeEach(async () => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    electronMock.ipcRenderer.removeListener.mockReset();
    await import('../../src/preload/index');
  });

  it('drops malformed startup events and cleans up the listener', () => {
    const exposed = electronMock.contextBridge.exposeInMainWorld.mock.calls
      .find(([name]) => name === 'orchid');
    if (!exposed) throw new Error('preload did not expose window.orchid');
    const api = exposed[1] as OrchidAPI;
    const received = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const dispose = api.startup.onChanged(received);
    const listener = electronMock.handlers.get(IPC_CHANNELS.STARTUP_CHANGED);
    if (!listener) throw new Error('no STARTUP_CHANGED listener registered');
    listener({}, { revision: -1, phase: 'ready', steps: [] });

    expect(received).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    dispose();
    expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.STARTUP_CHANGED,
      expect.any(Function),
    );
  });

  it('rejects malformed startup snapshots from the invoke boundary', async () => {
    const exposed = electronMock.contextBridge.exposeInMainWorld.mock.calls
      .find(([name]) => name === 'orchid');
    if (!exposed) throw new Error('preload did not expose window.orchid');
    const api = exposed[1] as OrchidAPI;
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({ revision: 0, phase: 'starting', steps: [] });

    await expect(api.startup.snapshot()).rejects.toThrow(/Invalid IPC response.*startup:snapshot/i);
  });
});
