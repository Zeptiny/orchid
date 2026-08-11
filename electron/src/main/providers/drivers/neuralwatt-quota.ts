import type { ProviderQuota } from '../../../shared/types/provider-facets';
import type {
  DriverQuotaRequest,
  ProviderDriver,
} from './types';
import { observationWithQuota } from '../facets/quota';
import type { ProviderStatusObservation } from '../status/cache';
import { parseRetryAfter, StatusRefreshError, type ProviderStatusSource } from '../status/service';

/** Code-owned Neuralwatt quota endpoint (documented), shared with the driver. */
const NEURALWATT_QUOTA_URL = 'https://api.neuralwatt.com/v1/quota';

export const NEURALWATT_QUOTA_TTL_MS = 5 * 60_000;
export const NEURALWATT_QUOTA_MINIMUM_MANUAL_REFRESH_MS = 30_000;
export const NEURALWATT_QUOTA_REQUEST_TIMEOUT_MS = 15_000;

function decimalText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function nested(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Parse the documented Neuralwatt quota payload into the untyped account
 * observation (accounting/balance/subscription fields), deliberately omitting
 * key/account identifiers. This is the typed facet's raw status surface.
 */
export function parseNeuralwattQuotaObservation(value: unknown, now = new Date()): ProviderStatusObservation {
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

/**
 * Fetch the Neuralwatt quota payload with the account credential, in the
 * trusted main process only.
 */
export async function fetchNeuralwattQuotaObservation(options: {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ProviderStatusObservation> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? NEURALWATT_QUOTA_REQUEST_TIMEOUT_MS);
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
  return parseNeuralwattQuotaObservation(payload, now());
}

/**
 * Map the driver's documented quota observation into the typed quota contract
 * (R24). Balances keep provider-native units (USD credits, kWh); the key
 * allowance mirrors Neuralwatt's documented blocked state. Unknown raw values
 * surface as unknown/absent, never fabricated (R4).
 */
export function quotaFromNeuralwattObservation(
  observation: ProviderStatusObservation,
): ProviderQuota {
  const data = nested(observation.data);
  const balances: ProviderQuota['balances'] = [];
  const creditsRemaining = decimalText(data?.['creditsRemainingUsd']);
  if (creditsRemaining !== null) {
    balances.push({ label: 'Credits remaining', amount: creditsRemaining, unit: 'USD' });
  }
  const creditsUsed = decimalText(data?.['creditsUsedUsd']);
  if (creditsUsed !== null) {
    balances.push({ label: 'Credits used', amount: creditsUsed, unit: 'USD' });
  }
  const overageLimit = decimalText(data?.['overageLimitUsd']);
  if (overageLimit !== null) {
    balances.push({ label: 'Overage limit', amount: overageLimit, unit: 'USD' });
  }

  const subscriptionData = nested(data?.['subscription']);
  let subscription: ProviderQuota['subscription'] = null;
  if (subscriptionData) {
    const status = text(subscriptionData['status']);
    const plan = text(subscriptionData['plan']);
    const renewsAt = timestamp(subscriptionData['currentPeriodEnd']);
    subscription = {
      state: status === 'active' || status === 'trialing' || status === 'past-due'
        || status === 'cancelled' || status === 'expired'
        ? status
        : 'unknown',
      ...(plan !== null ? { displayName: plan } : {}),
      ...(renewsAt !== null ? { renewsAt } : {}),
    };
    const included = decimalText(subscriptionData['kwhIncluded']);
    if (included !== null) {
      balances.push({ label: 'Subscription energy included', amount: included, unit: 'kWh' });
    }
    const remaining = decimalText(subscriptionData['kwhRemaining']);
    if (remaining !== null) {
      balances.push({ label: 'Subscription energy remaining', amount: remaining, unit: 'kWh' });
    }
  }

  const inOverage = subscriptionData?.['inOverage'];
  const allowances: ProviderQuota['allowances'] = [{
    label: 'API key',
    state: inOverage === true
      ? 'limited'
      : observation.availability === 'unavailable'
        ? 'blocked'
        : subscription?.state === 'past-due' || subscription?.state === 'expired' || subscription?.state === 'cancelled'
          ? 'blocked'
          : subscriptionData
            ? 'available'
            : 'unknown',
  }];

  return {
    observedAt: observation.providerUpdatedAt ?? observation.observedAt,
    balances,
    subscription,
    allowances,
  };
}

/**
 * Fetch typed quota for one Neuralwatt connection. The typed result folds into
 * the existing quota observation; a fetch failure must surface as a
 * stale/unavailable status observation through the status service, never as a
 * request-path error (R25).
 */
export async function fetchNeuralwattQuota(
  request: DriverQuotaRequest,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ProviderQuota> {
  if (request.credential.kind !== 'api-key') {
    throw new Error('Neuralwatt quota requires an API key credential');
  }
  const observation = await fetchNeuralwattQuotaObservation({
    apiKey: request.credential.apiKey,
    fetch: options.fetch,
    now: options.now,
    signal: options.signal,
  });
  return quotaFromNeuralwattObservation(observation);
}

/**
 * Additive wiring seam: the sibling tier/cache work owns neuralwatt.ts. This
 * property object is merged onto the driver at the bottom of its definition as
 * `quotaFacet: neuralwattQuotaFacet(options)` — a single disjoint hunk.
 */
export function neuralwattQuotaFacet(options: {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
} = {}): NonNullable<ProviderDriver['quotaFacet']> {
  return {
    fetchQuota: (request) => fetchNeuralwattQuota(request, {
      fetch: options.fetch,
      now: options.now,
    }),
  };
}

/**
 * Account-scoped status source carrying typed quota alongside the untyped
 * observation. It deliberately receives the API key only in the trusted main
 * process, and its result remains informational for status surfaces only.
 */
export function createNeuralwattQuotaStatusSource(
  connectionId: string,
  apiKey: string,
): ProviderStatusSource {
  return {
    providerId: 'neuralwatt',
    connectionId,
    ttlMs: NEURALWATT_QUOTA_TTL_MS,
    minimumManualRefreshMs: NEURALWATT_QUOTA_MINIMUM_MANUAL_REFRESH_MS,
    fetchStatus: async () => {
      const observation = await fetchNeuralwattQuotaObservation({ apiKey });
      return {
        ...observationWithQuota(observation, quotaFromNeuralwattObservation(observation)),
        connectionId,
      };
    },
  };
}
