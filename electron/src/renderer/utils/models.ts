import type { ProviderModelView } from '../../shared/types/ipc';
import type { CustomConnectionModel } from '../../shared/types/provider';

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

export const CONNECTION_MODEL_MODALITIES = [
  'text',
  'image',
  'audio',
  'video',
  'pdf',
  'embedding',
] as const;

export type ConnectionModelModality = (typeof CONNECTION_MODEL_MODALITIES)[number];

/** Build the exact input/output metadata selected for one connection model. */
export function connectionModelCapabilities(
  inputModalities: readonly ConnectionModelModality[] = ['text'],
  outputModalities: readonly ConnectionModelModality[] = ['text'],
  tools = true,
  reasoning = true,
): CustomConnectionModel['capabilities'] {
  return {
    inputModalities: [...inputModalities],
    outputModalities: [...outputModalities],
    tools,
    reasoning,
  };
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
