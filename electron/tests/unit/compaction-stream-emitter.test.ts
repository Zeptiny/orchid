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

const { activeAgents, sessionsStarting, sendTurnEvent, sendSessionEvent, webContentsForWindowId, selectCutMock, compactableModelSliceMock, runCompactionAttemptMock } = vi.hoisted(() => ({
  activeAgents: new Map<string, unknown>(),
  sessionsStarting: new Set<string>(),
  sendTurnEvent: vi.fn(),
  sendSessionEvent: vi.fn(),
  webContentsForWindowId: vi.fn(() => ({})),
  selectCutMock: vi.fn(),
  compactableModelSliceMock: vi.fn(),
  runCompactionAttemptMock: vi.fn(),
}));

vi.mock('../../src/main/ipc/chat/state', () => ({ activeAgents, sessionsStarting }));
vi.mock('../../src/main/ipc/chat/events', () => ({
  sendTurnEvent,
  sendSessionEvent,
  webContentsForWindowId,
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
  clearCompactionPausesForSession: vi.fn(),
  shouldPauseForCompaction: vi.fn(() => false),
}));
vi.mock('../../src/main/ipc/session-activity', () => ({ publishSessionActivity: vi.fn() }));
vi.mock('../../src/main/llm/compaction/select', () => ({
  selectCut: selectCutMock,
  resolvePreservePercent: vi.fn(() => 0.25),
  resolveUserExemptIds: vi.fn(() => new Set()),
}));
vi.mock('../../src/main/llm/compaction/reclaim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/llm/compaction/reclaim')>();
  return {
    ...actual,
    mechanicalReclaim: vi.fn(() => ({ flaggedIds: [] })),
  };
});
vi.mock('../../src/main/llm/compaction/summarize', () => ({
  summarizeCompactableRange: vi.fn(),
  buildCompactionBridgeContext: vi.fn(() => null),
}));
vi.mock('../../src/main/llm/compaction/apply', () => ({
  buildCompactionApply: vi.fn(),
  buildSelectiveCompactionApply: vi.fn(() => null),
}));
vi.mock('../../src/main/llm/compaction/trigger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/llm/compaction/trigger')>();
  return {
    ...actual,
    CompactionTrigger: class CompactionTrigger {
      state: Record<string, unknown> = {};
      onUsage(): void {}
      onCompactionApplied(): void {
        this.state.hysteresisArmed = true;
      }
      onApplyFailed(): void {
        this.state.lastApplyFailureAt = Date.now();
      }
      inApplyBackoff(): boolean {
        const at = this.state.lastApplyFailureAt as number | undefined;
        return typeof at === 'number' && Date.now() - at < 30_000;
      }
      markPrepareStarted(): void {
        this.state.pendingPrepare = true;
      }
      abortPrepare(): void {
        this.state.pendingPrepare = false;
      }
    },
  };
});
vi.mock('../../src/main/llm/compaction/run-attempt', () => ({
  compactableModelSlice: compactableModelSliceMock,
  runCompactionAttempt: runCompactionAttemptMock,
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
  handleUsageCompaction,
} from '../../src/main/ipc/chat/compaction';
import { deleteCompactionPending } from '../../src/main/llm/compaction/pending-store';
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
  sessionsStarting.clear();
  sendTurnEvent.mockClear();
  sendSessionEvent.mockClear();
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

  it('emits through a synthetic idle identity when no active agent exists (manual /compact)', () => {
    emitCompactionProgress(SESSION_ID, 'preparing', 'Compacting context');
    emitCompactionProgress(SESSION_ID, 'compacting', 'Applying summary');
    emitCompactionProgress(SESSION_ID, 'complete');

    expect(sendTurnEvent).not.toHaveBeenCalled();
    expect(sendSessionEvent).toHaveBeenCalledTimes(3);
    const first = sendSessionEvent.mock.calls[0]!;
    const second = sendSessionEvent.mock.calls[1]!;
    const terminal = sendSessionEvent.mock.calls[2]!;
    for (const call of [first, second, terminal]) {
      expect(call[0]).toBeNull();
      expect(call[1]).toBe(SESSION_ID);
      expect(call[2]).toBe(IPC_CHANNELS.CHAT_COMPACTION_PROGRESS);
    }
    // One stable synthetic turnId with a monotonic sequence across the lifecycle.
    expect((first[3] as Record<string, unknown>).turnId).toBe((second[3] as Record<string, unknown>).turnId);
    expect((terminal[3] as Record<string, unknown>).turnId).toBe((first[3] as Record<string, unknown>).turnId);
    expect((first[3] as Record<string, unknown>).sequence).toBe(1);
    expect((second[3] as Record<string, unknown>).sequence).toBe(2);
    expect((terminal[3] as Record<string, unknown>).sequence).toBe(3);

    // Terminal drops the identity: the next idle compaction mints a fresh one.
    emitCompactionProgress(SESSION_ID, 'preparing');
    const afterTerminal = sendSessionEvent.mock.calls[3]!;
    expect((afterTerminal[3] as Record<string, unknown>).turnId).not.toBe((first[3] as Record<string, unknown>).turnId);
    expect((afterTerminal[3] as Record<string, unknown>).sequence).toBe(1);
  });

  it('stays silent without an active agent while a turn is starting (send-time sync compaction)', () => {
    sessionsStarting.add(SESSION_ID);
    emitCompactionProgress(SESSION_ID, 'preparing');
    emitCompactionProgress(SESSION_ID, 'complete');
    expect(sendTurnEvent).not.toHaveBeenCalled();
    expect(sendSessionEvent).not.toHaveBeenCalled();
  });

  it('no-ops for a finalized agent or a missing target window', () => {
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

    clearCompactionState(SESSION_ID);
    sendTurnEvent.mockClear();

    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalled();
  });

  it('delivers idle-session deltas through the synthetic identity (manual /compact widget)', () => {
    const emit = createCompactionStreamEmitter('missing');
    emit('text');
    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendTurnEvent).not.toHaveBeenCalled();
    expect(sendSessionEvent).toHaveBeenCalledTimes(1);
    expect(sendSessionEvent).toHaveBeenLastCalledWith(
      null,
      'missing',
      IPC_CHANNELS.CHAT_COMPACTION_PROGRESS,
      compactingPayload({ streamText: 'text', estimatedTokens: null }),
    );

    // Deltas stay silent while a turn is starting — the send-time sync
    // compaction window must not mint a synthetic turnId.
    sessionsStarting.add('missing');
    emit('more text');
    vi.advanceTimersByTime(COMPACTION_STREAM_EMIT_INTERVAL_MS + 1);
    expect(sendSessionEvent).toHaveBeenCalledTimes(1);
  });
});

describe('usage fire-point guards (review #53 — orphaned-run cascade)', () => {
  const CUT = {
    cutIndex: 2,
    compactableRange: { start: 0, end: 2 },
    preservedCount: 1,
    openGroupStart: null,
    preservedRange: { start: 2, end: 4 },
  };
  const history = [
    { id: 'm1', role: 'user', content: 'explore the compaction system and explain the details', type: 'text' },
    { id: 'm2', role: 'assistant', content: 'reading files and summarizing the implementation now', type: 'text' },
    { id: 'm3', role: 'assistant', content: 'more content after the cut window', type: 'text' },
    { id: 'm4', role: 'assistant', content: 'even more content', type: 'text' },
  ] as never[];
  const runtime = {
    config: {
      compaction: {
        main: {
          mode: 'selective',
          threshold: 0.5,
          hysteresis_delta: 0.1,
          preserve_percent: 0.25,
          min_compactable_tokens: 1,
          mechanical_reclaim: true,
          keep_last_user_messages: 10,
          pin_first_user_message: true,
        },
      },
    },
    projectDir: '',
  } as never;

  function fireUsage(inputTokens: number): void {
    handleUsageCompaction(SESSION_ID, history as never, inputTokens, 10_000, runtime, {} as never, {} as never, null, 'turn-1');
  }

  beforeEach(() => {
    selectCutMock.mockReset().mockReturnValue(CUT);
    compactableModelSliceMock.mockReset().mockReturnValue([history[0]]);
    runCompactionAttemptMock.mockReset();
  });

  it('suppresses re-prepare while a selective run is still in flight, then re-arms once it settles', async () => {
    let settleRun: (value: unknown) => void = () => undefined;
    let trackedRun: Promise<unknown> = Promise.resolve();
    runCompactionAttemptMock.mockImplementation(() => {
      let resolveRun!: (value: unknown) => void;
      const run = new Promise<unknown>((resolve) => { resolveRun = resolve; });
      trackedRun = run;
      settleRun = resolveRun;
      return run;
    });

    fireUsage(9_000); // over threshold → prepare starts the (mocked) selective run
    expect(runCompactionAttemptMock).toHaveBeenCalledTimes(1);

    // Simulate the apply consuming the pending and discarding it early — the
    // orphan cascade entry point. The next usage event must NOT start a new
    // compactor run while the old one is still streaming.
    deleteCompactionPending(SESSION_ID, null);
    fireUsage(9_500);
    expect(runCompactionAttemptMock).toHaveBeenCalledTimes(1);

    // Once the run settles, the guard releases and a new fire may prepare.
    // Awaiting the run itself is the deterministic release signal: the
    // guard's finally-cleanup was registered on this promise when the run
    // was tracked, so it has already run by the time this await resumes —
    // no fixed microtask-count hop.
    settleRun({ kind: 'noop', reason: 'empty-slice' });
    await trackedRun;
    fireUsage(9_600);
    expect(runCompactionAttemptMock).toHaveBeenCalledTimes(2);
  });

  it('suppresses re-prepare during the apply-failure backoff window', () => {
    getCompactionTrigger(SESSION_ID).onApplyFailed();
    runCompactionAttemptMock.mockImplementation(() => new Promise(() => undefined));

    fireUsage(9_000);
    expect(runCompactionAttemptMock).not.toHaveBeenCalled();
  });
});
