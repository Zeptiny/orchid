/** Renderer-safe view-model helpers for typed connection-scoped selections. */
import type { ProviderConnectionView, ProviderModelOption } from '../../shared/types/ipc';
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

export function providerModelOptionDisplayName(option: ProviderModelOption): string {
  return option.model.displayName;
}

export function providerModelOptionContextLabel(option: ProviderModelOption): string {
  return `${option.providerDisplayName ?? option.providerId} · ${option.connectionName}`;
}

export function providerModelOptionLabel(option: ProviderModelOption): string {
  return `${providerModelOptionContextLabel(option)} · ${providerModelOptionDisplayName(option)}`;
}

export function selectionMatchesOption(
  selection: ModelSelection | null | undefined,
  option: ProviderModelOption,
): boolean {
  return selection?.connectionId === option.selection.connectionId
    && selection.modelId === option.selection.modelId;
}

/**
 * Pick one connection card to host provider-scoped status. A ready connection
 * wins because authenticated status refreshes can use it immediately; stable
 * list order breaks ties so the same observation is never repeated elsewhere.
 */
export function providerStatusConnectionId(
  connections: readonly ProviderConnectionView[],
  providerId: string,
): string | null {
  const matching = connections.filter((connection) => connection.providerId === providerId);
  return matching.find((connection) => connection.health === 'ready')?.id
    ?? matching[0]?.id
    ?? null;
}
