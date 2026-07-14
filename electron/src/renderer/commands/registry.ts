/**
 * Command Registry — renderer-side command definitions.
 *
 * Uses shared types from shared/commands.ts.
 * Commands with execute functions that use renderer APIs (window, localStorage).
 */

import type { CommandContext } from '../../shared/types/ipc-boundary';
import type { Command, PaletteResult, CommandCategory } from '../../shared/commands';
import {
  THEME_NAMES,
  THEME_LABELS,
} from '../../shared/commands';

export type { Command, PaletteResult, CommandCategory } from '../../shared/commands';
export { fuzzyMatch, highlightMatch } from '../../shared/commands';

// ── Recent commands storage ──────────────────────────────────────────────────

const RECENT_COMMANDS_KEY = 'orchid-recent-commands';
const MAX_RECENT = 5;

export function getRecentCommands(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_COMMANDS_KEY);
    if (stored) {
      return JSON.parse(stored) as string[];
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

export function trackRecentCommand(name: string): void {
  const recent = getRecentCommands().filter((c) => c !== name);
  recent.unshift(name);
  if (recent.length > MAX_RECENT) {
    recent.length = MAX_RECENT;
  }
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recent));
  } catch {
    // Non-fatal
  }
}

// ── Command definitions ──────────────────────────────────────────────────────

export const COMMANDS: (Command & { execute: (ctx: CommandContext) => Promise<void> })[] = [
  {
    name: '/new',
    description: 'Create a new session',
    category: 'commands',
    execute: async (ctx) => {
      await ctx.onCreateSession();
      ctx.onNotify('New session created.', 'info');
      ctx.onClose();
    },
  },
  {
    name: '/sessions',
    description: 'Load a saved session',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette / SlashCommandMenu
    },
  },
  {
    name: '/rename',
    description: 'Rename the active session',
    category: 'commands',
    execute: async (ctx) => {
      const sessionId = ctx.getActiveSessionId();
      const currentName = ctx.getActiveSessionName() ?? '';
      if (!sessionId) {
        ctx.onNotify('No active session to rename.', 'warning');
        ctx.onClose();
        return;
      }
      ctx.onClose();
      const next = window.prompt('Rename session', currentName);
      if (next === null) return; // cancelled
      const trimmed = next.trim();
      if (!trimmed) {
        ctx.onNotify('Session name cannot be empty.', 'warning');
        return;
      }
      if (trimmed === currentName) return;
      await ctx.onRenameSession(sessionId, trimmed);
      ctx.onNotify(`Session renamed to “${trimmed}”.`, 'info');
    },
  },
  {
    name: '/delete',
    description: 'Delete the active session',
    category: 'commands',
    execute: async (ctx) => {
      const sessionId = ctx.getActiveSessionId();
      const name = ctx.getActiveSessionName() ?? 'this session';
      if (!sessionId) {
        ctx.onNotify('No active session to delete.', 'warning');
        ctx.onClose();
        return;
      }
      ctx.onClose();
      const ok = window.confirm(`Delete session “${name}”? This cannot be undone.`);
      if (!ok) return;
      await ctx.onDeleteSession(sessionId);
      ctx.onNotify('Session deleted.', 'info');
    },
  },
  {
    name: '/model',
    description: 'Change the model for the current session',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette / SlashCommandMenu
    },
  },
  {
    name: '/theme',
    description: 'Switch the application theme',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette / SlashCommandMenu
    },
  },
  {
    name: '/personality',
    description: 'Switch the agent personality',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette / SlashCommandMenu
    },
  },
  {
    name: '/settings',
    description: 'Open configuration settings',
    category: 'commands',
    execute: async (ctx) => {
      ctx.onOpenSettings();
      ctx.onClose();
    },
  },
  {
    name: '/cd',
    description: 'Change the project working directory',
    category: 'commands',
    execute: async (ctx) => {
      if (!ctx.onPickProjectDir) {
        ctx.onNotify('Folder picker is not available.', 'warning');
        ctx.onClose();
        return;
      }
      ctx.onClose();
      try {
        await ctx.onPickProjectDir();
        ctx.onNotify('Project folder updated.', 'info');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.onNotify(`Failed to change project folder: ${msg}`, 'error');
      }
    },
  },
  {
    name: '/rag index',
    description: 'Index the project for RAG semantic search',
    category: 'commands',
    execute: async (ctx) => {
      ctx.onNotify('Indexing project for RAG...', 'info');
      ctx.onClose();
      try {
        await ctx.onIndexRAG();
        ctx.onNotify('RAG indexing complete.', 'info');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.onNotify(`RAG indexing failed: ${msg}`, 'error');
      }
    },
  },
  {
    name: '/ast index',
    description: 'Re-scan the project for AST symbol indexing',
    category: 'commands',
    execute: async (ctx) => {
      ctx.onNotify('Re-scanning project for AST symbols...', 'info');
      ctx.onClose();
      try {
        await ctx.onIndexAST();
        ctx.onNotify('AST indexing complete.', 'info');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.onNotify(`AST indexing failed: ${msg}`, 'error');
      }
    },
  },
  {
    name: '/rag clear',
    description: 'Clear the RAG index',
    category: 'commands',
    execute: async (ctx) => {
      await ctx.onClearRAG();
      ctx.onNotify('RAG index cleared.', 'info');
      ctx.onClose();
    },
  },
];

// ── Sub-picker data builders ─────────────────────────────────────────────────

export function buildThemeResults(currentTheme: string): PaletteResult[] {
  return THEME_NAMES.map((name) => ({
    id: `theme:${name}`,
    label: THEME_LABELS[name] ?? name,
    description: name === currentTheme ? 'Current theme' : `Switch to ${THEME_LABELS[name] ?? name}`,
    category: 'commands' as CommandCategory,
    icon: name === currentTheme ? '\u25cf' : '\u25cb',
    commandName: '/theme',
    action: 'theme' as const,
    value: name,
  }));
}

/**
 * Build personality picker results for palette display.
 * @param currentPersonality  Currently selected personality name
 * @param names  Personality names loaded from disk (`~/.orchid/personalities/`)
 */
export function buildPersonalityResults(
  currentPersonality: string,
  names: readonly string[] = [],
): PaletteResult[] {
  return names.map((name) => ({
    id: `personality:${name}`,
    label: name,
    description: name === currentPersonality ? 'Current personality' : `Switch to ${name}`,
    category: 'commands' as CommandCategory,
    icon: name === currentPersonality ? '\u25cf' : '\u25cb',
    commandName: '/personality',
    action: 'personality' as const,
    value: name,
  }));
}

/**
 * Build model picker results for `/model`.
 * @param currentModel  Active session / default model id
 * @param models  `provider/model` ids from config providers
 */
export function buildModelResults(
  currentModel: string,
  models: readonly string[] = [],
): PaletteResult[] {
  if (models.length === 0) {
    return [
      {
        id: 'model:empty',
        label: 'No models configured',
        description: 'Add providers in Settings → Providers first',
        category: 'commands' as CommandCategory,
        icon: 'alertCircle',
        commandName: '/model',
      },
    ];
  }

  return models.map((model) => ({
    id: `model:${model}`,
    label: model,
    description: model === currentModel ? 'Current model' : `Switch to ${model}`,
    category: 'commands' as CommandCategory,
    icon: model === currentModel ? '\u25cf' : '\u25cb',
    commandName: '/model',
    action: 'model' as const,
    value: model,
  }));
}

/** Build session list for `/sessions` sub-picker. */
export function buildSessionResults(
  sessions: readonly { id: string; name: string; modelLabel?: string | null }[],
): PaletteResult[] {
  if (sessions.length === 0) {
    return [
      {
        id: 'session:empty',
        label: 'No sessions yet',
        description: 'Create one with /new',
        category: 'sessions' as CommandCategory,
        icon: 'messageSquare',
        commandName: '/sessions',
      },
    ];
  }

  return sessions.map((s) => ({
    id: `session:${s.id}`,
    label: s.name,
    description: s.modelLabel ? `Model: ${s.modelLabel}` : undefined,
    category: 'sessions' as CommandCategory,
    icon: 'messageSquare',
    commandName: '/sessions',
    action: 'session' as const,
    value: s.id,
  }));
}
