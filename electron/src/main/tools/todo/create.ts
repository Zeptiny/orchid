/**
 * todo_create tool — create a new task in the session todo list.
 *
 * Ownership is agent-scoped: main creates main-owned tasks (null owner);
 * subagents auto-stamp their own scope id.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import type { TodoStore } from './store';
import {
  isMainAgentScope,
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
} from '../../../shared/types/agent-scope';

/**
 * Result returned by all todo tool handlers.
 */
export type TodoToolResult = GenericBuiltInToolOutcome;

/** Callback type for notifying the UI of todo changes. */
export type NotifyTodoChanged = (ctx: ToolExecutionContext) => void | Promise<void>;

/** Maximum number of items accepted in a single batch todo create/update call. */
export const TODO_BATCH_MAX_SIZE = 50;

/** Fixed store or a resolver scoped to the explicit tool execution context. */
export type TodoStoreSource = TodoStore | ((ctx: ToolExecutionContext) => TodoStore);

export function resolveTodoStore(
  source: TodoStoreSource,
  ctx: ToolExecutionContext,
): TodoStore {
  return typeof source === 'function' ? source(ctx) : source;
}

/**
 * Expand a JSON-encoded batch string into its array form.
 *
 * Some model/provider paths transport array arguments as JSON-encoded strings,
 * so a batch like '["a","b"]' arrives as a single title string. The schema
 * union's string branch accepts it and the store would create one task titled
 * with the raw array text (#171). Only strings that parse to an array whose
 * elements are all strings are expanded; everything else passes through
 * unchanged so literal bracketed titles survive.
 */
export function expandStringifiedBatch(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((el) => typeof el === 'string')) {
      return parsed;
    }
  } catch {
    // Not JSON — treat as a literal string value.
  }
  return value;
}

/**
 * Resolve ownership for a new todo under the calling agent scope.
 * - Subagents: always own the todo (caller cannot forge another scope).
 * - Main: store null (empty owner).
 */
export function resolveCreateOwner(agentScopeId: string | undefined): string | undefined {
  const scope = normalizeAgentScopeId(agentScopeId);
  if (!isMainAgentScope(scope)) {
    return scope;
  }
  // Main-owned: store null (empty owner)
  return undefined;
}

/**
 * Build the todo_create tool.
 *
 * @param store - TodoStore instance, or getter for the active session store
 * @param notifyChanged - Optional callback to notify UI of changes
 */
export function buildCreateTool(
  store: TodoStoreSource,
  notifyChanged?: NotifyTodoChanged,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'todo_create',
    description:
      'Create a new task in the session todo list. Tasks are scoped to the ' +
      'calling agent (main or a subagent). Subagents only see and modify ' +
      'their own tasks. Accepts a single title or an array of titles for ' +
      'batch creation.',
    inputSchema: z.object({
      title: z.preprocess(
        expandStringifiedBatch,
        z.union([z.string(), z.array(z.string()).min(1).max(TODO_BATCH_MAX_SIZE)]).describe(
          'Task title or array of task titles for batch creation.',
        ),
      ),
    }),
    category: 'todo',
    riskClass: RiskClass.MUTATION,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { title } = input as {
      title: string | string[];
    };

    const owner = resolveCreateOwner(ctx.agentScopeId);
    const titles = Array.isArray(title) ? title : [title];
    const todoStore = resolveTodoStore(store, ctx);
    const created = titles.map((t) => todoStore.create(t, owner));

    if (created.length > 0 && notifyChanged) {
      await notifyChanged(ctx);
    }

    if (created.length === 1) {
      const todo = created[0];
      return genericBuiltInToolOutcome('todo_create', {
        id: todo.id,
        title: todo.title,
        status: todo.status,
        owner: todo.subagent_id ?? MAIN_AGENT_SCOPE_ID,
      }, 'complete');
    }

    return genericBuiltInToolOutcome('todo_create', {
      created: created.map((todo) => ({
        id: todo.id,
        title: todo.title,
        status: todo.status,
        owner: todo.subagent_id ?? MAIN_AGENT_SCOPE_ID,
      })),
      count: created.length,
    }, 'complete');
  };

  return { definition, handler };
}
