/**
 * Provider resolution — maps provider aliases to AI SDK provider objects.
 *
 * Replicates Python `resolve_model_ref` (providers.py:93-123) but maps to
 * AI SDK providers instead of litellm.
 *
 * Provider mapping:
 * - `openai` or no provider → `@ai-sdk/openai` (direct) or
 *   `@ai-sdk/openai-compatible` (custom base_url)
 * - `anthropic` → `@ai-sdk/anthropic`
 * - `google` / `gemini` → `@ai-sdk/google`
 * - `groq` → `@ai-sdk/groq`
 * - `xai` → `@ai-sdk/xai`
 * - Any other → `@ai-sdk/openai-compatible` (assumes OpenAI-compatible API)
 *
 * The TS config uses a `provider` field or infers from `base_url`.
 */
import type { Config } from '../config/schema';
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
// Provider inference
// ---------------------------------------------------------------------------

/**
 * Known provider names that map directly to AI SDK providers.
 */
const KNOWN_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'gemini',
  'groq',
  'xai',
]);

/**
 * Infer the provider name from a base URL.
 * Used when no explicit `provider` field is set in the config.
 */
function inferProviderFromUrl(baseUrl: string): string {
  const url = baseUrl.toLowerCase();

  if (url.includes('openai.com') || url.includes('api.openai.com')) {
    return 'openai';
  }
  if (url.includes('anthropic.com') || url.includes('api.anthropic.com')) {
    return 'anthropic';
  }
  if (url.includes('googleapis.com') || url.includes('google.com')) {
    return 'google';
  }
  if (url.includes('groq.com') || url.includes('api.groq.com')) {
    return 'groq';
  }
  if (url.includes('xai.com') || url.includes('api.xai.com')) {
    return 'xai';
  }

  // Default to openai-compatible for unknown URLs
  return 'openai-compatible';
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model reference to an AI SDK-compatible configuration.
 *
 * Input format: `alias/model` (e.g., `work-openai/gpt-4o`, `anthropic/claude-3-5-sonnet`)
 *
 * The resolution logic:
 * 1. Split the reference into alias and model_id
 * 2. Look up the alias in config.providers
 * 3. Determine the provider name (explicit field or inferred from base_url)
 * 4. Return the resolved reference with provider details
 *
 * @param aliasModel - The model reference in `alias/model` format
 * @param config - The application config containing provider definitions
 * @returns Resolved model reference for AI SDK
 * @throws ProviderResolutionError if the reference cannot be resolved
 */
export function resolveModelRef(
  aliasModel: string,
  config: Config,
): ResolvedModelRef {
  // Split alias/model
  const slashIndex = aliasModel.indexOf('/');
  if (slashIndex === -1) {
    throw new ProviderResolutionError(
      `Model reference '${aliasModel}' must be in 'alias/model' form`,
    );
  }

  const alias = aliasModel.slice(0, slashIndex);
  const modelId = aliasModel.slice(slashIndex + 1);

  if (!alias || !modelId) {
    throw new ProviderResolutionError(
      `Model reference '${aliasModel}' has an empty alias or model id; ` +
        "expected 'alias/model' with both parts non-empty",
    );
  }

  // Look up provider config
  const providerConfig = config.providers[alias];
  if (!providerConfig) {
    throw new ProviderResolutionError(
      `Unknown provider alias '${alias}'; not present in config providers`,
    );
  }

  // Extract provider settings
  const baseUrl = (providerConfig.base_url as string) || undefined;
  const apiKey = resolveApiKey(providerConfig, alias);
  const explicitProvider = (providerConfig.provider as string) ||
    (providerConfig.litellm_provider as string) ||
    undefined;

  // Determine the provider name
  let providerName: string;
  if (explicitProvider && KNOWN_PROVIDERS.has(explicitProvider)) {
    providerName = explicitProvider;
  } else if (baseUrl) {
    providerName = inferProviderFromUrl(baseUrl);
  } else {
    // No base_url and no explicit provider — assume direct OpenAI
    providerName = 'openai';
  }

  // Determine if we should use the compatible provider
  // Use openai-compatible when:
  // - Provider is explicitly 'openai-compatible'
  // - Provider is 'openai' but has a custom base_url
  // - Provider is unknown (not in KNOWN_PROVIDERS)
  const useCompatible =
    providerName === 'openai-compatible' ||
    (providerName === 'openai' && !!baseUrl) ||
    (!KNOWN_PROVIDERS.has(providerName) && providerName !== 'openai');

  return {
    providerName: useCompatible ? 'openai-compatible' : providerName,
    modelId,
    baseUrl,
    apiKey,
    useCompatible,
  };
}

/**
 * Resolve an API key from provider config.
 * Matches Python `_resolve_api_key` (providers.py:66-90).
 *
 * Resolution order:
 * 1. Literal `api_key` field
 * 2. Environment variable named by `api_key_env`
 * 3. undefined (let AI SDK use its own detection)
 */
function resolveApiKey(
  providerConfig: Record<string, unknown>,
  alias: string,
): string | undefined {
  // 1. Literal api_key
  const literalKey = providerConfig.api_key;
  if (typeof literalKey === 'string' && literalKey) {
    return literalKey;
  }

  // 2. Environment variable
  const apiKeyEnv = providerConfig.api_key_env;
  if (typeof apiKeyEnv === 'string' && apiKeyEnv) {
    const value = process.env[apiKeyEnv];
    if (value) {
      return value;
    }
    // Treat unset/empty env vars as missing
    console.debug(
      `Provider '${alias}': env var '${apiKeyEnv}' is unset or empty; ` +
        'letting AI SDK fall back to its default API key detection',
    );
  }

  // 3. undefined — let AI SDK handle it
  return undefined;
}

/**
 * Get the default model reference from config.
 * Returns the full `alias/model` string (e.g., 'default/mimo-v2.5').
 */
export function getDefaultModelRef(config: Config): string {
  return config.default_model;
}

/**
 * Get the model reference for a specific tier.
 * Returns the full `alias/model` string.
 */
export function getModelForTier(config: Config, tier: string): string {
  return config.tier_models[tier] || config.default_model;
}
