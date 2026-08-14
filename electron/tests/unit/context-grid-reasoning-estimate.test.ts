import { describe, expect, it } from 'vitest';
import { computeContextCategories } from '../../src/renderer/components/ContextGrid';
import type { Message } from '../../src/shared/types/message';
import { MessageType } from '../../src/shared/types/message';

describe('context grid reasoning estimate', () => {
  it('falls back to the char ratio when the provider reports no reasoning tokens', () => {
    // Shape exactly what buildStepUsage produces for providers that do not
    // break out reasoning tokens (e.g. Anthropic extended thinking):
    // reasoning_tokens omitted, context snapshot reasoning_tokens omitted.
    const messages = [
      {
        role: 'assistant',
        content: 'a visible answer',
        type: MessageType.TEXT,
        thinking: null,
        hidden: false,
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cached_tokens: 0,
          context: {
            input_tokens: 100,
            output_tokens: 50,
            used_tokens: 150,
            system_tokens: 10,
            tools_tokens: 0,
            tool_use_tokens: 0,
            user_tokens: 30,
            assistant_tokens: 110,
          },
        },
      },
      {
        role: 'assistant',
        content: 'let me think about this very carefully for a long time',
        type: MessageType.THINKING,
        thinking: 'let me think about this very carefully for a long time',
        hidden: false,
      },
    ] as unknown as Message[];

    const categories = computeContextCategories(messages, messages[0]?.usage ?? null, 1000);

    expect(categories.reasoning).toBeGreaterThan(0);
    expect(categories.response).toBeLessThan(110);
  });
});
