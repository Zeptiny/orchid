/**
 * read tool — read file contents with line numbers.
 *
 * Params: file_path (required), offset (optional), limit (optional).
 * Returns lines in `num | content` format.
 * Default limit from config (read_line_limit, default 1000).
 * Binary detection: skips files that contain null bytes.
 *
 * Ported from Python `src/orchid/tools/file_manipulation.py` lines 18-81.
 *
 * Security note (P1-2):
 * This tool operates on arbitrary absolute paths with no restriction to the
 * project directory. A malicious agent could read sensitive files outside the
 * workspace (e.g., /etc/passwd, ~/.ssh/id_rsa). Path sandboxing is deferred
 * to R20 — the permission system will enforce directory restrictions.
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import { getConfig } from '../../config/loader';
import type { ToolDefinition, ToolHandler } from '../types';

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
  actionLabel: 'Reading...',
  category: 'filesystem',
};

// ── Binary detection ───────────────────────────────────────────────────────

const BINARY_CHECK_BYTES = 8192;

function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(BINARY_CHECK_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

export const readHandler: ToolHandler = async (input: unknown) => {
  const { file_path, offset = 1, limit } = input as ReadInput;
  const effectiveLimit = limit ?? getConfig().read_line_limit;

  try {
    // Binary check
    if (isBinaryFile(file_path)) {
      return {
        display: `Read error ${file_path}`,
        content: `Error reading file ${file_path}: file appears to be binary.`,
      isError: true
    };
    }

    const content = fs.readFileSync(file_path, 'utf-8');
    const allLines = content.split('\n');

    // Empty file (split gives [''] for empty string, so check actual content)
    if (content.length === 0 || (allLines.length === 1 && allLines[0] === '')) {
      return {
        display: `Read ${file_path} is empty`,
        content: `File ${file_path} is empty (0 lines)`,
      };
    }

    const lineCount = allLines.length;

    if (offset > lineCount) {
      return {
        display: `Read ${file_path}, offset ${offset} out of range`,
        content: `Offset of ${offset} is greater than the file line count ${lineCount}`,
        isError: true,
      };
    }

    // Slice lines: offset is 1-indexed, array is 0-indexed
    const startIdx = offset - 1;
    const endIdx = Math.min(startIdx + effectiveLimit, lineCount);
    const selectedLines = allLines.slice(startIdx, endIdx);

    const formatted = selectedLines
      .map((line, i) => `${startIdx + i + 1} | ${line}`)
      .join('\n');

    const displayEnd = Math.min(offset + effectiveLimit - 1, lineCount);
    return {
      display: `Read ${file_path} lines ${offset}-${displayEnd}`,
      content: `Showing lines ${offset}-${displayEnd} of ${lineCount}\n${formatted}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Read error ${file_path}`,
      content: `Error reading file ${file_path}: ${msg}`,
      isError: true
    };
  }
};
