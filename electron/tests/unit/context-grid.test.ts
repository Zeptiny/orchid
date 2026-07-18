import { describe, expect, it } from 'vitest';
import {
  computeContextBreakdown,
  contextPercent,
} from '../../src/renderer/components/ContextGrid';

describe('context grid breakdown', () => {
  it('renders the latest-step snapshot instead of redistributing cumulative usage', () => {
    const breakdown = computeContextBreakdown(
      [],
      {
        prompt_tokens: 900,
        completion_tokens: 100,
        total_tokens: 1_000,
        cached_tokens: 300,
        context: {
          input_tokens: 200,
          output_tokens: 50,
          used_tokens: 250,
          system_tokens: 50,
          tools_tokens: 25,
          tool_use_tokens: 25,
          user_tokens: 75,
          assistant_tokens: 75,
        },
      },
      1_000,
    );

    expect(breakdown).toEqual({
      free: 750,
      system: 50,
      tools: 25,
      tool_use: 25,
      messages: 150,
      percentUsed: 25,
    });
  });

  it('does not turn a hydrated context snapshot into a false zero while the window loads', () => {
    const usage = {
      prompt_tokens: 900,
      completion_tokens: 100,
      total_tokens: 1_000,
      cached_tokens: 300,
      context: {
        input_tokens: 200,
        output_tokens: 50,
        used_tokens: 250,
        system_tokens: 50,
        tools_tokens: 25,
        tool_use_tokens: 25,
        user_tokens: 75,
        assistant_tokens: 75,
      },
    } as const;

    expect(contextPercent(usage, null)).toBeNull();
    expect(contextPercent(usage, 1_000)).toBe(25);
  });
});
