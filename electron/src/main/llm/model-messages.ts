/**
 * Model message conversion — OpenAI-shaped replay records to AI SDK input.
 *
 * `history.ts` owns replay/pairing semantics. This adapter owns only the
 * provider-neutral shape conversion required by AI SDK's `streamText`, plus
 * two Responses-protocol replay rules:
 *
 * - Commentary phase: assistant text that precedes tool calls in the same
 *   message is intermediate commentary, so it replays with
 *   `openai.phase: "commentary"` for the Responses adapter (Meta rejects a
 *   plain final-answer message immediately before a function_call).
 * - Reasoning ordering: a replayed reasoning item must be followed by an
 *   assistant message or a function_call before the next user/system/developer
 *   message (Meta returns HTTP 400 otherwise). Reasoning-only turns — a
 *   cancelled turn or a text-less artifact — get a minimal assistant message
 *   after the reasoning item, the workaround the provider documents.
 */
import type { AssistantContent, ModelMessage } from 'ai';
import {
  MessageRole,
  type ApiMessage,
} from '../../shared/types/message';

function toTextOnlyContent(content: ApiMessage['content']): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    : '';
}

/**
 * Convert replay-safe OpenAI-shaped messages into AI SDK model messages.
 *
 * System messages deliberately do not appear in the returned array: callers
 * pass the composed system prompt through `streamText`'s `system` parameter.
 */
export function toModelMessages(
  historyMessages: readonly ApiMessage[],
  options: { readonly responsesReplay?: boolean } = {},
): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];

  for (const message of historyMessages) {
    if (message.role === MessageRole.SYSTEM) {
      continue;
    }

    if (message.role === MessageRole.ASSISTANT) {
      const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
      const contentArray = Array.isArray(message.content)
        ? message.content.map((part) => {
            if (part.type === 'reasoning') {
              // Replay artifacts ride as providerOptions so the provider
              // adapter can re-emit signed/encrypted thinking blocks.
              return {
                type: 'reasoning' as const,
                text: part.text,
                ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
              };
            }
            // Text emitted before tool calls in the same message is
            // intermediate commentary (Meta requires phase: "commentary" on
            // such replayed messages; a plain final answer 400s).
            const commentary = options.responsesReplay && hasToolCalls;
            return {
              type: 'text' as const,
              text: part.text,
              ...(commentary ? { providerOptions: { openai: { phase: 'commentary' } } } : {}),
            };
          })
        : message.content
          ? [{ type: 'text' as const, text: message.content }]
          : [];
      const toolCallContent = message.tool_calls?.flatMap((toolCall) => {
        let input: unknown;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          return [];
        }
        return [
          {
            type: 'tool-call' as const,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            input,
          },
        ];
      }) ?? [];

      const content: AssistantContent = toolCallContent.length > 0
        ? [
            ...contentArray,
            ...toolCallContent,
          ]
        : contentArray.length === 1 && contentArray[0].type === 'text'
          ? contentArray[0].text
          : contentArray.length > 0
            ? contentArray
            : '';
      modelMessages.push({ role: MessageRole.ASSISTANT, content });
      continue;
    }

    if (message.role === MessageRole.TOOL) {
      if (!message.tool_call_id) continue;
      const textContent = toTextOnlyContent(message.content);

      modelMessages.push({
        role: MessageRole.TOOL,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: message.tool_call_id,
            // The persisted result has no name; AI SDK pairs by toolCallId.
            toolName: 'unknown',
            output: { type: 'text', value: textContent },
          },
        ],
      });
      continue;
    }

    if (message.role === MessageRole.USER) {
      modelMessages.push({
        role: MessageRole.USER,
        content: toTextOnlyContent(message.content),
      });
    }
  }

  if (options.responsesReplay) {
    insertMinimalAssistantAfterReasoningOnly(modelMessages);
  }

  return modelMessages;
}

/**
 * Responses input validation requires every reasoning item to be followed by
 * an assistant message or a function_call before the next user/system/developer
 * message. Orchid replays each THINKING message as its own assistant reasoning
 * message, so a reasoning-only turn (cancelled mid-thought, or a text-less
 * opaque artifact) would leave `reasoning` directly before a user message and
 * be rejected. The provider-documented workaround is a minimal assistant
 * message inserted after the reasoning item.
 */
function insertMinimalAssistantAfterReasoningOnly(messages: ModelMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const parts = Array.isArray(message.content) ? message.content : [];
    const hasReasoning = parts.some((part) => part.type === 'reasoning');
    if (!hasReasoning) continue;
    const next = messages[index + 1];
    if (next?.role === 'assistant') continue;
    messages.splice(index + 1, 0, {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
    });
    index += 1;
  }
}
