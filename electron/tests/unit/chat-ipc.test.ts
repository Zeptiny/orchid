import * as fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { Agent } from '../../src/shared/types/agent';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import {
  clearNextRequestStop,
  requestNextRequestStop,
  shouldStopNextRequest,
} from '../../src/main/ipc/next-request-stop';
import { OPENAI_TIER_MECHANISM } from '../../src/main/providers/drivers/native';

function successfulToolResult(toolCallId: string, content: string): Record<string, unknown> {
  const canonical = createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: content },
  });
  return {
    type: 'tool_result',
    toolCallId,
    content,
    isError: false,
    execution: {
      canonical,
      agentProjection: { content, completeness: 'complete' },
    },
  };
}

function cancelledToolResult(toolCallId: string): Record<string, unknown> {
  const canonical = createCanonicalToolResult('generic', {
    status: 'cancelled',
    data: { questions: [], answers: [], cancelled: true },
  });
  return {
    type: 'tool_result',
    toolCallId,
    content: 'Question cancelled',
    isError: false,
    execution: {
      canonical,
      agentProjection: { content: 'Question cancelled', completeness: 'complete' },
    },
  };
}

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const streamResponses: string[] = [];
  const streamEventSequences: Array<Array<Record<string, unknown>>> = [];
  const electronWebContents = {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => []),
  };

  type MockSession = {
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
    selection?: { connectionId: string; modelId: string } | null;
    modelLabel?: string;
    reasoningEffortOverride?: string | number | null;
    tierOverride?: string | null;
  };
  let activeSession: MockSession | null = null;
  const sessionsById = new Map<string, MockSession>();
  const activeSessionsByWindow = new Map<string, MockSession | null>();

  let workspaceBound = true;
  const testProjectDir = '/tmp/orchid-chat-ipc-project';
  const workspaceByWindow = new Map<string, string>();
  const generalAgent = {
    name: 'general',
    type: 'internal' as const,
    tier: 'bloom' as const,
    description: 'General-purpose agent',
    system_prompt: 'You are a helpful assistant.',
    allowed_tools: ['*'],
    allowed_skills: ['*'],
  } satisfies Agent;
  const sessionNamerAgent = {
    name: 'session-namer',
    type: 'internal' as const,
    tier: 'seed' as const,
    description: 'Generates concise session titles',
    system_prompt: 'Return one concise title for the supplied conversation.',
    allowed_tools: [],
    allowed_skills: [],
  } satisfies Agent;
  const runtimeByCwd = new Map<string, {
    config: Record<string, unknown>;
    agents: Map<string, Agent>;
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
          default_model: null,
          tier_models: { bloom: null },
          command_timeout: 30,
          llm_stream_idle_timeout: 60,
          llm_stream_retries: 0,
          session_title_max_wait_seconds: 15,
        },
        agents: new Map([
          ['general', generalAgent],
          ['session-namer', sessionNamerAgent],
        ]),
        skills: new Map(),
        personalities: new Map(),
      };
    }),
    _set: (cwd: string, runtime: {
      config?: Record<string, unknown>;
      agents?: Map<string, Agent>;
      skills?: Map<string, unknown>;
      personalities?: Map<string, string>;
    }) => {
      runtimeByCwd.set(cwd, {
        config: runtime.config ?? {
          default_model: null,
          tier_models: { bloom: null },
          command_timeout: 30,
          llm_stream_idle_timeout: 60,
          llm_stream_retries: 0,
          session_title_max_wait_seconds: 15,
        },
        agents: runtime.agents ?? new Map([
          ['general', generalAgent],
          ['session-namer', sessionNamerAgent],
        ]),
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
  const modelInstance = { provider: 'trusted-test-driver' };
  const providerRuntime = {
    resolveLanguageModel: vi.fn(async () => modelInstance),
    resolveTierContext: vi.fn(async () => ({ connection: {}, tierMechanism: undefined })),
    resolveExecution: vi.fn(async () => ({
      modelInstance,
      connection: {},
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
      },
    })),
  };
  const aiGenerateText = vi.fn(async () => ({ text: 'Investigate Session Naming' }));
  const wrappedTitleModel = { provider: 'wrapped-title-model' };
  const aiWrapLanguageModel = vi.fn(() => wrappedTitleModel);
  const createMiddlewareStack = vi.fn(() => []);
  const accountingStore = {};
  const buildSystemPromptContext = vi.fn(async ({ cwd }: { cwd: string }) => ({
    cwd,
    directoryTree: '',
    subagents: [],
    todos: [],
    backgroundCommands: [],
  }));
  const mcpManager = {};

  const sessionManager = {
    getActive: vi.fn((windowId?: string) => (
      windowId === undefined
        ? activeSession
        : activeSessionsByWindow.has(windowId)
          ? activeSessionsByWindow.get(windowId) ?? null
          : activeSession
    )),
    clearActive: vi.fn(() => {
      activeSession = null;
    }),
    create: vi.fn((model: string | { connectionId: string; modelId: string }, options?: { cwd?: string | null }) => {
      const modelLabel = typeof model === 'string' ? model : model.modelId;
      activeSession = {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Session draft',
        model: modelLabel,
        cwd: options?.cwd ?? null,
        chains: [],
        activeChainId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subagentChains: [],
        todoStore: { tasks: [] },
        selection: typeof model === 'string' ? undefined : model,
        modelLabel,
      };
      sessionsById.set(activeSession.id, activeSession);
      return activeSession;
    }),
    changeCwd: vi.fn((id: string, cwd: string) => {
      if (!activeSession || activeSession.id !== id) {
        throw new Error(`Cannot change cwd: session ${id} is not active`);
      }
      activeSession = { ...activeSession, cwd };
      sessionsById.set(id, activeSession);
      return activeSession;
    }),
    changeModel: vi.fn((
      id: string,
      selection: { connectionId: string; modelId: string },
      modelLabel: string,
    ) => {
      if (!activeSession || activeSession.id !== id) {
        throw new Error(`Cannot change model: session ${id} is not active`);
      }
      activeSession = { ...activeSession, selection, model: modelLabel, modelLabel };
      sessionsById.set(id, activeSession);
      return activeSession;
    }),
    setReasoningEffortOverride: vi.fn((id: string, effort: string | number | null) => {
      const target = sessionsById.get(id) ?? (activeSession?.id === id ? activeSession : null);
      if (!target) return;
      const updated = { ...target, reasoningEffortOverride: effort };
      sessionsById.set(id, updated);
      if (activeSession?.id === id) activeSession = updated;
    }),
    setPermissionMode: vi.fn((id: string, mode: string | null) => {
      const target = sessionsById.get(id) ?? (activeSession?.id === id ? activeSession : null);
      if (!target) return;
      const updated = { ...target, permissionMode: mode };
      sessionsById.set(id, updated);
      if (activeSession?.id === id) activeSession = updated;
    }),
    getSession: vi.fn((id: string) => sessionsById.get(id) ?? (activeSession?.id === id ? activeSession : null)),
    switchTo: vi.fn((id: string) => {
      const session = sessionsById.get(id) ?? (activeSession?.id === id ? activeSession : null);
      if (session) activeSession = session;
      return session;
    }),
    startChain: vi.fn((params?: { messages?: unknown[]; }, sessionId?: string) => {
      const target = sessionId
        ? sessionsById.get(sessionId) ?? null
        : activeSession;
      if (!target) return null;
      const chain = {
        id: `chain-${target.chains.length + 1}`,
        sessionId: target.id,
        messages: params?.messages ?? [],
        status: 'active',
        model: target.model,
        agentName: 'general',
        agentType: 'subagent',
        agentTier: 'bloom',
        subagentRecord: null,
        startTime: new Date().toISOString(),
        endTime: null,
      };
      const updated = {
        ...target,
        chains: [...target.chains, chain],
        activeChainId: chain.id,
      };
      sessionsById.set(updated.id, updated);
      if (activeSession?.id === updated.id) activeSession = updated;
      return chain;
    }),
    updateActiveChainMessages: vi.fn((messages: unknown[], sessionId?: string) => {
      const target = sessionId
        ? sessionsById.get(sessionId) ?? null
        : activeSession;
      if (!target?.activeChainId) return null;
      const updated = {
        ...target,
        chains: target.chains.map((chain: { id: string }) =>
          chain.id === target.activeChainId ? { ...chain, messages } : chain
        ),
      };
      sessionsById.set(updated.id, updated);
      if (activeSession?.id === updated.id) activeSession = updated;
      return updated;
    }),
    persistTurn: vi.fn((params: { messages: unknown[]; status?: string }, sessionId?: string) => {
      const target = sessionId
        ? sessionsById.get(sessionId) ?? null
        : activeSession;
      if (!target) return null;
      const status = params.status ?? 'completed';
      const activeId = target.activeChainId;
      const idx = activeId
        ? target.chains.findIndex((c: { id: string }) => c.id === activeId)
        : -1;
      let updated: MockSession;
      if (idx >= 0) {
        const chains = target.chains.map((c: { id: string }, i: number) =>
          i === idx
            ? {
                ...c,
                messages: params.messages,
                status,
                endTime: new Date().toISOString(),
              }
            : c,
        );
        updated = {
          ...target,
          chains,
          activeChainId: null,
        };
      } else {
        const chain = {
          id: `chain-${target.chains.length + 1}`,
          sessionId: target.id,
          messages: params.messages,
          status,
          model: target.model,
          agentName: 'general',
          agentType: 'subagent',
          agentTier: 'bloom',
          subagentRecord: null,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
        };
        updated = {
          ...target,
          chains: [...target.chains, chain],
          activeChainId: null,
        };
      }
      sessionsById.set(updated.id, updated);
      if (activeSession?.id === updated.id) activeSession = updated;
      return updated;
    }),
    autoNameActive: vi.fn(async () => activeSession),
    autoName: vi.fn(async (
      _sessionId: string,
      generateTitle?: (session: NonNullable<typeof activeSession>) => Promise<string | null>,
    ) => {
      if (!activeSession || !generateTitle) return activeSession;
      const title = await generateTitle(activeSession);
      if (title) {
        activeSession = { ...activeSession, name: title };
        sessionsById.set(activeSession.id, activeSession);
      }
      return activeSession;
    }),
    /** Test helper: reset between cases */
    _reset: () => {
      activeSession = null;
      sessionsById.clear();
      activeSessionsByWindow.clear();
      workspaceBound = true;
      workspaceByWindow.clear();
      sessionManager.getActive.mockClear();
      sessionManager.create.mockClear();
      sessionManager.changeCwd.mockClear();
      sessionManager.changeModel.mockClear();
      sessionManager.getSession.mockClear();
      sessionManager.switchTo.mockClear();
      sessionManager.clearActive.mockClear();
      sessionManager.startChain.mockClear();
      sessionManager.updateActiveChainMessages.mockClear();
      sessionManager.persistTurn.mockClear();
      sessionManager.setReasoningEffortOverride.mockClear();
      sessionManager.setPermissionMode.mockClear();
      sessionManager.autoNameActive.mockClear();
      sessionManager.autoName.mockClear();
    },
    /** Test helper: seed an active session without going through create(). */
    _setActive: (session: MockSession | null) => {
      activeSession = session;
      if (session) sessionsById.set(session.id, session);
    },
    _setActiveForWindow: (windowId: string, session: MockSession | null) => {
      activeSessionsByWindow.set(windowId, session);
    },
    /** Test helper: register a session without selecting it for the window. */
    _putSession: (session: MockSession) => {
      sessionsById.set(session.id, session);
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

  const backgroundEntries = new Map<number, {
    sessionId: string | null;
    agentScopeId: string;
    tail: string;
    exitCode: number | null;
    interactive?: boolean;
    owner?: 'AGENT' | 'USER';
    command?: string;
    description?: string;
    createdAt?: number;
    buffer?: { getTail: (lastN?: number) => string };
  }>();
  const backgroundStore = {
    entries: backgroundEntries,
    terminateSession: vi.fn(),
    snapshot: vi.fn((commandId: number, _lastN?: number) => {
      const entry = backgroundEntries.get(commandId);
      if (!entry) return undefined;
      return { tail: entry.tail, exitCode: entry.exitCode };
    }),
    snapshotVisible: vi.fn((
      commandId: number,
      _lastN?: number,
      sessionId?: string | null,
      agentScopeId?: string,
    ) => {
      const entry = backgroundEntries.get(commandId);
      if (!entry) return undefined;
      if (entry.sessionId !== (sessionId ?? null)) return undefined;
      if (entry.agentScopeId !== (agentScopeId ?? 'main')) return undefined;
      return { tail: entry.tail, exitCode: entry.exitCode };
    }),
    snapshotForSession: vi.fn((
      commandId: number,
      _lastN: number | undefined,
      sessionId: string,
    ) => {
      const entry = backgroundEntries.get(commandId);
      if (!entry || entry.sessionId !== sessionId) return undefined;
      return { tail: entry.tail, exitCode: entry.exitCode };
    }),
    // The bgcmd:snapshot handler builds its found response directly from the
    // entry (single-lookup path), so hydrate the fields minimal fixtures omit,
    // mirroring real ProcessEntry defaults.
    get: vi.fn((commandId: number) => {
      const entry = backgroundEntries.get(commandId);
      if (!entry) return undefined;
      return {
        interactive: false,
        owner: 'AGENT' as const,
        command: '',
        ...entry,
        buffer: entry.buffer ?? { getTail: () => entry.tail },
      };
    }),
    list: vi.fn(() => []),
    _reset: () => {
      backgroundEntries.clear();
      backgroundStore.terminateSession.mockClear();
      backgroundStore.snapshot.mockClear();
      backgroundStore.snapshotVisible.mockClear();
      backgroundStore.snapshotForSession.mockClear();
      backgroundStore.get.mockClear();
    },
  };

  return {
    handlers,
    streamResponses,
    streamEventSequences,
    sessionManager,
    workspace,
    takeDraftReasoningOverride: vi.fn(
      () => undefined as string | number | null | undefined,
    ),
    takeDraftPermissionOverride: vi.fn(
      () => undefined as string | null | undefined,
    ),
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
    subagentManager: {
      cancelRunning: vi.fn(() => []),
    },
    publishSessionActivity: vi.fn(),
    completeSessionActivity: vi.fn(),
    electronWebContents,
    runtimeRegistry,
    generalAgent,
    sessionNamerAgent,
    toolRegistry,
    modelInstance,
    providerRuntime,
    aiGenerateText,
    aiWrapLanguageModel,
    wrappedTitleModel,
    createMiddlewareStack,
    buildSystemPromptContext,
    mcpManager,
    accountingStore,
    backgroundStore,
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  webContents: mocks.electronWebContents,
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    HOME_PERSONALITIES_DIR: '/tmp/orchid-test-personalities',
    getTierModelSelection: (
      config: {
        default_model: unknown;
        tier_models: Record<string, unknown>;
      },
      tier: string,
    ) => config.tier_models[tier] ?? config.default_model,
    getConfig: vi.fn(() => ({
      default_model: null,
      tier_models: { bloom: null },
      command_timeout: 30,
      llm_stream_idle_timeout: 60,
      llm_stream_retries: 0,
    })),
  };
});

vi.mock('../../src/main/tools', () => ({
  toolRegistry: mocks.toolRegistry,
  createBuiltinToolRegistry: vi.fn(() => mocks.toolRegistry),
  getBuiltinToolRegistryForRuntime: vi.fn(() => mocks.toolRegistry),
  getSubagentManager: vi.fn(() => mocks.subagentManager),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

vi.mock('../../src/main/llm/middleware', () => ({
  createMiddlewareStack: mocks.createMiddlewareStack,
}));

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async (specifier: string) => {
    if (specifier === 'ai') {
      return {
        generateText: mocks.aiGenerateText,
        wrapLanguageModel: mocks.aiWrapLanguageModel,
      };
    }
    throw new Error(`Unexpected importESM specifier in chat IPC test: ${specifier}`);
  }),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => mocks.providerRuntime,
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => mocks.accountingStore,
}));

vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: mocks.buildSystemPromptContext,
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: vi.fn(() => mocks.mcpManager),
  releaseProjectMCPManager: vi.fn(),
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (windowId: string) => mocks.workspace.resolveWorkspace(windowId),
}));

vi.mock('../../src/main/session/draft-reasoning', () => ({
  takeDraftReasoningOverride: (windowId: string) =>
    mocks.takeDraftReasoningOverride(windowId),
}));

vi.mock('../../src/main/permissions/session-overrides', () => ({
  takeDraftPermissionOverride: (windowId: string) =>
    mocks.takeDraftPermissionOverride(windowId),
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => mocks.runtimeRegistry,
}));

vi.mock('../../src/main/tools/process/background-store', () => ({
  getBackgroundStore: () => mocks.backgroundStore,
  setBackgroundStore: vi.fn(),
  BackgroundProcessStore: vi.fn(),
  subscribeBackgroundProcessChanges: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/ipc/session-activity', () => ({
  publishSessionActivity: mocks.publishSessionActivity,
  completeSessionActivity: mocks.completeSessionActivity,
}));

// The trust gate is fail-closed for the mocked (non-existent) workspace dirs,
// so these fixture cwds resolve as trusted to keep the suite on its own seams.
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
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

// ensureActiveSession inspects the real fixture directory before the trust
// gate (a deleted session folder must surface unbound_workspace), so the
// fixture project path has to exist on disk.
beforeAll(() => {
  fs.mkdirSync(mocks.workspace._testProjectDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(mocks.workspace._testProjectDir, { recursive: true, force: true });
});

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

    const result = chatIpc.ensureActiveSession(
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

    const result = chatIpc.ensureActiveSession(
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

    const result = chatIpc.ensureActiveSession(
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

async function waitForChannelCount(
  send: ReturnType<typeof vi.fn>,
  channelName: string,
  count: number,
) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    if (channelEvents(send, channelName).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${count} ${channelName} event(s)`);
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
    permissionMode: null,
  };
}

describe('chat IPC driver streaming', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.streamResponses.length = 0;
    mocks.streamEventSequences.length = 0;
    mocks.subagentManager.cancelRunning.mockClear();
    mocks.runtimeRegistry._reset();
    mocks.electronWebContents.fromId.mockReset();
    mocks.electronWebContents.fromId.mockReturnValue(null);
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
    chatIpc.forceAbortMainTurn('11111111-1111-4111-8111-111111111111');

    expect(mocks.subagentManager.cancelRunning).not.toHaveBeenCalled();
    expect(mocks.backgroundStore.terminateSession).not.toHaveBeenCalled();
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

    chatIpc.forceAbortMainTurn(sessionId, { emitTerminalEvents: true });

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
    expect(channelEvents(send, IPC_CHANNELS.SESSION_UPDATED).at(-1)?.[1]).toMatchObject({
      session: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', activeChainId: null },
    });
    expect(channelEvents(sameSession.send, IPC_CHANNELS.SESSION_UPDATED).at(-1)?.[1]).toMatchObject({
      session: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', activeChainId: null },
    });
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
});

describe('chat IPC teardown and bgcmd bounds', () => {
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

describe('chat:send draft single-flight (M-P1-013)', () => {
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

  it('concurrent draft sends create only one session', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.streamChat.mockImplementation(async function* () {
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
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.runtimeRegistry._reset();
    mocks.sessionManager._reset();
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
