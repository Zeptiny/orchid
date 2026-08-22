/**
 * Shared Message factory helpers for main-process conversation history.
 *
 * Single source of truth for constructing Message objects so chat IPC,
 * subagent manager, and tool-dispatch stay aligned. Canonical status is the
 * terminal authority.
 */

import type { Message, ThinkingReplayPayload, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import type { CanonicalToolResult } from '../../shared/types/tool-result';

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Create a USER text message. */
export function makeUserMessage(content: string): Message {
  return {
    id: newId(),
    role: MessageRole.USER,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

/** Create an ASSISTANT text message, optionally carrying usage on the final bubble. */
export function makeAssistantMessage(
  content: string,
  usage: Usage | null = null,
  id: string = newId(),
): Message {
  return {
    id,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: nowIso(),
    usage,
    hidden: false,
    tool_result: null,
  };
}

/** Create an ASSISTANT thinking/reasoning message, optionally with a replay artifact. */
export function makeThinkingMessage(
  content: string,
  id: string = newId(),
  payload?: ThinkingReplayPayload,
  durationMs?: number | null,
): Message {
  return {
    id,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.THINKING,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: content,
    ...(payload ? { thinking_payload: payload } : {}),
    ...(durationMs != null && durationMs > 0 ? { thinking_duration_ms: Math.round(durationMs) } : {}),
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

/** Create a TOOL_CALL assistant message (one tool call per message for chain pairing). */
export function makeToolCallMessage(
  toolCallId: string,
  toolName: string,
  args: string,
  id: string = newId(),
): Message {
  return {
    id,
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TOOL_CALL,
    tool_calls: [
      {
        id: toolCallId,
        type: 'function',
        function: { name: toolName, arguments: args || '{}' },
      },
    ],
    tool_call_id: toolCallId,
    name: toolName,
    thinking: null,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

/**
 * Create a TOOL_RESULT message.
 *
 * Content is the exact finalized agent projection.
 */
export function makeToolResultMessage(
  toolCallId: string,
  toolName: string | null,
  content: string,
  toolResult: CanonicalToolResult,
  id: string = newId(),
): Message {
  return {
    id,
    role: MessageRole.TOOL,
    content,
    type: MessageType.TOOL_RESULT,
    tool_calls: null,
    tool_call_id: toolCallId,
    name: toolName,
    thinking: null,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    tool_result: toolResult,
  };
}
