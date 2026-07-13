import type { LanguageModelV4 } from '@ai-sdk/provider';
import type {
  EffectiveModel,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderDefinition,
  ProviderProtocol,
} from '../../../shared/types/provider';

/** Only the request credential needed by an adapter, never a vault record. */
export type DriverCredential =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'oauth'; readonly accessToken: string }
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

/**
 * Trusted driver code owns credentials, request construction, and API origins.
 * Remote catalog data selects only the declared ID/protocol/capability data.
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
}
