/**
 * read_output tool — read output from a background command.
 *
 * Returns a snapshot of recent output and exit code. Supports long-polling
 * (wait_ms) to block until new output, exit, or deadline.
 *
 * Ported from Python `src/orchid/tools/background_io.py`.
 */
import { z } from 'zod';
import { getBackgroundStore } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LONG_POLL_MS = 60_000;

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const readOutputInputSchema = z.object({
  id: z.number().int().describe('The background command id'),
  last_n: z.number().int().optional().describe('Number of recent output lines to include (default: all available)'),
  wait_ms: z.number().int().optional().describe('Long-poll: wait up to this many milliseconds for new output or exit (default: no wait)'),
});

export type ReadOutputInput = z.infer<typeof readOutputInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeReadOutput(
  id: number,
  lastN?: number,
  waitMs?: number,
): Promise<{ display: string; content: string }> {
  const store = getBackgroundStore();
  const entry = store.getVisible(id);
  if (!entry) {
    return {
      display: `Background command ${id} not found`,
      content: `Error: No background command with id ${id}.`,
    };
  }

  // Long-poll: wait for new output or exit before snapshotting.
  if (waitMs !== undefined && waitMs > 0 && entry.exitCode === null) {
    const bounded = Math.min(waitMs, MAX_LONG_POLL_MS);
    await store.wait_for_progress(id, bounded);
  }

  const result = store.snapshotVisible(id, lastN);
  if (!result) {
    return {
      display: `Background command ${id} not found`,
      content: `Error: No background command with id ${id}.`,
    };
  }

  const { tail, exitCode } = result;
  const status = exitCode !== null ? 'exited' : 'running';
  const cmdPreview = entry.command.length > 80
    ? entry.command.substring(0, 79) + '...'
    : entry.command;

  const exitLine = exitCode !== null ? `\nExit code: ${exitCode}` : '';

  return {
    display: `$ ${cmdPreview} (${status})`,
    content: tail + exitLine,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const readOutputToolDefinition: ToolDefinition = {
  name: 'read_output',
  description:
    'Read output from a background command. Returns a snapshot of recent ' +
    'output and exit code. Use wait_ms for long-polling: blocks until new ' +
    'output, exit, or deadline.',
  inputSchema: readOutputInputSchema,
  actionLabel: 'Reading output...',
  category: 'process',
};

export const readOutputHandler: ToolHandler = async (input: unknown) => {
  const { id, last_n, wait_ms } = input as ReadOutputInput;
  return executeReadOutput(id, last_n, wait_ms);
};
