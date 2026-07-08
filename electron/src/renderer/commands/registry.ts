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
  PERSONALITY_NAMES,
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
      // Sub-picker handled by CommandPalette
    },
  },
  {
    name: '/rename',
    description: 'Rename the active session',
    category: 'commands',
    execute: async (ctx) => {
      const sessionId = ctx.getActiveSessionId();
      const currentName = ctx.getActiveSessionName();
      if (!sessionId) {
        ctx.onNotify('No active session to rename.', 'warning');
        ctx.onClose();
        return;
      }
      ctx.onClose();
      window.dispatchEvent(
        new CustomEvent('orchid:rename-session', {
          detail: { sessionId, currentName },
        }),
      );
    },
  },
  {
    name: '/delete',
    description: 'Delete the active session',
    category: 'commands',
    execute: async (ctx) => {
      const sessionId = ctx.getActiveSessionId();
      if (!sessionId) {
        ctx.onNotify('No active session to delete.', 'warning');
        ctx.onClose();
        return;
      }
      await ctx.onDeleteSession(sessionId);
      ctx.onNotify('Session deleted.', 'info');
      ctx.onClose();
    },
  },
  {
    name: '/model',
    description: 'Change the model for the current session',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette
    },
  },
  {
    name: '/theme',
    description: 'Switch the application theme',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette
    },
  },
  {
    name: '/personality',
    description: 'Switch the agent personality',
    category: 'commands',
    execute: async (_ctx) => {
      // Sub-picker handled by CommandPalette
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
    name: '/index-rag',
    description: 'Index the project for RAG semantic search',
    category: 'commands',
    execute: async (ctx) => {
      ctx.onNotify('Indexing project for RAG...', 'info');
      ctx.onClose();
      await ctx.onIndexRAG();
    },
  },
  {
    name: '/index-ast',
    description: 'Re-scan the project for AST symbol indexing',
    category: 'commands',
    execute: async (ctx) => {
      ctx.onNotify('Re-scanning project for AST symbols...', 'info');
      ctx.onClose();
      await ctx.onIndexAST();
    },
  },
  {
    name: '/rag status',
    description: 'Show RAG index status',
    category: 'commands',
    execute: async (ctx) => {
      const status = await ctx.onGetRAGStatus();
      if (!status || (status.lastIndexed === null && status.totalChunks === 0)) {
        ctx.onNotify('No RAG index exists. Run /index-rag to create one.', 'info');
      } else {
        ctx.onNotify(
          `RAG: ${status.totalFiles} files, ${status.totalChunks} chunks, indexed: ${status.lastIndexed || 'never'}`,
          'info',
        );
      }
      ctx.onClose();
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

// ── Command lookup ───────────────────────────────────────────────────────────

export function getCommand(name: string): (Command & { execute: (ctx: CommandContext) => Promise<void> }) | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function getCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

export function isCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name);
}

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

export function buildPersonalityResults(currentPersonality: string): PaletteResult[] {
  return PERSONALITY_NAMES.map((name) => ({
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
