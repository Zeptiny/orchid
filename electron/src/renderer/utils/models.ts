/**
 * Shared model listing helpers for config dropdowns and /model palette.
 */

/**
 * Check if a model entry in a provider's models dict is tagged as embeddings.
 */
function isEmbeddingsModel(modelData: unknown): boolean {
  if (!modelData || typeof modelData !== 'object') return false;
  return (modelData as Record<string, unknown>).mode === 'embeddings';
}

/**
 * Collect all available chat model IDs from the providers config.
 * Models tagged as `mode: "embeddings"` are excluded — they are for RAG,
 * not for chat/tier model pickers.
 * Returns sorted "provider/model" strings (same shape used by tier models).
 */
export function collectModelsFromProviders(
  providers: Record<string, Record<string, unknown>> | null | undefined,
): string[] {
  if (!providers) return [];
  const models: string[] = [];
  for (const [providerId, providerData] of Object.entries(providers)) {
    const providerModels = providerData?.models;
    if (providerModels && typeof providerModels === 'object' && !Array.isArray(providerModels)) {
      for (const [modelId, modelData] of Object.entries(providerModels as Record<string, unknown>)) {
        if (modelId && !isEmbeddingsModel(modelData)) {
          models.push(`${providerId}/${modelId}`);
        }
      }
    }
  }
  return models.sort((a, b) => a.localeCompare(b));
}

/**
 * Collect all available embedding model IDs from the providers config.
 * Only models tagged as `mode: "embeddings"` are included.
 * Returns sorted "provider/model" strings.
 */
export function collectEmbeddingModelsFromProviders(
  providers: Record<string, Record<string, unknown>> | null | undefined,
): string[] {
  if (!providers) return [];
  const models: string[] = [];
  for (const [providerId, providerData] of Object.entries(providers)) {
    const providerModels = providerData?.models;
    if (providerModels && typeof providerModels === 'object' && !Array.isArray(providerModels)) {
      for (const [modelId, modelData] of Object.entries(providerModels as Record<string, unknown>)) {
        if (modelId && isEmbeddingsModel(modelData)) {
          models.push(`${providerId}/${modelId}`);
        }
      }
    }
  }
  return models.sort((a, b) => a.localeCompare(b));
}

/**
 * Ensure the currently selected value stays in the option list even if it was
 * removed from providers (so the select never shows a blank invalid value).
 */
export function withCurrentModelOption(
  models: readonly string[],
  current: string | null | undefined,
): string[] {
  if (!current) return [...models];
  if (models.includes(current)) return [...models];
  return [current, ...models];
}
