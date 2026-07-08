/**
 * edit tool — exact string replacement in a file.
 *
 * Params: file_path, old_string, new_string (required), replace_all (optional).
 * - If old_string not found → error.
 * - If multiple matches and replace_all is false → error.
 * - Atomic write (temp + fsync + replace).
 * - Returns unified diff of changes.
 * - Triggers post-write callbacks (RAG, AST re-indexing).
 *
 * Ported from Python `src/orchid/tools/file_manipulation.py` lines 84-204.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { triggerPostWriteCallbacks } from './callbacks';

// ── Schema ─────────────────────────────────────────────────────────────────

export const editInputSchema = z.object({
  file_path: z.string().describe('The path to the file to edit, relative to the current working directory'),
  old_string: z.string().describe(
    'The exact string to find and replace. Must match the file content exactly, including whitespace and indentation.',
  ),
  new_string: z.string().describe('The replacement string'),
  replace_all: z.boolean().optional().describe('Whether to replace all occurrences of the old string (default: false). Use true for renames.'),
});

export type EditInput = z.infer<typeof editInputSchema>;

// ── Tool definition ────────────────────────────────────────────────────────

export const editDefinition: ToolDefinition = {
  name: 'edit',
  description:
    'Replace an exact string match in a file. The old_string must be found exactly once in the file ' +
    '(unless replace_all is true). Use replace_all=false for targeted single edits; ' +
    'use replace_all=true for renaming a variable/function across a file.',
  inputSchema: editInputSchema,
  actionLabel: 'Editing...',
  category: 'filesystem',
};

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Write content atomically: tmp file + fsync + rename.
 * Matches Python `src/orchid/tools/ast.py` lines 198-228.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.edit_${Date.now()}_${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content, undefined, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);

    // fsync parent dir
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/**
 * Generate a unified diff string from old and new content.
 */
function unifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Simple unified diff — count added/removed lines
  const result: string[] = [];
  result.push(`--- old/${filePath}`);
  result.push(`+++ new/${filePath}`);

  // Use a basic Myers-like approach for small files,
  // or fall back to line-level diff for larger ones
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  let hunkOldCount = 0;
  let hunkNewCount = 0;
  const hunkLines: string[] = [];

  function flushHunk(): void {
    if (hunkLines.length === 0) return;
    result.push(
      `@@ -${hunkOldStart + 1},${hunkOldCount} +${hunkNewStart + 1},${hunkNewCount} @@`,
    );
    result.push(...hunkLines);
    hunkLines.length = 0;
  }

  // LCS-based diff
  const lcs = computeLCS(oldLines, newLines);
  let oi = 0;
  let ni = 0;
  let li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      // Common line — flush current hunk if any, then add context
      if (hunkLines.length > 0) {
        flushHunk();
      }
      oi++;
      ni++;
      li++;
    } else {
      if (hunkLines.length === 0) {
        hunkOldStart = oi;
        hunkNewStart = ni;
        hunkOldCount = 0;
        hunkNewCount = 0;
      }
      // Removed from old
      if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        hunkLines.push(`-${oldLines[oi]}`);
        hunkOldCount++;
        oi++;
      }
      // Added in new
      if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        hunkLines.push(`+${newLines[ni]}`);
        hunkNewCount++;
        ni++;
      }
    }
  }

  flushHunk();

  // Normalize: strip trailing \r\n
  return result.map((l) => l.replace(/\r?\n$/, '')).join('\n');
}

/**
 * Compute the Longest Common Subsequence of two string arrays.
 */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

/**
 * Count added/removed lines from a unified diff string.
 * Matches Python `src/orchid/tools/_xml_utils.py` lines 15-25.
 */
function countDiffChanges(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// ── Handler ────────────────────────────────────────────────────────────────

export const editHandler: ToolHandler = async (input: unknown) => {
  const { file_path, old_string, new_string, replace_all = false } = input as EditInput;

  try {
    const content = fs.readFileSync(file_path, 'utf-8');

    // Read original file mode for preservation after atomic write
    const stat = fs.statSync(file_path);
    const originalMode = stat.mode;

    if (!content.includes(old_string)) {
      return {
        display: `String not found in ${file_path}`,
        content: `String '${old_string}' not found in file '${file_path}'. No changes made.`,
      };
    }

    const matchCount = content.split(old_string).length - 1;

    if (!replace_all && matchCount > 1) {
      return {
        display: `Multiple matches in ${file_path}`,
        content:
          `String '${old_string}' found ${matchCount} times in '${file_path}'. ` +
          `Use replace_all=true or provide a more specific string.`,
      };
    }

    const replacements = replace_all ? matchCount : 1;
    let newContent: string;
    if (replace_all) {
      newContent = content.replaceAll(old_string, new_string);
    } else {
      newContent = content.replace(old_string, new_string);
    }

    // Atomic write
    atomicWrite(file_path, newContent);

    // Preserve original file permissions
    fs.chmodSync(file_path, originalMode);

    // Generate diff
    const diffText = unifiedDiff(content, newContent, file_path);
    const { added, removed } = countDiffChanges(diffText);

    // Post-write callbacks
    const cbFailures = await triggerPostWriteCallbacks(file_path);

    let display = `Edited ${file_path}`;
    if (added > 0 || removed > 0) {
      display += ` (+${added} -${removed})`;
    }
    if (cbFailures.length > 0) {
      display += ` [warnings: ${cbFailures.length} callback(s) failed]`;
    }

    return { display, content: diffText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Edit error ${file_path}`,
      content: `Error editing file ${file_path}: ${msg}`,
    };
  }
};
