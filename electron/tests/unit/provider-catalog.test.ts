import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  catalogEnvelopeSchema,
  catalogToProviderDefinitions,
  type ProviderCatalog,
} from '../../src/main/providers/catalog/schema';
import {
  CatalogTrustError,
  MAX_CATALOG_BYTES,
  validateCatalogBytes,
  validateSignedCatalog,
  type CatalogKeyring,
} from '../../src/main/providers/catalog/trust';

const NOW = '2026-07-12T00:00:00.000Z';

function createCatalog(version = 1): ProviderCatalog {
  return catalogEnvelopeSchema.parse({
    schemaVersion: 1,
    catalogVersion: version,
    issuedAt: NOW,
    expiresAt: '2026-12-31T00:00:00.000Z',
    compatibleApp: { minimum: '0.1.0', maximum: '1.0.0' },
    provenance: {
      source: 'models.dev',
      sourceUrl: 'https://models.dev/api.json',
      capturedAt: NOW,
      contentHash: 'sha256:8157aaa5ff3f76be1ea17e011eae916ff2cce4613afcff2225e03f644dfd9bf5',
    },
    providers: [
      {
        id: 'openai',
        displayName: 'OpenAI',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: true,
        lifecycle: 'active',
        provenance: { source: 'catalog', observedAt: NOW },
        models: [
          {
            id: 'gpt-test/1',
            displayName: 'GPT Test',
            protocol: 'openai-compatible',
            capabilities: {
              inputModalities: ['text'],
              outputModalities: ['text'],
              tools: true,
              reasoning: true,
            },
            limits: { contextTokens: 128000, outputTokens: 16384 },
            lifecycle: 'active',
            pricing: {
              currency: 'USD',
              effectiveAt: NOW,
              rates: {
                input: { amount: '1.250000', per: 1000000, unit: 'tokens' },
                output: { amount: '5.000000', per: 1000000, unit: 'tokens' },
              },
              provenance: { source: 'catalog', observedAt: NOW },
            },
            provenance: { source: 'catalog', observedAt: NOW },
          },
        ],
      },
    ],
  });
}

describe('provider catalog schema', () => {
  it('adapts rich catalog data to the U1 provider-definition core without losing opaque model ids', () => {
    const definitions = catalogToProviderDefinitions(createCatalog());

    expect(definitions).toEqual([
      expect.objectContaining({
        id: 'openai',
        models: [
          expect.objectContaining({
            id: 'gpt-test/1',
            protocol: 'openai-compatible',
          }),
        ],
      }),
    ]);
  });

  it('rejects duplicate provider and model identifiers before a catalog becomes visible', () => {
    const duplicateProvider = createCatalog();
    const duplicateModel = structuredClone(duplicateProvider);
    duplicateModel.providers[0].models.push(structuredClone(duplicateModel.providers[0].models[0]));

    expect(() => catalogEnvelopeSchema.parse({
      ...duplicateProvider,
      providers: [...duplicateProvider.providers, structuredClone(duplicateProvider.providers[0])],
    })).toThrow(/duplicate provider/i);
    expect(() => catalogEnvelopeSchema.parse(duplicateModel)).toThrow(/duplicate model/i);
  });

  it('accepts richer pricing dimensions and a declared non-fiat currency unit', () => {
    const catalog = createCatalog();
    const pricing = catalog.providers[0].models[0].pricing;
    pricing.currency = 'kWh';
    pricing.currencyUnit = { kind: 'non-fiat', unit: 'kWh', displayName: 'Kilowatt-hour' };
    pricing.rates.cacheWriteByTtl = {
      '1h': { amount: '6.250000', per: 1_000_000, unit: 'tokens' },
    };
    pricing.rates.perRequest = { amount: '0.01', per: 1, unit: 'requests' };
    pricing.rates.energy = { amount: '0.040000', per: 1, unit: 'energy' };
    pricing.contextTiers = [{
      overContextTokens: 200_000,
      rates: {
        input: { amount: '2.500000', per: 1_000_000, unit: 'tokens' },
        perRequest: { amount: '0.02', per: 1, unit: 'requests' },
      },
    }];

    const parsed = catalogEnvelopeSchema.parse(catalog);
    const parsedPricing = parsed.providers[0].models[0].pricing;
    expect(parsedPricing.currencyUnit).toEqual({
      kind: 'non-fiat',
      unit: 'kWh',
      displayName: 'Kilowatt-hour',
    });
    expect(parsedPricing.rates.cacheWriteByTtl?.['1h']?.amount).toBe('6.250000');
    expect(parsedPricing.rates.perRequest?.unit).toBe('requests');
    expect(parsedPricing.contextTiers?.[0]?.rates.perRequest?.amount).toBe('0.02');
  });

  it('rejects a currency that lacks a matching currencyUnit declaration', () => {
    const undeclared = createCatalog();
    undeclared.providers[0].models[0].pricing.currency = 'kWh';
    expect(() => catalogEnvelopeSchema.parse(undeclared)).toThrow(/currencyUnit/i);

    const mismatched = createCatalog();
    mismatched.providers[0].models[0].pricing.currency = 'USD';
    mismatched.providers[0].models[0].pricing.currencyUnit = { kind: 'non-fiat', unit: 'kWh' };
    expect(() => catalogEnvelopeSchema.parse(mismatched)).toThrow(/currencyUnit/i);
  });

  it('rejects invalid rate dimensions and unknown facet keys', () => {
    const badTtl = createCatalog();
    badTtl.providers[0].models[0].pricing.rates.cacheWriteByTtl = {
      weekly: { amount: '1.000000', per: 1_000_000, unit: 'tokens' },
    };
    expect(() => catalogEnvelopeSchema.parse(badTtl)).toThrow();

    const negativeRate = createCatalog();
    negativeRate.providers[0].models[0].pricing.rates.input = {
      amount: '-1.000000',
      per: 1_000_000,
      unit: 'tokens',
    };
    expect(() => catalogEnvelopeSchema.parse(negativeRate)).toThrow();

    const unknownFacet = createCatalog() as unknown as {
      providers: Array<{ facets?: Record<string, unknown> }>;
    };
    unknownFacet.providers[0].facets = { quota: {} };
    expect(() => catalogEnvelopeSchema.parse(unknownFacet)).toThrow();
  });
});

describe('provider catalog trust', () => {
  it('verifies exact signed bytes with an injected Ed25519 public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bytes = Buffer.from(JSON.stringify(createCatalog()), 'utf8');
    const signature = sign(null, bytes, privateKey);
    const keyring: CatalogKeyring = {
      'test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };

    const result = validateSignedCatalog({
      bytes,
      signature,
      keyId: 'test-key',
      keyring,
      appVersion: '0.1.0',
      now: new Date(NOW),
    });

    expect(result.catalog.catalogVersion).toBe(1);
    expect(result.bytes.equals(bytes)).toBe(true);
  });

  it('rejects altered bytes, unknown keys, incompatible app ranges, and untrusted driver/auth declarations', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyring: CatalogKeyring = {
      'test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    const bytes = Buffer.from(JSON.stringify(createCatalog()), 'utf8');
    const signature = sign(null, bytes, privateKey);

    const input = {
      bytes,
      signature,
      keyId: 'test-key',
      keyring,
      appVersion: '0.1.0',
      now: new Date(NOW),
    };

    expect(() => validateSignedCatalog({ ...input, bytes: Buffer.concat([bytes, Buffer.from(' ')]) }))
      .toThrow(CatalogTrustError);
    expect(() => validateSignedCatalog({ ...input, keyId: 'unknown-key' })).toThrow(/unknown/i);

    const incompatible = createCatalog();
    incompatible.compatibleApp.minimum = '9.0.0';
    const incompatibleBytes = Buffer.from(JSON.stringify(incompatible), 'utf8');
    expect(() => validateSignedCatalog({
      ...input,
      bytes: incompatibleBytes,
      signature: sign(null, incompatibleBytes, privateKey),
    })).toThrow(/requires app version/i);

    const unauthorized = createCatalog();
    unauthorized.providers[0].supportedAuthMethods = ['none'];
    const unauthorizedBytes = Buffer.from(JSON.stringify(unauthorized), 'utf8');
    expect(() => validateSignedCatalog({
      ...input,
      bytes: unauthorizedBytes,
      signature: sign(null, unauthorizedBytes, privateKey),
    })).toThrow(/auth/i);

    const wrongProtocol = createCatalog();
    wrongProtocol.providers[0].models[0].protocol = 'xai';
    const wrongProtocolBytes = Buffer.from(JSON.stringify(wrongProtocol), 'utf8');
    expect(() => validateSignedCatalog({
      ...input,
      bytes: wrongProtocolBytes,
      signature: sign(null, wrongProtocolBytes, privateKey),
    })).toThrow(/protocol/i);

    const executable = createCatalog() as unknown as { providers: Array<Record<string, unknown>> };
    executable.providers[0].driver = 'remote-module';
    executable.providers[0].endpoint = 'https://attacker.invalid';
    const executableBytes = Buffer.from(JSON.stringify(executable), 'utf8');
    expect(() => validateSignedCatalog({
      ...input,
      bytes: executableBytes,
      signature: sign(null, executableBytes, privateKey),
    })).toThrow(/schema/i);

    expect(() => validateSignedCatalog({
      ...input,
      bytes: Buffer.alloc(MAX_CATALOG_BYTES + 1),
    })).toThrow(/exceeds/i);

    const truncatedBytes = Buffer.from('{"schemaVersion":', 'utf8');
    expect(() => validateSignedCatalog({
      ...input,
      bytes: truncatedBytes,
      signature: sign(null, truncatedBytes, privateKey),
    })).toThrow(/JSON/i);
  });

  it('rejects a provider declaring a facet not pinned in the trusted policy list', () => {
    // xai pins no facets, so any tier declaration is untrusted there.
    const providerLevel = createCatalog();
    providerLevel.providers[0].id = 'xai';
    providerLevel.providers[0].supportedProtocols = ['xai'];
    providerLevel.providers[0].models[0].protocol = 'xai';
    providerLevel.providers[0].facets = {
      tiers: {
        kind: 'model-name-variants',
        tiers: [{ id: 'flex', modelIdSuffix: '-flex', requiresStreaming: true }],
      },
    };
    expect(() => validateCatalogBytes(
      Buffer.from(JSON.stringify(providerLevel), 'utf8'),
      { appVersion: '0.1.0', now: new Date(NOW) },
    )).toThrow(CatalogTrustError);
    expect(() => validateCatalogBytes(
      Buffer.from(JSON.stringify(providerLevel), 'utf8'),
      { appVersion: '0.1.0', now: new Date(NOW) },
    )).toThrow(/facet/i);

    const modelLevel = createCatalog();
    modelLevel.providers[0].id = 'xai';
    modelLevel.providers[0].supportedProtocols = ['xai'];
    modelLevel.providers[0].models[0].protocol = 'xai';
    modelLevel.providers[0].models[0].facets = {
      tiers: { kind: 'request-parameter', parameter: 'service_tier', tiers: [{ id: 'flex' }] },
    };
    expect(() => validateCatalogBytes(
      Buffer.from(JSON.stringify(modelLevel), 'utf8'),
      { appVersion: '0.1.0', now: new Date(NOW) },
    )).toThrow(/facet/i);
  });

  it('accepts facet declarations pinned in the trusted policy list', () => {
    const catalog = createCatalog();
    catalog.providers[0].facets = {
      thinking: {
        exposure: 'readable',
        replay: 'mandatory-in-tool-loop',
        knobs: {
          displayModes: ['summarized'],
          defaultDisplayMode: 'summarized',
          encryptedContentOption: true,
        },
      },
      cache: { mode: 'explicit', sessionKey: true, ttlOptions: [{ id: '5m' }, { id: '1h' }] },
    };
    catalog.providers[0].models[0].facets = {
      thinking: { exposure: 'opaque', replay: 'impossible' },
    };

    const result = validateCatalogBytes(
      Buffer.from(JSON.stringify(catalog), 'utf8'),
      { appVersion: '0.1.0', now: new Date(NOW) },
    );
    expect(result.catalog.providers[0].facets?.cache?.mode).toBe('explicit');
    expect(result.catalog.providers[0].models[0].facets?.thinking?.exposure).toBe('opaque');
  });

  it('treats the injected policy list as the facet gate', () => {
    // xai pins no facets in the default policy list; the injected list grants tiers.
    const catalog = createCatalog();
    catalog.providers[0].id = 'xai';
    catalog.providers[0].supportedProtocols = ['xai'];
    catalog.providers[0].models[0].protocol = 'xai';
    catalog.providers[0].facets = {
      tiers: { kind: 'request-parameter', parameter: 'service_tier', tiers: [{ id: 'flex' }] },
    };
    const bytes = Buffer.from(JSON.stringify(catalog), 'utf8');

    expect(() => validateCatalogBytes(bytes, {
      appVersion: '0.1.0',
      now: new Date(NOW),
    })).toThrow(/facet/i);

    const result = validateCatalogBytes(bytes, {
      appVersion: '0.1.0',
      now: new Date(NOW),
      policies: [{
        id: 'xai',
        authMethods: ['api-key'],
        protocols: ['xai'],
        allowsCustomModels: true,
        facets: ['tiers'],
      }],
    });
    expect(result.catalog.providers[0].facets?.tiers?.kind).toBe('request-parameter');
  });
});

export { createCatalog, NOW };
