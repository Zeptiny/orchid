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

/** Code-owned Neuralwatt OpenAI-compatible API origin. */
export const NEURALWATT_API_ORIGIN = 'https://api.neuralwatt.com/v1';
export const NEURALWATT_QUOTA_URL = `${NEURALWATT_API_ORIGIN}/quota`;
export const NEURALWATT_STATUS_TTL_MS = 5 * 60_000;
export const NEURALWATT_STATUS_MINIMUM_MANUAL_REFRESH_MS = 30_000;
export const NEURALWATT_STATUS_REQUEST_TIMEOUT_MS = 15_000;

export interface NeuralwattBillingEvidence {
  /** Provider-reported request charge; U7 gives this precedence over formulae. */
  readonly reportedCostUsd: string | undefined;
  readonly allowanceRemainingUsd: string | undefined;
  readonly accountingMethod: 'energy' | 'token' | undefined;
  readonly energyKwhConsumed: string | undefined;
  readonly energyKwhCharged: string | undefined;
  readonly pricingMultiplier: string | undefined;
  readonly energyRateUsdPerKwh: string | undefined;
  readonly measurementAvailable: boolean | undefined;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed) ? trimmed : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Extract only documented, sanitized billing fields. Missing fields deliberately
 * remain undefined so later accounting records unknown cost rather than a guess.
 */
export function extractNeuralwattBillingEvidence(
  headers: Headers,
  body: unknown,
): NeuralwattBillingEvidence {
  const root = record(body);
  const energy = record(root?.energy);
  const accountingMethod = root?.accounting_method;
  return {
    reportedCostUsd: decimal(headers.get('x-request-cost-usd') ?? root?.request_cost_usd),
    allowanceRemainingUsd: decimal(headers.get('x-allowance-remaining-usd') ?? root?.allowance_remaining_usd),
    accountingMethod: accountingMethod === 'energy' || accountingMethod === 'token'
      ? accountingMethod
      : undefined,
    energyKwhConsumed: decimal(energy?.energy_kwh ?? root?.energy_kwh_consumed),
    energyKwhCharged: decimal(root?.energy_kwh_charged),
    pricingMultiplier: decimal(root?.pricing_multiplier),
    energyRateUsdPerKwh: decimal(root?.energy_rate_usd_per_kwh),
    measurementAvailable: typeof energy?.measurement_available === 'boolean'
      ? energy.measurement_available
      : undefined,
  };
}

export async function createNeuralwattLanguageModel(input: {
  readonly modelId: string;
  readonly apiKey: string;
}): Promise<LanguageModelV4> {
  const { createOpenAICompatible } = await importESM<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
  return createOpenAICompatible({
    name: 'neuralwatt',
    baseURL: NEURALWATT_API_ORIGIN,
    apiKey: input.apiKey,
    fetch: createUnwrappingFetch(),
  })(input.modelId);
}

function apiKeyForDriver(credential: { kind: string; apiKey?: string }): string {
  if (credential.kind === 'api-key') return credential.apiKey ?? '';
  return '';
}

export function createNeuralwattProviderDriver(): ProviderDriver {
  return {
    id: 'neuralwatt',
    supportedAuthMethods: ['api-key', 'environment'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomEndpoint: false,
    origin: NEURALWATT_API_ORIGIN,
    createLanguageModel: async ({ model, credential }) => {
      if (model.protocol !== 'openai-compatible') {
        throw new Error('Neuralwatt requires the OpenAI-compatible protocol');
      }
      return createNeuralwattLanguageModel({
        modelId: model.id,
        apiKey: apiKeyForDriver(credential),
      });
    },
    pricingFacet: {
      costEvidence: ({ headers, rawUsage }) => {
        const neural = extractNeuralwattBillingEvidence(new Headers(headers), rawUsage);
        return {
          ...(neural.reportedCostUsd ? { reportedCostAmount: neural.reportedCostUsd, reportedCurrency: 'USD' } : {}),
          ...(neural.accountingMethod ? { accountingMethod: neural.accountingMethod } : {}),
          ...(neural.energyRateUsdPerKwh ? { energyRateUsdPerKwh: neural.energyRateUsdPerKwh } : {}),
          ...(neural.accountingMethod ? { currency: 'USD' } : {}),
          ...(neural.energyKwhConsumed ? { energyKwhConsumed: neural.energyKwhConsumed } : {}),
          ...(neural.energyKwhCharged ? { energyKwhCharged: neural.energyKwhCharged } : {}),
          ...(neural.pricingMultiplier ? { pricingMultiplier: neural.pricingMultiplier } : {}),
          providerEvidence: { ...neural },
        };
      },
    },
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function nested(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Parse quota/accounting metadata while deliberately omitting key/account identifiers. */
export function parseNeuralwattQuotaStatus(value: unknown, now = new Date()): ProviderStatusObservation {
  const root = nested(value);
  if (!root) throw new StatusRefreshError('Neuralwatt quota response must be an object', { kind: 'schema' });
  const balance = nested(root['balance']);
  const usage = nested(root['usage']);
  const currentMonth = nested(usage?.['current_month']);
  const limits = nested(root['limits']);
  const subscription = nested(root['subscription']);
  const providerUpdatedAt = timestamp(root['snapshot_at']);
  const accountingMethod = balance?.['accounting_method'];
  if (accountingMethod !== 'energy' && accountingMethod !== 'token') {
    throw new StatusRefreshError('Neuralwatt quota response has no valid accounting method', { kind: 'schema' });
  }
  return {
    providerId: 'neuralwatt',
    observedAt: now.toISOString(),
    providerUpdatedAt,
    availability: 'available',
    stale: providerUpdatedAt === null,
    data: {
      accountingMethod,
      creditsRemainingUsd: finiteNumber(balance?.['credits_remaining_usd']),
      totalCreditsUsd: finiteNumber(balance?.['total_credits_usd']),
      creditsUsedUsd: finiteNumber(balance?.['credits_used_usd']),
      currentMonth: {
        costUsd: finiteNumber(currentMonth?.['cost_usd']),
        requests: finiteNumber(currentMonth?.['requests']),
        tokens: finiteNumber(currentMonth?.['tokens']),
        energyKwh: finiteNumber(currentMonth?.['energy_kwh']),
      },
      rateLimitTier: typeof limits?.['rate_limit_tier'] === 'string' ? limits['rate_limit_tier'] : null,
      overageLimitUsd: finiteNumber(limits?.['overage_limit_usd']),
      subscription: subscription ? {
        plan: typeof subscription['plan'] === 'string' ? subscription['plan'] : null,
        status: typeof subscription['status'] === 'string' ? subscription['status'] : null,
        currentPeriodEnd: timestamp(subscription['current_period_end']),
        kwhIncluded: finiteNumber(subscription['kwh_included']),
        kwhUsed: finiteNumber(subscription['kwh_used']),
        kwhRemaining: finiteNumber(subscription['kwh_remaining']),
        inOverage: typeof subscription['in_overage'] === 'boolean' ? subscription['in_overage'] : null,
      } : null,
    },
  };
}

export async function fetchNeuralwattQuotaStatus(options: {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ProviderStatusObservation> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? NEURALWATT_STATUS_REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetchImpl(NEURALWATT_QUOTA_URL, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    signal,
  });
  if (!response.ok) {
    throw new StatusRefreshError(`Neuralwatt quota request failed with HTTP ${response.status}`, {
      statusCode: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new StatusRefreshError('Neuralwatt quota response was not valid JSON', { kind: 'schema' });
  }
  return parseNeuralwattQuotaStatus(payload, now());
}

/** Account-scoped caller supplies the secret only in the trusted main process. */
export function createNeuralwattStatusSource(connectionId: string, apiKey: string): ProviderStatusSource {
  return {
    providerId: 'neuralwatt',
    connectionId,
    ttlMs: NEURALWATT_STATUS_TTL_MS,
    minimumManualRefreshMs: NEURALWATT_STATUS_MINIMUM_MANUAL_REFRESH_MS,
    fetchStatus: async () => ({
      ...await fetchNeuralwattQuotaStatus({ apiKey }),
      connectionId,
    }),
  };
}
