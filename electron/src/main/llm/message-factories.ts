/**
 * Shared Message factory helpers for main-process conversation history.
 *
 * Single source of truth for constructing Message objects so chat IPC,
 * subagent manager, and tool-dispatch stay aligned on shape and Error: prefixing.
 *
 * UI and orchestrator classify soft tool failures via the `Error:` content
 * prefix (ChatStream, MessageWidget, orchestrator soft-error detection).
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
  };
}

/**
 * Create a TOOL_RESULT message.
 *
 * When `isError` is true, content is prefixed with `Error:` unless it already
 * starts with that prefix (avoids double-prefix when callers pass pre-formatted
 * error strings). Empty error content becomes `"Error: "` so UI classifiers still
 * mark the tool as failed.
 *
 * Keep TOOL_RESULT type for chain reconciliation pairing.
 */
export function makeToolResultMessage(
  toolCallId: string,
  toolName: string | null,
  content: string,
  isError: boolean,
): Message {
  const finalContent =
    isError && !content.startsWith('Error:')
      ? `Error: ${content}`
      : content;

  return {
    id: newId(),
    role: MessageRole.TOOL,
    content: finalContent,
    type: MessageType.TOOL_RESULT,
    tool_calls: null,
    tool_call_id: toolCallId,
    name: toolName,
    thinking: null,
    timestamp: nowIso(),
    usage: null,
    hidden: false,
  };
}
