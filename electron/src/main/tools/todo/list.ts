/**
 * todo_list tool — list tasks owned by the calling agent scope.
 *
 * Agent isolation: main only lists main-owned tasks; subagents only list
 * their own. Optional status filter still applies within the scope.
 * The subagent_id param is ignored for isolation (scope is always the caller).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { TodoToolResult, TodoStoreSource } from './create';
import { resolveTodoStore } from './create';
import { TodoStatus } from '../../../shared/types/todo';
import {
  filterTodosForScope,
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
} from '../../../shared/types/agent-scope';

/** Accept exact enum values or common lowercase LLM forms (open → OPEN). */
const todoStatusSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  z.nativeEnum(TodoStatus),
);

/**
 * Build the todo_list tool.
 *
 * @param store - TodoStore instance, or getter for the active session store
 */
export function buildListTool(
  store: TodoStoreSource,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'todo_list',
    description:
      'List tasks owned by the current agent (main or this subagent). ' +
      'Optionally filter by status. Peer agents\' tasks are never returned.',
    inputSchema: z.object({
      status: todoStatusSchema
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
      status?: TodoStatus;
    };

    const scope = normalizeAgentScopeId(ctx.agentScopeId);
    const all = resolveTodoStore(store, ctx).list(status);
    const tasks = filterTodosForScope(all, scope);

    if (tasks.length === 0) {
      return genericBuiltInToolOutcome('todo_list', { scope, tasks: [] }, 'empty');
    }

    return genericBuiltInToolOutcome('todo_list', {
      scope,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.subagent_id ?? MAIN_AGENT_SCOPE_ID,
      })),
    }, 'complete');
  };

  return { definition, handler };
}
