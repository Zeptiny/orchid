/**
 * write tool — create or completely rewrite a file.
 *
 * The canonical result is content-first: the resulting bytes/text and exact
 * counts are persisted directly, without manufacturing a replacement diff.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { resolveToolPath } from '../types';
import { atomicWrite } from '../ast/utils';
import {
  fileWriteDataSchema,
  type FileWriteData,
} from '../../../shared/types/tool-result-filesystem';

// ── Schema ─────────────────────────────────────────────────────────────────

export const writeInputSchema = z.object({
  file_path: z.string().describe('The file path, relative to the current working directory'),
  content: z.string().describe('The complete file content to write'),
});

export type WriteInput = z.infer<typeof writeInputSchema>;

// ── Tool definition ────────────────────────────────────────────────────────

export const writeDefinition: ToolDefinition = {
  name: 'write',
  description:
    'Create a new file or completely rewrite an existing file. ' +
    'Parent directories are created automatically. ' +
    'The tool result is a compact head/tail preview (not the full body); use read to verify content. ' +
    'WARNING: This overwrites the entire file — use edit for partial changes to existing files.',
  inputSchema: writeInputSchema,
  resultFamily: 'file-write',
  outputDataSchema: fileWriteDataSchema,
  category: 'filesystem',
};

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith('\n')
    ? content.split('\n').length - 1
    : content.split('\n').length;
}

function writeData(filePath: string, operation: FileWriteData['operation'], content: string): FileWriteData {
  return fileWriteDataSchema.parse({
    path: filePath,
    operation,
    content,
    byteCount: Buffer.byteLength(content, 'utf8'),
    lineCount: countLines(content),
  });
}

// ── Handler ────────────────────────────────────────────────────────────────

export const writeHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, content } = input as WriteInput;
  const filePath = resolveToolPath(ctx.cwd, rawPath);
  const operation: FileWriteData['operation'] = fs.existsSync(filePath) ? 'replace' : 'create';
  const data = writeData(filePath, operation, content);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWrite(filePath, content);

    // New files default to 0644; existing mode already restored by atomicWrite.
    if (operation === 'create') {
      fs.chmodSync(filePath, 0o644);
    }
    return { status: 'complete', data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      data,
      error: { code: 'write_failed', message: `Error writing file ${filePath}: ${message}` },
    };
  }
};
