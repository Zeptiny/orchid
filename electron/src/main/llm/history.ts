/**
 * History conversion — persisted messages to API messages.
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
 * When a thinking replay context is supplied, the current model's thinking
 * policy decides per message: persisted artifacts (Anthropic signatures,
 * redacted blocks, Responses encrypted items) replay unmodified for the
 * producing provider/model, are stripped on a provider/model switch, and are
 * omitted entirely when the policy makes replay impossible (R15, R16).
 */
import type {
  ApiContentPartOptions,
  ApiMessage,
  Message,
  ThinkingReplayPayload,
} from '../../shared/types/message';
import { MessageType, MessageRole, messageToApiFormat } from '../../shared/types/message';
import type { ThinkingPolicy } from '../../shared/types/provider-facets';
import {
  buildThinkingProviderOptions,
  decideThinkingReplay,
  type ThinkingReplayIdentity,
} from '../providers/facets/thinking';

/** Frozen per-turn thinking replay context: the current model's policy. */
export interface ThinkingReplayContext {
  readonly policy: ThinkingPolicy;
  readonly selection: ThinkingReplayIdentity;
}

function thinkingReplayPart(
  msg: Message,
  thinking: ThinkingReplayContext,
): { type: string; text: string; providerOptions?: ApiContentPartOptions } | null {
  const decision = decideThinkingReplay({
    policy: thinking.policy,
    selection: thinking.selection,
    content: msg.content,
    payload: msg.thinking_payload,
  });
  if (decision.emit === 'none') return null;
  if (decision.emit === 'artifact') {
    const payload: ThinkingReplayPayload = decision.payload;
    const providerOptions = buildThinkingProviderOptions(payload);
    return {
      type: 'reasoning',
      text: payload.displayText ?? msg.content,
      ...(providerOptions ? { providerOptions } : {}),
    };
  }
  return { type: 'reasoning', text: decision.text };
}

function isReplayableToolCallMessage(message: Message): boolean {
  return message.role === MessageRole.ASSISTANT &&
    message.type === MessageType.TOOL_CALL &&
    !message.hidden &&
    !message.excludeFromModel &&
    Boolean(message.tool_calls?.length);
}

function isOmittedFromReplay(message: Message): boolean {
  if (message.type === MessageType.ERROR) return true;
  if (message.hidden || message.excludeFromModel) return true;
  if (message.type === MessageType.TOOL_CALL && (!message.tool_calls || message.tool_calls.length === 0)) return true;
  if (message.type === MessageType.THINKING && !message.content) return true;
  if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) return true;
  return false;
}

/**
 * Runtime lifecycle events persist one assistant message per parallel tool
 * call. Providers require those adjacent calls to be replayed as one assistant
 * tool-call group followed by all of the group's results.
 *
 * Records that the later replay filtering omits entirely (ERROR, hidden,
 * excluded, empty) are transparent for adjacency: two replayable tool-call
 * messages separated only by omitted records merge into one group.
 */
function coalesceConsecutiveToolCallMessages(messages: Message[]): Message[] {
  const normalized: Message[] = [];
  let lastReplayableIndex = -1;

  for (const message of messages) {
    if (isReplayableToolCallMessage(message)) {
      if (lastReplayableIndex !== -1) {
        const allSkippable = normalized
          .slice(lastReplayableIndex + 1)
          .every(isOmittedFromReplay);
        if (allSkippable) {
          const previous = normalized[lastReplayableIndex];
          normalized[lastReplayableIndex] = {
            ...previous,
            content: [previous.content, message.content].filter(Boolean).join('\n'),
            tool_calls: [...(previous.tool_calls ?? []), ...(message.tool_calls ?? [])],
            tool_call_id: null,
          };
          continue;
        }
      }
      lastReplayableIndex = normalized.length;
      normalized.push(message);
      continue;
    }

    if (!isOmittedFromReplay(message)) {
      lastReplayableIndex = -1;
    }
    normalized.push(message);
  }

  return normalized;
}

/**
 * Convert persisted display history to API history.
 *
 * @param messages - Persisted messages from the session
 * @returns API-shaped messages with pairing invariant enforced
 */
export function toApiMessages(messages: Message[], thinking?: ThinkingReplayContext): ApiMessage[] {
  const replayMessages = coalesceConsecutiveToolCallMessages(messages);

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
  const survivingToolCallsByMessage = new Map<Message, Set<string>>();
  const pendingToolCallIds = new Set<string>();
  let pendingToolCallMessage: Message | null = null;

  for (const msg of replayMessages) {
    // Skip error messages
    if (msg.type === MessageType.ERROR) {
      continue;
    }

    if (msg.hidden || msg.excludeFromModel) {
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
      if (
        pendingToolCallMessage &&
        msg.tool_call_id &&
        pendingToolCallIds.has(msg.tool_call_id)
      ) {
        const survivingIds = survivingToolCallsByMessage.get(pendingToolCallMessage);
        if (survivingIds) {
          survivingIds.add(msg.tool_call_id);
        } else {
          survivingToolCallsByMessage.set(
            pendingToolCallMessage,
            new Set([msg.tool_call_id]),
          );
        }
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
    pendingToolCallMessage = null;
    if (msg.tool_calls) {
      pendingToolCallMessage = msg;
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

  for (const msg of replayMessages) {
    // Skip error messages
    if (msg.type === MessageType.ERROR) {
      continue;
    }

    if (msg.hidden || msg.excludeFromModel) {
      continue;
    }

    // Skip tool_call messages with no tool_calls
    if (msg.type === MessageType.TOOL_CALL && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      continue;
    }

    // THINKING: replay with reasoning content parts so reasoning-capable
    // models (GLM, DeepSeek, Qwen) retain prior deliberation; with a thinking
    // context the current model's policy chooses artifact, plain text, or
    // omission. The match-set is NOT reset on THINKING: an intervening
    // THINKING between assistant(tool_calls=[A]) and tool(A) must not cause
    // A to be dropped as orphaned.
    if (msg.type === MessageType.THINKING) {
      if (thinking) {
        const part = thinkingReplayPart(msg, thinking);
        if (!part) continue;
        apiMessages.push({ role: 'assistant', content: [part] });
        continue;
      }
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
      const survivingIds = survivingToolCallsByMessage.get(msg);
      const surviving = msg.tool_calls.filter(
        (tc) => survivingIds?.has(tc.id),
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

    // Match-set must reflect only surviving tool_calls (those actually
    // emitted). Using unfiltered msg.tool_calls would keep dropped ids and
    // incorrectly pair orphaned TOOL_RESULT messages to them.
    if (d.tool_calls && d.tool_calls.length > 0) {
      lastAssistantToolCallIds = new Set(
        d.tool_calls.map((tc) => tc.id).filter((id): id is string => id != null),
      );
    } else {
      lastAssistantToolCallIds = new Set();
    }
  }

  return apiMessages;
}
