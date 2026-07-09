/**
 * Shared model listing helpers for config dropdowns and /model palette.
 */

/**
 * Collect all available model IDs from the providers config.
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
      for (const modelId of Object.keys(providerModels as Record<string, unknown>)) {
        if (modelId) models.push(`${providerId}/${modelId}`);
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
