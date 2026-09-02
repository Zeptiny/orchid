import { setupChatIpcTest } from './chat-ipc-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import { ensureActiveSession } from '../../src/main/host/chat/session';
import {
  discardDeletedSessionRuntime,
  forceAbortMainTurn,
} from '../../src/main/host/chat/abort';
import { OPENAI_TIER_MECHANISM } from '../../src/main/providers/drivers/native';

const {
  mocks,
  successfulToolResult,
  cancelledToolResult,
  doneEvents,
  channelEvents,
  waitForDoneCount,
  waitForChannelCount,
  makeSession,
} = setupChatIpcTest();

let chatIpc: typeof import('../../src/main/ipc/chat');

describe('chat session selection gate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.runtimeRegistry._reset();
    mocks.sessionManager._reset();
    mocks.backgroundStore._reset();
    chatIpc = await import('../../src/main/ipc/chat');
  });

  it('persists an explicit send selection before resolving an existing session turn', () => {
    const previous = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'old/provider/model',
    };
    const preferred = {
      connectionId: '22222222-2222-4222-8222-222222222222',
      modelId: 'new/provider/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
      selection: previous,
      modelLabel: previous.modelId,
    });

    const result = ensureActiveSession(
      { id: 906, send: vi.fn() } as never,
      preferred,
    );

    expect(result).toMatchObject({ ok: true, session: { selection: preferred } });
    expect(mocks.sessionManager.changeModel).toHaveBeenCalledWith(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      preferred,
      preferred.modelId,
    );
  });

  it('resolves requestedSessionId via getSession without switchTo (M-P1-007)', () => {
    const viewing = {
      ...makeSession('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      selection: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        modelId: 'viewing/model',
      },
    };
    const background = {
      ...makeSession('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      selection: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        modelId: 'background/model',
      },
    };
    mocks.sessionManager._setActive(viewing);
    mocks.sessionManager._putSession(background);

    const result = ensureActiveSession(
      { id: 907, send: vi.fn() } as never,
      null,
      background.id,
    );

    expect(result).toMatchObject({ ok: true, session: { id: background.id } });
    expect(mocks.sessionManager.switchTo).not.toHaveBeenCalled();
    expect(mocks.sessionManager.getSession).toHaveBeenCalledWith(background.id);
    expect(mocks.sessionManager.getActive()).toMatchObject({ id: viewing.id });
  });

  it('transfers a draft reasoning override into the session created from a draft', () => {
    mocks.takeDraftReasoningOverride.mockReturnValueOnce('high');
    const preferred = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };

    const result = ensureActiveSession(
      { id: 908, send: vi.fn() } as never,
      preferred,
    );

    expect(mocks.sessionManager.create).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManager.setReasoningEffortOverride).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'high',
    );
    expect(result).toMatchObject({
      ok: true,
      session: { reasoningEffortOverride: 'high' },
    });
  });
});

describe('chat IPC driver streaming', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.subagentManager.cancelRunning.mockClear();
    mocks.runtimeRegistry._reset();
    mocks.electronWebContents.fromId.mockReset();
    mocks.sendersById.clear();
    mocks.electronWebContents.fromId.mockImplementation(
      (id: number) => mocks.sendersById.get(id) ?? null,
    );
    mocks.electronWebContents.getAllWebContents.mockReset();
    mocks.electronWebContents.getAllWebContents.mockReturnValue([]);
    mocks.sessionManager._reset();

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

  it('main-turn-only abort leaves subagents and background commands running', () => {
    forceAbortMainTurn('11111111-1111-4111-8111-111111111111');

    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();
    expect(mocks.backgroundStore.terminateSession).not.toHaveBeenCalled();
  });

  it('keeps prior model history out of terminal renderer events', async () => {
    const sessionId = '89898989-8989-4989-8989-898989898989';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      selection,
      model: selection.modelId,
      modelLabel: selection.modelId,
    });
    mocks.sessionManager._setModelHistory([{
      id: 'old-history-message',
      role: MessageRole.USER,
      content: 'A very old request',
      type: MessageType.TEXT,
      tool_calls: null,
      tool_call_id: null,
      name: null,
      thinking: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      usage: null,
      hidden: false,
      tool_result: null,
    }]);
    mocks.streamResponses.push('Current answer');

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 612, send } }, { message: 'Current request' });
    await waitForDoneCount(send, 1);

    const done = doneEvents(send).at(-1)?.[1] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(done.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'old-history-message' }),
    ]));
    expect(done.messages).toEqual(
      mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0]?.messages,
    );
    expect(done.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: MessageRole.USER, content: 'Current request' }),
      expect.objectContaining({ role: MessageRole.ASSISTANT, content: 'Current answer' }),
    ]));
  });

  it('fails closed when complete model history cannot be loaded and permits retry', async () => {
    const sessionId = '78787878-7878-4787-8787-787878787878';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      selection,
      model: selection.modelId,
      modelLabel: selection.modelId,
    });
    mocks.sessionManager.getModelHistory
      .mockImplementationOnce(() => {
        throw new Error('database temporarily unavailable');
      })
      .mockReturnValueOnce([]);

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const failed = await chatSend(
      { sender: { id: 613, send } },
      { message: 'Must retain context' },
    );
    expect(failed).toEqual(expect.objectContaining({
      status: 'error',
      kind: 'history_load_failed',
      error: expect.stringContaining('database temporarily unavailable'),
    }));
    expect(mocks.sessionManager.startChain).not.toHaveBeenCalled();
    expect(mocks.providerRuntime.resolveTierContext).not.toHaveBeenCalled();

    mocks.streamResponses.push('Safe retry');
    const retried = await chatSend(
      { sender: { id: 613, send } },
      { message: 'Must retain context' },
    );
    expect(retried).toEqual(expect.objectContaining({ status: 'started', sessionId }));
    await waitForDoneCount(send, 1);
  });

  it('visible main-turn abort persists interruption and resets the renderer', async () => {
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
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
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Waiting for your choice' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const webContents = { id: 603, send };
    mocks.electronWebContents.fromId.mockReturnValue(webContents);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend(
      { sender: webContents },
      { message: 'Ask before continuing' },
    );
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_CHUNK, 1);

    forceAbortMainTurn(sessionId, { emitTerminalEvents: true });
    expect(doneEvents(send).at(-1)?.[1]).toMatchObject({
      type: 'done',
      response: 'Waiting for your choice',
      interrupted: true,
    });
    expect(doneEvents(send).at(-1)?.[1]?.messages).toEqual(
      mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0]?.messages,
    );
    expect(channelEvents(send, IPC_CHANNELS.CHAT_STATE).at(-1)?.[1]).toMatchObject({
      state: 'idle',
      interruptState: 'idle',
    });
    expect(mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'interrupted',
    });
    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();
    expect(mocks.backgroundStore.terminateSession).not.toHaveBeenCalled();
    releaseStream?.();
  });

  it('persists partial history before emitting an authoritative provider error', async () => {
    const sessionId = 'abababab-abab-4aba-8aba-abababababab';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Partial response' };
      yield { type: 'error', detail: 'Provider disconnected', title: 'Stream Error' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 606, send } }, { message: 'Trigger error' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_ERROR, 1);

    const error = channelEvents(send, IPC_CHANNELS.CHAT_ERROR).at(-1)?.[1] as {
      messages: Array<Record<string, unknown>>;
    };
    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(error.messages).toEqual(persisted.messages);
    expect(error.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: MessageRole.USER, content: 'Trigger error' }),
      expect.objectContaining({ role: MessageRole.ASSISTANT, content: 'Partial response' }),
    ]));
    expect(send.mock.calls.findIndex(([channel]) => channel === IPC_CHANNELS.SESSION_UPDATED))
      .toBeLessThan(send.mock.calls.findIndex(([channel]) => channel === IPC_CHANNELS.CHAT_ERROR));
  });

  it('keeps chunk-only updates out of CHAT_STATE payloads', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('abababab-abab-4aba-8aba-abababababab'),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    let releaseSecondChunk: (() => void) | undefined;
    let releaseFinish: (() => void) | undefined;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'a' };
      await secondChunkGate;
      yield { type: 'content', text: 'b' };
      yield { type: 'content', text: 'c' };
      await finishGate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 604, send } }, { message: 'Stream chunks' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_CHUNK, 1);
    const stateEventsBeforeMoreChunks = channelEvents(send, IPC_CHANNELS.CHAT_STATE);

    releaseSecondChunk!();
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_CHUNK, 3);

    const stateEventsAfterMoreChunks = channelEvents(send, IPC_CHANNELS.CHAT_STATE);
    expect(stateEventsAfterMoreChunks).toHaveLength(stateEventsBeforeMoreChunks.length);
    expect(stateEventsAfterMoreChunks.map(([, event]) => event)).not.toContainEqual(
      expect.objectContaining({ response: expect.any(String) }),
    );
    expect(mocks.sessionManager.updateActiveChainMessages).not.toHaveBeenCalled();

    releaseFinish!();
    await waitForDoneCount(send, 1);
  });

  it('checkpoints active turn messages at provider step boundaries', async () => {
    const sessionId = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
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
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'thinking', text: 'Inspecting the workspace' };
      yield {
        type: 'tool_call',
        toolCallId: 'tc-checkpoint-1',
        toolName: 'read',
        args: '{"path":"README.md"}',
      };
      yield successfulToolResult('tc-checkpoint-1', 'Orchid');
      yield { type: 'content', text: 'Checking files' };
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 10,
        },
      };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 605, send } }, { message: 'Keep this turn durable' });
    await vi.waitFor(() => {
      expect(mocks.sessionManager.updateActiveChainMessages).toHaveBeenCalledTimes(1);
    });

    const [checkpoint, checkpointSessionId] =
      mocks.sessionManager.updateActiveChainMessages.mock.calls[0] as [
        Array<Record<string, unknown>>,
        string,
      ];
    expect(checkpointSessionId).toBe(sessionId);
    expect(checkpoint).toEqual([
      expect.objectContaining({ role: MessageRole.USER, content: 'Keep this turn durable' }),
      expect.objectContaining({ type: MessageType.THINKING, content: 'Inspecting the workspace' }),
      expect.objectContaining({ type: MessageType.TOOL_CALL, tool_call_id: 'tc-checkpoint-1' }),
      expect.objectContaining({ type: MessageType.TOOL_RESULT, tool_call_id: 'tc-checkpoint-1' }),
      expect.objectContaining({
        role: MessageRole.ASSISTANT,
        content: 'Checking files',
        usage: expect.objectContaining({ prompt_tokens: 100 }),
      }),
    ]);
    expect(mocks.sessionManager.persistTurn).not.toHaveBeenCalled();
    expect(mocks.sessionManager.getSession(sessionId)?.activeChainId).toBe('chain-1');
    const chatSnapshot = mocks.handlers.get(IPC_CHANNELS.CHAT_SNAPSHOT)!;
    const liveSnapshot = await chatSnapshot(
      { sender: { id: 605, send } },
      { sessionId },
    ) as { messages: Array<Record<string, unknown>>; live: { response: string; toolCalls: Array<{ toolCallId: string }> } | null };
    expect(liveSnapshot.messages).toEqual([
      expect.objectContaining({ role: MessageRole.USER, content: 'Keep this turn durable' }),
    ]);
    expect(liveSnapshot.live).not.toBeNull();
    expect(liveSnapshot.live!.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: 'tc-checkpoint-1' }),
    ]);
    expect(liveSnapshot.live!.response).toBe('Checking files');

    releaseStream?.();
    await waitForDoneCount(send, 1);
  });

  it('persists cancelled tool results as visible but excluded from model context', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call',
        toolCallId: 'tc-question-cancelled',
        toolName: 'ask_question',
        args: '{"questions":[]}',
      };
      yield cancelledToolResult('tc-question-cancelled');
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend(
      { sender: { id: 602, send } },
      { message: 'Ask before continuing' },
    );
    await waitForDoneCount(send, 1);

    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(persisted.messages.find((message) => (
      message.type === MessageType.TOOL_RESULT &&
      message.tool_call_id === 'tc-question-cancelled'
    )))
      .toMatchObject({
        hidden: false,
        excludeFromModel: true,
      });
  });

  it('emits tool_update IPC payloads with the expected shape through the typed provider path', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'tool_call_start', toolCallId: 'tc-shape-1', toolName: 'glob' };
      yield { type: 'tool_call_delta', toolCallId: 'tc-shape-1', argsDelta: '{"pattern":' };
      yield { type: 'tool_call_delta', toolCallId: 'tc-shape-1', argsDelta: '"*.ts"}' };
      yield {
        type: 'tool_call',
        toolCallId: 'tc-shape-1',
        toolName: 'glob',
        args: '{"pattern":"*.ts"}',
      };
      yield successfulToolResult('tc-shape-1', 'src/index.ts');
      yield { type: 'content', text: 'Done' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const webContents = { id: 600, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: webContents }, { message: 'Find files' });
    await waitForDoneCount(send, 1);

    const starts = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_START);
    expect(starts).toHaveLength(1);
    expect(starts[0][1]).toMatchObject({
      type: 'tool_call_start',
      toolCallId: 'tc-shape-1',
      toolName: 'glob',
    });

    const deltas = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA);
    expect(deltas.map(([, p]) => (p as { argsDelta: string }).argsDelta)).toEqual([
      '{"pattern":',
      '"*.ts"}',
    ]);

    const updates = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0][1]).toMatchObject({
      toolCallId: 'tc-shape-1',
      status: 'running',
      args: '{"pattern":"*.ts"}',
    });
    expect(updates.at(-1)![1]).toMatchObject({
      toolCallId: 'tc-shape-1',
      status: 'complete',
      content: 'src/index.ts',
      toolResult: expect.objectContaining({ status: 'complete' }),
    });
    const done = doneEvents(send).at(-1)?.[1] as { messages: Array<Record<string, unknown>> };
    const textSegmentId = channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).at(-1)?.[1]
      ?.segmentId;
    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(done.messages).toEqual(persisted.messages);
    expect(done.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: textSegmentId, role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'Done' }),
      expect.objectContaining({ type: MessageType.TOOL_CALL, tool_call_id: 'tc-shape-1' }),
      expect.objectContaining({
        type: MessageType.TOOL_RESULT,
        tool_call_id: 'tc-shape-1',
        tool_result: expect.objectContaining({ status: 'complete' }),
      }),
    ]));
    expect(send.mock.calls.findIndex(([channel]) => channel === IPC_CHANNELS.SESSION_UPDATED))
      .toBeLessThan(send.mock.calls.findIndex(([channel]) => channel === IPC_CHANNELS.CHAT_DONE));
  });

  it('persists usage when a turn completes with tools but no assistant text', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call',
        toolCallId: 'tc-usage-only',
        toolName: 'read',
        args: '{"path":"README.md"}',
      };
      yield successfulToolResult('tc-usage-only', 'Orchid');
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 10,
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend(
      { sender: { id: 601, send } },
      { message: 'Read without a final response' },
    );
    await waitForDoneCount(send, 1);

    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(persisted.messages.at(-1)).toMatchObject({
      role: MessageRole.ASSISTANT,
      type: MessageType.TEXT,
      content: '',
      hidden: true,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_tokens: 10,
      },
    });
    const done = doneEvents(send).at(-1)?.[1] as { messages: Array<Record<string, unknown>> };
    expect(done.messages).toEqual(persisted.messages);
    expect(done.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: MessageType.TOOL_CALL, tool_call_id: 'tc-usage-only' }),
      expect.objectContaining({
        type: MessageType.TOOL_RESULT,
        tool_call_id: 'tc-usage-only',
        tool_result: expect.objectContaining({ status: 'complete' }),
      }),
      expect.objectContaining({ hidden: true, usage: expect.objectContaining({ total_tokens: 120 }) }),
    ]));
  });
});

describe('chat session snapshot hydration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.runtimeRegistry._reset();
    mocks.sessionManager._reset();
    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.sessionManager._reset();
  });

  it('uses live segment ids for persisted thinking and assistant messages', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'thinking', text: 'Stable reasoning' };
      yield { type: 'content', text: 'Stable final response' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend(
      { sender: { id: 604, send } },
      { message: 'Keep the bubble mounted' },
    );
    await waitForDoneCount(send, 1);

    const chunk = channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).at(-1)?.[1] as {
      segmentId?: string;
    };
    const thinking = channelEvents(send, IPC_CHANNELS.CHAT_THINKING).at(-1)?.[1] as {
      segmentId?: string;
    };
    const persisted = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<Record<string, unknown>>;
    };
    const assistant = persisted.messages.find(
      (message) => message.role === MessageRole.ASSISTANT && message.content === 'Stable final response',
    );
    const reasoning = persisted.messages.find(
      (message) => message.type === MessageType.THINKING && message.content === 'Stable reasoning',
    );

    expect(chunk.segmentId).toEqual(expect.any(String));
    expect(thinking.segmentId).toEqual(expect.any(String));
    expect(assistant?.id).toBe(chunk.segmentId);
    expect(reasoning?.id).toBe(thinking.segmentId);
  });

  it('keeps persisted history available after the live actor completes', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
    });
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call_start',
        toolCallId: 'call-read-1',
        toolName: 'read',
      };
      yield {
        type: 'tool_call',
        toolCallId: 'call-read-1',
        toolName: 'read',
        args: '{"path":"README.md"}',
      };
      yield successfulToolResult('call-read-1', 'Orchid');
      yield { type: 'content', text: 'Live partial response' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const webContents = { id: 490, send: vi.fn() };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const chatSnapshot = mocks.handlers.get(IPC_CHANNELS.CHAT_SNAPSHOT)!;
    const sendPromise = chatSend({ sender: webContents }, { message: 'Keep going' });

    await waitForChannelCount(webContents.send, IPC_CHANNELS.CHAT_CHUNK, 1);
    const running = await chatSnapshot(
      { sender: webContents },
      { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    );
    expect(running).toMatchObject({
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messages: [expect.objectContaining({ content: 'Keep going' })],
      live: expect.objectContaining({
        response: 'Live partial response',
        toolCalls: [expect.objectContaining({
          toolCallId: 'call-read-1',
          status: 'complete',
          content: 'Orchid',
          toolResult: expect.objectContaining({ status: 'complete' }),
        })],
        streamSegments: expect.arrayContaining([
          expect.objectContaining({ kind: 'tool', toolCallId: 'call-read-1' }),
        ]),
      }),
    });

    releaseStream!();
    await sendPromise;
    await waitForDoneCount(webContents.send, 1);

    const completed = await chatSnapshot(
      { sender: webContents },
      { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    );
    expect(completed).toMatchObject({
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messages: [
        expect.objectContaining({ content: 'Keep going' }),
        expect.objectContaining({ type: 'tool_call', tool_call_id: 'call-read-1' }),
        expect.objectContaining({
          type: 'tool_result',
          tool_call_id: 'call-read-1',
          content: 'Orchid',
          tool_result: expect.objectContaining({ status: 'complete' }),
        }),
        expect.objectContaining({ content: 'Live partial response' }),
      ],
      live: null,
    });
  });
});

describe('chat IPC provider gates', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.runtimeRegistry._reset();
    mocks.sessionManager._reset();
    mocks.electronWebContents.getAllWebContents.mockReset();
    mocks.electronWebContents.getAllWebContents.mockReturnValue([]);
    mocks.aiGenerateText.mockReset();
    mocks.aiGenerateText.mockResolvedValue({ text: 'Investigate Session Naming' });
    mocks.aiWrapLanguageModel.mockClear();
    mocks.createMiddlewareStack.mockClear();
    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.sessionManager._reset();
  });

  it('keeps a local workspace usable but fails sending without a typed provider selection', async () => {
    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    const result = await chatSend!({ sender: { id: 901, send } }, { message: 'Local only' });

    expect(result).toEqual({
      status: 'error',
      error: expect.stringContaining('provider connection and model'),
      kind: 'provider_required',
    });
    expect(mocks.sessionManager.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a legacy alias string before it can create a session or stream', async () => {
    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    await expect(
      chatSend!({ sender: { id: 902, send } }, { message: 'No alias fallback', model: 'legacy/gpt-4o' }),
    ).rejects.toThrow(/expected object/i);

    expect(mocks.sessionManager.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a legacy session label as display-only and requires a new typed selection', async () => {
    mocks.sessionManager._setActive({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Legacy session',
      model: 'legacy/provider/model',
      cwd: mocks.workspace._testProjectDir,
      chains: [],
      activeChainId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subagentChains: [],
      todoStore: { tasks: [] },
    });
    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    const result = await chatSend!({ sender: { id: 903, send } }, { message: 'Do not reuse label' });

    expect(result).toMatchObject({ status: 'error', kind: 'provider_required' });
    expect(mocks.sessionManager.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('routes a typed selection through the trusted runtime and shared stream path', async () => {
    const typedSelection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'Typed session',
      model: typedSelection.modelId,
      selection: typedSelection,
      modelLabel: typedSelection.modelId,
      cwd: mocks.workspace._testProjectDir,
      chains: [],
      activeChainId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subagentChains: [],
      todoStore: { tasks: [] },
    } as never);
    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    const result = await chatSend!(
      { sender: { id: 904, send } },
      { message: 'Use the selected connection' },
    );

    expect(result).toMatchObject({ status: 'started' });
    await waitForDoneCount(send, 1);
    expect(mocks.providerRuntime.resolveExecution).toHaveBeenCalledWith(typedSelection, {});
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      modelInstance: mocks.modelInstance,
      sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      agentScopeId: 'main',
    }));
    expect(mocks.toolRegistry.get).not.toHaveBeenCalled();
  });

  it('passes providerOptions to the stream when the model supports reasoning and a session override is set', async () => {
    const reasoningSelection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/reasoning-model',
    };
    const buildReasoningOptions = vi.fn((effort: string | number) => ({
      openai: { reasoningEffort: effort },
    }));
    mocks.providerRuntime.resolveExecution.mockResolvedValueOnce({
      modelInstance: mocks.modelInstance,
      connection: {},
      model: { id: 'vendor/path/reasoning-model', capabilities: { reasoning: true } },
      buildReasoningOptions,
      snapshot: {
        providerId: 'openai',
        providerDisplayName: 'OpenAI',
        connectionId: '11111111-1111-4111-8111-111111111111',
        connectionName: 'Work',
        modelId: 'vendor/path/reasoning-model',
        protocol: 'openai-compatible',
        modelSource: 'catalog',
        catalogVersion: 1,
        catalogSource: 'bundled',
        catalogObservedAt: null,
        pricing: null,
        fieldProvenance: {},
        statusObservation: null,
      },
    });
    mocks.sessionManager._setActive({
      ...makeSession('ffffffff-ffff-4fff-8fff-ffffffffffff'),
      selection: reasoningSelection,
      modelLabel: reasoningSelection.modelId,
      reasoningEffortOverride: 'high',
    } as never);
    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    const result = await chatSend!(
      { sender: { id: 908, send } },
      { message: 'Reason about this' },
    );

    expect(result).toMatchObject({ status: 'started' });
    await waitForDoneCount(send, 1);
    expect(buildReasoningOptions).toHaveBeenCalledWith('high');
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { openai: { reasoningEffort: 'high' } },
    }));
  });

  it('merges a session tier override into providerOptions and the frozen snapshot (R19/R21/R22)', async () => {
    const sessionId = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession(sessionId),
      model: selection.modelId,
      selection,
      modelLabel: selection.modelId,
      tierOverride: 'flex',
    });
    mocks.providerRuntime.resolveTierContext.mockResolvedValueOnce({
      connection: { tierSelections: { 'vendor/path/model': 'fast' } },
      tierMechanism: OPENAI_TIER_MECHANISM,
    } as never);
    mocks.providerRuntime.resolveExecution.mockResolvedValueOnce({
      modelInstance: mocks.modelInstance,
      connection: { tierSelections: { 'vendor/path/model': 'fast' } },
      model: { id: 'vendor/path/model', capabilities: { reasoning: false } },
      snapshot: {
        providerId: 'openai',
        providerDisplayName: 'OpenAI',
        connectionId: '11111111-1111-4111-8111-111111111111',
        connectionName: 'Work',
        modelId: 'vendor/path/model',
        protocol: 'openai-compatible',
        modelSource: 'catalog',
        catalogVersion: 1,
        catalogSource: 'bundled',
        catalogObservedAt: null,
        pricing: null,
        fieldProvenance: {},
        statusObservation: null,
        tier: { mechanism: 'request-parameter', requestedTier: 'flex' },
      },
      tierMechanism: OPENAI_TIER_MECHANISM,
    } as never);
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Tiered reply' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    await chatSend({ sender: { id: 909, send } }, { message: 'Tiered request' });
    await waitForDoneCount(send, 1);

    // The session override 'flex' wins over the connection selection 'fast' (R21).
    expect(mocks.providerRuntime.resolveExecution).toHaveBeenCalledWith(selection, { tier: 'flex' });
    // The request-parameter mechanism rides serviceTier into the merged providerOptions (R19).
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { openai: { serviceTier: 'flex' } },
      accounting: expect.objectContaining({
        snapshot: expect.objectContaining({
          tier: { mechanism: 'request-parameter', requestedTier: 'flex' },
        }),
      }),
    }));
  });

  it('auto-names a completed default session through the internal session-namer agent', async () => {
    const turnSelection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/chat-model',
    };
    const titleSelection = {
      connectionId: '22222222-2222-4222-8222-222222222222',
      modelId: 'vendor/path/sprout-model',
    };
    const sessionNamerAgent = {
      ...mocks.sessionNamerAgent,
      tier: 'sprout' as const,
      system_prompt: 'Create one compact title using 3-6 words.',
    };
    mocks.runtimeRegistry._set(mocks.workspace._testProjectDir, {
      config: {
        default_model: turnSelection,
        tier_models: {
          seed: {
            connectionId: '33333333-3333-4333-8333-333333333333',
            modelId: 'vendor/path/unused-seed-model',
          },
          sprout: titleSelection,
          bloom: null,
        },
        command_timeout: 30,
        llm_stream_idle_timeout: 60,
        llm_stream_retries: 0,
        session_title_max_wait_seconds: 15,
      },
      agents: new Map([
        ['general', mocks.generalAgent],
        ['session-namer', sessionNamerAgent],
      ]),
    });
    mocks.sessionManager._setActive({
      ...makeSession('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      selection: turnSelection,
      modelLabel: turnSelection.modelId,
    });
    mocks.streamResponses.push('The placeholder callback disables naming.');
    const send = vi.fn();
    const source = { id: 905, send };
    const sameSession = { id: 906, send: vi.fn() };
    const differentSession = { id: 907, send: vi.fn() };
    const selectedSession = mocks.sessionManager.getActive()!;
    mocks.sessionManager._setActiveForWindow('905', selectedSession);
    mocks.sessionManager._setActiveForWindow('906', selectedSession);
    mocks.sessionManager._setActiveForWindow('907', {
      ...selectedSession,
      id: 'different-session',
    });
    mocks.electronWebContents.getAllWebContents.mockReturnValue([
      source,
      sameSession,
      differentSession,
    ]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: source }, { message: 'Why are sessions unnamed?' });
    await waitForChannelCount(send, IPC_CHANNELS.SESSION_RENAMED, 1);

    expect(mocks.providerRuntime.resolveExecution).toHaveBeenCalledWith(titleSelection);
    expect(mocks.createMiddlewareStack).toHaveBeenCalledWith({
      retry: { maxRetries: 0 },
      accounting: expect.objectContaining({
        store: mocks.accountingStore,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        chainId: 'chain-1',
        turnId: 'chain-1',
        snapshot: expect.objectContaining({ modelId: 'vendor/path/model' }),
      }),
    });
    expect(mocks.aiGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      model: mocks.wrappedTitleModel,
      instructions: sessionNamerAgent.system_prompt,
      abortSignal: expect.any(AbortSignal),
      messages: [expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Why are sessions unnamed?'),
      })],
      maxRetries: 0,
    }));
    expect(channelEvents(send, IPC_CHANNELS.SESSION_RENAMED).at(-1)?.[1]).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Investigate Session Naming',
    });
    const sourceUpdate = channelEvents(send, IPC_CHANNELS.SESSION_UPDATED).at(-1)?.[1];
    const peerUpdate = channelEvents(sameSession.send, IPC_CHANNELS.SESSION_UPDATED).at(-1)?.[1];
    expect(sourceUpdate).toMatchObject({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      activeChainId: null,
      chain: { id: 'chain-1', status: 'completed' },
    });
    expect(peerUpdate).toMatchObject({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      activeChainId: null,
      chain: { id: 'chain-1', status: 'completed' },
    });
    expect(sourceUpdate).not.toHaveProperty('session');
    expect(sourceUpdate).not.toHaveProperty('subagentChains');
    expect(channelEvents(sameSession.send, IPC_CHANNELS.SESSION_RENAMED).at(-1)?.[1]).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Investigate Session Naming',
    });
    expect(channelEvents(differentSession.send, IPC_CHANNELS.SESSION_UPDATED)).toHaveLength(0);
    expect(channelEvents(differentSession.send, IPC_CHANNELS.SESSION_RENAMED)).toHaveLength(0);
  });

  it('logs a visible warning when title generation fails', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamResponses.push('Naming should fail without failing the turn.');
    mocks.aiGenerateText.mockRejectedValueOnce(new Error('title provider unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn();
    const source = { id: 906, send };
    mocks.sessionManager._setActiveForWindow('906', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: source }, { message: 'Trigger naming' });
    await waitForChannelCount(send, IPC_CHANNELS.SESSION_RENAMED, 1);

    expect(warn).toHaveBeenCalledWith(
      '[auto-name] Title generation failed; keeping the default session name:',
      expect.any(Error),
    );
    expect(mocks.providerRuntime.resolveExecution).toHaveBeenCalledWith(selection);
    expect(channelEvents(send, IPC_CHANNELS.SESSION_RENAMED).at(-1)?.[1]).toEqual({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Session bbbbbbbb',
    });
    warn.mockRestore();
  });

  it('auto-names a long-running turn from the in-flight history after the deadline', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.runtimeRegistry._set(mocks.workspace._testProjectDir, {
      config: {
        default_model: selection,
        tier_models: { bloom: null },
        command_timeout: 30,
        llm_stream_idle_timeout: 60,
        llm_stream_retries: 0,
        session_title_max_wait_seconds: 0.05,
      },
    });
    mocks.sessionManager._setActive({
      ...makeSession('ffffffff-ffff-4fff-8fff-ffffffffffff'),
      selection,
      modelLabel: selection.modelId,
    });
    // Turn stays in flight past the deadline and never yields assistant text.
    mocks.streamChat.mockImplementationOnce(async function* () {
      await new Promise(() => {});
      yield { type: 'finish', finishReason: 'stop' };
    });
    const send = vi.fn();
    const source = { id: 910, send };
    mocks.sessionManager._setActiveForWindow('910', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: source }, { message: 'Refactor the payment queue' });
    await waitForChannelCount(send, IPC_CHANNELS.SESSION_RENAMED, 1);

    expect(mocks.aiGenerateText).toHaveBeenCalledTimes(1);
    const call = mocks.aiGenerateText.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    // No assistant text exists yet — the user message alone must name the session.
    expect(call.messages[0].content).toContain('Refactor the payment queue');
    expect(call.messages[0].content).not.toContain('Assistant:');
    expect(channelEvents(send, IPC_CHANNELS.SESSION_RENAMED).at(-1)?.[1]).toEqual({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      name: 'Investigate Session Naming',
    });
  });

  it('deadline naming does not duplicate when the turn completes afterwards', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.runtimeRegistry._set(mocks.workspace._testProjectDir, {
      config: {
        default_model: selection,
        tier_models: { bloom: null },
        command_timeout: 30,
        llm_stream_idle_timeout: 60,
        llm_stream_retries: 0,
        session_title_max_wait_seconds: 0.05,
      },
    });
    mocks.sessionManager._setActive({
      ...makeSession('12121212-1212-4212-8212-121212121212'),
      selection,
      modelLabel: selection.modelId,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Still working' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });
    const send = vi.fn();
    const source = { id: 911, send };
    mocks.sessionManager._setActiveForWindow('911', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: source }, { message: 'Trace the flaky test' });
    await waitForChannelCount(send, IPC_CHANNELS.SESSION_RENAMED, 1);
    expect(mocks.aiGenerateText).toHaveBeenCalledTimes(1);

    // Turn completes later; the already-renamed session must not trigger again.
    releaseStream();
    await waitForDoneCount(send, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.aiGenerateText).toHaveBeenCalledTimes(1);
  });

  it('auto-names an Esc-cancelled turn from the exchanged history', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager._setActive({
      ...makeSession('abababab-abab-4bab-8bab-abababababab'),
      selection,
      modelLabel: selection.modelId,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Working on it' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });
    const send = vi.fn();
    const source = { id: 912, send };
    mocks.sessionManager._setActiveForWindow('912', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const chatCancel = mocks.handlers.get(IPC_CHANNELS.CHAT_CANCEL)!;

    await chatSend({ sender: source }, { message: 'Migrate the config loader' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_CHUNK, 1);

    const first = await chatCancel({ sender: source }, {});
    expect(first).toMatchObject({ status: 'confirming' });
    expect(mocks.aiGenerateText).not.toHaveBeenCalled();

    await chatCancel({ sender: source }, {});
    await waitForChannelCount(send, IPC_CHANNELS.SESSION_RENAMED, 1);

    expect(mocks.aiGenerateText).toHaveBeenCalledTimes(1);
    const call = mocks.aiGenerateText.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0].content).toContain('Migrate the config loader');
    expect(call.messages[0].content).toContain('Working on it');
    expect(channelEvents(send, IPC_CHANNELS.SESSION_RENAMED).at(-1)?.[1]).toEqual({
      id: 'abababab-abab-4bab-8bab-abababababab',
      name: 'Investigate Session Naming',
    });
    releaseStream();
  });

  it('auto-names a chat:stop turn and honors 0 as a disabled deadline', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.runtimeRegistry._set(mocks.workspace._testProjectDir, {
      config: {
        default_model: selection,
        tier_models: { bloom: null },
        command_timeout: 30,
        llm_stream_idle_timeout: 60,
        llm_stream_retries: 0,
        session_title_max_wait_seconds: 0,
      },
    });
    mocks.sessionManager._setActive({
      ...makeSession('cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd'),
      selection,
      modelLabel: selection.modelId,
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      await new Promise(() => {});
      yield { type: 'finish', finishReason: 'stop' };
    });
    const send = vi.fn();
    const source = { id: 913, send };
    mocks.sessionManager._setActiveForWindow('913', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.fromId.mockReturnValue(source);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;
    const chatStop = mocks.handlers.get(IPC_CHANNELS.CHAT_STOP)!;

    await chatSend({ sender: source }, { message: 'Profile the renderer startup' });
    // With the deadline disabled nothing may name the session on its own.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mocks.aiGenerateText).not.toHaveBeenCalled();

    const stopped = await chatStop(
      { sender: source },
      { sessionId: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd' },
    );
    expect(stopped).toEqual({ status: 'stopped' });
    await waitForChannelCount(send, IPC_CHANNELS.SESSION_RENAMED, 1);
    expect(mocks.aiGenerateText).toHaveBeenCalledTimes(1);
    const call = mocks.aiGenerateText.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0].content).toContain('Profile the renderer startup');
    expect(channelEvents(send, IPC_CHANNELS.SESSION_RENAMED).at(-1)?.[1]).toEqual({
      id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
      name: 'Investigate Session Naming',
    });
  });

  it('discards a deleted live turn without persistence, terminal events, or auto-naming', async () => {
    const sessionId = 'dededede-dede-4ede-8ede-dededededede';
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
      yield { type: 'content', text: 'partial deletion tail' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });
    const send = vi.fn();
    const source = { id: 915, send };
    mocks.sessionManager._setActiveForWindow('915', mocks.sessionManager.getActive()!);
    mocks.electronWebContents.getAllWebContents.mockReturnValue([source]);
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND)!;

    await chatSend({ sender: source }, { message: 'Delete this live turn' });
    await waitForChannelCount(send, IPC_CHANNELS.CHAT_CHUNK, 1);
    mocks.sessionManager.persistTurn.mockClear();
    mocks.aiGenerateText.mockClear();
    send.mockClear();

    expect(discardDeletedSessionRuntime(sessionId)).toBe(true);
    releaseStream();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.backgroundStore.terminateSession).toHaveBeenCalledWith(sessionId);
    expect(mocks.subagentManager.discardSession).toHaveBeenCalledWith(sessionId);
    expect(mocks.sessionManager.persistTurn).not.toHaveBeenCalled();
    expect(mocks.aiGenerateText).not.toHaveBeenCalled();
    expect(channelEvents(send, IPC_CHANNELS.CHAT_DONE)).toEqual([]);
    expect(channelEvents(send, IPC_CHANNELS.CHAT_STATE)).toEqual([]);
  });
});
