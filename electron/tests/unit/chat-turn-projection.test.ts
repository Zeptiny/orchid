import { describe, expect, it } from 'vitest';
import {
  applyChatTurnEvent,
  applyChatTurnEvents,
  reduceChatTurnProjection,
  seedChatTurnProjection,
  type ChatTurnEventAction,
} from '../../src/shared/chat/turn-projection';
import type { ChatSnapshot } from '../../src/shared/types/ipc';
import type { Usage } from '../../src/shared/types/message';

const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const STARTED_AT = 1_700_000_000_000;
const TOOL_STARTED_AT = '2026-07-31T12:00:00.000Z';
const TOOL_FINISHED_AT = '2026-07-31T12:00:01.000Z';

function usage(inputTokens: number): Usage {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: 2,
    total_tokens: inputTokens + 2,
    cached_tokens: 0,
  };
}

function liveSnapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sequence: 0,
    state: 'streaming',
    response: '',
    thinking: '',
    toolCalls: [],
    streamSegments: [],
    usage: null,
    error: null,
    interruptState: 'idle',
    cwd: '/workspace',
    startedAt: STARTED_AT,
    interrupted: false,
    ...overrides,
  };
}

function event<T extends Omit<ChatTurnEventAction, 'occurredAt'>>(action: T, occurredAt: string): ChatTurnEventAction {
  return { ...action, occurredAt };
}

function identity(sequence: number) {
  return { sessionId: SESSION_ID, turnId: TURN_ID, sequence };
}

describe('ChatTurnProjection', () => {
  it('uses the same reducer vocabulary for a local send start and its first wire event', () => {
    const started = reduceChatTurnProjection(seedChatTurnProjection(liveSnapshot({ usage: usage(7) })), {
      type: 'begin',
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
    });
    const projected = reduceChatTurnProjection(started, {
      type: 'events',
      actions: [event({ ...identity(1), type: 'chunk', data: 'first', segmentId: 'text-1' }, TOOL_STARTED_AT)],
    });

    expect(projected).toMatchObject({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      status: 'streaming',
      response: 'first',
      sequence: 1,
    });
    expect(started?.usage).toBeNull();
  });

  it('seeds every live fact from an existing ChatSnapshot without materializing messages', () => {
    const snapshot = liveSnapshot({
      sequence: 41,
      state: 'error',
      response: 'partial',
      thinking: 'reasoning',
      streamSegments: [
        { kind: 'thinking', id: 'think-1', content: 'reasoning' },
        { kind: 'tool', toolCallId: 'tool-1' },
      ],
      toolCalls: [{
        toolCallId: 'tool-1',
        toolName: 'read',
        status: 'running',
        partialArgs: '{"path":',
        args: '',
        content: null,
        toolResult: null,
        startedAt: TOOL_STARTED_AT,
        finishedAt: null,
      }],
      usage: usage(7),
      error: 'temporary failure',
      interruptState: 'confirmAgent',
      cwd: null,
      startedAt: null,
      interrupted: true,
    });

    const { terminal, status, ...projection } = seedChatTurnProjection(snapshot);

    expect({ ...projection, state: status }).toEqual(snapshot);
    expect(terminal).toBeNull();
    expect('messages' in projection).toBe(false);
  });

  it('aggregates normal text and thinking into canonical chronological segments', () => {
    const initial = seedChatTurnProjection(liveSnapshot());
    const projected = applyChatTurnEvents(initial, [
      event({ ...identity(1), type: 'thinking', data: 'Consider ', segmentId: 'think-1' }, TOOL_STARTED_AT),
      event({ ...identity(2), type: 'thinking', data: 'the API.', segmentId: 'think-1' }, TOOL_STARTED_AT),
      event({ ...identity(3), type: 'chunk', data: 'Hello', segmentId: 'text-1' }, TOOL_STARTED_AT),
      event({ ...identity(4), type: 'chunk', data: ' world', segmentId: 'text-1' }, TOOL_STARTED_AT),
      event({ ...identity(5), type: 'state', state: 'streaming', error: null, interruptState: 'idle', cwd: '/next' }, TOOL_STARTED_AT),
    ]);

    expect(projected).toMatchObject({
      sequence: 5,
      status: 'streaming',
      response: 'Hello world',
      thinking: 'Consider the API.',
      cwd: '/next',
      streamSegments: [
        { kind: 'thinking', id: 'think-1', content: 'Consider the API.' },
        { kind: 'text', id: 'text-1', content: 'Hello world' },
      ],
    });
  });

  it('coalesces frame deltas without changing direct event-trace semantics', () => {
    const actions: ChatTurnEventAction[] = [
      event({ ...identity(1), type: 'chunk', data: 'Hello', segmentId: 'text-1' }, TOOL_STARTED_AT),
      event({ ...identity(2), type: 'chunk', data: ' world', segmentId: 'text-1' }, TOOL_FINISHED_AT),
      event({ ...identity(2), type: 'chunk', data: ' stale', segmentId: 'text-1' }, TOOL_FINISHED_AT),
      event({ ...identity(3), type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '{"path":' }, TOOL_STARTED_AT),
      event({ ...identity(4), type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '"a.ts"}' }, TOOL_FINISHED_AT),
    ];
    const initial = seedChatTurnProjection(liveSnapshot());
    const direct = actions.reduce(applyChatTurnEvent, initial);

    expect(applyChatTurnEvents(initial, actions)).toEqual(direct);
    expect(direct).toMatchObject({
      sequence: 4,
      response: 'Hello world',
      toolCalls: [{ partialArgs: '{"path":"a.ts"}', startedAt: TOOL_STARTED_AT }],
    });
  });

  it('keeps tool-heavy interleaving in one canonical timeline and accumulates arguments', () => {
    const projected = applyChatTurnEvents(seedChatTurnProjection(liveSnapshot()), [
      event({ ...identity(1), type: 'chunk', data: 'Before ', segmentId: 'text-1' }, TOOL_STARTED_AT),
      event({ ...identity(2), type: 'tool_call_start', toolCallId: 'tool-1', toolName: 'read' }, TOOL_STARTED_AT),
      event({ ...identity(3), type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '{"path":' }, TOOL_STARTED_AT),
      event({ ...identity(4), type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '"a.ts"}' }, TOOL_STARTED_AT),
      event({ ...identity(5), type: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', args: '{"path":"a.ts"}', content: '<ok/>', toolResult: { schemaVersion: 1, family: 'generic', status: 'complete', completeness: 'complete', data: { value: 'ok' } } }, TOOL_FINISHED_AT),
      event({ ...identity(6), type: 'chunk', data: 'after', segmentId: 'text-2' }, TOOL_FINISHED_AT),
    ]);

    expect(projected.streamSegments).toEqual([
      { kind: 'text', id: 'text-1', content: 'Before ' },
      { kind: 'tool', toolCallId: 'tool-1' },
      { kind: 'text', id: 'text-2', content: 'after' },
    ]);
    expect(projected.toolCalls).toEqual([expect.objectContaining({
      toolCallId: 'tool-1',
      toolName: 'read',
      status: 'completed',
      partialArgs: '{"path":"a.ts"}',
      args: '{"path":"a.ts"}',
      content: '<ok/>',
      startedAt: TOOL_STARTED_AT,
      finishedAt: TOOL_FINISHED_AT,
    })]);
  });

  it('upserts a tool timeline exactly once when delta and update arrive without start', () => {
    const projected = applyChatTurnEvents(seedChatTurnProjection(liveSnapshot()), [
      event({ ...identity(1), type: 'tool_call_delta', toolCallId: 'tool-missing-start', argsDelta: '{"q":' }, TOOL_STARTED_AT),
      event({ ...identity(2), type: 'tool_call_update', toolCallId: 'tool-missing-start', toolName: 'grep', status: 'running' }, TOOL_FINISHED_AT),
      event({ ...identity(3), type: 'tool_call_delta', toolCallId: 'tool-missing-start', argsDelta: '"orchid"}' }, TOOL_FINISHED_AT),
    ]);

    expect(projected.streamSegments).toEqual([{ kind: 'tool', toolCallId: 'tool-missing-start' }]);
    expect(projected.toolCalls).toEqual([expect.objectContaining({
      toolCallId: 'tool-missing-start',
      toolName: 'grep',
      status: 'running',
      partialArgs: '{"q":"orchid"}',
      args: '',
      startedAt: TOOL_STARTED_AT,
      finishedAt: null,
    })]);
  });

  it('preserves classified terminal error facts', () => {
    const projected = applyChatTurnEvent(
      seedChatTurnProjection(liveSnapshot()),
      event({ ...identity(1), type: 'error', error: 'bad token', title: 'Authentication failed', kind: 'auth' }, TOOL_FINISHED_AT),
    );

    expect(projected).toMatchObject({
      status: 'error',
      error: 'bad token',
      terminal: { type: 'error', error: 'bad token', title: 'Authentication failed', kind: 'auth' },
    });
  });

  it('clears an error terminal fact without disturbing completed terminals', () => {
    const errored = applyChatTurnEvent(
      seedChatTurnProjection(liveSnapshot()),
      event({ ...identity(1), type: 'error', error: 'bad token', title: 'Authentication failed' }, TOOL_FINISHED_AT),
    );
    const cleared = reduceChatTurnProjection(errored, { type: 'clear_error' });
    const done = applyChatTurnEvent(
      seedChatTurnProjection(liveSnapshot()),
      event({ ...identity(1), type: 'done', response: 'complete' }, TOOL_FINISHED_AT),
    );

    expect(cleared).toMatchObject({ error: null, terminal: null });
    expect(reduceChatTurnProjection(done, { type: 'clear_error' })?.terminal).toEqual(done.terminal);
  });

  it('keeps first-Esc confirmation phase-only but fails active tools on cancellation', () => {
    const running = applyChatTurnEvent(
      seedChatTurnProjection(liveSnapshot()),
      event({ ...identity(1), type: 'tool_call_start', toolCallId: 'tool-1', toolName: 'read' }, TOOL_STARTED_AT),
    );
    const confirming = reduceChatTurnProjection(running, {
      type: 'interrupt',
      interruptState: 'confirmAgent',
      occurredAt: TOOL_FINISHED_AT,
      interrupted: false,
      failActiveTools: false,
    });
    const cancelled = reduceChatTurnProjection(confirming, {
      type: 'interrupt',
      interruptState: 'idle',
      occurredAt: TOOL_FINISHED_AT,
      interrupted: true,
      failActiveTools: true,
    });

    expect(confirming).toMatchObject({ interrupted: false, interruptState: 'confirmAgent' });
    expect(confirming?.toolCalls[0]?.status).toBe('generating');
    expect(cancelled).toMatchObject({ interrupted: true, interruptState: 'idle' });
    expect(cancelled?.toolCalls[0]?.status).toBe('failed');
  });

  it('keeps a cancelled turn idle through the interrupted machine state and interrupt timeout', () => {
    const finalUsage = usage(12);
    const cancelled = applyChatTurnEvents(seedChatTurnProjection(liveSnapshot()), [
      event({ ...identity(1), type: 'usage', usage: finalUsage }, TOOL_STARTED_AT),
      event({ ...identity(2), type: 'done', response: 'partial answer', interrupted: true, usage: finalUsage }, TOOL_FINISHED_AT),
      event({ ...identity(3), type: 'state', state: 'idle', error: null, interruptState: 'confirmSubagents', cwd: '/workspace' }, TOOL_FINISHED_AT),
      event({ ...identity(4), type: 'state', state: 'interrupted', error: null, interruptState: 'confirmSubagents', cwd: '/workspace' }, TOOL_FINISHED_AT),
    ]);
    const afterTimeout = applyChatTurnEvent(
      cancelled,
      event({ ...identity(5), type: 'state', state: 'idle', error: null, interruptState: 'idle', cwd: '/workspace' }, TOOL_FINISHED_AT),
    );

    expect(cancelled).toMatchObject({
      status: 'idle',
      response: 'partial answer',
      usage: finalUsage,
      interrupted: true,
      interruptState: 'confirmSubagents',
      terminal: { type: 'done', response: 'partial answer', interrupted: true, usage: finalUsage },
    });
    expect(afterTimeout).toMatchObject({ status: 'idle', interruptState: 'idle' });
  });

  it('rejects wrong identity and stale or duplicate sequence without mutating the projection', () => {
    const first = applyChatTurnEvent(
      seedChatTurnProjection(liveSnapshot()),
      event({ ...identity(2), type: 'chunk', data: 'accepted', segmentId: 'text-1' }, TOOL_STARTED_AT),
    );

    expect(applyChatTurnEvent(first, event({ sessionId: 'other', turnId: TURN_ID, sequence: 3, type: 'chunk', data: 'wrong session', segmentId: 'text-1' }, TOOL_FINISHED_AT))).toBe(first);
    expect(applyChatTurnEvent(first, event({ sessionId: SESSION_ID, turnId: 'other-turn', sequence: 3, type: 'chunk', data: 'wrong turn', segmentId: 'text-1' }, TOOL_FINISHED_AT))).toBe(first);
    expect(applyChatTurnEvent(first, event({ ...identity(2), type: 'chunk', data: 'duplicate', segmentId: 'text-1' }, TOOL_FINISHED_AT))).toBe(first);
    expect(applyChatTurnEvent(first, event({ ...identity(1), type: 'chunk', data: 'stale', segmentId: 'text-1' }, TOOL_FINISHED_AT))).toBe(first);
  });

  it('matches a snapshot at N followed by newer events with the direct event trace', () => {
    const actions: ChatTurnEventAction[] = [
      event({ ...identity(1), type: 'thinking', data: 'plan', segmentId: 'think-1' }, TOOL_STARTED_AT),
      event({ ...identity(2), type: 'tool_call_start', toolCallId: 'tool-1', toolName: 'read' }, TOOL_STARTED_AT),
      event({ ...identity(3), type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '{"path":"a"}' }, TOOL_STARTED_AT),
      event({ ...identity(4), type: 'chunk', data: 'answer', segmentId: 'text-1' }, TOOL_FINISHED_AT),
      event({ ...identity(5), type: 'usage', usage: usage(8) }, TOOL_FINISHED_AT),
      event({ ...identity(6), type: 'done', response: 'answer', usage: usage(8) }, TOOL_FINISHED_AT),
    ];
    const direct = applyChatTurnEvents(seedChatTurnProjection(liveSnapshot()), actions);
    const atThree = applyChatTurnEvents(seedChatTurnProjection(liveSnapshot()), actions.slice(0, 3));
    const snapshotAtThree = liveSnapshot({
      sequence: atThree.sequence,
      state: atThree.status,
      response: atThree.response,
      thinking: atThree.thinking,
      toolCalls: atThree.toolCalls,
      streamSegments: atThree.streamSegments,
      usage: atThree.usage,
      error: atThree.error,
      interruptState: atThree.interruptState,
      cwd: atThree.cwd,
      startedAt: atThree.startedAt,
      interrupted: atThree.interrupted,
    });

    expect(applyChatTurnEvents(seedChatTurnProjection(snapshotAtThree), actions.slice(3))).toEqual(direct);
  });
});
