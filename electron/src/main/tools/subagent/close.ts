/**
 * close_subagents tool — hides terminal subagents from the dynamic system prompt.
 *
 * Params: subagent_ids (string array, non-empty).
 * Returns which subagents were closed, already closed, not terminal, not found,
 * and which referenced a stored agent definition that no longer resolves.
 *
 * Closing never deletes or alters the session record, chain, or UI entry (R2);
 * it only frees prompt space. Only terminal (completed/failed/interrupted)
 * subagents can be closed (R3); running/queued ids are rejected with interrupt
 * guidance, and re-closing is idempotent.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { SubagentManager } from '../../agents/manager';
import { isTerminalSubagentState, SubagentSummaryClosedError } from '../../agents/manager';
import { hydrateSubagentRecords } from './hydrate';
import type { SubagentToolResult } from './delegate';

/**
 * Build the close_subagents tool.
 *
 * @param manager - SubagentManager instance for closing subagents
 */
export function buildCloseTool(
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'close_subagents',
    description:
      'Hide one or more terminal subagents from the dynamic system prompt once their results are incorporated. ' +
      'Closing never deletes the session record, chain, or UI entry — it only frees prompt space. ' +
      'Only terminal (completed/failed/interrupted) subagents can be closed; interrupt running ones first. ' +
      'Returns which subagents were closed.',
    inputSchema: z.object({
      subagent_ids: z
        .array(z.string())
        .min(1)
        .describe('List of subagent IDs to close'),
    }),
    category: 'subagent',
    riskClass: RiskClass.DELEGATION,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<SubagentToolResult> => {
    const { subagent_ids } = input as { subagent_ids: string[] };

    // Validate non-empty (mirrors wait_for_subagent).
    if (!subagent_ids || subagent_ids.length === 0) {
      return genericBuiltInToolOutcome('close_subagents', 'Error: subagent_ids must be a non-empty list of IDs.', 'error');
    }

    // Closing mutates a durable flag, so it needs a session owner both for the
    // ownership boundary and for hydration/persistence. Mirror interrupt's
    // no-session guard.
    if (!ctx?.sessionId) {
      return genericBuiltInToolOutcome('close_subagents', 'No session context available; cannot close subagents without a session id.', 'error');
    }
    const sessionId = ctx.sessionId;

    // Hydrate FIRST so evicted summaries and pre-restart records materialize
    // before the guards run — a flag set on an `_evicted` summary would never
    // persist (checkpoints skip evicted records). Ids whose stored agent
    // definition is gone surface separately as `agent_missing`.
    const { agentMissing } = await hydrateSubagentRecords(manager, sessionId, subagent_ids, ctx);
    const agentMissingSet = new Set(agentMissing);

    const closed: string[] = [];
    const alreadyClosed: string[] = [];
    const notTerminal: string[] = [];
    const notFound: string[] = [];

    // Deduplicate model-supplied ids so each contributes to exactly one result
    // list (a repeat would otherwise close, then report as already_closed).
    for (const sid of new Set(subagent_ids)) {
      // agent_missing ids exist in durable storage but cannot be materialized;
      // report them in their own list rather than as not_found.
      if (agentMissingSet.has(sid)) continue;

      const record = manager.getRecord(sid);
      // A miss OR a record owned by another session reads as not_found — the
      // same ownership boundary as wait/interrupt: a session may only touch its
      // own subagents.
      if (!record || (record.sessionId ?? null) !== sessionId) {
        notFound.push(sid);
      } else if (!isTerminalSubagentState(record.state)) {
        notTerminal.push(sid);
      } else if (record.closed) {
        alreadyClosed.push(sid);
      } else {
        try {
          manager.close(sid);
          closed.push(sid);
        } catch (err) {
          // A record evicted by a concurrent checkpoint since hydration: the
          // flag on a summary would never persist. Report loudly for retry
          // instead of a silent 'closed'.
          if (err instanceof SubagentSummaryClosedError) {
            notFound.push(sid);
            continue;
          }
          throw err;
        }
      }
    }

    // Flush the flag to storage and refresh the UI. Recovery mode also bypasses
    // the stale revision gate for just-hydrated records. Non-fatal (mirrors
    // wait.ts's dynamic-import pattern).
    if (closed.length > 0) {
      try {
        const { recoverSubagentPersistence } = await import('../../agents/wire-subagents');
        recoverSubagentPersistence(sessionId);
      } catch {
        // Non-fatal — UI can still read in-memory state on next refresh
      }
    }

    return genericBuiltInToolOutcome(
      'close_subagents',
      {
        closed,
        already_closed: alreadyClosed,
        not_terminal: notTerminal,
        not_found: notFound,
        agent_missing: agentMissing,
      },
      closed.length > 0 ? 'complete' : 'empty',
    );
  };

  return { definition, handler };
}
