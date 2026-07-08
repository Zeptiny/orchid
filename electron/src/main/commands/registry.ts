/**
 * Command Registry — central registry for all slash commands.
 *
 * Ported from src/orchid/commands/session_commands.py.
 *
 * Each command has:
 * - name: the slash command (e.g. "/new")
 * - description: human-readable help text
 * - category: grouping for the command palette
 * - execute: async function that performs the command action
 *
 * The registry also tracks recently used commands (last 5) in localStorage.
 */

import type { CommandContext } from '../../shared/types/ipc-boundary';

export type { CommandContext } from '../../shared/types/ipc-boundary';

// ── Types ────────────────────────────────────────────────────────────────────

export type CommandCategory = 'commands' | 'sessions' | 'settings' | 'navigation';

export interface Command {
  /** Slash command name, e.g. "/new". */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** Category for grouping in the palette. */
  readonly category: CommandCategory;
  /** Execute the command. Receives callbacks for actions that need UI coordination. */
  readonly execute: (ctx: CommandContext) => Promise<void>;
}

// ── Fuzzy match utilities ────────────────────────────────────────────────────

/**
 * Fuzzy match: checks if all characters of `query` appear in `text` in order.
 * Returns a score (higher = better match) or -1 if no match.
 *
 * "mod" matches "/model" but NOT "/rename".
 * "ses" matches "/sessions" and session names containing "ses".
 */
export function fuzzyMatch(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Empty query matches everything
  if (!q) return 1;

  // Exact prefix match gets highest score
  if (t.startsWith(q)) return 1000 + (100 - t.length);

  // Check if all query characters appear in order
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      // Consecutive matches get bonus
      if (lastMatchIndex === ti - 1) {
        score += 10;
      }
      // Match at word boundary gets bonus
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '-') {
        score += 5;
      }
      score += 1;
      lastMatchIndex = ti;
    }
  }

  // All query characters must match
  if (qi < q.length) return -1;

  // Bonus for shorter texts (more relevant)
  score += Math.max(0, 50 - t.length);

  return score;
}

/**
 * Highlight matched characters in text.
 * Returns an array of segments: { text, highlighted }.
 */
export function highlightMatch(
  query: string,
  text: string,
): Array<{ text: string; highlighted: boolean }> {
  const q = query.toLowerCase();
  const segments: Array<{ text: string; highlighted: boolean }> = [];
  let qi = 0;
  let current = '';

  for (let ti = 0; ti < text.length; ti++) {
    if (qi < q.length && text[ti].toLowerCase() === q[qi]) {
      if (current) {
        segments.push({ text: current, highlighted: false });
        current = '';
      }
      segments.push({ text: text[ti], highlighted: true });
      qi++;
    } else {
      current += text[ti];
    }
  }

  if (current) {
    segments.push({ text: current, highlighted: false });
  }

  return segments;
}

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

// ── Theme and personality constants ──────────────────────────────────────────

const THEME_NAMES = ['default', 'solarized-light', 'bluey', 'windows-xp', 'green-terminal'] as const;
const THEME_LABELS: Record<string, string> = {
  default: 'Default (Dark)',
  'solarized-light': 'Solarized Light',
  bluey: 'Bluey',
  'windows-xp': 'Windows XP',
  'green-terminal': 'Green Terminal',
};

const PERSONALITY_NAMES = [
  'default',
  'concise',
  'verbose',
  'creative',
  'technical',
  'friendly',
] as const;

// ── Command definitions ──────────────────────────────────────────────────────

export const COMMANDS: Command[] = [
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
      // This command shows a sub-picker; the palette itself handles session display
      // The actual session loading is handled by the palette's result selection
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
      // Trigger rename via a prompt-like flow; for now, use a simple approach
      // The palette will handle showing the rename input
      ctx.onClose();
      // Emit a custom event that the app can listen to for showing a rename dialog
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
      // The palette will show model results when this command is selected
      // Actual model switching is handled via the palette's result handler
    },
  },
  {
    name: '/theme',
    description: 'Switch the application theme',
    category: 'commands',
    execute: async (_ctx) => {
      // The palette will show theme options when this command is selected
    },
  },
  {
    name: '/personality',
    description: 'Switch the agent personality',
    category: 'commands',
    execute: async (_ctx) => {
      // The palette will show personality options when this command is selected
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

/** Get a command by exact name. */
export function getCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Get all command names. */
export function getCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

/** Check if a string is a known command. */
export function isCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name);
}

// ── Sub-picker data builders ─────────────────────────────────────────────────

/** Build theme picker results for palette display. */
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

/** Build personality picker results for palette display. */
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

// ── Palette result type ──────────────────────────────────────────────────────

export interface PaletteResult {
  /** Unique identifier for this result. */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** Optional description shown below the label. */
  readonly description?: string;
  /** Category for grouping. */
  readonly category: CommandCategory;
  /** Optional icon (emoji or character). */
  readonly icon?: string;
  /** Associated command name (if this is a sub-result of a command). */
  readonly commandName?: string;
  /** Action type for sub-results. */
  readonly action?: 'session' | 'theme' | 'personality' | 'model' | 'settings' | 'navigation';
  /** Value to pass to the action handler. */
  readonly value?: string;
}
