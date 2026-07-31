// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../../src/renderer/hooks/useChat';
import type { ChatChunkEvent, ChatErrorEvent, ChatSessionSnapshot } from '../../src/shared/types/ipc';

let onChunk: ((event: ChatChunkEvent) => void) | null = null;
let onError: ((event: ChatErrorEvent) => void) | null = null;

function chunk(sequence: number, data: string): ChatChunkEvent {
  return {
    sessionId: 'session-b',
    turnId: 'turn-b',
    sequence,
    type: 'chunk',
    segmentId: 'text-b',
    data,
  };
}

function liveSnapshot(): ChatSessionSnapshot {
  return {
    sessionId: 'session-b',
    messages: [],
    live: {
      sessionId: 'session-b',
      turnId: 'turn-b',
      sequence: 1,
      state: 'streaming',
      response: 'snapshot ',
      thinking: '',
      toolCalls: [],
      streamSegments: [{ kind: 'text', id: 'text-b', content: 'snapshot ' }],
      usage: null,
      error: null,
      interruptState: 'idle',
      cwd: '/workspace',
      startedAt: 1_700_000_000_000,
      interrupted: false,
    },
  };
}

beforeEach(() => {
  onChunk = null;
  onError = null;
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  window.orchid = {
    chat: {
      onChunk: vi.fn((callback: (event: ChatChunkEvent) => void) => {
        onChunk = callback;
        return () => {};
      }),
      onThinking: vi.fn(() => () => {}),
      onState: vi.fn(() => () => {}),
      onDone: vi.fn(() => () => {}),
      onError: vi.fn((callback: (event: ChatErrorEvent) => void) => {
        onError = callback;
        return () => {};
      }),
      onUsage: vi.fn(() => () => {}),
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

describe('useChat hydration replay', () => {
  it('seeds the live snapshot then replays only newer buffered target-turn events', () => {
    const { result } = renderHook(() => useChat('session-a'));

    act(() => {
      result.current.beginSessionSwitch('session-b');
      onChunk?.(chunk(1, 'stale'));
      onChunk?.(chunk(3, 'newer'));
      result.current.hydrateSnapshot(liveSnapshot());
    });

    expect(result.current.isSwitchingSession).toBe(false);
    expect(result.current.status).toBe('streaming');
    expect(result.current.streamingContent).toBe('snapshot newer');
    expect(result.current.streamSegments).toEqual([
      { kind: 'text', id: 'text-b', content: 'snapshot newer' },
    ]);
  });

  it('clears a displayed terminal error through the reducer action', () => {
    const { result } = renderHook(() => useChat('session-a'));

    act(() => {
      onError?.({
        sessionId: 'session-a',
        turnId: 'turn-a',
        sequence: 1,
        type: 'error',
        title: 'Authentication failed',
        error: 'bad token',
        kind: 'auth',
      });
    });
    expect(result.current.error).toBe('Authentication failed: bad token');

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
