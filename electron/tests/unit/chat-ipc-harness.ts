import * as fs from 'node:fs';
import { afterAll, beforeAll, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { Agent } from '../../src/shared/types/agent';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

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
  let modelHistory: Array<Record<string, unknown>> = [];
  // Real Electron resolves webContents.fromId(id) for the webContents serving
  // an IPC request; emulate that registry so event delivery can address the
  // inline sender objects by client id.
  const sendersById = new Map<number, unknown>();
  const electronWebContents = {
    fromId: vi.fn((id: number) => sendersById.get(id) ?? null),
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
  const testProjectDir = `/tmp/orchid-chat-ipc-project-${process.env.VITEST_WORKER_ID ?? process.pid}`;
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
    sharedPrompts: Record<'all-agents' | 'subagents', string | null>;
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
        sharedPrompts: { 'all-agents': null, subagents: null },
      };
    }),
    _set: (cwd: string, runtime: {
      config?: Record<string, unknown>;
      agents?: Map<string, Agent>;
      skills?: Map<string, unknown>;
      personalities?: Map<string, string>;
      sharedPrompts?: Record<'all-agents' | 'subagents', string | null>;
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
        sharedPrompts: runtime.sharedPrompts ?? { 'all-agents': null, subagents: null },
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
  // streamText adapter for the compaction paths: delegates to aiGenerateText so
  // mockImplementationOnce handlers keep working, exposing the result through a
  // single-chunk textStream + resolved usage (matches the consumption shape in
  // summarize.ts / selective/run.ts).
  const aiStreamText = vi.fn((args: Record<string, unknown>) => {
    const ready = aiGenerateText(args) as Promise<{ text?: string }>;
    // Zero-valued usage on both fulfilment and rejection so a failing
    // aiGenerateText never surfaces as an unhandled rejection.
    const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      textStream: (async function* () {
        const result = await ready;
        yield typeof result?.text === 'string' ? result.text : '';
      })(),
      usage: ready.then(() => zeroUsage, () => zeroUsage),
    };
  });
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
    load: vi.fn(() => null),
    setCachedSession: vi.fn(),
    /**
     * Mirror of SessionManager.refreshCachedSessionFromStorage: the mock's
     * "storage" is the sessionsById map, so the refresh returns the cached
     * row (the mock does not model durable compaction splits — those are
     * covered by session-compaction-persistence.test.ts).
     */
    refreshCachedSessionFromStorage: vi.fn((sessionId: string) =>
      sessionsById.get(sessionId) ?? null),
    getModelHistory: vi.fn(() => modelHistory),
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
        errorDetail: null,
        errorTitle: null,
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
    /**
     * Minimal mirror of SessionManager.applyCompaction (durable targeted
     * compaction write): reports the post-write chain layout without touching
     * the mock session rows — strict flag/anchor behavior is covered by
     * session-compaction-persistence.test.ts against real storage.
     */
    applyCompaction: vi.fn((
      sessionId: string,
      payload: {
        flaggedMessageIds?: readonly string[];
        summaryChain?: { id: string } | null;
      },
    ) => {
      const target = sessionsById.get(sessionId) ?? null;
      if (!target) {
        throw new Error(`applyCompaction: session ${sessionId} not found in durable rows`);
      }
      return {
        chainIds: [
          ...target.chains.map((chain: { id: string }) => chain.id),
          ...(payload.summaryChain ? [payload.summaryChain.id] : []),
        ],
        flaggedChainIds: [],
        summaryChainId: payload.summaryChain?.id ?? null,
      };
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
      modelHistory = [];
      workspaceBound = true;
      workspaceByWindow.clear();
      sessionManager.getActive.mockClear();
      sessionManager.create.mockClear();
      sessionManager.changeCwd.mockClear();
      sessionManager.changeModel.mockClear();
      sessionManager.getSession.mockClear();
      sessionManager.load.mockClear();
      sessionManager.setCachedSession.mockClear();
      sessionManager.getModelHistory.mockClear();
      sessionManager.switchTo.mockClear();
      sessionManager.clearActive.mockClear();
      sessionManager.startChain.mockClear();
      sessionManager.updateActiveChainMessages.mockClear();
      sessionManager.persistTurn.mockClear();
      sessionManager.applyCompaction.mockClear();
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
    _setModelHistory: (messages: Array<Record<string, unknown>>) => {
      modelHistory = messages;
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
    terminateScope: vi.fn(),
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
      backgroundStore.terminateScope.mockClear();
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
        handlers.set(channel, (event: { sender?: { id?: number } }, ...rest: unknown[]) => {
          const sender = event?.sender;
          if (sender && typeof sender.id === 'number') sendersById.set(sender.id, sender);
          return handler(event, ...rest);
        });
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
      discardSession: vi.fn(),
      getStates: vi.fn((): Array<{ id: string; state: string }> => []),
      // U5: the embedded local host's HostServer subscribes to manager changes.
      addOnChangeListener: vi.fn(() => vi.fn()),
    },
    sendersById,
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
    aiStreamText,
    aiWrapLanguageModel,
    wrappedTitleModel,
    createMiddlewareStack,
    buildSystemPromptContext,
    mcpManager,
    accountingStore,
    summarizeCompactableRange: vi.fn(),
    saveSession: vi.fn(),
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
  // U5: the embedded local host's HostServer installs its own notifier.
  setTodosChangedNotifier: vi.fn(),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

vi.mock('../../src/main/llm/compaction/summarize', async (importOriginal) => {
  // Partial-module mock: keep every real export (resolveCompactorModelSelection
  // uses the real fallback chain via the mocked config/loader) and override
  // only the summarizer call itself.
  const actual = await importOriginal<typeof import('../../src/main/llm/compaction/summarize')>();
  return {
    ...actual,
    summarizeCompactableRange: mocks.summarizeCompactableRange,
  };
});

vi.mock('../../src/main/session/storage', async (importOriginal) => {
  // Partial-module mock: override only saveSession; every other storage
  // export (loadSession, applyCompactionPersistence, …) stays real so
  // session/manager dependencies resolve their actual implementations.
  const actual = await importOriginal<typeof import('../../src/main/session/storage')>();
  return {
    ...actual,
    saveSession: mocks.saveSession,
  };
});

vi.mock('../../src/main/llm/middleware', () => ({
  createMiddlewareStack: mocks.createMiddlewareStack,
}));

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async (specifier: string) => {
    if (specifier === 'ai') {
      return {
        generateText: mocks.aiGenerateText,
        streamText: mocks.aiStreamText,
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

vi.mock('../../src/main/session/activity-live', () => ({
  publishSessionActivity: mocks.publishSessionActivity,
  completeSessionActivity: mocks.completeSessionActivity,
  // U5: the embedded local host's HostServer installs its own broadcast.
  setSessionActivityBroadcast: vi.fn(),
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

export function setupChatIpcTest() {
  // ensureActiveSession inspects the real fixture directory before the trust
  // gate (a deleted session folder must surface unbound_workspace), so the
  // fixture project path has to exist on disk.
  beforeAll(() => {
    fs.mkdirSync(mocks.workspace._testProjectDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(mocks.workspace._testProjectDir, { recursive: true, force: true });
  });

  return {
    mocks,
    successfulToolResult,
    cancelledToolResult,
    doneEvents,
    channelEvents,
    waitForDoneCount,
    waitForChannelCount,
    makeSession,
  };
}
