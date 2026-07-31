// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../../src/renderer/hooks/useChat';
import type { ChatChunkEvent, ChatUsageEvent } from '../../src/shared/types/ipc';

let onChunk: ((event: ChatChunkEvent) => void) | null = null;
let onUsage: ((event: ChatUsageEvent) => void) | null = null;
let frameCallback: FrameRequestCallback | null = null;

beforeEach(() => {
  onChunk = null;
  onUsage = null;
  frameCallback = null;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frameCallback = callback;
    return 1;
  }));
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
      onError: vi.fn(() => () => {}),
      onUsage: vi.fn((callback: (event: ChatUsageEvent) => void) => {
        onUsage = callback;
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
  vi.unstubAllGlobals();
});

describe('useChat stream ordering', () => {
  it('flushes a buffered chunk before a later usage event advances the sequence', () => {
    const { result } = renderHook(() => useChat('session-1'));
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cached_tokens: 0,
    };

    act(() => {
      onChunk?.({
        sessionId: 'session-1',
        turnId: 'turn-1',
        sequence: 1,
        type: 'chunk',
        segmentId: 'text-1',
        data: 'buffered answer',
      });
      onUsage?.({
        sessionId: 'session-1',
        turnId: 'turn-1',
        sequence: 2,
        type: 'usage',
        usage,
      });
    });

    // The usage callback arrives before the queued animation-frame callback.
    expect(frameCallback).not.toBeNull();
    expect(result.current.streamingContent).toBe('buffered answer');
    expect(result.current.usage).toEqual(usage);
  });
});
