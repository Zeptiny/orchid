/** Pure autocomplete row builders for the composer slash menu. */
import type { CommandContext, SessionSummary } from '../../../shared/types/ipc-boundary';
import {
  COMMANDS,
  buildModelResults,
  buildPersonalityResults,
  buildSessionResults,
  buildThemeResults,
  fuzzyMatch,
  type Command,
  type PaletteResult,
} from '../../commands/registry';

/** Open `/name` sub-picker; null shows the filtered command list. */
export type SlashSubPicker = '/theme' | '/personality' | '/model' | '/sessions' | null;

export interface SlashResultSource {
  input: string;
  subPicker: SlashSubPicker;
  commandContext: CommandContext;
  currentTheme: string;
  currentPersonality: string;
  personalityNames: readonly string[];
  sessions: readonly SessionSummary[];
  modelNotifyLabels: Readonly<Record<string, string>>;
}

const SUB_PICKER_RESULTS: Readonly<
  Record<NonNullable<SlashSubPicker>, (source: SlashResultSource) => PaletteResult[]>
> = {
  '/theme': ({ input, currentTheme }) =>
    filterResults(buildThemeResults(currentTheme), input),
  '/personality': ({ input, currentPersonality, personalityNames }) =>
    filterResults(buildPersonalityResults(currentPersonality, personalityNames), input),
  '/model': ({ input, commandContext, modelNotifyLabels }) =>
    filterResults(
      buildModelResults(
        commandContext.getCurrentModel(),
        commandContext.getAvailableModels(),
        modelNotifyLabels,
      ),
      input,
    ),
  '/sessions': ({ input, sessions }) => filterResults(buildSessionResults(sessions), input),
};

export function buildSlashResults(source: SlashResultSource): PaletteResult[] {
  const openSubPicker = source.subPicker;
  if (openSubPicker) return SUB_PICKER_RESULTS[openSubPicker](source);
  return buildCommandResults(source.input);
}

export function commandResult(command: Command): PaletteResult {
  return {
    id: `cmd:${command.name}`,
    label: command.name,
    description: command.description,
    category: 'commands',
    commandName: command.name,
  };
}

/** Command list — query is the full `/…` text. */
export function buildCommandResults(query: string): PaletteResult[] {
  const trimmed = query.trim();
  if (trimmed === '/' || trimmed === '') {
    return COMMANDS.map(listedCommandResult);
  }
  return COMMANDS
    .map((command) => ({ command, score: scoreCommand(trimmed, command) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => listedCommandResult(entry.command));
}

function listedCommandResult(command: Command): PaletteResult {
  return { ...commandResult(command), icon: 'command' };
}

function scoreCommand(query: string, command: Command): number {
  return Math.max(
    fuzzyMatch(query, command.name),
    // Also match without requiring the leading slash in the description path
    fuzzyMatch(query.replace(/^\//, ''), command.name.replace(/^\//, '')),
    fuzzyMatch(query, command.description),
  );
}

function filterResults(items: PaletteResult[], query: string): PaletteResult[] {
  const q = query.trim();
  if (!q) return items;
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(
        fuzzyMatch(q, item.label),
        item.description ? fuzzyMatch(q, item.description) : -1,
      ),
    }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
