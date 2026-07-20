/**
 * terminate_command tool — terminate a running background command.
 *
 * Sends SIGTERM followed by SIGKILL to the process group.
 * Use when a background command is no longer needed or is stuck.
 *
 * Ported from Python `src/orchid/tools/background_io.py`.
 */
import { z } from 'zod';
import { normalizeAgentScopeId } from '../../../shared/types/agent-scope';
import { getBackgroundStore } from './background-store';
import { backgroundCommandNotFound } from './not-found';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const terminateCommandInputSchema = z.object({
  id: z.number().int().describe('The background command id to terminate'),
});

export type TerminateCommandInput = z.infer<typeof terminateCommandInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeTerminateCommand(
  id: number,
  sessionId?: string | null,
  agentScopeId?: string | null,
): Promise<GenericBuiltInToolOutcome> {
  const store = getBackgroundStore();
  // Visibility: session + agent scope (peer agents cannot terminate each other).
  const entry = store.getVisible(id, sessionId ?? null, normalizeAgentScopeId(agentScopeId));
  if (!entry) {
    return backgroundCommandNotFound('terminate_command', id);
  }

  if (entry.exitCode !== null) {
    return genericBuiltInToolOutcome('terminate_command', {
      commandId: id,
      exitCode: entry.exitCode,
    }, 'complete');
  }

  store.terminate(id);

  return genericBuiltInToolOutcome('terminate_command', {
    commandId: id,
    command: entry.command,
  }, 'complete');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const terminateCommandToolDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'terminate_command',
  description:
    'Terminate a running background command. Sends SIGTERM followed by ' +
    'SIGKILL to the process group. Use when a background command is no ' +
    'longer needed or is stuck.',
  inputSchema: terminateCommandInputSchema,
  actionLabel: 'Terminating...',
  category: 'process',
};

export const terminateCommandHandler: ToolHandler = async (input: unknown, ctx) => {
  const { id } = input as TerminateCommandInput;
  return executeTerminateCommand(
    id,
    ctx.sessionId ?? null,
    ctx.agentScopeId ?? 'main',
  );
};
