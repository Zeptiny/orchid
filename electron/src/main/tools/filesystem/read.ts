/**
 * read tool — return a requested, numbered source range as structured data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { filePathIntent, type ToolDefinition, type ToolHandler, type ToolHandlerOutcome } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { getToolConfig, resolveBoundToolPath } from '../types';
import { isBinaryFileSync } from '../ast/utils';
import {
  fileContentDataSchema,
  type FileContentData,
} from '../../../shared/types/tool-result-filesystem';

// ── Schema ─────────────────────────────────────────────────────────────────

export const readInputSchema = z.object({
  file_path: z.string().describe('The path to the file to read, relative to the current working directory'),
  offset: z.number().int().min(1).optional().describe('The line number to start from (default: 1, 1-indexed)'),
  limit: z.number().int().positive().optional().describe('The maximum number of lines to read (default: from config read_line_limit)'),
});

export type ReadInput = z.infer<typeof readInputSchema>;

// ── Tool definition ────────────────────────────────────────────────────────

export const readDefinition: ToolDefinition = {
  name: 'read',
  description:
    'Read the content of a file. Returns lines with line numbers. ' +
    'Use offset/limit to read specific sections of large files rather than reading the entire file.',
  inputSchema: readInputSchema,
  resultFamily: 'file-content',
  outputDataSchema: fileContentDataSchema,
  category: 'filesystem',
  riskClass: RiskClass.READ_ONLY,
  inputPathIntents: (input) => [filePathIntent((input as ReadInput).file_path, 'read')],
  offload: true,
};
function languageHint(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const languages: Record<string, string> = {
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.css': 'css',
    '.go': 'go',
    '.html': 'html',
    '.java': 'java',
    '.js': 'javascript',
    '.json': 'json',
    '.jsx': 'javascript',
    '.md': 'markdown',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.sh': 'shell',
    '.sql': 'sql',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  };
  return languages[extension] ?? 'text';
}

function contentData(
  filePath: string,
  requestedRange: FileContentData['requestedRange'],
  lines: FileContentData['lines'],
  returnedRange: FileContentData['returnedRange'],
  totalLineCount: number,
): FileContentData {
  return fileContentDataSchema.parse({
    path: filePath,
    lines,
    requestedRange,
    returnedRange,
    totalLineCount,
    language: languageHint(filePath),
  });
}

function errorOutcome(
  filePath: string,
  requestedRange: FileContentData['requestedRange'],
  message: string,
  code: string,
  totalLineCount = 0,
  lines: FileContentData['lines'] = [],
): ToolHandlerOutcome<FileContentData> {
  return {
    status: 'error',
    data: contentData(filePath, requestedRange, lines, null, totalLineCount),
    error: { code, message },
  };
}

function splitSourceLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  // A terminal newline terminates the last line; it does not introduce an
  // additional empty source line.
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

// ── Handler ────────────────────────────────────────────────────────────────

export const readHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, offset = 1, limit } = input as ReadInput;
  const filePath = resolveBoundToolPath(ctx, rawPath);
  const configuredLimit = getToolConfig(ctx).read_line_limit;
  const effectiveLimit = limit ?? configuredLimit ?? 1000;
  const requestedEnd = offset + effectiveLimit - 1;
  const requestedRange = { start: offset, end: requestedEnd };

  try {
    if (isBinaryFileSync(filePath)) {
      return errorOutcome(
        filePath,
        requestedRange,
        `Error reading file ${filePath}: file appears to be binary.`,
        'binary_file',
      );
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const allLines = splitSourceLines(content);
    const lineCount = allLines.length;

    if (lineCount === 0) {
      const data = contentData(filePath, requestedRange, [], null, 0);
      return { status: 'empty', data };
    }

    if (offset > lineCount) {
      return errorOutcome(
        filePath,
        requestedRange,
        `Offset of ${offset} is greater than the file line count ${lineCount}`,
        'offset_out_of_range',
        lineCount,
      );
    }

    const startIndex = offset - 1;
    const endIndex = Math.min(startIndex + effectiveLimit, lineCount);
    const selectedLines = allLines.slice(startIndex, endIndex).map((line, index) => ({
      number: startIndex + index + 1,
      content: line,
    }));
    const returnedRange = { start: offset, end: endIndex };
    const data = contentData(filePath, requestedRange, selectedLines, returnedRange, lineCount);

    if (endIndex < lineCount) {
      return {
        status: 'partial',
        data,
        retrieval: { kind: 'read', path: filePath, offset: endIndex + 1, limit: effectiveLimit },
      };
    }
    return { status: 'complete', data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorOutcome(
      filePath,
      requestedRange,
      `Error reading file ${filePath}: ${message}`,
      'read_failed',
    );
  }
};
