/**
 * list_background_commands tool — agent fleet view.
 *
 * Lists background commands visible to the calling agent scope (session +
 * agentScopeId). Parity with the user `bgcmd:list` IPC surface but scope-gated
 * via BackgroundProcessStore.isVisible so peer subagents cannot see each other.
 *
 * Ported for review finding #11 (20260805-231924-577392d1).
 */
import { z } from 'zod';
import { normalizeAgentScopeId } from '../../../shared/types/agent-scope';
import { getBackgroundStore } from './background-store';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const listBackgroundCommandsInputSchema = z.object({});

export type ListBackgroundCommandsInput = z.infer<typeof listBackgroundCommandsInputSchema>;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeListBackgroundCommands(
  sessionId?: string | null,
  agentScopeId?: string | null,
): Promise<GenericBuiltInToolOutcome> {
  const store = getBackgroundStore();
  const scopeSessionId = sessionId ?? null;
  const scopeAgent = normalizeAgentScopeId(agentScopeId);

  const visible = store
    .list()
    .filter((entry) => store.isVisible(entry, scopeSessionId, scopeAgent))
    .map((entry) => ({
      id: entry.id,
      command: entry.command,
      description: entry.description,
      interactive: entry.interactive,
      owner: entry.owner,
      running: entry.exitCode === null,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
    }));

  // Running first, newest first within each group — matches bgcmd:list ordering.
  visible.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  return genericBuiltInToolOutcome('list_background_commands', { commands: visible }, 'complete');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const listBackgroundCommandsToolDefinition: ToolDefinition = {
  ...genericToolResultMetadata,
  name: 'list_background_commands',
  description:
    'List background commands visible to the current agent. ' +
    'Returns id, command, description, interactive, owner, running, exitCode, and createdAt for each command owned by this agent scope. ' +
    'Peer subagents and the main agent have isolated views.',
  inputSchema: listBackgroundCommandsInputSchema,
  category: 'process',
  riskClass: RiskClass.READ_ONLY,
};

export const listBackgroundCommandsHandler: ToolHandler = async (_input: unknown, ctx) =>
  executeListBackgroundCommands(ctx.sessionId ?? null, ctx.agentScopeId ?? 'main');
