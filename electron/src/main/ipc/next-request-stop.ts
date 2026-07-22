/**
 * Per-session early-stop flag for "next-request" queue messages.
 *
 * When the renderer queues a next-request message mid-stream, it signals
 * `chat:queue-next` so the current chain stops at the next step boundary and
 * the queued message can start a fresh chain. The flag is set by the IPC
 * handler, read by the orchestrator's `stopWhen` predicate, and cleared at
 * turn start so a stale signal never stops the new chain immediately.
 */

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
