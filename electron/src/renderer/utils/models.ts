import type { ProviderModelView } from '../../shared/types/ipc';

/** Shared model selection helpers for searchable pickers. */

/** Unknown/custom models remain eligible for chat until their role is declared. */
export function isTextGenerationModel(model: ProviderModelView): boolean {
  const output = model.capabilities?.outputModalities;
  return output === null || output === undefined || output.length === 0 || output.every((value) => value === 'text');
}

/** Embedding-only models are selectable by RAG, but must not appear in chat. */
export function isEmbeddingModel(model: ProviderModelView): boolean {
  const output = model.capabilities?.outputModalities;
  return output !== null && output !== undefined && output.length > 0
    && output.every((value) => value === 'embedding');
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
