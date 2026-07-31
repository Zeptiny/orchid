// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../../src/renderer/hooks/useChat';
import type {
  ChatDoneEvent,
  ChatToolCallDeltaEvent,
  ChatToolCallStartEvent,
  ChatToolCallUpdateEvent,
} from '../../src/shared/types/ipc';

type Listener<T> = ((event: T) => void) | null;

let onToolStart: Listener<ChatToolCallStartEvent> = null;
let onToolDelta: Listener<ChatToolCallDeltaEvent> = null;
let onToolUpdate: Listener<ChatToolCallUpdateEvent> = null;
let onDone: Listener<ChatDoneEvent> = null;
let frameCallback: FrameRequestCallback | null = null;
let cancelStatus = 'cancelled';

function eventIdentity(sequence: number) {
  return { sessionId: 'session-1', turnId: 'turn-1', sequence };
}

beforeEach(() => {
  onToolStart = null;
  onToolDelta = null;
  onToolUpdate = null;
  onDone = null;
  frameCallback = null;
  cancelStatus = 'cancelled';
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frameCallback = callback;
    return 1;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  window.orchid = {
    chat: {
      onChunk: vi.fn(() => () => {}),
      onThinking: vi.fn(() => () => {}),
      onState: vi.fn(() => () => {}),
      onDone: vi.fn((callback: (event: ChatDoneEvent) => void) => {
        onDone = callback;
        return () => {};
      }),
      onError: vi.fn(() => () => {}),
      onUsage: vi.fn(() => () => {}),
      onToolCallStart: vi.fn((callback: (event: ChatToolCallStartEvent) => void) => {
        onToolStart = callback;
        return () => {};
      }),
      onToolCallDelta: vi.fn((callback: (event: ChatToolCallDeltaEvent) => void) => {
        onToolDelta = callback;
        return () => {};
      }),
      onToolCallUpdate: vi.fn((callback: (event: ChatToolCallUpdateEvent) => void) => {
        onToolUpdate = callback;
        return () => {};
      }),
      cancel: vi.fn(async () => ({ status: cancelStatus })),
    },
  } as never;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useChat tool argument streaming', () => {
  it('publishes many tool argument fragments once per frame and flushes exact args at terminal commit', () => {
    const { result } = renderHook(() => useChat('session-1'));

    act(() => {
      onToolStart?.({
        ...eventIdentity(1),
        type: 'tool_call_start',
        toolCallId: 'tool-1',
        toolName: 'write',
      });
    });
    const revisionBeforeDeltas = result.current.streamRevision;

    act(() => {
      onToolDelta?.({
        ...eventIdentity(2),
        type: 'tool_call_delta',
        toolCallId: 'tool-1',
        argsDelta: '{"path":',
      });
      onToolDelta?.({
        ...eventIdentity(3),
        type: 'tool_call_delta',
        toolCallId: 'tool-1',
        argsDelta: '"/a"}',
      });
    });

    expect(result.current.toolBlocks[0]?.partialArgs).toBe('');
    expect(result.current.streamRevision).toBe(revisionBeforeDeltas);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      frameCallback?.(0);
    });
    expect(result.current.toolBlocks[0]?.partialArgs).toBe('{"path":"/a"}');
    expect(result.current.streamRevision).toBe(revisionBeforeDeltas + 1);

    act(() => {
      onToolDelta?.({
        ...eventIdentity(4),
        type: 'tool_call_delta',
        toolCallId: 'tool-1',
        argsDelta: ' trailing',
      });
      onDone?.({
        ...eventIdentity(5),
        type: 'done',
        response: '',
      });
    });

    const toolCall = result.current.messages.find((message) => message.tool_call_id === 'tool-1');
    expect(toolCall?.tool_calls?.[0]?.function.arguments).toBe('{"path":"/a"} trailing');
  });

  it('flushes buffered arguments before back-to-back tool lifecycle events', () => {
    const { result } = renderHook(() => useChat('session-1'));

    act(() => {
      onToolStart?.({
        ...eventIdentity(1),
        type: 'tool_call_start',
        toolCallId: 'tool-1',
        toolName: 'write',
      });
      onToolDelta?.({
        ...eventIdentity(2),
        type: 'tool_call_delta',
        toolCallId: 'tool-1',
        argsDelta: '{"path":"/a"}',
      });
      onToolStart?.({
        ...eventIdentity(3),
        type: 'tool_call_start',
        toolCallId: 'tool-2',
        toolName: 'grep',
      });
      onToolDelta?.({
        ...eventIdentity(4),
        type: 'tool_call_delta',
        toolCallId: 'tool-2',
        argsDelta: '{"query":"orchid"}',
      });
      onToolUpdate?.({
        ...eventIdentity(5),
        type: 'tool_call_update',
        toolCallId: 'tool-2',
        status: 'running',
        args: '{"query":"orchid"}',
      });
    });

    expect(result.current.toolBlocks.map((block) => block.partialArgs)).toEqual([
      '{"path":"/a"}',
      '{"query":"orchid"}',
    ]);
    expect(result.current.toolBlocks[1]?.args).toBe('{"query":"orchid"}');
    expect(result.current.toolBlocks[1]?.status).toBe('running');
  });

  it('keeps buffered arguments when cancellation marks an active tool failed', async () => {
    const { result } = renderHook(() => useChat('session-1'));

    act(() => {
      onToolStart?.({
        ...eventIdentity(1),
        type: 'tool_call_start',
        toolCallId: 'tool-1',
        toolName: 'write',
      });
      onToolDelta?.({
        ...eventIdentity(2),
        type: 'tool_call_delta',
        toolCallId: 'tool-1',
        argsDelta: '{"path":"/cancelled"}',
      });
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.toolBlocks[0]).toMatchObject({
      partialArgs: '{"path":"/cancelled"}',
      status: 'failed',
    });
  });

  it('keeps first-Esc confirmation phase-only until cancellation actually begins', async () => {
    const { result } = renderHook(() => useChat('session-1'));
    act(() => {
      onToolStart?.({
        ...eventIdentity(1),
        type: 'tool_call_start',
        toolCallId: 'tool-1',
        toolName: 'write',
      });
    });

    cancelStatus = 'confirming';
    await act(async () => result.current.cancel());

    expect(result.current.interruptState).toBe('confirmAgent');
    expect(result.current.interrupted).toBe(false);
    expect(result.current.toolBlocks[0]?.status).toBe('generating');

    cancelStatus = 'cancelled';
    await act(async () => result.current.cancel());

    expect(result.current.interrupted).toBe(true);
    expect(result.current.toolBlocks[0]?.status).toBe('failed');
  });
});
