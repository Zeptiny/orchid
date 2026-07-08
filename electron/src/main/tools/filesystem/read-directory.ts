/**
 * read_directory tool — list directory contents as an ASCII tree.
 *
 * Params: directory_path (required), max_depth (optional), include_hidden (optional).
 * Default depth from config (directory_tree_depth, default 2).
 * Returns a tree with ├── / └── connectors.
 *
 * Ported from Python `src/orchid/utils.py` lines 105-133
 * and `src/orchid/tools/file_manipulation.py` lines 207-250.
 */
import * as fs from 'node:fs';
import * as pathModule from 'node:path';
import { z } from 'zod';
import { getConfig } from '../../config/loader';
import type { ToolDefinition, ToolHandler } from '../types';

// ── Schema ─────────────────────────────────────────────────────────────────

export const readDirectoryInputSchema = z.object({
  directory_path: z.string().describe('The path to the directory to read, relative to the current working directory'),
  max_depth: z.number().int().positive().optional().describe('The max depth of the directory tree (default: from config directory_tree_depth)'),
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
  actionLabel: 'Browsing...',
  category: 'filesystem',
};

// ── Tree builder ───────────────────────────────────────────────────────────

function directoryTree(
  dirPath: string,
  maxDepth: number,
  includeHidden: boolean,
  ignoredDirs: Set<string>,
  depth: number = 0,
  prefix: string = '',
): string {
  if (depth >= maxDepth) return '';

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath).sort();
  } catch {
    return '';
  }

  if (!includeHidden) {
    entries = entries.filter(
      (e) => !e.startsWith('.') && !ignoredDirs.has(e),
    );
  }

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fullPath = pathModule.join(dirPath, entry);
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        lines.push(`${prefix}${connector}${entry}/`);
        const subtree = directoryTree(
          fullPath,
          maxDepth,
          includeHidden,
          ignoredDirs,
          depth + 1,
          prefix + childPrefix,
        );
        if (subtree) lines.push(subtree);
      } else {
        lines.push(`${prefix}${connector}${entry}`);
      }
    } catch {
      // skip entries we can't stat
    }
  }

  return lines.join('\n');
}

// ── Handler ────────────────────────────────────────────────────────────────

export const readDirectoryHandler: ToolHandler = async (input: unknown) => {
  const { directory_path, max_depth, include_hidden = false } = input as ReadDirectoryInput;
  const effectiveMaxDepth = max_depth ?? getConfig().directory_tree_depth;
  const ignoredDirs = new Set(getConfig().ignored_dirs);

  try {
    const result = directoryTree(
      directory_path,
      effectiveMaxDepth,
      include_hidden,
      ignoredDirs,
    );

    return {
      display: `Read directory ${directory_path}`,
      content: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Read directory error ${directory_path}`,
      content: `Error reading directory ${directory_path}: ${msg}`,
    };
  }
};
