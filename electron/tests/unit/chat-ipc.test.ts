import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const streamResponses: string[] = [];
  const streamEventSequences: Array<Array<Record<string, unknown>>> = [];

  let activeSession: {
    id: string;
    name: string;
    model: string;
    cwd: string | null;
    chains: unknown[];
    activeChainId: string | null;
    createdAt: string;
    updatedAt: string;
    subagentChains: unknown[];
    todoStore: { tasks: unknown[] };
  } | null = null;

  let workspaceBound = true;
  const testProjectDir = '/tmp/orchid-chat-ipc-project';

  const sessionManager = {
    getActive: vi.fn(() => activeSession),
    clearActive: vi.fn(() => {
      activeSession = null;
    }),
    create: vi.fn((model: string, options?: { cwd?: string | null }) => {
      activeSession = {
        id: 'lazy-session-id',
        name: 'Session draft',
        model,
        cwd: options?.cwd ?? null,
        chains: [],
        activeChainId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subagentChains: [],
        todoStore: { tasks: [] },
      };
      return activeSession;
    }),
    syncActiveChain: vi.fn((params: { messages: unknown[] }) => {
      if (!activeSession) return null;
      activeSession = {
        ...activeSession,
        chains: [
          {
            id: 'chain-1',
            sessionId: activeSession.id,
            messages: params.messages,
            status: 'completed',
            model: activeSession.model,
            agentName: 'general',
            agentType: 'subagent',
            agentTier: 'bloom',
            subagentRecord: null,
          },
        ],
        activeChainId: 'chain-1',
      };
      return activeSession;
    }),
    autoNameActive: vi.fn(async () => activeSession),
    /** Test helper: reset between cases */
    _reset: () => {
      activeSession = null;
      workspaceBound = true;
      sessionManager.getActive.mockClear();
      sessionManager.create.mockClear();
      sessionManager.clearActive.mockClear();
      sessionManager.syncActiveChain.mockClear();
      sessionManager.autoNameActive.mockClear();
    },
  };

  const workspace = {
    resolveWorkspace: vi.fn((_windowId: string, _options?: unknown) => {
      if (!workspaceBound) {
        return { cwd: null, source: 'unbound' as const, status: 'unbound' as const };
      }
      return {
        cwd: testProjectDir,
        source: 'default' as const,
        status: 'valid' as const,
      };
    }),
    isWorkspaceBound: vi.fn((info: { status: string; cwd: string | null }) => {
      return info.status === 'valid' && info.cwd != null && info.cwd !== '';
    }),
    clearDraftCwd: vi.fn(),
    setDraftCwd: vi.fn(),
    getDraftCwd: vi.fn(() => null),
    clearAllDraftCwds: vi.fn(),
    updateStickyDefaultProjectDir: vi.fn(),
    requireValidProjectDirectory: vi.fn((dir: string) => dir),
    resolveWorkspaceFromParts: vi.fn(),
    _setBound: (bound: boolean) => {
      workspaceBound = bound;
    },
    _testProjectDir: testProjectDir,
  };

  return {
    handlers,
    streamResponses,
    streamEventSequences,
    sessionManager,
    workspace,
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

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => mocks.sessionManager,
}));

vi.mock('../../src/main/project/layers', () => ({
  applyWorkspaceProjectLayers: vi.fn(() => ({
    applied: true,
    projectDir: '/tmp/orchid-chat-ipc-project',
    config: {},
    agents: null,
    skills: null,
  })),
  getLastAppliedProjectDir: vi.fn(() => null),
  resetLastAppliedProjectDir: vi.fn(),
}));

vi.mock('../../src/main/project/workspace', () => ({
  resolveWorkspace: (...args: unknown[]) =>
    mocks.workspace.resolveWorkspace(...(args as [string, unknown?])),
  isWorkspaceBound: (...args: unknown[]) =>
    mocks.workspace.isWorkspaceBound(...(args as [{ status: string; cwd: string | null }])),
  clearDraftCwd: (...args: unknown[]) =>
    mocks.workspace.clearDraftCwd(...(args as [string])),
  setDraftCwd: mocks.workspace.setDraftCwd,
  getDraftCwd: mocks.workspace.getDraftCwd,
  clearAllDraftCwds: mocks.workspace.clearAllDraftCwds,
  updateStickyDefaultProjectDir: mocks.workspace.updateStickyDefaultProjectDir,
  requireValidProjectDirectory: mocks.workspace.requireValidProjectDirectory,
  resolveWorkspaceFromParts: mocks.workspace.resolveWorkspaceFromParts,
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

  it('lazy-creates a session on first send when none is active', async () => {
    mocks.streamResponses.push('Hello back');
    const send = vi.fn();
    const webContents = { id: 99, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    expect(mocks.sessionManager.getActive()).toBeNull();

    await chatSend!(
      { sender: webContents },
      { message: 'Hi from draft', model: 'preferred/model' },
    );
    await waitForDoneCount(send, 1);

    expect(mocks.sessionManager.create).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManager.create).toHaveBeenCalledWith('preferred/model', {
      cwd: mocks.workspace._testProjectDir,
    });
    expect(mocks.sessionManager.getActive()?.id).toBe('lazy-session-id');
    expect(mocks.sessionManager.getActive()?.cwd).toBe(mocks.workspace._testProjectDir);
    expect(mocks.workspace.clearDraftCwd).toHaveBeenCalledWith('99');

    const created = channelEvents(send, IPC_CHANNELS.SESSION_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0][1]).toMatchObject({
      session: { id: 'lazy-session-id', model: 'preferred/model' },
    });

    // Second send reuses the active session — no second create
    mocks.streamResponses.push('Again');
    await chatSend!({ sender: webContents }, { message: 'Follow-up' });
    await waitForDoneCount(send, 2);
    expect(mocks.sessionManager.create).toHaveBeenCalledTimes(1);
  });

  it('rejects chat:send when workspace is unbound (no session create, no stream)', async () => {
    mocks.workspace._setBound(false);
    const send = vi.fn();
    const webContents = { id: 100, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    const result = await chatSend!(
      { sender: webContents },
      { message: 'Should not start' },
    );

    expect(result).toEqual({
      status: 'error',
      error: expect.stringContaining('project folder'),
      kind: 'unbound_workspace',
    });
    expect(mocks.sessionManager.create).not.toHaveBeenCalled();
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(doneEvents(send)).toHaveLength(0);
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

  it.each([
    {
      title: 'Authentication Failed',
      detail: 'Invalid API key for provider "default"',
      kind: 'auth',
    },
    {
      title: 'Rate Limited',
      detail: 'HTTP 429: rate limit exceeded, try again later',
      kind: 'rate-limit',
    },
    {
      title: 'Stream Error',
      detail: 'Connection timed out while streaming response',
      kind: 'stream',
    },
    {
      title: 'Provider Error',
      detail: 'Model returned an unexpected response payload',
      kind: 'generic',
    },
  ] as const)(
    'forwards classified error title and kind=$kind on stream failure',
    async ({ title, detail, kind }) => {
      mocks.streamChat.mockImplementationOnce(async function* () {
        yield {
          type: 'error',
          title,
          detail,
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
        title,
        kind,
        error: detail,
      });
    },
  );
  it('forceAbortChat stops further CHAT_CHUNK emission (session switch)', async () => {
    // Stream yields one chunk, pauses (session switch window), then more content.
    let releaseSecondHalf: (() => void) | undefined;
    const secondHalf = new Promise<void>((resolve) => {
      releaseSecondHalf = resolve;
    });

    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Session-A-chunk' };
      await secondHalf;
      yield { type: 'content', text: 'LEAKED-AFTER-ABORT' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const webContents = { id: 47, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    const sendPromise = chatSend!({ sender: webContents }, { message: 'stream me' });

    // Wait until the first chunk has been forwarded
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const chunks = channelEvents(send, IPC_CHANNELS.CHAT_CHUNK);
      if (chunks.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const chunksBefore = channelEvents(send, IPC_CHANNELS.CHAT_CHUNK);
    expect(chunksBefore.length).toBeGreaterThanOrEqual(1);
    expect(
      chunksBefore.some(([, p]) => (p as { data: string }).data.includes('Session-A-chunk')),
    ).toBe(true);

    // Simulate session:load / session:create abort path
    chatIpc.forceAbortChat(String(webContents.id));

    // Let the stream continue after abort — stale content must not be forwarded
    releaseSecondHalf!();
    await sendPromise;
    // Allow any deferred microtasks / actor stop notifications
    await new Promise((resolve) => setTimeout(resolve, 30));

    const allChunks = channelEvents(send, IPC_CHANNELS.CHAT_CHUNK);
    const leaked = allChunks.filter(([, p]) =>
      (p as { data: string }).data.includes('LEAKED-AFTER-ABORT'),
    );
    expect(leaked).toHaveLength(0);

    // forceAbort is silent — must not emit CHAT_DONE for the aborted turn
    const donesAfterAbort = doneEvents(send);
    expect(donesAfterAbort).toHaveLength(0);
  });

  it('forceAbortChat prevents old agent chunks from interleaving with a new turn', async () => {
    let releaseOldStream: (() => void) | undefined;
    const oldStreamGate = new Promise<void>((resolve) => {
      releaseOldStream = resolve;
    });

    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield { type: 'content', text: 'OLD-TURN' };
        await oldStreamGate;
        yield { type: 'content', text: 'OLD-STALE-TAIL' };
        yield { type: 'finish', finishReason: 'stop' };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'content', text: 'NEW-TURN' };
        yield { type: 'finish', finishReason: 'stop' };
      });

    const send = vi.fn();
    const webContents = { id: 48, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    const oldSendPromise = chatSend!({ sender: webContents }, { message: 'old' });

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (
        channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).some(([, p]) =>
          (p as { data: string }).data.includes('OLD-TURN'),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Session switch aborts old agent, then a new turn starts on the same window
    chatIpc.forceAbortChat(String(webContents.id));
    await chatSend!({ sender: webContents }, { message: 'new' });
    await waitForDoneCount(send, 1);

    // Old stream resumes after the new turn — must not emit stale chunks
    releaseOldStream!();
    await oldSendPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const chunkTexts = channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).map(
      ([, p]) => (p as { data: string }).data,
    );
    expect(chunkTexts.some((t) => t.includes('OLD-STALE-TAIL'))).toBe(false);
    expect(chunkTexts.some((t) => t.includes('NEW-TURN'))).toBe(true);

    const responses = doneEvents(send).map(([, p]) => (p as { response: string }).response);
    expect(responses).toEqual(['NEW-TURN']);
  });
});
