/**
 * edit tool — exact string replacement in a file.
 *
 * Diff facts are computed and schema-validated before the atomic mutation so a
 * malformed diff can never leave a partially updated file behind.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import { filePathIntent, type ToolDefinition, type ToolHandler, type ToolHandlerOutcome } from '../types';
import { RiskClass } from '../../../shared/types/permission';
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
  category: 'filesystem',
  riskClass: RiskClass.MUTATION,
  inputPathIntents: (input) => [filePathIntent((input as EditInput).file_path, 'mutation')],
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
    return errorOutcome(filePath, `Error reading file ${filePath}: ${message}`, 'read_failed', '');
  }

  if (old_string === '') {
    return errorOutcome(
      filePath,
      'old_string must not be empty. Provide a non-empty string to match.',
      'empty_old_string',
      content,
    );
  }

  const hasCrlf = content.includes('\r\n');
  const normalizedContent = hasCrlf ? content.replace(/\r\n/g, '\n') : content;
  const normalizedOld = old_string.replace(/\r\n/g, '\n');
  const normalizedNew = new_string.replace(/\r\n/g, '\n');

  if (!normalizedContent.includes(normalizedOld)) {
    return errorOutcome(
      filePath,
      `String '${old_string}' not found in file '${filePath}'. No changes made.`,
      'string_not_found',
      content,
    );
  }

  const matchCount = normalizedContent.split(normalizedOld).length - 1;
  if (!replace_all && matchCount > 1) {
    return errorOutcome(
      filePath,
      `String '${old_string}' found ${matchCount} times in '${filePath}'. Use replace_all=true or provide a more specific string.`,
      'multiple_matches',
      content,
    );
  }

  let newContent = replace_all
    ? normalizedContent.replaceAll(normalizedOld, () => normalizedNew)
    : normalizedContent.replace(normalizedOld, () => normalizedNew);

  if (hasCrlf) {
    newContent = newContent.replace(/\n/g, '\r\n');
  }

  let validated: FileChangeData | undefined;
  try {
    const data = buildStructuredFileChange({
      path: filePath,
      operation: 'update',
      oldContent: content,
      newContent,
    });
    validated = fileChangeDataSchema.parse(data);
    atomicWrite(filePath, newContent);
    return { status: 'complete', data: validated };
  } catch (error) {
    const actualContent = fs.readFileSync(filePath, 'utf-8');
    if (actualContent === newContent && validated !== undefined) {
      return { status: 'complete', data: validated };
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorOutcome(
      filePath,
      `Error editing file ${filePath}: ${message}`,
      'edit_failed',
      content,
    );
  }
};
