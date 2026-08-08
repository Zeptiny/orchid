import type { ProviderModelRateCard } from '../../../shared/types/provider-facets';
import type {
  DriverModelRequest,
  DriverPricingFetchContext,
  ProviderDriver,
} from '../drivers/types';
import { redactStatusDiagnostic } from '../status/cache';
import type { DynamicPricingState } from './pricing';

/** One dynamic-pricing refresh registration, built at request-resolve time. */
export interface PricingRefreshTarget {
  readonly driver: ProviderDriver;
  readonly request: DriverModelRequest;
  readonly fetchContext: () => DriverPricingFetchContext;
}

/** Latest-known rate cards plus the freshness of the refresh loop itself. */
export interface DynamicPricingCacheEntry {
  readonly cards: readonly ProviderModelRateCard[];
  /** Last successful fetch; null when the endpoint has never been reached. */
  readonly fetchedAt: string | null;
  /** Last failed refresh attempt, when it is newer than the last success. */
  readonly failedAt?: string;
  /** Redacted failure detail from the last failed refresh. */
  readonly error?: string;
}

function keyOf(providerId: string, connectionId: string): string {
  return JSON.stringify([providerId, connectionId]);
}

/**
 * Latest-known cache for driver-declared dynamic pricing (R7). Refreshes run
 * in the background on the driver-declared cadence, triggered when requests
 * resolve; a request never blocks on pricing freshness. A failed refresh keeps
 * the last successful cards and marks them stale, so the resolver can fall
 * back down the ladder with provenance intact.
 */
export class PricingRefresher {
  private readonly now: () => Date;
  private readonly entries = new Map<string, DynamicPricingCacheEntry>();
  private readonly inFlight = new Map<string, Promise<DynamicPricingCacheEntry>>();

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Kick an unawaited refresh when the latest-known rates are missing or older
   * than the driver-declared cadence. Safe to call on every request resolve.
   */
  ensureFresh(target: PricingRefreshTarget): void {
    const dynamic = target.driver.pricingFacet?.dynamic;
    if (!dynamic) return;
    const entry = this.entries.get(keyOf(target.driver.id, target.request.connection.id));
    const fetchedAt = entry?.fetchedAt ? Date.parse(entry.fetchedAt) : null;
    const due = fetchedAt === null
      || this.now().getTime() - fetchedAt >= dynamic.refreshIntervalSeconds * 1000;
    if (due) void this.refresh(target);
  }

  /** Single-flight refresh; updates the latest-known cache and never throws. */
  refresh(target: PricingRefreshTarget): Promise<DynamicPricingCacheEntry> {
    const key = keyOf(target.driver.id, target.request.connection.id);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.refreshOnce(target).finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Latest-known state for one model; never triggers a fetch. */
  stateFor(
    providerId: string,
    connectionId: string,
    modelId: string,
    refreshIntervalSeconds: number,
  ): DynamicPricingState {
    const entry = this.entries.get(keyOf(providerId, connectionId));
    const card = entry?.cards.find((candidate) => candidate.modelId === modelId);
    const fetchedAt = entry?.fetchedAt ? Date.parse(entry.fetchedAt) : null;
    const failedAt = entry?.failedAt ? Date.parse(entry.failedAt) : null;
    const stale = entry !== undefined && (
      fetchedAt === null
      || this.now().getTime() - fetchedAt >= refreshIntervalSeconds * 1000
      || (failedAt !== null && fetchedAt !== null && failedAt > fetchedAt)
    );
    return {
      card,
      stale,
      ...(entry?.error ? { error: entry.error } : {}),
    };
  }

  /** Await every in-flight refresh (tests and graceful shutdown). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Forget one connection's latest-known rates after an identity change. */
  invalidate(providerId: string, connectionId: string): void {
    this.entries.delete(keyOf(providerId, connectionId));
  }

  stop(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private async refreshOnce(target: PricingRefreshTarget): Promise<DynamicPricingCacheEntry> {
    const key = keyOf(target.driver.id, target.request.connection.id);
    const dynamic = target.driver.pricingFacet?.dynamic;
    const prior = this.entries.get(key);
    if (!dynamic) {
      return prior ?? { cards: [], fetchedAt: null };
    }
    try {
      const cards = await dynamic.fetchRates(target.request, target.fetchContext());
      const entry: DynamicPricingCacheEntry = {
        cards: structuredClone(cards),
        fetchedAt: this.now().toISOString(),
      };
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      const entry: DynamicPricingCacheEntry = {
        cards: prior?.cards ?? [],
        fetchedAt: prior?.fetchedAt ?? null,
        failedAt: this.now().toISOString(),
        error: redactStatusDiagnostic(error instanceof Error ? error.message : String(error)),
      };
      this.entries.set(key, entry);
      return entry;
    }
  }
}
