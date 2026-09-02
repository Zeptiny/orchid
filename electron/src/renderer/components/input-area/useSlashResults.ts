import { useMemo } from 'react';
import type { CommandContext, SessionSummary } from '../../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import type { PaletteResult } from '../../commands/registry';
import { resolveModelNotifyLabel } from '../../utils/provider-selection';
import { buildSlashResults, type SlashSubPicker } from './slash-results';

export interface SlashResultsOptions {
  commandContext?: CommandContext;
  input: string;
  isSlashMode: boolean;
  subPicker: SlashSubPicker;
  currentTheme: string;
  currentPersonality: string;
  personalityNames: readonly string[];
  sessions: readonly SessionSummary[];
  modelDetails?: Readonly<Record<string, ProviderModelOption>>;
  modelLabels?: Readonly<Record<string, string>>;
}

/** Autocomplete rows for the composer slash menu; empty while it is closed. */
export function useSlashResults(options: SlashResultsOptions): PaletteResult[] {
  const {
    commandContext,
    input,
    isSlashMode,
    modelDetails,
    modelLabels,
    subPicker,
    currentTheme,
    currentPersonality,
    personalityNames,
    sessions,
  } = options;

  const availableModels = commandContext?.getAvailableModels() ?? [];
  const modelNotifyLabels = useMemo(
    () => Object.fromEntries(
      availableModels.map((key) => [
        key,
        resolveModelNotifyLabel(key, modelDetails, modelLabels),
      ]),
    ),
    [availableModels, modelDetails, modelLabels],
  );

  return useMemo<PaletteResult[]>(() => {
    if (!isSlashMode || !commandContext) return [];
    return buildSlashResults({
      input,
      subPicker,
      commandContext,
      currentTheme,
      currentPersonality,
      personalityNames,
      sessions,
      modelNotifyLabels,
    });
  }, [
    isSlashMode,
    commandContext,
    subPicker,
    input,
    currentTheme,
    currentPersonality,
    personalityNames,
    sessions,
    modelNotifyLabels,
  ]);
}
