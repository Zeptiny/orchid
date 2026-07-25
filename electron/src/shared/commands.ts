/**
 * Shared Command Types and Utilities
 *
 * Types and pure functions shared between main and renderer processes.
 * Command definitions with execute functions live in the renderer.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CommandCategory = 'commands' | 'sessions' | 'settings' | 'navigation';

export interface Command {
  /** Slash command name, e.g. "/new". */
  readonly name: string;
  /** Human-readable description. */
  readonly description: string;
  /** Category for grouping in the palette. */
  readonly category: CommandCategory;
}

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

// ── Fuzzy match utilities ────────────────────────────────────────────────────

/**
 * Fuzzy match: checks if all characters of `query` appear in `text` in order.
 * Returns a score (higher = better match) or -1 if no match.
 */
export function fuzzyMatch(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (!q) return 1;

  if (t.startsWith(q)) return 1000 + (100 - t.length);

  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      if (lastMatchIndex === ti - 1) {
        score += 10;
      }
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '-') {
        score += 5;
      }
      score += 1;
      lastMatchIndex = ti;
    }
  }

  if (qi < q.length) return -1;

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

// ── Theme and personality constants ──────────────────────────────────────────

export const THEME_NAMES = ['default', 'light', 'solarized-light', 'bluey', 'windows-xp', 'green-terminal'] as const;
export const THEME_LABELS: Record<string, string> = {
  default: 'Default (Dark)',
  light: 'Light',
  'solarized-light': 'Solarized Light',
  bluey: 'Bluey',
  'windows-xp': 'Windows XP',
  'green-terminal': 'Green Terminal',
};

