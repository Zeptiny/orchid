/** Renderer-safe view-model helpers for typed connection-scoped selections. */
import type { ProviderConnectionView, ProviderModelOption, ProviderStatusView } from '../../shared/types/ipc';
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

/**
 * Context window (tokens) for an arbitrary selection — e.g. a subagent
 * chain's persisted `chain.selection` — resolved against typed model
 * metadata. Null when the selection or its model limits are unknown.
 */
export function contextTokensForSelection(
  selection: ModelSelection | null | undefined,
  optionDetails?: Readonly<Record<string, ProviderModelOption>>,
): number | null {
  if (!selection || !optionDetails) return null;
  return optionDetails[selectionKey(selection)]?.model.limits?.contextTokens ?? null;
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

/** Toast / notification label: provider name and model display name only. */
export function providerModelOptionNotifyLabel(option: ProviderModelOption): string {
  const provider = option.providerDisplayName ?? option.providerId;
  return `${provider} · ${providerModelOptionDisplayName(option)}`;
}

/**
 * Resolve a human-readable model label for opaque picker keys.
 * Prefer typed option metadata; fall back to a labels map or the raw key.
 */
export function resolveModelNotifyLabel(
  key: string,
  optionDetails?: Readonly<Record<string, ProviderModelOption>>,
  optionLabels?: Readonly<Record<string, string>>,
): string {
  const detail = optionDetails?.[key];
  if (detail) return providerModelOptionNotifyLabel(detail);
  return optionLabels?.[key] ?? key;
}

export function selectionMatchesOption(
  selection: ModelSelection | null | undefined,
  option: ProviderModelOption,
): boolean {
  return selection?.connectionId === option.selection.connectionId
    && selection.modelId === option.selection.modelId;
}

/** Reasoning effort metadata for a selection, derived from renderer provider state. */
export interface ModelReasoningSummary {
  readonly levels: readonly string[];
  readonly default: string | number | null;
  readonly supportsReasoning: boolean;
}

const NO_REASONING: ModelReasoningSummary = {
  levels: [],
  default: null,
  supportsReasoning: false,
};

/**
 * Derive reasoning effort levels for an arbitrary model selection from the
 * redacted provider state. Levels come from the selected model's connection
 * `reasoningConfig`; `supportsReasoning` mirrors the model capability. Nothing
 * is hardcoded — an unconfigured or non-reasoning model yields no levels.
 */
export function reasoningConfigForSelection(
  selection: ModelSelection | null | undefined,
  connections: readonly ProviderConnectionView[],
  modelOptions: readonly ProviderModelOption[],
): ModelReasoningSummary {
  if (!selection) return NO_REASONING;
  const option = modelOptions.find((item) => selectionMatchesOption(selection, item));
  const connection = connections.find((item) => item.id === selection.connectionId);
  const modelConfig = connection?.reasoningConfig?.[selection.modelId];
  return {
    levels: modelConfig?.levels ?? [],
    default: modelConfig?.default ?? null,
    supportsReasoning: option?.model.capabilities?.reasoning ?? false,
  };
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

/** Account quota requires the credential-bound connection that fetched it. */
export function providerStatusIsConnectionScoped(providerId: string): boolean {
  return providerId === 'neuralwatt';
}

/** Return only the observation that belongs on this connection's card. */
export function providerStatusForConnection(
  connections: readonly ProviderConnectionView[],
  connection: ProviderConnectionView,
  statuses: readonly ProviderStatusView[],
): ProviderStatusView | undefined {
  const connectionStatus = statuses.find((status) =>
    status.providerId === connection.providerId && status.connectionId === connection.id,
  );
  if (connectionStatus || providerStatusIsConnectionScoped(connection.providerId)) return connectionStatus;
  return providerStatusConnectionId(connections, connection.providerId) === connection.id
    ? statuses.find((status) => status.providerId === connection.providerId && status.connectionId === undefined)
    : undefined;
}
