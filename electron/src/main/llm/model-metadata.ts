/**
 * Model metadata resolution — capabilities and limits for known LLM models.
 *
 * Provides a `resolveModelMetadata()` function that returns display-ready
 * metadata (max tokens, vision support, mode) for a model ref.
 *
 * Model refs from the UI are `alias/model` (same as resolveModelRef). Bare
 * model ids are also accepted for built-in / legacy lookups.
 *
 * Resolution order:
 * 1. Split `alias/model` on the first slash when present
 * 2. Look up bare model id in built-in defaults table
 * 3. Merge per-model overrides from that provider's config
 * 4. Cache the result under the full ref for subsequent lookups
 *
 * Unknown models get safe defaults: null limits, no vision, 'chat' mode.
 * Call `clearModelMetadataCache()` after config saves so overrides refresh.
 */
import type { ModelMetadata } from '../../shared/types/ipc-boundary';
import type { Config } from '../config/schema';

// Re-export for consumers
export type { ModelMetadata } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Default metadata for known models
// ---------------------------------------------------------------------------

/**
 * Built-in metadata for well-known models.
 * Keyed by model ID substring — the resolver does a startsWith/contains match.
 */
const KNOWN_MODELS: Record<string, ModelMetadata> = {
  // ── OpenAI GPT-4 family ─────────────────────────────────────────────────
  'gpt-4o': {
    max_input_tokens: 128_000,
    max_output_tokens: 16_384,
    supports_vision: true,
    mode: 'chat',
  },
  'gpt-4o-mini': {
    max_input_tokens: 128_000,
    max_output_tokens: 16_384,
    supports_vision: true,
    mode: 'chat',
  },
  'gpt-4-turbo': {
    max_input_tokens: 128_000,
    max_output_tokens: 4_096,
    supports_vision: true,
    mode: 'chat',
  },
  'gpt-4': {
    max_input_tokens: 8_192,
    max_output_tokens: 4_096,
    supports_vision: false,
    mode: 'chat',
  },
  'gpt-3.5-turbo': {
    max_input_tokens: 16_385,
    max_output_tokens: 4_096,
    supports_vision: false,
    mode: 'chat',
  },
  'o1': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
    mode: 'chat',
  },
  'o1-mini': {
    max_input_tokens: 128_000,
    max_output_tokens: 65_536,
    supports_vision: false,
    mode: 'chat',
  },
  'o1-pro': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
    mode: 'chat',
  },
  'o3': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
    mode: 'chat',
  },
  'o3-mini': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: false,
    mode: 'chat',
  },
  'o4-mini': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
    mode: 'chat',
  },

  // ── Anthropic Claude family ─────────────────────────────────────────────
  'claude-op-4-20250514': {
    max_input_tokens: 200_000,
    max_output_tokens: 32_000,
    supports_vision: true,
    mode: 'chat',
  },
  'claude-sonnet-4-20250514': {
    max_input_tokens: 200_000,
    max_output_tokens: 16_000,
    supports_vision: true,
    mode: 'chat',
  },
  'claude-3-5-sonnet': {
    max_input_tokens: 200_000,
    max_output_tokens: 8_192,
    supports_vision: true,
    mode: 'chat',
  },
  'claude-3-5-haiku': {
    max_input_tokens: 200_000,
    max_output_tokens: 8_192,
    supports_vision: true,
    mode: 'chat',
  },
  'claude-3-opus': {
    max_input_tokens: 200_000,
    max_output_tokens: 4_096,
    supports_vision: true,
    mode: 'chat',
  },
  'claude-3-sonnet': {
    max_input_tokens: 200_000,
    max_output_tokens: 4_096,
    supports_vision: true,
    mode: 'chat',
  },
  'claude-3-haiku': {
    max_input_tokens: 200_000,
    max_output_tokens: 4_096,
    supports_vision: true,
    mode: 'chat',
  },

  // ── Google Gemini family ────────────────────────────────────────────────
  'gemini-2.5-pro': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 65_536,
    supports_vision: true,
    mode: 'chat',
  },
  'gemini-2.5-flash': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 65_536,
    supports_vision: true,
    mode: 'chat',
  },
  'gemini-2.0-flash': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 8_192,
    supports_vision: true,
    mode: 'chat',
  },
  'gemini-1.5-pro': {
    max_input_tokens: 2_097_152,
    max_output_tokens: 8_192,
    supports_vision: true,
    mode: 'chat',
  },
  'gemini-1.5-flash': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 8_192,
    supports_vision: true,
    mode: 'chat',
  },

  // ── Groq models ─────────────────────────────────────────────────────────
  'llama-3.3-70b-versatile': {
    max_input_tokens: 128_000,
    max_output_tokens: 32_768,
    supports_vision: false,
    mode: 'chat',
  },
  'llama-3.1-8b-instant': {
    max_input_tokens: 128_000,
    max_output_tokens: 8_192,
    supports_vision: false,
    mode: 'chat',
  },
  'mixtral-8x7b-32768': {
    max_input_tokens: 32_768,
    max_output_tokens: 32_768,
    supports_vision: false,
    mode: 'chat',
  },

  // ── xAI Grok ────────────────────────────────────────────────────────────
  'grok-2': {
    max_input_tokens: 131_072,
    max_output_tokens: 131_072,
    supports_vision: false,
    mode: 'chat',
  },
  'grok-2-vision': {
    max_input_tokens: 131_072,
    max_output_tokens: 131_072,
    supports_vision: true,
    mode: 'chat',
  },
  'grok-3': {
    max_input_tokens: 131_072,
    max_output_tokens: 131_072,
    supports_vision: false,
    mode: 'chat',
  },

  // ── OpenCode / mimo ─────────────────────────────────────────────────────
  'mimo-v2.5': {
    max_input_tokens: 131_072,
    max_output_tokens: 32_768,
    supports_vision: false,
    mode: 'chat',
  },
};

// ---------------------------------------------------------------------------
// Metadata cache
// ---------------------------------------------------------------------------

const metadataCache = new Map<string, ModelMetadata>();

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Default metadata returned for unknown models.
 * Null limits mean "no known limit" — callers should handle gracefully.
 */
const DEFAULT_METADATA: ModelMetadata = {
  max_input_tokens: null,
  max_output_tokens: null,
  supports_vision: false,
  mode: 'chat',
};

/**
 * Split a model ref into provider alias and bare model id.
 *
 * UI / session model ids are `alias/model` (first slash only), matching
 * `resolveModelRef`. Bare ids (no slash) are returned as-is with a null alias.
 * Model ids that themselves contain slashes (e.g. `cline-pass/mimo-v2.5`)
 * remain intact after the first slash: `cline/cline-pass/mimo-v2.5`.
 */
export function splitProviderModelRef(ref: string): {
  alias: string | null;
  modelId: string;
} {
  const slashIndex = ref.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= ref.length - 1) {
    return { alias: null, modelId: ref };
  }
  return {
    alias: ref.slice(0, slashIndex),
    modelId: ref.slice(slashIndex + 1),
  };
}

/**
 * Find the best matching built-in metadata for a bare model ID.
 * Tries exact match first, then prefix match (longest prefix wins).
 */
function findBuiltInMetadata(modelId: string): ModelMetadata | null {
  // Exact match
  if (modelId in KNOWN_MODELS) {
    return KNOWN_MODELS[modelId];
  }

  // Prefix match — longest prefix wins
  let bestMatch: ModelMetadata | null = null;
  let bestLength = 0;

  for (const [key, meta] of Object.entries(KNOWN_MODELS)) {
    if (modelId.startsWith(key) && key.length > bestLength) {
      bestMatch = meta;
      bestLength = key.length;
    }
  }

  return bestMatch;
}

/**
 * Extract per-model overrides from provider config.
 *
 * When `alias` is set (from `alias/model` refs used by pickers), only that
 * provider's models dict is consulted — so two providers with the same bare
 * model id keep independent overrides.
 *
 * Without an alias, scans all providers and returns the first match (legacy
 * bare-id lookups). Prefer alias-qualified refs from the UI.
 *
 * Override fields: `{ max_input_tokens, max_output_tokens, supports_vision, mode }`
 */
function findConfigOverrides(
  modelId: string,
  config: Config,
  alias: string | null,
): Partial<ModelMetadata> | null {
  const providers = config.providers;
  if (!providers || typeof providers !== 'object') {
    return null;
  }

  if (alias != null) {
    const provider = providers[alias];
    if (typeof provider !== 'object' || provider === null) {
      return null;
    }
    return readModelOverride(provider as Record<string, unknown>, modelId);
  }

  // Bare model id: scan providers (order is object key order). Prefer
  // alias-qualified refs so same-id models under different providers do not
  // collide.
  for (const provider of Object.values(providers)) {
    if (typeof provider !== 'object' || provider === null) continue;
    const entry = readModelOverride(provider as Record<string, unknown>, modelId);
    if (entry) return entry;
  }

  return null;
}

function readModelOverride(
  provider: Record<string, unknown>,
  modelId: string,
): Partial<ModelMetadata> | null {
  const models = provider.models;
  if (typeof models !== 'object' || models === null) return null;

  const entry = (models as Record<string, unknown>)[modelId];
  if (typeof entry === 'object' && entry !== null) {
    return entry as Partial<ModelMetadata>;
  }
  return null;
}

/**
 * Resolve model metadata for a given model ref.
 *
 * Resolution order:
 * 1. Cache hit → return cached result
 * 2. Split `alias/model` (first slash) when present
 * 3. Built-in defaults for the bare model id
 * 4. Per-model overrides from that provider's config (or any provider if bare)
 * 5. Merge: built-in defaults ← config overrides
 * 6. Cache and return
 *
 * Unknown models get safe defaults: null limits, no vision, 'chat' mode.
 *
 * @param modelRef - Bare model id or `alias/model` (e.g. `default/mimo-v2.5`)
 * @param config - The application config (for provider overrides)
 * @returns ModelMetadata with all fields populated (nulls for unknown limits)
 */
export function resolveModelMetadata(
  modelRef: string,
  config: Config,
): ModelMetadata {
  // Check cache (keyed by full ref so provider-specific overrides stay distinct)
  const cached = metadataCache.get(modelRef);
  if (cached) return cached;

  const { alias, modelId } = splitProviderModelRef(modelRef);

  // Find built-in defaults from bare model id
  const builtIn = findBuiltInMetadata(modelId);

  // Find config overrides for this provider + model
  const overrides = findConfigOverrides(modelId, config, alias);

  // Merge: built-in defaults (or DEFAULT) ← config overrides
  const base = builtIn ?? { ...DEFAULT_METADATA };
  const merged: ModelMetadata = {
    max_input_tokens:
      overrides?.max_input_tokens !== undefined
        ? overrides.max_input_tokens
        : base.max_input_tokens,
    max_output_tokens:
      overrides?.max_output_tokens !== undefined
        ? overrides.max_output_tokens
        : base.max_output_tokens,
    supports_vision:
      overrides?.supports_vision !== undefined
        ? overrides.supports_vision
        : base.supports_vision,
    mode: overrides?.mode !== undefined ? overrides.mode : base.mode,
  };

  // Cache the result under the full ref
  metadataCache.set(modelRef, merged);

  return merged;
}

/**
 * Clear the metadata cache. Useful when config changes.
 */
export function clearModelMetadataCache(): void {
  metadataCache.clear();
}

/**
 * Get all known model IDs. Useful for UI model pickers.
 */
export function getKnownModelIds(): string[] {
  return Object.keys(KNOWN_MODELS);
}
