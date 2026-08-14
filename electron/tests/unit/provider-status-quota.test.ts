import { describe, expect, it, vi } from 'vitest';
import {
  ProviderStatusCache,
  type ProviderStatusObservation,
} from '../../src/main/providers/status/cache';
import {
  ProviderStatusService,
  type ProviderQuotaStatusSource,
} from '../../src/main/providers/status/service';
import type { ProviderQuota } from '../../src/shared/types/provider-facets';

const NOW = new Date('2026-07-12T12:00:00.000Z');

function quota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
  return {
    observedAt: '2026-07-12T11:59:00.000Z',
    balances: [{ label: 'Credits remaining', amount: '12.5', unit: 'USD' }],
    subscription: { state: 'active', displayName: 'Pro' },
    allowances: [{ label: 'API key', state: 'available' }],
    ...overrides,
  };
}

function observation(overrides: Partial<ProviderStatusObservation> = {}): ProviderStatusObservation {
  return {
    providerId: 'neuralwatt',
    connectionId: 'conn-1',
    observedAt: NOW.toISOString(),
    providerUpdatedAt: NOW.toISOString(),
    availability: 'available',
    stale: false,
    data: { accountingMethod: 'energy' },
    ...overrides,
  };
}

function quotaSource(
  fetchStatus: ProviderQuotaStatusSource['fetchStatus'],
  fetchQuota: ProviderQuotaStatusSource['fetchQuota'],
): ProviderQuotaStatusSource {
  return {
    providerId: 'neuralwatt',
    connectionId: 'conn-1',
    ttlMs: 5 * 60_000,
    minimumManualRefreshMs: 30_000,
    fetchStatus,
    fetchQuota,
  };
}

function service(now: () => Date = () => NOW, cache?: ProviderStatusCache): ProviderStatusService {
  return new ProviderStatusService({
    cache: cache ?? new ProviderStatusCache({ filePath: null }),
    now,
  });
}

describe('ProviderStatusService typed quota (R24/R25)', () => {
  it('stores typed quota on data.quota through the normal refresh path', async () => {
    const svc = service();
    const source = quotaSource(
      async () => observation(),
      async () => quota(),
    );

    const result = await svc.refreshQuota(source);

    expect(result.source).toBe('network');
    expect(result.observation.data['quota']).toEqual(quota());
    expect(result.observation.stale).toBe(false);
  });

  it('typed quota survives the status cache persistence/redaction round-trip intact', async () => {
    const cache = new ProviderStatusCache({ filePath: null });
    const svc = service(() => NOW, cache);
    const source = quotaSource(async () => observation(), async () => quota());
    await svc.refreshQuota(source);

    const cached = cache.get('neuralwatt', 'conn-1');
    // Redaction must not blank balance/allowance labels such as
    // 'Credits remaining' or 'API key' (no credential/account id keys inside).
    expect(cached?.data['quota']).toEqual(quota());
  });

  it('a quota failure degrades to an unavailable/stale observation only, never throws', async () => {
    const svc = service();
    const source = quotaSource(
      async () => observation(),
      async () => { throw new Error('quota endpoint 500'); },
    );

    const result = await svc.refreshQuota(source);

    expect(result.source).toBe('error');
    expect(result.observation.availability).toBe('unavailable');
    expect(result.observation.stale).toBe(true);
    expect(result.observation.error?.message).toContain('quota endpoint 500');
  });

  it('a quota failure preserves the prior cached quota as stale rather than dropping it', async () => {
    const cache = new ProviderStatusCache({ filePath: null });
    const svc = service(() => NOW, cache);
    const good = quotaSource(async () => observation(), async () => quota());
    await svc.refreshQuota(good);

    const failing = quotaSource(
      async () => observation(),
      async () => { throw new Error('boom'); },
    );
    // Advance past the manual minimum so the refresh actually re-runs.
    const later = service(() => new Date(NOW.getTime() + 60_000), cache);
    const result = await later.refreshQuota(failing, { manual: true });

    expect(result.source).toBe('error');
    expect(result.observation.stale).toBe(true);
    expect(result.observation.data['quota']).toEqual(quota());
  });

  it('a blocked allowance is surfaced as typed data and does not throw or gate (AE6)', async () => {
    const svc = service();
    const blocked = quota({ allowances: [{ label: 'API key', state: 'blocked', detail: 'past-due' }] });
    const source = quotaSource(async () => observation(), async () => blocked);

    const result = await svc.refreshQuota(source);

    expect(result.source).toBe('network');
    expect(result.observation.availability).toBe('available');
    expect((result.observation.data['quota'] as ProviderQuota).allowances[0]).toEqual({
      label: 'API key',
      state: 'blocked',
      detail: 'past-due',
    });
  });

  it('single-flights concurrent typed quota refreshes', async () => {
    const svc = service();
    let resolveQuota: ((q: ProviderQuota) => void) | undefined;
    const fetchQuota = vi.fn(() => new Promise<ProviderQuota>((resolve) => { resolveQuota = resolve; }));
    const source = quotaSource(async () => observation(), fetchQuota);

    const first = svc.refreshQuota(source);
    const second = svc.refreshQuota(source, { manual: true });
    // Let the composed fetchStatus reach the (single) fetchQuota call.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchQuota).toHaveBeenCalledTimes(1);
    resolveQuota?.(quota());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
