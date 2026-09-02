/** Slash-menu and submit key dispatch for the composer textarea. */
import type { CommandContext } from '../../../shared/types/ipc-boundary';
import { COMMANDS, type PaletteResult } from '../../commands/registry';
import { commandResult, type SlashSubPicker } from './slash-results';

/** The keyboard-event fields the composer reads. */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

export interface SlashMenuKeyHandlers {
  results: readonly PaletteResult[];
  selectedIndex: number;
  subPicker: SlashSubPicker;
  input: string;
  selectNext: () => void;
  selectPrevious: () => void;
  selectResult: (result: PaletteResult) => void;
  leaveSubPicker: (picker: NonNullable<SlashSubPicker>, resetSelection: boolean) => void;
  closeMenu: () => void;
  setInputValue: (value: string) => void;
}

/** Consume a key while the slash menu is open; true when the event was handled. */
export function consumeSlashMenuKey(
  event: ComposerKeyEvent,
  handlers: SlashMenuKeyHandlers,
): boolean {
  if (handlers.results.length > 0) return consumeSlashMenuNavigationKey(event, handlers);
  if (event.key === 'Escape') {
    event.preventDefault();
    exitSlashMenu(handlers, false);
    return true;
  }
  return false;
}

function consumeSlashMenuNavigationKey(
  event: ComposerKeyEvent,
  handlers: SlashMenuKeyHandlers,
): boolean {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      handlers.selectNext();
      return true;
    case 'ArrowUp':
      event.preventDefault();
      handlers.selectPrevious();
      return true;
    case 'Enter':
      if (event.shiftKey) return false;
      event.preventDefault();
      selectHighlightedResult(handlers);
      return true;
    case 'Tab':
      event.preventDefault();
      selectHighlightedResult(handlers);
      return true;
    case 'Escape':
      event.preventDefault();
      exitSlashMenu(handlers, true);
      return true;
    default:
      return false;
  }
}

function selectHighlightedResult(handlers: SlashMenuKeyHandlers): void {
  const item = handlers.results[handlers.selectedIndex];
  if (item) handlers.selectResult(item);
}

function exitSlashMenu(handlers: SlashMenuKeyHandlers, resetSelection: boolean): void {
  const { subPicker } = handlers;
  if (subPicker) {
    handlers.leaveSubPicker(subPicker, resetSelection);
    return;
  }
  handlers.closeMenu();
  // Leave text so user can keep editing, or clear if only `/`
  if (handlers.input === '/') handlers.setInputValue('');
}

/** Enter and Ctrl/Cmd+S submit; Shift+Enter stays a newline. */
export function isComposerSendKey(event: ComposerKeyEvent): boolean {
  return (
    (event.key === 'Enter' && !event.shiftKey) ||
    (event.key === 's' && (event.ctrlKey || event.metaKey))
  );
}

export interface ExactSlashCommandHandlers {
  isSlashMode: boolean;
  hasResults: boolean;
  input: string;
  commandContext: CommandContext | null;
  selectResult: (result: PaletteResult) => void;
}

/** Exact slash command with no fuzzy matches: select it when fully typed. */
export function consumeExactSlashCommand(
  event: ComposerKeyEvent,
  handlers: ExactSlashCommandHandlers,
): boolean {
  const { isSlashMode, hasResults, input, commandContext } = handlers;
  if (!isSlashMode || hasResults) return false;
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return false;
  const exact = COMMANDS.find((c) => c.name === trimmed);
  if (!exact || !commandContext) return false;
  event.preventDefault();
  handlers.selectResult(commandResult(exact));
  return true;
}
