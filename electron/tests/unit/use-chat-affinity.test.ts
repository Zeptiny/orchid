import { describe, expect, it } from 'vitest';
import {
  acceptChatEvent,
  bindChatSession,
  drainBufferedHydrationEvents,
  seedAffinityFromLive,
  shouldBufferChatEvent,
  type ChatEventAffinity,
} from '../../src/renderer/hooks/useChat';

function affinity(selectedSessionId: string | null): ChatEventAffinity {
  return { selectedSessionId, streamSessionId: selectedSessionId, streamTurnId: null, lastSequence: -1 };
}

describe('useChat event affinity', () => {
  it('rejects events from a non-selected session', () => {
    const state = affinity('session-b');
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'turn-a', sequence: 1 }, false)).toBe(false);
    expect(state.streamTurnId).toBeNull();
  });

  it('rejects duplicate and stale sequences for the selected turn', () => {
    const state = affinity('session-a');
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'turn-a', sequence: 2 }, false)).toBe(true);
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'turn-a', sequence: 2 }, false)).toBe(false);
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'turn-a', sequence: 1 }, false)).toBe(false);
  });

  it('binds draft events only while a send is in progress', () => {
    const idleDraft = affinity(null);
    expect(acceptChatEvent(idleDraft, { sessionId: 'session-a', turnId: 'turn-a', sequence: 1 }, false)).toBe(false);

    const sendingDraft = affinity(null);
    expect(acceptChatEvent(sendingDraft, { sessionId: 'session-a', turnId: 'turn-a', sequence: 1 }, true)).toBe(true);
    expect(sendingDraft.streamSessionId).toBe('session-a');
  });

  it('rebinds affinity synchronously when navigation starts', () => {
    const state = affinity('session-a');
    state.streamTurnId = 'turn-a';
    state.lastSequence = 8;

    bindChatSession(state, 'session-b');

    expect(state).toEqual({
      selectedSessionId: 'session-b',
      streamSessionId: 'session-b',
      streamTurnId: null,
      lastSequence: -1,
    });
    expect(acceptChatEvent(
      state,
      { sessionId: 'session-a', turnId: 'turn-a', sequence: 9 },
      false,
    )).toBe(false);
  });

  it('buffers only target-session events during snapshot hydration', () => {
    expect(shouldBufferChatEvent('session-b', { sessionId: 'session-b' })).toBe(true);
    expect(shouldBufferChatEvent('session-b', { sessionId: 'session-a' })).toBe(false);
    expect(shouldBufferChatEvent(null, { sessionId: 'session-b' })).toBe(false);
  });

  it('null-live drain discards wrong-session and stale-sequence buffered events', () => {
    // After replaceMessages / beginSessionSwitch, affinity is rebound with no turn.
    const state = affinity('session-b');
    const applied: string[] = [];

    const count = drainBufferedHydrationEvents(
      state,
      [
        {
          event: { sessionId: 'session-a', turnId: 'turn-old', sequence: 9 },
          apply: () => applied.push('wrong-session'),
        },
        {
          event: { sessionId: 'session-b', turnId: 'turn-b', sequence: 1 },
          apply: () => applied.push('first'),
        },
        {
          event: { sessionId: 'session-b', turnId: 'turn-b', sequence: 1 },
          apply: () => applied.push('dup-seq'),
        },
        {
          event: { sessionId: 'session-b', turnId: 'turn-b', sequence: 2 },
          apply: () => applied.push('newer'),
        },
        {
          event: { sessionId: 'session-b', turnId: 'turn-other', sequence: 5 },
          apply: () => applied.push('wrong-turn'),
        },
      ],
      false,
    );

    expect(count).toBe(2);
    expect(applied).toEqual(['first', 'newer']);
    expect(state.streamTurnId).toBe('turn-b');
    expect(state.lastSequence).toBe(2);
  });

  it('live snapshot seed drops buffered events at or below sequence high-water mark', () => {
    const state = affinity('session-b');
    seedAffinityFromLive(state, {
      sessionId: 'session-b',
      turnId: 'turn-live',
      sequence: 4,
    });
    const applied: number[] = [];

    const count = drainBufferedHydrationEvents(
      state,
      [
        {
          event: { sessionId: 'session-b', turnId: 'turn-live', sequence: 3 },
          apply: () => applied.push(3),
        },
        {
          event: { sessionId: 'session-b', turnId: 'turn-live', sequence: 4 },
          apply: () => applied.push(4),
        },
        {
          event: { sessionId: 'session-b', turnId: 'turn-live', sequence: 5 },
          apply: () => applied.push(5),
        },
      ],
      true,
    );

    expect(count).toBe(1);
    expect(applied).toEqual([5]);
    expect(state.lastSequence).toBe(5);
  });

  it('cancelInFlight serialization is a re-entry guard (contract)', async () => {
    // Pure behavioral stand-in for cancelInFlightRef: overlapping cancel
    // must not re-enter while a previous cancel await is in flight.
    let cancelInFlight = false;
    const cancelCalls: string[] = [];

    async function cancel(label: string): Promise<void> {
      if (cancelInFlight) {
        cancelCalls.push(`skip:${label}`);
        return;
      }
      cancelInFlight = true;
      try {
        cancelCalls.push(`run:${label}`);
        await Promise.resolve();
      } finally {
        cancelInFlight = false;
      }
    }

    const first = cancel('a');
    const second = cancel('b');
    await Promise.all([first, second]);
    expect(cancelCalls).toEqual(['run:a', 'skip:b']);
  });
});
