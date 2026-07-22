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
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
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
    ...genericToolResultMetadata,
    name: 'interrupt_subagents',
    description:
      'Interrupt one or more running subagents. ' +
      'Use when you need to stop subagents that are no longer needed or are taking too long. ' +
      'Returns which subagents were cancelled.',
    inputSchema: z.object({
      subagent_ids: z
        .array(z.string())
        .describe(
          'List of subagent IDs to interrupt. Pass an empty list to interrupt all running subagents in this session.',
        ),
    }),
    category: 'subagent',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<SubagentToolResult> => {
    const { subagent_ids } = input as { subagent_ids: string[] };

    // Empty list → cancel all running in this session only (never process-wide).
    if (!subagent_ids || subagent_ids.length === 0) {
      if (!ctx.sessionId) {
        return genericBuiltInToolOutcome('interrupt_subagents', 'No session context available; cannot interrupt subagents without a session id.', 'empty');
      }
      // cancelOne (via cancelRunning) already resolves waiters for cancelled
      // records. Do not flush process-wide waiters — that would unblock
      // other sessions' waits (M-P0-013).
      const cancelled = manager.cancelRunning(ctx.sessionId);

      if (cancelled.length === 0) {
        return genericBuiltInToolOutcome('interrupt_subagents', 'No running subagents found to interrupt.', 'empty');
      }

      return genericBuiltInToolOutcome('interrupt_subagents', {
        interrupted: cancelled,
        already_finished: [],
        not_found: [],
      }, 'complete');
    }

    // Cancel specific subagents by ID
    const cancelled: string[] = [];
    const notFound: string[] = [];
    const alreadyDone: string[] = [];

    for (const sid of subagent_ids) {
      const record = manager.getRecord(sid);
      if (!record || (record.sessionId ?? null) !== (ctx?.sessionId ?? null)) {
        notFound.push(sid);
      } else if (TERMINAL_STATES.has(record.state)) {
        alreadyDone.push(sid);
      } else {
        // cancelOne resolves waiters for this record only.
        manager.cancelOne(sid);
        cancelled.push(sid);
      }
    }

    return genericBuiltInToolOutcome(
      'interrupt_subagents',
      {
        interrupted: cancelled,
        already_finished: alreadyDone,
        not_found: notFound,
      },
      cancelled.length > 0 ? 'complete' : 'empty',
    );
  };

  return { definition, handler };
}
