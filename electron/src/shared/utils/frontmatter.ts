/**
 * Custom YAML frontmatter parser.
 *
 * Supports key-value (`key: value`) and list (`- item`) syntax between
 * `---` delimiters.  No external YAML library required.
 *
 * Ported from Python `src/orchid/utils.py:parse_frontmatter`.
 */

export type FrontmatterValue = string | string[];
export type FrontmatterDict = Record<string, FrontmatterValue>;

export interface ParsedFrontmatter {
  metadata: FrontmatterDict;
  body: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 *
 * Returns `{ metadata, body }`.
 * If no frontmatter is found, returns `{ metadata: {}, body: content }`.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trim();
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(trimmed);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const frontmatterStr = match[1];
  const body = match[2];

  const metadata: FrontmatterDict = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of frontmatterStr.split('\n')) {
    const stripped = line.trim();

    // List item under a key
    if (stripped.startsWith('- ') && currentKey !== null) {
      if (currentList === null) {
        currentList = [];
      }
      currentList.push(stripped.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    // Save previous list if we hit a new key
    if (currentList !== null && currentKey !== null) {
      metadata[currentKey] = currentList;
      currentList = null;
    }

    if (!stripped || !stripped.includes(':')) {
      continue;
    }

    const colonIdx = stripped.indexOf(':');
    const key = stripped.slice(0, colonIdx).trim();
    const value = stripped.slice(colonIdx + 1).trim();
    currentKey = key;

    // Remove quotes if present
    let cleanValue = value;
    if (
      cleanValue.length >= 2 &&
      ((cleanValue[0] === '"' && cleanValue[cleanValue.length - 1] === '"') ||
        (cleanValue[0] === "'" && cleanValue[cleanValue.length - 1] === "'"))
    ) {
      cleanValue = cleanValue.slice(1, -1);
    }

    if (cleanValue) {
      metadata[key] = cleanValue;
      currentList = null;
    } else {
      currentList = [];
    }
  }

  // Save any trailing list
  if (currentList !== null && currentKey !== null) {
    metadata[currentKey] = currentList;
  }

  return { metadata, body };
}

/**
 * Extract a string value from frontmatter metadata.
 * Returns the value if it's a string, or the first element if it's a list.
 * Returns `fallback` if the key is missing or the value is not a string.
 */
export function getString(
  meta: FrontmatterDict,
  key: string,
  fallback = '',
): string {
  const val = meta[key];
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
    return val[0];
  }
  return fallback;
}

/**
 * Extract a string array from frontmatter metadata.
 * If the value is a string, splits by comma.
 * If the value is already a list, returns it.
 * Returns `fallback` if missing.
 */
export function getStringArray(
  meta: FrontmatterDict,
  key: string,
  fallback: string[] = [],
): string[] {
  const val = meta[key];
  if (Array.isArray(val)) {
    return val.filter((v): v is string => typeof v === 'string');
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '[]' || trimmed === '') return [];
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return fallback;
}

/**
 * Serialize metadata + body into a markdown document with YAML frontmatter.
 *
 * List values become multi-line `- item` blocks; strings with special characters
 * are single-quoted. Keys are emitted in insertion order.
 */
export function serializeFrontmatter(
  metadata: FrontmatterDict,
  body: string,
): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }

  lines.push('---');
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '');
  if (trimmedBody) {
    lines.push('');
    lines.push(trimmedBody);
  }
  lines.push('');
  return lines.join('\n');
}

/** Quote a YAML scalar when needed (colons, leading/trailing space, quotes). */
function yamlScalar(value: string): string {
  if (value === '') return "''";
  const needsQuotes =
    /[:#{}[\],&*!|>'"%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    value.includes('\n') ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    /^-?\d+(\.\d+)?$/.test(value);

  if (!needsQuotes) return value;

  // Prefer single quotes; double-escape any internal single quotes.
  return `'${value.replace(/'/g, "''")}'`;
}
