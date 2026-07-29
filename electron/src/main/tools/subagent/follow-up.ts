/**
 * follow_up_subagent tool — resumes a terminal subagent with new input (U6).
 *
 * Params: subagent_id, input.
 * Hydrates evicted and persisted-only records first (R9) so follow-ups work
 * across app restarts and the retention-eviction boundary, then resumes the
 * record via `SubagentManager.followUp` — the full prior chain is replayed
 * with the new user message appended (R5). Admission limits and the FIFO
 * queue are shared with spawn (R7). The result envelope mirrors
 * delegate_to_subagent; the ownership boundary mirrors interrupt_subagents.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { SubagentManager, SubagentRecord } from '../../agents/manager';
import {
  SubagentClosedError,
  SubagentEvictedError,
  SubagentNotTerminalError,
  SubagentQueueFullError,
  SubagentState,
} from '../../agents/manager';
import { hydrateSubagentRecords } from './hydrate';
import type { SubagentToolResult } from './delegate';

/**
 * Build the follow_up_subagent tool.
 *
 * @param manager - SubagentManager instance for resuming subagents
 */
export function buildFollowUpTool(
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'follow_up_subagent',
    description:
      'Send follow-up input to a terminal (completed/failed/interrupted) subagent and rerun it ' +
      'with its full conversation history replayed — the new message is appended to its chain. ' +
      'Use to fix unfinished work or continue after an interruption or app restart; subagent ids ' +
      'are recoverable from conversation history (delegate tool calls). ' +
      'Cannot be used on closed subagents. ' +
      'After following up, use wait_for_subagent to collect the new result.',
    inputSchema: z.object({
      subagent_id: z.string().describe('The subagent ID to resume'),
      input: z
        .string()
        .describe('The follow-up user message appended to the subagent chain'),
    }),
    category: 'subagent',
    riskClass: RiskClass.DELEGATION,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<SubagentToolResult> => {
    const { subagent_id, input: followUpInput } = input as {
      subagent_id: string;
      input: string;
    };

    if (!ctx.sessionId) {
      return genericBuiltInToolOutcome(
        'follow_up_subagent',
        'No session context available; cannot follow up on a subagent without a session id.',
        'empty',
      );
    }

    // Hydrate first: evicted summaries and records persisted before this app
    // launch hold their full chain only in durable storage, and a resume must
    // replay it (R9). Live full records are left untouched.
    const hydrated = await hydrateSubagentRecords(manager, ctx.sessionId, [subagent_id], ctx);
    if (hydrated.agentMissing.includes(subagent_id)) {
      return genericBuiltInToolOutcome(
        'follow_up_subagent',
        `Error: the agent definition for subagent '${subagent_id}' is no longer available; cannot resume.`,
        'error',
      );
    }

    // Ownership boundary mirrors interrupt/wait: ids owned by another session
    // (or unknown entirely) read as not found.
    const existing = manager.getRecord(subagent_id);
    if (!existing || existing.sessionId !== ctx.sessionId) {
      return genericBuiltInToolOutcome(
        'follow_up_subagent',
        `Error: subagent '${subagent_id}' not found.`,
        'error',
      );
    }

    let record: SubagentRecord;
    try {
      record = manager.followUp(subagent_id, followUpInput);
    } catch (err) {
      if (err instanceof SubagentClosedError) {
        return genericBuiltInToolOutcome(
          'follow_up_subagent',
          `Error: cannot follow up on a closed subagent ('${subagent_id}').`,
          'error',
        );
      }
      if (err instanceof SubagentNotTerminalError) {
        // The message already carries wait/interrupt guidance; surface as-is.
        return genericBuiltInToolOutcome('follow_up_subagent', `Error: ${err.message}`, 'error');
      }
      if (err instanceof SubagentEvictedError) {
        return genericBuiltInToolOutcome(
          'follow_up_subagent',
          `Error: subagent history is not available in memory and hydration failed ('${subagent_id}').`,
          'error',
        );
      }
      if (err instanceof SubagentQueueFullError) {
        return genericBuiltInToolOutcome('follow_up_subagent', `Error: ${err.message}`, 'error');
      }
      throw err;
    }

    const queuePosition = record.state === SubagentState.QUEUED
      ? manager.getQueuePosition(record.id)
      : null;

    return genericBuiltInToolOutcome(
      'follow_up_subagent',
      {
        id: record.id,
        name: record.label,
        status: record.state,
        ...(queuePosition !== null ? { queue_position: queuePosition } : {}),
      },
      'complete',
    );
  };

  return { definition, handler };
}
