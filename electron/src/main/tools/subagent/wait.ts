/**
 * wait_for_subagent tool — blocks until specified subagents complete.
 *
 * Params: subagent_ids (string array).
 * Returns results for each subagent (completed, failed, or interrupted).
 *
 * Ported from Python `src/orchid/tools/subagent.py` (wait_for_subagent / execute_wait_for_subagent).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { SubagentManager } from '../../agents/manager';
import type { SubagentToolResult } from './delegate';
import { getSessionManager } from '../../ipc/session';

/**
 * Build the wait_for_subagent tool.
 *
 * @param manager - SubagentManager instance for waiting on subagents
 */
export function buildWaitTool(
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'wait_for_subagent',
    description:
      'Wait for one or more subagents to complete and get their results. ' +
      "Returns the subagent's final output, status, and any errors. " +
      'Use after delegate_to_subagent to collect results.',
    inputSchema: z.object({
      subagent_ids: z
        .array(z.string())
        .describe('List of subagent IDs to wait for'),
    }),
    actionLabel: 'Waiting...',
    category: 'subagent',
  };

  const handler: ToolHandler = async (input: unknown): Promise<SubagentToolResult> => {
    const { subagent_ids } = input as { subagent_ids: string[] };

    // Validate non-empty
    if (!subagent_ids || subagent_ids.length === 0) {
      return {
        display: 'No subagent IDs provided',
        content: 'Error: subagent_ids must be a non-empty list of IDs.',
      isError: true,
      };
    }

    // Wait for all specified subagents to reach terminal state
    const records = await manager.wait(subagent_ids);

    // Persist latest subagent chains (usage + messages) onto the active session
    try {
      getSessionManager().syncSubagentChains(manager.toDomainRecords());
    } catch {
      // Non-fatal — UI can still read in-memory state on next refresh
    }

    // No records found at all
    if (records.size === 0) {
      return {
        display: 'No subagents found',
        content: `No subagents found for IDs: ${subagent_ids.join(', ')}`,
      };
    }

    // Build result parts for each found subagent
    const parts: string[] = [];
    for (const [sid, record] of records) {
      const elapsed = record.endTime
        ? record.endTime - record.startTime
        : record.startTime
          ? Date.now() - record.startTime
          : null;

      const usage = record.usage;
      const usageAttr = usage
        ? ` prompt_tokens="${usage.prompt_tokens}" completion_tokens="${usage.completion_tokens}" cached_tokens="${usage.cached_tokens}"`
        : '';

      const attrs =
        `id="${sid}" name="${record.label}" type="${record.agent.type}" ` +
        `status="${record.state}"` +
        (elapsed !== null ? ` elapsed="${elapsed}"` : '') +
        usageAttr;

      const taskBlock = record.task
        ? `<task>\n${record.task}\n</task>`
        : '';

      if (record.result) {
        parts.push(
          `<subagent ${attrs}>\n${taskBlock}\n<result>\n${record.result}\n</result>\n</subagent>`,
        );
      } else if (record.error) {
        parts.push(
          `<subagent ${attrs}>\n${taskBlock}\n<error>\n${record.error}\n</error>\n</subagent>`,
        );
      } else {
        parts.push(`<subagent ${attrs}>\n${taskBlock}\n</subagent>`);
      }
    }

    // Track missing IDs (not found in manager)
    const foundIds = new Set(records.keys());
    const missing = subagent_ids.filter((id) => !foundIds.has(id));
    const missingBlock = missing.length > 0
      ? `\n<not_found>${missing.join(', ')}</not_found>`
      : '';

    const content = `<subagents>\n${parts.join('\n')}\n</subagents>${missingBlock}`;

    return {
      display: `Waited for ${records.size} subagent(s)`,
      content,
    };
  };

  return { definition, handler };
}
