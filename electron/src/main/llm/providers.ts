/**
 * Provider-selection compatibility helpers.
 *
 * U1 intentionally retires the development-era `alias/model` resolver. A
 * request must carry a connection-scoped ModelSelection and is resolved by a
 * trusted driver registry in U4. Keeping an explicit fail-closed export here
 * prevents overlooked legacy callers from silently selecting an account.
 */
import type { Config } from '../config/schema';
import type { ModelSelection } from '../../shared/types/provider';
import { ProviderResolutionError } from './middleware/error-classification';

// Re-export for consumers
export { ProviderResolutionError } from './middleware/error-classification';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolved model reference ready for AI SDK consumption.
 */
export interface ResolvedModelRef {
  /** The AI SDK provider name (e.g., 'openai', 'anthropic'). */
  providerName: string;
  /** The model ID (e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022'). */
  modelId: string;
  /** The base URL for the API, if custom. */
  baseUrl?: string;
  /** The API key, if resolved. */
  apiKey?: string;
  /** Whether to use the openai-compatible provider. */
  useCompatible: boolean;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Fail closed for a retired `alias/model` reference. This temporary export is
 * retained only to make legacy callers fail safely while U4 moves them to the
 * typed driver registry.
 */
export function resolveModelRef(
  _legacyAliasModel: string,
  _config: Config,
): never {
  throw new ProviderResolutionError(
    'A provider connection and typed model selection are required before Orchid can send this request.',
  );
}

/**
 * Get the default model reference from config.
 * Returns a connection-scoped selection, or null when no connection is set.
 */
export function getDefaultModelRef(config: Config): ModelSelection | null {
  return config.default_model;
}

/**
 * Get the model reference for a specific tier.
 * Returns a connection-scoped selection, or null when no tier/default is set.
 */
export function getModelForTier(config: Config, tier: string): ModelSelection | null {
  return config.tier_models[tier] || config.default_model;
}

// ---------------------------------------------------------------------------
// Model endpoint discovery
// ---------------------------------------------------------------------------

/**
 * A discovered model from a provider's `GET /models` endpoint.
 */
export interface DiscoveredModel {
  /** The model ID (e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022'). */
  id: string;
  /** Optional human-readable name. */
  name?: string;
  /** Optional model owner/organization. */
  owned_by?: string;
}

/** Discovery is disabled until U8 exposes connection-scoped provider IPC. */
export function resetDiscoveryCache(): void {}

/** Legacy aliases must not issue model-discovery requests. */
export function discoverModels(
  _alias: string,
  _config: Config,
  _force = false,
): DiscoveredModel[] {
  return [];
}

/** Legacy aliases must not issue model-discovery requests. */
export async function discoverModelsAsync(
  _alias: string,
  _config: Config,
  _force = false,
): Promise<DiscoveredModel[]> {
  return [];
}

/** Legacy aliases must not issue model-discovery requests. */
export async function discoverAllModels(
  _config: Config,
  _force = false,
): Promise<Record<string, DiscoveredModel[]>> {
  return {};
}
