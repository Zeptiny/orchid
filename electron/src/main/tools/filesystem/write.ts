/**
 * write tool — create or completely rewrite a file.
 *
 * Params: file_path (required), content (required).
 * - Auto-creates parent directories.
 * - Atomic write (temp + fsync + replace).
 * - Triggers post-write callbacks (RAG, AST re-indexing).
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
import { triggerPostWriteCallbacks } from './callbacks';

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

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Write content atomically: tmp file + fsync + rename.
 * Matches Python `src/orchid/tools/ast.py` lines 198-228.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.write_${Date.now()}_${process.pid}.tmp`);
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

// ── Handler ────────────────────────────────────────────────────────────────

export const writeHandler: ToolHandler = async (input: unknown) => {
  const { file_path, content } = input as WriteInput;

  try {
    // Auto-create parent directories
    const parentDir = path.dirname(file_path);
    fs.mkdirSync(parentDir, { recursive: true });

    // Preserve original file permissions if file exists
    let originalMode: number | undefined;
    try {
      const stat = fs.statSync(file_path);
      originalMode = stat.mode;
    } catch {
      // File doesn't exist, will use default mode
    }

    // Atomic write
    atomicWrite(file_path, content);

    // Preserve original file permissions (default to 0o644 for new files)
    fs.chmodSync(file_path, originalMode ?? 0o644);

    // Post-write callbacks
    const cbFailures = await triggerPostWriteCallbacks(file_path);

    const lines = content.split('\n');
    const formatted = lines
      .map((line, i) => `${i + 1} | ${line}`)
      .join('\n');

    let display = `Wrote ${lines.length} lines to ${file_path}`;
    if (cbFailures.length > 0) {
      display += ` [warnings: ${cbFailures.length} callback(s) failed]`;
    }

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
    };
  }
};
