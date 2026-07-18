/**
 * read_output tool — read output from a background command.
 *
 * Returns a snapshot of recent output and exit code. Supports long-polling
 * (wait_ms) to block until new output, exit, or deadline.
 *
 * Ported from Python `src/orchid/tools/background_io.py`.
 */
import { z } from 'zod';
import { normalizeAgentScopeId } from '../../../shared/types/agent-scope';
import { getBackgroundStore } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';

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
  sessionId?: string | null,
  agentScopeId?: string | null,
): Promise<GenericBuiltInToolOutcome> {
  const store = getBackgroundStore();
  const scopeSessionId = sessionId ?? null;
  const scopeAgent = normalizeAgentScopeId(agentScopeId);
  // Visibility is session + agent scoped (peer agents cannot read each other).
  const entry = store.getVisible(id, scopeSessionId, scopeAgent);
  if (!entry) {
    return genericBuiltInToolOutcome('read_output', `Error: No background command with id ${id}.`, 'error');
  }

  // Long-poll: wait for new output or exit before snapshotting.
  if (waitMs !== undefined && waitMs > 0 && entry.exitCode === null) {
    const bounded = Math.min(waitMs, MAX_LONG_POLL_MS);
    await store.wait_for_progress(id, bounded);
  }

  const result = store.snapshotVisible(id, lastN, scopeSessionId, scopeAgent);
  if (!result) {
    return genericBuiltInToolOutcome('read_output', `Error: No background command with id ${id}.`, 'error');
  }

  const { tail, exitCode } = result;
  const exitLine = exitCode !== null ? `\nExit code: ${exitCode}` : '';

  return genericBuiltInToolOutcome('read_output', tail + exitLine, 'complete');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const readOutputToolDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'read_output',
  description:
    'Read output from a background command. Returns a snapshot of recent ' +
    'output and exit code. Use wait_ms for long-polling: blocks until new ' +
    'output, exit, or deadline.',
  inputSchema: readOutputInputSchema,
  actionLabel: 'Reading output...',
  category: 'process',
};

export const readOutputHandler: ToolHandler = async (input: unknown, ctx) => {
  const { id, last_n, wait_ms } = input as ReadOutputInput;
  return executeReadOutput(
    id,
    last_n,
    wait_ms,
    ctx.sessionId ?? null,
    ctx.agentScopeId ?? 'main',
  );
};
