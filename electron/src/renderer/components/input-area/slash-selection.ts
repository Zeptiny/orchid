/** Table-driven dispatch for a picked slash-menu row. */
import type { CommandContext } from '../../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../../shared/types/ipc';
import { COMMANDS, trackRecentCommand, type PaletteResult } from '../../commands/registry';
import { resolveModelNotifyLabel } from '../../utils/provider-selection';
import type { SlashSubPicker } from './slash-results';

type PickerCommand = NonNullable<SlashSubPicker>;

export interface SlashSelectionHandlers {
  commandContext: CommandContext;
  modelDetails?: Readonly<Record<string, ProviderModelOption>>;
  modelLabels?: Readonly<Record<string, string>>;
  clearAndClose: () => void;
  openSubPicker: (picker: PickerCommand) => void;
}

type SlashActionHandler = (
  value: string,
  result: PaletteResult,
  handlers: SlashSelectionHandlers,
) => Promise<void>;

/** Sub-picker a `/name` command opens instead of executing directly. */
const SUB_PICKER_BY_COMMAND: Readonly<Record<string, PickerCommand>> = {
  '/theme': '/theme',
  '/personality': '/personality',
  '/model': '/model',
  '/sessions': '/sessions',
};

/** Apply a sub-picker row, notify, then close the composer menu. */
const SLASH_ACTION_HANDLERS: Readonly<
  Partial<Record<NonNullable<PaletteResult['action']>, SlashActionHandler>>
> = {
  theme: async (value, result, { commandContext, clearAndClose }) => {
    await commandContext.onSetTheme(value);
    commandContext.onNotify(`Theme changed to ${result.label}`, 'info');
    clearAndClose();
  },
  personality: async (value, result, { commandContext, clearAndClose }) => {
    await commandContext.onSetPersonality(value);
    commandContext.onNotify(`Personality changed to ${result.label}`, 'info');
    clearAndClose();
  },
  model: async (value, _result, { commandContext, clearAndClose, modelDetails, modelLabels }) => {
    await commandContext.onSetModel(value);
    commandContext.onNotify(
      `Model changed to ${resolveModelNotifyLabel(value, modelDetails, modelLabels)}`,
      'info',
    );
    clearAndClose();
  },
  session: async (value, result, { commandContext, clearAndClose }) => {
    await commandContext.onLoadSession(value);
    commandContext.onNotify(`Loaded session: ${result.label}`, 'info');
    clearAndClose();
  },
};

export async function applySlashSelection(
  result: PaletteResult,
  handlers: SlashSelectionHandlers,
): Promise<void> {
  trackRecentCommand(result.commandName ?? result.label);

  const actionHandler = result.action ? SLASH_ACTION_HANDLERS[result.action] : undefined;
  if (actionHandler && result.value) {
    await actionHandler(result.value, result, handlers);
    return;
  }

  if (!result.commandName) return;
  const command = COMMANDS.find((c) => c.name === result.commandName);
  if (!command) return;

  const subPicker = SUB_PICKER_BY_COMMAND[command.name];
  if (subPicker) {
    handlers.openSubPicker(subPicker);
    return;
  }

  await command.execute(handlers.commandContext);
  // Ensure composer is cleared even if execute did not call onClose
  handlers.clearAndClose();
}
