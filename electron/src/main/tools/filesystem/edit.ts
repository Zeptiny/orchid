/**
 * edit tool — exact string replacement in a file.
 *
 * Diff facts are computed and schema-validated before the atomic mutation so a
 * malformed diff can never leave a partially updated file behind.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler, ToolHandlerOutcome } from '../types';
import { resolveToolPath } from '../types';
import { atomicWrite } from '../ast/utils';
import { buildStructuredFileChange } from './structured-diff';
import {
  fileChangeDataSchema,
  type FileChangeData,
} from '../../../shared/types/tool-result-filesystem';

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
  resultFamily: 'file-change',
  outputDataSchema: fileChangeDataSchema,
  actionLabel: 'Editing...',
  category: 'filesystem',
};
function errorOutcome(
  filePath: string,
  message: string,
  code: string,
  resultingContent = '',
): ToolHandlerOutcome<FileChangeData> {
  return {
    status: 'error',
    data: {
      path: filePath,
      operation: 'update',
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      resultingContent,
    },
    error: { code, message },
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

export const editHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, old_string, new_string, replace_all = false } = input as EditInput;
  const filePath = resolveToolPath(ctx.cwd, rawPath);

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorOutcome(filePath, `Error reading file ${filePath}: ${message}`, 'read_failed');
  }

  if (old_string === '') {
    return errorOutcome(
      filePath,
      'old_string must not be empty. Provide a non-empty string to match.',
      'empty_old_string',
      content,
    );
  }

  if (!content.includes(old_string)) {
    return errorOutcome(
      filePath,
      `String '${old_string}' not found in file '${filePath}'. No changes made.`,
      'string_not_found',
      content,
    );
  }

  const matchCount = content.split(old_string).length - 1;
  if (!replace_all && matchCount > 1) {
    return errorOutcome(
      filePath,
      `String '${old_string}' found ${matchCount} times in '${filePath}'. Use replace_all=true or provide a more specific string.`,
      'multiple_matches',
      content,
    );
  }

  const newContent = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string);

  try {
    // This computes, validates, and fully materializes all canonical facts
    // before the source is touched.
    const data = buildStructuredFileChange({
      path: filePath,
      operation: 'update',
      oldContent: content,
      newContent,
    });
    // Keep this explicit validation at the mutation boundary in case the
    // structured helper is replaced by a test seam or future implementation.
    const validated = fileChangeDataSchema.parse(data);
    atomicWrite(filePath, newContent);
    return { status: 'complete', data: validated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorOutcome(
      filePath,
      `Error editing file ${filePath}: ${message}`,
      'edit_failed',
      content,
    );
  }
};
