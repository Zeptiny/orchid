/**
 * Model message conversion — OpenAI-shaped replay records to AI SDK input.
 *
 * `history.ts` owns replay/pairing semantics. This adapter owns only the
 * provider-neutral shape conversion required by AI SDK's `streamText`.
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
export function toModelMessages(historyMessages: readonly ApiMessage[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];

  for (const message of historyMessages) {
    if (message.role === MessageRole.SYSTEM) {
      continue;
    }

    if (message.role === MessageRole.ASSISTANT) {
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
            return { type: 'text' as const, text: part.text };
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

  return modelMessages;
}
