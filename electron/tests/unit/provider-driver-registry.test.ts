import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderDefinition } from '../../src/shared/types/provider';
import type { ProviderCatalogSnapshot } from '../../src/main/providers/catalog/store';
import type { ProviderStatusObservation } from '../../src/main/providers/status/cache';

const connection: ProviderConnection = {
  id: '44444444-4444-4444-8444-444444444444',
  providerId: 'openai',
  name: 'Work',
  protocol: 'openai-compatible',
  authMethod: 'api-key',
  credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
  modelIds: [],
  health: 'ready',
};

const provider: ProviderDefinition = {
  id: 'openai',
  displayName: 'OpenAI',
  supportedAuthMethods: ['api-key'],
  supportedProtocols: ['openai-compatible'],
  allowsCustomModels: false,
  models: [{ id: 'gpt-test', displayName: 'GPT Test', protocol: 'openai-compatible' }],
};

describe('ProviderDriverRegistry', () => {
  it('rejects unsupported auth/protocol pairs before credential retrieval or adapter construction', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const createLanguageModel = vi.fn();
    const registry = new ProviderDriverRegistry([{
      id: 'openai',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.openai.com/v1',
      createLanguageModel,
    }]);

    await expect(registry.createLanguageModel({
      connection: { ...connection, authMethod: 'oauth' },
      provider,
      model: { ...provider.models[0], source: 'catalog' },
      credential: { kind: 'oauth', accessToken: 'not-used' },
    })).rejects.toThrow(/auth/i);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('rejects unknown remote drivers, remote endpoint overrides, and protocol mismatches without fallback', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const registry = new ProviderDriverRegistry([]);

    await expect(registry.createLanguageModel({
      connection,
      provider,
      model: { ...provider.models[0], source: 'catalog' },
      credential: { kind: 'api-key', apiKey: 'not-used' },
    })).rejects.toThrow(/trusted driver/i);
  });

  it('resolves a connection-scoped selection through its vault-bound trusted driver', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const model = { kind: 'trusted-model' };
    const createLanguageModel = vi.fn(async () => model);
    const registry = new ProviderDriverRegistry([{
      id: 'openai',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.openai.com/v1',
      createLanguageModel,
    }]);
    const vault = {
      readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'vault-key' })),
    };
    const runtime = new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [provider] },
      connections: { list: async () => [connection] },
      vault,
      registry,
    });

    await expect(runtime.resolveLanguageModel({ connectionId: connection.id, modelId: 'gpt-test' }))
      .resolves.toBe(model);
    expect(vault.readSecret).toHaveBeenCalledWith(connection.credential.handle, expect.objectContaining({
      connectionId: connection.id,
      driverId: 'openai',
      origin: 'https://api.openai.com',
    }));
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({
      credential: { kind: 'api-key', apiKey: 'vault-key' },
    }));
  });

  it('freezes Lilac’s authoritative live discount multiplier into one request price', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const lilacConnection: ProviderConnection = {
      ...connection,
      providerId: 'lilac',
      name: 'Lilac subscription',
    };
    const lilacProvider: ProviderDefinition = {
      id: 'lilac',
      displayName: 'Lilac',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: false,
      models: [{ id: 'moonshotai/kimi-k2.6', displayName: 'Kimi K2.6', protocol: 'openai-compatible' }],
    };
    const pricingCatalog = {
      source: 'bundled',
      stale: false,
      catalog: {
        catalogVersion: 1,
        issuedAt: '2026-07-12T12:00:00.000Z',
        providers: [{
          id: 'lilac',
          provenance: { source: 'catalog', observedAt: '2026-07-12T12:00:00.000Z' },
          models: [{
            id: 'moonshotai/kimi-k2.6',
            provenance: { source: 'catalog', observedAt: '2026-07-12T12:00:00.000Z' },
            pricing: {
              currency: 'USD',
              effectiveAt: '2026-07-12T12:00:00.000Z',
              rates: {
                input: { amount: '0.7', per: 1_000_000, unit: 'tokens' },
                output: { amount: '3.5', per: 1_000_000, unit: 'tokens' },
              },
              provenance: { source: 'catalog', observedAt: '2026-07-12T12:00:00.000Z' },
            },
          }],
        }],
      },
    } as unknown as ProviderCatalogSnapshot;
    let status: ProviderStatusObservation = {
      providerId: 'lilac',
      observedAt: '2026-07-12T12:01:00.000Z',
      providerUpdatedAt: '2026-07-12T12:01:00.000Z',
      availability: 'available',
      stale: false,
      error: null,
      data: {
        subscriptionSupplyUpdatedAt: '2026-07-12T12:01:00.000Z',
        models: [{
          modelId: 'moonshotai/kimi-k2.6',
          subscription: {
            availability: 'available',
            discountPercent: 75,
            creditMultiplier: 0.25,
          },
        }],
      },
    };
    const registry = new ProviderDriverRegistry([{
      id: 'lilac',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.getlilac.com/v1',
      createLanguageModel: vi.fn(async () => ({ kind: 'lilac-model' })),
    }]);
    const runtime = new ProviderRuntime({
      catalog: {
        getProviderDefinitions: () => [lilacProvider],
        load: () => pricingCatalog,
      },
      connections: { list: async () => [lilacConnection] },
      vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'vault-key' })) },
      status: { get: () => status },
      registry,
    });

    const first = await runtime.resolveExecution({
      connectionId: lilacConnection.id,
      modelId: 'moonshotai/kimi-k2.6',
    });
    expect(first.snapshot.pricing).toMatchObject({
      effectiveAt: '2026-07-12T12:01:00.000Z',
      rates: {
        input: { amount: '0.175' },
        output: { amount: '0.875' },
      },
      provenance: {
        source: 'lilac-public-status',
        discountPercent: 75,
        creditMultiplier: '0.25',
      },
    });

    // A later status observation changes only a future request snapshot.
    status = {
      ...status,
      observedAt: '2026-07-12T12:06:00.000Z',
      providerUpdatedAt: '2026-07-12T12:06:00.000Z',
      data: {
        subscriptionSupplyUpdatedAt: '2026-07-12T12:06:00.000Z',
        models: [{
          modelId: 'moonshotai/kimi-k2.6',
          subscription: {
            availability: 'available',
            discountPercent: 50,
            creditMultiplier: 0.5,
          },
        }],
      },
    };
    const second = await runtime.resolveExecution({
      connectionId: lilacConnection.id,
      modelId: 'moonshotai/kimi-k2.6',
    });
    expect(first.snapshot.pricing?.rates.input?.amount).toBe('0.175');
    expect(second.snapshot.pricing?.rates.input?.amount).toBe('0.35');

    // Stale or incomplete supply data is informational: it cannot block the
    // model and cannot invent a price, so the signed catalog rate remains.
    status = { ...status, stale: true };
    const third = await runtime.resolveExecution({
      connectionId: lilacConnection.id,
      modelId: 'moonshotai/kimi-k2.6',
    });
    expect(third.snapshot.pricing).toMatchObject({
      rates: { input: { amount: '0.7' } },
      provenance: { source: 'signed-catalog' },
    });
  });

  it('resolves API embeddings through the same typed selection and trusted endpoint gate', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const createEmbeddingTarget = vi.fn(async () => ({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'vault-key',
    }));
    const registry = new ProviderDriverRegistry([{
      id: 'openai',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.openai.com/v1',
      createLanguageModel: vi.fn(),
      createEmbeddingTarget,
    }]);
    const runtime = new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [provider] },
      connections: { list: async () => [connection] },
      vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'vault-key' })) },
      registry,
    });

    await expect(runtime.resolveApiEmbeddingTarget({
      connectionId: connection.id,
      modelId: 'gpt-test',
    })).resolves.toEqual({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'vault-key',
    });
    expect(createEmbeddingTarget).toHaveBeenCalledWith(expect.objectContaining({
      connection,
      model: expect.objectContaining({ id: 'gpt-test' }),
    }));
  });

  it('fails before adapter construction when a generic endpoint change invalidates its stored credential binding', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const genericProvider: ProviderDefinition = {
      id: 'generic-openai-compatible',
      displayName: 'Generic OpenAI-compatible',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomModels: true,
      models: [],
    };
    const genericConnection: ProviderConnection = {
      ...connection,
      providerId: genericProvider.id,
      protocol: 'openai-compatible',
      modelIds: ['vendor/path/model'],
      endpoint: 'https://new-endpoint.example.test/v1',
    };
    const createLanguageModel = vi.fn();
    const registry = new ProviderDriverRegistry([{
      id: genericProvider.id,
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: true,
      origin: null,
      createLanguageModel,
    }]);
    const vault = {
      readSecret: vi.fn(async (_handle: string, binding: { origin: string | null }) => {
        expect(binding.origin).toBe('https://new-endpoint.example.test');
        throw new Error('Credential handle binding does not match this connection or destination');
      }),
    };
    const runtime = new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [genericProvider] },
      connections: { list: async () => [genericConnection] },
      vault,
      registry,
    });

    await expect(runtime.resolveLanguageModel({
      connectionId: genericConnection.id,
      modelId: 'vendor/path/model',
    })).rejects.toThrow(/binding/i);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('routes an uncatalogued Anthropic-compatible model with explicit user metadata', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const genericProvider: ProviderDefinition = {
      id: 'generic-anthropic-compatible',
      displayName: 'Generic Anthropic-compatible',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['anthropic-messages'],
      allowsCustomModels: true,
      models: [],
    };
    const genericConnection: ProviderConnection = {
      ...connection,
      providerId: genericProvider.id,
      protocol: 'anthropic-messages',
      modelIds: ['vendor/claude-compatible'],
      endpoint: 'https://anthropic-gateway.example.test/v1',
      customModels: [{
        id: 'vendor/claude-compatible',
        displayName: 'Vendor Claude-compatible',
        protocol: 'anthropic-messages',
        capabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          tools: true,
          reasoning: false,
        },
        limits: { contextTokens: 32000, outputTokens: 4096 },
      }],
    };
    const model = { kind: 'anthropic-compatible' };
    const createLanguageModel = vi.fn(async () => model);
    const registry = new ProviderDriverRegistry([{
      id: genericProvider.id,
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['anthropic-messages'],
      allowsCustomEndpoint: true,
      origin: null,
      createLanguageModel,
    }]);
    const runtime = new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [genericProvider] },
      connections: { list: async () => [genericConnection] },
      vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'vault-key' })) },
      registry,
    });

    await expect(runtime.resolveLanguageModel({
      connectionId: genericConnection.id,
      modelId: 'vendor/claude-compatible',
    })).resolves.toBe(model);
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://anthropic-gateway.example.test/v1',
      model: expect.objectContaining({
        source: 'connection',
        capabilities: expect.objectContaining({ tools: true }),
        limits: { contextTokens: 32000, outputTokens: 4096 },
      }),
    }));
  });
});
