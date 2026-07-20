/**
 * XState event type definitions for the agent orchestration hierarchy.
 *
 * Covers all events that flow between session, agent, subagent, and
 * interrupt machines.
 *
 * Ported from Python `src/orchid/agents/manager.py` and `src/orchid/app.py`.
 */

import type { StreamEvent } from '../../llm/orchestrator';
import type { Usage } from '../../../shared/types/message';
import type { ToolExecutionResult } from '../../../shared/types/tool-result';

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

/** LLM stream emits a reasoning/thinking chunk. */
export interface ThinkingChunkEvent {
  type: 'THINKING';
  data: string;
}

/** LLM stream requests a tool call. */
export interface ToolCallEvent {
  type: 'TOOL_CALL';
  toolCallId: string;
  toolName: string;
  args: string;
}

/** LLM stream starts generating a tool call (tool input streaming). */
export interface ToolCallStartEvent {
  type: 'TOOL_CALL_START';
  toolCallId: string;
  toolName: string;
}

/** LLM stream emits a delta for tool call arguments (partial JSON). */
export interface ToolCallDeltaEvent {
  type: 'TOOL_CALL_DELTA';
  toolCallId: string;
  argsDelta: string;
}

/** Tool execution produced a result. */
export interface ToolResultEvent {
  type: 'TOOL_RESULT';
  toolCallId: string;
  execution: ToolExecutionResult;
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

/** LLM stream emitted token usage data. */
export interface UsageEvent {
  type: 'USAGE';
  usage: Usage;
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
  | ThinkingChunkEvent
  | ToolCallEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolResultEvent
  | StreamEndEvent
  | CancelEvent
  | ErrorEvent
  | UsageEvent;

/** All events the interrupt machine can receive. */
export type InterruptMachineEvent =
  | InterruptEvent
  | InterruptTimeoutEvent
  | CancelEvent;

// ── Re-export StreamEvent for convenience ───────────────────────────────────

export type { StreamEvent };
