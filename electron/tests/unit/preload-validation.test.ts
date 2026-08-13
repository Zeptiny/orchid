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
import {
  IPC_CHANNELS,
  type ChatDoneEvent,
  type ChatErrorEvent,
  type OrchidAPI,
  type SubagentEvent,
} from '../../src/shared/types/ipc';

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
      agentRole: 'explorer',
      task: 'Inspect the project',
      status: 'completed',
      chain_id: 'chain-1',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:05.000Z',
      parentChainIndex: null,
      usage: null,
    },
    state: 'completed',
    usage: null,
  };
}

function terminalMessages(): Record<string, unknown>[] {
  return [
    {
      id: 'message-user',
      role: 'user',
      content: 'Read the file',
      type: 'text',
      tool_calls: null,
      tool_call_id: null,
      name: null,
      thinking: null,
      timestamp: '2026-07-31T00:00:00.000Z',
      usage: null,
      hidden: false,
      tool_result: null,
    },
    {
      id: 'message-call',
      role: 'assistant',
      content: '',
      type: 'tool_call',
      tool_calls: [{
        id: 'tool-1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"/tmp/a"}' },
      }],
      tool_call_id: 'tool-1',
      name: 'read',
      thinking: null,
      timestamp: '2026-07-31T00:00:01.000Z',
      usage: null,
      hidden: false,
      excludeFromModel: true,
      tool_result: null,
    },
    {
      id: 'message-result',
      role: 'tool',
      content: 'contents',
      type: 'tool_result',
      tool_calls: null,
      tool_call_id: 'tool-1',
      name: 'read',
      thinking: null,
      timestamp: '2026-07-31T00:00:02.000Z',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        cached_tokens: 0,
      },
      hidden: false,
      tool_result: {
        schemaVersion: 1,
        family: 'generic',
        status: 'complete',
        completeness: 'complete',
        data: { value: 'contents' },
      },
    },
  ];
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

describe('preload session history validation', () => {
  let api: OrchidAPI;

  beforeEach(async () => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    await import('../../src/preload/index');
    const exposed = electronMock.contextBridge.exposeInMainWorld.mock.calls
      .find(([name]) => name === 'orchid');
    if (!exposed) throw new Error('preload did not expose window.orchid');
    api = exposed[1] as OrchidAPI;
  });

  it('rejects malformed paged-history invoke results', async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      chainId: 'chain-1',
      messages: terminalMessages(),
      startIndex: -1,
      totalMessages: 3,
      complete: false,
    });

    await expect(api.session.loadHistoryPage({
      sessionId: SESSION_ID,
      chainId: 'chain-1',
    })).rejects.toThrow(/Invalid IPC response.*session:history_page/i);
  });

  it('accepts and preserves a well-formed paged-history invoke result', async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      chainId: 'chain-1',
      messages: terminalMessages(),
      startIndex: 0,
      totalMessages: 3,
      complete: true,
    });

    const page = await api.session.loadHistoryPage({
      sessionId: SESSION_ID,
      chainId: 'chain-1',
    });

    expect(page.messages.map((message) => message.id))
      .toEqual(['message-user', 'message-call', 'message-result']);
    expect(page.startIndex).toBe(0);
    expect(page.totalMessages).toBe(3);
    expect(page.complete).toBe(true);
  });
});

describe('preload session deletion validation', () => {
  let api: OrchidAPI;

  beforeEach(async () => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    electronMock.ipcRenderer.invoke.mockReset();
    await import('../../src/preload/index');
    const exposed = electronMock.contextBridge.exposeInMainWorld.mock.calls
      .find(([name]) => name === 'orchid');
    if (!exposed) throw new Error('preload did not expose window.orchid');
    api = exposed[1] as OrchidAPI;
  });

  it('rejects a deletion response without an authoritative working-set snapshot', async () => {
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({ status: 'deleted' });

    await expect(api.session.delete({ id: SESSION_ID }))
      .rejects.toThrow(/Invalid IPC response.*session:delete/i);
  });

  it('accepts and preserves a well-formed deletion response', async () => {
    const result = {
      status: 'deleted' as const,
      workingSet: {
        openSessionIds: ['session-2'],
        focusedSessionId: 'session-2',
        mruSessionIds: ['session-2'],
      },
    };
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce(result);

    await expect(api.session.delete({ id: SESSION_ID })).resolves.toEqual(result);
  });

  it('delivers only well-formed session deletion events', () => {
    const received: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.session.onDeleted((event) => received.push(event));
    const listener = electronMock.handlers.get(IPC_CHANNELS.SESSION_DELETED);
    if (!listener) throw new Error('session:deleted listener was not registered');
    const valid = {
      id: SESSION_ID,
      workingSet: {
        openSessionIds: ['session-2'],
        focusedSessionId: 'session-2',
        mruSessionIds: ['session-2'],
      },
    };

    listener({}, valid);
    listener({}, { id: SESSION_ID, workingSet: { openSessionIds: [] } });

    expect(received).toEqual([valid]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('preload terminal chat history validation', () => {
  let done: ChatDoneEvent[];
  let errors: ChatErrorEvent[];

  beforeEach(async () => {
    vi.resetModules();
    electronMock.handlers.clear();
    electronMock.contextBridge.exposeInMainWorld.mockClear();
    await import('../../src/preload/index');
    const exposed = electronMock.contextBridge.exposeInMainWorld.mock.calls
      .find(([name]) => name === 'orchid');
    if (!exposed) throw new Error('preload did not expose window.orchid');
    const api = exposed[1] as OrchidAPI;
    done = [];
    errors = [];
    api.chat.onDone((event) => done.push(event));
    api.chat.onError((event) => errors.push(event));
  });

  function emit(channel: string, payload: unknown): void {
    const listener = electronMock.handlers.get(channel);
    if (!listener) throw new Error(`no ${channel} listener registered`);
    listener({}, payload);
  }

  it('requires a meaningful durable history for done and error events', () => {
    const base = { sessionId: SESSION_ID, turnId: 'turn-1', sequence: 1 };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    emit(IPC_CHANNELS.CHAT_DONE, { ...base, type: 'done', response: 'done' });
    emit(IPC_CHANNELS.CHAT_ERROR, { ...base, type: 'error', error: 'failed' });
    emit(IPC_CHANNELS.CHAT_DONE, {
      ...base,
      sequence: 2,
      type: 'done',
      response: 'done',
      messages: [{ id: 'incomplete' }],
    });
    emit(IPC_CHANNELS.CHAT_ERROR, {
      ...base,
      sequence: 2,
      type: 'error',
      error: 'failed',
      messages: terminalMessages(),
    });

    expect(done).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.messages).toEqual(terminalMessages());
    expect(warn).toHaveBeenCalled();
  });
});
