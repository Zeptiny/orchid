/**
 * Provider model surface for ChatView: the shared catalog, the composer's
 * effective selection, and the derived labels the picker/footer consume.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { ModelSelection } from '../../../shared/types/provider';
import { onOrchidEvent } from '../../utils/events';
import {
  providerModelOptionDisplayName,
  providerModelOptionKey,
  selectionMatchesOption,
} from '../../utils/provider-selection';
import { isTextGenerationModel } from '../../utils/models';
import type { UseProvidersReturn } from '../../hooks/useProviders';

export interface UseChatViewModelsOptions {
  readonly providers: UseProvidersReturn;
  readonly activeSessionId: string | null;
  readonly activeSessionSelection: ModelSelection | null;
  readonly changeModel: (
    id: string,
    selection: ModelSelection | null,
    modelLabel?: string | null,
  ) => Promise<void>;
  readonly currentSelection: ModelSelection | null;
  readonly setCurrentSelection: (selection: ModelSelection | null) => void;
  readonly isSwitchingSession: boolean;
}

export interface UseChatViewModelsReturn {
  readonly chatProviderModels: readonly ProviderModelOption[];
  readonly availableProviderModels: readonly ProviderModelOption[];
  readonly providerModelLabels: Record<string, string>;
  readonly providerModelDetails: Record<string, ProviderModelOption>;
  readonly preferredSelection: ModelSelection | null;
  readonly selectedProviderModel: ProviderModelOption | null;
  readonly providerAvailable: boolean;
  readonly modelSelected: boolean;
  readonly providerPickerValue: string;
  readonly maxContext: number | null;
}

/**
 * Shared catalog — never blank mid-switch; only update when a full list lands.
 * The picker value is the resolved selection's catalog key, empty when the
 * session's model is not (yet) in the catalog.
 */
export function useChatViewModels({
  providers,
  activeSessionId,
  activeSessionSelection,
  changeModel,
  currentSelection,
  setCurrentSelection,
  isSwitchingSession,
}: UseChatViewModelsOptions): UseChatViewModelsReturn {
  const [providerModelOptions, setProviderModelOptions] = useState<readonly ProviderModelOption[]>([]);
  const [maxContext, setMaxContext] = useState<number | null>(null);

  const connectionStateSignature = useMemo(
    () => providers.overview?.connections
      .map((connection) => `${connection.id}:${connection.health}:${connection.modelIds.join(',')}`)
      .sort()
      .join('|') ?? '',
    [providers.overview?.connections],
  );

  useEffect(() => {
    if (providers.modelOptions != null) {
      setProviderModelOptions(providers.modelOptions);
    }
  }, [providers.modelOptions]);

  useEffect(() => {
    void providers.ensureModelList();
  }, [connectionStateSignature, providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:providers-updated', () => {
      void providers.refresh().then(() => providers.ensureModelList());
    });
  }, [providers.refresh, providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:provider-selection-created', (detail) => {
      const selection = detail.selection;
      if (!selection) return;
      setCurrentSelection({
        connectionId: selection.connectionId,
        modelId: selection.modelId,
      });
      if (activeSessionId) {
        void changeModel(activeSessionId, selection, selection.modelId);
      }
      void providers.refresh();
    });
  }, [providers.refresh, activeSessionId, changeModel, setCurrentSelection]);

  const availableProviderModels = useMemo(
    () => providerModelOptions.filter((option) => option.available && isTextGenerationModel(option.model)),
    [providerModelOptions],
  );
  const chatProviderModels = useMemo(
    () => providerModelOptions.filter((option) => isTextGenerationModel(option.model)),
    [providerModelOptions],
  );
  const providerModelLabels = useMemo(
    () => Object.fromEntries(chatProviderModels.map((option) => [
      providerModelOptionKey(option),
      providerModelOptionDisplayName(option),
    ])),
    [chatProviderModels],
  );
  const providerModelDetails = useMemo(
    () => Object.fromEntries(chatProviderModels.map((option) => [providerModelOptionKey(option), option])),
    [chatProviderModels],
  );

  const preferredSelection = activeSessionSelection ?? currentSelection;
  const selectedProviderModel = preferredSelection
    ? chatProviderModels.find((option) => selectionMatchesOption(preferredSelection, option)) ?? null
    : null;
  const providerAvailable = providers.hasUsableConnection;
  const modelSelected = selectedProviderModel?.available === true;
  const providerPickerValue = selectedProviderModel ? providerModelOptionKey(selectedProviderModel) : '';

  useEffect(() => {
    if (selectedProviderModel) {
      setMaxContext(selectedProviderModel.model.limits?.contextTokens ?? null);
      return;
    }
    if (!isSwitchingSession) setMaxContext(null);
  }, [selectedProviderModel, isSwitchingSession]);

  return {
    chatProviderModels,
    availableProviderModels,
    providerModelLabels,
    providerModelDetails,
    preferredSelection,
    selectedProviderModel,
    providerAvailable,
    modelSelected,
    providerPickerValue,
    maxContext,
  };
}
