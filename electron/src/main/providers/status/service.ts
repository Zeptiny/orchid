import {
  ProviderStatusCache,
  providerStatusKey,
  redactStatusDiagnostic,
  type ProviderStatusError,
  type ProviderStatusErrorKind,
  type ProviderStatusObservation,
} from './cache';

export interface ProviderStatusSource {
  readonly providerId: string;
  /** Present only when status is authenticated and account-specific. */
  readonly connectionId?: string;
  readonly ttlMs: number;
  readonly minimumManualRefreshMs: number;
  fetchStatus(): Promise<ProviderStatusObservation>;
}

export interface StatusRefreshOptions {
  /** A user-requested refresh can bypass TTL, but not the provider-safe minimum. */
  readonly manual?: boolean;
}

export interface StatusRefreshResult {
  readonly source: 'network' | 'cache' | 'retry-after' | 'error';
  readonly observation: ProviderStatusObservation;
}

export interface ProviderStatusServiceOptions {
  readonly cache?: ProviderStatusCache;
  readonly now?: () => Date;
}

/** A provider status failure with optional HTTP rate-limit metadata. */
export class StatusRefreshError extends Error {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly kind?: ProviderStatusErrorKind;

  constructor(
    message: string,
    options: {
      readonly statusCode?: number;
      readonly retryAfterMs?: number;
      readonly kind?: ProviderStatusErrorKind;
    } = {},
  ) {
    super(message);
    this.name = 'StatusRefreshError';
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.kind = options.kind;
  }
}

/** Parse an HTTP Retry-After header as a positive duration, if valid. */
export function parseRetryAfter(value: string | null | undefined, now = new Date()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, retryAt - now.getTime());
}

function millisecondsSince(timestamp: string, now: Date): number | null {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  return Math.max(0, now.getTime() - time);
}

function isFresh(observation: ProviderStatusObservation, ttlMs: number, now: Date): boolean {
  const elapsed = millisecondsSince(observation.observedAt, now);
  return !observation.stale && elapsed !== null && elapsed < ttlMs;
}

function retryAfterAt(observation: ProviderStatusObservation | undefined): number | undefined {
  if (!observation?.error?.retryAfterAt) return undefined;
  const time = Date.parse(observation.error.retryAfterAt);
  return Number.isNaN(time) ? undefined : time;
}

function classifyError(error: unknown, now: Date): ProviderStatusError {
  const statusError = error instanceof StatusRefreshError ? error : undefined;
  const statusCode = statusError?.statusCode;
  const kind: ProviderStatusErrorKind = statusError?.kind
    ?? (statusCode === 401 || statusCode === 403
      ? 'unauthorized'
      : statusCode === 429
        ? 'rate-limited'
        : 'network');
  const retryAfterMs = statusError?.retryAfterMs;
  const retryAfter = retryAfterMs === undefined
    ? undefined
    : new Date(now.getTime() + Math.max(0, retryAfterMs)).toISOString();
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind,
    message: redactStatusDiagnostic(message),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfter === undefined ? {} : { retryAfterAt: retryAfter }),
  };
}

function unavailableObservation(source: ProviderStatusSource, now: Date, error: ProviderStatusError): ProviderStatusObservation {
  return {
    providerId: source.providerId,
    ...(source.connectionId ? { connectionId: source.connectionId } : {}),
    observedAt: now.toISOString(),
    providerUpdatedAt: null,
    availability: 'unavailable',
    stale: true,
    data: {},
    error,
  };
}

function staleObservation(observation: ProviderStatusObservation, error: ProviderStatusError): ProviderStatusObservation {
  return {
    ...observation,
    stale: true,
    error,
  };
}

/**
 * Independently refreshes trusted provider status sources. Its only outputs
 * are cached observations; it never mutates a connection or selects a model.
 */
export class ProviderStatusService {
  private readonly cache: ProviderStatusCache;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<StatusRefreshResult>>();
  /**
   * Bumps whenever a connection changes account identity. A refresh that began
   * with the prior identity may finish, but must not repopulate its old status.
   */
  private readonly generations = new Map<string, number>();

  constructor(options: ProviderStatusServiceOptions = {}) {
    this.cache = options.cache ?? new ProviderStatusCache();
    this.now = options.now ?? (() => new Date());
  }

  get(providerId: string, connectionId?: string): ProviderStatusObservation | undefined {
    return this.cache.get(providerId, connectionId);
  }

  list(): readonly ProviderStatusObservation[] {
    return this.cache.list();
  }

  /**
   * Forget account-specific status after a credential identity change.
   * Deliberately scoped to the composite key so public provider status remains.
   */
  invalidate(providerId: string, connectionId: string): void {
    const key = providerStatusKey(providerId, connectionId);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.inFlight.delete(key);
    this.cache.delete(providerId, connectionId);
  }

  refresh(source: ProviderStatusSource, options: StatusRefreshOptions = {}): Promise<StatusRefreshResult> {
    const key = providerStatusKey(source.providerId, source.connectionId);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const generation = this.generations.get(key) ?? 0;
    const refresh = this.refreshOnce(source, options, generation).finally(() => {
      if (this.inFlight.get(key) === refresh) this.inFlight.delete(key);
    });
    this.inFlight.set(key, refresh);
    return refresh;
  }

  private async refreshOnce(
    source: ProviderStatusSource,
    options: StatusRefreshOptions,
    generation: number,
  ): Promise<StatusRefreshResult> {
    if (!Number.isFinite(source.ttlMs) || source.ttlMs <= 0) throw new Error(`Invalid status TTL for '${source.providerId}'`);
    if (!Number.isFinite(source.minimumManualRefreshMs) || source.minimumManualRefreshMs < 0) {
      throw new Error(`Invalid manual status refresh minimum for '${source.providerId}'`);
    }

    const now = this.now();
    const cached = this.cache.get(source.providerId, source.connectionId);
    const retryAt = retryAfterAt(cached);
    if (retryAt !== undefined && retryAt > now.getTime()) {
      const observation = cached ?? unavailableObservation(source, now, {
        kind: 'rate-limited',
        message: 'Status refresh is delayed by the provider Retry-After response',
        retryAfterAt: new Date(retryAt).toISOString(),
      });
      return { source: 'retry-after', observation: { ...observation, stale: true } };
    }

    const elapsed = cached ? millisecondsSince(cached.observedAt, now) : null;
    if (cached && options.manual) {
      if (elapsed !== null && elapsed < source.minimumManualRefreshMs) return { source: 'cache', observation: cached };
    } else if (cached && isFresh(cached, source.ttlMs, now)) {
      return { source: 'cache', observation: cached };
    }

    try {
      const refreshed = await source.fetchStatus();
      if (refreshed.providerId !== source.providerId || refreshed.connectionId !== source.connectionId) {
        throw new StatusRefreshError(`Status source returned a mismatched provider id for '${source.providerId}'`, { kind: 'schema' });
      }
      const observation = this.putIfCurrent(source, generation, refreshed);
      return { source: 'network', observation };
    } catch (error) {
      const diagnostic = classifyError(error, now);
      const observation = this.putIfCurrent(source, generation, cached
        ? staleObservation(cached, diagnostic)
        : unavailableObservation(source, now, diagnostic));
      return { source: 'error', observation };
    }
  }

  private putIfCurrent(
    source: ProviderStatusSource,
    generation: number,
    observation: ProviderStatusObservation,
  ): ProviderStatusObservation {
    const key = providerStatusKey(source.providerId, source.connectionId);
    return (this.generations.get(key) ?? 0) === generation
      ? this.cache.put(observation)
      : structuredClone(observation);
  }
}

/**
 * Lightweight lifecycle owner for independent provider status refreshes.
 * It deliberately never observes connections or inference state: each source
 * is scheduled only according to its declared status cadence.
 */
export class ProviderStatusScheduler {
  private readonly service: ProviderStatusService;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(service: ProviderStatusService) {
    this.service = service;
  }

  start(sources: readonly ProviderStatusSource[]): void {
    this.stop();
    for (const source of sources) {
      const key = providerStatusKey(source.providerId, source.connectionId);
      if (this.timers.has(key)) {
        throw new Error(`Duplicate provider status source '${source.providerId}'`);
      }
      // Record a current observation promptly, then let source-owned TTL
      // govern subsequent informational refreshes.
      void this.service.refresh(source).catch(() => undefined);
      const timer = setInterval(() => {
        void this.service.refresh(source).catch(() => undefined);
      }, source.ttlMs);
      timer.unref?.();
      this.timers.set(key, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
