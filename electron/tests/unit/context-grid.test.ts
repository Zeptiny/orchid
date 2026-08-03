import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ContextGrid,
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

  it('prefers provider-reported reasoning tokens over the character ratio', () => {
    // Summarized reasoning: tiny visible thinking vs a long response would
    // make the char-based split undercount reasoning.
    const messages = [
      {
        role: 'assistant',
        content: 'a very long visible response '.repeat(10),
        type: MessageType.TEXT,
        thinking: null,
        hidden: false,
      },
      {
        role: 'assistant',
        content: 'sum',
        type: MessageType.THINKING,
        thinking: 'sum',
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
          reasoning_tokens: 40,
        },
      },
      1_000,
    )).toEqual({
      toolDefinition: 25,
      toolUse: 25,
      response: 35,
      reasoning: 40,
    });
  });

  it('subtracts provider reasoning tokens from completion usage without a snapshot', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'answer',
        type: MessageType.TEXT,
        thinking: null,
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
        reasoning_tokens: 60,
      },
      1_000,
    )).toEqual({
      toolDefinition: 0,
      toolUse: 0,
      response: 40,
      reasoning: 60,
    });
  });

  it('excludes hidden messages from every character bucket', () => {
    const hiddenTool = {
      role: 'assistant',
      content: 'hidden tool output',
      type: MessageType.TOOL_RESULT,
      thinking: null,
      hidden: true,
    } as unknown as Message;

    expect(computeContextCategories(
      [hiddenTool],
      {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
      },
      1_000,
    )).toEqual({
      toolDefinition: 0,
      toolUse: 0,
      response: 0,
      reasoning: 0,
    });
  });

  it('labels tool and assistant categories without parent rows', () => {
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

    expect(html).toContain('Tool (Definition)');
    expect(html).toContain('Tool use (Output)');
    expect(html).toContain('Response');
    expect(html).toContain('Reasoning');
    expect(html).not.toContain('>Tools<');
    expect(html).not.toContain('>Assistant<');
    expect(html).not.toContain('context-panel-list pl-3');
  });

  it('scans message content once for the paired bar and legend', () => {
    let contentReads = 0;
    const message = {
      role: 'user',
      type: MessageType.TEXT,
      hidden: false,
      get content() {
        contentReads += 1;
        return 'hello';
      },
    } as unknown as Message;

    renderToStaticMarkup(
      createElement(ContextGrid, {
        messages: [message],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 0,
          total_tokens: 100,
          cached_tokens: 0,
        },
        maxContext: 1_000,
      }),
    );

    expect(contentReads).toBe(1);
  });
});
