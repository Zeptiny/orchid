import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { getConfig } from '../../src/main/config/loader';

const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONNECTION_UUID = '11111111-2222-4333-8444-555555555555';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  type SessionShape = {
    id: string;
    name: string;
    selection: { connectionId: string; modelId: string } | null;
    modelLabel: string | null;
    cwd: string | null;
    chains: unknown[];
    activeChainId: string | null;
    createdAt: string;
    updatedAt: string;
    subagentChains: unknown[];
    todoStore: { tasks: unknown[] };
    reasoningEffortOverride: string | number | null;
  };

  let activeSession: SessionShape | null = null;

  const sessionManager = {
    getActive: vi.fn(() => activeSession),
    setReasoningEffortOverride: vi.fn((id: string, effort: string | number | null) => {
      if (!activeSession || activeSession.id !== id) return;
      activeSession = { ...activeSession, reasoningEffortOverride: effort };
    }),
    _setActive: (session: SessionShape | null) => {
      activeSession = session;
    },
    _reset: () => {
      activeSession = null;
      sessionManager.getActive.mockClear();
      sessionManager.setReasoningEffortOverride.mockClear();
    },
  };

  const connectionStore = {
    list: vi.fn(() => [] as unknown[]),
  };

  const catalogStore = {
    getProviderDefinitions: vi.fn(() => [] as unknown[]),
  };

  return {
    handlers,
    sessionManager,
    connectionStore,
    catalogStore,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('../../src/main/config/loader', () => ({
  getConfig: vi.fn(() => ({ default_project_dir: null })),
  atomicWriteJson: vi.fn(),
  HOME_CONFIG_PATH: '/tmp/orchid-test-config.json',
  HOME_CONFIG_DIR: '/tmp',
  ConfigManager: { load: vi.fn(), save: vi.fn(), reset: vi.fn() },
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: vi.fn(() => ({
    get: vi.fn(() => ({ config: { default_model: null } })),
  })),
  clearProjectRuntimeRegistry: vi.fn(),
}));

vi.mock('../../src/main/ipc/chat-history', () => ({
  clearChatHistory: vi.fn(),
  seedChatHistory: vi.fn(),
}));

vi.mock('../../src/main/providers/runtime-context', () => ({
  getProviderConnectionStore: vi.fn(() => mocks.connectionStore),
  getProviderCatalogStore: vi.fn(() => mocks.catalogStore),
}));

vi.mock('../../src/main/providers/resolver', () => ({
  resolveModelSelection: vi.fn((selection, connections, definitions) => {
    if (!selection) return { kind: 'selection-required', reason: 'no-selection' };
    const connection = (connections as Array<{ id: string }>).find(
      (c) => c.id === selection.connectionId,
    );
    if (!connection) return { kind: 'unavailable', selection, reason: 'unknown-connection' };
    const provider = (definitions as Array<{ id: string; models: unknown[] }>).find(
      (d) => d.id === (connection as { providerId: string }).providerId,
    );
    if (!provider) return { kind: 'unavailable', selection, reason: 'unknown-provider' };
    const model = (provider.models as Array<{ id: string }>).find(
      (m) => m.id === selection.modelId,
    );
    if (!model) return { kind: 'unavailable', selection, reason: 'missing-model' };
    return { kind: 'resolved', selection, connection, provider, model };
  }),
}));

let sessionIpc: typeof import('../../src/main/ipc/session');

function makeSession(overrides: Partial<{
  selection: { connectionId: string; modelId: string } | null;
  reasoningEffortOverride: string | number | null;
}> = {}) {
  return {
    id: SESSION_UUID,
    name: 'Test Session',
    selection: overrides.selection ?? null,
    modelLabel: overrides.selection?.modelId ?? null,
    cwd: '/tmp/project',
    chains: [],
    activeChainId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subagentChains: [],
    todoStore: { tasks: [] },
    reasoningEffortOverride: overrides.reasoningEffortOverride ?? null,
    permissionMode: null as string | null,
  };
}

function sender(id = 1) {
  return { id, send: vi.fn(), isDestroyed: () => false };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
  mocks.connectionStore.list.mockReturnValue([]);
  mocks.catalogStore.getProviderDefinitions.mockReturnValue([]);
  vi.mocked(getConfig).mockReturnValue({ default_project_dir: null } as never);

  sessionIpc = await import('../../src/main/ipc/session');
  const mgr = sessionIpc.getSessionManager();
  Object.assign(mgr, {
    getActive: mocks.sessionManager.getActive,
    setReasoningEffortOverride: mocks.sessionManager.setReasoningEffortOverride,
  });

  sessionIpc.unregisterSessionIPC();
  sessionIpc.registerSessionIPC();
});

afterEach(() => {
  sessionIpc.unregisterSessionIPC();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
});

describe('session:set_reasoning_effort', () => {
  it('sets override on active session', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender() }, { effort: 'high' });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setReasoningEffortOverride).toHaveBeenCalledWith(SESSION_UUID, 'high');
  });

  it('clears override with null', async () => {
    mocks.sessionManager._setActive(makeSession({ reasoningEffortOverride: 'high' }));
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);

    const result = await handler!({ sender: sender() }, { effort: null });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setReasoningEffortOverride).toHaveBeenCalledWith(SESSION_UUID, null);
  });

  it('accepts numeric effort', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);

    const result = await handler!({ sender: sender() }, { effort: 8192 });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setReasoningEffortOverride).toHaveBeenCalledWith(SESSION_UUID, 8192);
  });

  it('stores a draft override when no session is active', async () => {
    mocks.sessionManager._setActive(null);
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);

    const result = await handler!({ sender: sender() }, { effort: 'high' });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.sessionManager.setReasoningEffortOverride).not.toHaveBeenCalled();
  });

  it('rejects invalid payload', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);

    await expect(handler!({ sender: sender() }, { effort: true })).rejects.toThrow(
      /Invalid session:set_reasoning_effort payload/,
    );
  });

  it('rejects missing effort field', async () => {
    mocks.sessionManager._setActive(makeSession());
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);

    await expect(handler!({ sender: sender() }, {})).rejects.toThrow(
      /Invalid session:set_reasoning_effort payload/,
    );
  });
});

describe('session:get_reasoning_config', () => {
  it('returns levels, default, override, and supportsReasoning for reasoning model', async () => {
    mocks.sessionManager._setActive(
      makeSession({
        selection: { connectionId: CONNECTION_UUID, modelId: 'o3' },
        reasoningEffortOverride: 'high',
      }),
    );

    mocks.connectionStore.list.mockReturnValue([
      {
        id: CONNECTION_UUID,
        providerId: 'openai',
        name: 'OpenAI',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        credential: { kind: 'stored', handle: 'h' },
        modelIds: ['o3'],
        health: 'ready',
        reasoningConfig: {
          o3: { levels: ['low', 'medium', 'high'], default: 'medium' },
        },
      },
    ]);
    mocks.catalogStore.getProviderDefinitions.mockReturnValue([
      {
        id: 'openai',
        displayName: 'OpenAI',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: false,
        models: [
          {
            id: 'o3',
            displayName: 'o3',
            protocol: 'openai-compatible',
            capabilities: {
              inputModalities: ['text'],
              outputModalities: ['text'],
              tools: true,
              reasoning: true,
            },
          },
        ],
      },
    ]);

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      levels: ['low', 'medium', 'high'],
      default: 'medium',
      override: 'high',
      supportsReasoning: true,
    });
  });

  it('returns supportsReasoning false for non-reasoning model', async () => {
    mocks.sessionManager._setActive(
      makeSession({
        selection: { connectionId: CONNECTION_UUID, modelId: 'gpt-4o' },
      }),
    );

    mocks.connectionStore.list.mockReturnValue([
      {
        id: CONNECTION_UUID,
        providerId: 'openai',
        name: 'OpenAI',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        credential: { kind: 'stored', handle: 'h' },
        modelIds: ['gpt-4o'],
        health: 'ready',
      },
    ]);
    mocks.catalogStore.getProviderDefinitions.mockReturnValue([
      {
        id: 'openai',
        displayName: 'OpenAI',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: false,
        models: [
          {
            id: 'gpt-4o',
            displayName: 'GPT-4o',
            protocol: 'openai-compatible',
            capabilities: {
              inputModalities: ['text'],
              outputModalities: ['text'],
              tools: true,
              reasoning: false,
            },
          },
        ],
      },
    ]);

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      levels: [],
      default: null,
      override: null,
      supportsReasoning: false,
    });
  });

  it('returns empty config when no active session', async () => {
    mocks.sessionManager._setActive(null);
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      levels: [],
      default: null,
      override: null,
      supportsReasoning: false,
    });
  });

  it('returns empty config when session has no model selection', async () => {
    mocks.sessionManager._setActive(makeSession({ selection: null }));
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      levels: [],
      default: null,
      override: null,
      supportsReasoning: false,
    });
  });

  it('returns empty levels when model has no reasoningConfig entry', async () => {
    mocks.sessionManager._setActive(
      makeSession({
        selection: { connectionId: CONNECTION_UUID, modelId: 'o3' },
      }),
    );

    mocks.connectionStore.list.mockReturnValue([
      {
        id: CONNECTION_UUID,
        providerId: 'openai',
        name: 'OpenAI',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        credential: { kind: 'stored', handle: 'h' },
        modelIds: ['o3'],
        health: 'ready',
      },
    ]);
    mocks.catalogStore.getProviderDefinitions.mockReturnValue([
      {
        id: 'openai',
        displayName: 'OpenAI',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: false,
        models: [
          {
            id: 'o3',
            displayName: 'o3',
            protocol: 'openai-compatible',
            capabilities: {
              inputModalities: ['text'],
              outputModalities: ['text'],
              tools: true,
              reasoning: true,
            },
          },
        ],
      },
    ]);

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      levels: [],
      default: null,
      override: null,
      supportsReasoning: true,
    });
  });

  function mockReasoningProvider(): void {
    mocks.connectionStore.list.mockReturnValue([
      {
        id: CONNECTION_UUID,
        providerId: 'openai',
        name: 'OpenAI',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        credential: { kind: 'stored', handle: 'h' },
        modelIds: ['o3'],
        health: 'ready',
        reasoningConfig: {
          o3: { levels: ['low', 'medium', 'high'], default: 'medium' },
        },
      },
    ]);
    mocks.catalogStore.getProviderDefinitions.mockReturnValue([
      {
        id: 'openai',
        displayName: 'OpenAI',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: false,
        models: [
          {
            id: 'o3',
            displayName: 'o3',
            protocol: 'openai-compatible',
            capabilities: {
              inputModalities: ['text'],
              outputModalities: ['text'],
              tools: true,
              reasoning: true,
            },
          },
        ],
      },
    ]);
  }

  function setDefaultModel(): void {
    vi.mocked(getConfig).mockReturnValue({
      default_project_dir: null,
      default_model: { connectionId: CONNECTION_UUID, modelId: 'o3' },
    } as never);
  }

  it('resolves reasoning config from the default model in draft mode', async () => {
    mocks.sessionManager._setActive(null);
    setDefaultModel();
    mockReasoningProvider();

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      levels: ['low', 'medium', 'high'],
      default: 'medium',
      override: null,
      supportsReasoning: true,
    });
  });

  it('surfaces a draft override set before any session exists', async () => {
    mocks.sessionManager._setActive(null);
    setDefaultModel();
    mockReasoningProvider();

    const setHandler = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);
    await setHandler!({ sender: sender() }, { effort: 'high' });

    const getHandler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);
    const result = await getHandler!({ sender: sender() });
    expect(result).toEqual({
      levels: ['low', 'medium', 'high'],
      default: 'medium',
      override: 'high',
      supportsReasoning: true,
    });
  });
});
