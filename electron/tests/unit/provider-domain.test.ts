import { describe, expect, it } from 'vitest';
import {
  modelSelectionSchema,
  copyModelSelection,
  parseProviderConnectionDocument,
  providerConnectionSchema,
  providerProtocolSchema,
  type ProviderConnection,
  type ProviderDefinition,
} from '../../src/shared/types/provider';
import { ProviderDriverRegistry } from '../../src/main/providers/drivers/registry';
import type { ProviderDriver } from '../../src/main/providers/drivers/types';
import { resolveModelSelection } from '../../src/main/providers/resolver';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    models: [{ id: 'vendor/path/model', displayName: 'Slash model', protocol: 'openai-compatible' }],
    allowsCustomModels: false,
    ...overrides,
  };
}

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: CONNECTION_ID,
    providerId: 'openai',
    name: 'Work account',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: 'credential-work-v1' },
    modelIds: ['vendor/path/model'],
    health: 'ready',
    ...overrides,
  };
}

describe('provider domain', () => {
  it('keeps a model id containing slashes intact in a connection-scoped selection', () => {
    const selection = modelSelectionSchema.parse({
      connectionId: CONNECTION_ID,
      modelId: 'vendor/path/model',
    });
    expect(selection).toEqual({
      connectionId: CONNECTION_ID,
      modelId: 'vendor/path/model',
    });
    expect(copyModelSelection(selection)).toEqual(selection);
    expect(copyModelSelection(selection)).not.toBe(selection);
  });

  it('rejects malformed selections and secret-bearing connection records', () => {
    expect(() => modelSelectionSchema.parse({ connectionId: 'not-a-uuid', modelId: 'model' }))
      .toThrow();
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      name: ' ',
    })).toThrow();
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      credential: { kind: 'environment', variable: 'lowercase' },
    })).toThrow();
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      apiKey: 'never-persist-this',
    })).toThrow();
  });

  it('returns provider-required with no usable connection', () => {
    expect(resolveModelSelection(null, [], [definition()])).toEqual({
      kind: 'provider-required',
      reason: 'no-usable-connection',
    });
    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({ health: 'disabled' })],
      [definition()],
    )).toEqual({
      kind: 'provider-required',
      reason: 'no-usable-connection',
    });
  });

  it('requires an explicit selection instead of auto-selecting a ready connection', () => {
    expect(resolveModelSelection(null, [connection()], [definition()])).toEqual({
      kind: 'selection-required',
      reason: 'no-selection',
    });
  });

  it('resolves only the selected connection and preserves slash model ids', () => {
    const result = resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [
        connection(),
        connection({
          id: OTHER_CONNECTION_ID,
          name: 'Personal account',
          credential: { kind: 'stored', handle: 'credential-personal-v1' },
        }),
      ],
      [definition()],
    );

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.connection.id).toBe(CONNECTION_ID);
      expect(result.model.id).toBe('vendor/path/model');
    }
  });

  it('does not resolve a catalog model removed from the connection model set', () => {
    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({ modelIds: [] })],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'missing-model' });
  });

  it('prefers connection-local metadata over a matching preconfigured catalog model', () => {
    const result = resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({
        customModels: [{
          id: 'vendor/path/model',
          displayName: 'Work-tuned model',
          protocol: 'openai-compatible',
          capabilities: {
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            tools: false,
            reasoning: true,
          },
          limits: { contextTokens: 64_000, outputTokens: 8_000 },
        }],
      })],
      [definition({ allowsCustomModels: false })],
    );

    expect(result).toMatchObject({
      kind: 'resolved',
      model: {
        source: 'connection',
        displayName: 'Work-tuned model',
        capabilities: { inputModalities: ['text', 'image'] },
      },
    });
  });

  it('fails closed for unknown, disabled, and definition-mismatched selections', () => {
    expect(resolveModelSelection(
      { connectionId: OTHER_CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection()],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'unknown-connection' });

    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'vendor/path/model' },
      [connection({ health: 'disabled' }), connection({ id: OTHER_CONNECTION_ID })],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'connection-not-ready' });

    expect(resolveModelSelection(
      { connectionId: CONNECTION_ID, modelId: 'different-provider-model' },
      [connection()],
      [definition()],
    )).toMatchObject({ kind: 'unavailable', reason: 'missing-model' });
  });
});

describe('provider protocol extensions', () => {
  it('accepts openai-responses as a first-class protocol', () => {
    expect(providerProtocolSchema.parse('openai-responses')).toBe('openai-responses');
    expect(providerConnectionSchema.parse(connection({ protocol: 'openai-responses' })).protocol)
      .toBe('openai-responses');
  });
});

describe('provider connection document v2', () => {
  it('migrates a v1 document to v2 with empty new fields, preserving connections', () => {
    const legacy = connection();
    const migrated = parseProviderConnectionDocument({
      version: 1,
      connections: [legacy],
    });

    expect(migrated.version).toBe(2);
    expect(migrated.connections).toEqual([legacy]);
    expect(migrated.connections[0].discoveredModels).toBeUndefined();
    expect(migrated.connections[0].pricingOverrides).toBeUndefined();
    expect(migrated.connections[0].tierSelections).toBeUndefined();
  });

  it('passes current documents through and rejects malformed documents', () => {
    const current = { version: 2, connections: [connection()] };
    expect(parseProviderConnectionDocument(current).connections).toEqual([connection()]);

    expect(() => parseProviderConnectionDocument({ version: 3, connections: [] })).toThrow();
    expect(() => parseProviderConnectionDocument({
      version: 1,
      connections: [connection(), connection()],
    })).toThrow(/duplicate/i);
  });

  it('round-trips discovered models, pricing overrides, and tier selections', () => {
    const parsed = providerConnectionSchema.parse(connection({
      discoveredModels: [{
        id: 'vendor/path/discovered',
        displayName: 'Discovered model',
        protocol: 'openai-compatible',
        reasoningLevels: ['low', 'high'],
        pricing: {
          currencyUnit: { kind: 'fiat', code: 'USD' },
          observedAt: '2026-08-08T12:00:00.000Z',
          rates: { input: { amount: '1.250000', per: 1_000_000, unit: 'tokens' } },
        },
        provenance: 'provider',
        discoveredAt: '2026-08-08T12:00:00.000Z',
      }],
      pricingOverrides: {
        'vendor/path/model': {
          output: { amount: '9.000000', per: 1_000_000, unit: 'tokens' },
          cacheWriteByTtl: { '1h': { amount: '6.250000', per: 1_000_000, unit: 'tokens' } },
        },
      },
      tierSelections: { 'vendor/path/model': 'flex' },
    }));

    expect(parsed.discoveredModels?.[0]).toMatchObject({
      id: 'vendor/path/discovered',
      provenance: 'provider',
    });
    expect(parsed.pricingOverrides?.['vendor/path/model']?.output?.amount).toBe('9.000000');
    expect(parsed.tierSelections?.['vendor/path/model']).toBe('flex');
  });

  it('rejects malformed facet data on connections', () => {
    expect(() => providerConnectionSchema.parse({
      ...connection(),
      discoveredModels: [{
        id: 'vendor/path/discovered',
        provenance: 'user',
        discoveredAt: '2026-08-08T12:00:00.000Z',
      }],
    })).toThrow();

    expect(() => providerConnectionSchema.parse({
      ...connection(),
      pricingOverrides: {
        'vendor/path/model': {
          cacheWriteByTtl: { weekly: { amount: '1', per: 1_000_000, unit: 'tokens' } },
        },
      },
    })).toThrow();

    expect(() => providerConnectionSchema.parse({
      ...connection(),
      pricingOverrides: {
        'vendor/path/model': { input: { amount: '-1', per: 1_000_000, unit: 'tokens' } },
      },
    })).toThrow();

    expect(() => providerConnectionSchema.parse({
      ...connection(),
      tierSelections: { 'vendor/path/model': ' ' },
    })).toThrow();
  });
});

describe('provider driver facets', () => {
  it('keeps a driver with no facet hooks valid', () => {
    const driver: ProviderDriver = {
      id: 'bare-driver',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible'],
      allowsCustomEndpoint: false,
      origin: 'https://example.test',
      createLanguageModel: () => Promise.reject(new Error('not exercised')),
    };

    const registry = new ProviderDriverRegistry([driver]);
    expect(registry.require('bare-driver')).toBe(driver);
    expect(driver.thinkingPolicy).toBeUndefined();
    expect(driver.tierMechanism).toBeUndefined();
    expect(driver.pricingFacet).toBeUndefined();
    expect(driver.cacheFacet).toBeUndefined();
    expect(driver.quotaFacet).toBeUndefined();
    expect(driver.discoveryFacet).toBeUndefined();
  });
});
