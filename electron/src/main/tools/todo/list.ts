/**
 * todo_list tool — list tasks owned by the calling agent scope.
 *
 * Agent isolation: main only lists main-owned tasks; subagents only list
 * their own. Optional status filter still applies within the scope.
 * The subagent_id param is ignored for isolation (scope is always the caller).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoToolResult, TodoStoreSource } from './create';
import { resolveTodoStore } from './create';
import { TodoStatus } from '../../../shared/types/todo';
import {
  filterTodosForScope,
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
} from '../../../shared/types/agent-scope';

/**
 * Build the todo_list tool.
 *
 * @param store - TodoStore instance, or getter for the active session store
 */
export function buildListTool(
  store: TodoStoreSource,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'todo_list',
    description:
      'List tasks owned by the current agent (main or this subagent). ' +
      'Optionally filter by status. Peer agents\' tasks are never returned.',
    inputSchema: z.object({
      status: z
        .string()
        .optional()
        .describe(
          `Filter by status. Must be one of: ${Object.values(TodoStatus).join(', ')}.`,
        ),
      // Kept for schema stability; enforced scope always overrides.
      subagent_id: z
        .string()
        .optional()
        .describe('Deprecated: scope is always the calling agent. Ignored.'),
    }),
    actionLabel: 'Listing todos...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { status } = input as {
      status?: string;
    };

    // Parse and validate status
    let parsedStatus: TodoStatus | undefined;
    if (status !== undefined) {
      const upper = status.toUpperCase();
      if (!Object.values(TodoStatus).includes(upper as TodoStatus)) {
        return {
          display: 'Invalid status',
          content: `Error: Invalid status '${status}'. Valid statuses: ${Object.values(TodoStatus).join(', ')}`,
          isError: true,
        };
      }
      parsedStatus = upper as TodoStatus;
    }

    const scope = normalizeAgentScopeId(ctx.agentScopeId);
    const all = resolveTodoStore(store, ctx).list(parsedStatus);
    const tasks = filterTodosForScope(all, scope);

    if (tasks.length === 0) {
      return {
        display: 'No tasks found',
        content: `No tasks for agent scope '${scope}'.`,
      };
    }

    const lines = [`Found ${tasks.length} task(s) for scope '${scope}':\n`];
    for (const t of tasks) {
      const parts = [`[${t.id}] ${t.title}`];
      parts.push(`  Status: ${t.status}`);
      parts.push(`  Owner: ${t.subagent_id ?? MAIN_AGENT_SCOPE_ID}`);
      lines.push(parts.join('\n') + '\n');
    }

    return {
      display: `Found ${tasks.length} task(s)`,
      content: lines.join('\n'),
    };
  };

  return { definition, handler };
}
