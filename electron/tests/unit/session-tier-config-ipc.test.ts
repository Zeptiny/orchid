/**
 * Session service tier config IPC — variant tiers are filtered to those
 * actually present for the active model, and requiresStreaming preconditions
 * are surfaced (R20, R23).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { getConfig } from '../../src/main/config/loader';
import type { TierMechanism } from '../../src/shared/types/provider-facets';

const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONNECTION_UUID = '11111111-2222-4333-8444-555555555555';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  type SessionShape = {
    id: string;
    name: string;
    selection: { connectionId: string; modelId: string } | null;
    tierOverride: string | null;
    cwd: string | null;
    chains: unknown[];
    activeChainId: string | null;
    createdAt: string;
    updatedAt: string;
    subagentChains: unknown[];
    todoStore: { tasks: unknown[] };
  };

  let activeSession: SessionShape | null = null;

  const sessionManager = {
    getActive: vi.fn(() => activeSession),
    _setActive: (session: SessionShape | null) => {
      activeSession = session;
    },
    _reset: () => {
      activeSession = null;
      sessionManager.getActive.mockClear();
    },
  };

  const connectionStore = {
    list: vi.fn(() => [] as unknown[]),
  };

  const catalogStore = {
    getProviderDefinitions: vi.fn(() => [] as unknown[]),
  };

  const driverRegistry = {
    get: vi.fn((_id: string): { tierMechanism?: TierMechanism } | undefined => undefined),
  };

  return {
    handlers,
    sessionManager,
    connectionStore,
    catalogStore,
    driverRegistry,
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

vi.mock('../../src/main/host/chat/history', () => ({
  clearChatHistory: vi.fn(),
  seedChatHistory: vi.fn(),
}));

vi.mock('../../src/main/providers/runtime-context', () => ({
  getProviderConnectionStore: vi.fn(() => mocks.connectionStore),
  getProviderCatalogStore: vi.fn(() => mocks.catalogStore),
  getProviderDriverRegistry: vi.fn(() => mocks.driverRegistry),
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

const parameterMechanism: TierMechanism = {
  kind: 'request-parameter',
  parameter: 'serviceTier',
  tiers: [
    { id: 'auto', displayName: 'Auto' },
    { id: 'flex', displayName: 'Flex' },
  ],
};

const variantMechanism: TierMechanism = {
  kind: 'model-name-variants',
  tiers: [
    { id: 'fast', displayName: 'Fast', modelIdSuffix: '-fast' },
    { id: 'flex', displayName: 'Flex', modelIdSuffix: '-flex', requiresStreaming: true },
    { id: 'short', displayName: 'Short', modelIdSuffix: '-short' },
  ],
};

let sessionIpc: typeof import('../../src/main/ipc/session');

function makeSession(overrides: Partial<{
  selection: { connectionId: string; modelId: string } | null;
  tierOverride: string | null;
}> = {}) {
  return {
    id: SESSION_UUID,
    name: 'Test Session',
    selection: overrides.selection ?? null,
    tierOverride: overrides.tierOverride ?? null,
    cwd: '/tmp/project',
    chains: [],
    activeChainId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subagentChains: [],
    todoStore: { tasks: [] },
    permissionMode: null as string | null,
  };
}

function sender(id = 1) {
  return { id, send: vi.fn(), isDestroyed: () => false };
}

function model(id: string, reasoning = true) {
  return {
    id,
    displayName: id,
    protocol: 'openai-compatible',
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoning,
    },
  };
}

function mockOpenAIConnection(overrides: Record<string, unknown> = {}) {
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
      ...overrides,
    },
  ]);
  mocks.catalogStore.getProviderDefinitions.mockReturnValue([
    {
      id: 'openai',
      displayName: 'OpenAI',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: false,
      models: [model('o3')],
    },
  ]);
}

function mockNeuralwattConnection(modelIds: string[], overrides: Record<string, unknown> = {}) {
  mocks.connectionStore.list.mockReturnValue([
    {
      id: CONNECTION_UUID,
      providerId: 'neuralwatt',
      name: 'Neuralwatt',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'h' },
      modelIds,
      health: 'ready',
      ...overrides,
    },
  ]);
  mocks.catalogStore.getProviderDefinitions.mockReturnValue([
    {
      id: 'neuralwatt',
      displayName: 'Neuralwatt',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: false,
      models: modelIds.map((id) => model(id)),
    },
  ]);
}

function emptyResult(override: string | null): Record<string, unknown> {
  return {
    mechanism: null,
    tiers: [],
    selected: null,
    override,
    effective: null,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
  mocks.connectionStore.list.mockReturnValue([]);
  mocks.catalogStore.getProviderDefinitions.mockReturnValue([]);
  mocks.driverRegistry.get.mockReturnValue(undefined);
  vi.mocked(getConfig).mockReturnValue({ default_project_dir: null } as never);

  sessionIpc = await import('../../src/main/ipc/session');
  const mgr = sessionIpc.getSessionManager();
  Object.assign(mgr, {
    getActive: mocks.sessionManager.getActive,
  });

  sessionIpc.unregisterSessionIPC();
  sessionIpc.registerSessionIPC();
});

afterEach(() => {
  sessionIpc.unregisterSessionIPC();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
});

describe('session:get_service_tier_config', () => {
  it('lists every declared tier for a request-parameter mechanism', async () => {
    mocks.sessionManager._setActive(
      makeSession({ selection: { connectionId: CONNECTION_UUID, modelId: 'o3' } }),
    );
    mockOpenAIConnection();
    mocks.driverRegistry.get.mockReturnValue({ tierMechanism: parameterMechanism });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    expect(handler).toBeDefined();

    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: 'request-parameter',
      tiers: [
        { id: 'auto', displayName: 'Auto', description: null },
        { id: 'flex', displayName: 'Flex', description: null },
      ],
      selected: null,
      override: null,
      effective: null,
    });
  });

  it('filters variant tiers to those actually present for the active model', async () => {
    mocks.sessionManager._setActive(
      makeSession({ selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' } }),
    );
    mockNeuralwattConnection(['glm-5.2', 'glm-5.2-flex', 'glm-5.2-short']);
    mocks.driverRegistry.get.mockReturnValue({ tierMechanism: variantMechanism });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: 'model-name-variants',
      tiers: [
        { id: 'flex', displayName: 'Flex', description: null, requiresStreaming: true },
        { id: 'short', displayName: 'Short', description: null },
      ],
      selected: null,
      override: null,
      effective: null,
    });
  });

  it('excludes absent variant tiers and keeps the streaming precondition flag', async () => {
    mocks.sessionManager._setActive(
      makeSession({ selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' } }),
    );
    mockNeuralwattConnection(['glm-5.2', 'glm-5.2-fast']);
    mocks.driverRegistry.get.mockReturnValue({ tierMechanism: variantMechanism });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual({
      mechanism: 'model-name-variants',
      tiers: [{ id: 'fast', displayName: 'Fast', description: null }],
      selected: null,
      override: null,
      effective: null,
    });
  });

  it('offers no tiers when no variant of the active model is present', async () => {
    mocks.sessionManager._setActive(
      makeSession({ selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' } }),
    );
    mockNeuralwattConnection(['glm-5.2']);
    mocks.driverRegistry.get.mockReturnValue({ tierMechanism: variantMechanism });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual(emptyResult(null));
  });

  it('returns empty when the driver declares no tier mechanism', async () => {
    mocks.sessionManager._setActive(
      makeSession({ selection: { connectionId: CONNECTION_UUID, modelId: 'o3' } }),
    );
    mockOpenAIConnection();
    mocks.driverRegistry.get.mockReturnValue(undefined);

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual(emptyResult(null));
  });

  it('returns empty when the session has no model selection', async () => {
    mocks.sessionManager._setActive(makeSession({ selection: null }));
    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toEqual(emptyResult(null));
  });

  it('surfaces the session override as the effective tier', async () => {
    mocks.sessionManager._setActive(
      makeSession({
        selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' },
        tierOverride: 'flex',
      }),
    );
    mockNeuralwattConnection(['glm-5.2', 'glm-5.2-flex', 'glm-5.2-short']);
    mocks.driverRegistry.get.mockReturnValue({ tierMechanism: variantMechanism });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toMatchObject({
      override: 'flex',
      effective: 'flex',
      mechanism: 'model-name-variants',
    });
  });

  it('falls back to the connection per-model selection', async () => {
    mocks.sessionManager._setActive(
      makeSession({ selection: { connectionId: CONNECTION_UUID, modelId: 'glm-5.2' } }),
    );
    mockNeuralwattConnection(['glm-5.2', 'glm-5.2-flex'], {
      tierSelections: { 'glm-5.2': 'flex' },
    });
    mocks.driverRegistry.get.mockReturnValue({ tierMechanism: variantMechanism });

    const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
    const result = await handler!({ sender: sender() });
    expect(result).toMatchObject({
      selected: 'flex',
      override: null,
      effective: 'flex',
    });
  });
});
