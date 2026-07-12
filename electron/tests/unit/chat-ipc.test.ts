import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const streamResponses: string[] = [];
  const streamEventSequences: Array<Array<Record<string, unknown>>> = [];
  const electronWebContents = {
    fromId: vi.fn(() => null),
  };

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
  const workspaceByWindow = new Map<string, string>();
  const generalAgent = {
    name: 'general',
    type: 'subagent' as const,
    tier: 'bloom' as const,
    description: 'General-purpose agent',
    system_prompt: 'You are a helpful assistant.',
    allowed_tools: ['*'],
    allowed_skills: ['*'],
  };
  const runtimeByCwd = new Map<string, {
    config: Record<string, unknown>;
    agents: Map<string, typeof generalAgent>;
    skills: Map<string, unknown>;
    personalities: Map<string, string>;
  }>();
  const runtimeRegistry = {
    get: vi.fn((cwd: string) => {
      const existing = runtimeByCwd.get(cwd);
      if (existing) return { projectDir: cwd, ...existing };
      return {
        projectDir: cwd,
        config: {
          default_model: 'test/model',
          tier_models: { bloom: 'test/model' },
          command_timeout: 30,
          llm_stream_retries: 0,
        },
        agents: new Map([['general', generalAgent]]),
        skills: new Map(),
        personalities: new Map(),
      };
    }),
    _set: (cwd: string, runtime: {
      config?: Record<string, unknown>;
      agents?: Map<string, typeof generalAgent>;
      skills?: Map<string, unknown>;
      personalities?: Map<string, string>;
    }) => {
      runtimeByCwd.set(cwd, {
        config: runtime.config ?? {
          default_model: 'test/model',
          tier_models: { bloom: 'test/model' },
          command_timeout: 30,
          llm_stream_retries: 0,
        },
        agents: runtime.agents ?? new Map([['general', generalAgent]]),
        skills: runtime.skills ?? new Map(),
        personalities: runtime.personalities ?? new Map(),
      });
    },
    _reset: () => {
      runtimeByCwd.clear();
      runtimeRegistry.get.mockClear();
    },
  };
  const toolRegistry = {
    filter: vi.fn(() => []),
    get: vi.fn(() => null),
    validate: vi.fn(() => ({ ok: true as const, data: {} })),
  };

  const sessionManager = {
    getActive: vi.fn(() => activeSession),
    clearActive: vi.fn(() => {
      activeSession = null;
    }),
    create: vi.fn((model: string, options?: { cwd?: string | null }) => {
      activeSession = {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
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
    changeCwd: vi.fn((id: string, cwd: string) => {
      if (!activeSession || activeSession.id !== id) {
        throw new Error(`Cannot change cwd: session ${id} is not active`);
      }
      activeSession = { ...activeSession, cwd };
      return activeSession;
    }),
    startChain: vi.fn((params?: { messages?: unknown[] }) => {
      if (!activeSession) return null;
      const chain = {
        id: `chain-${activeSession.chains.length + 1}`,
        sessionId: activeSession.id,
        messages: params?.messages ?? [],
        status: 'active',
        model: activeSession.model,
        agentName: 'general',
        agentType: 'subagent',
        agentTier: 'bloom',
        subagentRecord: null,
        startTime: new Date().toISOString(),
        endTime: null,
      };
      activeSession = {
        ...activeSession,
        chains: [...activeSession.chains, chain],
        activeChainId: chain.id,
      };
      return chain;
    }),
    persistTurn: vi.fn((params: { messages: unknown[]; status?: string }) => {
      if (!activeSession) return null;
      const status = params.status ?? 'completed';
      const activeId = activeSession.activeChainId;
      const idx = activeId
        ? activeSession.chains.findIndex((c: { id: string }) => c.id === activeId)
        : -1;
      if (idx >= 0) {
        const chains = activeSession.chains.map((c: { id: string }, i: number) =>
          i === idx
            ? {
                ...c,
                messages: params.messages,
                status,
                endTime: new Date().toISOString(),
              }
            : c,
        );
        activeSession = {
          ...activeSession,
          chains,
          activeChainId: null,
        };
      } else {
        const chain = {
          id: `chain-${activeSession.chains.length + 1}`,
          sessionId: activeSession.id,
          messages: params.messages,
          status,
          model: activeSession.model,
          agentName: 'general',
          agentType: 'subagent',
          agentTier: 'bloom',
          subagentRecord: null,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
        };
        activeSession = {
          ...activeSession,
          chains: [...activeSession.chains, chain],
          activeChainId: null,
        };
      }
      return activeSession;
    }),
    syncActiveChain: vi.fn((params: { messages: unknown[]; status?: string }) => {
      return sessionManager.persistTurn(params);
    }),
    autoNameActive: vi.fn(async () => activeSession),
    autoName: vi.fn(async () => activeSession),
    /** Test helper: reset between cases */
    _reset: () => {
      activeSession = null;
      workspaceBound = true;
      workspaceByWindow.clear();
      sessionManager.getActive.mockClear();
      sessionManager.create.mockClear();
      sessionManager.changeCwd.mockClear();
      sessionManager.clearActive.mockClear();
      sessionManager.startChain.mockClear();
      sessionManager.persistTurn.mockClear();
      sessionManager.syncActiveChain.mockClear();
      sessionManager.autoNameActive.mockClear();
      sessionManager.autoName.mockClear();
    },
    /** Test helper: seed an active session without going through create(). */
    _setActive: (session: typeof activeSession) => {
      activeSession = session;
    },
  };

  const workspace = {
    resolveWorkspace: vi.fn((windowId: string, _options?: unknown) => {
      if (!workspaceBound) {
        return { cwd: null, source: 'unbound' as const, status: 'unbound' as const };
      }
      return {
        cwd: workspaceByWindow.get(windowId) ?? testProjectDir,
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
    _setWindowCwd: (windowId: string, cwd: string) => {
      workspaceByWindow.set(windowId, cwd);
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
    listAgents: vi.fn(() => [generalAgent]),
    subagentManager: {
      cancelRunning: vi.fn(() => []),
    },
    publishSessionActivity: vi.fn(),
    completeSessionActivity: vi.fn(),
    electronWebContents,
    runtimeRegistry,
    toolRegistry,
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  webContents: mocks.electronWebContents,
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

vi.mock('../../src/main/config/runtime', () => ({
  getRuntimeConfig: vi.fn(async () => ({
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
  toolRegistry: mocks.toolRegistry,
  createBuiltinToolRegistry: vi.fn(() => mocks.toolRegistry),
  getBuiltinToolRegistryForRuntime: vi.fn(() => mocks.toolRegistry),
  getSubagentManager: vi.fn(() => mocks.subagentManager),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (windowId: string) =>
    mocks.workspace.resolveWorkspace(windowId),
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

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => mocks.runtimeRegistry,
  hydrateProjectRuntime: async <T>(runtime: T) => runtime,
}));

vi.mock('../../src/main/ipc/session-activity', () => ({
  publishSessionActivity: mocks.publishSessionActivity,
  completeSessionActivity: mocks.completeSessionActivity,
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

function makeSession(id: string, cwd = mocks.workspace._testProjectDir) {
  return {
    id,
    name: `Session ${id.slice(0, 8)}`,
    model: 'test/model',
    cwd,
    chains: [],
    activeChainId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subagentChains: [],
    todoStore: { tasks: [] },
  };
}

describe('chat IPC', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.subagentManager.cancelRunning.mockClear();
    mocks.runtimeRegistry._reset();
    mocks.electronWebContents.fromId.mockReset();
    mocks.electronWebContents.fromId.mockReturnValue(null);
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

    expect(mocks.publishSessionActivity).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expect.objectContaining({ state: 'working', phase: 'agent' }),
    );
    expect(mocks.completeSessionActivity).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      false,
    );

    expect(mocks.sessionManager.create).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManager.create).toHaveBeenCalledWith(
      'preferred/model',
      { cwd: mocks.workspace._testProjectDir },
      '99',
    );
    expect(mocks.sessionManager.getActive()?.id).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(mocks.sessionManager.getActive()?.cwd).toBe(mocks.workspace._testProjectDir);
    expect(mocks.workspace.clearDraftCwd).toHaveBeenCalledWith('99');

    const created = channelEvents(send, IPC_CHANNELS.SESSION_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0][1]).toMatchObject({
      session: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', model: 'preferred/model' },
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

  it('binds legacy null session cwd from sticky/draft workspace before tools run', async () => {
    mocks.streamResponses.push('Legacy bound');
    mocks.sessionManager._setActive({
      id: 'legacy-session-id',
      name: 'Legacy',
      model: 'test/model',
      cwd: null,
      chains: [],
      activeChainId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subagentChains: [],
      todoStore: { tasks: [] },
    });

    const send = vi.fn();
    const webContents = { id: 101, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: webContents }, { message: 'Hello legacy' });
    await waitForDoneCount(send, 1);

    expect(mocks.sessionManager.changeCwd).toHaveBeenCalledWith(
      'legacy-session-id',
      mocks.workspace._testProjectDir,
    );
    expect(mocks.sessionManager.getActive()?.cwd).toBe(mocks.workspace._testProjectDir);
    expect(mocks.sessionManager.create).not.toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalled();
  });

  it('passes frozen turn cwd + sessionId into streamChat context', async () => {
    mocks.streamResponses.push('ctx ok');
    mocks.sessionManager._setActive({
      id: 'turn-ctx-session',
      name: 'Ctx',
      model: 'test/model',
      cwd: mocks.workspace._testProjectDir,
      chains: [],
      activeChainId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subagentChains: [],
      todoStore: { tasks: [] },
    });

    const send = vi.fn();
    const webContents = { id: 102, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: webContents }, { message: 'Use frozen cwd' });
    await waitForDoneCount(send, 1);

    expect(mocks.streamChat).toHaveBeenCalled();
    const call = mocks.streamChat.mock.calls[0]?.[0] as {
      context?: { cwd?: string };
      sessionId?: string;
    };
    expect(call.context?.cwd).toBe(mocks.workspace._testProjectDir);
    expect(call.sessionId).toBe('turn-ctx-session');
  });

  it('captures independent project config, agents, and personality for each turn', async () => {
    const projectA = '/tmp/orchid-project-a';
    const projectB = '/tmp/orchid-project-b';
    const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mocks.workspace._setWindowCwd('111', projectA);
    mocks.workspace._setWindowCwd('112', projectB);
    mocks.runtimeRegistry._set(projectA, {
      config: {
        default_model: 'project-a/model',
        tier_models: { bloom: 'project-a/model' },
        command_timeout: 30,
        llm_stream_retries: 0,
        personality: 'voice',
      },
      agents: new Map([['general', {
        name: 'general',
        type: 'subagent' as const,
        tier: 'bloom' as const,
        description: 'Project A agent',
        system_prompt: 'Project A prompt.',
        allowed_tools: ['*'],
        allowed_skills: ['*'],
      }]]),
      personalities: new Map([['voice', 'Project A voice.']]),
    });
    mocks.runtimeRegistry._set(projectB, {
      config: {
        default_model: 'project-b/model',
        tier_models: { bloom: 'project-b/model' },
        command_timeout: 30,
        llm_stream_retries: 0,
        personality: 'voice',
      },
      agents: new Map([['general', {
        name: 'general',
        type: 'subagent' as const,
        tier: 'bloom' as const,
        description: 'Project B agent',
        system_prompt: 'Project B prompt.',
        allowed_tools: ['*'],
        allowed_skills: ['*'],
      }]]),
      personalities: new Map([['voice', 'Project B voice.']]),
    });
    mocks.streamResponses.push('A done', 'B done');

    const sendA = vi.fn();
    const sendB = vi.fn();
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    expect(chatSend).toBeDefined();

    mocks.sessionManager._setActive(makeSession(sessionA, projectA));
    await chatSend!({ sender: { id: 111, send: sendA } }, { message: 'A' });
    await waitForDoneCount(sendA, 1);

    mocks.sessionManager._setActive(makeSession(sessionB, projectB));
    await chatSend!({ sender: { id: 112, send: sendB } }, { message: 'B' });
    await waitForDoneCount(sendB, 1);

    const first = mocks.streamChat.mock.calls[0]?.[0] as {
      config: { default_model: string };
      agent: { description: string };
      systemPrompt: string;
      context: { cwd: string };
    };
    const second = mocks.streamChat.mock.calls[1]?.[0] as typeof first;
    expect(first.config.default_model).toBe('project-a/model');
    expect(first.agent.description).toBe('Project A agent');
    expect(first.systemPrompt).toContain('Project A voice.');
    expect(first.context.cwd).toBe(projectA);
    expect(second.config.default_model).toBe('project-b/model');
    expect(second.agent.description).toBe('Project B agent');
    expect(second.systemPrompt).toContain('Project B voice.');
    expect(second.context.cwd).toBe(projectB);
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

  it('returns a session-addressed live snapshot for a running turn', async () => {
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const send = vi.fn();
    const webContents = { id: 49, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    const chatSnapshot = mocks.handlers.get(IPC_CHANNELS.CHAT_SNAPSHOT);
    expect(chatSend).toBeDefined();
    expect(chatSnapshot).toBeDefined();

    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Live partial response' };
      await streamGate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const sendPromise = chatSend!({ sender: webContents }, { message: 'Keep going' });

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const snapshot = await chatSnapshot!(
      { sender: webContents },
      { sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    );
    expect(snapshot).toMatchObject({
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      state: 'streaming',
      response: 'Live partial response',
      thinking: '',
      toolCalls: [],
      error: null,
      interrupted: false,
    });
    expect(snapshot.turnId).toEqual(expect.any(String));
    expect(snapshot.sequence).toEqual(expect.any(Number));
    expect(
      await chatSnapshot!(
        { sender: webContents },
        { sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      ),
    ).toBeNull();

    releaseStream!();
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
  it('explicit window abort stops further CHAT_CHUNK emission', async () => {
    // Stream yields one chunk, pauses during an explicit abort window, then more content.
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

    // Explicitly abort the selected session through the legacy window shim.
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

  it('replacement send aborts old activity before publishing the new turn', async () => {
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

    mocks.publishSessionActivity.mockClear();
    mocks.completeSessionActivity.mockClear();

    // Replacement send owns the abort and must finish old activity first.
    await chatSend!({ sender: webContents }, { message: 'new' });
    await waitForDoneCount(send, 1);

    expect(mocks.completeSessionActivity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishSessionActivity.mock.invocationCallOrder[0]!,
    );

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

  it('cancels only the requested running session and preserves another window stream', async () => {
    const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });

    mocks.streamChat
      .mockImplementationOnce(async function* () {
        yield { type: 'content', text: 'A-first' };
        await aGate;
        yield { type: 'content', text: 'A-stale-tail' };
        yield { type: 'finish', finishReason: 'stop' };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'content', text: 'B-first' };
        await bGate;
        yield { type: 'content', text: 'B-finished' };
        yield { type: 'finish', finishReason: 'stop' };
      });

    const sendA = vi.fn();
    const sendB = vi.fn();
    const windowA = { id: 301, send: sendA };
    const windowB = { id: 302, send: sendB };
    mocks.electronWebContents.fromId.mockImplementation((id: number) => {
      if (id === windowA.id) return windowA;
      if (id === windowB.id) return windowB;
      return null;
    });
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    const chatCancel = mocks.handlers.get(IPC_CHANNELS.CHAT_CANCEL);
    expect(chatSend).toBeDefined();
    expect(chatCancel).toBeDefined();

    mocks.sessionManager._setActive(makeSession(sessionA));
    const aSendPromise = chatSend!({ sender: windowA }, { message: 'run A' });
    const firstDeadline = Date.now() + 1000;
    while (Date.now() < firstDeadline) {
      if (channelEvents(sendA, IPC_CHANNELS.CHAT_CHUNK).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    mocks.sessionManager._setActive(makeSession(sessionB));
    const bSendPromise = chatSend!({ sender: windowB }, { message: 'run B' });
    const secondDeadline = Date.now() + 1000;
    while (Date.now() < secondDeadline) {
      if (channelEvents(sendB, IPC_CHANNELS.CHAT_CHUNK).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await chatCancel!({ sender: windowB }, { sessionId: sessionA })).toEqual({
      status: 'confirming',
    });
    expect(await chatCancel!({ sender: windowB }, { sessionId: sessionA })).toEqual({
      status: 'confirming_subagents',
    });
    expect(await chatCancel!({ sender: windowB }, { sessionId: sessionA })).toEqual({
      status: 'cancelled',
    });
    expect(mocks.subagentManager.cancelRunning).toHaveBeenCalledWith(sessionA);

    releaseB!();
    await bSendPromise;
    await waitForDoneCount(sendB, 1);

    releaseA!();
    await aSendPromise;
    await new Promise((resolve) => setTimeout(resolve, 25));

    const aChunks = channelEvents(sendA, IPC_CHANNELS.CHAT_CHUNK).map(
      ([, event]) => event as { sessionId: string; data: string },
    );
    const bChunks = channelEvents(sendB, IPC_CHANNELS.CHAT_CHUNK).map(
      ([, event]) => event as { sessionId: string; data: string },
    );
    expect(aChunks.some((event) => event.data === 'A-stale-tail')).toBe(false);
    expect(aChunks.every((event) => event.sessionId === sessionA)).toBe(true);
    expect(bChunks.every((event) => event.sessionId === sessionB)).toBe(true);
    expect(bChunks.some((event) => event.data === 'B-finished')).toBe(true);

    expect(doneEvents(sendA).map(([, event]) => (event as { sessionId: string }).sessionId))
      .toContain(sessionA);
    expect(doneEvents(sendB).map(([, event]) => (event as { sessionId: string }).sessionId))
      .toEqual([sessionB]);
  });

  it('immediately stops one session for the global activity surface', async () => {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'Before stop' };
      await gate;
      yield { type: 'content', text: 'Must not leak' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const send = vi.fn();
    const windowA = { id: 350, send };
    mocks.electronWebContents.fromId.mockImplementation((id: number) =>
      id === windowA.id ? windowA : null,
    );
    mocks.sessionManager._setActive(makeSession(sessionId));
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);
    const chatStop = mocks.handlers.get(IPC_CHANNELS.CHAT_STOP);
    expect(chatSend).toBeDefined();
    expect(chatStop).toBeDefined();

    const sendPromise = chatSend!({ sender: windowA }, { message: 'Stop me' });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await chatStop!({ sender: { id: 351, send: vi.fn() } }, { sessionId }))
      .toEqual({ status: 'stopped' });
    expect(mocks.subagentManager.cancelRunning).toHaveBeenCalledWith(sessionId);
    expect(doneEvents(send).map(([, event]) => (event as { sessionId: string }).sessionId))
      .toContain(sessionId);

    release!();
    await sendPromise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(channelEvents(send, IPC_CHANNELS.CHAT_CHUNK).some(([, event]) =>
      (event as { data: string }).data === 'Must not leak',
    )).toBe(false);
  });

  it('multi-chain: startChain + persistTurn turn-local + SESSION_UPDATED on each send', async () => {
    mocks.streamResponses.push('Answer one', 'Answer two');
    mocks.sessionManager._setActive({
      id: 'multi-chain-session',
      name: 'Multi',
      model: 'test/model',
      cwd: mocks.workspace._testProjectDir,
      chains: [],
      activeChainId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subagentChains: [],
      todoStore: { tasks: [] },
    });

    const send = vi.fn();
    const webContents = { id: 201, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: webContents }, { message: 'Q1' });
    await waitForDoneCount(send, 1);

    expect(mocks.sessionManager.startChain).toHaveBeenCalled();
    const start1 = mocks.sessionManager.startChain.mock.calls[0]?.[0] as {
      messages?: Array<{ content: string }>;
    };
    expect(start1?.messages?.[0]?.content).toBe('Q1');

    expect(mocks.sessionManager.persistTurn).toHaveBeenCalled();
    const persist1 = mocks.sessionManager.persistTurn.mock.calls[0]?.[0] as {
      messages: Array<{ content: string; role?: string }>;
      status?: string;
    };
    // Turn-local: user + assistant only for this turn (not full cumulative history blob alone)
    expect(persist1.messages.some((m) => m.content === 'Q1')).toBe(true);
    expect(persist1.status).toBe('completed');

    const updated = channelEvents(send, IPC_CHANNELS.SESSION_UPDATED);
    expect(updated.length).toBeGreaterThanOrEqual(1);

    await chatSend!({ sender: webContents }, { message: 'Q2' });
    await waitForDoneCount(send, 2);

    expect(mocks.sessionManager.startChain.mock.calls.length).toBeGreaterThanOrEqual(2);
    const start2 = mocks.sessionManager.startChain.mock.calls.at(-1)?.[0] as {
      messages?: Array<{ content: string }>;
    };
    expect(start2?.messages?.[0]?.content).toBe('Q2');

    const lastPersist = mocks.sessionManager.persistTurn.mock.calls.at(-1)?.[0] as {
      messages: Array<{ content: string }>;
    };
    // Second turn must not rewrite first-turn-only messages into one mega-chain call
    expect(lastPersist.messages.some((m) => m.content === 'Q2')).toBe(true);
    expect(lastPersist.messages.every((m) => m.content !== 'Q1')).toBe(true);
  });

  it('multi-chain: stream error persists FAILED via persistTurn', async () => {
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'partial' };
      yield {
        type: 'error',
        title: 'Stream Error',
        detail: 'boom',
      };
    });
    mocks.sessionManager._setActive({
      id: 'fail-session',
      name: 'Fail',
      model: 'test/model',
      cwd: mocks.workspace._testProjectDir,
      chains: [],
      activeChainId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subagentChains: [],
      todoStore: { tasks: [] },
    });

    const send = vi.fn();
    const webContents = { id: 202, send };
    const chatSend = mocks.handlers.get(IPC_CHANNELS.CHAT_SEND);

    await chatSend!({ sender: webContents }, { message: 'Will fail' });

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (mocks.sessionManager.persistTurn.mock.calls.some(
        (c) => (c[0] as { status?: string }).status === 'failed',
      )) {
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    const failed = mocks.sessionManager.persistTurn.mock.calls.find(
      (c) => (c[0] as { status?: string }).status === 'failed',
    );
    expect(failed).toBeDefined();
    const payload = failed![0] as { messages: Array<{ content: string }> };
    expect(payload.messages.some((m) => m.content === 'Will fail')).toBe(true);
  });
});
