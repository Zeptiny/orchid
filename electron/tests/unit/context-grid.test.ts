import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ContextLegend,
  computeContextBreakdown,
  computeContextCategories,
  contextPercent,
} from '../../src/renderer/components/ContextGrid';
import type { Message } from '../../src/shared/types/message';
import { MessageType } from '../../src/shared/types/message';

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

  it('splits tool and assistant usage into the overview categories', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'answer',
        type: MessageType.TEXT,
        thinking: null,
        hidden: false,
      },
      {
        role: 'assistant',
        content: 'reason',
        type: MessageType.THINKING,
        thinking: 'reason',
        hidden: false,
      },
    ] as unknown as Message[];

    expect(computeContextCategories(
      messages,
      {
        prompt_tokens: 900,
        completion_tokens: 100,
        total_tokens: 1_000,
        cached_tokens: 0,
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
    )).toEqual({
      toolDefinition: 25,
      toolUse: 25,
      response: 37,
      reasoning: 38,
    });
  });

  it('labels nested tool and assistant categories in the overview', () => {
    const html = renderToStaticMarkup(
      createElement(ContextLegend, {
        usage: {
          prompt_tokens: 900,
          completion_tokens: 100,
          total_tokens: 1_000,
          cached_tokens: 0,
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
        maxContext: 1_000,
        variant: 'panel',
      }),
    );

    expect(html).toContain('Tools');
    expect(html).toContain('Tool (Definition)');
    expect(html).toContain('Tool use (Output)');
    expect(html).toContain('Assistant');
    expect(html).toContain('Response');
    expect(html).toContain('Reasoning');
  });
});
