/**
 * send_input tool — send stdin input to an interactive background command.
 *
 * Rejected when the command is not interactive, has exited, or a user owns
 * the input (control: USER).
 *
 * Ported from Python `src/orchid/tools/background_io.py`.
 */
import { z } from 'zod';
import { getBackgroundStore } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const sendInputSchema = z.object({
  id: z.number().int().describe('The background command id'),
  text: z.string().describe('Text to write to stdin (include \\n for newline)'),
});

export type SendInputInput = z.infer<typeof sendInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeSendInput(
  id: number,
  text: string,
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

  // Not interactive
  if (!entry.interactive) {
    return {
      display: `Command ${id} is not interactive`,
      content: `Error: Command was not started with interactive=true. Respawn with interactive=true to send input.`,
      isError: true,
    };
  }

  // Already exited
  if (entry.exitCode !== null) {
    return {
      display: `Command ${id} has exited`,
      content: `Error: Command has already exited.`,
      isError: true,
    };
  }

  // User owns input
  if (entry.owner === 'USER') {
    return {
      display: `Command ${id} owned by user`,
      content: `Error: A user currently owns the input for this command (control: USER). Wait for them to release.`,
      isError: true,
    };
  }

  const ok = await store.send(id, text);
  if (!ok) {
    return {
      display: `Failed to send input to command ${id}`,
      content: `Error: Failed to write to stdin (pipe broken or closed).`,
      isError: true,
    };
  }

  // Record user input time
  entry.lastUserInputAt = Date.now();

  const preview = text.length > 60 ? text.substring(0, 59) + '...' : text;

  return {
    display: `Sent input to command ${id}: ${preview}`,
    content: `Input sent to command ${id}`,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sendInputToolDefinition: ToolDefinition = {
  name: 'send_input',
  description:
    'Send input to an interactive background command\'s stdin. Rejected ' +
    'when the command is not interactive or when a user owns the input ' +
    '(control: USER).',
  inputSchema: sendInputSchema,
  actionLabel: 'Sending input...',
  category: 'process',
};

export const sendInputHandler: ToolHandler = async (input: unknown) => {
  const { id, text } = input as SendInputInput;
  return executeSendInput(id, text);
};
