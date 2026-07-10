/**
 * todo_update tool — update an existing task in the shared todo list.
 *
 * Params: id (string, required), title (string, optional), status (string, optional),
 *         subagent_id (string, optional)
 * Validates transitions against VALID_TRANSITIONS (OPEN → IN_PROGRESS → DONE).
 * Triggers notifyTodoChanged() callback.
 *
 * Ported from Python `src/orchid/tools/todo.py` (execute_todo_update).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoStore } from './store';
import type { TodoToolResult, NotifyTodoChanged } from './create';
import { TodoStatus } from '../../../shared/types/todo';

/**
 * Build the todo_update tool.
 *
 * @param store - TodoStore instance for the current session
 * @param notifyChanged - Optional callback to notify UI of changes
 */
export function buildUpdateTool(
  store: TodoStore,
  notifyChanged?: NotifyTodoChanged,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'todo_update',
    description:
      'Update an existing task in the shared todo list.\n\n' +
      'Status transitions:\n' +
      `  OPEN → IN_PROGRESS\n` +
      `  IN_PROGRESS → DONE\n` +
      `  DONE → (terminal, no transitions)`,
    inputSchema: z.object({
      id: z.string().describe('The ID of the task to update.'),
      title: z.string().optional().describe('New title (optional).'),
      status: z
        .string()
        .optional()
        .describe(
          `New status. Must be one of: ${Object.values(TodoStatus).join(', ')}.`,
        ),
      subagent_id: z.string().optional().describe('New subagent ID (optional).'),
    }),
    actionLabel: 'Updating todo...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown, _ctx): Promise<TodoToolResult> => {
    const { id, title, status, subagent_id } = input as {
      id: string;
      title?: string;
      status?: string;
      subagent_id?: string;
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

    const [task, error] = store.update(id, {
      title,
      status: parsedStatus,
      subagent_id,
    });

    if (error) {
      return { display: 'Update failed', content: `Error: ${error}`, isError: true };
    }

    if (notifyChanged) {
      await notifyChanged();
    }

    // Build change summary
    const changes: string[] = [];
    if (title !== undefined) changes.push(`Title: ${task!.title}`);
    if (status !== undefined) changes.push(`Status: ${task!.status}`);
    if (subagent_id !== undefined) changes.push(`Subagent: ${task!.subagent_id}`);

    return {
      display: `Updated task ${task!.id}`,
      content: 'Task updated successfully.\n\n' + changes.join('\n'),
    };
  };

  return { definition, handler };
}
