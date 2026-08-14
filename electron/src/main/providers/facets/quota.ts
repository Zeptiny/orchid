import {
  providerQuotaSchema,
  type ProviderQuota,
} from '../../../shared/types/provider-facets';
import type {
  DriverCredential,
  DriverQuotaRequest,
  ProviderDriver,
} from '../drivers/types';
import type { ProviderStatusObservation } from '../status/cache';
import { StatusRefreshError } from '../status/service';
import type {
  ProviderConnection,
  ProviderDefinition,
} from '../../../shared/types/provider';

/**
 * Typed quota facet consumption (R24, R25). A driver's fetchQuota result is
 * validated and normalized into the typed portion of one status observation,
 * so the status layer and renderer consume one typed contract instead of
 * untyped observation data (R4). Quota is informational only: this module has
 * no call path into request resolution, routing, or send eligibility.
 */

export interface ConnectionQuotaRequest {
  readonly driver: ProviderDriver;
  readonly connection: ProviderConnection;
  readonly provider: ProviderDefinition;
  readonly credential: DriverCredential;
}

function parseDriverQuota(value: unknown, providerId: string): ProviderQuota {
  const parsed = providerQuotaSchema.safeParse(value);
  if (!parsed.success) {
    throw new StatusRefreshError(
      `Driver '${providerId}' returned quota state that does not match the typed contract`,
      { kind: 'schema' },
    );
  }
  return parsed.data;
}

/**
 * Validate one driver quota response against the typed contract. Callers turn
 * a rejection into a stale/unavailable status observation; quota failures must
 * never propagate into the request path.
 */
export function validateDriverQuota(value: unknown, providerId: string): ProviderQuota {
  return parseDriverQuota(value, providerId);
}

/** Fetch typed quota through the driver's facet, validating its result. */
export async function fetchDriverQuota(request: ConnectionQuotaRequest): Promise<ProviderQuota> {
  const hook = request.driver.quotaFacet?.fetchQuota;
  if (!hook) {
    throw new StatusRefreshError(`Driver '${request.driver.id}' declares no quota facet`, {
      kind: 'unknown',
    });
  }
  const quotaRequest: DriverQuotaRequest = {
    connection: request.connection,
    provider: request.provider,
    credential: request.credential,
  };
  return parseDriverQuota(await hook(quotaRequest), request.driver.id);
}

function freshQuota(quota: ProviderQuota, now: Date): boolean {
  const observedAt = Date.parse(quota.observedAt);
  return !Number.isNaN(observedAt) && observedAt <= now.getTime();
}

/**
 * Fold typed quota into an observation for the status layer. A fresh typed
 * result joins `data.quota`; a missing hook or stale/self-dated result only
 * makes the observation stale — balances from a prior observation are never
 * dropped, and nothing here is read to gate usability or sends.
 */
export function observationWithQuota(
  observation: ProviderStatusObservation,
  quota: ProviderQuota | undefined,
  now = new Date(),
): ProviderStatusObservation {
  if (!quota) return { ...observation, stale: true };
  const data = { ...observation.data, quota };
  if (!freshQuota(quota, now)) {
    return { ...observation, data, stale: true };
  }
  return { ...observation, data };
}
