/** Provider IPC tests — intent-only, redacted, connection-scoped boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type {
  ProviderConnection,
  ProviderDefinition,
} from '../../src/shared/types/provider';
import { ProviderDriverRegistry } from '../../src/main/providers/drivers/registry';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
    interruptPendingForConnection: vi.fn(() => 0),
    activeSessionsForProviderConnection: vi.fn((): readonly string[] => []),
    stopActiveProviderConnectionTurns: vi.fn((): readonly string[] => []),
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain }));
vi.mock('../../src/main/index', () => ({
  getProviderCatalogStore: vi.fn(),
  getProviderConnectionStore: vi.fn(),
  getProviderCredentialVault: vi.fn(),
  getProviderStatusService: vi.fn(),
}));
vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => ({
    interruptPendingForConnection: mocks.interruptPendingForConnection,
  }),
}));
vi.mock('../../src/main/ipc/chat', () => ({
  activeSessionsForProviderConnection: mocks.activeSessionsForProviderConnection,
  stopActiveProviderConnectionTurns: mocks.stopActiveProviderConnectionTurns,
}));

let providersIpc: typeof import('../../src/main/ipc/providers');

const OPENAI: ProviderDefinition = {
  id: 'openai',
  displayName: 'OpenAI',
  supportedAuthMethods: ['api-key', 'environment'],
  supportedProtocols: ['openai-compatible'],
  allowsCustomModels: false,
  lifecycle: 'active',
  models: [{
    id: 'gpt-5/test',
    displayName: 'GPT 5 Test',
    protocol: 'openai-compatible',
    lifecycle: 'active',
    capabilities: {
      inputModalities: ['text'],
      outputModalities: ['text'],
      tools: true,
      reasoning: true,
    },
    limits: { contextTokens: 1000, outputTokens: 100 },
  }],
};

const GENERIC: ProviderDefinition = {
  id: 'generic-openai-compatible',
  displayName: 'Generic OpenAI-compatible',
  supportedAuthMethods: ['api-key', 'environment', 'none'],
  supportedProtocols: ['openai-compatible'],
  allowsCustomModels: true,
  lifecycle: 'active',
  models: [],
};

function registry(): ProviderDriverRegistry {
  return new ProviderDriverRegistry([
    {
      id: 'openai',
      supportedAuthMethods: ['api-key', 'environment'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.openai.com/v1',
      createLanguageModel: vi.fn(),
    },
    {
      id: 'generic-openai-compatible',
      supportedAuthMethods: ['api-key', 'environment', 'none'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: true,
      origin: null,
      createLanguageModel: vi.fn(),
    },
  ]);
}

function memoryServices(definitions: readonly ProviderDefinition[] = [OPENAI, GENERIC]) {
  const records = new Map<string, ProviderConnection>();
  let sequence = 1;
  const connections = {
    list: vi.fn(async () => [...records.values()].map((record) => structuredClone(record))),
    get: vi.fn(async (id: string) => records.get(id) ? structuredClone(records.get(id)!) : null),
    create: vi.fn(async (input: Omit<ProviderConnection, 'id'>) => {
      const id = `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
      const record = { ...structuredClone(input), id } as ProviderConnection;
      records.set(id, record);
      return structuredClone(record);
    }),
    update: vi.fn(async (id: string, patch: Partial<ProviderConnection>) => {
      const current = records.get(id);
      if (!current) throw new Error(`Unknown provider connection '${id}'`);
      const record = { ...current, ...structuredClone(patch), id } as ProviderConnection;
      records.set(id, record);
      return structuredClone(record);
    }),
  };
  const vault = {
    getAvailability: vi.fn(() => ({ available: true as const, backend: 'libsecret' })),
    replaceConnectionApiKey: vi.fn(async () => '00000000-0000-4000-8000-000000000099'),
    readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'never-return-this' })),
    deleteConnectionCredentials: vi.fn(async () => 1),
  };
  const status = {
    get: vi.fn(() => undefined),
    refresh: vi.fn(),
  };
  return {
    services: {
      catalog: { getProviderDefinitions: () => definitions },
      connections,
      vault,
      status,
      registry: registry(),
    },
    records,
    connections,
    vault,
  };
}

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.interruptPendingForConnection.mockClear();
  mocks.activeSessionsForProviderConnection.mockReset();
  mocks.activeSessionsForProviderConnection.mockReturnValue([]);
  mocks.stopActiveProviderConnectionTurns.mockReset();
  mocks.stopActiveProviderConnectionTurns.mockReturnValue([]);
  providersIpc = await import('../../src/main/ipc/providers');
  providersIpc._setProviderIPCServicesForTests(null);
});

afterEach(() => {
  providersIpc.unregisterProviderIPC();
  providersIpc._setProviderIPCServicesForTests(null);
});

describe('provider IPC', () => {
  it('lists redacted connections and never includes credential handles', async () => {
    const memory = memoryServices();
    memory.records.set('00000000-0000-4000-8000-000000000011', {
      id: '00000000-0000-4000-8000-000000000011',
      providerId: 'openai',
      name: 'Work',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000012' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_LIST)(null);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('00000000-0000-4000-8000-000000000012');
    expect(result).toMatchObject({
      connections: [{ name: 'Work', credentialKind: 'stored', environmentVariable: null }],
    });
    expect(result).toMatchObject({
      definitions: expect.arrayContaining([expect.objectContaining({ id: 'openai', available: true })]),
    });
  });

  it('rejects renderer credential handles, unsupported auth, and code-owned endpoint overrides', async () => {
    const memory = memoryServices();
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await expect(handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Bad handle',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      modelIds: ['gpt-5/test'],
      credential: { kind: 'stored', handle: 'renderer-forged' },
    })).rejects.toThrow('Invalid providers:create payload');

    await expect(handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Bad auth',
      protocol: 'openai-compatible',
      authMethod: 'none',
      modelIds: ['gpt-5/test'],
    })).rejects.toThrow('not supported');

    await expect(handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Redirected',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      endpoint: 'https://attacker.invalid/v1',
      modelIds: ['gpt-5/test'],
    })).rejects.toThrow('code-owned endpoint');
  });

  it('accepts one-shot API-key submission without returning key or handle', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000021';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Personal',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['gpt-5/test'],
      health: 'draft',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'sk-test-never-serialize',
    });

    expect(memory.vault.replaceConnectionApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: id, driverId: 'openai' }),
      'sk-test-never-serialize',
    );
    expect(JSON.stringify(result)).not.toContain('sk-test-never-serialize');
    expect(JSON.stringify(result)).not.toContain('00000000-0000-4000-8000-000000000099');
    expect(result).toMatchObject({ connection: { health: 'ready', credentialKind: 'stored' } });
  });

  it('invalidates a stored generic credential before a normalized-origin change', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000031';
    memory.records.set(id, {
      id,
      providerId: 'generic-openai-compatible',
      name: 'Fixture',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000032' },
      modelIds: ['fixture-model'],
      customModels: [{
        id: 'fixture-model',
        displayName: 'Fixture model',
        protocol: 'openai-compatible',
        capabilities: {
          inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false,
        },
        limits: { contextTokens: 4096, outputTokens: 1024 },
      }],
      endpoint: 'https://one.example/v1',
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      endpoint: 'https://two.example/v1',
    });

    expect(memory.vault.deleteConnectionCredentials).toHaveBeenCalledWith(id);
    expect(result).toMatchObject({
      connection: { credentialKind: 'none', health: 'needs_attention' },
    });
  });

  it('requires explicit environment-variable reconfirmation when a generic origin changes', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000033';
    memory.records.set(id, {
      id,
      providerId: 'generic-openai-compatible',
      name: 'Environment fixture',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      credential: { kind: 'environment', variable: 'FIXTURE_API_KEY' },
      modelIds: ['fixture-model'],
      customModels: [{
        id: 'fixture-model',
        displayName: 'Fixture model',
        protocol: 'openai-compatible',
        capabilities: {
          inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false,
        },
        limits: { contextTokens: 4096, outputTokens: 1024 },
      }],
      endpoint: 'https://one.example/v1',
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const invalidated = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      endpoint: 'https://two.example/v1',
    });

    expect(memory.vault.deleteConnectionCredentials).not.toHaveBeenCalled();
    expect(invalidated).toMatchObject({
      connection: { credentialKind: 'none', health: 'needs_attention' },
    });
  });

  it('disables only new work while reporting that a frozen turn can finish', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000041';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Active work',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000042' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    mocks.activeSessionsForProviderConnection.mockReturnValue(['session-active']);
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_DISABLE)(null, {
      connectionId: id,
    });

    expect(memory.connections.update).toHaveBeenCalledWith(id, { health: 'disabled' });
    expect(mocks.stopActiveProviderConnectionTurns).not.toHaveBeenCalled();
    expect(mocks.interruptPendingForConnection).not.toHaveBeenCalled();
    expect(memory.vault.deleteConnectionCredentials).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      connection: { health: 'disabled', activeTurnCount: 1 },
      message: expect.stringMatching(/active turn can finish/i),
    });
  });

  it('disconnects only after active turns and pending accounting are finalized', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000051';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Destructive disconnect',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000052' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    mocks.stopActiveProviderConnectionTurns.mockReturnValue(['session-active']);
    mocks.interruptPendingForConnection.mockReturnValue(1);
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_DISCONNECT)(null, {
      connectionId: id,
      confirm: true,
    });

    expect(mocks.stopActiveProviderConnectionTurns).toHaveBeenCalledWith(id);
    expect(mocks.interruptPendingForConnection).toHaveBeenCalledWith(id);
    expect(memory.vault.deleteConnectionCredentials).toHaveBeenCalledWith(id);
    expect(memory.connections.update).toHaveBeenCalledWith(id, {
      credential: { kind: 'none' },
      health: 'disconnected',
    });
    expect(result).toMatchObject({
      connection: { health: 'disconnected', credentialKind: 'none' },
      message: expect.stringMatching(/cancelled 1 active turn.*finalized.*removing stored credentials/i),
    });
  });

  it('keeps credentials when active-turn accounting cannot be finalized', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000061';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Accounting unavailable',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000062' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    mocks.stopActiveProviderConnectionTurns.mockReturnValue(['session-active']);
    mocks.interruptPendingForConnection.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCONNECT)(null, {
      connectionId: id,
      confirm: true,
    })).rejects.toThrow(/credentials were not removed.*ledger unavailable/i);

    expect(memory.vault.deleteConnectionCredentials).not.toHaveBeenCalled();
    expect(memory.connections.update).not.toHaveBeenCalledWith(id, expect.objectContaining({
      health: 'disconnected',
    }));
  });
});
