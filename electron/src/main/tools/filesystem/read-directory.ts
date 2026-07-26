/**
 * read_directory — enumerate a directory as structured, canonical entries.
 *
 * The old implementation returned an ASCII tree.  The tree is a renderer
 * concern now; the handler records the path, hierarchy, kind and stat facts
 * that the renderer (and the agent projector) can derive from later.
 */
import * as fs from 'node:fs';
import * as pathModule from 'node:path';
import { z } from 'zod';
import { directoryPathIntent, type ToolDefinition, type ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { getToolConfig, resolveToolPath } from '../types';
import {
  directoryEntriesDataSchema,
  type DirectoryEntriesData,
  type DirectoryEntry,
} from '../../../shared/types/tool-result-filesystem';
import type { ToolHandlerOutcome } from '../../../shared/types/tool-result';

// ── Schema ─────────────────────────────────────────────────────────────────

export const readDirectoryInputSchema = z.object({
  directory_path: z.string().describe(
    'The path to the directory to read, relative to the current working directory',
  ),
  max_depth: z.number().int().positive().optional().describe(
    'The max depth of the directory tree (default: from config directory_tree_depth)',
  ),
  include_hidden: z.boolean().optional().describe(
    'Whether to include hidden files and directories (starting with . or cache/builds/dist/envs/tooling directories) (default: false)',
  ),
});

export type ReadDirectoryInput = z.infer<typeof readDirectoryInputSchema>;

// ── Tool definition ────────────────────────────────────────────────────────

export const readDirectoryDefinition: ToolDefinition = {
  name: 'read_directory',
  description:
    'List the contents of a directory as a tree. ' +
    'Use this to understand project structure before reading individual files. ' +
    'Returns directory names with trailing / and file names.',
  inputSchema: readDirectoryInputSchema,
  resultFamily: 'directory-entries',
  outputDataSchema: directoryEntriesDataSchema,
  category: 'filesystem',
  riskClass: RiskClass.READ_ONLY,
  inputPathIntents: (input) => [directoryPathIntent((input as ReadDirectoryInput).directory_path, 'read')],
};

// ── Tree builder ────────────────────────────────────────────────────────────

function visibleEntryNames(
  names: string[],
  includeHidden: boolean,
  ignoredDirs: Set<string>,
): string[] {
  // Preserve the historical policy: ignored names are omitted along with
  // hidden names by default.  `include_hidden` is an explicit opt-in to both
  // classes of names, matching the pre-canonical tool behavior.
  return names
    .filter((name) => includeHidden || (!name.startsWith('.') && !ignoredDirs.has(name)))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function hasVisibleChildren(
  directoryPath: string,
  includeHidden: boolean,
  ignoredDirs: Set<string>,
): boolean {
  try {
    const names = fs.readdirSync(directoryPath);
    return visibleEntryNames(names, includeHidden, ignoredDirs).length > 0;
  } catch {
    // An unreadable boundary is still incomplete: callers cannot inspect all
    // of its children at this depth.
    return true;
  }
}

interface DirectoryWalkOptions {
  maxDepth: number;
  includeHidden: boolean;
  ignoredDirs: Set<string>;
}

function collectDirectoryEntries(
  root: string,
  options: DirectoryWalkOptions,
): { entries: DirectoryEntry[]; depthLimitReached: boolean } {
  const entries: DirectoryEntry[] = [];
  let depthLimitReached = false;

  const walk = (directoryPath: string, parentPath: string | undefined, depth: number): void => {
    if (depth >= options.maxDepth) {
      depthLimitReached = true;
      return;
    }

    let names: string[];
    try {
      names = visibleEntryNames(
        fs.readdirSync(directoryPath),
        options.includeHidden,
        options.ignoredDirs,
      );
    } catch {
      // The root is checked before this function is called.  A directory can
      // disappear or become unreadable during traversal; retaining the facts
      // already collected is preferable to manufacturing entries.
      return;
    }

    for (const name of names) {
      const fullPath = pathModule.join(directoryPath, name);
      const relativePath = pathModule.relative(root, fullPath) || name;
      let stat: fs.Stats;
      let kind: DirectoryEntry['kind'];
      try {
        // lstat is intentional: symlinks are facts in the result and should
        // not be followed into another tree (or loop forever).
        stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) kind = 'symlink';
        else if (stat.isDirectory()) kind = 'directory';
        else if (stat.isFile()) kind = 'file';
        else kind = 'other';
      } catch {
        // Entries can disappear between readdir and lstat.  This mirrors the
        // old renderer path, which skipped entries that could not be stated.
        continue;
      }

      const entry: DirectoryEntry = {
        name,
        relativePath,
        kind,
        depth,
        ...(parentPath === undefined ? {} : { parentPath }),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
      entries.push(entry);

      if (kind === 'directory') {
        if (depth + 1 >= options.maxDepth) {
          // We deliberately do not recurse at the configured boundary, but
          // report that more entries may exist below it.  Checking visibility
          // keeps an empty boundary directory complete.
          if (hasVisibleChildren(fullPath, options.includeHidden, options.ignoredDirs)) {
            depthLimitReached = true;
          }
        } else {
          walk(fullPath, relativePath, depth + 1);
        }
      }
    }
  };

  walk(root, undefined, 0);
  return { entries, depthLimitReached };
}

function emptyDirectoryData(
  root: string,
  depthLimit: number,
): DirectoryEntriesData {
  return {
    root,
    entries: [],
    totalEntries: 0,
    depthLimit,
    depthLimitReached: false,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

export const readDirectoryHandler: ToolHandler = async (
  input: unknown,
  ctx,
): Promise<ToolHandlerOutcome<DirectoryEntriesData>> => {
  const {
    directory_path: rawDir,
    max_depth,
    include_hidden = false,
  } = input as ReadDirectoryInput;
  const directoryPath = resolveToolPath(ctx.cwd, rawDir);
  const config = getToolConfig(ctx);
  const depthLimit = max_depth ?? config.directory_tree_depth ?? 2;
  const ignoredDirs = new Set(config.ignored_dirs);

  const baseData = () => emptyDirectoryData(directoryPath, depthLimit);

  try {
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory()) {
      return {
        status: 'error',
        data: baseData(),
        error: {
          code: 'not_a_directory',
          message: `Path '${directoryPath}' is not a directory.`,
        },
      };
    }

    const { entries, depthLimitReached } = collectDirectoryEntries(directoryPath, {
      maxDepth: depthLimit,
      includeHidden: include_hidden,
      ignoredDirs,
    });
    const data: DirectoryEntriesData = {
      root: directoryPath,
      entries,
      totalEntries: entries.length,
      depthLimit,
      depthLimitReached,
    };
    directoryEntriesDataSchema.parse(data);
    return entries.length === 0
      ? { status: 'empty', data }
      : depthLimitReached
        ? {
            status: 'partial',
            data,
            retrieval: {
              kind: 'rerun',
              toolName: 'read_directory',
              input: {
                directory_path: directoryPath,
                max_depth: depthLimit + 1,
                include_hidden,
              },
            },
          }
        : { status: 'complete', data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      data: baseData(),
      error: {
        code: 'directory_read_failed',
        message: `Error reading directory '${directoryPath}': ${msg}`,
      },
    };
  }
};
