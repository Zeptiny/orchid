/**
 * todo_create tool — create a new task in the session todo list.
 *
 * Ownership is agent-scoped: empty/null subagent_id = main. Subagents auto-stamp
 * their scope id so peers and main do not share ownership by default.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import type { TodoStore } from './store';
import {
  isMainAgentScope,
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
} from '../../../shared/types/agent-scope';

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

/** Fixed store or lazy resolver (session-scoped active store). */
export type TodoStoreSource = TodoStore | (() => TodoStore);

export function resolveTodoStore(source: TodoStoreSource): TodoStore {
  return typeof source === 'function' ? source() : source;
}

/**
 * Resolve ownership for a new todo under the calling agent scope.
 * - Subagents: always own the todo (caller cannot forge another scope).
 * - Main: may optionally tag a subagent_id (assigns ownership to that subagent).
 */
export function resolveCreateOwner(
  agentScopeId: string | undefined,
  requestedSubagentId?: string,
): string | undefined {
  const scope = normalizeAgentScopeId(agentScopeId);
  if (!isMainAgentScope(scope)) {
    return scope;
  }
  if (requestedSubagentId !== undefined && requestedSubagentId.trim() !== '') {
    return requestedSubagentId.trim();
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
    name: 'todo_create',
    description:
      'Create a new task in the session todo list. Tasks are scoped to the ' +
      'calling agent (main or a specific subagent). Subagents only see and ' +
      'modify their own tasks.',
    inputSchema: z.object({
      title: z.string().describe('Task title.'),
      subagent_id: z
        .string()
        .optional()
        .describe(
          'Main agent only: assign ownership to a subagent id. ' +
            'Ignored when called by a subagent (auto-stamped to caller).',
        ),
    }),
    actionLabel: 'Creating todo...',
    category: 'todo',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<TodoToolResult> => {
    const { title, subagent_id } = input as {
      title: string;
      subagent_id?: string;
    };

    const owner = resolveCreateOwner(ctx.agentScopeId, subagent_id);
    const todo = resolveTodoStore(store).create(title, owner);

    if (notifyChanged) {
      await notifyChanged();
    }

    return {
      display: `Created task: ${todo.title}`,
      content:
        `Task created successfully.\n\n` +
        `ID: ${todo.id}\n` +
        `Title: ${todo.title}\n` +
        `Status: ${todo.status}` +
        (todo.subagent_id ? `\nOwner: ${todo.subagent_id}` : `\nOwner: ${MAIN_AGENT_SCOPE_ID}`),
    };
  };

  return { definition, handler };
}
