import { describe, expect, it } from 'vitest';
import {
  acceptChatEvent,
  beginCancelRequest,
  bindChatSession,
  chatToolSnapshotToBlock,
  consumePendingCancel,
  dropOptimisticUserMessageIfLast,
  mergeTerminalTurnMessages,
  resetCancelQueue,
  shouldBufferChatEvent,
  type CancelQueueState,
  type ChatEventAffinity,
} from '../../src/renderer/hooks/useChat';
import {
  chatChunkEventSchema,
  chatDoneEventSchema,
  chatThinkingEventSchema,
} from '../../src/shared/types/ipc-schemas';
import type { Message, Usage } from '../../src/shared/types/message';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

function affinity(selectedSessionId: string | null): ChatEventAffinity {
  return { selectedSessionId, streamSessionId: selectedSessionId, streamTurnId: null, lastSequence: -1 };
}

function emptyCancelQueue(): CancelQueueState {
  return { inFlight: false, pending: false };
}

describe('useChat event affinity', () => {
  it('preserves canonical segment ids at the preload validation boundary', () => {
    const identity = { sessionId: 'session-1', turnId: 'turn-1', sequence: 1 };

    expect(chatChunkEventSchema.parse({
      ...identity,
      type: 'chunk',
      data: 'answer',
      segmentId: 'text-segment',
    }).segmentId).toBe('text-segment');
    expect(chatThinkingEventSchema.parse({
      ...identity,
      type: 'thinking',
      data: 'reasoning',
      segmentId: 'thinking-segment',
    }).segmentId).toBe('thinking-segment');
  });

  it('retains canonical facts while reconstructing a hydrated tool block', () => {
    const canonical = createCanonicalToolResult('generic', {
      status: 'cancelled',
      data: { value: 'same projection' },
    });
    const block = chatToolSnapshotToBlock({
      toolCallId: 'tool-1',
      toolName: 'read',
      status: 'cancelled',
      partialArgs: '{}',
      args: '{}',
      content: 'same projection',
      toolResult: canonical,
      startedAt: '2026-07-18T00:00:00.000Z',
      finishedAt: '2026-07-18T00:00:01.000Z',
    });

    expect(block.toolResult).toEqual(canonical);
    expect(block.agentProjection).toBe('same projection');
  });

  it('accepts a canonical tool-only durable terminal history', () => {
    const usage: Usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cached_tokens: 10,
    };
    const toolResult = createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: 'done' },
    });

    const messages: Message[] = [{
      id: 'tool-only-usage',
      role: 'assistant',
      content: '',
      type: 'text',
      tool_calls: null,
      tool_call_id: null,
      name: null,
      thinking: null,
      timestamp: '2026-07-19T00:00:00.000Z',
      usage,
      hidden: true,
      tool_result: null,
    }, {
      id: 'tool-result',
      role: 'tool',
      content: 'done',
      type: 'tool_result',
      tool_calls: null,
      tool_call_id: 'tool-1',
      name: 'read',
      thinking: null,
      timestamp: '2026-07-19T00:00:01.000Z',
      usage: null,
      hidden: false,
      tool_result: toolResult,
    }];

    expect(chatDoneEventSchema.parse({
      sessionId: 'session-1',
      turnId: 'turn-1',
      sequence: 1,
      type: 'done',
      response: '',
      messages,
    }).messages).toEqual(messages);
  });

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

  it('rejects a foreign turnId without the idle-rebind flag (default event policy)', () => {
    const state = affinity('session-a');
    state.streamTurnId = 'turn-a';
    state.lastSequence = 5;
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'manual-1', sequence: 1 }, false)).toBe(false);
  });

  it('rebinds to a manual compaction turnId when idle, with a fresh sequence watermark', () => {
    const state = affinity('session-a');
    state.streamTurnId = 'turn-a';
    state.lastSequence = 50;

    // Idle: the manual /compact synthetic turn rebinds even at a lower sequence.
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'manual-1', sequence: 1 }, false, true)).toBe(true);
    expect(state.streamTurnId).toBe('manual-1');
    expect(state.lastSequence).toBe(1);
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'manual-1', sequence: 2 }, false, true)).toBe(true);
    expect(acceptChatEvent(state, { sessionId: 'session-a', turnId: 'manual-1', sequence: 2 }, false, true)).toBe(false);

    // While streaming, the mismatched turnId stays foreign even with the flag.
    const streaming = affinity('session-a');
    streaming.streamTurnId = 'turn-live';
    streaming.lastSequence = 3;
    expect(acceptChatEvent(streaming, { sessionId: 'session-a', turnId: 'manual-1', sequence: 1 }, true, true)).toBe(false);
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

  it('cancel queue serializes IPC and stages a second Esc for the next phase', async () => {
    const state = emptyCancelQueue();
    const phases: string[] = [];
    const phaseResults = ['confirming', 'confirming_subagents'];

    async function cancel(): Promise<void> {
      if (beginCancelRequest(state) === 'queued') return;
      try {
        while (true) {
          const result = phaseResults[phases.length] ?? 'cancelled';
          phases.push(result);
          await Promise.resolve();
          if (!consumePendingCancel(state)) break;
        }
      } catch {
        resetCancelQueue(state);
      }
    }

    const first = cancel();
    // Second Esc arrives while first cancel IPC is still awaiting RTT.
    const second = cancel();
    await Promise.all([first, second]);

    expect(phases).toEqual(['confirming', 'confirming_subagents']);
    expect(state).toEqual({ inFlight: false, pending: false });
  });

  it('cancel queue coalesces multiple Esc presses into one staged follow-up', async () => {
    const state = emptyCancelQueue();
    let ipcCount = 0;

    async function cancel(): Promise<void> {
      if (beginCancelRequest(state) === 'queued') return;
      try {
        while (true) {
          ipcCount += 1;
          await Promise.resolve();
          if (!consumePendingCancel(state)) break;
        }
      } catch {
        resetCancelQueue(state);
      }
    }

    const first = cancel();
    void cancel(); // stage
    void cancel(); // coalesce into same pending flag
    void cancel(); // still one pending
    await first;

    // First run + one drained pending — not four concurrent IPCs.
    expect(ipcCount).toBe(2);
    expect(state).toEqual({ inFlight: false, pending: false });
  });

  it('beginCancelRequest refuses concurrent IPC without dropping a staged Esc', () => {
    const state = emptyCancelQueue();
    expect(beginCancelRequest(state)).toBe('run');
    expect(state).toEqual({ inFlight: true, pending: false });
    expect(beginCancelRequest(state)).toBe('queued');
    expect(state).toEqual({ inFlight: true, pending: true });
    expect(beginCancelRequest(state)).toBe('queued');
    expect(state).toEqual({ inFlight: true, pending: true });
  });

  it('dropOptimisticUserMessageIfLast only removes the trailing optimistic bubble', () => {
    const prior = { id: 'prior' };
    const optimistic = { id: 'opt' };
    expect(dropOptimisticUserMessageIfLast([prior, optimistic], 'opt')).toEqual([prior]);
    expect(dropOptimisticUserMessageIfLast([prior, optimistic], 'missing')).toEqual([
      prior,
      optimistic,
    ]);
    expect(dropOptimisticUserMessageIfLast([prior], 'opt')).toEqual([prior]);
    expect(dropOptimisticUserMessageIfLast([], 'opt')).toEqual([]);
  });

  it('merges a terminal turn without replacing bounded prior history', () => {
    const current = [
      { id: 'bounded-old', role: 'assistant', content: 'Loaded tail' },
      { id: 'optimistic-user', role: 'user', content: 'Current request' },
    ] as Message[];
    const terminal = [
      { id: 'durable-user', role: 'user', content: 'Current request' },
      { id: 'durable-answer', role: 'assistant', content: 'Current answer' },
    ] as Message[];

    expect(mergeTerminalTurnMessages(current, terminal).map((message) => message.id))
      .toEqual(['bounded-old', 'durable-user', 'durable-answer']);
  });
});
