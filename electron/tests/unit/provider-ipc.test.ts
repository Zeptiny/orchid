/** Provider IPC tests — intent-only, redacted, connection-scoped boundary. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { HOST_ERROR_CODES, HostProtocolError } from '../../src/shared/host/protocol';
import {
  clearActiveMachine,
  registerHostClient,
  setActiveMachine,
  unregisterHostClient,
} from '../../src/main/host/routing';
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
// The provider view/mutation core (providers/views.ts) sources the active-turn
// helpers from the relocated host pipeline instead of the IPC facade.
vi.mock('../../src/main/host/chat/abort', () => ({
  activeSessionsForProviderConnection: mocks.activeSessionsForProviderConnection,
  stopActiveProviderConnectionTurns: mocks.stopActiveProviderConnectionTurns,
}));

let providersIpc: typeof import('../../src/main/ipc/providers');
let providerModelsIpc: typeof import('../../src/main/ipc/provider-models');
let providerViews: typeof import('../../src/main/providers/views');

function registerProviderIpc(): void {
  providersIpc.registerProviderIPC();
  providerModelsIpc.registerProviderModelsIPC();
}

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
    persistDiscoveredModels: vi.fn(async (
      id: string,
      discoveredModels: readonly unknown[],
      reasoningConfig?: Record<string, unknown>,
    ) => {
      const current = records.get(id);
      if (!current) throw new Error(`Unknown provider connection '${id}'`);
      const record = {
        ...current,
        discoveredModels: structuredClone([...discoveredModels]),
        ...(reasoningConfig ? { reasoningConfig: structuredClone(reasoningConfig) } : {}),
      } as ProviderConnection;
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
    list: vi.fn(() => []),
    refresh: vi.fn(),
    invalidate: vi.fn(),
  };
  const pricing = { invalidate: vi.fn() };
  return {
    services: {
      catalog: { getProviderDefinitions: () => definitions, load: () => emptyCatalogSnapshot() },
      connections,
      vault,
      status,
      pricing,
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
    pricing,
  };
}

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  // U5: host-routed handlers resolve the caller from event.sender.id; this
  // suite invokes handlers directly, so substitute a stable sender when the
  // call does not provide one.
  return (event: unknown, ...rest: unknown[]) => {
    const sender = event != null && typeof event === 'object' && 'sender' in event
      ? event
      : { sender: { id: 1 } };
    return registered(sender, ...rest);
  };
}

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.interruptPendingForConnection.mockClear();
  mocks.activeSessionsForProviderConnection.mockReset();
  mocks.activeSessionsForProviderConnection.mockReturnValue([]);
  mocks.stopActiveProviderConnectionTurns.mockReset();
  mocks.stopActiveProviderConnectionTurns.mockReturnValue([]);
  providersIpc = await import('../../src/main/ipc/providers');
  providerModelsIpc = await import('../../src/main/ipc/provider-models');
  providerViews = await import('../../src/main/providers/views');
  providerViews._setProviderIPCServicesForTests(null);
  providerViews._clearConnectionMutationLocksForTests();
});

afterEach(() => {
  providersIpc.unregisterProviderIPC();
  providerModelsIpc.unregisterProviderModelsIPC();
  providerViews._setProviderIPCServicesForTests(null);
  providerViews._clearConnectionMutationLocksForTests();
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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
      customModels: [{ id: 'gpt-next', source: 'user' }],
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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
      customModels: [{ id: 'gpt-next', source: 'user' }],
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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
        source: 'catalog',
        displayName: 'GPT 5 Vision override',
        capabilities: { inputModalities: ['text', 'image'] },
      },
      customized: true,
      enabled: true,
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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests({
      ...memory.services,
      clearConfigReferences,
    });
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
      const result = await providerViews.clearConnectionConfigReferences(connectionId, {
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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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

    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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

    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'sk-should-not-store',
    })).rejects.toThrow(/disabled/i);

    expect(memory.vault.replaceConnectionApiKey).not.toHaveBeenCalled();
  });
});

describe('provider live model discovery IPC', () => {
  const NEURALWATT: ProviderDefinition = {
    id: 'neuralwatt',
    displayName: 'Neuralwatt',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: true,
    lifecycle: 'active',
    models: [{
      id: 'nw-base',
      displayName: 'NW Base',
      protocol: 'openai-compatible',
      lifecycle: 'active',
      capabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        tools: true,
        reasoning: false,
      },
      limits: { contextTokens: 1000, outputTokens: 100 },
    }],
  };

  function discoveryServices(fetchModels: unknown) {
    const memory = memoryServices([NEURALWATT]);
    const registryWithDiscovery = new ProviderDriverRegistry([{
      id: 'neuralwatt',
      supportedAuthMethods: ['api-key', 'environment'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.neuralwatt.com/v1',
      createLanguageModel: vi.fn(),
      discoveryFacet: { fetchModels: fetchModels as never },
    }]);
    return { ...memory, services: { ...memory.services, registry: registryWithDiscovery } };
  }

  it('discovers models once when a connection is created with a working credential', async () => {
    const fetchModels = vi.fn(async () => [
      { id: 'nw-base', displayName: 'NW Base Live', limits: { contextTokens: 2000, outputTokens: null } },
      {
        id: 'nw-new',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: true },
        limits: { contextTokens: 5000, outputTokens: 500 },
        reasoningLevels: ['low', 'high'],
        reasoningDefault: 'low',
      },
    ]);
    const memory = discoveryServices(fetchModels);
    process.env.ORCHID_TEST_NEURALWATT_KEY = 'nw-env-key';
    try {
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      const result = await handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
        providerId: 'neuralwatt',
        name: 'NW',
        protocol: 'openai-compatible',
        authMethod: 'environment',
        environmentVariable: 'ORCHID_TEST_NEURALWATT_KEY',
        modelIds: ['nw-base'],
      });

      expect(fetchModels).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        connection: { health: 'ready' },
        message: expect.stringMatching(/discovered 1 new model/i),
      });
      const record = memory.records.get(result.connection.id);
      expect(record?.discoveredModels).toHaveLength(2);
      expect(record?.discoveredModels?.[1]).toMatchObject({
        id: 'nw-new',
        provenance: 'provider',
        limits: { contextTokens: 5000, outputTokens: 500 },
      });
      expect(record?.discoveredModels?.every(
        (model: { discoveredAt?: string }) => typeof model.discoveredAt === 'string',
      )).toBe(true);
      // Live reasoning levels seed the connection fill-absent (R28 affordance parity).
      expect(record?.reasoningConfig?.['nw-new']).toEqual({ levels: ['low', 'high'], default: 'low' });
    } finally {
      delete process.env.ORCHID_TEST_NEURALWATT_KEY;
    }
  });

  it('discovers on the first working API key submission and never polls afterwards', async () => {
    const fetchModels = vi.fn(async () => [{ id: 'nw-new' }]);
    const memory = discoveryServices(fetchModels);
    const id = '00000000-0000-4000-8000-000000000091';
    memory.records.set(id, {
      id,
      providerId: 'neuralwatt',
      name: 'NW keys',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['nw-base'],
      health: 'draft',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const first = await handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'nw-first-key',
    });
    expect(first).toMatchObject({
      connection: { health: 'ready' },
      message: expect.stringMatching(/discovered 1 new model/i),
    });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(memory.records.get(id)?.discoveredModels).toEqual([
      expect.objectContaining({ id: 'nw-new', provenance: 'provider' }),
    ]);

    // A later credential rotation does not rediscover: discovery is one-shot
    // per connection plus explicit manual fetches (R26, no background polling).
    const second = await handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'nw-rotated-key',
    });
    expect(second).toMatchObject({ connection: { health: 'ready' }, message: null });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(memory.pricing.invalidate).toHaveBeenCalledWith('neuralwatt', id);
  });

  it('merges live metadata over catalog and preserves user overrides over live', async () => {
    const fetchModels = vi.fn(async () => [
      { id: 'nw-base', limits: { contextTokens: 2000, outputTokens: null } },
      { id: 'nw-live-only', displayName: 'NW Live Only' },
    ]);
    const memory = discoveryServices(fetchModels);
    const id = '00000000-0000-4000-8000-000000000092';
    memory.records.set(id, {
      id,
      providerId: 'neuralwatt',
      name: 'NW precedence',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-nw-key' },
      modelIds: ['nw-base'],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, { connectionId: id });

    const unified = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, {
      connectionId: id,
      includeDisabled: true,
    });
    const byId = new Map(unified.map((option: { model: { id: string } }) => [option.model.id, option]));
    expect(byId.get('nw-base')).toMatchObject({
      enabled: true,
      customized: false,
      model: {
        source: 'provider',
        limits: { contextTokens: 2000, outputTokens: 100 },
      },
    });
    expect(byId.get('nw-live-only')).toMatchObject({
      enabled: false,
      model: { source: 'provider', displayName: 'NW Live Only' },
    });
    // The picker path keeps its enabled-only cardinality.
    const pickerOptions = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(pickerOptions.map((option: { model: { id: string } }) => option.model.id)).toEqual(['nw-base']);

    // A user-set override wins over the live value (fill-absent philosophy).
    await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      customModels: [{
        id: 'nw-base',
        displayName: 'NW Base tuned',
        protocol: 'openai-compatible',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
        limits: { contextTokens: 32_000, outputTokens: 4_000 },
      }],
    });
    const overridden = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, {
      connectionId: id,
      includeDisabled: true,
    });
    expect(overridden.find((option: { model: { id: string } }) => option.model.id === 'nw-base'))
      .toMatchObject({
        customized: true,
        model: {
          displayName: 'NW Base tuned',
          limits: { contextTokens: 32_000, outputTokens: 4_000 },
        },
      });
  });

  it('adds ids-only discoveries without degrading catalog metadata and lists uniform rows', async () => {
    const fetchModels = vi.fn(async () => [{ id: 'nw-base' }, { id: 'nw-id-only' }]);
    const memory = discoveryServices(fetchModels);
    const id = '00000000-0000-4000-8000-000000000093';
    memory.records.set(id, {
      id,
      providerId: 'neuralwatt',
      name: 'NW ids only',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-nw-key' },
      modelIds: ['nw-base'],
      customModels: [{
        id: 'nw-custom',
        displayName: 'NW Custom',
        protocol: 'openai-compatible',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
        limits: { contextTokens: 4096, outputTokens: 512 },
      }],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const discovered = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, { connectionId: id });
    expect(discovered).toMatchObject({ status: 'ok', addedModelIds: ['nw-id-only'] });

    const unified = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, {
      connectionId: id,
      includeDisabled: true,
    });
    const byId = new Map(unified.map((option: { model: { id: string } }) => [option.model.id, option]));
    // Ids-only data contributes nothing beyond the id (R27).
    expect(byId.get('nw-base')).toMatchObject({
      model: { source: 'catalog', limits: { contextTokens: 1000, outputTokens: 100 } },
    });
    expect(byId.get('nw-id-only')).toMatchObject({
      enabled: false,
      model: { source: 'provider', capabilities: null, limits: null },
    });
    expect(byId.get('nw-custom')).toMatchObject({
      enabled: false,
      model: { source: 'user' },
    });
    // Uniform affordances: every row carries the same affordance fields.
    for (const option of unified) {
      expect(option).toMatchObject({
        enabled: expect.any(Boolean),
        customized: expect.any(Boolean),
        available: expect.any(Boolean),
      });
      expect(option).toHaveProperty('discoveredAt');
    }

    // Enabling a discovered model passes the static gate and resolves live.
    await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      modelIds: ['nw-base', 'nw-id-only'],
    });
    const enabled = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(enabled.map((option: { model: { id: string } }) => option.model.id).sort())
      .toEqual(['nw-base', 'nw-id-only']);
    expect(enabled.find((option: { model: { id: string } }) => option.model.id === 'nw-id-only'))
      .toMatchObject({ available: true, model: { source: 'provider' } });
  });

  it('reports unsupported and missing-credential discovery without failing the connection', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000094';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'No discovery driver',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const unsupported = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, { connectionId: id });
    expect(unsupported).toMatchObject({
      status: 'unsupported',
      message: expect.stringMatching(/does not publish/i),
    });

    const withDiscovery = discoveryServices(vi.fn());
    const missingId = '00000000-0000-4000-8000-000000000095';
    withDiscovery.records.set(missingId, {
      id: missingId,
      providerId: 'neuralwatt',
      name: 'No credential yet',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['nw-base'],
      health: 'draft',
    });
    providerViews._setProviderIPCServicesForTests(withDiscovery.services);

    const noCredential = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, { connectionId: missingId });
    expect(noCredential).toMatchObject({
      status: 'no-credential',
      message: expect.stringMatching(/credential/i),
    });
  });

  it('keeps catalog and custom models intact with a redacted note when discovery fails', async () => {
    const fetchModels = vi.fn(async () => {
      throw new Error('HTTP 401 for authorization: Bearer sk-nw-live-secret');
    });
    const memory = discoveryServices(fetchModels);
    const id = '00000000-0000-4000-8000-000000000096';
    memory.records.set(id, {
      id,
      providerId: 'neuralwatt',
      name: 'Failing discovery',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-nw-key' },
      modelIds: ['nw-base'],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, { connectionId: id });
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/discovery failed/i);
    expect(JSON.stringify(result)).not.toContain('sk-nw-live-secret');
    expect(memory.records.get(id)?.discoveredModels).toBeUndefined();

    const options = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(options).toMatchObject([{
      model: { id: 'nw-base', source: 'catalog', limits: { contextTokens: 1000 } },
      available: true,
    }]);
  });

  it('prunes an enabled model that a manual refresh delists', async () => {
    const fetchModels = vi.fn(async () => [{ id: 'nw-base' }]);
    const memory = discoveryServices(fetchModels);
    const id = '00000000-0000-4000-8000-000000000098';
    memory.records.set(id, {
      id,
      providerId: 'neuralwatt',
      name: 'NW delist',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-nw-key' },
      modelIds: ['nw-base', 'nw-gone'],
      tierSelections: { 'nw-base': 'lite', 'nw-gone': 'pro' },
      reasoningConfig: { 'nw-gone': { levels: ['low'], default: 'low' } },
      discoveredModels: [{
        id: 'nw-gone',
        provenance: 'provider',
        discoveredAt: '2026-08-01T00:00:00.000Z',
      }],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, { connectionId: id });
    expect(result).toMatchObject({ status: 'ok' });

    const record = memory.records.get(id);
    expect(record?.discoveredModels?.map((model: { id: string }) => model.id)).toEqual(['nw-base']);
    // The delisted id is dropped from the enabled list and its selections are
    // pruned with the fresh snapshot instead of orphaning every later update.
    expect(record?.modelIds).toEqual(['nw-base']);
    expect(record?.tierSelections).toEqual({ 'nw-base': 'lite' });
    expect(record?.reasoningConfig).toEqual({});
  });

  it('reports an orphaned enabled modelId instead of failing validate and name-only updates', async () => {
    const memory = discoveryServices(vi.fn());
    const id = '00000000-0000-4000-8000-000000000099';
    memory.records.set(id, {
      id,
      providerId: 'neuralwatt',
      name: 'NW orphan',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-nw-key' },
      modelIds: ['nw-base', 'nw-orphan'],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const validated = await handler(IPC_CHANNELS.PROVIDERS_VALIDATE)(null, { connectionId: id });
    expect(validated).toMatchObject({ connection: { health: 'ready' } });
    expect(validated.message).toMatch(/'nw-orphan'/);
    expect(validated.message).toMatch(/no longer available/i);

    const renamed = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      name: 'NW orphan renamed',
    });
    expect(renamed).toMatchObject({
      connection: { name: 'NW orphan renamed', health: 'ready' },
    });
    expect(renamed.message).toMatch(/'nw-orphan'/);
    // The orphan is reported, never silently clobbered by a name-only update.
    expect(memory.records.get(id)?.modelIds).toEqual(['nw-base', 'nw-orphan']);
  });

  it('invalidates latest-known pricing when a connection is deleted', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000097';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Pricing invalidation',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await handler(IPC_CHANNELS.PROVIDERS_DELETE)(null, { connectionId: id, confirm: true });

    expect(memory.status.invalidate).toHaveBeenCalledWith('openai', id);
    expect(memory.pricing.invalidate).toHaveBeenCalledWith('openai', id);
  });

  describe('draft discovery before the connection exists (#138)', () => {
    function genericDraftServices(fetchModels: unknown) {
      const memory = memoryServices([GENERIC]);
      const registryWithGenericDiscovery = new ProviderDriverRegistry([{
        id: 'generic-openai-compatible',
        supportedAuthMethods: ['api-key', 'environment', 'none'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomEndpoint: true,
        origin: null,
        createLanguageModel: vi.fn(),
        discoveryFacet: { fetchModels: fetchModels as never },
      }]);
      return { ...memory, services: { ...memory.services, registry: registryWithGenericDiscovery } };
    }

    it('fetches provider rows for a draft connection without persisting anything', async () => {
      const fetchModels = vi.fn(async () => [
        { id: 'nw-base', displayName: 'NW Base Live' },
        { id: 'nw-draft-new', displayName: 'NW Draft New' },
      ]);
      const memory = discoveryServices(fetchModels);
      process.env.ORCHID_TEST_NEURALWATT_KEY = 'nw-env-key';
      try {
        providerViews._setProviderIPCServicesForTests(memory.services);
        registerProviderIpc();

        const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
          providerId: 'neuralwatt',
          protocol: 'openai-compatible',
          authMethod: 'environment',
          environmentVariable: 'ORCHID_TEST_NEURALWATT_KEY',
        });

        expect(result.status).toBe('ok');
        expect(result.models).toEqual([
          expect.objectContaining({
            id: 'nw-base',
            displayName: 'NW Base Live',
            protocol: 'openai-compatible',
            source: 'provider',
          }),
          expect.objectContaining({ id: 'nw-draft-new', source: 'provider' }),
        ]);
        expect(typeof result.discoveredAt).toBe('string');
        expect(result.message).toMatch(/fetched 2 models/i);
        expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining({
          credential: { kind: 'api-key', apiKey: 'nw-env-key' },
        }));
        // A draft fetch never creates or mutates stored connections.
        expect(memory.records.size).toBe(0);
        expect(memory.connections.create).not.toHaveBeenCalled();
        expect(memory.connections.update).not.toHaveBeenCalled();
      } finally {
        delete process.env.ORCHID_TEST_NEURALWATT_KEY;
      }
    });

    it('uses the one-shot payload api key for the fetch only', async () => {
      const fetchModels = vi.fn(async () => [{ id: 'nw-draft' }]);
      const memory = discoveryServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'neuralwatt',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        apiKey: 'nw-draft-key',
      });

      expect(result.status).toBe('ok');
      expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining({
        credential: { kind: 'api-key', apiKey: 'nw-draft-key' },
      }));
      expect(JSON.stringify(result)).not.toContain('nw-draft-key');
    });

    it('reports no-credential drafts without calling the driver', async () => {
      const fetchModels = vi.fn();
      const memory = discoveryServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'neuralwatt',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
      });

      expect(result).toMatchObject({ status: 'no-credential', models: [] });
      expect(result.message).toMatch(/working credential/i);
      expect(fetchModels).not.toHaveBeenCalled();
    });

    it('keeps the failure redacted and non-blocking when the endpoint fails', async () => {
      const fetchModels = vi.fn(async () => {
        throw new Error('boom with key sk-nw-secret');
      });
      const memory = discoveryServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'neuralwatt',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        apiKey: 'nw-draft-key',
      });

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/discovery failed/i);
      expect(JSON.stringify(result)).not.toContain('sk-nw-secret');
    });

    it('applies the create-time static gate to drafts', async () => {
      const fetchModels = vi.fn();
      const memory = discoveryServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'neuralwatt',
        protocol: 'anthropic-messages',
        authMethod: 'api-key',
        apiKey: 'nw-draft-key',
      })).rejects.toThrow(/not supported/i);

      await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'unknown-provider',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
      })).rejects.toThrow(/unknown provider/i);

      expect(fetchModels).not.toHaveBeenCalled();
    });

    it('validates generic endpoints and passes them to the driver fetch', async () => {
      const fetchModels = vi.fn(async () => [{ id: 'generic-live' }]);
      const memory = genericDraftServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'generic-openai-compatible',
        protocol: 'openai-compatible',
        authMethod: 'none',
      })).rejects.toThrow(/requires a custom endpoint/i);
      expect(fetchModels).not.toHaveBeenCalled();

      const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'generic-openai-compatible',
        protocol: 'openai-compatible',
        authMethod: 'none',
        endpoint: 'https://api.example.com/v1',
      });

      expect(result.status).toBe('ok');
      expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: 'https://api.example.com/v1',
      }));
    });

    it('persists discovery for none-auth connections so draft previews converge after create', async () => {
      const fetchModels = vi.fn(async () => [{ id: 'generic-live' }]);
      const memory = genericDraftServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      const draft = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'generic-openai-compatible',
        protocol: 'openai-compatible',
        authMethod: 'none',
        endpoint: 'https://api.example.com/v1',
      });
      expect(draft.status).toBe('ok');

      const created = await handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
        providerId: 'generic-openai-compatible',
        name: 'Local endpoint',
        protocol: 'openai-compatible',
        authMethod: 'none',
        endpoint: 'https://api.example.com/v1',
        modelIds: ['generic-live'],
      });

      // The persisted path fetches for none-auth too, so the id selected from
      // the draft preview is backed instead of orphaned after creation.
      expect(fetchModels).toHaveBeenCalledTimes(2);
      const record = memory.records.get(created.connection.id);
      expect(record?.discoveredModels).toEqual([
        expect.objectContaining({ id: 'generic-live', provenance: 'provider' }),
      ]);
    });

    it('reports no-credential when an environment variable is declared but unset', async () => {
      const fetchModels = vi.fn();
      const memory = discoveryServices(fetchModels);
      providerViews._setProviderIPCServicesForTests(memory.services);
      registerProviderIpc();

      const result = await handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
        providerId: 'neuralwatt',
        protocol: 'openai-compatible',
        authMethod: 'environment',
        environmentVariable: 'ORCHID_TEST_NEURALWATT_UNSET',
      });

      expect(result).toMatchObject({ status: 'no-credential', models: [] });
      expect(fetchModels).not.toHaveBeenCalled();
    });
  });
});

describe('provider per-model pricing override IPC', () => {
  const OVERRIDE = {
    input: { amount: '1.25', per: 1_000_000, unit: 'tokens' as const },
    output: { amount: '5.00', per: 1_000_000, unit: 'tokens' as const },
    cacheRead: { amount: '0.25', per: 1_000_000, unit: 'tokens' as const },
    perRequest: { amount: '0.02', per: 1, unit: 'requests' as const },
  };

  it('creates a connection with per-model pricing overrides and returns them on the view', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const result = await handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Priced',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      modelIds: ['gpt-5/test'],
      pricingOverrides: { 'gpt-5/test': OVERRIDE },
    });

    expect(memory.records.get(result.connection.id)).toMatchObject({
      pricingOverrides: { 'gpt-5/test': OVERRIDE },
    });
    expect(result.connection.pricingOverrides).toEqual({ 'gpt-5/test': OVERRIDE });
  });

  it('updates per-model pricing overrides and carries them on the unified model rows', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000111';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Pricing editor',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const result = await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      pricingOverrides: { 'gpt-5/test': OVERRIDE },
    });
    expect(memory.records.get(id)).toMatchObject({
      pricingOverrides: { 'gpt-5/test': OVERRIDE },
    });
    expect(result.connection.pricingOverrides).toEqual({ 'gpt-5/test': OVERRIDE });

    const options = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(options).toMatchObject([{
      model: { id: 'gpt-5/test' },
      pricingOverrides: OVERRIDE,
    }]);

    await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      pricingOverrides: {},
    });
    const cleared = await handler(IPC_CHANNELS.PROVIDERS_MODEL_LIST)(null, { connectionId: id });
    expect(cleared[0]).not.toHaveProperty('pricingOverrides');
  });

  it('rejects malformed per-model pricing overrides on create and update', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Bad pricing',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      modelIds: ['gpt-5/test'],
      pricingOverrides: {
        'gpt-5/test': { input: { amount: 'not-a-number', per: 1_000_000, unit: 'tokens' } },
      },
    })).rejects.toThrow('Invalid providers:create payload');

    const id = '00000000-0000-4000-8000-000000000112';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Pricing editor',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: 'fixture-openai-key' },
      modelIds: ['gpt-5/test'],
      health: 'ready',
    });
    await expect(handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: id,
      pricingOverrides: { 'gpt-5/test': { output: { amount: '5', per: 0, unit: 'tokens' } } },
    })).rejects.toThrow('Invalid providers:update payload');
    expect(memory.records.get(id)?.pricingOverrides).toBeUndefined();
  });
});

describe('provider channel zod rejection', () => {
  it('rejects providers:discover_models with a non-uuid connection id', async () => {
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, {
      connectionId: 'not-a-uuid',
    })).rejects.toThrow('Invalid providers:discover_models payload');
  });

  it('rejects providers:discover_models with a missing payload', async () => {
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, undefined))
      .rejects.toThrow('Invalid providers:discover_models payload');
    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS)(null, {}))
      .rejects.toThrow('Invalid providers:discover_models payload');
  });

  it('rejects providers:quota_refresh with a non-uuid connection id', async () => {
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH)(null, {
      connectionId: 'not-a-uuid',
    })).rejects.toThrow('Invalid providers:quota_refresh payload');
  });

  it('rejects providers:quota_refresh with a missing payload', async () => {
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH)(null, undefined))
      .rejects.toThrow('Invalid providers:quota_refresh payload');
    await expect(handler(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH)(null, {}))
      .rejects.toThrow('Invalid providers:quota_refresh payload');
  });

  it('rejects providers:discover_draft_models with an invalid payload', async () => {
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, undefined))
      .rejects.toThrow('Invalid providers:discover_draft_models payload');
    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {}))
      .rejects.toThrow('Invalid providers:discover_draft_models payload');
    // Environment auth without a variable never reaches driver code.
    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(null, {
      providerId: 'openai',
      protocol: 'openai-compatible',
      authMethod: 'environment',
    })).rejects.toThrow('Invalid providers:discover_draft_models payload');
  });

  it('rejects providers:create environment-auth pairings at the shared boundary', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    // Environment auth without a variable never reaches the host.
    await expect(handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Env without variable',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      modelIds: ['gpt-5/test'],
    })).rejects.toThrow('Invalid providers:create payload');
    // An environment variable rides only environment auth.
    await expect(handler(IPC_CHANNELS.PROVIDERS_CREATE)(null, {
      providerId: 'openai',
      name: 'Variable on api-key auth',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      modelIds: ['gpt-5/test'],
      environmentVariable: 'OPENAI_API_KEY',
    })).rejects.toThrow('Invalid providers:create payload');
    expect(memory.connections.create).not.toHaveBeenCalled();
  });

  it('rejects providers:update environment-auth pairings and empty patches', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: '00000000-0000-4000-8000-000000000121',
      authMethod: 'api-key',
      environmentVariable: 'OPENAI_API_KEY',
    })).rejects.toThrow('Invalid providers:update payload');
    await expect(handler(IPC_CHANNELS.PROVIDERS_UPDATE)(null, {
      connectionId: '00000000-0000-4000-8000-000000000121',
    })).rejects.toThrow('Invalid providers:update payload');
    expect(memory.connections.update).not.toHaveBeenCalled();
  });

  it('fails closed when the vault is unavailable at submit time despite the local capability', async () => {
    const memory = memoryServices();
    memory.vault.getAvailability = vi.fn(() => ({ available: false, reason: 'basic_text' as const, backend: null }));
    memory.vault.replaceConnectionApiKey = vi.fn(async () => {
      throw new Error('Secure credential storage is unavailable because Electron selected Linux basic_text storage.');
    });
    const id = '00000000-0000-4000-8000-000000000122';
    memory.records.set(id, {
      id,
      providerId: 'openai',
      name: 'Draft on keyring-less host',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['gpt-5/test'],
      health: 'draft',
    });
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(null, {
      connectionId: id,
      apiKey: 'sk-vault-unavailable',
    })).rejects.toThrow(/unavailable/i);
    // Fail closed: the connection never claims a stored credential.
    expect(memory.records.get(id)?.credential).toEqual({ kind: 'none' });
    expect(memory.records.get(id)?.health).toBe('draft');
  });
});

describe('provider connection intents on a remote-active window (#5)', () => {
  const REMOTE_WINDOW = { sender: { id: 1 } };
  const REMOTE_MACHINE = 'build-1';
  let remoteRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActiveMachine('1', REMOTE_MACHINE);
    remoteRequest = vi.fn(async () => ({ connection: { id: 'remote-connection' }, message: null }));
    registerHostClient(REMOTE_MACHINE, { request: remoteRequest } as never);
  });

  afterEach(() => {
    clearActiveMachine('1');
    unregisterHostClient(REMOTE_MACHINE);
  });

  it('forwards providers:create to the driven machine and never touches the local store', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    const result = await handler(IPC_CHANNELS.PROVIDERS_CREATE)(REMOTE_WINDOW, {
      providerId: 'openai',
      name: 'Remote account',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      modelIds: ['gpt-5/test'],
      environmentVariable: 'OPENAI_API_KEY',
    });

    expect(result).toEqual({ connection: { id: 'remote-connection' }, message: null });
    expect(remoteRequest).toHaveBeenCalledWith('providers.create', {
      providerId: 'openai',
      name: 'Remote account',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      modelIds: ['gpt-5/test'],
      environmentVariable: 'OPENAI_API_KEY',
    });
    expect(memory.connections.create).not.toHaveBeenCalled();
    expect(memory.records.size).toBe(0);
    expect(memory.vault.replaceConnectionApiKey).not.toHaveBeenCalled();
  });

  it('forwards providers:update to the driven machine and leaves local connections untouched', async () => {
    const memory = memoryServices();
    const id = '00000000-0000-4000-8000-000000000031';
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
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await handler(IPC_CHANNELS.PROVIDERS_UPDATE)(REMOTE_WINDOW, {
      connectionId: id,
      name: 'Renamed on the remote machine',
    });

    expect(remoteRequest).toHaveBeenCalledWith('providers.update', {
      connectionId: id,
      name: 'Renamed on the remote machine',
    });
    expect(memory.connections.update).not.toHaveBeenCalled();
    expect(memory.records.get(id)?.name).toBe('Existing OpenAI');
  });

  it('forwards providers:submit_api_key to the driven machine instead of the local vault', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await handler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY)(REMOTE_WINDOW, {
      connectionId: '00000000-0000-4000-8000-000000000032',
      apiKey: 'sk-routes-to-the-driven-machine',
    });

    expect(remoteRequest).toHaveBeenCalledWith('providers.submit_api_key', {
      connectionId: '00000000-0000-4000-8000-000000000032',
      apiKey: 'sk-routes-to-the-driven-machine',
    });
    expect(memory.vault.replaceConnectionApiKey).not.toHaveBeenCalled();
    expect(memory.connections.update).not.toHaveBeenCalled();
  });

  it('rejects providers:discover_draft_models with the typed error before any local driver work', async () => {
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    await expect(handler(IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS)(REMOTE_WINDOW, {
      providerId: 'openai',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      apiKey: 'sk-draft-discovery-on-remote',
    })).rejects.toMatchObject({
      code: HOST_ERROR_CODES.UNSUPPORTED_ON_HOST,
    });
    expect(memory.connections.create).not.toHaveBeenCalled();
    expect(memory.connections.update).not.toHaveBeenCalled();
  });

  it('resumes local vault writes once the window is switched back to the local machine', async () => {
    clearActiveMachine('1');
    const memory = memoryServices();
    providerViews._setProviderIPCServicesForTests(memory.services);
    registerProviderIpc();

    // Same shape as the local-window create tests: an api-key connection
    // lands in the local store (draft health; validation is memory-backed).
    const result = await handler(IPC_CHANNELS.PROVIDERS_CREATE)(REMOTE_WINDOW, {
      providerId: 'openai',
      name: 'Local again',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      modelIds: ['gpt-5/test'],
    });
    expect(result.connection).toMatchObject({ name: 'Local again' });
    expect(memory.connections.create).toHaveBeenCalledTimes(1);
  });
});
