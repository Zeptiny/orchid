/**
 * send_input tool — send stdin input to an interactive background command.
 *
 * Rejected when the command is not interactive, has exited, or a user owns
 * the input (control: USER).
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
  sessionId?: string | null,
  agentScopeId?: string | null,
): Promise<GenericBuiltInToolOutcome> {
  const store = getBackgroundStore();
  const entry = store.getVisible(id, sessionId ?? null, normalizeAgentScopeId(agentScopeId));
  if (!entry) {
    return backgroundCommandNotFound('send_input', id);
  }

  // Not interactive
  if (!entry.interactive) {
    return genericBuiltInToolOutcome('send_input', `Error: Command was not started with interactive=true. Respawn with interactive=true to send input.`, 'error');
  }

  // Already exited
  if (entry.exitCode !== null) {
    return genericBuiltInToolOutcome('send_input', `Error: Command has already exited.`, 'error');
  }

  // User owns input
  if (entry.owner === 'USER') {
    return genericBuiltInToolOutcome('send_input', `Error: A user currently owns the input for this command (control: USER). Wait for them to release.`, 'error');
  }

  const ok = await store.send(id, text);
  if (!ok) {
    return genericBuiltInToolOutcome('send_input', `Error: Failed to write to stdin (pipe broken or closed).`, 'error');
  }

  // Record user input time
  entry.lastUserInputAt = Date.now();

  return genericBuiltInToolOutcome('send_input', {
    commandId: id,
    input: text,
  }, 'complete');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sendInputToolDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'send_input',
  description:
    'Send input to an interactive background command\'s stdin. Rejected ' +
    'when the command is not interactive or when a user owns the input ' +
    '(control: USER).',
  inputSchema: sendInputSchema,
  category: 'process',
};

export const sendInputHandler: ToolHandler = async (input: unknown, ctx) => {
  const { id, text } = input as SendInputInput;
  return executeSendInput(
    id,
    text,
    ctx.sessionId ?? null,
    ctx.agentScopeId ?? 'main',
  );
};
