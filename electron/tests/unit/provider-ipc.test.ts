/** Provider IPC tests — intent-only, redacted, connection-scoped boundary. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type {
  ProviderConnection,
  ProviderDefinition,
} from '../../src/shared/types/provider';
import type { ProviderCatalogSnapshot } from '../../src/main/providers/catalog/store';
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
vi.mock('../../src/main/providers/runtime-context', () => ({
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
  allowsCustomModels: true,
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

function emptyCatalogSnapshot(): ProviderCatalogSnapshot {
  return {
    source: 'bundled',
    stale: false,
    catalog: {
      schemaVersion: 1,
      catalogVersion: 1,
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z',
      compatibleApp: { minimum: '0.1.0' },
      provenance: {
        source: 'models.dev',
        sourceUrl: 'https://example.com/catalog.json',
        capturedAt: '2026-01-01T00:00:00.000Z',
        contentHash: `sha256:${'0'.repeat(64)}`,
      },
      providers: [],
    },
  };
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
    remove: vi.fn(async (id: string) => {
      const current = records.get(id);
      if (!current) return null;
      records.delete(id);
      return structuredClone(current);
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
    list: vi.fn(() => []),
    refresh: vi.fn(),
    invalidate: vi.fn(),
  };
  return {
    services: {
      catalog: { getProviderDefinitions: () => definitions, load: () => emptyCatalogSnapshot() },
      connections,
      vault,
      status,
      registry: registry(),
      clearConfigReferences: vi.fn(async () => ({
        config: {
          default_model: null,
          tier_models: { seed: null, sprout: null, bloom: null, crown: null },
          rag: { embedding_api_model: null },
        },
        clearedConfigReferences: {
          defaultModel: false,
          tierModels: [],
          ragEmbeddingModel: false,
        },
      })) as never,
    },
    records,
    connections,
    vault,
    status,
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
  providersIpc._clearConnectionMutationLocksForTests();
});

afterEach(() => {
  providersIpc.unregisterProviderIPC();
  providersIpc._setProviderIPCServicesForTests(null);
  providersIpc._clearConnectionMutationLocksForTests();
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

  it('accepts a user-defined model for a named provider when the catalog is stale', async () => {
    const memory = memoryServices();
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'OpenAI with a new model',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      modelIds: ['gpt-next'],
      customModels: [{
        id: 'gpt-next',
        displayName: 'GPT Next',
        protocol: 'openai-compatible',
        capabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          tools: true,
          reasoning: true,
        },
        limits: { contextTokens: 128000, outputTokens: 16384 },
      }],
    });

    expect(result.connection).toMatchObject({
      providerId: 'openai',
      modelIds: ['gpt-next'],
      customModels: [{ id: 'gpt-next', source: 'connection' }],
    });
  });

  it('updates an existing named provider connection with a user-defined model', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000022';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Existing OpenAI',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      modelIds: ['gpt-next'],
      customModels: [{
        id: 'gpt-next',
        displayName: 'GPT Next',
        protocol: 'openai-compatible',
        capabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          tools: true,
          reasoning: true,
        },
        limits: { contextTokens: 128000, outputTokens: 16384 },
      }],
    });

    expect(result.connection).toMatchObject({
      id,
      modelIds: ['gpt-next'],
      customModels: [{ id: 'gpt-next', source: 'connection' }],
      health: 'ready',
    });
  });

  it('lists only the catalog models selected on the connection after model edits', async () => {
    const secondModel = {
      ...OPENAI.models[0],
      id: 'gpt-5/other',
      displayName: 'GPT 5 Other',
    };
    const memory = memoryServices([{ ...OPENAI, models: [...OPENAI.models, secondModel] }]);
    const id = '00000000-0000-4000-8000-000000000023';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Editable OpenAI',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const initial = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(initial.map((option: { model: { id: string } }) => option.model.id)).toEqual([
      'gpt-5/test',
    ]);

    await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      modelIds: ['gpt-5/other'],
    });
    const updated = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(updated.map((option: { model: { id: string } }) => option.model.id)).toEqual([
      'gpt-5/other',
    ]);
  });

  it('accepts a connection-local override for a preconfigured model', async () => {
    const fixedCatalogProvider = { ...OPENAI, allowsCustomModels: false };
    const memory = memoryServices([fixedCatalogProvider]);
    const id = '00000000-0000-4000-8000-000000000024';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Vision override',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      customModels: [{
        id: 'gpt-5/test',
        displayName: 'GPT 5 Vision override',
        protocol: 'openai-compatible',
        capabilities: {
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          tools: true,
          reasoning: false,
        },
        limits: { contextTokens: 32_000, outputTokens: 4_000 },
      }],
    });

    const options = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(options).toMatchObject([{
      model: {
        id: 'gpt-5/test',
        source: 'connection',
        displayName: 'GPT 5 Vision override',
        capabilities: { inputModalities: ['text', 'image'] },
      },
    }]);
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

  it('changes authentication method while keeping credential values redacted', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000025';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Authentication editor',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      authMethod: 'environment',
      environmentVariable: 'UPDATED_OPENAI_API_KEY',
    });

    expect(memory.vault.deleteConnectionCredentials).toHaveBeenCalledWith(id);
    expect(memory.records.get(id)).toMatchObject({
      authMethod: 'environment',
      credential: { kind: 'environment', variable: 'UPDATED_OPENAI_API_KEY' },
    });
    expect(result).toMatchObject({
      connection: {
        authMethod: 'environment',
        credentialKind: 'environment',
        environmentVariable: 'UPDATED_OPENAI_API_KEY',
      },
    });
    expect(JSON.stringify(result)).not.toContain('fixture-openai-key');
    expect(memory.status.invalidate).toHaveBeenCalledWith('openai', id);
  });

  it('invalidates connection-scoped status when replacing a ready stored API key', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000029';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Replacement key',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-old-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'replacement-api-key',
    });

    expect(memory.status.invalidate).toHaveBeenCalledWith('openai', id);
  });

  it('switches an environment connection to a newly stored API key', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000026';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Authentication transition',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      credential: { kind: 'environment', variable: 'OLD_OPENAI_API_KEY' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const unauthenticated = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      authMethod: 'api-key',
    });
    expect(unauthenticated).toMatchObject({
      connection: {
        authMethod: 'api-key',
        credentialKind: 'none',
        health: 'needs_attention',
      },
    });

    const authenticated = await handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'replacement-api-key',
    });
    expect(memory.vault.replaceConnectionApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: id, authMethod: 'api-key' }),
      'replacement-api-key',
    );
    expect(authenticated).toMatchObject({
      connection: { authMethod: 'api-key', credentialKind: 'stored', health: 'ready' },
    });
    expect(JSON.stringify(authenticated)).not.toContain('replacement-api-key');
  });

  it('requires an environment reference when changing to environment authentication', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000027';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Invalid authentication transition',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await expect(handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      authMethod: 'environment',
    })).rejects.toThrow('Invalid providers:update payload');
    expect(memory.vault.deleteConnectionCredentials).not.toHaveBeenCalled();
    expect(memory.records.get(id)).toMatchObject({
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
    });
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

  it('deletes a connection and clears credentials, status, and configuration references', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000053';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Delete me',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000054' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    const clearConfigReferences = vi.fn(async () => ({
      config: {
        default_model: null,
        tier_models: { seed: null, sprout: null, bloom: null, crown: null },
        rag: { embedding_api_model: null },
      },
      clearedConfigReferences: {
        defaultModel: true,
        tierModels: ['bloom'],
        ragEmbeddingModel: true,
      },
    })) as never;
    providersIpc._setProviderIPCServicesForTests({
      ...memory.services,
      clearConfigReferences,
    });
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_DELETE)(null, {
      connectionId: id,
      confirm: true,
    });

    expect(memory.vault.deleteConnectionCredentials).toHaveBeenCalledWith(id);
    expect(memory.status.invalidate).toHaveBeenCalledWith('openai', id);
    expect(clearConfigReferences).toHaveBeenCalledWith(id);
    expect(memory.connections.remove).toHaveBeenCalledWith(id);
    expect(memory.records.has(id)).toBe(false);
    expect(result).toMatchObject({
      connectionId: id,
      clearedConfigReferences: {
        defaultModel: true,
        tierModels: ['bloom'],
        ragEmbeddingModel: true,
      },
    });
  });

  it('requires explicit confirmation before deleting a connection', async () => {
    const memory = memoryServices();
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DELETE)(null, {
      connectionId: '00000000-0000-4000-8000-000000000055',
      confirm: false,
    })).rejects.toThrow(/invalid providers:delete payload/i);
    expect(memory.connections.remove).not.toHaveBeenCalled();
  });

  it('clears deleted connection references from default, tier, and RAG selections', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-delete-config-'));
    const configPath = path.join(root, 'config.json');
    const connectionId = '00000000-0000-4000-8000-000000000056';
    const siblingId = '00000000-0000-4000-8000-000000000057';
    fs.writeFileSync(configPath, JSON.stringify({
      default_model: { connectionId, modelId: 'default-model' },
      tier_models: {
        seed: { connectionId, modelId: 'seed-model' },
        bloom: { connectionId: siblingId, modelId: 'sibling-model' },
      },
      rag: {
        embedding_api_model: { connectionId, modelId: 'embedding-model' },
      },
    }));
    fs.writeFileSync(path.join(root, '.orchid.json'), JSON.stringify({
      theme: 'project-only-theme',
    }));

    try {
      const result = await providersIpc.clearConnectionConfigReferences(connectionId, {
        homeConfigPath: configPath,
        projectDir: root,
        refreshRuntime: false,
      });
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      expect(result.clearedConfigReferences).toEqual({
        defaultModel: true,
        tierModels: ['seed'],
        ragEmbeddingModel: true,
      });
      expect(persisted.default_model).toBeNull();
      expect(persisted.tier_models.seed).toBeNull();
      expect(persisted.tier_models.bloom).toEqual({
        connectionId: siblingId,
        modelId: 'sibling-model',
      });
      expect(persisted.rag.embedding_api_model).toBeNull();
      expect(persisted).not.toHaveProperty('theme');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('restores connection health when deletion accounting cannot be finalized', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000063';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Deletion accounting unavailable',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000064' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    mocks.stopActiveProviderConnectionTurns.mockReturnValue(['session-active']);
    mocks.interruptPendingForConnection.mockImplementation(() => {
      throw new Error('ledger unavailable');
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DELETE)(null, {
      connectionId: id,
      confirm: true,
    })).rejects.toThrow(/connection was not deleted.*ledger unavailable/i);

    expect(memory.connections.update).toHaveBeenNthCalledWith(1, id, { health: 'disabled' });
    expect(memory.connections.update).toHaveBeenNthCalledWith(2, id, { health: 'ready' });
    expect(memory.records.get(id)?.health).toBe('ready');
    expect(memory.vault.deleteConnectionCredentials).not.toHaveBeenCalled();
    expect(memory.connections.remove).not.toHaveBeenCalled();
  });

  it('serializes submit_api_key against concurrent disconnect so no live key remains', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000071';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Race fixture',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000072' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });

    let releaseVaultWrite: (() => void) | undefined;
    const vaultWriteGate = new Promise<void>((resolve) => {
      releaseVaultWrite = resolve;
    });
    let submitEnteredVault = false;
    memory.vault.replaceConnectionApiKey.mockImplementation(async () => {
      submitEnteredVault = true;
      await vaultWriteGate;
      return '00000000-0000-4000-8000-000000000099';
    });

    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const submitPromise = handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'sk-concurrent-submit',
    });
    await vi.waitFor(() => expect(submitEnteredVault).toBe(true));

    const disconnectPromise = handler(IPC_CHANNELS.PROVIDERS_DISCONNECT)(null, {
      connectionId: id,
      confirm: true,
    });

    // Disconnect must wait on the per-connection lock while submit holds it.
    await Promise.resolve();
    expect(memory.vault.deleteConnectionCredentials).not.toHaveBeenCalled();

    releaseVaultWrite!();
    const [submitResult, disconnectResult] = await Promise.all([submitPromise, disconnectPromise]);

    expect(submitResult).toMatchObject({
      connection: { health: 'ready', credentialKind: 'stored' },
    });
    expect(disconnectResult).toMatchObject({
      connection: { health: 'disconnected', credentialKind: 'none' },
    });
    expect(memory.records.get(id)).toMatchObject({
      health: 'disconnected',
      credential: { kind: 'none' },
    });
    expect(memory.vault.deleteConnectionCredentials).toHaveBeenCalledWith(id);
    // Final vault state after disconnect must not retain a post-disconnect key.
    const deleteOrder = memory.vault.deleteConnectionCredentials.mock.invocationCallOrder[0]!;
    const replaceOrder = memory.vault.replaceConnectionApiKey.mock.invocationCallOrder[0]!;
    expect(deleteOrder).toBeGreaterThan(replaceOrder);
  });

  it('does not re-enable a connection disabled while validate is in flight', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000081';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Validate race',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000082' },
      modelIds: ['gpt-5/test'],
      health: 'draft',
    });

    let releaseReadSecret: (() => void) | undefined;
    const readSecretGate = new Promise<void>((resolve) => {
      releaseReadSecret = resolve;
    });
    let validateEnteredReadiness = false;
    memory.vault.readSecret.mockImplementation(async () => {
      validateEnteredReadiness = true;
      await readSecretGate;
      return { kind: 'api-key' as const, apiKey: 'never-return-this' };
    });

    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const validatePromise = handler(IPC_CHANNELS.PROVIDERS_VALIDATE)(null, { connectionId: id });
    await vi.waitFor(() => expect(validateEnteredReadiness).toBe(true));

    // Without the connection mutation lock, disable would finish while validate
    // still holds the readiness snapshot and then validate would write ready.
    // With the lock, disable queues until validate completes its health write.
    const disablePromise = handler(IPC_CHANNELS.PROVIDERS_DISABLE)(null, { connectionId: id });
    await Promise.resolve();
    expect(memory.records.get(id)?.health).toBe('draft');

    releaseReadSecret!();
    const [validateResult, disableResult] = await Promise.all([validatePromise, disablePromise]);

    expect(validateResult).toMatchObject({
      connection: { health: 'ready' },
    });
    expect(disableResult).toMatchObject({
      connection: { health: 'disabled' },
    });
    expect(memory.records.get(id)?.health).toBe('disabled');
  });

  it('validate leaves an already-disabled connection disabled', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000083';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Already disabled',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '00000000-0000-4000-8000-000000000084' },
      modelIds: ['gpt-5/test'],
      health: 'disabled',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    const result = await handler(IPC_CHANNELS.PROVIDERS_VALIDATE)(null, { connectionId: id });

    expect(result).toMatchObject({
      connection: { health: 'disabled' },
      message: expect.stringMatching(/disabled/i),
    });
    expect(memory.connections.update).not.toHaveBeenCalled();
    expect(memory.vault.readSecret).not.toHaveBeenCalled();
  });

  it('rejects submit_api_key while the connection is disabled', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000085';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Disabled submit',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['gpt-5/test'],
      health: 'disabled',
    });
    providersIpc._setProviderIPCServicesForTests(memory.services);
    providersIpc.registerProviderIPC();

    await expect(handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'sk-should-not-store',
    })).rejects.toThrow(/disabled/i);

    expect(memory.vault.replaceConnectionApiKey).not.toHaveBeenCalled();
  });
});
