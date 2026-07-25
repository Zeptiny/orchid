import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderStatusCache,
  type ProviderStatusObservation,
} from '../../src/main/providers/status/cache';
import {
  ProviderStatusScheduler,
  ProviderStatusService,
  StatusRefreshError,
  type ProviderStatusSource,
} from '../../src/main/providers/status/service';

const PROVIDER_ID = 'lilac';
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function observation(at: string, overrides: Partial<ProviderStatusObservation> = {}): ProviderStatusObservation {
  return {
    providerId: PROVIDER_ID,
    observedAt: at,
    providerUpdatedAt: at,
    availability: 'available',
    stale: false,
    data: { model: 'moonshotai/kimi-k2.6' },
    ...overrides,
  };
}

function source(fetchStatus: ProviderStatusSource['fetchStatus']): ProviderStatusSource {
  return {
    providerId: PROVIDER_ID,
    ttlMs: 5 * 60_000,
    minimumManualRefreshMs: 30_000,
    fetchStatus,
  };
}

describe('ProviderStatusService', () => {
  it('uses TTL and the manual-refresh minimum without coupling status to request eligibility', async () => {
    let now = new Date('2026-07-12T12:00:00.000Z');
    const fetchStatus = vi.fn(async () => observation(now.toISOString()));
    const service = new ProviderStatusService({
      cache: new ProviderStatusCache({ filePath: null }),
      now: () => now,
    });
    const lilac = source(fetchStatus);

    await expect(service.refresh(lilac)).resolves.toMatchObject({ source: 'network', observation: { stale: false } });
    await expect(service.refresh(lilac)).resolves.toMatchObject({ source: 'cache', observation: { stale: false } });
    await expect(service.refresh(lilac, { manual: true })).resolves.toMatchObject({ source: 'cache' });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    now = new Date('2026-07-12T12:00:30.000Z');
    await expect(service.refresh(lilac, { manual: true })).resolves.toMatchObject({ source: 'network' });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous refreshes for one provider', async () => {
    let resolveFetch: ((value: ProviderStatusObservation) => void) | undefined;
    const fetchStatus = vi.fn(() => new Promise<ProviderStatusObservation>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = new ProviderStatusService({
      cache: new ProviderStatusCache({ filePath: null }),
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    });
    const lilac = source(fetchStatus);

    const first = service.refresh(lilac);
    const second = service.refresh(lilac, { manual: true });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    resolveFetch?.(observation('2026-07-12T12:00:00.000Z'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ source: 'network' }),
      expect.objectContaining({ source: 'network' }),
    ]);
  });

  it('honors Retry-After, preserves the prior observation as stale, and redacts diagnostics', async () => {
    let now = new Date('2026-07-12T12:00:00.000Z');
    const cache = new ProviderStatusCache({ filePath: null });
    cache.put(observation('2026-07-12T11:55:00.000Z'));
    const fetchStatus = vi.fn(async () => {
      throw new StatusRefreshError(
        '429 Bearer super-secret-token account_id=acct_123 request_body={"api_key":"not-safe"}',
        { statusCode: 429, retryAfterMs: 60_000 },
      );
    });
    const service = new ProviderStatusService({ cache, now: () => now });
    const lilac = source(fetchStatus);

    const failed = await service.refresh(lilac, { manual: true });
    expect(failed.observation).toMatchObject({ stale: true, availability: 'available' });
    expect(failed.observation.error?.message).not.toContain('super-secret-token');
    expect(failed.observation.error?.message).not.toContain('acct_123');
    expect(failed.observation.error?.message).toContain('[REDACTED]');

    now = new Date('2026-07-12T12:00:30.000Z');
    await expect(service.refresh(lilac, { manual: true })).resolves.toMatchObject({ source: 'retry-after' });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('persists only redacted timestamped observations', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-status-'));
    const filePath = path.join(tempDir, 'status.json');
    const cache = new ProviderStatusCache({ filePath });

    cache.put(observation('2026-07-12T12:00:00.000Z', {
      data: {
        model: 'kimi',
        authorization: 'Bearer should-not-persist',
        requestBody: { api_key: 'should-not-persist' },
      },
      error: {
        kind: 'network',
        message: 'account=acct_123 Bearer should-not-persist',
      },
    }));

    const restored = new ProviderStatusCache({ filePath }).get(PROVIDER_ID);
    expect(restored).toBeDefined();
    expect(JSON.stringify(restored)).not.toContain('should-not-persist');
    expect(JSON.stringify(restored)).not.toContain('acct_123');
    expect(JSON.stringify(restored)).toContain('[REDACTED]');
  });

  it('keeps a fetched observation available when status-cache persistence fails', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-status-'));
    const blocker = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(blocker, 'block cache directory creation');
    const service = new ProviderStatusService({
      cache: new ProviderStatusCache({ filePath: path.join(blocker, 'status.json') }),
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    });

    await expect(service.refresh(source(async () => observation('2026-07-12T12:00:00.000Z'))))
      .resolves.toMatchObject({ source: 'network', observation: { availability: 'available' } });
  });

  it('schedules independent status refreshes and stops cleanly without touching inference state', async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async () => observation(new Date().toISOString()));
      const service = new ProviderStatusService({
        cache: new ProviderStatusCache({ filePath: null }),
      });
      const scheduler = new ProviderStatusScheduler(service);
      scheduler.start([source(fetchStatus)]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchStatus).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetchStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
