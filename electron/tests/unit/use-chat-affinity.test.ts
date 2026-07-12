import { describe, expect, it } from 'vitest';
import { acceptChatEvent, type ChatEventAffinity } from '../../src/renderer/hooks/useChat';

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
});
