/**
 * Per-session early-stop flags for "next-request" queue messages and
 * agent-scope-keyed compaction pauses.
 *
 * When the renderer queues a next-request message mid-stream, it signals
 * `chat:queue_next` so the current chain stops at the next step boundary and
 * the queued message can start a fresh chain. The flag is set by the IPC
 * handler, read by the orchestrator's `stopWhen` predicate, and cleared at
 * turn start so a stale signal never stops the new chain immediately.
 *
 * The compaction pause registry is keyed by (sessionId, agentScopeId) so the
 * main session and each subagent run pause independently — one choreography,
 * two hosts (the agent machine's idle intercept for main, the subagent
 * runner's restart loop for subagents).
 */
import {
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
  type AgentScopeId,
} from '../../shared/types/agent-scope';

/** Sessions whose current chain should stop at the next step boundary. */
const nextRequestStops = new Set<string>();

/**
 * Mark a session's current chain for early stop at the next step boundary.
 * Idempotent — repeated signals keep the flag set.
 */
export function requestNextRequestStop(sessionId: string): void {
  nextRequestStops.add(sessionId);
}

/**
 * Whether a session's chain should stop at the next step boundary.
 * Non-destructive — the flag stays set until {@link clearNextRequestStop}.
 */
export function shouldStopNextRequest(sessionId: string): boolean {
  return nextRequestStops.has(sessionId);
}

/** Remove a session's early-stop flag (called at turn start). */
export function clearNextRequestStop(sessionId: string): void {
  nextRequestStops.delete(sessionId);
}

/**
 * Agent scopes whose tool loop should pause for compaction at the next step
 * boundary, grouped per session. Null/empty scope ids normalize to main.
 */
const compactionPauses = new Map<string, Set<AgentScopeId>>();

/**
 * Mark an agent scope's tool loop for a compaction pause at the next step
 * boundary. Idempotent — repeated signals keep the flag set.
 */
export function requestCompactionPause(
  sessionId: string,
  agentScopeId: AgentScopeId | null = MAIN_AGENT_SCOPE_ID,
): void {
  const scope = normalizeAgentScopeId(agentScopeId);
  let scopes = compactionPauses.get(sessionId);
  if (!scopes) {
    scopes = new Set<AgentScopeId>();
    compactionPauses.set(sessionId, scopes);
  }
  scopes.add(scope);
}

/**
 * Whether an agent scope's tool loop should pause for compaction at the next
 * step boundary. Non-destructive — the flag stays set until
 * {@link clearCompactionPause}.
 */
export function shouldPauseForCompaction(
  sessionId: string,
  agentScopeId: AgentScopeId | null = MAIN_AGENT_SCOPE_ID,
): boolean {
  return compactionPauses.get(sessionId)?.has(normalizeAgentScopeId(agentScopeId)) ?? false;
}

/** Remove an agent scope's compaction-pause flag (called when the pause is consumed or the run ends). */
export function clearCompactionPause(
  sessionId: string,
  agentScopeId: AgentScopeId | null = MAIN_AGENT_SCOPE_ID,
): void {
  const scopes = compactionPauses.get(sessionId);
  if (!scopes) return;
  scopes.delete(normalizeAgentScopeId(agentScopeId));
  if (scopes.size === 0) compactionPauses.delete(sessionId);
}

/** Remove every compaction-pause flag for a session (session deleted). */
export function clearCompactionPausesForSession(sessionId: string): void {
  compactionPauses.delete(sessionId);
}

/**
 * Whether the MAIN scope's chain should stop early at the next step boundary
 * (a queued next-request message or a main-scope compaction pause). This is
 * the predicate the main turn's orchestrator binds into `stopWhen`.
 */
export function shouldStopEarlyForSession(sessionId: string): boolean {
  return (
    shouldStopNextRequest(sessionId) ||
    shouldPauseForCompaction(sessionId, MAIN_AGENT_SCOPE_ID)
  );
}
