import { describe, expect, it } from 'vitest';
import type { FrozenProviderRequestSnapshot } from '../../src/shared/types/accounting';
import { calculateAttemptCost } from '../../src/main/providers/accounting/cost';

function snapshot(overrides: Partial<FrozenProviderRequestSnapshot> = {}): FrozenProviderRequestSnapshot {
  return {
    providerId: 'anthropic',
    providerDisplayName: 'Anthropic',
    connectionId: '11111111-1111-4111-8111-111111111111',
    connectionName: 'Work',
    modelId: 'claude-test',
    protocol: 'anthropic-messages',
    modelSource: 'catalog',
    catalogVersion: 1,
    catalogSource: 'bundled',
    catalogObservedAt: '2026-07-12T00:00:00.000Z',
    fieldProvenance: {},
    statusObservation: null,
    pricing: {
      currency: 'USD',
      effectiveAt: '2026-07-12T00:00:00.000Z',
      rates: {
        input: { amount: '5', per: 1_000_000, unit: 'tokens' },
        output: { amount: '25', per: 1_000_000, unit: 'tokens' },
        cacheRead: { amount: '0.5', per: 1_000_000, unit: 'tokens' },
        cacheWrite: { amount: '6.25', per: 1_000_000, unit: 'tokens' },
      },
      inclusion: {
        cacheRead: 'subset-of-input',
        cacheWrite: 'additional',
        reasoning: 'subset-of-output',
      },
      provenance: { source: 'catalog' },
    },
    ...overrides,
  };
}

describe('provider cost calculation', () => {
  it('calculates independent Anthropic input, output, cache-read, and cache-write dimensions exactly', () => {
    expect(calculateAttemptCost({
      snapshot: snapshot(),
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 10,
      },
      evidence: {},
    })).toEqual({
      state: 'calculated',
      source: 'token-formula',
      currency: 'USD',
      amount: '0.0096125',
    });
  });

  it('gives a provider-reported monetary charge precedence over any frozen formula', () => {
    expect(calculateAttemptCost({
      snapshot: snapshot(),
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      evidence: { reportedCostAmount: '0.000001', reportedCurrency: 'USD' },
    })).toEqual({
      state: 'reported',
      source: 'provider-reported',
      currency: 'USD',
      amount: '0.000001',
    });
  });

  it('gives a reported cost precedence over every pricing ladder rung', () => {
    const rungSnapshot = snapshot({
      pricing: {
        ...snapshot().pricing!,
        rates: {
          input: {
            amount: '1', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'provider-api', observedAt: '2026-07-12T12:00:00.000Z' },
          },
          output: {
            amount: '2', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'user', observedAt: null },
          },
        },
      },
    });
    expect(calculateAttemptCost({
      snapshot: rungSnapshot,
      usage: { inputTokens: 1000, outputTokens: 100 },
      evidence: { reportedCostAmount: '0.5', reportedCurrency: 'USD' },
    })).toEqual({
      state: 'reported',
      source: 'provider-reported',
      currency: 'USD',
      amount: '0.5',
    });
  });

  it('calculates Neuralwatt only from complete authoritative charged-energy evidence', () => {
    const energySnapshot = snapshot({
      providerId: 'neuralwatt',
      pricing: {
        currency: 'USD',
        effectiveAt: '2026-07-12T00:00:00.000Z',
        rates: { energy: { amount: '5', per: 1, unit: 'energy' } },
        inclusion: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown' },
        provenance: { source: 'provider' },
      },
    });
    expect(calculateAttemptCost({
      snapshot: energySnapshot,
      usage: {
        energyKwhConsumed: '0.02',
        energyKwhCharged: '0.013',
        pricingMultiplier: '0.65',
      },
      evidence: { accountingMethod: 'energy', energyRateUsdPerKwh: '5', currency: 'USD' },
    })).toEqual({
      state: 'calculated',
      source: 'energy-formula',
      currency: 'USD',
      amount: '0.065',
      rateRung: 'provider-api',
    });
  });

  it('computes native kWh cost from the frozen energy rate and retains unit provenance', () => {
    const kwhSnapshot = snapshot({
      providerId: 'neuralwatt',
      pricing: {
        currency: 'kWh',
        currencyUnit: { kind: 'non-fiat', unit: 'kWh', displayName: 'kilowatt-hour' },
        effectiveAt: '2026-07-12T00:00:00.000Z',
        rates: {
          energy: {
            amount: '1.5', per: 1, unit: 'energy',
            provenance: { source: 'catalog', observedAt: '2026-07-12T00:00:00.000Z' },
          },
        },
        inclusion: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown' },
        provenance: { source: 'catalog' },
      },
    });
    expect(calculateAttemptCost({
      snapshot: kwhSnapshot,
      usage: {
        energyKwhConsumed: '0.02',
        energyKwhCharged: '0.013',
        pricingMultiplier: '0.65',
      },
      evidence: { accountingMethod: 'energy', currency: 'kWh' },
    })).toEqual({
      state: 'calculated',
      source: 'energy-formula',
      currency: 'kWh',
      amount: '0.0195',
      rateRung: 'catalog',
    });
  });

  it('accepts a provider-reported charge denominated in the declared native unit', () => {
    const kwhSnapshot = snapshot({
      pricing: {
        ...snapshot().pricing!,
        currency: 'kWh',
        currencyUnit: { kind: 'non-fiat', unit: 'kWh' },
      },
    });
    expect(calculateAttemptCost({
      snapshot: kwhSnapshot,
      usage: { inputTokens: 10, outputTokens: 5 },
      evidence: { reportedCostAmount: '0.004', reportedCurrency: 'kWh' },
    })).toEqual({
      state: 'reported',
      source: 'provider-reported',
      currency: 'kWh',
      amount: '0.004',
    });
  });

  it('applies a frozen per-request fee once per attempt', () => {
    const feeSnapshot = snapshot({
      pricing: {
        ...snapshot().pricing!,
        rates: {
          input: { amount: '5', per: 1_000_000, unit: 'tokens' },
          output: { amount: '25', per: 1_000_000, unit: 'tokens' },
          perRequest: { amount: '0.01', per: 1, unit: 'requests' },
        },
      },
    });
    expect(calculateAttemptCost({
      snapshot: feeSnapshot,
      usage: { inputTokens: 1000, outputTokens: 200 },
      evidence: {},
    })).toEqual({
      state: 'calculated',
      source: 'token-formula',
      currency: 'USD',
      amount: '0.02',
    });
  });

  it('applies context-tier rates only once the input exceeds the tier threshold', () => {
    const tiered = snapshot({
      pricing: {
        ...snapshot().pricing!,
        rates: {
          input: { amount: '5', per: 1_000_000, unit: 'tokens' },
          output: { amount: '25', per: 1_000_000, unit: 'tokens' },
        },
        contextTiers: [{
          overContextTokens: 100_000,
          rates: {
            input: { amount: '10', per: 1_000_000, unit: 'tokens' },
            output: { amount: '50', per: 1_000_000, unit: 'tokens' },
          },
        }],
      },
    });
    expect(calculateAttemptCost({
      snapshot: tiered,
      usage: { inputTokens: 200_000, outputTokens: 100 },
      evidence: {},
    })).toMatchObject({ amount: '2.005' });
    expect(calculateAttemptCost({
      snapshot: tiered,
      usage: { inputTokens: 100_000, outputTokens: 100 },
      evidence: {},
    })).toMatchObject({ amount: '0.5025' });
  });

  it('reports the highest contributing ladder rung and staleness on calculated costs', () => {
    const mixed = snapshot({
      pricing: {
        ...snapshot().pricing!,
        rates: {
          input: {
            amount: '5', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'provider-api', observedAt: '2026-07-12T11:00:00.000Z', stale: true },
          },
          output: {
            amount: '25', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'catalog', observedAt: '2026-07-11T00:00:00.000Z' },
          },
        },
      },
    });
    expect(calculateAttemptCost({
      snapshot: mixed,
      usage: { inputTokens: 1000, outputTokens: 100 },
      evidence: {},
    })).toEqual({
      state: 'calculated',
      source: 'token-formula',
      currency: 'USD',
      amount: '0.0075',
      rateRung: 'provider-api',
      rateRungStale: true,
    });

    const userOnly = snapshot({
      pricing: {
        ...snapshot().pricing!,
        rates: {
          input: {
            amount: '5', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'user', observedAt: null },
          },
          output: {
            amount: '25', per: 1_000_000, unit: 'tokens',
            provenance: { source: 'catalog', observedAt: '2026-07-11T00:00:00.000Z' },
          },
        },
      },
    });
    expect(calculateAttemptCost({
      snapshot: userOnly,
      usage: { inputTokens: 1000, outputTokens: 100 },
      evidence: {},
    })).toEqual({
      state: 'calculated',
      source: 'token-formula',
      currency: 'USD',
      amount: '0.0075',
      rateRung: 'user',
    });
  });

  it('records unknown instead of inventing energy/token cost when authoritative inputs are incomplete or ambiguous', () => {
    expect(calculateAttemptCost({
      snapshot: snapshot({
        pricing: {
          ...snapshot().pricing!,
          inclusion: { cacheRead: 'subset-of-input', cacheWrite: 'unknown', reasoning: 'subset-of-output' },
        },
      }),
      usage: { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 5 },
      evidence: {},
    })).toMatchObject({ state: 'unknown', source: 'unknown' });

    expect(calculateAttemptCost({
      snapshot: snapshot({ providerId: 'neuralwatt' }),
      usage: { energyKwhCharged: '0.013', pricingMultiplier: '0.65' },
      evidence: { accountingMethod: 'energy', energyRateUsdPerKwh: '5', currency: 'USD' },
    })).toMatchObject({ state: 'unknown', source: 'unknown' });
  });

  it('refuses to bill base rates for a request-parameter tier without tier-aware rates (R22)', () => {
    const tiered = snapshot({
      tier: { mechanism: 'request-parameter', requestedTier: 'flex' },
    });
    expect(calculateAttemptCost({
      snapshot: tiered,
      usage: { inputTokens: 1000, outputTokens: 100 },
      evidence: {},
    })).toEqual({
      state: 'unknown',
      source: 'unknown',
      reason: "Service tier 'flex' was requested but tier-aware rates are not frozen for this attempt",
    });
  });

  it('gives a provider-reported charge precedence over the request-parameter tier guard', () => {
    const tiered = snapshot({
      tier: { mechanism: 'request-parameter', requestedTier: 'flex' },
    });
    expect(calculateAttemptCost({
      snapshot: tiered,
      usage: { inputTokens: 1000, outputTokens: 100 },
      evidence: { reportedCostAmount: '0.25', reportedCurrency: 'USD' },
    })).toEqual({
      state: 'reported',
      source: 'provider-reported',
      currency: 'USD',
      amount: '0.25',
    });
  });

  it('keeps billing model-name-variant tiers from the frozen served variant rates', () => {
    const tiered = snapshot({
      modelId: 'glm-5.2-flex',
      tier: {
        mechanism: 'model-name-variants',
        requestedTier: 'flex',
        servedModelId: 'glm-5.2-flex',
        baseModelId: 'glm-5.2',
      },
    });
    expect(calculateAttemptCost({
      snapshot: tiered,
      usage: { inputTokens: 1000, outputTokens: 100 },
      evidence: {},
    })).toMatchObject({
      state: 'calculated',
      source: 'token-formula',
      currency: 'USD',
      amount: '0.0075',
    });
  });
});
