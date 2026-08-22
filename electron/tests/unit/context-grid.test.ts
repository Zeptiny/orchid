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

  it('counts reasoning tokens on a hidden usage message after the chain finishes', () => {
    // When a turn produces no text response (only thinking/tool calls),
    // finalizeTurn attaches the accumulated usage to a hidden assistant
    // message. The done event carries the same usage reference, so
    // isPersistedUsageRef returns true and providerDelta is zeroed.
    // sumPersistedReasoning must still find the reasoning tokens on the
    // hidden message — otherwise all assistant tokens are misattributed
    // to "response" instead of being split between response and reasoning.
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cached_tokens: 0,
      reasoning_tokens: 40,
      context: {
        input_tokens: 100,
        output_tokens: 50,
        used_tokens: 150,
        system_tokens: 10,
        tools_tokens: 0,
        tool_use_tokens: 0,
        user_tokens: 30,
        assistant_tokens: 110,
        reasoning_tokens: 40,
      },
    } as const;

    const hiddenUsageMessage = {
      role: 'assistant',
      content: '',
      type: MessageType.TEXT,
      thinking: null,
      hidden: true,
      usage,
    } as unknown as Message;

    const categories = computeContextCategories([hiddenUsageMessage], usage, 1_000);

    expect(categories.reasoning).toBe(40);
    expect(categories.response).toBe(70);
  });

  it('estimates reasoning from visible thinking when the provider reports zero', () => {
    // Some models (e.g. GLM) stream visible thinking text but report
    // reasoning_tokens = 0. The live view counts that thinking via streaming
    // chars; once the chain finishes the persisted zero must not collapse the
    // category to 0 — fall back to the character-ratio estimate instead.
    const thinkingText = 'x'.repeat(24_513);
    const usage = {
      prompt_tokens: 96_743,
      completion_tokens: 3_480,
      total_tokens: 100_223,
      cached_tokens: 0,
      reasoning_tokens: 0,
      context: {
        input_tokens: 96_743,
        output_tokens: 3_480,
        used_tokens: 100_223,
        system_tokens: 8_896,
        tools_tokens: 10_546,
        tool_use_tokens: 76_680,
        user_tokens: 32,
        assistant_tokens: 4_069,
        reasoning_tokens: 0,
      },
    } as const;
    const usageMessage = {
      role: 'assistant',
      content: 'final answer',
      type: MessageType.TEXT,
      thinking: null,
      hidden: false,
      usage,
    } as unknown as Message;
    const thinkingMessage = {
      role: 'assistant',
      content: thinkingText,
      type: MessageType.THINKING,
      thinking: thinkingText,
      hidden: false,
    } as unknown as Message;

    const categories = computeContextCategories(
      [thinkingMessage, usageMessage], usage, 200_000,
    );

    expect(categories.reasoning).toBeGreaterThan(0);
    expect(categories.reasoning + categories.response).toBe(4_069);
  });

  it('sums the provider reasoning count with the in-flight streaming estimate', () => {
    // While a turn is active the provider-reported count (here 500) covers
    // finished steps; the thinking-char estimate (8000 chars -> 2000 tokens)
    // covers the in-flight step. They are disjoint and must be summed —
    // picking one made live thinking inflate "Response" (issue 187).
    const usage = {
      prompt_tokens: 1_000,
      completion_tokens: 600,
      total_tokens: 1_600,
      cached_tokens: 0,
      reasoning_tokens: 500,
      context: {
        input_tokens: 1_000,
        output_tokens: 600,
        used_tokens: 1_600,
        system_tokens: 100,
        tools_tokens: 0,
        tool_use_tokens: 0,
        user_tokens: 100,
        assistant_tokens: 3_000,
        reasoning_tokens: 500,
      },
    } as const;

    const html = renderToStaticMarkup(
      createElement(ContextLegend, {
        messages: [],
        usage,
        maxContext: 100_000,
        streamingThinkingChars: 8_000,
        variant: 'panel',
      }),
    );

    const reasoningTokens = html.match(
      /context-panel-label">Reasoning<\/span>.*?context-panel-tokens">([^<]+)</s,
    )?.[1];
    expect(reasoningTokens).toBe('2.5k');
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
    expect(html).toContain('Tool use');
    expect(html).not.toContain('Tool use (Output)');
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

  it('falls back to a char-derived summary category when summary_tokens is unreported', () => {
    const messages = [
      {
        role: 'user',
        content: 'x'.repeat(100),
        type: MessageType.TEXT,
        thinking: null,
        hidden: false,
      },
      {
        role: 'assistant',
        content: 'y'.repeat(100),
        type: MessageType.TEXT,
        thinking: null,
        hidden: false,
        compacted: { rangeStart: 'a', rangeEnd: 'b', mode: 'simple' as const },
      },
    ] as unknown as Message[];

    const breakdown = computeContextBreakdown(
      messages,
      {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        total_tokens: 1_100,
        cached_tokens: 0,
        context: {
          input_tokens: 1_000,
          output_tokens: 100,
          used_tokens: 1_100,
          system_tokens: 100,
          tools_tokens: 100,
          tool_use_tokens: 100,
          user_tokens: 350,
          assistant_tokens: 350,
        },
      },
      2_000,
    );

    // 100 summary chars of 200 total → half of the input tokens.
    expect(breakdown.summary).toBe(500);

    const html = renderToStaticMarkup(
      createElement(ContextLegend, {
        messages,
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
          cached_tokens: 0,
          context: {
            input_tokens: 1_000,
            output_tokens: 100,
            used_tokens: 1_100,
            system_tokens: 100,
            tools_tokens: 100,
            tool_use_tokens: 100,
            user_tokens: 350,
            assistant_tokens: 350,
          },
        },
        maxContext: 2_000,
        variant: 'panel',
      }),
    );
    expect(html).toContain('Summary (Compaction)');
  });

  it('prefers the provider-reported summary_tokens over the char fallback', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'y'.repeat(100),
        type: MessageType.TEXT,
        thinking: null,
        hidden: false,
        compacted: { rangeStart: 'a', rangeEnd: 'b', mode: 'simple' as const },
      },
    ] as unknown as Message[];

    const breakdown = computeContextBreakdown(
      messages,
      {
        prompt_tokens: 1_000,
        completion_tokens: 0,
        total_tokens: 1_000,
        cached_tokens: 0,
        context: {
          input_tokens: 1_000,
          output_tokens: 0,
          used_tokens: 1_000,
          system_tokens: 100,
          tools_tokens: 100,
          tool_use_tokens: 100,
          user_tokens: 350,
          assistant_tokens: 300,
          summary_tokens: 50,
        },
      },
      2_000,
    );

    expect(breakdown.summary).toBe(50);
  });
});
