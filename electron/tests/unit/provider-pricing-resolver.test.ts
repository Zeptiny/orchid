import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '../../src/shared/types/provider';
import type { ProviderModelRateCard } from '../../src/shared/types/provider-facets';
import type { CatalogPricing } from '../../src/main/providers/catalog/schema';
import type { DriverPricingFacet } from '../../src/main/providers/drivers/types';
import {
  resolveFrozenPricing,
  type PricingResolverInput,
} from '../../src/main/providers/facets/pricing';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const MODEL_ID = 'vendor/test-model';

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    providerId: 'test-provider',
    name: 'Test',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
    modelIds: [MODEL_ID],
    health: 'ready',
    ...overrides,
  };
}

function catalogPricing(overrides: Partial<CatalogPricing> = {}): CatalogPricing {
  return {
    currency: 'USD',
    effectiveAt: '2026-07-11T00:00:00.000Z',
    rates: {
      input: { amount: '3', per: 1_000_000, unit: 'tokens' },
      output: { amount: '9', per: 1_000_000, unit: 'tokens' },
      cacheRead: { amount: '0.3', per: 1_000_000, unit: 'tokens' },
    },
    provenance: { source: 'models.dev', observedAt: '2026-07-11T00:00:00.000Z' },
    ...overrides,
  };
}

function rateCard(overrides: Partial<ProviderModelRateCard> = {}): ProviderModelRateCard {
  return {
    modelId: MODEL_ID,
    currencyUnit: { kind: 'fiat', code: 'USD' },
    observedAt: '2026-07-12T11:55:00.000Z',
    rates: {
      input: { amount: '1', per: 1_000_000, unit: 'tokens' },
    },
    ...overrides,
  };
}

function dynamicFacet(): DriverPricingFacet {
  return {
    dynamic: {
      refreshIntervalSeconds: 300,
      fetchRates: () => Promise.resolve([]),
    },
  };
}

function resolve(input: Partial<PricingResolverInput>) {
  return resolveFrozenPricing({
    pricingFacet: undefined,
    connection: connection(),
    modelId: MODEL_ID,
    catalogPricing: catalogPricing(),
    dynamic: undefined,
    now: NOW,
    ...input,
  });
}

describe('pricing resolver ladder', () => {
  it('resolves provider API over user override over catalog, field by field', () => {
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      connection: connection({
        pricingOverrides: {
          [MODEL_ID]: {
            input: { amount: '2', per: 1_000_000, unit: 'tokens' },
            output: { amount: '8', per: 1_000_000, unit: 'tokens' },
          },
        },
      }),
      dynamic: { card: rateCard(), stale: false },
    });

    expect(snapshot?.rates.input).toMatchObject({
      amount: '1',
      provenance: { source: 'provider-api', observedAt: '2026-07-12T11:55:00.000Z' },
    });
    expect(snapshot?.rates.output).toMatchObject({
      amount: '8',
      provenance: { source: 'user', observedAt: null },
    });
    expect(snapshot?.rates.cacheRead).toMatchObject({
      amount: '0.3',
      provenance: { source: 'catalog', observedAt: '2026-07-11T00:00:00.000Z' },
    });
    expect(snapshot?.provenance).toMatchObject({ source: 'provider-api', user: true });
  });

  it('merges cache-write TTL variants key by key down the ladder', () => {
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      connection: connection({
        pricingOverrides: {
          [MODEL_ID]: {
            cacheWriteByTtl: {
              '5m': { amount: '2', per: 1_000_000, unit: 'tokens' },
              '1h': { amount: '4', per: 1_000_000, unit: 'tokens' },
            },
          },
        },
      }),
      catalogPricing: catalogPricing({
        rates: {
          input: { amount: '3', per: 1_000_000, unit: 'tokens' },
          cacheWriteByTtl: { '1h': { amount: '5', per: 1_000_000, unit: 'tokens' } },
        },
      }),
      dynamic: {
        card: rateCard({
          rates: {
            input: { amount: '1', per: 1_000_000, unit: 'tokens' },
            cacheWriteByTtl: { '5m': { amount: '1.5', per: 1_000_000, unit: 'tokens' } },
          },
        }),
        stale: false,
      },
    });

    expect(snapshot?.rates.cacheWriteByTtl).toEqual({
      '5m': { amount: '1.5', per: 1_000_000, unit: 'tokens', provenance: { source: 'provider-api', observedAt: '2026-07-12T11:55:00.000Z' } },
      '1h': { amount: '4', per: 1_000_000, unit: 'tokens', provenance: { source: 'user', observedAt: null } },
    });
  });

  it('adopts context tiers wholesale from the highest rung that declares them', () => {
    const tierRates = {
      input: { amount: '6', per: 1_000_000, unit: 'tokens' as const },
    };
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      catalogPricing: catalogPricing({
        contextTiers: [{ overContextTokens: 100_000, rates: tierRates }],
      }),
      dynamic: {
        card: rateCard({
          contextTiers: [{
            overContextTokens: 200_000,
            rates: { input: { amount: '2.5', per: 1_000_000, unit: 'tokens' } },
          }],
        }),
        stale: false,
      },
    });

    expect(snapshot?.contextTiers).toHaveLength(1);
    expect(snapshot?.contextTiers?.[0]).toMatchObject({
      overContextTokens: 200_000,
      rates: { input: { amount: '2.5', provenance: { source: 'provider-api' } } },
    });

    const catalogOnly = resolve({
      catalogPricing: catalogPricing({
        contextTiers: [{ overContextTokens: 100_000, rates: tierRates }],
      }),
    });
    expect(catalogOnly?.contextTiers?.[0]).toMatchObject({
      overContextTokens: 100_000,
      rates: { input: { amount: '6', provenance: { source: 'catalog' } } },
    });
  });

  it('freezes a user-only rung with the driver-declared native currency unit', () => {
    const snapshot = resolve({
      pricingFacet: { currencyUnit: { kind: 'non-fiat', unit: 'kWh' } },
      connection: connection({
        pricingOverrides: {
          [MODEL_ID]: { energy: { amount: '0.5', per: 1, unit: 'energy' } },
        },
      }),
      catalogPricing: undefined,
    });

    expect(snapshot).toMatchObject({
      currency: 'kWh',
      currencyUnit: { kind: 'non-fiat', unit: 'kWh' },
      effectiveAt: NOW.toISOString(),
      rates: { energy: { amount: '0.5', provenance: { source: 'user', observedAt: null } } },
      provenance: { source: 'user', user: true },
    });
  });

  it('returns null when no rung has rates or the billing unit is unknowable', () => {
    expect(resolve({
      connection: connection(),
      catalogPricing: undefined,
    })).toBeNull();
    // User rates without any declared currency cannot produce a formula.
    expect(resolve({
      connection: connection({
        pricingOverrides: { [MODEL_ID]: { input: { amount: '2', per: 1_000_000, unit: 'tokens' } } },
      }),
      catalogPricing: undefined,
    })).toBeNull();
  });

  it('marks latest-known provider rates stale after a failed refresh', () => {
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      dynamic: { card: rateCard(), stale: true, error: 'HTTP 503' },
    });

    expect(snapshot?.rates.input?.provenance).toEqual({
      source: 'provider-api',
      observedAt: '2026-07-12T11:55:00.000Z',
      stale: true,
    });
    expect(snapshot?.provenance).toMatchObject({
      source: 'provider-api',
      dynamic: { state: 'stale', observedAt: '2026-07-12T11:55:00.000Z', error: 'HTTP 503' },
    });
  });

  it('falls back down the ladder with provenance when the pricing endpoint is unreachable', () => {
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      connection: connection({
        pricingOverrides: {
          [MODEL_ID]: { input: { amount: '2', per: 1_000_000, unit: 'tokens' } },
        },
      }),
      dynamic: { card: undefined, stale: false, error: 'connect ECONNREFUSED' },
    });

    expect(snapshot?.rates.input?.provenance).toEqual({ source: 'user', observedAt: null });
    expect(snapshot?.rates.output?.provenance).toMatchObject({ source: 'catalog' });
    expect(snapshot?.provenance).toMatchObject({
      source: 'user',
      user: true,
      dynamic: { state: 'unavailable', error: 'connect ECONNREFUSED' },
    });
  });

  it('ignores provider cards that carry no rate fields', () => {
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      dynamic: { card: rateCard({ rates: {} }), stale: false },
    });

    expect(snapshot?.rates.input?.provenance).toMatchObject({ source: 'catalog' });
    expect(snapshot?.provenance).toMatchObject({
      source: 'catalog',
      dynamic: { state: 'unavailable' },
    });
  });

  it('surfaces driver rate-adjustment evidence and derives inclusion semantics', () => {
    const snapshot = resolve({
      pricingFacet: dynamicFacet(),
      dynamic: {
        card: rateCard({
          rates: {
            input: { amount: '0.175', per: 1_000_000, unit: 'tokens' },
            cacheWrite: { amount: '1.25', per: 1_000_000, unit: 'tokens' },
            reasoning: { amount: '3', per: 1_000_000, unit: 'tokens' },
          },
          adjustment: {
            kind: 'subscription-multiplier',
            multiplier: '0.25',
            discountPercent: 75,
            supplyUpdatedAt: '2026-07-12T11:59:00.000Z',
          },
        }),
        stale: false,
      },
    });

    expect(snapshot?.effectiveAt).toBe('2026-07-12T11:55:00.000Z');
    expect(snapshot?.inclusion).toEqual({
      cacheRead: 'subset-of-input',
      cacheWrite: 'additional',
      reasoning: 'subset-of-output',
    });
    expect(snapshot?.provenance).toMatchObject({
      dynamic: {
        state: 'fresh',
        adjustment: { kind: 'subscription-multiplier', multiplier: '0.25', discountPercent: 75 },
      },
    });
  });

  it('freezes the catalog rung last with its signed provenance when nothing else prices', () => {
    const snapshot = resolve({});

    expect(snapshot).toMatchObject({
      currency: 'USD',
      effectiveAt: '2026-07-11T00:00:00.000Z',
      provenance: {
        source: 'catalog',
        signedCatalog: { source: 'models.dev' },
      },
    });
    expect(snapshot?.provenance.dynamic).toBeUndefined();
    expect(snapshot?.provenance.user).toBeUndefined();
  });

  it('keys the user-override rung off the base model id for variant-tier requests (R22)', () => {
    const snapshot = resolve({
      connection: connection({
        pricingOverrides: {
          [MODEL_ID]: {
            input: { amount: '2', per: 1_000_000, unit: 'tokens' },
            output: { amount: '8', per: 1_000_000, unit: 'tokens' },
          },
        },
      }),
      modelId: `${MODEL_ID}-flex`,
      userOverrideModelId: MODEL_ID,
      catalogPricing: catalogPricing({
        rates: {
          input: { amount: '3', per: 1_000_000, unit: 'tokens' },
          output: { amount: '9', per: 1_000_000, unit: 'tokens' },
          cacheRead: { amount: '0.3', per: 1_000_000, unit: 'tokens' },
        },
      }),
    });

    expect(snapshot?.rates.input).toMatchObject({
      amount: '2',
      provenance: { source: 'user', observedAt: null },
    });
    expect(snapshot?.rates.output).toMatchObject({
      amount: '8',
      provenance: { source: 'user', observedAt: null },
    });
    expect(snapshot?.rates.cacheRead).toMatchObject({
      amount: '0.3',
      provenance: { source: 'catalog', observedAt: '2026-07-11T00:00:00.000Z' },
    });
    expect(snapshot?.provenance).toMatchObject({ source: 'user', user: true });
  });

  it('feeds live-discovered inline pricing into the top provider-api rung (R27)', () => {
    const snapshot = resolve({
      connection: connection({
        pricingOverrides: {
          [MODEL_ID]: {
            input: { amount: '2', per: 1_000_000, unit: 'tokens' },
            output: { amount: '8', per: 1_000_000, unit: 'tokens' },
          },
        },
      }),
      catalogPricing: catalogPricing({
        rates: {
          input: { amount: '3', per: 1_000_000, unit: 'tokens' },
          output: { amount: '9', per: 1_000_000, unit: 'tokens' },
        },
      }),
      discovered: {
        pricing: rateCard({
          rates: {
            input: { amount: '1', per: 1_000_000, unit: 'tokens' },
            output: { amount: '4', per: 1_000_000, unit: 'tokens' },
          },
        }),
        discoveredAt: '2026-07-12T11:50:00.000Z',
      },
    });

    expect(snapshot?.rates.input).toMatchObject({
      amount: '1',
      provenance: { source: 'provider-api', observedAt: '2026-07-12T11:50:00.000Z' },
    });
    expect(snapshot?.rates.output).toMatchObject({
      amount: '4',
      provenance: { source: 'provider-api', observedAt: '2026-07-12T11:50:00.000Z' },
    });
    expect(snapshot?.provenance).toMatchObject({
      source: 'provider-api',
      discovered: { observedAt: '2026-07-12T11:50:00.000Z' },
    });
    expect(snapshot?.provenance.user).toBeUndefined();
  });
});
