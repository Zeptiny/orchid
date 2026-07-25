import { describe, expect, it } from 'vitest';
import {
  acceptChatEvent,
  appendStreamSegmentDelta,
  appendStreamSegmentDeltas,
  beginCancelRequest,
  bindChatSession,
  chatToolSnapshotToBlock,
  commitSegmentsToMessages,
  consumePendingCancel,
  cumulativeUsageFromMessages,
  dropOptimisticUserMessageIfLast,
  drainBufferedHydrationEvents,
  residualStateAfterSendFailure,
  resetCancelQueue,
  resolveHydratedUsage,
  seedAffinityFromLive,
  shouldBufferChatEvent,
  type CancelQueueState,
  type ChatEventAffinity,
} from '../../src/renderer/hooks/useChat';
import {
  chatChunkEventSchema,
  chatThinkingEventSchema,
} from '../../src/shared/types/ipc-schemas';
import type { Message, Usage } from '../../src/shared/types/message';
import { MessageType } from '../../src/shared/types/message';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

function affinity(selectedSessionId: string | null): ChatEventAffinity {
  return { selectedSessionId, streamSessionId: selectedSessionId, streamTurnId: null, lastSequence: -1 };
}

function emptyCancelQueue(): CancelQueueState {
  return { inFlight: false, pending: false };
}

describe('useChat event affinity', () => {
  it('keeps canonical segment ids while accumulating live text and thinking', () => {
    const text = appendStreamSegmentDelta([], 'text', 'text-segment', 'Hello');
    const continued = appendStreamSegmentDelta(text, 'text', 'text-segment', ' world');
    const next = appendStreamSegmentDelta(continued, 'text', 'next-segment', '!');

    expect(continued).toEqual([
      { kind: 'text', id: 'text-segment', content: 'Hello world' },
    ]);
    expect(next).toEqual([
      { kind: 'text', id: 'text-segment', content: 'Hello world' },
      { kind: 'text', id: 'next-segment', content: '!' },
    ]);
  });

  it('applies a frame of stream deltas without mutating the previous segments', () => {
    const previous = [
      { kind: 'text' as const, id: 'text-segment', content: 'Hello' },
    ];

    const next = appendStreamSegmentDeltas(previous, [
      { kind: 'text', segmentId: 'text-segment', data: ' world' },
      { kind: 'text', segmentId: 'text-segment', data: '!' },
      { kind: 'thinking', segmentId: 'thinking-segment', data: 'Checking' },
      { kind: 'thinking', segmentId: 'thinking-segment', data: ' files' },
    ]);

    expect(previous).toEqual([
      { kind: 'text', id: 'text-segment', content: 'Hello' },
    ]);
    expect(next).toEqual([
      { kind: 'text', id: 'text-segment', content: 'Hello world!' },
      { kind: 'thinking', id: 'thinking-segment', content: 'Checking files' },
    ]);
  });

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

  it('keeps persisted usage when an idle live snapshot has no usage', () => {
    const persisted: Usage = {
      prompt_tokens: 900,
      completion_tokens: 100,
      total_tokens: 1_000,
      cached_tokens: 300,
      context: {
        input_tokens: 900,
        output_tokens: 100,
        used_tokens: 1_000,
        system_tokens: 100,
        tools_tokens: 200,
        tool_use_tokens: 300,
        user_tokens: 200,
        assistant_tokens: 200,
      },
    };
    const messages = [{ usage: persisted }] as Message[];
    const emptyLiveUsage: Usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
    };
    const liveUsage: Usage = { ...persisted, total_tokens: 1_100 };

    expect(resolveHydratedUsage(messages, null)).toBe(persisted);
    expect(resolveHydratedUsage(messages, emptyLiveUsage)).toBe(persisted);
    expect(resolveHydratedUsage(messages, liveUsage)).toBe(liveUsage);
  });

  it('includes authoritative in-flight usage in session totals', () => {
    const persisted: Usage = {
      prompt_tokens: 900,
      completion_tokens: 100,
      total_tokens: 1_000,
      cached_tokens: 300,
    };
    const live: Usage = {
      prompt_tokens: 180,
      completion_tokens: 30,
      total_tokens: 210,
      cached_tokens: 80,
    };

    expect(cumulativeUsageFromMessages(
      [{ usage: persisted }] as Message[],
      live,
    )).toEqual({
      prompt_tokens: 1_080,
      completion_tokens: 130,
      total_tokens: 1_210,
      cached_tokens: 380,
    });
  });

  it('keeps usage on a tool-only terminal turn', () => {
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

    const committed = commitSegmentsToMessages({
      segments: [{ kind: 'tool', toolCallId: 'tool-1' }],
      liveTools: [{
        id: 'tool-1',
        toolName: 'read',
        status: 'complete',
        partialArgs: '{}',
        args: '{}',
        agentProjection: 'done',
        toolResult,
        startedAt: '2026-07-19T00:00:00.000Z',
        finishedAt: '2026-07-19T00:00:01.000Z',
      }],
      fallbackResponse: '',
      interrupted: false,
      usage,
      thinking: null,
    });

    expect(committed.map((message) => message.type)).toEqual([
      MessageType.TOOL_CALL,
      MessageType.TOOL_RESULT,
      MessageType.TEXT,
    ]);
    expect(committed.at(-1)).toMatchObject({ content: '', usage, hidden: true });
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

  it('send failure residual state is identical for structured error and throw paths', () => {
    const residual = residualStateAfterSendFailure();
    expect(residual).toEqual({
      isSending: false,
      status: 'error',
      streamStartTime: null,
      streamingContent: '',
      streamingThinking: '',
      accumulatedContent: '',
      accumulatedThinking: '',
    });
    // Composer can send again once isSending is false and status is not streaming.
    expect(residual.isSending).toBe(false);
    expect(residual.status).not.toBe('streaming');
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
});
