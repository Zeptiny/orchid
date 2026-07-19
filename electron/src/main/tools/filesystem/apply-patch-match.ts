// ── Unicode normalization ──────────────────────────────────────────────────

const DASH_CHARS = new Set([
  '\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2014}', '\u{2015}', '\u{2212}',
]);

const SINGLE_QUOTE_CHARS = new Set([
  '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}',
]);

const DOUBLE_QUOTE_CHARS = new Set([
  '\u{201C}', '\u{201D}', '\u{201E}', '\u{201F}',
]);

const SPACE_CHARS = new Set([
  '\u{00A0}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
  '\u{2007}', '\u{2008}', '\u{2009}', '\u{200A}', '\u{202F}', '\u{205F}',
  '\u{3000}',
]);

/**
 * Normalize a string by trimming and mapping common Unicode punctuation to ASCII equivalents.
 */
export function normalizeUnicode(s: string): string {
  let out = '';
  for (const ch of s.trim()) {
    if (DASH_CHARS.has(ch)) out += '-';
    else if (SINGLE_QUOTE_CHARS.has(ch)) out += "'";
    else if (DOUBLE_QUOTE_CHARS.has(ch)) out += '"';
    else if (SPACE_CHARS.has(ch)) out += ' ';
    else out += ch;
  }
  return out;
}

// ── Matching tiers ─────────────────────────────────────────────────────────

function matchExact(lines: string[], pattern: string[], i: number): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (lines[i + j] !== pattern[j]) return false;
  }
  return true;
}

function matchTrimEnd(lines: string[], pattern: string[], i: number): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (lines[i + j].trimEnd() !== pattern[j].trimEnd()) return false;
  }
  return true;
}

function matchTrim(lines: string[], pattern: string[], i: number): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (lines[i + j].trim() !== pattern[j].trim()) return false;
  }
  return true;
}

function matchNormalized(lines: string[], pattern: string[], i: number): boolean {
  for (let j = 0; j < pattern.length; j++) {
    if (normalizeUnicode(lines[i + j]) !== normalizeUnicode(pattern[j])) return false;
  }
  return true;
}

// ── Core algorithm ─────────────────────────────────────────────────────────

/**
 * Attempt to find a sequence of pattern lines within source lines, starting at or after `start`.
 * Returns the starting index of the match, or null if not found.
 *
 * Matching is attempted with decreasing strictness across 4 tiers:
 * 1. Exact match
 * 2. Trailing whitespace ignored (trimEnd per line)
 * 3. Both leading and trailing whitespace ignored (trim per line)
 * 4. Unicode punctuation normalization + trim
 */
export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart = eof && lines.length >= pattern.length
    ? lines.length - pattern.length
    : start;

  const lastStart = lines.length - pattern.length;

  const tiers = [matchExact, matchTrimEnd, matchTrim, matchNormalized];

  for (const tier of tiers) {
    for (let i = searchStart; i <= lastStart; i++) {
      if (tier(lines, pattern, i)) return i;
    }
  }

  if (eof && searchStart !== start) {
    for (const tier of tiers) {
      for (let i = start; i <= lastStart; i++) {
        if (tier(lines, pattern, i)) return i;
      }
    }
  }

  return null;
}

// ── Context hint finder ────────────────────────────────────────────────────

/**
 * Find a @@ context hint line in the source, using the same 4-tier matching.
 * Returns the index after the found hint (so subsequent chunk matching starts after it).
 */
export function findContextHint(
  lines: string[],
  hint: string,
  start: number,
): number | null {
  const found = seekSequence(lines, [hint], start, false);
  return found !== null ? found + 1 : null;
}
