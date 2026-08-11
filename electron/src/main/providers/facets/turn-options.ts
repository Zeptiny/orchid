/**
 * Turn-level facet provider-options assembly shared by the main-agent and
 * subagent turn paths. Thinking request knobs, the service tier, and the
 * cache options merge in one fixed order over the caller's reasoning-effort
 * options; the caller resolves the effective tier (session override →
 * connection selection) and passes it in.
 */
import type { CacheFacet, ThinkingPolicy, TierMechanism } from '../../../shared/types/provider-facets';
import type { ReasoningProviderOptions } from '../drivers/types';
import {
  buildCacheProviderOptions,
  deriveCacheSessionKey,
  resolveCacheTtl,
} from './cache';
import { buildThinkingRequestOptions, mergeProviderOptions } from './thinking';
import { buildTierProviderOptions } from './tiers';

/** Resolved execution context feeding the facet assembly for one turn. */
export interface AssembleFacetProviderOptionsInput {
  /** Reasoning-effort options resolved by the caller; undefined when absent. */
  readonly providerOptions: ReasoningProviderOptions | undefined;
  /** Thinking policy resolved for the frozen model; absent drivers skip knobs. */
  readonly thinkingPolicy: ThinkingPolicy | undefined;
  /** Provider id from the frozen snapshot — namespaces the thinking knobs. */
  readonly providerId: string;
  /** Effective service tier already resolved by the caller. */
  readonly tierId: string | undefined;
  readonly tierMechanism: TierMechanism | undefined;
  readonly cacheFacet: CacheFacet | undefined;
  /** User TTL selection from the connection, validated against the facet. */
  readonly cacheTtlSelection: string | undefined;
  /** Session id for the stable cache/routing key. */
  readonly sessionId: string | undefined;
}

export interface AssembleFacetProviderOptionsResult {
  readonly providerOptions: ReasoningProviderOptions | undefined;
  readonly cacheSessionKey: string | undefined;
  readonly cacheTtl: string | undefined;
}

/** Assemble the facet provider options for one turn in the fixed merge order. */
export function assembleFacetProviderOptions(
  input: AssembleFacetProviderOptionsInput,
): AssembleFacetProviderOptionsResult {
  let providerOptions = input.providerOptions;
  if (input.thinkingPolicy) {
    providerOptions = mergeProviderOptions(
      providerOptions,
      buildThinkingRequestOptions(input.thinkingPolicy, input.providerId),
    );
  }
  providerOptions = mergeProviderOptions(
    providerOptions,
    buildTierProviderOptions(input.tierMechanism, input.tierId),
  );
  const cacheSessionKey = deriveCacheSessionKey(input.sessionId);
  const cacheTtl = resolveCacheTtl(input.cacheFacet, input.cacheTtlSelection);
  providerOptions = mergeProviderOptions(
    providerOptions,
    buildCacheProviderOptions(input.cacheFacet, cacheSessionKey),
  );
  return { providerOptions, cacheSessionKey, cacheTtl };
}
