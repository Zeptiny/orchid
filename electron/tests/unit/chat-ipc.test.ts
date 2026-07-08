import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const streamResponses: string[] = [];

  return {
    handlers,
    streamResponses,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    streamChat: vi.fn(async function* () {
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
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
}));

vi.mock('../../src/main/config/loader', () => ({
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
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

let chatIpc: typeof import('../../src/main/ipc/chat');

function doneEvents(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.CHAT_DONE);
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

    chatIpc = await import('../../src/main/ipc/chat');
    chatIpc.registerChatIPC();
  });

  afterEach(() => {
    chatIpc.unregisterChatIPC();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
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
});
