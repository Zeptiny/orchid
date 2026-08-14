/** Live model discovery (U5): driver fetchModels hooks, precedence merge, unified rows. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DiscoveredProviderModel,
  ProviderConnection,
  ProviderDefinition,
  ProviderModelDefinition,
  ProviderProtocol,
} from '../../src/shared/types/provider';
import {
  discoverConnectionModels,
  listConnectionModelRows,
  mergeDiscoveredModels,
  resolveEffectiveModel,
} from '../../src/main/providers/facets/discovery';
import {
  createNeuralwattProviderDriver,
  NEURALWATT_MODELS_URL,
  parseNeuralwattModels,
} from '../../src/main/providers/drivers/neuralwatt';
import {
  createLilacProviderDriver,
  LILAC_MODELS_URL,
  parseLilacModels,
} from '../../src/main/providers/drivers/lilac';
import {
  createNativeProviderDrivers,
  OPENAI_MODELS_URL,
  parseOpenAIModels,
} from '../../src/main/providers/drivers/native';
import {
  createOpenCodeGoProviderDriver,
  OPENCODE_GO_MODELS_URL,
  parseOpenCodeGoModels,
} from '../../src/main/providers/drivers/opencode-go';
import {
  createCompatibleProviderDrivers,
  parseCompatibleModels,
} from '../../src/main/providers/drivers/compatible';
import { resolveModelSelection } from '../../src/main/providers/resolver';
import type { DriverDiscoveryRequest, ProviderDriver } from '../../src/main/providers/drivers/types';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
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
        reasoning: true,
      },
      limits: { contextTokens: 1000, outputTokens: 100 },
    }],
    ...overrides,
  };
}

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: CONNECTION_ID,
    providerId: 'neuralwatt',
    name: 'NW account',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: 'credential-nw-v1' },
    modelIds: ['nw-base'],
    health: 'ready',
    ...overrides,
  };
}

function driverWithModels(
  fetchModels: (request: DriverDiscoveryRequest) => Promise<readonly DiscoveredProviderModel[]>,
): ProviderDriver {
  return {
    id: 'neuralwatt',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomEndpoint: false,
    origin: 'https://api.neuralwatt.com/v1',
    createLanguageModel: vi.fn(),
    discoveryFacet: { fetchModels },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function catalogModel(id: string, protocol: ProviderProtocol): ProviderModelDefinition {
  return { id, displayName: id, protocol };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Neuralwatt models endpoint', () => {
  it('parses inline pricing, limits, capabilities, and reasoning metadata', () => {
    const models = parseNeuralwattModels({
      object: 'list',
      data: [{
        id: 'glm-5.2',
        display_name: 'GLM 5.2',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        tools: true,
        reasoning: true,
        context_tokens: 202_752,
        output_tokens: 16_384,
        reasoning_levels: ['low', 'medium', 'high'],
        reasoning_default: 'medium',
        pricing: {
          currency: 'USD',
          observed_at: '2026-08-08T10:00:00.000Z',
          input_usd_per_million_tokens: '1.25',
          output_usd_per_million_tokens: 10,
          cache_read_usd_per_million_tokens: '0.125',
          request_fee_usd: '0.001',
          energy_usd_per_kwh: '0.42',
        },
      }],
    }, new Date('2026-08-08T12:00:00.000Z'));

    expect(models).toEqual([{
      id: 'glm-5.2',
      displayName: 'GLM 5.2',
      capabilities: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        tools: true,
        reasoning: true,
      },
      limits: { contextTokens: 202_752, outputTokens: 16_384 },
      reasoningLevels: ['low', 'medium', 'high'],
      reasoningDefault: 'medium',
      pricing: {
        currencyUnit: { kind: 'fiat', code: 'USD' },
        observedAt: '2026-08-08T10:00:00.000Z',
        rates: {
          input: { amount: '1.25', per: 1_000_000, unit: 'tokens' },
          output: { amount: '10', per: 1_000_000, unit: 'tokens' },
          cacheRead: { amount: '0.125', per: 1_000_000, unit: 'tokens' },
          perRequest: { amount: '0.001', per: 1, unit: 'requests' },
          energy: { amount: '0.42', per: 1, unit: 'energy' },
        },
      },
    }]);
  });

  it('contributes only the id from ids-only entries and skips malformed rows', () => {
    const models = parseNeuralwattModels({
      data: [
        { id: 'glm-5.2-flex' },
        { id: 'glm-5.2-flex' },
        { name: 'missing id' },
        'not-a-record',
      ],
    });
    expect(models).toEqual([{ id: 'glm-5.2-flex' }]);
    expect(() => parseNeuralwattModels({ unexpected: true })).toThrow(/no data array/i);
  });

  it('fetches the code-owned models URL with the connection credential', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'glm-5.2' }] }));
    const driver = createNeuralwattProviderDriver({ fetch: fetch as typeof globalThis.fetch });

    const models = await driver.discoveryFacet!.fetchModels({
      connection: connection(),
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'nw-secret-key' },
    });

    expect(models).toEqual([{ id: 'glm-5.2' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(NEURALWATT_MODELS_URL);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer nw-secret-key');
  });

  it('fails with the HTTP status when the endpoint rejects the fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: 'nope' }, 401));
    const driver = createNeuralwattProviderDriver({ fetch: fetch as typeof globalThis.fetch });
    await expect(driver.discoveryFacet!.fetchModels({
      connection: connection(),
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'nw-secret-key' },
    })).rejects.toThrow(/HTTP 401/);
  });
});

describe('Lilac models endpoint', () => {
  it('parses the OpenAI-style ids-only list with an optional display name', () => {
    expect(parseLilacModels({
      object: 'list',
      data: [
        { id: 'moonshotai/kimi-k2.6', object: 'model', created: 1, owned_by: 'lilac' },
        { id: 'zai-org/glm-5.2', name: 'GLM 5.2' },
      ],
    })).toEqual([
      { id: 'moonshotai/kimi-k2.6' },
      { id: 'zai-org/glm-5.2', displayName: 'GLM 5.2' },
    ]);
  });

  it('wires the discovery facet through the driver with injected transport', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'moonshotai/kimi-k2.6' }] }));
    const driver = createLilacProviderDriver({ fetch: fetch as typeof globalThis.fetch });

    const models = await driver.discoveryFacet!.fetchModels({
      connection: connection(),
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'lilac-key' },
    });

    expect(models).toEqual([{ id: 'moonshotai/kimi-k2.6' }]);
    expect(fetch.mock.calls[0]?.[0]).toBe(LILAC_MODELS_URL);
  });
});

describe('OpenAI models endpoint', () => {
  it('parses ids-only entries and stamps the catalog-declared Responses protocol', () => {
    const models = parseOpenAIModels({
      object: 'list',
      data: [
        { id: 'gpt-5.2', object: 'model', created: 1_755_270_000, owned_by: 'openai' },
        { id: 'gpt-4.1' },
        { id: 'gpt-unlisted' },
        { name: 'missing id' },
      ],
    }, [
      catalogModel('gpt-5.2', 'openai-responses'),
      catalogModel('gpt-4.1', 'openai-compatible'),
    ]);

    expect(models).toEqual([
      { id: 'gpt-5.2', protocol: 'openai-responses' },
      { id: 'gpt-4.1' },
      { id: 'gpt-unlisted' },
    ]);
  });

  it('fetches the code-owned OpenAI models URL with the connection credential', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'gpt-4.1' }] }));
    const openai = createNativeProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((driver) => driver.id === 'openai')!;

    const models = await openai.discoveryFacet!.fetchModels({
      connection: connection({ providerId: 'openai' }),
      provider: definition({ id: 'openai', models: [] }),
      credential: { kind: 'api-key', apiKey: 'sk-openai-key' },
    });

    expect(models).toEqual([{ id: 'gpt-4.1' }]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(OPENAI_MODELS_URL);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-openai-key');
  });

  it('drops Responses-routed ids from a chat-protocol connection snapshot', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      data: [{ id: 'gpt-5.2' }, { id: 'gpt-4.1' }, { id: 'gpt-new' }],
    }));
    const openai = createNativeProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((driver) => driver.id === 'openai')!;

    const outcome = await discoverConnectionModels({
      driver: openai,
      connection: connection({ providerId: 'openai', protocol: 'openai-compatible' }),
      provider: definition({
        id: 'openai',
        supportedProtocols: ['openai-compatible', 'openai-responses'],
        models: [
          catalogModel('gpt-5.2', 'openai-responses'),
          catalogModel('gpt-4.1', 'openai-compatible'),
        ],
      }),
      credential: { kind: 'api-key', apiKey: 'sk-openai-key' },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.discoveredModels.map((model) => model.id)).toEqual(['gpt-4.1', 'gpt-new']);
    expect(outcome.addedModelIds).toEqual(['gpt-new']);
  });

  it('fails with the HTTP status when the endpoint rejects the fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: 'nope' }, 401));
    const openai = createNativeProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((driver) => driver.id === 'openai')!;

    await expect(openai.discoveryFacet!.fetchModels({
      connection: connection({ providerId: 'openai' }),
      provider: definition({ id: 'openai', models: [] }),
      credential: { kind: 'api-key', apiKey: 'sk-openai-key' },
    })).rejects.toThrow(/HTTP 401/);
  });

  it('leaves native drivers without a verified models endpoint undiscoverable', () => {
    const drivers = createNativeProviderDrivers();
    for (const id of ['anthropic', 'google-gemini', 'xai']) {
      expect(drivers.find((driver) => driver.id === id)?.discoveryFacet).toBeUndefined();
    }
  });
});

describe('OpenCode Go models endpoint', () => {
  it('parses ids-only entries and maps protocols from the frozen catalog table', () => {
    const models = parseOpenCodeGoModels({
      data: [
        { id: 'glm-5.2' },
        { id: 'claude-opus-4-6' },
        { id: 'gpt-5.2' },
        { id: 'unlisted-model' },
      ],
    }, [
      catalogModel('glm-5.2', 'openai-compatible'),
      catalogModel('claude-opus-4-6', 'anthropic-messages'),
      catalogModel('gpt-5.2', 'openai-responses'),
    ]);

    expect(models).toEqual([
      { id: 'glm-5.2', protocol: 'openai-compatible' },
      { id: 'claude-opus-4-6', protocol: 'anthropic-messages' },
      { id: 'gpt-5.2', protocol: 'openai-responses' },
      { id: 'unlisted-model' },
    ]);
  });

  it('wires the discovery facet through the driver with injected transport', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'glm-5.2' }] }));
    const driver = createOpenCodeGoProviderDriver({ fetch: fetch as typeof globalThis.fetch });

    const models = await driver.discoveryFacet!.fetchModels({
      connection: connection({ providerId: 'opencode-go' }),
      provider: definition({
        id: 'opencode-go',
        models: [catalogModel('glm-5.2', 'openai-compatible')],
      }),
      credential: { kind: 'api-key', apiKey: 'go-key' },
    });

    expect(models).toEqual([{ id: 'glm-5.2', protocol: 'openai-compatible' }]);
    expect(fetch.mock.calls[0]?.[0]).toBe(OPENCODE_GO_MODELS_URL);
  });

  it('fails with the HTTP status when the endpoint rejects the fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: 'down' }, 503));
    const driver = createOpenCodeGoProviderDriver({ fetch: fetch as typeof globalThis.fetch });

    await expect(driver.discoveryFacet!.fetchModels({
      connection: connection({ providerId: 'opencode-go' }),
      provider: definition({ id: 'opencode-go', models: [] }),
      credential: { kind: 'api-key', apiKey: 'go-key' },
    })).rejects.toThrow(/HTTP 503/);
  });
});

describe('generic OpenAI-compatible models endpoint', () => {
  it('parses the ids-only list and skips malformed rows', () => {
    expect(parseCompatibleModels({
      data: [{ id: 'local-model' }, { id: 'local-model' }, { name: 'missing id' }],
    })).toEqual([{ id: 'local-model' }]);
  });

  it('builds the models URL from the validated connection endpoint', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'local-model' }] }));
    const driver = createCompatibleProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((candidate) => candidate.id === 'generic-openai-compatible')!;

    const models = await driver.discoveryFacet!.fetchModels({
      connection: connection({
        providerId: 'generic-openai-compatible',
        endpoint: 'http://localhost:1234/v1/',
      }),
      provider: definition({ id: 'generic-openai-compatible', models: [] }),
      credential: { kind: 'api-key', apiKey: 'local-key' },
      endpoint: 'http://localhost:1234/v1/',
    });

    expect(models).toEqual([{ id: 'local-model' }]);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://localhost:1234/v1/models');
  });

  it('threads the connection endpoint through discovery orchestration', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [{ id: 'local-model' }] }));
    const driver = createCompatibleProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((candidate) => candidate.id === 'generic-openai-compatible')!;

    const outcome = await discoverConnectionModels({
      driver,
      connection: connection({
        providerId: 'generic-openai-compatible',
        endpoint: 'http://localhost:1234/v1',
      }),
      provider: definition({ id: 'generic-openai-compatible', models: [] }),
      credential: { kind: 'api-key', apiKey: 'local-key' },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.addedModelIds).toEqual(['local-model']);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://localhost:1234/v1/models');
  });

  it('requires an endpoint and refuses unconfirmed non-loopback HTTP before fetching', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [] }));
    const driver = createCompatibleProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((candidate) => candidate.id === 'generic-openai-compatible')!;

    await expect(driver.discoveryFacet!.fetchModels({
      connection: connection({ providerId: 'generic-openai-compatible' }),
      provider: definition({ id: 'generic-openai-compatible', models: [] }),
      credential: { kind: 'api-key', apiKey: 'local-key' },
    })).rejects.toThrow(/requires an endpoint/);

    await expect(driver.discoveryFacet!.fetchModels({
      connection: connection({
        providerId: 'generic-openai-compatible',
        endpoint: 'http://192.168.1.10:8000/v1',
      }),
      provider: definition({ id: 'generic-openai-compatible', models: [] }),
      credential: { kind: 'api-key', apiKey: 'local-key' },
      endpoint: 'http://192.168.1.10:8000/v1',
    })).rejects.toThrow(/Non-loopback HTTP/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails with the HTTP status when the endpoint rejects the fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: 'nope' }, 502));
    const driver = createCompatibleProviderDrivers({ fetch: fetch as typeof globalThis.fetch })
      .find((candidate) => candidate.id === 'generic-openai-compatible')!;

    await expect(driver.discoveryFacet!.fetchModels({
      connection: connection({
        providerId: 'generic-openai-compatible',
        endpoint: 'http://localhost:1234/v1',
      }),
      provider: definition({ id: 'generic-openai-compatible', models: [] }),
      credential: { kind: 'api-key', apiKey: 'local-key' },
      endpoint: 'http://localhost:1234/v1',
    })).rejects.toThrow(/HTTP 502/);
  });
});

describe('discovery merge', () => {
  it('stamps provider provenance and drops protocol-mismatched and duplicate entries', () => {
    const merged = mergeDiscoveredModels(connection(), [
      { id: 'nw-base', limits: { contextTokens: 2000, outputTokens: null } },
      { id: 'nw-base', displayName: 'duplicate' },
      { id: 'nw-other-protocol', protocol: 'anthropic-messages' },
      { id: 'nw-new' },
    ], new Date('2026-08-08T12:00:00.000Z'));

    expect(merged).toEqual([
      {
        id: 'nw-base',
        limits: { contextTokens: 2000, outputTokens: null },
        provenance: 'provider',
        discoveredAt: '2026-08-08T12:00:00.000Z',
      },
      { id: 'nw-new', provenance: 'provider', discoveredAt: '2026-08-08T12:00:00.000Z' },
    ]);
  });

  it('reports unsupported, missing-credential, and redacted failures without touching models', async () => {
    const plain: ProviderDriver = {
      id: 'neuralwatt',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://api.neuralwatt.com/v1',
      createLanguageModel: vi.fn(),
    };
    const prior = connection({
      discoveredModels: [{
        id: 'nw-old',
        provenance: 'provider',
        discoveredAt: '2026-08-01T00:00:00.000Z',
      }],
    });

    await expect(discoverConnectionModels({
      driver: plain,
      connection: prior,
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'key' },
    })).resolves.toMatchObject({ status: 'unsupported', discoveredModels: prior.discoveredModels });

    await expect(discoverConnectionModels({
      driver: driverWithModels(vi.fn()),
      connection: prior,
      provider: definition(),
      credential: undefined,
    })).resolves.toMatchObject({ status: 'no-credential' });

    const failure = await discoverConnectionModels({
      driver: driverWithModels(async () => {
        throw new Error('request failed: authorization=sk-live-secret-key-value');
      }),
      connection: prior,
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'sk-live-secret-key-value' },
    });
    expect(failure.status).toBe('failed');
    expect(failure.discoveredModels).toEqual(prior.discoveredModels);
    expect(failure.message).not.toContain('sk-live-secret-key-value');
  });

  it('merges a successful fetch, names added models, and seeds reasoning fill-absent', async () => {
    const existing = connection({
      reasoningConfig: { 'nw-new': { levels: ['user-low'], default: 'user-low' } },
      discoveredModels: [{ id: 'nw-gone', provenance: 'provider', discoveredAt: '2026-08-01T00:00:00.000Z' }],
    });
    const outcome = await discoverConnectionModels({
      driver: driverWithModels(async () => [
        { id: 'nw-base' },
        {
          id: 'nw-new',
          capabilities: {
            inputModalities: ['text'],
            outputModalities: ['text'],
            tools: true,
            reasoning: true,
          },
          reasoningLevels: ['low', 'high'],
          reasoningDefault: 'low',
        },
      ]),
      connection: existing,
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'key' },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.addedModelIds).toEqual(['nw-new']);
    // The stale snapshot entry disappears; the fresh snapshot replaces it.
    expect(outcome.discoveredModels.map((model) => model.id)).toEqual(['nw-base', 'nw-new']);
    // Existing user reasoning configuration wins over the live levels.
    expect(outcome.reasoningConfig).toBeUndefined();
  });

  it('prunes selections whose models the fresh snapshot no longer backs', async () => {
    const existing = connection({
      modelIds: ['nw-base', 'nw-gone'],
      tierSelections: { 'nw-base': 'lite', 'nw-gone': 'pro' },
      reasoningConfig: {
        'nw-base': { levels: ['low', 'high'], default: 'low' },
        'nw-gone': { levels: ['low'], default: 'low' },
      },
      discoveredModels: [{
        id: 'nw-gone',
        provenance: 'provider',
        discoveredAt: '2026-08-01T00:00:00.000Z',
      }],
    });
    const outcome = await discoverConnectionModels({
      driver: driverWithModels(async () => [{ id: 'nw-base' }]),
      connection: existing,
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'key' },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.discoveredModels.map((model) => model.id)).toEqual(['nw-base']);
    // The delisted model's selections are flagged for pruning rather than left
    // orphaned, while selections for still-backed models are untouched.
    expect(outcome.prune).toEqual({
      modelIds: ['nw-gone'],
      tierSelections: ['nw-gone'],
      reasoningConfig: ['nw-gone'],
    });
  });

  it('never prunes selections backed by the catalog, custom models, or the fresh snapshot', async () => {
    const outcome = await discoverConnectionModels({
      driver: driverWithModels(async () => [{ id: 'nw-new' }]),
      connection: connection({
        modelIds: ['nw-base', 'nw-custom', 'nw-new'],
        customModels: [{
          id: 'nw-custom',
          displayName: 'Custom entry',
          protocol: 'openai-compatible',
          capabilities: {
            inputModalities: ['text'],
            outputModalities: ['text'],
            tools: true,
            reasoning: false,
          },
          limits: { contextTokens: 4096, outputTokens: 1024 },
        }],
        tierSelections: { 'nw-base': 'lite' },
        reasoningConfig: { 'nw-new': { levels: ['low'], default: 'low' } },
      }),
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'key' },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.prune).toEqual({ modelIds: [], tierSelections: [], reasoningConfig: [] });
  });

  it('seeds reasoning levels from live metadata only when nothing is configured', async () => {
    const outcome = await discoverConnectionModels({
      driver: driverWithModels(async () => [{
        id: 'nw-new',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: true },
        reasoningLevels: ['low', 'high'],
        reasoningDefault: 'low',
      }]),
      connection: connection(),
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'key' },
    });
    expect(outcome.reasoningConfig).toEqual({ 'nw-new': { levels: ['low', 'high'], default: 'low' } });
  });

  it('never schedules background polling work', async () => {
    vi.useFakeTimers();
    const fetchModels = vi.fn(async (): Promise<readonly DiscoveredProviderModel[]> => [{ id: 'nw-new' }]);
    const outcome = await discoverConnectionModels({
      driver: driverWithModels(fetchModels),
      connection: connection(),
      provider: definition(),
      credential: { kind: 'api-key', apiKey: 'key' },
    });
    expect(outcome.status).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });
});

describe('unified listing rows', () => {
  it('lets live metadata override catalog values with a provider badge', () => {
    const rows = listConnectionModelRows(connection({
      discoveredModels: [{
        id: 'nw-base',
        displayName: 'NW Base Live',
        limits: { contextTokens: 2000, outputTokens: null },
        provenance: 'provider',
        discoveredAt: '2026-08-08T12:00:00.000Z',
      }],
    }), definition());

    const row = rows.find((candidate) => candidate.model.id === 'nw-base');
    expect(row).toMatchObject({
      source: 'provider',
      enabled: true,
      customized: false,
      discoveredAt: '2026-08-08T12:00:00.000Z',
      model: {
        displayName: 'NW Base Live',
        // The live context length replaces the catalog one (AE8); the absent
        // live output limit falls through to the catalog value.
        limits: { contextTokens: 2000, outputTokens: 100 },
        capabilities: { reasoning: true },
      },
    });
  });

  it('preserves explicit user overrides over live and catalog values', () => {
    const rows = listConnectionModelRows(connection({
      customModels: [{
        id: 'nw-base',
        displayName: 'My tuned base',
        protocol: 'openai-compatible',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: false, reasoning: true },
        limits: { contextTokens: 32_000, outputTokens: 4_000 },
      }],
      discoveredModels: [{
        id: 'nw-base',
        limits: { contextTokens: 999_999, outputTokens: 99_999 },
        provenance: 'provider',
        discoveredAt: '2026-08-08T12:00:00.000Z',
      }],
    }), definition());

    const row = rows.find((candidate) => candidate.model.id === 'nw-base');
    expect(row).toMatchObject({
      customized: true,
      model: {
        displayName: 'My tuned base',
        limits: { contextTokens: 32_000, outputTokens: 4_000 },
        capabilities: { tools: false, reasoning: true },
      },
    });
  });

  it('keeps catalog metadata intact for ids-only discovery and badges all three origins', () => {
    const rows = listConnectionModelRows(connection({
      customModels: [{
        id: 'nw-custom',
        displayName: 'Custom entry',
        protocol: 'openai-compatible',
        capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: false },
        limits: { contextTokens: 4096, outputTokens: 1024 },
      }],
      discoveredModels: [
        { id: 'nw-base', provenance: 'provider', discoveredAt: '2026-08-08T12:00:00.000Z' },
        { id: 'nw-live-only', provenance: 'provider', discoveredAt: '2026-08-08T12:00:00.000Z' },
      ],
    }), definition());

    const byId = new Map(rows.map((row) => [row.model.id, row]));
    // Ids-only live data contributes nothing beyond the id (R27).
    expect(byId.get('nw-base')).toMatchObject({
      source: 'catalog',
      model: { displayName: 'NW Base', limits: { contextTokens: 1000, outputTokens: 100 } },
    });
    expect(byId.get('nw-live-only')).toMatchObject({
      source: 'provider',
      enabled: false,
      model: { id: 'nw-live-only', displayName: 'nw-live-only' },
    });
    expect(byId.get('nw-custom')).toMatchObject({
      source: 'user',
      enabled: false,
      customized: false,
      model: { displayName: 'Custom entry', limits: { contextTokens: 4096 } },
    });
    expect(rows.every((row) => typeof row.enabled === 'boolean')).toBe(true);
  });
});

describe('resolver integration', () => {
  it('resolves a discovered-only model with its live metadata', () => {
    const result = resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'nw-live-only' },
      [connection({
        modelIds: ['nw-base', 'nw-live-only'],
        discoveredModels: [{
          id: 'nw-live-only',
          displayName: 'NW Live',
          capabilities: { inputModalities: ['text'], outputModalities: ['text'], tools: true, reasoning: true },
          limits: { contextTokens: 5000, outputTokens: 500 },
          provenance: 'provider',
          discoveredAt: '2026-08-08T12:00:00.000Z',
        }],
      })],
      [definition()],
    );

    expect(result).toMatchObject({
      kind: 'resolved',
      model: {
        id: 'nw-live-only',
        source: 'connection',
        displayName: 'NW Live',
        capabilities: { reasoning: true },
        limits: { contextTokens: 5000, outputTokens: 500 },
      },
    });
  });

  it('applies live metadata over catalog metadata at request time', () => {
    const result = resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'nw-base' },
      [connection({
        discoveredModels: [{
          id: 'nw-base',
          limits: { contextTokens: 2000, outputTokens: null },
          provenance: 'provider',
          discoveredAt: '2026-08-08T12:00:00.000Z',
        }],
      })],
      [definition()],
    );

    expect(result).toMatchObject({
      kind: 'resolved',
      model: { source: 'catalog', limits: { contextTokens: 2000, outputTokens: 100 } },
    });
  });

  it('resolveEffectiveModel fills absent live fields from the catalog without degradation', () => {
    const effective = resolveEffectiveModel({
      catalog: definition().models[0],
      discovered: {
        id: 'nw-base',
        provenance: 'provider',
        discoveredAt: '2026-08-08T12:00:00.000Z',
      },
      fallbackId: 'nw-base',
      fallbackProtocol: 'openai-compatible',
    });
    expect(effective).toMatchObject({
      displayName: 'NW Base',
      capabilities: { reasoning: true },
      limits: { contextTokens: 1000, outputTokens: 100 },
    });
  });
});
