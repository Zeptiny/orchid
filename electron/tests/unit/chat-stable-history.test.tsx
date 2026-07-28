// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderCounts = vi.hoisted(() => new Map<string, number>());
const footerUsages = vi.hoisted(() => new Map<string, number | null>());
const footerSubUsages = vi.hoisted(() => new Map<string, number | null>());

vi.mock('../../src/renderer/components/MessageWidget', () => ({
  MessageWidget: ({ message }: { message: { id: string } }) => {
    renderCounts.set(message.id, (renderCounts.get(message.id) ?? 0) + 1);
    return <div data-testid={`message-${message.id}`} />;
  },
}));

vi.mock('../../src/renderer/components/ChainFooter', () => ({
  ChainFooter: ({
    usage,
    subUsage,
  }: {
    usage: { total_tokens: number } | null;
    subUsage?: { total_tokens: number } | null;
  }) => {
    footerUsages.set('active', usage?.total_tokens ?? null);
    footerSubUsages.set('active', subUsage?.total_tokens ?? null);
    return <div data-testid="active-footer">{usage?.total_tokens ?? 'none'}</div>;
  },
}));

import { ChatStream } from '../../src/renderer/components/ChatStream';
import { MessageRole, MessageType, type Message, type Usage } from '../../src/shared/types/message';
import type { SubagentUsageSummary } from '../../src/shared/usage';

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
  footerSubUsages.clear();
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

  it('renders committed rows once across 100 live frames while the usage summary is stable', () => {
    const summary: SubagentUsageSummary = { byParentChain: new Map(), total: null };
    const view = render(
      <ChatStream {...props('token 0', 1, usage(10))} subagentUsage={summary} />,
    );
    const before = {
      user: renderCounts.get('history-user') ?? 0,
      assistant: renderCounts.get('history-assistant') ?? 0,
    };
    expect(before.user).toBeGreaterThan(0);
    expect(before.assistant).toBeGreaterThan(0);

    for (let revision = 2; revision <= 101; revision += 1) {
      view.rerender(
        <ChatStream
          {...props(`token ${revision}`, revision, usage(revision * 10))}
          subagentUsage={summary}
        />,
      );
    }

    expect(renderCounts.get('history-user')).toBe(before.user);
    expect(renderCounts.get('history-assistant')).toBe(before.assistant);
    expect(footerUsages.get('active')).toBe(1010);
  });

  it('recomputes footer sub attribution when the usage summary identity changes', () => {
    const first: SubagentUsageSummary = {
      byParentChain: new Map([[-1, usage(30)]]),
      total: usage(30),
    };
    const view = render(
      <ChatStream {...props('t', 1, usage(10))} subagentUsage={first} />,
    );
    expect(footerSubUsages.get('active')).toBe(30);

    const second: SubagentUsageSummary = {
      byParentChain: new Map([[-1, usage(45)]]),
      total: usage(45),
    };
    view.rerender(
      <ChatStream {...props('t', 2, usage(20))} subagentUsage={second} />,
    );
    expect(footerSubUsages.get('active')).toBe(45);
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
