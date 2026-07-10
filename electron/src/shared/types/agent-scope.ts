/**
 * Agent scope identity within a session.
 *
 * Used to isolate todos, background commands, and dynamic prompt content
 * so Sub1 does not see Main/Sub2 state (and vice versa for peer scopes).
 *
 * - Main agent scope id is always `"main"`.
 * - Subagents use their runtime record id (e.g. `subagent-…`).
 * - Todos with empty/null `subagent_id` belong to main.
 */
export const MAIN_AGENT_SCOPE_ID = 'main' as const;

export type AgentScopeId = string;

/** Normalize empty/missing scope to main. */
export function normalizeAgentScopeId(scope?: string | null): AgentScopeId {
  if (scope == null) return MAIN_AGENT_SCOPE_ID;
  const trimmed = scope.trim();
  return trimmed === '' ? MAIN_AGENT_SCOPE_ID : trimmed;
}

export function isMainAgentScope(scope?: string | null): boolean {
  return normalizeAgentScopeId(scope) === MAIN_AGENT_SCOPE_ID;
}

/**
 * Owner of a todo for scope checks.
 * Empty/null `subagent_id` → main.
 */
export function todoOwnerScopeId(subagentId: string | null | undefined): AgentScopeId {
  return normalizeAgentScopeId(subagentId);
}

/** True if the todo is visible/mutable by the given agent scope. */
export function todoBelongsToScope(
  todo: { subagent_id: string | null },
  agentScopeId?: string | null,
): boolean {
  return todoOwnerScopeId(todo.subagent_id) === normalizeAgentScopeId(agentScopeId);
}

/**
 * Filter todos for an agent scope.
 * Main only sees main-owned todos; subagents only see their own.
 */
export function filterTodosForScope<T extends { subagent_id: string | null }>(
  todos: readonly T[],
  agentScopeId?: string | null,
): T[] {
  const scope = normalizeAgentScopeId(agentScopeId);
  return todos.filter((t) => todoBelongsToScope(t, scope));
}
