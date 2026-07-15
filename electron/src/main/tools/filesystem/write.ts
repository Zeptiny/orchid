/**
 * write tool — create or completely rewrite a file.
 *
 * Params: file_path (required), content (required).
 * - Auto-creates parent directories.
 * - Atomic write (temp + fsync + replace).
 *
 * Ported from Python `src/orchid/tools/file_manipulation.py` lines 311-347.
 *
 * Security note (P1-2):
 * This tool operates on arbitrary absolute paths with no restriction to the
 * project directory. A malicious agent could write to sensitive locations
 * outside the workspace. Path sandboxing is deferred to R20 — the permission
 * system will enforce directory restrictions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { resolveToolPath } from '../types';
import { atomicWrite } from '../ast/utils';

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
    'WARNING: This overwrites the entire file — use edit for partial changes to existing files.',
  inputSchema: writeInputSchema,
  actionLabel: 'Writing...',
  category: 'filesystem',
};

// ── Handler ────────────────────────────────────────────────────────────────

export const writeHandler: ToolHandler = async (input: unknown, ctx) => {
  const { file_path: rawPath, content } = input as WriteInput;
  const file_path = resolveToolPath(ctx.cwd, rawPath);

  try {
    const parentDir = path.dirname(file_path);
    fs.mkdirSync(parentDir, { recursive: true });

    let originalMode: number | undefined;
    try {
      originalMode = fs.statSync(file_path).mode;
    } catch {
      // new file
    }

    atomicWrite(file_path, content);

    // New files default to 0o644; existing mode already restored by atomicWrite
    if (originalMode === undefined) {
      fs.chmodSync(file_path, 0o644);
    }

    const lines = content.split('\n');
    const formatted = lines
      .map((line, i) => `${i + 1} | ${line}`)
      .join('\n');

    const display = `Wrote ${lines.length} lines to ${file_path}`;
    return {
      display,
      content:
        `File written successfully, path: ${file_path}, Showing lines 1-${lines.length} of written file:\n${formatted}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      display: `Write error ${file_path}`,
      content: `Error writing file: ${msg}`,
      isError: true
    };
  }
};
