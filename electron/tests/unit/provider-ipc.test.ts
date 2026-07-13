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
});
