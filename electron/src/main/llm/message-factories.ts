/**
 * Shared Message factory helpers for main-process conversation history.
 *
 * Single source of truth for constructing Message objects so chat IPC,
 * subagent manager, and tool-dispatch stay aligned. Canonical status is the
 * terminal authority; `is_error` remains a derived compatibility field.
 */

import type { Message, Usage } from '../../shared/types/message';
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
    is_error: false,
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
    is_error: false,
  };
}

/** Create an ASSISTANT thinking/reasoning message. */
export function makeThinkingMessage(content: string, id: string = newId()): Message {
  return {
    id,
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
    tool_result: null,
    is_error: false,
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
    is_error: false,
  };
}

/**
 * Create a TOOL_RESULT message.
 *
 * Content is the exact finalized agent projection. Canonical status derives
 * the compatibility `is_error` flag; no content inspection is performed.
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
    is_error: toolResult.status === 'error',
  };
}
