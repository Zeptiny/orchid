/**
 * Shared glob → anchored RegExp conversion for simple patterns.
 *
 * Supports `*` → `.*`, `?` → `.`, optional unclosed-safe `[...]` character
 * classes, and escaping of regex metacharacters. Always anchors with `^…$`.
 */

// ── Options ────────────────────────────────────────────────────────────────

export type GlobToRegexOptions = {
  /** When true, use RegExp `i` flag. Default false. */
  caseInsensitive?: boolean;
  /**
   * When true, support unclosed-safe `[...]` character classes.
   * When false, treat `[` as a literal to escape (segment-safe).
   * Default true.
   */
  characterClasses?: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeRegexLiteral(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to an anchored RegExp (`^…$`).
 *
 * Supports `*` → `.*`, `?` → `.`, optional character classes, and escapes
 * regex metacharacters. Does not implement brace expansion or extended globs.
 */
export function globToRegex(
  pattern: string,
  options?: GlobToRegexOptions,
): RegExp {
  const caseInsensitive = options?.caseInsensitive ?? false;
  const characterClasses = options?.characterClasses ?? true;

  let regex = '';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === '*') {
      regex += '.*';
    } else if (character === '?') {
      regex += '.';
    } else if (character === '[' && characterClasses) {
      const end = pattern.indexOf(']', index + 1);
      if (end !== -1) {
        regex += `[${pattern.substring(index + 1, end).replace(/\\/g, '\\\\')}]`;
        index = end;
      } else {
        regex += '\\[';
      }
    } else {
      regex += escapeRegexLiteral(character);
    }
    index++;
  }

  return new RegExp(`^${regex}$`, caseInsensitive ? 'i' : '');
}
