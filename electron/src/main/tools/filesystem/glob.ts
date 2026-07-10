/**
 * glob tool — find files matching a glob pattern.
 *
 * Params: directory_path (required), pattern (required), include_hidden (optional).
 * Returns matching file paths sorted by modification time (newest first).
 *
 * Ported from Python `src/orchid/tools/file_manipulation.py` lines 253-308.
 *
 * Security note (P1-2):
 * This tool operates on arbitrary absolute paths with no restriction to the
 * project directory. A malicious agent could discover sensitive files outside
 * the workspace. Path sandboxing is deferred to R20 — the permission system
 * will enforce directory restrictions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';

// ── Schema ─────────────────────────────────────────────────────────────────

export const globInputSchema = z.object({
  directory_path: z.string().describe('The directory to search in, relative to the current working directory'),
  pattern: z.string().describe(
    'The glob pattern to match file names (e.g., \'*.py\', \'**/*.txt\', \'src/**/*.py\')',
  ),
  include_hidden: z.boolean().optional().describe('Whether to include hidden files (starting with .) (default: false)'),
});

export type GlobInput = z.infer<typeof globInputSchema>;

// ── Tool definition ────────────────────────────────────────────────────────

export const globDefinition: ToolDefinition = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Use to locate files by name when you know the pattern ' +
    '(e.g. \'*.py\', \'**/*.test.ts\'). Returns matching file paths sorted by modification time, newest first.',
  inputSchema: globInputSchema,
  actionLabel: 'Globbing...',
  category: 'filesystem',
};

// ── Glob implementation ────────────────────────────────────────────────────

/**
 * Recursive glob implementation that supports ** and * patterns.
 * Returns absolute paths of matching files.
 */
function globSync(baseDir: string, pattern: string): string[] {
  const fullPattern = path.join(baseDir, pattern);
  const segments = fullPattern.split(path.sep).filter((s) => s !== '');
  const results: string[] = [];
  walkGlob(segments, 0, path.sep, results);
  return results;
}

/**
 * Walk the filesystem according to glob pattern segments.
 * currentPath starts as '/' (the filesystem root).
 */
function walkGlob(
  segments: string[],
  idx: number,
  currentPath: string,
  results: string[],
): void {
  if (idx >= segments.length) {
    try {
      const stat = fs.statSync(currentPath);
      if (stat.isFile()) {
        results.push(currentPath);
      }
    } catch {
      // doesn't exist
    }
    return;
  }

  const segment = segments[idx];

  if (segment === '**') {
    // ** matches zero or more directories
    walkGlob(segments, idx + 1, currentPath, results);

    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = path.join(currentPath, entry);
      try {
        const stat = fs.statSync(childPath);
        if (stat.isDirectory()) {
          walkGlob(segments, idx, childPath, results);
        }
      } catch {
        // skip
      }
    }
    return;
  }

  // Regular segment — may contain * or ? wildcards
  const regex = globSegmentToRegex(segment);
  let entries: string[];
  try {
    entries = fs.readdirSync(currentPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (regex.test(entry)) {
      const childPath = path.join(currentPath, entry);
      walkGlob(segments, idx + 1, childPath, results);
    }
  }
}

/**
 * Convert a single glob segment (no path separators) to a regex.
 * Supports: *, ?, ** (handled separately).
 */
function globSegmentToRegex(segment: string): RegExp {
  let regexStr = '^';
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === '*') {
      regexStr += '.*';
    } else if (ch === '?') {
      regexStr += '.';
    } else if (ch === '.') {
      regexStr += '\\.';
    } else {
      regexStr += escapeRegex(ch);
    }
    i++;
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Handler ────────────────────────────────────────────────────────────────

export const globHandler: ToolHandler = async (input: unknown) => {
  const { directory_path, pattern, include_hidden = false } = input as GlobInput;

  try {
    const matches = globSync(directory_path, pattern);

    // Filter hidden files
    let filtered = matches;
    if (!include_hidden) {
      filtered = matches.filter((m) => {
        const relPath = path.relative(directory_path, m);
        const parts = relPath.split(path.sep);
        return !parts.some((p) => p.startsWith('.'));
      });
    }

    if (filtered.length === 0) {
      return {
        display: `No matches for ${pattern}`,
        content: `No files found matching pattern '${pattern}' in '${directory_path}'.`,
      };
    }

    // Sort by modification time, newest first
    filtered.sort((a, b) => {
      try {
        const statA = fs.statSync(a);
        const statB = fs.statSync(b);
        return statB.mtimeMs - statA.mtimeMs;
      } catch {
        return 0;
      }
    });

    // Convert to relative paths
    const relativePaths = filtered.map((m) => path.relative(directory_path, m));

    const lines = [`Found ${relativePaths.length} file(s) matching '${pattern}':`];
    for (const p of relativePaths) {
      try {
        const fullPath = path.join(directory_path, p);
        const stat = fs.statSync(fullPath);
        lines.push(stat.isDirectory() ? `${p}/` : p);
      } catch {
        lines.push(p);
      }
    }

    return {
      display: `Found ${relativePaths.length} matches for ${pattern}`,
      content: lines.join('\n'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Glob error pattern: ${pattern}`,
      content: `Error searching for files using pattern ${pattern}: ${msg}`,
      isError: true
    };
  }
};
