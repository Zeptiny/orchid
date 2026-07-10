/**
 * todo_delete tool — delete a task from the shared todo list.
 *
 * Params: id (string, required)
 * Removes todo. Triggers notifyTodoChanged() callback.
 *
 * Ported from Python `src/orchid/tools/todo.py` (execute_todo_delete).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoStore } from './store';
import type { TodoToolResult, NotifyTodoChanged } from './create';

/**
 * Build the todo_delete tool.
 *
 * @param store - TodoStore instance for the current session
 * @param notifyChanged - Optional callback to notify UI of changes
 */
export function buildDeleteTool(
  store: TodoStore,
  notifyChanged?: NotifyTodoChanged,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'todo_delete',
    description: 'Delete a task from the shared todo list.',
    inputSchema: z.object({
      id: z.string().describe('The ID of the task to delete.'),
    }),
    actionLabel: 'Deleting todo...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown, _ctx): Promise<TodoToolResult> => {
    const { id } = input as { id: string };

    const task = store.delete(id);
    if (!task) {
      return {
        display: 'Task not found',
        content: `Error: No task found with ID '${id}'.`,
      isError: true,
      };
    }

    if (notifyChanged) {
      await notifyChanged();
    }

    return {
      display: `Deleted task: ${task.title}`,
      content: `Task '${task.id}' (${task.title}) deleted successfully.`,
    };
  };

  return { definition, handler };
}
