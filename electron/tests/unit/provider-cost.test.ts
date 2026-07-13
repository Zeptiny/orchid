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
});
