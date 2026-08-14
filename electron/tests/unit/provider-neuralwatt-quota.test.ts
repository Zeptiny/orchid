import { describe, expect, it } from 'vitest';
import {
  quotaFromNeuralwattObservation,
  neuralwattQuotaFacet,
} from '../../src/main/providers/drivers/neuralwatt-quota';
import type { ProviderStatusObservation } from '../../src/main/providers/status/cache';
import { createNeuralwattProviderDriver } from '../../src/main/providers/drivers/neuralwatt';

function observation(data: Record<string, unknown>): ProviderStatusObservation {
  return {
    providerId: 'neuralwatt',
    connectionId: 'conn-1',
    observedAt: '2026-07-12T12:00:00.000Z',
    providerUpdatedAt: '2026-07-12T11:59:00.000Z',
    availability: 'available',
    stale: false,
    data,
  };
}

describe('quotaFromNeuralwattObservation', () => {
  it('maps documented balance, subscription, and kWh allowance into native units', () => {
    const quota = quotaFromNeuralwattObservation(observation({
      accountingMethod: 'energy',
      creditsRemainingUsd: 12.5,
      creditsUsedUsd: 3.25,
      overageLimitUsd: 50,
      subscription: {
        plan: 'Pro',
        status: 'active',
        currentPeriodEnd: '2026-08-01T00:00:00.000Z',
        kwhIncluded: 200,
        kwhUsed: 40,
        kwhRemaining: 160,
        inOverage: false,
      },
    }));

    expect(quota.observedAt).toBe('2026-07-12T11:59:00.000Z');
    expect(quota.balances).toEqual([
      { label: 'Credits remaining', amount: '12.5', unit: 'USD' },
      { label: 'Credits used', amount: '3.25', unit: 'USD' },
      { label: 'Overage limit', amount: '50', unit: 'USD' },
      { label: 'Subscription energy included', amount: '200', unit: 'kWh' },
      { label: 'Subscription energy remaining', amount: '160', unit: 'kWh' },
    ]);
    expect(quota.subscription).toEqual({
      state: 'active',
      displayName: 'Pro',
      renewsAt: '2026-08-01T00:00:00.000Z',
    });
    expect(quota.allowances).toEqual([{ label: 'API key', state: 'available' }]);
  });

  it('marks the key allowance blocked when the subscription is past-due (AE6 surfaces it as data)', () => {
    const quota = quotaFromNeuralwattObservation(observation({
      subscription: { plan: 'Pro', status: 'past-due', currentPeriodEnd: null, inOverage: false },
    }));
    expect(quota.subscription?.state).toBe('past-due');
    expect(quota.allowances[0]?.state).toBe('blocked');
  });

  it('marks the key allowance limited while in overage', () => {
    const quota = quotaFromNeuralwattObservation(observation({
      subscription: { plan: 'Pro', status: 'active', currentPeriodEnd: null, inOverage: true },
    }));
    expect(quota.allowances[0]?.state).toBe('limited');
  });

  it('reports an unknown allowance when no subscription block is published', () => {
    const quota = quotaFromNeuralwattObservation(observation({ accountingMethod: 'token' }));
    expect(quota.subscription).toBeNull();
    expect(quota.allowances).toEqual([{ label: 'API key', state: 'unknown' }]);
  });

  it('omits absent balances instead of fabricating zeroes', () => {
    const quota = quotaFromNeuralwattObservation(observation({ accountingMethod: 'energy' }));
    expect(quota.balances).toEqual([]);
  });
});

describe('neuralwattQuotaFacet', () => {
  it('wires a fetchQuota hook onto the driver (additive, informational only)', () => {
    const driver = createNeuralwattProviderDriver();
    expect(driver.quotaFacet).toBeDefined();
    expect(typeof driver.quotaFacet?.fetchQuota).toBe('function');
  });

  it('rejects a quota fetch without an API key credential', async () => {
    const facet = neuralwattQuotaFacet();
    await expect(facet.fetchQuota({
      connection: {
        id: 'conn-1',
        providerId: 'neuralwatt',
        name: 'NW',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        credential: { kind: 'none' },
        modelIds: [],
        health: 'ready',
      },
      provider: {
        id: 'neuralwatt',
        displayName: 'Neuralwatt',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: false,
        models: [],
      },
      credential: { kind: 'none' },
    })).rejects.toThrowError(/API key/);
  });
});
