/** Bounded evaluator history of recent tool calls, keyed by session and agent scope. */

const TOOL_CALL_HISTORY_SIZE = 50;

/** One recorded tool call kept for the evaluator's recent-context window. */
export type ToolCallHistoryEntry = { name: string; argsSummary: string };

const toolCallHistory = new Map<string, Map<string, ToolCallHistoryEntry[]>>();

function historyScope(agentScopeId: string | undefined): string {
  return agentScopeId ?? 'main';
}

function summarizeArgValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 80 ? `<${value.length} chars>` : value;
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    return '<unserializable>';
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** Render a bounded, human-readable `key=value` summary of a tool call's args. */
export function summarizeArgs(args: unknown, budget = 200): string {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args).slice(0, budget);
  const parts: string[] = [];
  let used = 0;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const part = `${key}=${summarizeArgValue(value)}`;
    if (used + part.length > budget) {
      parts.push('…');
      break;
    }
    parts.push(part);
    used += part.length + 1;
  }
  return parts.join(' ');
}

/** Record one tool call into the bounded per-session/per-scope evaluator history. */
export function recordToolCall(
  sessionId: string | undefined,
  agentScopeId: string | undefined,
  name: string,
  args: unknown,
): void {
  if (!sessionId) return;
  const summary = summarizeArgs(args);
  let sessionHistory = toolCallHistory.get(sessionId);
  if (!sessionHistory) {
    sessionHistory = new Map();
    toolCallHistory.set(sessionId, sessionHistory);
  }
  const scope = historyScope(agentScopeId);
  const entries = sessionHistory.get(scope) ?? [];
  entries.push({ name, argsSummary: summary });
  if (entries.length > TOOL_CALL_HISTORY_SIZE) {
    entries.splice(0, entries.length - TOOL_CALL_HISTORY_SIZE);
  }
  sessionHistory.set(scope, entries);
}

/** Return newest bounded evaluator history for one session and agent scope. */
export function getRecentToolCallHistory(
  sessionId: string,
  agentScopeId: string | undefined,
  limit: number,
): ToolCallHistoryEntry[] {
  if (limit <= 0) return [];
  const entries = toolCallHistory.get(sessionId)?.get(historyScope(agentScopeId)) ?? [];
  return entries.slice(-Math.min(limit, TOOL_CALL_HISTORY_SIZE));
}

/** Drop evaluator history once a session is permanently deleted. */
export function clearToolCallHistoryForSession(sessionId: string): void {
  toolCallHistory.delete(sessionId);
}

/** Drop evaluator history for one terminal agent without affecting its peers. */
export function clearToolCallHistoryForAgentScope(
  sessionId: string,
  agentScopeId: string,
): void {
  const sessionHistory = toolCallHistory.get(sessionId);
  if (!sessionHistory) return;
  sessionHistory.delete(historyScope(agentScopeId));
  if (sessionHistory.size === 0) toolCallHistory.delete(sessionId);
}
