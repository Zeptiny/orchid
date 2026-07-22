/**
 * glob — find files matching a glob pattern and return structured matches.
 *
 * Matching and ordering remain the same as the legacy tool (newest mtime
 * first), while display strings are now derived from the canonical records.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { resolveToolPath } from '../types';
import { globToRegex } from '../glob-pattern';
import {
  searchResultsDataSchema,
  type GlobResultsData,
} from '../../../shared/types/tool-result-filesystem';
import type { ToolHandlerOutcome } from '../../../shared/types/tool-result';

// ── Schema ─────────────────────────────────────────────────────────────────

export const globInputSchema = z.object({
  directory_path: z.string().describe(
    'The directory to search in, relative to the current working directory',
  ),
  pattern: z.string().describe(
    'The glob pattern to match file names (e.g., \'*.py\', \'**/*.txt\', \'src/**/*.py\')',
  ),
  include_hidden: z.boolean().optional().describe(
    'Whether to include hidden files (starting with .) (default: false)',
  ),
});

export type GlobInput = z.infer<typeof globInputSchema>;

// ── Tool definition ────────────────────────────────────────────────────────

export const globDefinition: ToolDefinition = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Use to locate files by name when you know the pattern ' +
    '(e.g. \'*.py\', \'**/*.test.ts\'). Returns matching file paths sorted by modification time, newest first.',
  inputSchema: globInputSchema,
  resultFamily: 'search-results',
  outputDataSchema: searchResultsDataSchema,
  category: 'filesystem',
  riskClass: RiskClass.READ_ONLY,
};

// ── Walk records ───────────────────────────────────────────────────────────

/** Matched file with mtime/size captured once during walk. */
interface GlobWalkMatch {
  absolutePath: string;
  size: number;
  modifiedAt: number;
  modifiedAtIso: string;
}

// ── Glob implementation ────────────────────────────────────────────────────

/**
 * Recursive glob implementation that supports ** and * patterns.
 * Returns walk records (path + mtime/size) for matching files.
 */
function globSync(baseDir: string, pattern: string): GlobWalkMatch[] {
  const segments = pattern.split(/[/\\]/).filter((segment) => segment !== '');
  const results: GlobWalkMatch[] = [];
  walkGlob(segments, 0, baseDir, results);
  return results;
}

/** Walk the filesystem according to glob pattern segments. */
function walkGlob(
  segments: string[],
  index: number,
  currentPath: string,
  results: GlobWalkMatch[],
): void {
  if (index >= segments.length) {
    try {
      const stat = fs.statSync(currentPath);
      if (stat.isFile()) {
        results.push({
          absolutePath: currentPath,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          modifiedAtIso: stat.mtime.toISOString(),
        });
      }
    } catch {
      // Doesn't exist or became unreadable.
    }
    return;
  }

  const segment = segments[index];
  if (segment === '**') {
    // ** matches zero or more directories.
    walkGlob(segments, index + 1, currentPath, results);

    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = path.join(currentPath, entry);
      try {
        if (fs.statSync(childPath).isDirectory()) {
          walkGlob(segments, index, childPath, results);
        }
      } catch {
        // Skip entries that disappear during traversal.
      }
    }
    return;
  }

  const regex = globToRegex(segment, {
    caseInsensitive: false,
    characterClasses: false,
  });
  let entries: string[];
  try {
    entries = fs.readdirSync(currentPath).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (regex.test(entry)) {
      walkGlob(segments, index + 1, path.join(currentPath, entry), results);
    }
  }
}

function emptyData(root: string, pattern: string): GlobResultsData {
  return {
    kind: 'glob',
    root,
    pattern,
    matches: [],
    totalMatches: 0,
    limitReached: false,
  };
}

function globOutcome(
  directoryPath: string,
  pattern: string,
  includeHidden: boolean,
): ToolHandlerOutcome<GlobResultsData> {
  const empty = emptyData(directoryPath, pattern);
  try {
    const matches = globSync(directoryPath, pattern);
    const filtered = includeHidden
      ? matches
      : matches.filter((match) => {
          const relativePath = path.relative(directoryPath, match.absolutePath);
          return !relativePath.split(path.sep).some((part) => part.startsWith('.'));
        });

    // Reuse mtime/size captured during walk — no second stat per path.
    const ordered = filtered
      .map((match) => ({
        path: path.relative(directoryPath, match.absolutePath),
        size: match.size,
        modifiedAt: match.modifiedAt,
        modifiedAtIso: match.modifiedAtIso,
      }))
      .sort((left, right) =>
        // Files created during one scan often differ by filesystem
        // sub-second noise.  Use the timestamp precision exposed by the
        // canonical ISO metadata (milliseconds) only as a tie-breaker within
        // the same second, so a scan's order remains stable across filesystems
        // while preserving deliberate cross-second mtime ordering.
        Math.floor(right.modifiedAt / 1000) - Math.floor(left.modifiedAt / 1000)
        || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      );

    const data: GlobResultsData = {
      kind: 'glob',
      root: directoryPath,
      pattern,
      matches: ordered.map((match) => ({
        path: match.path,
        size: match.size,
        modifiedAt: match.modifiedAtIso,
      })),
      totalMatches: ordered.length,
      limitReached: false,
    };
    searchResultsDataSchema.parse(data);
    return ordered.length === 0 ? { status: 'empty', data } : { status: 'complete', data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      data: empty,
      error: {
        code: 'glob_failed',
        message: `Error searching for files using pattern '${pattern}': ${message}`,
      },
    };
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

export const globHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<ToolHandlerOutcome<GlobResultsData>> => {
  const {
    directory_path: rawDir,
    pattern,
    include_hidden: includeHidden = false,
  } = input as GlobInput;
  const directoryPath = resolveToolPath(ctx.cwd, rawDir);
  return globOutcome(directoryPath, pattern, includeHidden);
};
