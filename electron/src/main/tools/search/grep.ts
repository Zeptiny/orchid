/**
 * grep tool — search file contents using regex.
 *
 * Returns matching lines with file paths and line numbers. Bounded concurrency
 * (semaphore=32), per-file timeout (10s), binary detection, glob-to-regex
 * file filtering, max_results cancellation.
 *
 * Ported from Python `src/orchid/tools/search.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { getConfig } from '../../config/loader';
import type { Config } from '../../config/schema';
import type { ToolDefinition, ToolHandler } from '../types';
import { getToolConfig, resolveToolPath } from '../types';
import { isBinaryFile } from '../ast/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PER_FILE_TIMEOUT_MS = 10_000; // 10 seconds
const SEMAPHORE_LIMIT = 32;

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private _permits: number;
  private _queue: Array<() => void> = [];

  constructor(permits: number) {
    this._permits = permits;
  }

  async acquire(): Promise<void> {
    if (this._permits > 0) {
      this._permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._permits++;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern (like *.ts, *.py) to a regex.
 * Uses fnmatch.translate() equivalent logic.
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      regex += '.*';
    } else if (c === '?') {
      regex += '.';
    } else if (c === '[') {
      // Find closing bracket
      const j = pattern.indexOf(']', i + 1);
      if (j !== -1) {
        regex += '[' + pattern.substring(i + 1, j).replace(/\\/g, '\\\\') + ']';
        i = j;
      } else {
        regex += '\\[';
      }
    } else if (c === '.') {
      regex += '\\.';
    } else {
      regex += c.replace(/[\\^$+{}()|]/g, '\\$&');
    }
    i++;
  }
  return new RegExp('^' + regex + '$', 'i');
}

function shouldSkipDir(dirname: string, ignored: Set<string>): boolean {
  if (ignored.has(dirname)) return true;
  return dirname.startsWith('.');
}

async function collectFiles(
  basePath: string,
  fileRegex: RegExp | null,
  ignored: Set<string>,
): Promise<string[]> {
  const collected: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }

    // Filter directories (in-place equivalent)
    const subdirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name, ignored)) {
          subdirs.push(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        if (fileRegex && !fileRegex.test(entry.name)) continue;
        files.push(path.join(dir, entry.name));
      }
    }

    files.sort();
    collected.push(...files);

    // Recurse into subdirectories
    for (const subdir of subdirs) {
      await walk(subdir);
    }
  }

  await walk(basePath);
  return collected;
}

function searchFileSync(
  filePath: string,
  regex: RegExp,
  basePath: string,
  maxResults: number,
): string[] | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const matches: string[] = [];
    const relativePath = path.relative(basePath, filePath);

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${relativePath}:${i + 1}: ${lines[i].replace(/\s+$/, '')}`);
        if (matches.length >= maxResults) break;
      }
    }
    return matches;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const grepInputSchema = z.object({
  pattern: z.string().describe('The regex pattern to search for'),
  directory_path: z.string().describe('The directory to search in, relative to the current working directory'),
  include_pattern: z.string().optional().describe('Glob pattern to filter files (e.g., "*.py", "*.txt"). If not set, all files are searched.'),
  case_insensitive: z.boolean().optional().describe('Whether the search should be case insensitive (default: false)'),
  max_results: z.number().int().positive().optional().describe('Maximum number of matching lines to return (default: 100)'),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeGrep(
  pattern: string,
  directoryPath: string,
  includePattern?: string,
  caseInsensitive?: boolean,
  maxResults?: number,
  config?: Pick<Config, 'grep_max_results' | 'ignored_dirs'>,
): Promise<{ display: string; content: string; isError?: boolean }> {
  if (maxResults === undefined) {
    maxResults = config?.grep_max_results ?? getConfig().grep_max_results;
  }

  // Compile regex
  let regex: RegExp;
  try {
    const flags = caseInsensitive ? 'i' : '';
    regex = new RegExp(pattern, flags);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      display: `Invalid regex: ${pattern}`,
      content: `Error: Invalid regex pattern '${pattern}': ${msg}`,
      isError: true,
    };
  }

  // Resolve base path
  const basePath = path.resolve(directoryPath);
  try {
    const stat = await fs.promises.stat(basePath);
    if (!stat.isDirectory()) {
      return {
        display: `Directory not found: ${directoryPath}`,
        content: `Error: Directory '${directoryPath}' does not exist.`,
      isError: true,
      };
    }
  } catch {
    return {
      display: `Directory not found: ${directoryPath}`,
      content: `Error: Directory '${directoryPath}' does not exist.`,
      isError: true,
    };
  }

  // Build ignored set
  const ignored = new Set(config?.ignored_dirs ?? getConfig().ignored_dirs);

  // Compile file filter regex
  let fileRegex: RegExp | null = null;
  if (includePattern) {
    fileRegex = globToRegex(includePattern);
  }

  // Collect all files
  const filePaths = await collectFiles(basePath, fileRegex, ignored);

  // Search files with bounded concurrency
  const semaphore = new Semaphore(SEMAPHORE_LIMIT);
  const results: string[] = [];
  let cancelled = false;

  const searchTasks = filePaths.map(async (filePath) => {
    if (cancelled) return;
    await semaphore.acquire();
    try {
      if (cancelled) return;

      // Binary detection
      if (await isBinaryFile(filePath, { unreadableAsBinary: true })) return;

      // Per-file timeout
      const matches = await Promise.race([
        Promise.resolve().then(() => searchFileSync(filePath, regex, basePath, maxResults!)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PER_FILE_TIMEOUT_MS)),
      ]);

      if (matches && !cancelled) {
        for (const match of matches) {
          if (cancelled) break;
          results.push(match);
          if (results.length >= maxResults!) {
            cancelled = true;
            break;
          }
        }
      }
    } finally {
      semaphore.release();
    }
  });

  await Promise.allSettled(searchTasks);

  if (results.length === 0) {
    return {
      display: `No matches for '${pattern}'`,
      content: `No matches found for pattern '${pattern}' in '${directoryPath}'.`,
    };
  }

  const outputLines = [`Found ${results.length} match(es) for pattern '${pattern}':`];
  outputLines.push(...results);

  if (results.length >= maxResults!) {
    outputLines.push(`\n... (truncated to ${maxResults} results)`);
  }

  return {
    display: `Found ${results.length} matches for '${pattern}'`,
    content: outputLines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const grepToolDefinition: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents using regex. Returns matching lines with file paths and line numbers. ' +
    'Use to find function definitions, variable references, error messages, or any text pattern across the codebase.',
  inputSchema: grepInputSchema,
  actionLabel: 'Grepping...',
  category: 'search',
};

export const grepHandler: ToolHandler = async (input: unknown, ctx) => {
  const { pattern, directory_path, include_pattern, case_insensitive, max_results } =
    input as GrepInput;
  const resolvedDir = resolveToolPath(ctx.cwd, directory_path);
  const config = getToolConfig(ctx);
  return executeGrep(
    pattern,
    resolvedDir,
    include_pattern,
    case_insensitive,
    max_results,
    config,
  );
};
