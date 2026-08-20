/**
 * Tests for the typed compaction-progress event emitters (U2, review #37).
 *
 * The synthetic `'compaction'` tool-call channel is gone: progress now rides
 * `chat:compaction_progress` events keyed by agent scope. These tests pin the
 * event shape, the main-scope key, the throttle/trailing-flush behavior of
 * the live-stream emitter, and the epoch guard that keeps a trailing flush
 * from an already-finished compaction from flipping the widget back to a
 * running phase (the regression the old tool-id machinery guarded against).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveAgent } from '../../src/main/ipc/chat/state';
import type { ChatStreamSegmentSnapshot } from '../../src/shared/types/ipc';

const { activeAgents, sendTurnEvent, webContentsForWindowId } = vi.hoisted(() => ({
  activeAgents: new Map<string, unknown>(),
  sendTurnEvent: vi.fn(),
  webContentsForWindowId: vi.fn(() => ({})),
}));

vi.mock('../../src/main/ipc/chat/state', () => ({ activeAgents }));
vi.mock('../../src/main/ipc/chat/events', () => ({
  sendTurnEvent,
  webContentsForWindowId,
  sendSessionEvent: vi.fn(),
  buildSessionUpdatedEvent: vi.fn(),
  canSend: vi.fn(() => true),
}));
vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: vi.fn(() => ({ getSession: vi.fn(() => null) })),
}));
vi.mock('../../src/main/session/manager', () => ({ onSessionDeleted: vi.fn() }));
vi.mock('../../src/main/ipc/chat-history', () => ({ setChatHistory: vi.fn() }));
vi.mock('../../src/main/ipc/next-request-stop', () => ({
  requestCompactionPause: vi.fn(),
  clearCompactionPause: vi.fn(),
  shouldPauseForCompaction: vi.fn(() => false),
}));
vi.mock('../../src/main/ipc/session-activity', () => ({ publishSessionActivity: vi.fn() }));
vi.mock('../../src/main/llm/compaction/select', () => ({
  selectCut: vi.fn(),
  resolvePreservePercent: vi.fn(() => 0.25),
  resolveUserExemptIds: vi.fn(() => new Set()),
}));
vi.mock('../../src/main/llm/compaction/reclaim', () => ({
  mechanicalReclaim: vi.fn(() => ({ flaggedIds: [] })),
}));
vi.mock('../../src/main/llm/compaction/summarize', () => ({
  summarizeCompactableRange: vi.fn(),
}));
vi.mock('../../src/main/llm/compaction/apply', () => ({
  buildCompactionApply: vi.fn(),
  CompactionApplyError: class CompactionApplyError extends Error {},
}));
vi.mock('../../src/main/llm/compaction/trigger', () => ({
  CompactionTrigger: class CompactionTrigger { state: Record<string, unknown> = {}; },
}));
vi.mock('../../src/main/llm/compaction/run-attempt', () => ({
  compactableModelSlice: vi.fn(),
  filterUserFlaggedIds: vi.fn(),
  runCompactionAttempt: vi.fn(),
  unflagUserMessagesInApply: vi.fn(),
}));
vi.mock('../../src/main/ipc/chat/persist', () => ({
  persistCompactionBetweenTurns: vi.fn(),
  persistCompactionDurable: vi.fn(),
}));

import {
  clearCompactionState,
  COMPACTION_STREAM_EMIT_INTERVAL_MS,
  createCompactionStreamEmitter,
  emitCompactionProgress,
  getCompactionTrigger,
} from '../../src/main/ipc/chat/compaction';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const SESSION_ID = 's1';

function makeActive(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    sessionId: SESSION_ID,
    windowId: '944',
    finalized: false,
    toolCalls: new Map(),
    streamSegments: [] as ChatStreamSegmentSnapshot[],
    ...overrides,
  } as unknown as ActiveAgent;
}

function compactingPayload(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    type: 'compaction_progress',
    agentScopeId: 'main',
    phase: 'compacting',
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  activeAgents.clear();
  sendTurnEvent.mockClear();
  webContentsForWindowId.mockClear();
  webContentsForWindowId.mockReturnValue({});
  try {
    clearCompactionState(SESSION_ID);
  } catch {
    // module state unavailable in isolated imports — ignore
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('emitCompactionProgress', () => {
  it('emits a typed compaction-progress event keyed to the main scope', () => {
    activeAgents.set(SESSION_ID, makeActive());

    emitCompactionProgress(SESSION_ID, 'preparing', 'Summarizing history', { mode: 'simple' });
    emitCompactionProgress(SESSION_ID, 'compacting', 'Applying summary');
    emitCompactionProgress(SESSION_ID, 'complete', 'Context compacted — resuming');

    expect(sendTurnEvent).toHaveBeenCalledTimes(3);
    for (const call of sendTurnEvent.mock.calls) {
      expect(call[2]).toBe(IPC_CHANNELS.CHAT_COMPACTION_PROGRESS);
    }
    expect(sendTurnEvent).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      expect.objectContaining({
        type: 'compaction_progress',
        agentScopeId: 'main',
        phase: 'preparing',
        detail: 'Summarizing history',
        mode: 'simple',
      }),
    );
    expect(sendTurnEvent).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      expect.objectContaining({
        type: 'compaction_progress',
        agentScopeId: 'main',
        phase: 'complete',
      }),
    );
  });

  it('never carries synthetic tool-call fields — no toolCallId, no toolName', () => {
    activeAgents.set(SESSION_ID, makeActive());

    emitCompactionProgress(SESSION_ID, 'preparing');

    const payload = sendTurnEvent.mock.calls[0]![3] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('toolCallId');
    expect(payload).not.toHaveProperty('toolName');
    expect(payload).not.toHaveProperty('toolResult');
  });

  it('no-ops without an active agent, a finalized agent, or a target window', () => {
    emitCompactionProgress(SESSION_ID, 'preparing');
    expect(sendTurnEvent).not.toHaveBeenCalled();

    activeAgents.set(SESSION_ID, makeActive({ finalized: true }));
    emitCompactionProgress(SESSION_ID, 'preparing');
    expect(sendTurnEvent).not.toHaveBeenCalled();

    activeAgents.set(SESSION_ID, makeActive());
    webContentsForWindowId.mockReturnValue(null);
    emitCompactionProgress(SESSION_ID, 'preparing');
    expect(sendTurnEvent).not.toHaveBeenCalled();
  });

  it('delivers on the caller-supplied webContents when provided', () => {
    activeAgents.set(SESSION_ID, makeActive());
    const callerWebContents = { id: 4242 } as never;

    emitCompactionProgress(SESSION_ID, 'compacting', 'Applying summary', {
      webContents: callerWebContents,
    });

    expect(sendTurnEvent).toHaveBeenCalledTimes(1);
    expect(sendTurnEvent).toHaveBeenCalledWith(
      callerWebContents,
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      compactingPayload({ detail: 'Applying summary' }),
    );
    expect(webContentsForWindowId).not.toHaveBeenCalled();
  });
});

describe('createCompactionStreamEmitter', () => {
  it('emits throttled compacting events with the accumulated text', () => {
    activeAgents.set(SESSION_ID, makeActive());

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('Sum');
    emit('Summary text');

    expect(sendTurnEvent).toHaveBeenCalledTimes(1);
    expect(sendTurnEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      compactingPayload({ streamText: 'Sum', estimatedTokens: null }),
    );

    // Trailing flush carries the latest accumulated text.
    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).toHaveBeenCalledTimes(2);
    expect(sendTurnEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      compactingPayload({ streamText: 'Summary text', estimatedTokens: null }),
    );
  });

  it('includes the calibrated token estimate with each compacting event', () => {
    activeAgents.set(SESSION_ID, makeActive());
    (getCompactionTrigger(SESSION_ID) as unknown as { state: Record<string, unknown> }).state.tokensPerChar = 0.25;

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('Sum'); // 3 chars × 0.25 = 0.75 → ceil 1
    expect(sendTurnEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      compactingPayload({ estimatedTokens: 1 }),
    );

    // Without calibration the estimate is null — never a heuristic ratio.
    (getCompactionTrigger(SESSION_ID) as unknown as { state: Record<string, unknown> }).state.tokensPerChar = undefined;
    emit('Summary text');
    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      compactingPayload({ streamText: 'Summary text', estimatedTokens: null }),
    );
  });

  it('never flips a completed widget back to compacting (trailing flush after terminal)', () => {
    activeAgents.set(SESSION_ID, makeActive());

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('streamed so far'); // first emit flushes immediately
    emit('streamed so far, continued'); // schedules the pending trailing flush

    // The mid-turn resume path completes the widget.
    emitCompactionProgress(SESSION_ID, 'complete', 'Context compacted — resuming');
    sendTurnEvent.mockClear();

    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      compactingPayload({ streamText: expect.any(String) }),
    );

    // Later deltas after completion are also ignored.
    emit('more text after completion');
    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      compactingPayload({ streamText: expect.any(String) }),
    );
  });

  it('binds to the compaction epoch at emitter creation, not the current one', () => {
    activeAgents.set(SESSION_ID, makeActive());

    const firstEmit = createCompactionStreamEmitter(SESSION_ID);
    firstEmit('first compaction output'); // immediate flush
    firstEmit('first compaction output, continued'); // pending trailing flush
    emitCompactionProgress(SESSION_ID, 'complete'); // first compaction finishes

    // A second compaction on the same session mints a fresh emitter; the
    // first emitter's trailing flush must not touch the second widget.
    const secondEmit = createCompactionStreamEmitter(SESSION_ID);
    secondEmit('second compaction output');
    sendTurnEvent.mockClear();

    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      compactingPayload({ streamText: 'first compaction output, continued' }),
    );
  });

  it('goes silent once the session compaction state is cleared', () => {
    activeAgents.set(SESSION_ID, makeActive());

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('partial'); // immediate flush
    emit('partial, continued'); // pending trailing flush

    try {
      clearCompactionState(SESSION_ID);
    } catch {
      // module state unavailable in isolated imports — ignore
    }
    sendTurnEvent.mockClear();

    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalled();
  });

  it('ignores deltas for a session with no active agent', () => {
    const emit = createCompactionStreamEmitter('missing');
    emit('text');
    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalled();
  });
});
