/**
 * XState event type definitions for the agent orchestration hierarchy.
 *
 * Covers all events that flow between session, agent, subagent, and
 * interrupt machines.
 *
 * Ported from Python `src/orchid/agents/manager.py` and `src/orchid/app.py`.
 */

import type { StreamEvent } from '../../llm/orchestrator';

// ── Agent events ────────────────────────────────────────────────────────────

/** User submits a message from the input area. */
export interface UserInputEvent {
  type: 'USER_INPUT';
  message: string;
}

/** LLM stream emits a text chunk. */
export interface ChunkEvent {
  type: 'CHUNK';
  data: string;
}

/** LLM stream requests a tool call. */
export interface ToolCallEvent {
  type: 'TOOL_CALL';
  toolCallId: string;
  toolName: string;
  args: string;
}

/** Tool execution produced a result. */
export interface ToolResultEvent {
  type: 'TOOL_RESULT';
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** Tool execution failed with an error. */
export interface ToolErrorEvent {
  type: 'TOOL_ERROR';
  toolCallId: string;
  error: string;
}

/** LLM stream completed without requesting further tool calls. */
export interface StreamEndEvent {
  type: 'STREAM_END';
  finishReason: string;
}

/** User or system requests cancellation of the current stream. */
export interface CancelEvent {
  type: 'CANCEL';
}

/** An error occurred during streaming or tool execution. */
export interface ErrorEvent {
  type: 'ERROR';
  error: string;
  title?: string;
}

// ── Subagent events ─────────────────────────────────────────────────────────

/** Parent requests spawning a new subagent. */
export interface SpawnSubagentEvent {
  type: 'SPAWN_SUBAGENT';
  name: string;
  task: string;
  agentType: string;
  model?: string;
  parentChainIndex?: number;
}

/** Subagent completed successfully, reported to parent. */
export interface SubagentCompleteEvent {
  type: 'SUBAGENT_COMPLETE';
  subagentId: string;
  result: string;
}

/** Subagent failed, reported to parent. */
export interface SubagentFailedEvent {
  type: 'SUBAGENT_FAILED';
  subagentId: string;
  error: string;
}

// ── Interrupt events ────────────────────────────────────────────────────────

/** User presses Esc — first press transitions to CONFIRM_AGENT. */
export interface InterruptEvent {
  type: 'INTERRUPT';
}

/** Interrupt confirmation timed out — auto-reset to IDLE. */
export interface InterruptTimeoutEvent {
  type: 'INTERRUPT_TIMEOUT';
}

// ── Aggregate union ─────────────────────────────────────────────────────────

/** All events the agent machine can receive. */
export type AgentEvent =
  | UserInputEvent
  | ChunkEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StreamEndEvent
  | CancelEvent
  | ErrorEvent;

/** All events the session machine can receive. */
export type SessionEvent =
  | UserInputEvent
  | SpawnSubagentEvent
  | SubagentCompleteEvent
  | SubagentFailedEvent
  | CancelEvent
  | InterruptEvent
  | InterruptTimeoutEvent;

/** All events the subagent machine can receive. */
export type SubagentEvent =
  | ChunkEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | StreamEndEvent
  | CancelEvent
  | ErrorEvent;

/** All events the interrupt machine can receive. */
export type InterruptMachineEvent =
  | InterruptEvent
  | InterruptTimeoutEvent
  | CancelEvent;

// ── Re-export StreamEvent for convenience ───────────────────────────────────

export type { StreamEvent };
