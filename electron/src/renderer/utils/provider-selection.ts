/** Renderer-safe view-model helpers for typed connection-scoped selections. */
import type { ProviderModelOption } from '../../shared/types/ipc';
import type { ModelSelection } from '../../shared/types/provider';

/**
 * Keep selection identifiers opaque. The renderer never splits a model ID,
 * which may contain `/` or other provider-owned characters.
 */
export function providerModelOptionKey(option: ProviderModelOption): string {
  return `${option.selection.connectionId}\u001f${option.selection.modelId}`;
}

export function selectionKey(selection: ModelSelection | null | undefined): string {
  return selection ? `${selection.connectionId}\u001f${selection.modelId}` : '';
}

export function providerModelOptionLabel(option: ProviderModelOption): string {
  return `${option.providerDisplayName ?? option.providerId} · ${option.connectionName} · ${option.model.displayName}`;
}

export function selectionMatchesOption(
  selection: ModelSelection | null | undefined,
  option: ProviderModelOption,
): boolean {
  return selection?.connectionId === option.selection.connectionId
    && selection.modelId === option.selection.modelId;
}
