/**
 * terminate_command tool — terminate a running background command.
 *
 * Sends SIGTERM followed by SIGKILL to the process group.
 * Use when a background command is no longer needed or is stuck.
 *
 * Ported from Python `src/orchid/tools/background_io.py`.
 */
import { z } from 'zod';
import { getBackgroundStore } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';

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
): Promise<{ display: string; content: string; isError?: boolean }> {
  const store = getBackgroundStore();
  const entry = store.getVisible(id);
  if (!entry) {
    return {
      display: `Background command ${id} not found`,
      content: `Error: No background command with id ${id}.`,
      isError: true,
    };
  }

  if (entry.exitCode !== null) {
    return {
      display: `Command ${id} already exited (code ${entry.exitCode})`,
      content: `Command ${id} already exited with code ${entry.exitCode}.`,
    };
  }

  store.terminate(id);

  const preview = entry.command.length > 60
    ? entry.command.substring(0, 59) + '...'
    : entry.command;

  return {
    display: `Terminated command ${id}: $ ${preview}`,
    content: `Terminated command ${id}: ${entry.command}`,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const terminateCommandToolDefinition: ToolDefinition = {
  name: 'terminate_command',
  description:
    'Terminate a running background command. Sends SIGTERM followed by ' +
    'SIGKILL to the process group. Use when a background command is no ' +
    'longer needed or is stuck.',
  inputSchema: terminateCommandInputSchema,
  actionLabel: 'Terminating...',
  category: 'process',
};

export const terminateCommandHandler: ToolHandler = async (input: unknown) => {
  const { id } = input as TerminateCommandInput;
  return executeTerminateCommand(id);
};
