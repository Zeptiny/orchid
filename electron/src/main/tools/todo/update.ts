/**
 * todo_update tool — update a task owned by the calling agent scope.
 *
 * Cross-scope updates are rejected (Sub1 cannot mutate main/Sub2 todos).
 * Subagents cannot reassign ownership away from themselves.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { TodoToolResult, NotifyTodoChanged, TodoStoreSource } from './create';
import { resolveTodoStore } from './create';
import { TodoStatus } from '../../../shared/types/todo';
import {
  isMainAgentScope,
  normalizeAgentScopeId,
  todoBelongsToScope,
} from '../../../shared/types/agent-scope';

/** Accept exact enum values or common lowercase LLM forms (open → OPEN). */
const todoStatusSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  z.nativeEnum(TodoStatus),
);

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
      'Status transitions are unrestricted: any status can be set to any status.',
    inputSchema: z.object({
      id: z.string().describe('The ID of the task to update.'),
      title: z.string().optional().describe('New title (optional).'),
      status: todoStatusSchema
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
    category: 'todo',
    riskClass: RiskClass.MUTATION,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { id, title, status, subagent_id } = input as {
      id: string;
      title?: string;
      status?: TodoStatus;
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

    // Ownership reassignment: main only; subagents cannot reassign.
    const updates: { title?: string; status?: TodoStatus; subagent_id?: string } = {
      title,
      status,
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

    const changes: { title?: string; status?: string; owner?: string } = {};
    if (title !== undefined) changes.title = task!.title;
    if (status !== undefined) changes.status = task!.status;
    if (isMainAgentScope(scope) && subagent_id !== undefined) {
      changes.owner = task!.subagent_id || 'main';
    }

    return genericBuiltInToolOutcome('todo_update', {
      taskId: task!.id,
      title: task!.title,
      changes,
    }, 'complete');
  };

  return { definition, handler };
}
