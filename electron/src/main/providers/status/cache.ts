import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOME_CONFIG_DIR, atomicWriteJson } from '../../config/loader';

export const PROVIDER_STATUS_CACHE_PATH = path.join(HOME_CONFIG_DIR, 'provider-status.json');

export type ProviderStatusAvailability = 'available' | 'unavailable' | 'unknown';

export type ProviderStatusErrorKind =
  | 'network'
  | 'unauthorized'
  | 'rate-limited'
  | 'schema'
  | 'unknown';

/** Diagnostics are informational only and intentionally exclude secret values. */
export interface ProviderStatusError {
  readonly kind: ProviderStatusErrorKind;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryAfterAt?: string;
}

/**
 * One timestamped, redacted observation from a trusted provider status source.
 * Status data never controls connection usability or request routing.
 */
export interface ProviderStatusObservation {
  readonly providerId: string;
  /**
   * Authenticated account status is bound to the connection that supplied its
   * credential. Omitted means a provider-wide, credential-free observation.
   */
  readonly connectionId?: string;
  /** When Orchid fetched or recorded this observation. */
  readonly observedAt: string;
  /** The provider's source timestamp, if it supplied a valid one. */
  readonly providerUpdatedAt: string | null;
  readonly availability: ProviderStatusAvailability;
  readonly stale: boolean;
  readonly data: Readonly<Record<string, unknown>>;
  readonly error?: ProviderStatusError;
}

interface ProviderStatusCacheDocument {
  readonly version: 2;
  readonly observations: Readonly<Record<string, ProviderStatusObservation>>;
}

export interface ProviderStatusCacheOptions {
  /** Use null for an in-memory cache (for tests and ephemeral callers). */
  readonly filePath?: string | null;
}

const SENSITIVE_STATUS_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|cookie|credential|request[_-]?body|(?:^|[_-])body$|account(?:[_-]?(?:id|identifier))?|org(?:anization)?[_-]?id|user[_-]?id)/i;

/** Redact status diagnostics before they reach disk, logs, or IPC. */
export function redactStatusDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|credential)\s*[=:]\s*[^\s,;"'}]+/gi, (match) => {
      const separator = match.indexOf('=') >= 0 ? '=' : ':';
      return `${match.slice(0, match.indexOf(separator) + 1)}[REDACTED]`;
    })
    .replace(/\b(?:account(?:[_-]?(?:id|identifier))?|org(?:anization)?[_-]?id|user[_-]?id)\s*[=:]\s*[^\s,;"'}]+/gi, (match) => {
      const separator = match.indexOf('=') >= 0 ? '=' : ':';
      return `${match.slice(0, match.indexOf(separator) + 1)}[REDACTED]`;
    });
}

function redactStatusValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && SENSITIVE_STATUS_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactStatusDiagnostic(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactStatusValue(entry, undefined, seen));

  const redacted: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    redacted[nestedKey] = redactStatusValue(nestedValue, nestedKey, seen);
  }
  return redacted;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function validAvailability(value: unknown): ProviderStatusAvailability {
  return value === 'available' || value === 'unavailable' || value === 'unknown'
    ? value
    : 'unknown';
}

function validError(value: unknown): ProviderStatusError | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const error = value as Record<string, unknown>;
  const kind = error['kind'];
  if (kind !== 'network' && kind !== 'unauthorized' && kind !== 'rate-limited' && kind !== 'schema' && kind !== 'unknown') {
    return undefined;
  }
  if (typeof error['message'] !== 'string') return undefined;
  const statusCode = typeof error['statusCode'] === 'number' && Number.isInteger(error['statusCode'])
    ? error['statusCode']
    : undefined;
  const retryAfterAt = validTimestamp(error['retryAfterAt']);
  return {
    kind,
    message: redactStatusDiagnostic(error['message']),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfterAt === null ? {} : { retryAfterAt }),
  };
}

function normalizeObservation(value: unknown): ProviderStatusObservation | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const observation = value as Record<string, unknown>;
  if (typeof observation['providerId'] !== 'string' || observation['providerId'].trim() === '') return null;
  const connectionId = observation['connectionId'];
  if (connectionId !== undefined && (typeof connectionId !== 'string' || connectionId.trim() === '')) return null;
  const observedAt = validTimestamp(observation['observedAt']);
  if (observedAt === null) return null;
  const rawData = observation['data'];
  const data = rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)
    ? redactStatusValue(rawData) as Record<string, unknown>
    : {};
  const error = validError(observation['error']);
  return {
    providerId: observation['providerId'],
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    observedAt,
    providerUpdatedAt: validTimestamp(observation['providerUpdatedAt']),
    availability: validAvailability(observation['availability']),
    stale: observation['stale'] === true,
    data,
    ...(error === undefined ? {} : { error }),
  };
}

/** Stable identity shared by cached observations and in-flight refreshes. */
export function providerStatusKey(providerId: string, connectionId?: string): string {
  return JSON.stringify([providerId, connectionId ?? null]);
}

function cloneObservation(observation: ProviderStatusObservation): ProviderStatusObservation {
  return structuredClone(observation);
}

/**
 * Atomic, restart-safe cache for provider observations. It persists only
 * redacted public/status metadata, never credentials or raw request bodies.
 */
export class ProviderStatusCache {
  private readonly filePath: string | null;
  private loaded = false;
  private readonly observations = new Map<string, ProviderStatusObservation>();

  constructor(options: ProviderStatusCacheOptions = {}) {
    this.filePath = options.filePath === undefined ? PROVIDER_STATUS_CACHE_PATH : options.filePath;
  }

  get(providerId: string, connectionId?: string): ProviderStatusObservation | undefined {
    this.load();
    const observation = this.observations.get(providerStatusKey(providerId, connectionId));
    return observation ? cloneObservation(observation) : undefined;
  }

  list(): readonly ProviderStatusObservation[] {
    this.load();
    return [...this.observations.values()].map(cloneObservation);
  }

  put(observation: ProviderStatusObservation): ProviderStatusObservation {
    this.load();
    const normalized = normalizeObservation(observation);
    if (!normalized) throw new Error('Provider status observation is invalid');
    this.observations.set(providerStatusKey(normalized.providerId, normalized.connectionId), normalized);
    this.persist();
    return cloneObservation(normalized);
  }

  /** Remove one provider/account observation without affecting provider-wide status. */
  delete(providerId: string, connectionId?: string): boolean {
    this.load();
    const deleted = this.observations.delete(providerStatusKey(providerId, connectionId));
    if (deleted) this.persist();
    return deleted;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.filePath === null || !fs.existsSync(this.filePath)) return;

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const document = parsed as Record<string, unknown>;
      if ((document['version'] !== 1 && document['version'] !== 2)
        || document['observations'] === null
        || typeof document['observations'] !== 'object'
        || Array.isArray(document['observations'])) {
        return;
      }
      for (const [providerId, value] of Object.entries(document['observations'] as Record<string, unknown>)) {
        const observation = normalizeObservation(value);
        // Version 1 keyed public observations by provider ID. Version 2 uses
        // an opaque composite key so account-scoped entries cannot collide.
        if (observation && (document['version'] === 2 || observation.providerId === providerId)) {
          this.observations.set(providerStatusKey(observation.providerId, observation.connectionId), observation);
        }
      }
    } catch {
      // Invalid/corrupt status data is informational and must never affect inference.
    }
  }

  private persist(): void {
    if (this.filePath === null) return;
    const observations: Record<string, ProviderStatusObservation> = {};
    for (const [key, observation] of this.observations.entries()) {
      observations[key] = observation;
    }
    const document: ProviderStatusCacheDocument = { version: 2, observations };
    try {
      atomicWriteJson(this.filePath, document);
    } catch {
      // Status is informational. Retain the redacted in-memory observation
      // when a filesystem problem prevents restart persistence.
    }
  }
}
