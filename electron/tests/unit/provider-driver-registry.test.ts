import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderDefinition } from '../../src/shared/types/provider';
import type { ProviderCatalogSnapshot } from '../../src/main/providers/catalog/store';
import { catalogToProviderDefinitions } from '../../src/main/providers/catalog/schema';
import { createCatalogFixture } from '../fixtures/provider-catalog/catalog-fixture';

const connection: ProviderConnection = {
  id: '44444444-4444-4444-8444-444444444444',
  providerId: 'openai',
  name: 'Work',
  protocol: 'openai-compatible',
  authMethod: 'api-key',
  credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
  modelIds: ['gpt-test'],
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
  it('uses one catalog snapshot across selection resolution and frozen accounting', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const firstCatalog = createCatalogFixture(1);
    const secondCatalog = createCatalogFixture(2);
    secondCatalog.providers[0].models[0].displayName = 'Changed after credential wait';
    secondCatalog.providers[0].models[0].pricing.rates.input.amount = '99';
    const firstSnapshot = {
      source: 'bundled' as const,
      stale: false,
      catalog: firstCatalog,
    };
    const secondSnapshot = {
      source: 'cache' as const,
      stale: false,
      catalog: secondCatalog,
    };
    let currentSnapshot = firstSnapshot as ProviderCatalogSnapshot;
    let releaseCredential!: () => void;
    const credentialWait = new Promise<void>((resolve) => { releaseCredential = resolve; });
    const load = vi.fn(() => currentSnapshot);
    const runtime = new ProviderRuntime({
      catalog: {
        getProviderDefinitions: () => catalogToProviderDefinitions(firstCatalog),
        load,
      },
      connections: { list: async () => [{ ...connection, modelIds: ['gpt-test/1'] }] },
      vault: {
        readSecret: vi.fn(async () => {
          await credentialWait;
          return { kind: 'api-key' as const, apiKey: 'vault-key' };
        }),
      },
      registry: new ProviderDriverRegistry([{
        id: 'openai',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomEndpoint: false,
        origin: 'https://api.openai.com/v1',
        createLanguageModel: vi.fn(async () => ({ kind: 'model' })),
      }]),
    });

    const resolution = runtime.resolveExecution({
      connectionId: connection.id,
      modelId: 'gpt-test/1',
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    currentSnapshot = secondSnapshot as ProviderCatalogSnapshot;
    releaseCredential();

    await expect(resolution).resolves.toMatchObject({
      snapshot: {
        catalogVersion: 1,
        catalogSource: 'bundled',
        pricing: { rates: { input: { amount: '1.250000' } } },
      },
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

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
      connection: { ...connection, authMethod: 'environment' },
      provider,
      model: { ...provider.models[0], source: 'catalog' },
      credential: { kind: 'api-key', apiKey: 'not-used' },
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

  it('freezes Lilac live subscription pricing through the driver pricing facet', async () => {
    const { ProviderDriverRegistry } = await import('../../src/main/providers/drivers/registry');
    const { ProviderRuntime } = await import('../../src/main/providers');
    const { createLilacProviderDriver } = await import('../../src/main/providers/drivers/lilac');
    const { PricingRefresher } = await import('../../src/main/providers/facets/pricing-refresh');
    const lilacConnection: ProviderConnection = {
      ...connection,
      providerId: 'lilac',
      name: 'Lilac subscription',
      modelIds: ['moonshotai/kimi-k2.6'],
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
          displayName: 'Lilac',
          supportedAuthMethods: ['api-key'],
          supportedProtocols: ['openai-compatible'],
          allowsCustomModels: false,
          lifecycle: 'active',
          provenance: { source: 'catalog', observedAt: '2026-07-12T12:00:00.000Z' },
          models: [{
            id: 'moonshotai/kimi-k2.6',
            displayName: 'Kimi K2.6',
            protocol: 'openai-compatible',
            capabilities: {
              inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false,
            },
            limits: { contextTokens: 128000, outputTokens: 16384 },
            lifecycle: 'active',
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
    let now = new Date('2026-07-12T12:00:30.000Z');
    const statusPayload = (multiplier: number, discount: number, updatedAt: string) => ({
      updated_at: updatedAt,
      window: '5m',
      window_secs: 300,
      stale: false,
      current_subscription_supply_updated_at: updatedAt,
      models: [{
        id: 'moonshotai/kimi-k2.6',
        current_subscription_supply_state: 'surplus',
        current_subscription_discount_percent: discount,
        current_subscription_credit_multiplier: multiplier,
      }],
    });
    let payload = statusPayload(0.25, 75, '2026-07-12T12:00:00.000Z');
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const refresher = new PricingRefresher({ now: () => now });
    const lilacDriver = {
      ...createLilacProviderDriver({ fetch: fetch as typeof globalThis.fetch, now: () => now }),
      createLanguageModel: vi.fn(async () => ({ kind: 'lilac-model' })),
    };
    const runtime = new ProviderRuntime({
      catalog: {
        getProviderDefinitions: () => [lilacProvider],
        load: () => pricingCatalog,
      },
      connections: { list: async () => [lilacConnection] },
      vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'vault-key' })) },
      registry: new ProviderDriverRegistry([lilacDriver]),
      pricing: refresher,
    });
    const selection = { connectionId: lilacConnection.id, modelId: 'moonshotai/kimi-k2.6' };

    // A request never blocks on pricing freshness: the first freeze holds
    // catalog list rates while the live fetch runs in the background.
    const first = await runtime.resolveExecution(selection);
    expect(first.snapshot.pricing).toMatchObject({
      rates: { input: { amount: '0.7' }, output: { amount: '3.5' } },
      provenance: { source: 'catalog', dynamic: { state: 'unavailable' } },
    });

    await refresher.settled();
    const second = await runtime.resolveExecution(selection);
    expect(second.snapshot.pricing).toMatchObject({
      effectiveAt: '2026-07-12T12:00:00.000Z',
      rates: {
        input: { amount: '0.175', provenance: { source: 'provider-api' } },
        output: { amount: '0.875' },
      },
      provenance: {
        source: 'provider-api',
        dynamic: { state: 'fresh', adjustment: { multiplier: '0.25', discountPercent: 75 } },
      },
    });
    // The second resolve stayed inside the declared cadence: no refetch.
    expect(fetch).toHaveBeenCalledTimes(1);

    // A changed multiplier only affects snapshots frozen after its refresh lands.
    payload = statusPayload(0.5, 50, '2026-07-12T12:06:00.000Z');
    now = new Date('2026-07-12T12:06:30.000Z');
    const third = await runtime.resolveExecution(selection);
    expect(third.snapshot.pricing?.rates.input).toMatchObject({
      amount: '0.175',
      provenance: { source: 'provider-api', stale: true },
    });
    await refresher.settled();
    const fourth = await runtime.resolveExecution(selection);
    expect(fourth.snapshot.pricing?.rates.input).toMatchObject({ amount: '0.35' });
    expect(second.snapshot.pricing?.rates.input?.amount).toBe('0.175');

    // An unreachable pricing endpoint keeps last-known rates marked stale.
    now = new Date('2026-07-12T12:12:00.000Z');
    fetch.mockRejectedValueOnce(new Error('HTTP 503'));
    const fifth = await runtime.resolveExecution(selection);
    expect(fifth.snapshot.pricing?.rates.input?.amount).toBe('0.35');
    await refresher.settled();
    const sixth = await runtime.resolveExecution(selection);
    expect(sixth.snapshot.pricing).toMatchObject({
      rates: { input: { amount: '0.35', provenance: { source: 'provider-api', stale: true } } },
      provenance: { source: 'provider-api', dynamic: { state: 'stale', error: 'HTTP 503' } },
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
