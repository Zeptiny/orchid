/**
 * Model metadata resolution — capabilities and limits for known LLM models.
 *
 * Provides a `resolveModelMetadata()` function that returns display-ready
 * metadata (max tokens and vision support) for a model ID.
 *
 * Model IDs are opaque provider-owned strings. A model ID may contain `/`, so
 * this compatibility lookup never tries to infer a provider alias from it.
 *
 * Resolution order:
 * 1. Look up the complete model ID in built-in defaults table
 * 2. Cache the result under the complete ID for subsequent lookups
 *
 * Unknown models get safe defaults: null limits, no vision.
 * Call `clearModelMetadataCache()` after config saves so overrides refresh.
 */
import type { ModelMetadata } from '../../shared/types/ipc-boundary';

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
  },
  'gpt-4o-mini': {
    max_input_tokens: 128_000,
    max_output_tokens: 16_384,
    supports_vision: true,
  },
  'gpt-4-turbo': {
    max_input_tokens: 128_000,
    max_output_tokens: 4_096,
    supports_vision: true,
  },
  'gpt-4': {
    max_input_tokens: 8_192,
    max_output_tokens: 4_096,
    supports_vision: false,
  },
  'gpt-3.5-turbo': {
    max_input_tokens: 16_385,
    max_output_tokens: 4_096,
    supports_vision: false,
  },
  'o1': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
  },
  'o1-mini': {
    max_input_tokens: 128_000,
    max_output_tokens: 65_536,
    supports_vision: false,
  },
  'o1-pro': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
  },
  'o3': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
  },
  'o3-mini': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: false,
  },
  'o4-mini': {
    max_input_tokens: 200_000,
    max_output_tokens: 100_000,
    supports_vision: true,
  },

  // ── Anthropic Claude family ─────────────────────────────────────────────
  'claude-op-4-20250514': {
    max_input_tokens: 200_000,
    max_output_tokens: 32_000,
    supports_vision: true,
  },
  'claude-sonnet-4-20250514': {
    max_input_tokens: 200_000,
    max_output_tokens: 16_000,
    supports_vision: true,
  },
  'claude-3-5-sonnet': {
    max_input_tokens: 200_000,
    max_output_tokens: 8_192,
    supports_vision: true,
  },
  'claude-3-5-haiku': {
    max_input_tokens: 200_000,
    max_output_tokens: 8_192,
    supports_vision: true,
  },
  'claude-3-opus': {
    max_input_tokens: 200_000,
    max_output_tokens: 4_096,
    supports_vision: true,
  },
  'claude-3-sonnet': {
    max_input_tokens: 200_000,
    max_output_tokens: 4_096,
    supports_vision: true,
  },
  'claude-3-haiku': {
    max_input_tokens: 200_000,
    max_output_tokens: 4_096,
    supports_vision: true,
  },

  // ── Google Gemini family ────────────────────────────────────────────────
  'gemini-2.5-pro': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 65_536,
    supports_vision: true,
  },
  'gemini-2.5-flash': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 65_536,
    supports_vision: true,
  },
  'gemini-2.0-flash': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 8_192,
    supports_vision: true,
  },
  'gemini-1.5-pro': {
    max_input_tokens: 2_097_152,
    max_output_tokens: 8_192,
    supports_vision: true,
  },
  'gemini-1.5-flash': {
    max_input_tokens: 1_048_576,
    max_output_tokens: 8_192,
    supports_vision: true,
  },

  // ── Groq models ─────────────────────────────────────────────────────────
  'llama-3.3-70b-versatile': {
    max_input_tokens: 128_000,
    max_output_tokens: 32_768,
    supports_vision: false,
  },
  'llama-3.1-8b-instant': {
    max_input_tokens: 128_000,
    max_output_tokens: 8_192,
    supports_vision: false,
  },
  'mixtral-8x7b-32768': {
    max_input_tokens: 32_768,
    max_output_tokens: 32_768,
    supports_vision: false,
  },

  // ── xAI Grok ────────────────────────────────────────────────────────────
  'grok-2': {
    max_input_tokens: 131_072,
    max_output_tokens: 131_072,
    supports_vision: false,
  },
  'grok-2-vision': {
    max_input_tokens: 131_072,
    max_output_tokens: 131_072,
    supports_vision: true,
  },
  'grok-3': {
    max_input_tokens: 131_072,
    max_output_tokens: 131_072,
    supports_vision: false,
  },

  // ── OpenCode / mimo ─────────────────────────────────────────────────────
  'mimo-v2.5': {
    max_input_tokens: 131_072,
    max_output_tokens: 32_768,
    supports_vision: false,
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
};

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
 * Resolve model metadata for a complete opaque model ID.
 *
 * Resolution order:
 * 1. Cache hit → return cached result
 * 2. Built-in defaults for that complete model ID
 * 3. Cache and return
 *
 * Unknown models get safe defaults: null limits, no vision.
 *
 * @param modelId - Opaque provider model ID
 * @returns ModelMetadata with all fields populated (nulls for unknown limits)
 */
export function resolveModelMetadata(
  modelId: string,
): ModelMetadata {
  // Check cache keyed by the complete opaque model ID.
  const cached = metadataCache.get(modelId);
  if (cached) return cached;

  // Find built-in defaults from the complete model ID.
  const builtIn = findBuiltInMetadata(modelId);
  const metadata: ModelMetadata = { ...(builtIn ?? DEFAULT_METADATA) };

  // Cache the result under the complete opaque ID.
  metadataCache.set(modelId, metadata);

  return metadata;
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
