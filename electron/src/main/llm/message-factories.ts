/**
 * Shared Message factory helpers for main-process conversation history.
 *
 * Single source of truth for constructing Message objects so chat IPC,
 * subagent manager, and tool-dispatch stay aligned. Tool failure is an
 * explicit `is_error` flag — never inferred from content text.
 */

import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';

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
    is_error: false,
  };
}

/** Create an ASSISTANT text message, optionally carrying usage on the final bubble. */
export function makeAssistantMessage(
  content: string,
  usage: Usage | null = null,
): Message {
  return {
    id: newId(),
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
    is_error: false,
  };
}

/** Create an ASSISTANT thinking/reasoning message. */
export function makeThinkingMessage(content: string): Message {
  return {
    id: newId(),
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.THINKING,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: content,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
    is_error: false,
  };
}

/** Create a TOOL_CALL assistant message (one tool call per message for chain pairing). */
export function makeToolCallMessage(
  toolCallId: string,
  toolName: string,
  args: string,
): Message {
  return {
    id: newId(),
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
    is_error: false,
  };
}

/**
 * Create a TOOL_RESULT message.
 *
 * `isError` is stored as `is_error` on the Message and persisted to session
 * JSON. Content is stored as-is (no automatic Error: prefix).
 */
export function makeToolResultMessage(
  toolCallId: string,
  toolName: string | null,
  content: string,
  isError: boolean,
): Message {
  return {
    id: newId(),
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
    is_error: isError,
  };
}
