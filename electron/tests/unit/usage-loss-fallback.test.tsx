// @vitest-environment jsdom
/**
 * Regression tests for issue #136 — "Data loss after interrupted agent /
 * failed request".
 *
 * Turns that end without delivering a usage event (provider failure before
 * the first finish-step, interrupt before any usage) leave a live-but-empty
 * turn projection. `projection?.usage ?? persistedUsage` then evaluated the
 * null projection usage as authoritative and blanked the Context/Usage
 * surfaces that previously showed the session's persisted usage.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../../src/renderer/hooks/useChat';
import { buildHistoryStreamItems } from '../../src/renderer/utils/stream-building';
import { EMPTY_SUBAGENT_USAGE_SUMMARY } from '../../src/shared/usage';
import { ChainStatus, type Chain } from '../../src/shared/types/chain';
import {
  MessageRole,
  MessageType,
  type Message,
  type Usage,
} from '../../src/shared/types/message';
import type {
  ChatDoneEvent,
  ChatErrorEvent,
  ChatUsageEvent,
} from '../../src/shared/types/ipc';

type OrchidChatHandlers = {
  onUsage: ((event: ChatUsageEvent) => void) | null;
  onDone: ((event: ChatDoneEvent) => void) | null;
  onError: ((event: ChatErrorEvent) => void) | null;
};

let handlers: OrchidChatHandlers;

beforeEach(() => {
  handlers = { onUsage: null, onDone: null, onError: null };
  window.orchid = {
    chat: {
      send: vi.fn(),
      cancel: vi.fn(),
      onChunk: vi.fn(() => () => {}),
      onThinking: vi.fn(() => () => {}),
      onState: vi.fn(() => () => {}),
      onDone: vi.fn((callback: (event: ChatDoneEvent) => void) => {
        handlers.onDone = callback;
        return () => {};
      }),
      onError: vi.fn((callback: (event: ChatErrorEvent) => void) => {
        handlers.onError = callback;
        return () => {};
      }),
      onUsage: vi.fn((callback: (event: ChatUsageEvent) => void) => {
        handlers.onUsage = callback;
        return () => {};
      }),
      onToolCallStart: vi.fn(() => () => {}),
      onToolCallDelta: vi.fn(() => () => {}),
      onToolCallUpdate: vi.fn(() => () => {}),
    },
  } as never;
});

afterEach(() => {
  cleanup();
});

const PERSISTED_USAGE: Usage = {
  prompt_tokens: 800,
  completion_tokens: 120,
  total_tokens: 920,
  cached_tokens: 64,
  context: {
    input_tokens: 800,
    output_tokens: 120,
    used_tokens: 8_400,
    system_tokens: 300,
    tools_tokens: 100,
    tool_use_tokens: 50,
    user_tokens: 200,
    assistant_tokens: 270,
  },
};

function message(id: string, role: MessageRole, content: string, usage: Usage | null = null): Message {
  return {
    id,
    role,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-08-17T00:00:00.000Z',
    usage,
    hidden: false,
    tool_result: null,
  };
}

describe('#136 persisted usage survives turns ending without usage', () => {
  it('failed request keeps the persisted usage on chat + cumulative surfaces', () => {
    const { result } = renderHook(() => useChat('session-1'));
    act(() => {
      result.current.setMessages([
        message('u1', MessageRole.USER, 'Explain the cache.'),
        message('a1', MessageRole.ASSISTANT, 'The cache is bounded.', PERSISTED_USAGE),
      ]);
    });
    expect(result.current.usage).toEqual(PERSISTED_USAGE);

    const failedTurnUser = message('u2', MessageRole.USER, 'Break things');
    act(() => {
      handlers.onError?.({
        sessionId: 'session-1',
        turnId: 'turn-2',
        sequence: 3,
        type: 'error',
        error: 'unknown inference model',
        title: 'Stream Error',
        messages: [failedTurnUser],
      });
    });

    // The failed turn delivered no usage; surfaces must keep persisted usage.
    expect(result.current.usage).toEqual(PERSISTED_USAGE);
    expect(result.current.cumulativeUsage.prompt_tokens).toBe(PERSISTED_USAGE.prompt_tokens);
    expect(result.current.status).toBe('idle');
  });

  it('interrupted turn with no delivered usage keeps persisted usage', () => {
    const { result } = renderHook(() => useChat('session-1'));
    act(() => {
      result.current.setMessages([
        message('u1', MessageRole.USER, 'Explain the cache.'),
        message('a1', MessageRole.ASSISTANT, 'The cache is bounded.', PERSISTED_USAGE),
      ]);
    });

    act(() => {
      handlers.onDone?.({
        sessionId: 'session-1',
        turnId: 'turn-2',
        sequence: 3,
        type: 'done',
        response: 'partial answer',
        interrupted: true,
        usage: null,
        messages: [
          message('u2', MessageRole.USER, 'Interrupt me'),
          message('a2', MessageRole.ASSISTANT, 'partial answer'),
        ],
      });
    });

    expect(result.current.usage).toEqual(PERSISTED_USAGE);
    expect(result.current.interrupted).toBe(true);
  });

  it('live usage still wins while streaming and after a usage-carrying done', () => {
    const { result } = renderHook(() => useChat('session-1'));
    act(() => {
      result.current.setMessages([
        message('u1', MessageRole.USER, 'Older'),
        message('a1', MessageRole.ASSISTANT, 'Older answer', PERSISTED_USAGE),
      ]);
    });

    const liveUsage: Usage = {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      cached_tokens: 0,
    };
    act(() => {
      handlers.onUsage?.({
        sessionId: 'session-1',
        turnId: 'turn-2',
        sequence: 1,
        type: 'usage',
        usage: liveUsage,
      });
    });
    expect(result.current.usage).toEqual(liveUsage);
    expect(result.current.currentTurnUsage).toEqual(liveUsage);

    act(() => {
      handlers.onDone?.({
        sessionId: 'session-1',
        turnId: 'turn-2',
        sequence: 2,
        type: 'done',
        response: 'fresh answer',
        interrupted: false,
        usage: liveUsage,
        messages: [
          message('u2', MessageRole.USER, 'Fresh'),
          message('a2', MessageRole.ASSISTANT, 'fresh answer', liveUsage),
        ],
      });
    });
    expect(result.current.usage).toEqual(liveUsage);
    expect(result.current.currentTurnUsage).toBeNull();
  });
});

function makeChain(overrides: Partial<Chain>): Chain {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    messages: [],
    status: ChainStatus.COMPLETED,
    selection: null,
    modelLabel: null,
    agentName: 'general',
    agentType: 'internal',
    agentTier: 'bloom',
    subagentRecord: null,
    startTime: '2026-08-17T00:00:00.000Z',
    endTime: '2026-08-17T00:01:00.000Z',
    errorDetail: null,
    errorTitle: null,
    ...overrides,
  };
}

describe('#136 terminal chain footers are never stamped with live usage', () => {
  it('FAILED last chain without its own usage does not inherit liveUsage', () => {
    const failedChain = makeChain({
      status: ChainStatus.FAILED,
      errorDetail: 'unknown inference model',
      errorTitle: 'Stream Error',
      messages: [message('u2', MessageRole.USER, 'Break things')],
    });
    const { items } = buildHistoryStreamItems({
      messages: failedChain.messages as Message[],
      toolBlocks: [],
      status: 'idle',
      liveUsage: PERSISTED_USAGE,
      subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
      sessionChains: [failedChain],
      interrupted: false,
      expandedChainIndexes: new Set(),
    });

    const footer = items.find((item) => item.kind === 'footer');
    expect(footer).toBeTruthy();
    if (footer?.kind === 'footer') {
      expect(footer.usage).toBeNull();
    }
  });

  it('ACTIVE last chain still prefers liveUsage over its committed sum', () => {
    const activeChain = makeChain({
      status: ChainStatus.ACTIVE,
      endTime: null,
      messages: [message('u2', MessageRole.USER, 'Running turn')],
    });
    const { activeFooter } = buildHistoryStreamItems({
      messages: activeChain.messages as Message[],
      toolBlocks: [],
      status: 'streaming',
      liveUsage: PERSISTED_USAGE,
      subagentUsage: EMPTY_SUBAGENT_USAGE_SUMMARY,
      sessionChains: [activeChain],
      interrupted: false,
      expandedChainIndexes: new Set(),
    });

    expect(activeFooter).toBeTruthy();
    expect(activeFooter?.usage).toEqual(PERSISTED_USAGE);
  });
});
