import { describe, expect, it, vi } from 'vitest';
import {
  quotaFromLilacObservation,
  fetchLilacQuota,
  createLilacProviderDriver,
  type LilacStatusData,
} from '../../src/main/providers/drivers/lilac';
import type { ProviderStatusObservation } from '../../src/main/providers/status/cache';

function lilacObservation(models: LilacStatusData['models']): ProviderStatusObservation {
  const data: LilacStatusData = {
    window: '5m',
    windowSeconds: 300,
    subscriptionSupplyUpdatedAt: '2026-07-12T11:59:00.000Z',
    models,
  };
  return {
    providerId: 'lilac',
    observedAt: '2026-07-12T12:00:00.000Z',
    providerUpdatedAt: '2026-07-12T12:00:00.000Z',
    availability: 'available',
    stale: false,
    data,
  };
}

function modelWithSupply(
  modelId: string,
  supply: { availability: 'available' | 'unavailable'; supplyState: 'low' | 'medium' | 'high' | 'surplus' | null; discountPercent: number | null; creditMultiplier: number | null },
) {
  return {
    modelId,
    name: modelId,
    tokensPerSecond: 100,
    timeToFirstTokenSeconds: 0.4,
    uptimePercent: 99.9,
    subscription: supply,
  };
}

const QUOTA_REQUEST = {
  connection: {
    id: 'conn-1',
    providerId: 'lilac',
    name: 'Lilac',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: 'h' },
    modelIds: [],
    health: 'ready',
  },
  provider: {
    id: 'lilac',
    displayName: 'Lilac',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: false,
    models: [],
  },
  credential: { kind: 'api-key', apiKey: 'key' },
} as const;

describe('quotaFromLilacObservation', () => {
  it('keeps balances empty and subscription null (no documented endpoint) while mapping supply allowances', () => {
    const quota = quotaFromLilacObservation(lilacObservation([
      modelWithSupply('moonshotai/kimi-k2.6', {
        availability: 'available',
        supplyState: 'surplus',
        discountPercent: 75,
        creditMultiplier: 0.25,
      }),
    ]));

    // Lilac gap: no documented balance/account-subscription fields.
    expect(quota.balances).toEqual([]);
    expect(quota.subscription).toBeNull();
    expect(quota.allowances).toEqual([{
      label: 'moonshotai/kimi-k2.6',
      state: 'available',
      detail: 'Supply: surplus · Discount: 75% · Credit multiplier: 0.25',
    }]);
  });

  it('omits models whose supply data is unavailable rather than inferring state', () => {
    const quota = quotaFromLilacObservation(lilacObservation([
      modelWithSupply('moonshotai/kimi-k2.6', {
        availability: 'unavailable',
        supplyState: null,
        discountPercent: null,
        creditMultiplier: null,
      }),
    ]));
    expect(quota.allowances).toEqual([]);
  });
});

describe('fetchLilacQuota', () => {
  it('fetches typed quota from the public status endpoint without a credential', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      updated_at: '2026-07-12T12:00:00.000Z',
      window: '5m',
      window_secs: 300,
      stale: false,
      current_subscription_supply_updated_at: '2026-07-12T11:59:00.000Z',
      models: [{
        id: 'moonshotai/kimi-k2.6',
        current_subscription_supply_state: 'high',
        current_subscription_discount_percent: 50,
        current_subscription_credit_multiplier: 0.5,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const quota = await fetchLilacQuota(QUOTA_REQUEST, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => new Date('2026-07-12T12:01:00.000Z'),
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.getlilac.com/status?window=5m',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(quota.balances).toEqual([]);
    expect(quota.allowances[0]).toMatchObject({ state: 'available' });
  });

  it('throws when the status observation is stale so the caller degrades to stale status', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      updated_at: '2026-07-12T11:00:00.000Z',
      stale: true,
      models: [],
    }), { status: 200 }));

    await expect(fetchLilacQuota(QUOTA_REQUEST, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => new Date('2026-07-12T12:01:00.000Z'),
    })).rejects.toThrowError(/stale/);
  });
});

describe('lilac driver quota facet', () => {
  it('declares a quotaFacet hook (supply-mapped, performance-only gap documented)', () => {
    const driver = createLilacProviderDriver();
    expect(driver.quotaFacet).toBeDefined();
    expect(typeof driver.quotaFacet?.fetchQuota).toBe('function');
  });
});
