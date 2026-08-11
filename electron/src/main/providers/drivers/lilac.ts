import type { LanguageModelV4 } from '@ai-sdk/provider';
import Decimal from 'decimal.js';
import { createUnwrappingFetch } from '../../llm/response-unwrap';
import { importESM } from '../../utils/esm-import';
import type { DiscoveredProviderModel } from '../../../shared/types/provider';
import type { ProviderDriver } from './types';
import type { ProviderStatusObservation } from '../status/cache';
import type {
  PricingRateFields,
  ProviderModelRateCard,
  ProviderQuota,
} from '../../../shared/types/provider-facets';
import { scalePricingRateFields } from '../facets/pricing';
import { observationWithQuota } from '../facets/quota';
import { fetchModelsEndpoint, modelsListEntries } from './models-endpoint';
import {
  parseRetryAfter,
  StatusRefreshError,
  type ProviderStatusSource,
} from '../status/service';
import type { DriverQuotaRequest } from './types';

/** Lilac’s documented OpenAI-compatible inference API, owned by driver code. */
export const LILAC_INFERENCE_BASE_URL = 'https://api.getlilac.com/v1';
export const LILAC_MODELS_URL = `${LILAC_INFERENCE_BASE_URL}/models`;
/** Lilac’s public status source; it deliberately receives no API credential. */
export const LILAC_STATUS_URL = 'https://api.getlilac.com/status?window=5m';
export const LILAC_STATUS_TTL_MS = 5 * 60_000;
export const LILAC_STATUS_MINIMUM_MANUAL_REFRESH_MS = 30_000;
export const LILAC_STATUS_REQUEST_TIMEOUT_MS = 15_000;
export const LILAC_PRICING_REFRESH_INTERVAL_SECONDS = LILAC_STATUS_TTL_MS / 1000;

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

function apiKeyForLilac(credential: { readonly kind: string; readonly apiKey?: string }): string {
  if (credential.kind === 'api-key' && credential.apiKey) return credential.apiKey;
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
 * Lilac publishes a live subscription multiplier alongside its discount. Both
 * values must be present, fresh, and tied to a model before they can adjust
 * that model's list rates. We never derive either value from the other,
 * supply state, or performance data. The public status endpoint deliberately
 * receives no API credential.
 */
export async function fetchLilacPricingRateCards(input: {
  readonly catalogRates?: Readonly<Record<string, PricingRateFields>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}): Promise<readonly ProviderModelRateCard[]> {
  const observation = await fetchLilacStatus({ fetch: input.fetch, now: input.now });
  if (observation.stale || observation.availability !== 'available') {
    throw new Error('Lilac live pricing is unavailable from a stale status observation');
  }
  const data = observation.data as LilacStatusData;
  const cards: ProviderModelRateCard[] = [];
  for (const model of data.models) {
    const { subscription } = model;
    if (subscription.availability !== 'available') continue;
    if (subscription.discountPercent === null || subscription.creditMultiplier === null) continue;
    const base = input.catalogRates?.[model.modelId];
    if (!base) continue;
    const multiplier = new Decimal(String(subscription.creditMultiplier));
    cards.push({
      modelId: model.modelId,
      currencyUnit: { kind: 'fiat', code: 'USD' },
      observedAt: data.subscriptionSupplyUpdatedAt ?? observation.providerUpdatedAt ?? observation.observedAt,
      rates: scalePricingRateFields(base, multiplier),
      adjustment: {
        kind: 'subscription-multiplier',
        multiplier: multiplier.toFixed(),
        discountPercent: subscription.discountPercent,
        providerUpdatedAt: observation.providerUpdatedAt,
        supplyUpdatedAt: data.subscriptionSupplyUpdatedAt,
      },
    });
  }
  return cards;
}

/**
 * Lilac's OpenAI-compatible models list carries ids (and at most a display
 * name), so discovered entries contribute nothing beyond the id (R27).
 */
export function parseLilacModels(payload: unknown): DiscoveredProviderModel[] {
  return modelsListEntries(payload, 'Lilac').map((entry) => {
    const name = entry['name'];
    return {
      id: entry['id'] as string,
      ...(typeof name === 'string' && name.trim() !== '' ? { displayName: name.trim() } : {}),
    };
  });
}

export async function fetchLilacModels(options: {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<readonly DiscoveredProviderModel[]> {
  const payload = await fetchModelsEndpoint(LILAC_MODELS_URL, options.apiKey, 'Lilac', {
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return parseLilacModels(payload);
}

/**
 * A specialized, code-owned Lilac driver. Catalog data can select models but
 * cannot redirect credentials or transport to another endpoint.
 */
export function createLilacProviderDriver(options: {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
} = {}): ProviderDriver {
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
    pricingFacet: {
      dynamic: {
        refreshIntervalSeconds: LILAC_PRICING_REFRESH_INTERVAL_SECONDS,
        fetchRates: (_request, context) => fetchLilacPricingRateCards({
          catalogRates: context.catalogRates,
          fetch: options.fetch,
          now: options.now,
        }),
      },
    },
    discoveryFacet: {
      fetchModels: ({ credential }) => fetchLilacModels({
        apiKey: apiKeyForLilac(credential),
        fetch: options.fetch,
      }),
    },
    quotaFacet: {
      fetchQuota: (request) => fetchLilacQuota(request, {
        fetch: options.fetch,
        now: options.now,
      }),
    },
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
  readonly timeoutMs?: number;
}

/** Fetch public Lilac performance/supply metadata without sending user credentials. */
export async function fetchLilacStatus(options: FetchLilacStatusOptions = {}): Promise<ProviderStatusObservation> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? LILAC_STATUS_REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetchImpl(LILAC_STATUS_URL, {
    headers: { accept: 'application/json' },
    signal,
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

/**
 * Lilac's public status endpoint documents no balance or account-subscription
 * fields; the typed balances/subscription surface therefore stays empty rather
 * than fabricating state. The documented per-model supply state maps into typed
 * allowances; unavailable supply data surfaces as 'unknown', never inferred (R4).
 */
export function quotaFromLilacObservation(observation: ProviderStatusObservation): ProviderQuota {
  const data = observation.data as LilacStatusData;
  const allowances = data.models
    .filter((model) => model.subscription.availability === 'available')
    .map((model) => ({
      label: model.name ?? model.modelId,
      state: 'available' as const,
      detail: `Supply: ${model.subscription.supplyState ?? 'unknown'} · Discount: ${
        model.subscription.discountPercent !== null ? `${model.subscription.discountPercent}%` : 'unavailable'
      } · Credit multiplier: ${
        model.subscription.creditMultiplier !== null ? String(model.subscription.creditMultiplier) : 'unavailable'
      }`,
    }));
  return {
    observedAt: data.subscriptionSupplyUpdatedAt ?? observation.providerUpdatedAt ?? observation.observedAt,
    balances: [],
    subscription: null,
    allowances,
  };
}

/** Fetch typed Lilac quota from the public, credential-free status endpoint. */
export async function fetchLilacQuota(
  _request: DriverQuotaRequest,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ProviderQuota> {
  const observation = await fetchLilacStatus({
    fetch: options.fetch,
    now: options.now,
    signal: options.signal,
  });
  if (observation.stale || observation.availability !== 'available') {
    throw new StatusRefreshError('Lilac quota is unavailable from a stale status observation', {
      kind: 'network',
    });
  }
  return quotaFromLilacObservation(observation);
}

/** The scheduler-facing source remains public, credential-free, and informational. */
export function createLilacStatusSource(): ProviderStatusSource {
  return {
    providerId: 'lilac',
    ttlMs: LILAC_STATUS_TTL_MS,
    minimumManualRefreshMs: LILAC_STATUS_MINIMUM_MANUAL_REFRESH_MS,
    fetchStatus: async () => {
      const observation = await fetchLilacStatus();
      return observationWithQuota(observation, quotaFromLilacObservation(observation));
    },
  };
}
