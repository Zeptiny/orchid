/**
 * grep — search file contents using a regular expression.
 *
 * The handler returns structured path/line/column/text facts.  Binary files,
 * hidden/ignored directories and files that exceed the per-file timeout are
 * skipped as before; reaching max_results is represented as canonical
 * partiality with native rerun guidance.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { getConfig } from '../../config/loader';
import type { Config } from '../../config/schema';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { getToolConfig, resolveToolPath } from '../types';
import { isBinaryFile } from '../ast/utils';
import { globToRegex } from '../glob-pattern';
import {
  grepMatchSchema,
  searchResultsDataSchema,
  type GrepResultsData,
} from '../../../shared/types/tool-result-filesystem';
import type { JsonValue, ToolHandlerOutcome } from '../../../shared/types/tool-result';

type GrepMatch = z.infer<typeof grepMatchSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEMAPHORE_LIMIT = 32;

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.permits++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldSkipDir(dirname: string, ignored: Set<string>): boolean {
  return dirname.startsWith('.') || ignored.has(dirname);
}

async function collectFiles(
  basePath: string,
  fileRegex: RegExp | null,
  ignored: Set<string>,
): Promise<string[]> {
  const collected: string[] = [];

  async function walk(directoryPath: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name, ignored)) {
          await walk(path.join(directoryPath, entry.name));
        }
      } else if (entry.isFile() && (!fileRegex || fileRegex.test(entry.name))) {
        collected.push(path.join(directoryPath, entry.name));
      }
    }
  }

  await walk(basePath);
  return collected.sort((left, right) => {
    const leftRelative = path.relative(basePath, left);
    const rightRelative = path.relative(basePath, right);
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
}

function searchFileSync(
  filePath: string,
  regex: RegExp,
  basePath: string,
  maxResults: number,
): GrepMatch[] | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(basePath, filePath);
    const matches: GrepMatch[] = [];
    for (const [index, line] of content.split('\n').entries()) {
      const matchIndex = line.search(regex);
      if (matchIndex < 0) continue;
        matches.push({
          path: relativePath,
          line: index + 1,
          column: matchIndex + 1,
          // CR is the line separator in a CRLF file, not source content.
          // Preserve all other trailing whitespace exactly.
          text: line.endsWith('\r') ? line.slice(0, -1) : line,
        });
      if (matches.length >= maxResults) break;
    }
    return matches;
  } catch {
    return null;
  }
}

function emptyData(root: string, pattern: string): GrepResultsData {
  return {
    kind: 'grep',
    root,
    pattern,
    matches: [],
    totalMatches: 0,
    limitReached: false,
  };
}

function rerunInput(
  pattern: string,
  directoryPath: string,
  includePattern: string | undefined,
  caseInsensitive: boolean | undefined,
): Record<string, JsonValue> {
  return {
    pattern,
    directory_path: directoryPath,
    ...(includePattern === undefined ? {} : { include_pattern: includePattern }),
    ...(caseInsensitive === undefined ? {} : { case_insensitive: caseInsensitive }),
  };
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const grepInputSchema = z.object({
  pattern: z.string().describe('The regex pattern to search for'),
  directory_path: z.string().describe(
    'The file or directory to search in, relative to the current working directory',
  ),
  include_pattern: z.string().optional().describe(
    'Glob pattern to filter files (e.g., "*.py", "*.txt"). If not set, all files are searched.',
  ),
  case_insensitive: z.boolean().optional().describe(
    'Whether the search should be case insensitive (default: false)',
  ),
  max_results: z.number().int().positive().optional().describe(
    'Maximum number of matching lines to return (default: 100)',
  ),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeGrepOutcome(
  pattern: string,
  directoryPath: string,
  includePattern?: string,
  caseInsensitive?: boolean,
  maxResults?: number,
  config?: Pick<Config, 'grep_max_results' | 'ignored_dirs' | 'grep_per_file_timeout'>,
): Promise<ToolHandlerOutcome<GrepResultsData>> {
  const effectiveMaxResults = maxResults
    ?? config?.grep_max_results
    ?? getConfig().grep_max_results;
  const empty = emptyData(path.resolve(directoryPath), pattern);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      data: empty,
      error: {
        code: 'invalid_regex',
        message: `Invalid regex pattern '${pattern}': ${message}`,
      },
    };
  }

  const basePath = path.resolve(directoryPath);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(basePath);
  } catch {
    return {
      status: 'error',
      data: emptyData(basePath, pattern),
      error: {
        code: 'path_not_found',
        message: `Path '${directoryPath}' does not exist.`,
      },
    };
  }

  const perFileTimeoutMs = (config?.grep_per_file_timeout ?? getConfig().grep_per_file_timeout) * 1000;
  const ignored = new Set(config?.ignored_dirs ?? getConfig().ignored_dirs);
  let fileRegex: RegExp | null = null;
  if (includePattern) fileRegex = globToRegex(includePattern, { caseInsensitive: true });

  let searchRoot: string;
  let filePaths: string[];
  if (stat.isFile()) {
    searchRoot = path.dirname(basePath);
    filePaths = [basePath];
  } else {
    searchRoot = basePath;
    filePaths = await collectFiles(basePath, fileRegex, ignored);
  }
  const semaphore = new Semaphore(SEMAPHORE_LIMIT);
  const perFile = new Map<string, GrepMatch[]>();

  await Promise.all(filePaths.map(async (filePath) => {
    await semaphore.acquire();
    try {
      if (await isBinaryFile(filePath, { unreadableAsBinary: true })) return;
      const matches = await Promise.race([
        Promise.resolve().then(() => searchFileSync(
          filePath,
          regex,
          searchRoot,
          effectiveMaxResults,
        )),
        new Promise<GrepMatch[] | null>((resolve) => {
          setTimeout(() => resolve(null), perFileTimeoutMs);
        }),
      ]);
      if (matches) perFile.set(filePath, matches);
    } finally {
      semaphore.release();
    }
  }));

  const allMatches = filePaths.flatMap((filePath) => perFile.get(filePath) ?? []);
  const returnedMatches = allMatches.slice(0, effectiveMaxResults);
  const limitReached = allMatches.length >= effectiveMaxResults;
  const data: GrepResultsData = {
    kind: 'grep',
    root: searchRoot,
    pattern,
    matches: returnedMatches,
    totalMatches: returnedMatches.length,
    limitReached,
  };
  searchResultsDataSchema.parse(data);

  if (returnedMatches.length === 0) return { status: 'empty', data };
  if (limitReached) {
    return {
      status: 'partial',
      data,
      retrieval: {
        kind: 'rerun',
        toolName: 'grep',
        input: rerunInput(pattern, basePath, includePattern, caseInsensitive),
      },
    };
  }
  return { status: 'complete', data };
}

// ---------------------------------------------------------------------------
// Tool definition / handler
// ---------------------------------------------------------------------------

export const grepToolDefinition: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents using regex. Returns matching lines with file paths and line numbers. ' +
    'Accepts a file path to search a single file, or a directory to search recursively. ' +
    'Use to find function definitions, variable references, error messages, or any text pattern across the codebase.',
  inputSchema: grepInputSchema,
  resultFamily: 'search-results',
  outputDataSchema: searchResultsDataSchema,
  category: 'search',
  riskClass: RiskClass.READ_ONLY,
};

export const grepHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<ToolHandlerOutcome<GrepResultsData>> => {
  const {
    pattern,
    directory_path,
    include_pattern,
    case_insensitive,
    max_results,
  } = input as GrepInput;
  const resolvedDir = resolveToolPath(ctx.cwd, directory_path);
  return executeGrepOutcome(
    pattern,
    resolvedDir,
    include_pattern,
    case_insensitive,
    max_results,
    getToolConfig(ctx),
  );
};
