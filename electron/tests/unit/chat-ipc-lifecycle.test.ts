import { resetHarness, setupChatIpcTest } from './chat-ipc-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import {
  clearNextRequestStop,
  requestNextRequestStop,
  shouldStopNextRequest,
} from '../../src/main/agents/next-request-stop';

const {
  mocks,
  waitForDoneCount,
  waitForChannelCount,
  makeSession,
} = setupChatIpcTest();

let chatIpc: typeof import('../../src/main/ipc/chat');

describe('chat IPC teardown and bgcmd bounds', () => {
  beforeEach(async () => {
    resetHarness();
    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.sessionManager._reset();
  });

  it('unregisterChatIPC releases MCP project leases for active agents', async () => {
    const projectRegistry = await import('../../src/main/mcp/project-registry');
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      selection,
      modelLabel: selection.modelId,
    });

    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'partial' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const sendResult = await chatSend(
      { sender: { id: 910, send } },
      { message: 'Hold open for teardown' },
    );
    expect(sendResult).toMatchObject({ status: 'started' });

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && mocks.streamChat.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(mocks.streamChat).toHaveBeenCalled();
    expect(projectRegistry.acquireProjectMCPManager).toHaveBeenCalled();

    chatIpc.unregisterChatIPC();
    chatIpc.registerChatIPC();

    expect(projectRegistry.releaseProjectMCPManager).toHaveBeenCalled();
    releaseStream?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('bgcmd:snapshot rejects lastN above the upper bound', async () => {
    const snap = mocks.handlers.get(IPC_CHANNELS.BG_CMD_SNAPSHOT);
    expect(snap).toBeDefined();

    await expect(
      snap!({ sender: { id: 911, send: vi.fn() } }, { commandId: 1, lastN: 1001 }),
    ).rejects.toThrow(/Invalid bgcmd:snapshot/);
  });

  it('bgcmd:snapshot accepts lastN at the upper bound', async () => {
    const snap = mocks.handlers.get(IPC_CHANNELS.BG_CMD_SNAPSHOT)!;

    const result = await snap(
      { sender: { id: 912, send: vi.fn() } },
      { commandId: 999_999, lastN: 1000 },
    );
    expect(result).toEqual({ found: false });
  });

  it('bgcmd:snapshot denies cross-session command tails (M-P1-001)', async () => {
    const ownerSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mocks.backgroundStore.entries.set(42, {
      sessionId: ownerSession,
      agentScopeId: 'main',
      tail: 'secret-output\n',
      exitCode: 0,
    });

    mocks.sessionManager._setActive({
      ...makeSession(otherSession),
      selection: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        modelId: 'vendor/path/model',
      },
    });

    const snap = mocks.handlers.get(IPC_CHANNELS.BG_CMD_SNAPSHOT)!;
    const denied = await snap(
      { sender: { id: 913, send: vi.fn() } },
      { commandId: 42, lastN: 50 },
    );
    expect(denied).toEqual({ found: false });

    const allowed = await snap(
      { sender: { id: 913, send: vi.fn() } },
      { commandId: 42, lastN: 50, sessionId: ownerSession },
    );
    expect(allowed).toEqual({
      found: true,
      tail: 'secret-output\n',
      exitCode: 0,
      running: false,
      interactive: false,
      owner: 'AGENT',
      command: '',
      agentScopeId: 'main',
    });
  });

  it('bgcmd:snapshot allows subagent-scoped tails within the same session', async () => {
    const ownerSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mocks.backgroundStore.entries.set(43, {
      sessionId: ownerSession,
      agentScopeId: 'subagent-xyz',
      tail: 'subagent-output\n',
      exitCode: null,
    });
    mocks.sessionManager._setActive({
      ...makeSession(ownerSession),
      selection: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        modelId: 'vendor/path/model',
      },
    });

    const snap = mocks.handlers.get(IPC_CHANNELS.BG_CMD_SNAPSHOT)!;
    const result = await snap(
      { sender: { id: 914, send: vi.fn() } },
      { commandId: 43, lastN: 50 },
    );
    expect(result).toEqual({
      found: true,
      tail: 'subagent-output\n',
      exitCode: null,
      running: true,
      interactive: false,
      owner: 'AGENT',
      command: '',
      agentScopeId: 'subagent-xyz',
    });
  });
});

describe('chat:cancel interrupt layers (issue #145)', () => {
  beforeEach(async () => {
    resetHarness();
    mocks.subagentManager.getStates.mockReturnValue([]);
    mocks.sendersById.clear();
    mocks.electronWebContents.fromId.mockReset();
    mocks.electronWebContents.fromId.mockImplementation(
      (id: number) => mocks.sendersById.get(id) ?? null,
    );
    mocks.electronWebContents.getAllWebContents.mockReset();
    mocks.electronWebContents.getAllWebContents.mockReturnValue([]);

    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.sessionManager._reset();
  });

  it('second Esc terminates only main-scoped processes and leaves subagents running', async () => {
    const sessionId = 'efefefef-efef-4efe-8efe-efefefefefef';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      selection,
      modelLabel: selection.modelId,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'subagents keep working' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });
    const send = vi.fn();
    const source = { id: 916, send };
    mocks.sessionManager._setActiveForWindow('916', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const chatCancel = mocks.handlers.get(IPC_CHANNELS.CHAT_CANCEL)!;

    await chatSend({ sender: source }, { message: 'Run the crew' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_CHUNK, 1);

    expect(await chatCancel({ sender: source }, { sessionId })).toMatchObject({ status: 'confirming' });
    expect(await chatCancel({ sender: source }, { sessionId })).toMatchObject({ status: 'confirming_subagents' });

    expect(mocks.backgroundStore.terminateScope).toHaveBeenCalledWith(sessionId, 'main');
    expect(mocks.backgroundStore.terminateSession).not.toHaveBeenCalled();
    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();

    releaseStream();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('keeps the subagent-cancel layer reachable after the main turn is gone', async () => {
    const sessionId = 'fdfdfdfd-fdfd-4fdf-8fdf-fdfdfdfdfdfd';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamResponses.push('turn finished');
    const send = vi.fn();
    const source = { id: 917, send };
    mocks.sessionManager._setActiveForWindow('917', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const chatCancel = mocks.handlers.get(IPC_CHANNELS.CHAT_CANCEL)!;

    await chatSend({ sender: source }, { message: 'Delegate everything' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_DONE, 1);
    // Let the finalize microtask dispose the ActiveAgent (post-interrupt-reset
    // state: no live main turn, subagents still running).
    await new Promise((resolve) => setTimeout(resolve, 20));

    mocks.subagentManager.getStates.mockReturnValue([
      { id: 'subagent-1', state: 'running' },
    ]);
    mocks.subagentManager.cancelRunning.mockReturnValue(['subagent-1']);
    expect(await chatCancel({ sender: source }, { sessionId })).toMatchObject({ status: 'confirming_subagents' });
    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();

    expect(await chatCancel({ sender: source }, { sessionId })).toMatchObject({ status: 'cancelled' });
    expect(mocks.subagentManager.cancelRunning).toHaveBeenCalledWith(sessionId);
    expect(mocks.backgroundStore.terminateSession).toHaveBeenCalledWith(sessionId);
    expect(mocks.completeSessionActivity).toHaveBeenCalled();
  });

  it('returns no_active_stream when no main turn and no running subagents exist', async () => {
    const sessionId = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
    mocks.sessionManager._setActive(makeSession(sessionId));
    const chatCancel = mocks.handlers.get(IPC_CHANNELS.CHAT_CANCEL)!;

    expect(await chatCancel({ sender: { id: 918, send: vi.fn() } }, { sessionId }))
      .toMatchObject({ status: 'no_active_stream' });
    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();
  });
});

describe('chat:send draft single-flight (M-P1-013)', () => {
  beforeEach(async () => {
    resetHarness();
    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.sessionManager._reset();
  });

  it('concurrent draft sends create only one session', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    // mockImplementationOnce (not mockImplementation): vi.clearAllMocks()
    // clears calls but NOT implementations, so a persistent implementation here
    // would shadow the harness default that serves later tests'
    // streamResponses/streamEventSequences queues.
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'ok' };
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const webContents = { id: 920, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;

    const first = chatSend(
      { sender: webContents },
      { message: 'First draft send', model: selection },
    );
    const second = chatSend(
      { sender: webContents },
      { message: 'Second draft send', model: selection },
    );
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(mocks.sessionManager.create).toHaveBeenCalledTimes(1);
    const statuses = [firstResult, secondResult].map(
      (r) => (r as { status: string }).status,
    );
    expect(statuses.filter((s) => s === 'started')).toHaveLength(1);
    expect(statuses).toContain('error');
  });
});

describe('chat:queue_next early-stop signaling', () => {
  const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  beforeEach(async () => {
    resetHarness();
    clearNextRequestStop(sessionId);
    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    clearNextRequestStop(sessionId);
    mocks.sessionManager._reset();
  });

  it('sets the early-stop flag for a valid sessionId', async () => {
    const queueNext = mocks.handlers.get(IPC_CHANNELS.CHAT_QUEUE_NEXT)!;
    await queueNext({ sender: { id: 930, send: vi.fn() } }, { sessionId });
    expect(shouldStopNextRequest(sessionId)).toBe(true);
  });

  it('is idempotent for repeated signals', async () => {
    const queueNext = mocks.handlers.get(IPC_CHANNELS.CHAT_QUEUE_NEXT)!;
    await queueNext({ sender: { id: 931, send: vi.fn() } }, { sessionId });
    await queueNext({ sender: { id: 931, send: vi.fn() } }, { sessionId });
    expect(shouldStopNextRequest(sessionId)).toBe(true);
  });

  it('throws on a payload missing sessionId', async () => {
    const queueNext = mocks.handlers.get(IPC_CHANNELS.CHAT_QUEUE_NEXT)!;
    await expect(
      queueNext({ sender: { id: 932, send: vi.fn() } }, {}),
    ).rejects.toThrow(/Invalid chat:queue_next payload/);
    expect(shouldStopNextRequest(sessionId)).toBe(false);
  });

  it('throws on a wrong-typed sessionId', async () => {
    const queueNext = mocks.handlers.get(IPC_CHANNELS.CHAT_QUEUE_NEXT)!;
    await expect(
      queueNext({ sender: { id: 933, send: vi.fn() } }, { sessionId: 123 }),
    ).rejects.toThrow(/Invalid chat:queue_next payload/);
    expect(shouldStopNextRequest(sessionId)).toBe(false);
  });

  it('clears the early-stop flag at chat:send turn start', async () => {
    requestNextRequestStop(sessionId);
    expect(shouldStopNextRequest(sessionId)).toBe(true);

    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 934, send } }, { message: 'continue' });
    await waitForDoneCount(send, 1);

    expect(shouldStopNextRequest(sessionId)).toBe(false);
  });
});
