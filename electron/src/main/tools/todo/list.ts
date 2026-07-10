/**
 * todo_list tool — list tasks in the shared todo list.
 *
 * Params: status (string, optional), subagent_id (string, optional)
 * Filters by status and/or subagent_id. Returns list of todos.
 *
 * Ported from Python `src/orchid/tools/todo.py` (execute_todo_list).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoStore } from './store';
import type { TodoToolResult } from './create';
import { TodoStatus } from '../../../shared/types/todo';

/**
 * Build the todo_list tool.
 *
 * @param store - TodoStore instance for the current session
 */
export function buildListTool(
  store: TodoStore,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'todo_list',
    description:
      'List tasks in the shared todo list, optionally filtered by status or subagent.',
    inputSchema: z.object({
      status: z
        .string()
        .optional()
        .describe(
          `Filter by status. Must be one of: ${Object.values(TodoStatus).join(', ')}.`,
        ),
      subagent_id: z.string().optional().describe('Filter by subagent ID.'),
    }),
    actionLabel: 'Listing todos...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown): Promise<TodoToolResult> => {
    const { status, subagent_id } = input as {
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

    const tasks = store.list(parsedStatus, subagent_id);

    if (tasks.length === 0) {
      return {
        display: 'No tasks found',
        content: 'No tasks match the given filters.',
      };
    }

    const lines = [`Found ${tasks.length} task(s):\n`];
    for (const t of tasks) {
      const parts = [`[${t.id}] ${t.title}`];
      parts.push(`  Status: ${t.status}`);
      if (t.subagent_id) {
        parts.push(`  Subagent: ${t.subagent_id}`);
      }
      lines.push(parts.join('\n') + '\n');
    }

    return {
      display: `Found ${tasks.length} task(s)`,
      content: lines.join('\n'),
    };
  };

  return { definition, handler };
}
