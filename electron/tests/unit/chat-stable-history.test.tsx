// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderCounts = vi.hoisted(() => new Map<string, number>());
const footerUsages = vi.hoisted(() => new Map<string, number | null>());

vi.mock('../../src/renderer/components/MessageWidget', () => ({
  MessageWidget: ({ message }: { message: { id: string } }) => {
    renderCounts.set(message.id, (renderCounts.get(message.id) ?? 0) + 1);
    return <div data-testid={`message-${message.id}`} />;
  },
}));

vi.mock('../../src/renderer/components/ChainFooter', () => ({
  ChainFooter: ({ usage }: { usage: { total_tokens: number } | null }) => {
    footerUsages.set('active', usage?.total_tokens ?? null);
    return <div data-testid="active-footer">{usage?.total_tokens ?? 'none'}</div>;
  },
}));

import { ChatStream } from '../../src/renderer/components/ChatStream';
import { MessageRole, MessageType, type Message, type Usage } from '../../src/shared/types/message';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  renderCounts.clear();
  footerUsages.clear();
});

function message(id: string, role: MessageRole, content: string): Message {
  return {
    id,
    role,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-07-27T00:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

const history = [
  message('history-user', MessageRole.USER, 'Explain the cache.'),
  message('history-assistant', MessageRole.ASSISTANT, 'The cache is bounded.'),
];

function usage(totalTokens: number): Usage {
  return {
    prompt_tokens: totalTokens - 1,
    completion_tokens: 1,
    total_tokens: totalTokens,
    cached_tokens: 0,
  };
}

function props(streamingContent: string, streamRevision: number, currentTurnUsage: Usage) {
  return {
    messages: history,
    streamingContent,
    toolBlocks: [],
    streamRevision,
    status: 'streaming' as const,
    error: null,
    usage: null,
    currentTurnUsage,
    onClearError: vi.fn(),
    streamSegments: [{ kind: 'text' as const, id: 'live-text', content: streamingContent }],
  };
}

describe('ChatStream stable history boundary', () => {
  it('does not recreate committed rows for a live-only stream revision while the active footer updates', () => {
    const view = render(
      <ChatStream {...props('first live token', 1, usage(10))} />,
    );
    const historyRendersBeforeLiveUpdate = {
      user: renderCounts.get('history-user') ?? 0,
      assistant: renderCounts.get('history-assistant') ?? 0,
    };

    view.rerender(
      <ChatStream {...props('second live token', 2, usage(20))} />,
    );

    expect(renderCounts.get('history-user')).toBe(historyRendersBeforeLiveUpdate.user);
    expect(renderCounts.get('history-assistant')).toBe(historyRendersBeforeLiveUpdate.assistant);
    expect(footerUsages.get('active')).toBe(20);
  });

  it('keeps a live row mounted when SESSION_UPDATED commits it before CHAT_DONE', () => {
    const view = render(
      <ChatStream {...props('final answer', 1, usage(10))} />,
    );
    const liveNode = screen.getByTestId('message-live-text');

    view.rerender(
      <ChatStream
        {...props('final answer', 2, usage(20))}
        messages={[
          ...history,
          message('live-text', MessageRole.ASSISTANT, 'final answer'),
        ]}
      />,
    );

    expect(screen.getAllByTestId('message-live-text')).toHaveLength(1);
    expect(screen.getByTestId('message-live-text')).toBe(liveNode);
  });
});
