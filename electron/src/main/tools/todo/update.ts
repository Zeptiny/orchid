/**
 * todo_update tool — update a task owned by the calling agent scope.
 *
 * Cross-scope updates are rejected (Sub1 cannot mutate main/Sub2 todos).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { TodoToolResult, NotifyTodoChanged, TodoStoreSource } from './create';
import { resolveTodoStore, TODO_BATCH_MAX_SIZE, expandStringifiedBatch } from './create';
import { TodoStatus, type Todo } from '../../../shared/types/todo';
import {
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
      'Status transitions are unrestricted: any status can be set to any status.\n' +
      'Accepts a single id or an array of ids for batch updates. When using ' +
      'arrays, title/status arrays are matched by index to id arrays.',
    inputSchema: z.object({
      id: z.preprocess(
        expandStringifiedBatch,
        z.union([z.string(), z.array(z.string()).min(1).max(TODO_BATCH_MAX_SIZE)]).describe(
          'The ID of the task to update, or an array of IDs for batch update.',
        ),
      ),
      title: z
        .preprocess(
          expandStringifiedBatch,
          z.union([z.string(), z.array(z.string()).max(TODO_BATCH_MAX_SIZE)]).describe(
            'New title (optional). A single value is applied to every id; an array is matched by index.',
          ),
        )
        .optional(),
      status: z
        .preprocess(
          (v) => {
            const expanded = expandStringifiedBatch(v);
            if (Array.isArray(expanded)) {
              return expanded.map((el) => (typeof el === 'string' ? el.toUpperCase() : el));
            }
            return expanded;
          },
          z.union([todoStatusSchema, z.array(todoStatusSchema).max(TODO_BATCH_MAX_SIZE)]).describe(
            `New status. Must be one of: ${Object.values(TodoStatus).join(', ')}. ` +
              'A single value is applied to every id; an array is matched by index.',
          ),
        )
        .optional(),
    }),
    category: 'todo',
    riskClass: RiskClass.MUTATION,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { id, title, status } = input as {
      id: string | string[];
      title?: string | string[];
      status?: TodoStatus | TodoStatus[];
    };

    const scope = normalizeAgentScopeId(ctx.agentScopeId);
    const todoStore = resolveTodoStore(store, ctx);
    const ids = Array.isArray(id) ? id : [id];

    if (Array.isArray(title) && title.length !== ids.length) {
      return genericBuiltInToolOutcome(
        'todo_update',
        `Error: title array length (${title.length}) must match id array length (${ids.length}).`,
        'error',
      );
    }
    if (Array.isArray(status) && status.length !== ids.length) {
      return genericBuiltInToolOutcome(
        'todo_update',
        `Error: status array length (${status.length}) must match id array length (${ids.length}).`,
        'error',
      );
    }
    if (title === undefined && status === undefined) {
      return genericBuiltInToolOutcome(
        'todo_update',
        'Error: Nothing to update — provide title and/or status.',
        'error',
      );
    }

    const titles = title === undefined ? undefined : Array.isArray(title) ? title : ids.map(() => title);
    const statuses = status === undefined ? undefined : Array.isArray(status) ? status : ids.map(() => status);

    const results: { task: Todo | null; error: string | null; changes: { title?: string; status?: string } }[] = [];

    for (let i = 0; i < ids.length; i++) {
      const existing = todoStore.get(ids[i]);
      if (!existing) {
        results.push({ task: null, error: `No task found with ID '${ids[i]}'.`, changes: {} });
        continue;
      }
      if (!todoBelongsToScope(existing, scope)) {
        results.push({ task: null, error: `Task '${ids[i]}' is not owned by agent scope '${scope}'.`, changes: {} });
        continue;
      }

      const updates: { title?: string; status?: TodoStatus } = {};
      if (titles !== undefined && titles[i] !== undefined) {
        updates.title = titles[i];
      }
      if (statuses !== undefined && statuses[i] !== undefined) {
        updates.status = statuses[i];
      }

      const [task, error] = todoStore.update(ids[i], updates);
      if (error || !task) {
        results.push({ task: null, error: error ?? 'Unknown error.', changes: {} });
        continue;
      }
      const changes: { title?: string; status?: string } = {};
      if (updates.title !== undefined) changes.title = task.title;
      if (updates.status !== undefined) changes.status = task.status;
      results.push({ task, error: null, changes });
    }

    if (results.length > 0 && notifyChanged) {
      await notifyChanged(ctx);
    }

    if (ids.length === 1) {
      const r = results[0];
      if (r.error) {
        return genericBuiltInToolOutcome('todo_update', `Error: ${r.error}`, 'error');
      }
      return genericBuiltInToolOutcome('todo_update', {
        taskId: r.task!.id,
        title: r.task!.title,
        changes: r.changes,
      }, 'complete');
    }

    const succeeded = results.filter((r) => r.task !== null).map((r) => ({
      taskId: r.task!.id,
      title: r.task!.title,
      changes: r.changes,
    }));
    const errors = results.filter((r) => r.error !== null).map((r) => r.error!);

    return genericBuiltInToolOutcome('todo_update', {
      updated: succeeded,
      errors,
      count: succeeded.length,
    }, errors.length === ids.length ? 'error' : 'complete');
  };

  return { definition, handler };
}
