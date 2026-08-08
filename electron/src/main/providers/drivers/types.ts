import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { JSONValue } from 'ai';
import type {
  DiscoveredProviderModel,
  EffectiveModel,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderDefinition,
  ProviderProtocol,
} from '../../../shared/types/provider';
import type {
  CacheFacet,
  CurrencyUnit,
  ProviderModelRateCard,
  ProviderQuota,
  ThinkingPolicy,
  TierMechanism,
} from '../../../shared/types/provider-facets';

export type ReasoningProviderOptions = Record<string, Record<string, JSONValue>>;

/** Only the request credential needed by an adapter, never a vault record. */
export type DriverCredential =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'none' };

export interface DriverModelRequest {
  readonly connection: ProviderConnection;
  readonly provider: ProviderDefinition;
  readonly model: EffectiveModel;
  readonly credential: DriverCredential;
  /** Present only for generic drivers after URL validation. */
  readonly endpoint?: string;
}

/**
 * Main-process-only target for Orchid's OpenAI-compatible embedding client.
 * It is deliberately constructed by trusted driver code rather than from a
 * renderer/model alias, and never crosses the IPC boundary.
 */
export interface ProviderEmbeddingTarget {
  readonly baseURL: string;
  readonly apiKey: string | undefined;
}

/** Pricing metadata: native billing unit plus an optional dynamic-rate hook. */
export interface DriverPricingFacet {
  /** Native billing unit for non-fiat providers (R8); fiat providers omit this. */
  readonly currencyUnit?: CurrencyUnit;
  /** Dynamic rates refresh in the background on a declared cadence (R7). */
  readonly dynamic?: {
    readonly refreshIntervalSeconds: number;
    readonly fetchRates: (request: DriverModelRequest) => Promise<readonly ProviderModelRateCard[]>;
  };
}

/** Typed quota/subscription state in provider-native units (R24). */
export interface DriverQuotaFacet {
  readonly fetchQuota: (request: DriverModelRequest) => Promise<ProviderQuota>;
}

/** Live model discovery from the provider's models endpoint (R26). */
export interface DriverDiscoveryFacet {
  readonly fetchModels: (request: DriverModelRequest) => Promise<readonly DiscoveredProviderModel[]>;
}

/**
 * Trusted driver code owns credentials, request construction, and API origins.
 * Remote catalog data selects only the declared ID/protocol/capability data.
 * Every capability facet is optional: a driver implements only the facets it
 * supports, and each facet exposes typed metadata (R1, R2, R4).
 */
export interface ProviderDriver {
  readonly id: string;
  readonly supportedAuthMethods: readonly ProviderAuthMethod[];
  readonly supportedProtocols: readonly ProviderProtocol[];
  readonly allowsCustomEndpoint: boolean;
  /** Code-owned API origin for built-in drivers; null for generic drivers. */
  readonly origin: string | null;
  createLanguageModel(request: DriverModelRequest): Promise<LanguageModelV4>;
  /** Present only when the driver supports Orchid's API embedding transport. */
  createEmbeddingTarget?(request: DriverModelRequest): Promise<ProviderEmbeddingTarget>;
  /** Translate a reasoning effort value into provider-native providerOptions. */
  buildReasoningOptions?(effort: string | number, model: EffectiveModel): ReasoningProviderOptions | undefined;
  /** Thinking exposure/replay policy for a model; absent means no policy (R15). */
  readonly thinkingPolicy?: (model: EffectiveModel) => ThinkingPolicy | undefined;
  /** Service-tier mechanism: request parameter or model-name variants (R19). */
  readonly tierMechanism?: TierMechanism;
  /** Pricing metadata and optional dynamic-rate hook (R7, R8, R9). */
  readonly pricingFacet?: DriverPricingFacet;
  /** Prompt-cache capability: placement mode, routing key, TTL options (R10–R12). */
  readonly cacheFacet?: CacheFacet;
  /** Typed quota hook; informational only, never gates routing or sends (R25). */
  readonly quotaFacet?: DriverQuotaFacet;
  /** Live model discovery hook; invoked on demand, never polled (R26). */
  readonly discoveryFacet?: DriverDiscoveryFacet;
}
