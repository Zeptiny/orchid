/**
 * interrupt_subagents tool — cancels running subagents.
 *
 * Params: subagent_ids (string array, empty = cancel all running).
 * Returns list of cancelled, already-finished, and not-found subagent IDs.
 *
 * Ported from Python `src/orchid/tools/subagent.py` (interrupt_subagents / execute_interrupt_subagents).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { SubagentManager } from '../../agents/manager';
import { SubagentState } from '../../agents/manager';
import type { SubagentToolResult } from './delegate';

/** Terminal states — subagents in these states cannot be cancelled. */
const TERMINAL_STATES = new Set<SubagentState>([
  SubagentState.COMPLETED,
  SubagentState.FAILED,
  SubagentState.INTERRUPTED,
]);

/**
 * Build the interrupt_subagents tool.
 *
 * @param manager - SubagentManager instance for cancelling subagents
 */
export function buildInterruptTool(
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'interrupt_subagents',
    description:
      'Interrupt one or more running subagents. ' +
      'Use when you need to stop subagents that are no longer needed or are taking too long. ' +
      'Returns which subagents were cancelled.',
    inputSchema: z.object({
      subagent_ids: z
        .array(z.string())
        .describe(
          'List of subagent IDs to interrupt. Pass an empty list to interrupt all running subagents.',
        ),
    }),
    actionLabel: 'Interrupting...',
    category: 'subagent',
  };

  const handler: ToolHandler = async (input: unknown): Promise<SubagentToolResult> => {
    const { subagent_ids } = input as { subagent_ids: string[] };

    // Empty list → cancel all running
    if (!subagent_ids || subagent_ids.length === 0) {
      const cancelled = manager.cancelRunning();
      // Flush any remaining pending state callbacks for clean state transitions
      manager.flushStateCallbacks();

      if (cancelled.length === 0) {
        return {
          display: 'No running subagents to interrupt',
          content: 'No running subagents found to interrupt.',
        };
      }

      return {
        display: `Interrupted ${cancelled.length} subagent(s)`,
        content: `Interrupted subagents: ${cancelled.join(', ')}`,
      };
    }

    // Cancel specific subagents by ID
    const cancelled: string[] = [];
    const notFound: string[] = [];
    const alreadyDone: string[] = [];

    for (const sid of subagent_ids) {
      const record = manager.getRecord(sid);
      if (!record) {
        notFound.push(sid);
      } else if (TERMINAL_STATES.has(record.state)) {
        alreadyDone.push(sid);
      } else {
        manager.cancelOne(sid);
        cancelled.push(sid);
      }
    }

    // Flush any remaining pending state callbacks for clean state transitions
    manager.flushStateCallbacks();

    // Build status message
    const parts: string[] = [];
    if (cancelled.length > 0) {
      parts.push(`Interrupted: ${cancelled.join(', ')}`);
    }
    if (alreadyDone.length > 0) {
      parts.push(`Already finished: ${alreadyDone.join(', ')}`);
    }
    if (notFound.length > 0) {
      parts.push(`Not found: ${notFound.join(', ')}`);
    }

    const content = parts.length > 0
      ? parts.join('. ') + '.'
      : 'No subagents matched.';

    return {
      display: cancelled.length > 0
        ? `Interrupted ${cancelled.length} subagent(s)`
        : 'No subagents interrupted',
      content,
    };
  };

  return { definition, handler };
}
