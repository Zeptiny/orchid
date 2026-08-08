import { describe, expect, it, vi } from 'vitest';
import type { ProviderModelRateCard } from '../../src/shared/types/provider-facets';
import type {
  DriverModelRequest,
  ProviderDriver,
} from '../../src/main/providers/drivers/types';
import {
  PricingRefresher,
  type PricingRefreshTarget,
} from '../../src/main/providers/facets/pricing-refresh';

const PROVIDER_ID = 'test-provider';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const MODEL_ID = 'vendor/test-model';

let now = new Date('2026-07-12T12:00:00.000Z');

function card(multiplier: string): ProviderModelRateCard {
  return {
    modelId: MODEL_ID,
    currencyUnit: { kind: 'fiat', code: 'USD' },
    observedAt: now.toISOString(),
    rates: { input: { amount: multiplier, per: 1_000_000, unit: 'tokens' } },
  };
}

function driver(fetchRates: () => Promise<readonly ProviderModelRateCard[]>): ProviderDriver {
  return {
    id: PROVIDER_ID,
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomEndpoint: false,
    origin: 'https://example.test',
    createLanguageModel: () => Promise.reject(new Error('not exercised')),
    pricingFacet: { dynamic: { refreshIntervalSeconds: 300, fetchRates } },
  };
}

function target(fetchRates: () => Promise<readonly ProviderModelRateCard[]>): PricingRefreshTarget {
  return {
    driver: driver(fetchRates),
    request: {
      connection: {
        id: CONNECTION_ID,
        providerId: PROVIDER_ID,
        name: 'Test',
        protocol: 'openai-compatible',
        authMethod: 'api-key',
        credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
        modelIds: [MODEL_ID],
        health: 'ready',
      },
      provider: {
        id: PROVIDER_ID,
        displayName: 'Test',
        supportedAuthMethods: ['api-key'],
        supportedProtocols: ['openai-compatible'],
        allowsCustomModels: false,
        models: [],
      },
      model: { id: MODEL_ID, displayName: MODEL_ID, protocol: 'openai-compatible', source: 'catalog' },
      credential: { kind: 'api-key', apiKey: 'test-key' },
    } satisfies DriverModelRequest,
    fetchContext: () => ({}),
  };
}

describe('PricingRefresher', () => {
  it('caches fetched rate cards as fresh latest-known state', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    const fetchRates = vi.fn(async () => [card('1')]);
    const refreshTarget = target(fetchRates);

    await refresher.refresh(refreshTarget);
    const state = refresher.stateFor(PROVIDER_ID, CONNECTION_ID, MODEL_ID, 300);
    expect(state.stale).toBe(false);
    expect(state.card?.rates.input?.amount).toBe('1');
    expect(state.error).toBeUndefined();
  });

  it('refreshes in the background only when the declared cadence has elapsed', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    const fetchRates = vi.fn(async () => [card('1')]);
    const refreshTarget = target(fetchRates);

    refresher.ensureFresh(refreshTarget);
    await refresher.settled();
    refresher.ensureFresh(refreshTarget);
    await refresher.settled();
    expect(fetchRates).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 299_000);
    refresher.ensureFresh(refreshTarget);
    await refresher.settled();
    expect(fetchRates).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 2_000);
    refresher.ensureFresh(refreshTarget);
    await refresher.settled();
    expect(fetchRates).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into one provider request', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    let release!: (cards: ProviderModelRateCard[]) => void;
    const fetchRates = vi.fn(() => new Promise<readonly ProviderModelRateCard[]>((resolvePromise) => {
      release = resolvePromise;
    }));
    const refreshTarget = target(fetchRates);

    const first = refresher.refresh(refreshTarget);
    const second = refresher.refresh(refreshTarget);
    release([card('1')]);
    await Promise.all([first, second]);
    expect(fetchRates).toHaveBeenCalledTimes(1);
  });

  it('keeps last-known cards marked stale when a refresh fails', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    const fetchRates = vi.fn()
      .mockResolvedValueOnce([card('0.25')])
      .mockRejectedValueOnce(new Error('HTTP 503'));
    const refreshTarget = target(fetchRates as () => Promise<readonly ProviderModelRateCard[]>);

    await refresher.refresh(refreshTarget);
    now = new Date(now.getTime() + 301_000);
    await refresher.refresh(refreshTarget);

    const state = refresher.stateFor(PROVIDER_ID, CONNECTION_ID, MODEL_ID, 300);
    expect(state.card?.rates.input?.amount).toBe('0.25');
    expect(state.stale).toBe(true);
    expect(state.error).toBe('HTTP 503');
  });

  it('serves no provider rung while the endpoint has never been reachable', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    const refreshTarget = target(() => Promise.reject(new Error('connect ECONNREFUSED')));

    await expect(refresher.refresh(refreshTarget)).resolves.toMatchObject({
      cards: [],
      fetchedAt: null,
      error: 'connect ECONNREFUSED',
    });
    const state = refresher.stateFor(PROVIDER_ID, CONNECTION_ID, MODEL_ID, 300);
    expect(state.card).toBeUndefined();
    expect(state.error).toBe('connect ECONNREFUSED');
  });

  it('redacts credential material from refresh failure details', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    const refreshTarget = target(() => Promise.reject(new Error('request failed: Bearer sk-live-abcdefgh12345678')));

    const entry = await refresher.refresh(refreshTarget);
    expect(entry.error).not.toContain('sk-live-abcdefgh12345678');
    expect(entry.error).toContain('[REDACTED]');
  });

  it('forgets latest-known rates for one connection on invalidate', async () => {
    now = new Date('2026-07-12T12:00:00.000Z');
    const refresher = new PricingRefresher({ now: () => now });
    await refresher.refresh(target(() => Promise.resolve([card('1')])));

    refresher.invalidate(PROVIDER_ID, CONNECTION_ID);
    expect(refresher.stateFor(PROVIDER_ID, CONNECTION_ID, MODEL_ID, 300).card).toBeUndefined();
  });
});
