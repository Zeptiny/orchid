import { describe, expect, it, vi } from 'vitest';
import { fetchLilacStatus } from '../../src/main/providers/drivers/lilac';
import {
  createNeuralwattStatusSource,
  fetchNeuralwattQuotaStatus,
} from '../../src/main/providers/drivers/neuralwatt';
import { ProviderStatusCache } from '../../src/main/providers/status/cache';
import { ProviderStatusService, type ProviderStatusSource } from '../../src/main/providers/status/service';

describe('provider status contracts', () => {
  it.each([
    ['Lilac', (fetch: typeof globalThis.fetch) => fetchLilacStatus({ fetch, timeoutMs: 5 })],
    ['Neuralwatt', (fetch: typeof globalThis.fetch) => fetchNeuralwattQuotaStatus({
      apiKey: 'test-key', fetch, timeoutMs: 5,
    })],
  ])('aborts %s status requests when the request deadline expires', async (_name, request) => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('missing abort signal'));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as unknown as typeof globalThis.fetch;

    await expect(request(fetch)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('uses Lilac’s public five-minute status contract and keeps status informational', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      updated_at: '2026-07-12T12:00:00.000Z',
      window: '5m',
      window_secs: 300,
      stale: false,
      current_subscription_supply_updated_at: '2026-07-12T11:59:00.000Z',
      models: [{
        id: 'moonshotai/kimi-k2.6',
        name: 'Kimi K2.6',
        tps: 142.7,
        ttfb_seconds: 0.41,
        uptime_pct: 99.8,
        current_subscription_supply_state: 'surplus',
        current_subscription_discount_percent: 75,
        current_subscription_credit_multiplier: 0.25,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const source: ProviderStatusSource = {
      providerId: 'lilac',
      ttlMs: 5 * 60_000,
      minimumManualRefreshMs: 30_000,
      fetchStatus: () => fetchLilacStatus({ fetch, now: () => new Date('2026-07-12T12:01:00.000Z') }),
    };
    const service = new ProviderStatusService({ cache: new ProviderStatusCache({ filePath: null }) });

    const result = await service.refresh(source);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.getlilac.com/status?window=5m',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(result).toMatchObject({
      source: 'network',
      observation: {
        providerId: 'lilac',
        stale: false,
        data: {
          models: [{ subscription: { supplyState: 'surplus', discountPercent: 75, creditMultiplier: 0.25 } }],
        },
      },
    });
  });

  it('makes unavailable supply fields visible as unavailable rather than changing routing or fabricating a discount', async () => {
    const source: ProviderStatusSource = {
      providerId: 'lilac',
      ttlMs: 5 * 60_000,
      minimumManualRefreshMs: 30_000,
      fetchStatus: async () => fetchLilacStatus({
        fetch: async () => new Response(JSON.stringify({
          updated_at: '2026-07-12T12:00:00.000Z',
          window: '5m',
          window_secs: 300,
          stale: false,
          models: [{ id: 'moonshotai/kimi-k2.6', tps: 100, ttfb_seconds: 0.4, uptime_pct: 99 }],
        }), { status: 200 }),
        now: () => new Date('2026-07-12T12:01:00.000Z'),
      }),
    };
    const service = new ProviderStatusService({ cache: new ProviderStatusCache({ filePath: null }) });

    const result = await service.refresh(source);
    const model = (result.observation.data['models'] as Array<{ subscription: Record<string, unknown> }>)[0];

    expect(model.subscription).toEqual({
      availability: 'unavailable',
      supplyState: null,
      discountPercent: null,
      creditMultiplier: null,
    });
    expect(result.observation.data).not.toHaveProperty('recommendedModel');
    expect(result.observation.data).not.toHaveProperty('requestEligibility');
  });

  it('binds Neuralwatt quota observations to the connection that supplied its credential', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      snapshot_at: '2026-07-12T12:00:00.000Z',
      balance: { accounting_method: 'token', credits_remaining_usd: 12 },
    }), { status: 200 }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetch);
    try {
      const observation = await createNeuralwattStatusSource('connection-personal', 'test-key')
        .fetchStatus();

      expect(observation).toMatchObject({
        providerId: 'neuralwatt',
        connectionId: 'connection-personal',
        data: { creditsRemainingUsd: 12 },
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});
