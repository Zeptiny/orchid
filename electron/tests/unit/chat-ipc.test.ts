import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const streamResponses: string[] = [];
  const streamEventSequences: Array<Array<Record<string, unknown>>> = [];

  return {
    handlers,
    streamResponses,
    streamEventSequences,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    streamChat: vi.fn(async function* () {
      const eventSequence = streamEventSequences.shift();
      if (eventSequence) {
        for (const event of eventSequence) {
          yield event;
        }
        return;
      }
      const response = streamResponses.shift() ?? '';
      if (response) {
        yield { type: 'content', text: response };
      }
      yield { type: 'finish', finishReason: 'stop' };
    }),
    listAgents: vi.fn(() => [
      {
        name: 'general',
        type: 'subagent',
        tier: 'bloom',
        description: 'General-purpose agent',
        system_prompt: 'You are a helpful assistant.',
        allowed_tools: ['*'],
        allowed_skills: ['*'],
      },
    ]),
    subagentManager: {
      cancelRunning: vi.fn(() => []),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
}));

vi.mock('../../src/main/config/loader', () => ({
  HOME_PERSONALITIES_DIR: '/tmp/orchid-test-personalities',
  getConfig: vi.fn(() => ({
    default_model: 'test/model',
    tier_models: { bloom: 'test/model' },
    command_timeout: 30,
    llm_stream_retries: 0,
  })),
}));

vi.mock('../../src/main/agents/registry', () => ({
  listAgents: mocks.listAgents,
  getAgent: vi.fn(),
}));

vi.mock('../../src/main/llm/providers', () => ({
  resolveModelRef: vi.fn(() => ({ provider: 'test', model: 'model' })),
}));

vi.mock('../../src/main/llm/providers-factory', () => ({
  createProviderModel: vi.fn(async () => ({})),
}));

vi.mock('../../src/main/tools', () => ({
  toolRegistry: {
    filter: vi.fn(() => []),
    get: vi.fn(() => null),
  },
  getSubagentManager: vi.fn(() => mocks.subagentManager),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

let chatIpc: typeof import('../../src/main/ipc/chat');

function doneEvents(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.CHAT_DONE);
}

function channelEvents(send: ReturnType<typeof vi.fn>, channelName: string) {
  return send.mock.calls.filter(([channel]) => channel === channelName);
}

async function waitForDoneCount(send: ReturnType<typeof vi.fn>, count: number) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    if (doneEvents(send).length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${count} chat:done events`);
}

describe('chat IPC', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.subagentManager.cancelRunning.mockClear();

    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
  });

  it('does not replay the previous assistant response when a new turn starts', async () => {
    mocks.streamResponses.push('First response', 'Second response');
    const send = vi.fn();
    const webContents = { id: 42, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    expect(chatSend).toBeDefined();

    await chatSend!({ sender: webContents }, { message: 'Hello' });
    await waitForDoneCount(send, 1);

    await chatSend!({ sender: webContents }, { message: 'Next question' });
    await waitForDoneCount(send, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const responses = doneEvents(send).map(([, payload]) => {
      return (payload as { response: string }).response;
    });

    expect(responses).toEqual(['First response', 'Second response']);
  });

  it('forwards streamed tool call lifecycle events', async () => {
    mocks.streamEventSequences.push([
      { type: 'tool_call_start', toolCallId: 'tc-1', toolName: 'read_file' },
      { type: 'tool_call_delta', toolCallId: 'tc-1', argsDelta: '{"file_path":' },
      { type: 'tool_call_delta', toolCallId: 'tc-1', argsDelta: '"README.md"}' },
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        args: '{"file_path":"README.md"}',
      },
      {
        type: 'tool_result',
        toolCallId: 'tc-1',
        content: 'file contents',
        isError: false,
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const send = vi.fn();
    const webContents = { id: 43, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    expect(chatSend).toBeDefined();

    await chatSend!({ sender: webContents }, { message: 'Read the file' });
    await waitForDoneCount(send, 1);

    const starts = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_START);
    const deltas = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA);
    const updates = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE);

    expect(starts).toHaveLength(1);
    expect(starts[0][1]).toMatchObject({
      type: 'tool_call_start',
      toolCallId: 'tc-1',
      toolName: 'read_file',
    });
    expect(deltas.map(([, payload]) => (payload as { argsDelta: string }).argsDelta)).toEqual([
      '{"file_path":',
      '"README.md"}',
    ]);
    expect(updates.map(([, payload]) => (payload as { status: string }).status)).toEqual([
      'running',
      'completed',
    ]);
    expect(updates.at(-1)?.[1]).toMatchObject({
      toolCallId: 'tc-1',
      status: 'completed',
      result: 'file contents',
    });
  });

  it('two-phase Esc cancels stream and emits interrupted done without suffix', async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Partial answer' };
      // Stay open long enough for cancel path to run
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const webContents = { id: 44, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    const chatCancel = mocks.handlers.get(IPC_CHANNELS.CHAT_CANCEL);
    expect(chatSend).toBeDefined();
    expect(chatCancel).toBeDefined();

    // Fire-and-forget send so we can cancel mid-stream
    const sendPromise = chatSend!({ sender: webContents }, { message: 'Write something long' });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const first = await chatCancel!({ sender: webContents });
    expect(first).toEqual({ status: 'confirming' });

    const second = await chatCancel!({ sender: webContents });
    expect(second).toEqual({ status: 'confirming_subagents' });
    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();

    const third = await chatCancel!({ sender: webContents });
    expect(third).toEqual({ status: 'cancelled' });
    expect(mocks.subagentManager.cancelRunning).toHaveBeenCalledTimes(1);

    const dones = doneEvents(send);
    expect(dones.length).toBeGreaterThanOrEqual(1);
    const payload = dones[0][1] as {
      response: string;
      interrupted?: boolean;
    };
    expect(payload.interrupted).toBe(true);
    expect(payload.response).toContain('Partial');
    expect(payload.response).not.toContain('[Interrupted by user]');

    await sendPromise;
  });

  it('maps AI SDK 7 tool stream parts through generating → running → completed', async () => {
    mocks.streamEventSequences.push([
      {
        type: 'tool_call_start',
        toolCallId: 'call_glob_1',
        toolName: 'glob',
      },
      {
        type: 'tool_call_delta',
        toolCallId: 'call_glob_1',
        argsDelta: '{"pattern":',
      },
      {
        type: 'tool_call_delta',
        toolCallId: 'call_glob_1',
        argsDelta: '"*.ts"}',
      },
      {
        type: 'tool_call',
        toolCallId: 'call_glob_1',
        toolName: 'glob',
        args: '{"pattern":"*.ts"}',
      },
      {
        type: 'tool_result',
        toolCallId: 'call_glob_1',
        content: 'src/main.ts\nsrc/preload.ts',
        isError: false,
      },
      { type: 'content', text: 'Found 2 files.' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    const send = vi.fn();
    const webContents = { id: 46, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    await chatSend!({ sender: webContents }, { message: 'Find ts files' });
    await waitForDoneCount(send, 1);

    const starts = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_START);
    const deltas = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_DELTA);
    const updates = channelEvents(send, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE);

    expect(starts[0][1]).toMatchObject({
      toolCallId: 'call_glob_1',
      toolName: 'glob',
    });
    expect(deltas.map(([, p]) => (p as { argsDelta: string }).argsDelta)).toEqual([
      '{"pattern":',
      '"*.ts"}',
    ]);
    expect(updates.map(([, p]) => (p as { status: string }).status)).toEqual([
      'running',
      'completed',
    ]);
    expect(updates[0][1]).toMatchObject({
      toolCallId: 'call_glob_1',
      status: 'running',
      args: '{"pattern":"*.ts"}',
    });
    expect(updates[1][1]).toMatchObject({
      toolCallId: 'call_glob_1',
      status: 'completed',
      result: 'src/main.ts\nsrc/preload.ts',
    });
  });

  it('forwards classified error title and kind on stream failure', async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'error',
        title: 'Authentication Failed',
        detail: 'Invalid API key for provider "default"',
      };
    });

    const send = vi.fn();
    const webContents = { id: 45, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    await chatSend!({ sender: webContents }, { message: 'Hello' });

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const errors = channelEvents(send, IPC_CHANNELS.CHAT_ERROR);
      if (errors.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const errors = channelEvents(send, IPC_CHANNELS.CHAT_ERROR);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0][1]).toMatchObject({
      type: 'error',
      title: 'Authentication Failed',
      kind: 'auth',
      error: 'Invalid API key for provider "default"',
    });
  });
});
