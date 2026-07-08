/**
 * History conversion — persisted messages to API messages.
 *
 * Replicates Python `_history_to_api_messages` (client.py:310-399).
 *
 * Enforces the OpenAI-shaped invariant both ways:
 * - Every `tool` message is preceded by an assistant message whose
 *   `tool_calls` contains the same `tool_call_id` (orphaned tool results
 *   are dropped).
 * - Every assistant `tool_calls` block has at least one following matching
 *   `tool` message (assistant tool_calls that never received a result are
 *   filtered so we don't send dangling tool_calls, which would 400 on
 *   strict providers).
 *
 * THINKING messages are replayed as assistant content with reasoning parts
 * so reasoning-capable models (GLM, DeepSeek, Qwen) retain prior deliberation.
 */
import type { Message, ApiMessage } from '../../shared/types/message';
import { MessageType, MessageRole, messageToApiFormat } from '../../shared/types/message';

/**
 * Convert persisted display history to API history.
 *
 * @param messages - Persisted messages from the session
 * @returns API-shaped messages with pairing invariant enforced
 */
export function toApiMessages(messages: Message[]): ApiMessage[] {
  // ── Pre-pass: collect tool_call_ids that have a properly-sequenced
  // matching TOOL_RESULT ──
  //
  // A tool_call_id "survives" only if a TOOL_RESULT with that id appears
  // after its assistant tool_calls block, before any intervening
  // non-thinking/non-tool message resets the sequence. A global "anywhere"
  // presence check is too broad: it would mark an id as surviving based on
  // an orphan result that appears in a later turn after the sequence was
  // already broken, emitting a dangling tool_calls block with no paired
  // result in message order.
  const survivingToolCallIds = new Set<string>();
  const pendingToolCallIds = new Set<string>();

  for (const msg of messages) {
    // Skip error messages
    if (msg.type === MessageType.ERROR) {
      continue;
    }

    // Skip tool_call messages with no tool_calls
    if (msg.type === MessageType.TOOL_CALL && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      continue;
    }

    // THINKING never breaks the tool_call/tool_result pairing (mirrors
    // the main loop's non-reset-on-thinking guarantee below).
    if (msg.type === MessageType.THINKING) {
      continue;
    }

    // TOOL_RESULT: check if it matches a pending tool_call_id
    if (msg.role === MessageRole.TOOL) {
      if (msg.tool_call_id && pendingToolCallIds.has(msg.tool_call_id)) {
        survivingToolCallIds.add(msg.tool_call_id);
      }
      continue;
    }

    // Skip empty messages
    if (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      continue;
    }

    // An emitted non-tool message breaks the sequence: results from a
    // later turn can no longer legitimately pair with earlier tool_calls.
    // A new assistant tool_calls block resets pending to its own ids.
    pendingToolCallIds.clear();
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          pendingToolCallIds.add(tc.id);
        }
      }
    }
  }

  // ── Main pass: emit API messages ──
  const apiMessages: ApiMessage[] = [];
  let lastAssistantToolCallIds = new Set<string>();

  for (const msg of messages) {
    // Skip error messages
    if (msg.type === MessageType.ERROR) {
      continue;
    }

    // Skip tool_call messages with no tool_calls
    if (msg.type === MessageType.TOOL_CALL && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      continue;
    }

    // THINKING: replay with reasoning content parts so reasoning-capable
    // models (GLM, DeepSeek, Qwen) retain prior deliberation.
    // The match-set is NOT reset on THINKING: an intervening THINKING between
    // assistant(tool_calls=[A]) and tool(A) must not cause A to be
    // dropped as orphaned.
    if (msg.type === MessageType.THINKING) {
      if (!msg.content) {
        continue;
      }
      apiMessages.push({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: msg.content },
        ],
      });
      continue;
    }

    // TOOL_RESULT: only emit if it has a matching assistant tool_calls
    if (msg.role === MessageRole.TOOL) {
      if (!msg.tool_call_id) {
        continue;
      }
      if (!lastAssistantToolCallIds.has(msg.tool_call_id)) {
        // Orphaned tool result — no preceding assistant tool_calls message
        // in history. Drop it.
        continue;
      }
      apiMessages.push(messageToApiFormat(msg));
      continue;
    }

    // Skip empty messages
    if (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      continue;
    }

    // Assistant message: filter tool_calls to only those that received a
    // tool result, and drop the field entirely if none survived. Avoids
    // sending dangling assistant tool_calls (e.g. after a cancelled turn)
    // that strict providers reject with 400.
    const d = messageToApiFormat(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const surviving = msg.tool_calls.filter(
        (tc) => survivingToolCallIds.has(tc.id),
      );
      if (surviving.length > 0) {
        d.tool_calls = surviving.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      } else {
        // All tool_calls were unserviced — drop the field.
        delete d.tool_calls;
        // If the assistant message has no content AND its tool_calls were
        // all unserviced, skip it entirely (empty assistant turn).
        if (!msg.content) {
          lastAssistantToolCallIds = new Set();
          continue;
        }
      }
    }

    apiMessages.push(d);

    // Update lastAssistantToolCallIds for the next iteration
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      lastAssistantToolCallIds = new Set(
        msg.tool_calls.map((tc) => tc.id).filter((id): id is string => id != null),
      );
    } else {
      lastAssistantToolCallIds = new Set();
    }
  }

  return apiMessages;
}
