/**
 * todo_delete tool — delete a task owned by the calling agent scope.
 *
 * Cross-scope deletes are rejected.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoToolResult, NotifyTodoChanged, TodoStoreSource } from './create';
import { resolveTodoStore } from './create';
import {
  normalizeAgentScopeId,
  todoBelongsToScope,
} from '../../../shared/types/agent-scope';

/**
 * Build the todo_delete tool.
 *
 * @param store - TodoStore instance, or getter for the active session store
 * @param notifyChanged - Optional callback to notify UI of changes
 */
export function buildDeleteTool(
  store: TodoStoreSource,
  notifyChanged?: NotifyTodoChanged,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'todo_delete',
    description:
      'Delete a task owned by the current agent. Cannot delete peer agents\' tasks.',
    inputSchema: z.object({
      id: z.string().describe('The ID of the task to delete.'),
    }),
    actionLabel: 'Deleting todo...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { id } = input as { id: string };
    const scope = normalizeAgentScopeId(ctx.agentScopeId);
    const todoStore = resolveTodoStore(store, ctx);
    const existing = todoStore.get(id);
    if (!existing) {
      return {
        display: 'Task not found',
        content: `Error: No task found with ID '${id}'.`,
        isError: true,
      };
    }
    if (!todoBelongsToScope(existing, scope)) {
      return {
        display: 'Delete failed',
        content: `Error: Task '${id}' is not owned by agent scope '${scope}'.`,
        isError: true,
      };
    }

    const task = todoStore.delete(id);
    if (!task) {
      return {
        display: 'Task not found',
        content: `Error: No task found with ID '${id}'.`,
        isError: true,
      };
    }

    if (notifyChanged) {
      await notifyChanged(ctx);
    }

    return {
      display: `Deleted task: ${task.title}`,
      content: `Task '${task.id}' (${task.title}) deleted successfully.`,
    };
  };

  return { definition, handler };
}
