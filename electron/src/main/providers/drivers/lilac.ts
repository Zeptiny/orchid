import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createUnwrappingFetch } from '../../llm/response-unwrap';
import { importESM } from '../../utils/esm-import';
import type { ProviderDriver } from './types';
import type { ProviderStatusObservation } from '../status/cache';
import {
  parseRetryAfter,
  StatusRefreshError,
  type ProviderStatusSource,
} from '../status/service';

/** Lilac’s documented OpenAI-compatible inference API, owned by driver code. */
export const LILAC_INFERENCE_BASE_URL = 'https://api.getlilac.com/v1';
/** Lilac’s public status source; it deliberately receives no API credential. */
export const LILAC_STATUS_URL = 'https://api.getlilac.com/status?window=5m';
export const LILAC_STATUS_TTL_MS = 5 * 60_000;
export const LILAC_STATUS_MINIMUM_MANUAL_REFRESH_MS = 30_000;

export type LilacSupplyState = 'low' | 'medium' | 'high' | 'surplus';

export interface LilacSubscriptionStatus {
  readonly availability: 'available' | 'unavailable';
  readonly supplyState: LilacSupplyState | null;
  readonly discountPercent: number | null;
  readonly creditMultiplier: number | null;
}

export interface LilacModelStatus {
  readonly modelId: string;
  readonly name: string | null;
  readonly tokensPerSecond: number | null;
  readonly timeToFirstTokenSeconds: number | null;
  readonly uptimePercent: number | null;
  readonly subscription: LilacSubscriptionStatus;
}

export interface LilacStatusData extends Record<string, unknown> {
  readonly window: string | null;
  readonly windowSeconds: number | null;
  readonly subscriptionSupplyUpdatedAt: string | null;
  readonly models: readonly LilacModelStatus[];
}

function apiKeyForLilac(credential: { readonly kind: string; readonly apiKey?: string; readonly accessToken?: string }): string {
  if (credential.kind === 'api-key' && credential.apiKey) return credential.apiKey;
  if (credential.kind === 'oauth' && credential.accessToken) return credential.accessToken;
  throw new Error('Lilac requires an API key credential');
}

/** Construct Lilac’s documented OpenAI-compatible chat model. */
export async function createLilacLanguageModel(input: {
  readonly modelId: string;
  readonly apiKey: string;
}): Promise<LanguageModelV4> {
  const { createOpenAICompatible } = await importESM<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
  return createOpenAICompatible({
    name: 'lilac',
    baseURL: LILAC_INFERENCE_BASE_URL,
    apiKey: input.apiKey,
    fetch: createUnwrappingFetch(),
  })(input.modelId);
}

/**
 * A specialized, code-owned Lilac driver. Catalog data can select models but
 * cannot redirect credentials or transport to another endpoint.
 */
export function createLilacProviderDriver(): ProviderDriver {
  return {
    id: 'lilac',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomEndpoint: false,
    origin: LILAC_INFERENCE_BASE_URL,
    createLanguageModel: async ({ model, credential }) => createLilacLanguageModel({
      modelId: model.id,
      apiKey: apiKeyForLilac(credential),
    }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function optionalFiniteNumber(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function optionalSupplyState(value: unknown): LilacSupplyState | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'surplus' ? value : null;
}

function parseModelStatus(value: unknown, supplyUpdatedAt: string | null): LilacModelStatus | null {
  const model = record(value);
  if (!model || typeof model['id'] !== 'string' || model['id'].trim() === '') return null;
  const supplyState = optionalSupplyState(model['current_subscription_supply_state']);
  const discountPercent = optionalFiniteNumber(model['current_subscription_discount_percent'], 0, 100);
  const creditMultiplier = optionalFiniteNumber(model['current_subscription_credit_multiplier'], 0);
  const supplyAvailable = supplyUpdatedAt !== null
    && supplyState !== null
    && discountPercent !== null
    && creditMultiplier !== null;
  return {
    modelId: model['id'],
    name: typeof model['name'] === 'string' ? model['name'] : null,
    tokensPerSecond: optionalFiniteNumber(model['tps']),
    timeToFirstTokenSeconds: optionalFiniteNumber(model['ttfb_seconds']),
    uptimePercent: optionalFiniteNumber(model['uptime_pct'], 0, 100),
    subscription: {
      availability: supplyAvailable ? 'available' : 'unavailable',
      supplyState,
      discountPercent,
      creditMultiplier,
    },
  };
}

function sourceIsStale(providerUpdatedAt: string | null, sourceStale: unknown, now: Date): boolean {
  if (sourceStale === true || providerUpdatedAt === null) return true;
  return now.getTime() - Date.parse(providerUpdatedAt) > LILAC_STATUS_TTL_MS;
}

/**
 * Parse Lilac’s documented public status response. Supply values are copied
 * only when the source supplies them; no state-to-discount inference occurs.
 */
export function parseLilacStatus(value: unknown, now = new Date()): ProviderStatusObservation {
  const status = record(value);
  if (!status || !Array.isArray(status['models'])) {
    throw new StatusRefreshError('Lilac status response has no models array', { kind: 'schema' });
  }
  const providerUpdatedAt = optionalTimestamp(status['updated_at']);
  const subscriptionSupplyUpdatedAt = optionalTimestamp(status['current_subscription_supply_updated_at']);
  const models = status['models']
    .map((model) => parseModelStatus(model, subscriptionSupplyUpdatedAt))
    .filter((model): model is LilacModelStatus => model !== null);
  const data: LilacStatusData = {
    window: typeof status['window'] === 'string' ? status['window'] : null,
    windowSeconds: optionalFiniteNumber(status['window_secs'], 0),
    subscriptionSupplyUpdatedAt,
    models,
  };
  return {
    providerId: 'lilac',
    observedAt: now.toISOString(),
    providerUpdatedAt,
    availability: 'available',
    stale: sourceIsStale(providerUpdatedAt, status['stale'], now),
    data,
  };
}

export interface FetchLilacStatusOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/** Fetch public Lilac performance/supply metadata without sending user credentials. */
export async function fetchLilacStatus(options: FetchLilacStatusOptions = {}): Promise<ProviderStatusObservation> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const response = await fetchImpl(LILAC_STATUS_URL, {
    headers: { accept: 'application/json' },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new StatusRefreshError(`Lilac status request failed with HTTP ${response.status}`, {
      statusCode: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new StatusRefreshError('Lilac status response was not valid JSON', { kind: 'schema' });
  }
  return parseLilacStatus(payload, now());
}

/** The scheduler-facing source remains public, credential-free, and informational. */
export function createLilacStatusSource(): ProviderStatusSource {
  return {
    providerId: 'lilac',
    ttlMs: LILAC_STATUS_TTL_MS,
    minimumManualRefreshMs: LILAC_STATUS_MINIMUM_MANUAL_REFRESH_MS,
    fetchStatus: () => fetchLilacStatus(),
  };
}
