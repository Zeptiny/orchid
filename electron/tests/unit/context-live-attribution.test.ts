/**
 * Issue #187 regressions — live/done token attribution in the Context panel.
 *
 * Three defects:
 * 1. In-flight thinking chars are bucketed into "Response" (not "Reasoning")
 *    because provider-reported reasoning (finished steps) and the streaming
 *    thinking estimate (in-flight step) were treated as mutually exclusive —
 *    they cover disjoint steps and must be summed.
 * 2. "Response" collapses to 0 when the turn ends: the renderer receives the
 *    done-event usage and the message-attached usage as separate structured
 *    clones across IPC, so reference equality cannot detect that the usage is
 *    already persisted on a message — its reasoning tokens double-count and
 *    clamp the whole assistant bucket into "Reasoning".
 * 3. The turn projection must expose how much thinking text is still
 *    unaccounted for by the latest usage event, so the renderer does not
 *    re-estimate thinking that the provider already reported.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  applyChatTurnEvents,
  beginChatTurnProjection,
} from '../../src/shared/chat/turn-projection';
import {
  computeContextCategories,
  ContextLegend,
} from '../../src/renderer/components/ContextGrid';import type { Message, Usage } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';

function usageWith(reasoning: number, assistantTokens: number): Usage {
  return {
    prompt_tokens: 12_000,
    completion_tokens: 3_500,
    total_tokens: 15_500,
    cached_tokens: 0,
    reasoning_tokens: reasoning,
    context: {
      input_tokens: 12_000,
      output_tokens: 3_500,
      used_tokens: 15_500,
      system_tokens: 500,
      tools_tokens: 500,
      tool_use_tokens: 1_000,
      user_tokens: 4_000,
      assistant_tokens: assistantTokens,
      reasoning_tokens: reasoning,
    },
  };
}

function textMessage(content: string, usage?: Usage): Message {
  return {
    id: `text-${content.length}`,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TEXT,
    thinking: null,
    hidden: false,
    ...(usage ? { usage } : {}),
  } as unknown as Message;
}

function thinkingMessage(content: string): Message {
  return {
    id: `thinking-${content.length}`,
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.THINKING,
    thinking: content,
    hidden: false,
  } as unknown as Message;
}

function panelTokens(
  html: string,
  label: string,
): number {
  const match = html.match(
    new RegExp(`context-panel-label">${label}</span>.*?context-panel-tokens">([\\d.,kM]+)<`, 's'),
  )?.[1];
  if (!match) throw new Error(`panel row not found: ${label}`);
  if (match.endsWith('k')) return Math.round(parseFloat(match) * 1_000);
  if (match.endsWith('M')) return Math.round(parseFloat(match) * 1_000_000);
  return parseInt(match.replace(/,/g, ''), 10);
}

function renderPanel(
  messages: readonly Message[],
  usage: Usage | null,
  streamingThinkingChars?: number,
): { response: number; reasoning: number; toolUse: number } {
  const html = renderToStaticMarkup(createElement(ContextLegend, {
    messages: [...messages],
    usage: usage ?? undefined,
    maxContext: 200_000,
    ...(streamingThinkingChars ? { streamingThinkingChars } : {}),
    variant: 'panel',
  }));
  return {
    response: panelTokens(html, 'Response'),
    reasoning: panelTokens(html, 'Reasoning'),
    toolUse: panelTokens(html, 'Tool use'),
  };
}

describe('issue 187: live reasoning attribution', () => {
  it('attributes in-flight thinking to Reasoning, not Response', () => {
    // Turn so far: finished step reported 1200 reasoning tokens; 2000 chars of
    // the NEXT step's thinking are streaming with no usage event yet.
    const usage = usageWith(1_200, 1_400);
    const messages = [textMessage('prior answer'), textMessage('x'.repeat(200))];

    const before = renderPanel(messages, usage);
    const during = renderPanel(messages, usage, 2_000);

    expect(during.reasoning).toBeGreaterThan(before.reasoning);
    // The whole point of #187: Response must not move while only thinking
    // streams in.
    expect(during.response).toBe(before.response);
  });

  it('sums provider reasoning with the streaming estimate instead of picking one', () => {
    const usage = usageWith(500, 3_000);
    const panel = renderPanel([textMessage('answer')], usage, 8_000);

    // 500 provider-reported + ~2000 estimated in-flight (8000 chars / 4).
    expect(panel.reasoning).toBeGreaterThanOrEqual(2_400);
  });

  it('keeps a positive Response after the turn ends with a cloned done-event usage', () => {
    // The done event and the merged terminal messages cross IPC separately —
    // the usage object on the message is a structural clone, never the same
    // reference the projection holds.
    const turnUsage = usageWith(1_200, 1_400);
    const messages = [
      textMessage('question context'.repeat(5)),
      textMessage('Here is the fix for the auth bug. '.repeat(20), structuredClone(turnUsage)),
    ];

    const categories = computeContextCategories(messages, structuredClone(turnUsage), 200_000);

    expect(categories.response).toBeGreaterThan(0);
    expect(categories.reasoning).toBe(1_200);
  });

  it('keeps an explicit response visible when turn reasoning exceeds the final snapshot bucket', () => {
    // Multi-step reasoning-heavy turn: per-message usage reports 2300 reasoning
    // tokens, but the final step's context snapshot only holds 900 assistant
    // tokens (earlier steps' reasoning never re-enters the final window).
    // Clamping with the session total redirected the whole bucket into
    // Reasoning and collapsed the explicit response to zero.
    const turnUsage = usageWith(2_300, 900);
    const messages = [
      textMessage('question context'.repeat(5)),
      thinkingMessage('x'.repeat(9_000)),
      textMessage('Here is the fix for the auth bug. '.repeat(20), structuredClone(turnUsage)),
    ];

    const panel = renderPanel(messages, structuredClone(turnUsage));

    expect(panel.response).toBeGreaterThan(0);
    expect(panel.reasoning).toBeGreaterThan(0);
  });

  it('labels the tool-use row without the stale "(Output)" suffix', () => {
    const html = renderToStaticMarkup(createElement(ContextLegend, {
      messages: [],
      usage: usageWith(0, 0),
      maxContext: 1_000,
      variant: 'panel',
    }));
    expect(html).toContain('Tool use');
    expect(html).not.toContain('Tool use (Output)');
  });
});

describe('issue 187: unaccounted thinking tracking', () => {
  const identity = (sequence: number) => ({ sessionId: 's1', turnId: 't1', sequence });
  const at = (sequence: number) => ({ ...identity(sequence), occurredAt: '2026-01-01T00:00:00Z' });

  it('captures the thinking length already covered by each usage event', () => {
    const projected = applyChatTurnEvents(beginChatTurnProjection('s1', 0), [
      { ...at(1), type: 'thinking', data: 'a'.repeat(900), segmentId: 'think-1' },
      { ...at(2), type: 'usage', usage: usageWith(200, 300) },
      { ...at(3), type: 'thinking', data: 'b'.repeat(300), segmentId: 'think-2' },
    ]);

    expect(projected?.thinking.length).toBe(1_200);
    expect(projected?.usageThinkingChars).toBe(900);
  });

  it('treats all thinking as unaccounted before any usage event', () => {
    const projected = applyChatTurnEvents(beginChatTurnProjection('s1', 0), [
      { ...at(1), type: 'thinking', data: 'a'.repeat(400), segmentId: 'think-1' },
    ]);

    expect(projected?.usageThinkingChars).toBe(0);
    expect(projected?.thinking.length).toBe(400);
  });
});
