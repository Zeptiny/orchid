/**
 * Model message conversion — OpenAI-shaped replay records to AI SDK input.
 *
 * `history.ts` owns replay/pairing semantics. This adapter owns only the
 * provider-neutral shape conversion required by AI SDK's `streamText`.
 */
import type { AssistantContent, ModelMessage } from 'ai';
import type { ApiMessage } from '../../shared/types/message';

/**
 * Convert replay-safe OpenAI-shaped messages into AI SDK model messages.
 *
 * System messages deliberately do not appear in the returned array: callers
 * pass the composed system prompt through `streamText`'s `system` parameter.
 */
export function toModelMessages(historyMessages: readonly ApiMessage[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];

  for (const message of historyMessages) {
    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'assistant') {
      const contentArray = Array.isArray(message.content)
        ? message.content.map((part) => {
            if (part.type === 'reasoning') {
              return { type: 'reasoning' as const, text: part.text };
            }
            return { type: 'text' as const, text: part.text };
          })
        : message.content
          ? [{ type: 'text' as const, text: message.content }]
          : [];

      const content: AssistantContent = message.tool_calls
        ? [
            ...contentArray,
            ...message.tool_calls.flatMap((toolCall) => {
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
            }),
          ]
        : contentArray.length === 1 && contentArray[0].type === 'text'
          ? contentArray[0].text
          : contentArray.length > 0
            ? contentArray
            : '';
      modelMessages.push({ role: 'assistant', content });
      continue;
    }

    if (message.role === 'tool') {
      const textContent = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
          : '';

      modelMessages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: message.tool_call_id!,
            // The persisted result has no name; AI SDK pairs by toolCallId.
            toolName: 'unknown',
            output: { type: 'text', value: textContent },
          },
        ],
      });
      continue;
    }

    if (message.role === 'user') {
      const textContent = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
          : '';
      modelMessages.push({ role: 'user', content: textContent });
    }
  }

  return modelMessages;
}
