/**
 * Compaction progress event — typed, agent-scoped.
 *
 * Replaces the fake synthetic `'compaction'` tool-call channel (review #37):
 * structured progress state was JSON-stringified into synthetic tool args
 * and the renderer re-parsed it by literal `toolName === 'compaction'` match.
 * This typed event carries the same lifecycle without any string parsing or
 * tool-name interception, and is keyed by agent scope so both main and
 * subagent compactions share one render path.
 */
import type { CompactionMode } from './message';
import type { AgentScopeId } from './agent-scope';

/**
 * Lifecycle phases for one compaction. The widget renders a running indicator
 * while `preparing`/`compacting`, and a terminal `complete`/`failed` state.
 */
export const CompactionProgressPhase = {
  PREPARING: 'preparing',
  COMPACTING: 'compacting',
  COMPLETE: 'complete',
  FAILED: 'failed',
} as const;

export type CompactionProgressPhase =
  (typeof CompactionProgressPhase)[keyof typeof CompactionProgressPhase];

/**
 * A single compaction progress event. Emitted live through the sequenced
 * turn-event broadcast (main scope) or the subagent live-projection delta
 * stream (subagent scope). On snapshot replay, the widget is derived from
 * the persisted `compacted` summary-head marker instead of this event.
 */
export interface CompactionProgressEvent {
  /** Session whose runtime emitted this event. */
  readonly sessionId: string;
  /**
   * Agent scope: `'main'` for the main session, or a subagent id. Null is
   * treated as `'main'` by consumers (see `normalizeAgentScopeId`).
   */
  readonly agentScopeId: AgentScopeId | null;
  /** Monotonic per-turn event sequence (main scope); per-run for subagents. */
  readonly turnId: string;
  readonly sequence: number;
  readonly type: 'compaction_progress';
  readonly phase: CompactionProgressPhase;
  /** Short human-readable detail (e.g. `"Summarizing history"`). */
  readonly detail?: string;
  /** Compaction mode (simple/selective) when known at emit time. */
  readonly mode?: CompactionMode;
  /**
   * Accumulated compactor LLM output tail — summary text (simple) or raw ops
   * JSON (selective). Forwarded as live progress so the widget can show a
   * streaming tail.
   */
  readonly streamText?: string | null;
  /** Calibrated token estimate of `streamText`; null when no calibration exists. */
  readonly estimatedTokens?: number | null;
}
