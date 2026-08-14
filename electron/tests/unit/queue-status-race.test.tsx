// @vitest-environment jsdom
import { useCallback } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatChunkEvent,
  ChatDoneEvent,
  ChatStateEvent,
  ChatUsageEvent,
} from '../../src/shared/types/ipc';
import { MessageRole, MessageType, type Message } from '../../src/shared/types/message';
import { useChat } from '../../src/renderer/hooks/useChat';
import { useMessageQueue } from '../../src/renderer/hooks/useMessageQueue';
import { useQueueAutoFire } from '../../src/renderer/hooks/useQueueAutoFire';

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let onChunk: ((event: ChatChunkEvent) => void) | null;
let onDone: ((event: ChatDoneEvent) => void) | null;
let onState: ((event: ChatStateEvent) => void) | null;
let onUsage: ((event: ChatUsageEvent) => void) | null;
let resolveQueuedSend:
  | ((value: { status: 'started'; sessionId: string; turnId: string }) => void)
  | null;
let send: ReturnType<typeof vi.fn>;

function textMessage(id: string, role: MessageRole, content: string): Message {
  return {
    id,
    role,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

function useQueueRaceHarness() {
  const chat = useChat(SESSION_ID);
  const queue = useMessageQueue(SESSION_ID);
  const sendQueued = useCallback(
    (message: string) => chat.send(message, { sessionId: SESSION_ID }),
    [chat.send],
  );
  useQueueAutoFire(
    chat.status,
    queue.consumeNext,
    queue.restoreBatch,
    queue.editingId,
    sendQueued,
  );
  return { chat, queue };
}

beforeEach(() => {
  onChunk = null;
  onDone = null;
  onState = null;
  onUsage = null;
  resolveQueuedSend = null;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  send = vi.fn()
    .mockResolvedValueOnce({ status: 'started', sessionId: SESSION_ID, turnId: 'turn-1' })
    .mockImplementationOnce(() => new Promise((resolve) => {
      resolveQueuedSend = resolve;
    }));
  window.orchid = {
    chat: {
      send,
      onChunk: vi.fn((callback) => { onChunk = callback; return () => {}; }),
      onThinking: vi.fn(() => () => {}),
      onState: vi.fn((callback) => { onState = callback; return () => {}; }),
      onDone: vi.fn((callback) => { onDone = callback; return () => {}; }),
      onError: vi.fn(() => () => {}),
      onUsage: vi.fn((callback) => { onUsage = callback; return () => {}; }),
      onToolCallStart: vi.fn(() => () => {}),
      onToolCallDelta: vi.fn(() => () => {}),
      onToolCallUpdate: vi.fn(() => () => {}),
    },
  } as never;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('queued turn status handoff', () => {
  it('waits for the prior terminal event before auto-firing the queued turn', async () => {
    const { result } = renderHook(() => useQueueRaceHarness());

    await act(async () => {
      expect(await result.current.chat.send('first request', { sessionId: SESSION_ID })).toBe(true);
    });
    act(() => {
      result.current.queue.addToQueue('queued follow-up');
    });

    await act(async () => {
      onState?.({
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        sequence: 1,
        state: 'idle',
        error: null,
        interruptState: 'idle',
        cwd: '/project',
      });
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.chat.status).toBe('streaming');
    expect(result.current.queue.queue).toHaveLength(1);

    await act(async () => {
      onDone?.({
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        sequence: 2,
        type: 'done',
        response: 'first answer',
        messages: [
          textMessage('user-1', MessageRole.USER, 'first request'),
          textMessage('assistant-1', MessageRole.ASSISTANT, 'first answer'),
        ],
        interrupted: false,
        usage: null,
      });
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    await act(async () => {
      // Cancellation can publish a trailing idle state after CHAT_DONE. It
      // must not claim affinity while the queued send handshake is pending.
      onState?.({
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        sequence: 3,
        state: 'idle',
        error: null,
        interruptState: 'idle',
        cwd: '/project',
      });
      onState?.({
        sessionId: SESSION_ID,
        turnId: 'turn-2',
        sequence: 1,
        state: 'streaming',
        error: null,
        interruptState: 'idle',
        cwd: '/project',
      });
      onChunk?.({
        sessionId: SESSION_ID,
        turnId: 'turn-2',
        sequence: 2,
        type: 'chunk',
        segmentId: 'queued-answer',
        data: 'second answer',
      });
      onUsage?.({
        sessionId: SESSION_ID,
        turnId: 'turn-2',
        sequence: 3,
        type: 'usage',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cached_tokens: 0,
        },
      });
      resolveQueuedSend?.({ status: 'started', sessionId: SESSION_ID, turnId: 'turn-2' });
    });

    expect(result.current.chat.status).toBe('streaming');
    expect(result.current.chat.streamingContent).toBe('second answer');
    expect(result.current.chat.messages.map((message) => message.content)).toEqual([
      'first request',
      'first answer',
      'queued follow-up',
    ]);
    expect(result.current.queue.queue).toHaveLength(0);
  });
});
