/**
 * edit tool — exact string replacement in a file.
 *
 * Params: file_path, old_string, new_string (required), replace_all (optional).
 * - If old_string not found → error.
 * - If multiple matches and replace_all is false → error.
 * - Atomic write (temp + fsync + replace).
 * - Returns unified diff of changes.
 *
 * Ported from Python `src/orchid/tools/file_manipulation.py` lines 84-204.
 *
 * Security note (P1-2):
 * This tool operates on arbitrary absolute paths with no restriction to the
 * project directory. A malicious agent could modify sensitive files outside
 * the workspace. Path sandboxing is deferred to R20 — the permission system
 * will enforce directory restrictions.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { resolveToolPath } from '../types';
import { atomicWrite, countDiffChanges, generateDiff } from '../ast/utils';

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

// ── Handler ────────────────────────────────────────────────────────────────

export const editHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, old_string, new_string, replace_all = false } = input as EditInput;
  const file_path = resolveToolPath(ctx.cwd, rawPath);

  try {
    const content = fs.readFileSync(file_path, 'utf-8');

    if (old_string === '') {
      return {
        display: 'Invalid old_string',
        content: 'old_string must not be empty. Provide a non-empty string to match.',
        isError: true,
      };
    }

    if (!content.includes(old_string)) {
      return {
        display: `String not found in ${file_path}`,
        content: `String '${old_string}' not found in file '${file_path}'. No changes made.`,
        isError: true,
      };
    }

    const matchCount = content.split(old_string).length - 1;

    if (!replace_all && matchCount > 1) {
      return {
        display: `Multiple matches in ${file_path}`,
        content:
          `String '${old_string}' found ${matchCount} times in '${file_path}'. ` +
          `Use replace_all=true or provide a more specific string.`,
        isError: true,
      };
    }

    const newContent = replace_all
      ? content.replaceAll(old_string, new_string)
      : content.replace(old_string, new_string);

    atomicWrite(file_path, newContent);

    const diffText = generateDiff(content, newContent, file_path);
    const { added, removed } = countDiffChanges(diffText);

    let display = `Edited ${file_path}`;
    if (added > 0 || removed > 0) {
      display += ` (+${added} -${removed})`;
    }
    return { display, content: diffText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Edit error ${file_path}`,
      content: `Error editing file ${file_path}: ${msg}`,
      isError: true
    };
  }
};
