/**
 * todo_create tool — create a new task in the shared todo list.
 *
 * Params: title (string, required)
 * Generates 8-hex UUID, creates todo with status OPEN.
 * Triggers notifyTodoChanged() callback.
 *
 * Ported from Python `src/orchid/tools/todo.py` (execute_todo_create).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoStore } from './store';

/**
 * Result returned by all todo tool handlers.
 */
export interface TodoToolResult {
  /** Brief summary for UI display */
  display: string;
  /** Full content (may include structured data) */
  content: string;
  /** Explicit failure flag for UI/status (never inferred from content). */
  isError?: boolean;
}

/** Callback type for notifying the UI of todo changes. */
export type NotifyTodoChanged = () => void | Promise<void>;

/**
 * Build the todo_create tool.
 *
 * @param store - TodoStore instance for the current session
 * @param notifyChanged - Optional callback to notify UI of changes
 */
export function buildCreateTool(
  store: TodoStore,
  notifyChanged?: NotifyTodoChanged,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    name: 'todo_create',
    description: 'Create a new task in the shared todo list.',
    inputSchema: z.object({
      title: z.string().describe('Task title.'),
      subagent_id: z
        .string()
        .optional()
        .describe('ID of the subagent this task belongs to (optional).'),
    }),
    actionLabel: 'Creating todo...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown): Promise<TodoToolResult> => {
    const { title, subagent_id } = input as {
      title: string;
      subagent_id?: string;
    };

    const todo = store.create(title, subagent_id);

    if (notifyChanged) {
      await notifyChanged();
    }

    return {
      display: `Created task: ${todo.title}`,
      content:
        `Task created successfully.\n\n` +
        `ID: ${todo.id}\n` +
        `Title: ${todo.title}\n` +
        `Status: ${todo.status}`,
    };
  };

  return { definition, handler };
}
