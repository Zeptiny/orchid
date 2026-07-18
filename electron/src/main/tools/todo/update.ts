/**
 * todo_update tool — update a task owned by the calling agent scope.
 *
 * Cross-scope updates are rejected (Sub1 cannot mutate main/Sub2 todos).
 * Subagents cannot reassign ownership away from themselves.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { TodoToolResult, NotifyTodoChanged, TodoStoreSource } from './create';
import { resolveTodoStore } from './create';
import { TodoStatus, parseTodoStatus } from '../../../shared/types/todo';
import {
  isMainAgentScope,
  normalizeAgentScopeId,
  todoBelongsToScope,
} from '../../../shared/types/agent-scope';

/**
 * Build the todo_update tool.
 *
 * @param store - TodoStore instance, or getter for the active session store
 * @param notifyChanged - Optional callback to notify UI of changes
 */
export function buildUpdateTool(
  store: TodoStoreSource,
  notifyChanged?: NotifyTodoChanged,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'todo_update',
    description:
      'Update an existing task owned by the current agent.\n\n' +
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
      subagent_id: z
        .string()
        .optional()
        .describe(
          'Main agent only: reassign ownership. Subagents cannot change owner.',
        ),
    }),
    actionLabel: 'Updating todo...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { id, title, status, subagent_id } = input as {
      id: string;
      title?: string;
      status?: string;
      subagent_id?: string;
    };

    const scope = normalizeAgentScopeId(ctx.agentScopeId);
    const todoStore = resolveTodoStore(store, ctx);
    const existing = todoStore.get(id);
    if (!existing) {
      return genericBuiltInToolOutcome('todo_update', `Error: No task found with ID '${id}'.`, 'error');
    }
    if (!todoBelongsToScope(existing, scope)) {
      return genericBuiltInToolOutcome('todo_update', `Error: Task '${id}' is not owned by agent scope '${scope}'.`, 'error');
    }

    let parsedStatus: TodoStatus | undefined;
    if (status !== undefined) {
      const parsed = parseTodoStatus(status);
      if (parsed === null) {
        return genericBuiltInToolOutcome('todo_update', `Error: Invalid status '${status}'. Valid statuses: ${Object.values(TodoStatus).join(', ')}`, 'error');
      }
      parsedStatus = parsed;
    }

    // Ownership reassignment: main only; subagents cannot reassign.
    const updates: { title?: string; status?: TodoStatus; subagent_id?: string } = {
      title,
      status: parsedStatus,
    };
    if (isMainAgentScope(scope) && subagent_id !== undefined) {
      updates.subagent_id = subagent_id;
    }

    const [task, error] = todoStore.update(id, updates);

    if (error) {
      return genericBuiltInToolOutcome('todo_update', `Error: ${error}`, 'error');
    }

    if (notifyChanged) {
      await notifyChanged(ctx);
    }

    // Build change summary
    const changes: string[] = [];
    if (title !== undefined) changes.push(`Title: ${task!.title}`);
    if (status !== undefined) changes.push(`Status: ${task!.status}`);
    if (isMainAgentScope(scope) && subagent_id !== undefined) {
      changes.push(`Owner: ${task!.subagent_id || 'main'}`);
    }

    return genericBuiltInToolOutcome('todo_update', 'Task updated successfully.\n\n' + (changes.join('\n') || 'No fields changed.'), 'complete');
  };

  return { definition, handler };
}
