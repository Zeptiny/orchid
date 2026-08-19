/**
 * Regression tests for the compaction live-stream emitter (#second compaction
 * stuck in 'generating').
 *
 * Two defects surfaced when a second compaction reused the same
 * `compaction-${sessionId}` toolCallId on one chain:
 *  1. a trailing throttled flush landed AFTER the mid-turn resume path marked
 *     the snapshot 'complete' (without deleting it) and flipped the widget back
 *     to 'generating' forever;
 *  2. ensureToolSnapshot pushed a duplicate tool stream segment once the first
 *     widget's tool call had been deleted but its segment remained.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveAgent } from '../../src/main/ipc/chat/state';
import type { ChatStreamSegmentSnapshot } from '../../src/shared/types/ipc';

const { activeAgents, sendTurnEvent } = vi.hoisted(() => ({
  activeAgents: new Map<string, unknown>(),
  sendTurnEvent: vi.fn(),
}));

vi.mock('../../src/main/ipc/chat/state', () => ({ activeAgents }));
vi.mock('../../src/main/ipc/chat/events', () => ({
  sendTurnEvent,
  webContentsForWindowId: vi.fn(() => ({})),
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

// Real snapshot helpers run against the mocked activeAgents map.
import {
  clearCompactionState,
  compactionWidgetToolId,
  createCompactionStreamEmitter,
  getCompactionTrigger,
} from '../../src/main/ipc/chat/compaction';
import { ensureToolSnapshot, updateToolSnapshot } from '../../src/main/ipc/chat/snapshot';

const SESSION_ID = 's1';

function makeActive(): ActiveAgent {
  return {
    sessionId: SESSION_ID,
    windowId: '944',
    finalized: false,
    toolCalls: new Map(),
    streamSegments: [] as ChatStreamSegmentSnapshot[],
  } as unknown as ActiveAgent;
}

function generatingPayload(toolCallId: string, content: string) {
  return expect.objectContaining({
    type: 'tool_call_update',
    toolCallId,
    toolName: 'compaction',
    status: 'generating',
    content,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  activeAgents.clear();
  sendTurnEvent.mockClear();
  try {
    clearCompactionState(SESSION_ID);
  } catch {
    // module state unavailable in isolated imports — ignore
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createCompactionStreamEmitter', () => {
  it('emits throttled generating updates with the accumulated text', () => {
    const TOOL_ID = compactionWidgetToolId(SESSION_ID);
    const active = makeActive();
    activeAgents.set(SESSION_ID, active);
    ensureToolSnapshot(active, TOOL_ID, 'compaction');
    updateToolSnapshot(active, TOOL_ID, 'compaction', { status: 'running', args: '{"phase":"summarizing"}' });

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('Sum');
    emit('Summary text');

    expect(sendTurnEvent).toHaveBeenCalledTimes(1);
    expect(sendTurnEvent).toHaveBeenCalledWith(
      expect.anything(),
      active,
      'chat:tool_call_update',
      generatingPayload(TOOL_ID, 'Sum'),
    );

    // Trailing flush carries the latest accumulated text.
    vi.advanceTimersByTime(150);
    expect(sendTurnEvent).toHaveBeenCalledTimes(2);
    expect(sendTurnEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      active,
      'chat:tool_call_update',
      generatingPayload(TOOL_ID, 'Summary text'),
    );
    expect(active.toolCalls.get(TOOL_ID)).toMatchObject({ status: 'generating', content: 'Summary text' });
  });

  it('includes the calibrated token estimate with each generating update', () => {
    const TOOL_ID = compactionWidgetToolId(SESSION_ID);
    const active = makeActive();
    activeAgents.set(SESSION_ID, active);
    ensureToolSnapshot(active, TOOL_ID, 'compaction');
    updateToolSnapshot(active, TOOL_ID, 'compaction', { status: 'running', args: '{"phase":"summarizing"}' });
    (getCompactionTrigger(SESSION_ID) as unknown as { state: Record<string, unknown> }).state.tokensPerChar = 0.25;

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('Sum'); // 3 chars × 0.25 = 0.75 → ceil 1
    expect(sendTurnEvent).toHaveBeenCalledWith(
      expect.anything(),
      active,
      'chat:tool_call_update',
      expect.objectContaining({ toolCallId: TOOL_ID, status: 'generating', estimatedTokens: 1 }),
    );
    expect(active.toolCalls.get(TOOL_ID)).toMatchObject({ estimatedTokens: 1 });

    // Without calibration the estimate is null — never a heuristic ratio.
    (getCompactionTrigger(SESSION_ID) as unknown as { state: Record<string, unknown> }).state.tokensPerChar = undefined;
    emit('Summary text');
    vi.advanceTimersByTime(150);
    expect(sendTurnEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      active,
      'chat:tool_call_update',
      expect.objectContaining({ toolCallId: TOOL_ID, status: 'generating', estimatedTokens: null }),
    );
  });

  it('never flips a completed widget back to generating (trailing flush after terminal)', () => {
    const TOOL_ID = compactionWidgetToolId(SESSION_ID);
    const active = makeActive();
    activeAgents.set(SESSION_ID, active);
    ensureToolSnapshot(active, TOOL_ID, 'compaction');
    updateToolSnapshot(active, TOOL_ID, 'compaction', { status: 'running', args: '{"phase":"summarizing"}' });

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('streamed so far'); // schedules a trailing flush

    // Mid-turn resume path completes the snapshot WITHOUT deleting it.
    updateToolSnapshot(active, TOOL_ID, 'compaction', {
      status: 'complete',
      args: '',
      content: 'Context compacted — resuming',
      finishedAt: new Date().toISOString(),
    });
    sendTurnEvent.mockClear();

    vi.advanceTimersByTime(150);
    expect(active.toolCalls.get(TOOL_ID)).toMatchObject({ status: 'complete' });
    expect(sendTurnEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      generatingPayload(TOOL_ID, expect.any(String)),
    );

    // Later deltas after completion are also ignored.
    emit('more text after completion');
    vi.advanceTimersByTime(150);
    expect(active.toolCalls.get(TOOL_ID)).toMatchObject({ status: 'complete' });
  });

  it('does not resurrect a deleted widget snapshot', () => {
    const TOOL_ID = compactionWidgetToolId(SESSION_ID);
    const active = makeActive();
    activeAgents.set(SESSION_ID, active);
    ensureToolSnapshot(active, TOOL_ID, 'compaction');
    updateToolSnapshot(active, TOOL_ID, 'compaction', { status: 'running', args: '{}' });

    const emit = createCompactionStreamEmitter(SESSION_ID);
    emit('partial');

    // completeCompactionWidget tears the entry down.
    active.toolCalls.delete(TOOL_ID);
    sendTurnEvent.mockClear();

    vi.advanceTimersByTime(150);
    expect(active.toolCalls.has(TOOL_ID)).toBe(false);
    expect(sendTurnEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      generatingPayload(TOOL_ID, expect.any(String)),
    );
  });

  it('binds to the widget id minted at emitter creation, not the current one', () => {
    const FIRST_ID = compactionWidgetToolId(SESSION_ID);
    const active = makeActive();
    activeAgents.set(SESSION_ID, active);
    ensureToolSnapshot(active, FIRST_ID, 'compaction');
    updateToolSnapshot(active, FIRST_ID, 'compaction', { status: 'running', args: '{}' });

    const emit = createCompactionStreamEmitter(SESSION_ID);
    active.toolCalls.delete(FIRST_ID); // first compaction completes + releases
    try {
      clearCompactionState(SESSION_ID);
    } catch {}

    const SECOND_ID = compactionWidgetToolId(SESSION_ID);
    expect(SECOND_ID).not.toBe(FIRST_ID);
    ensureToolSnapshot(active, SECOND_ID, 'compaction');
    updateToolSnapshot(active, SECOND_ID, 'compaction', { status: 'running', args: '{}' });

    // A trailing flush from the FIRST emitter must not touch the second widget.
    sendTurnEvent.mockClear();
    vi.advanceTimersByTime(150);
    expect(active.toolCalls.get(SECOND_ID)).toMatchObject({ status: 'running', content: null });
    expect(sendTurnEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      generatingPayload(SECOND_ID, expect.any(String)),
    );
  });

  it('ignores deltas for a session with no active agent', () => {
    const emit = createCompactionStreamEmitter('missing');
    emit('text');
    vi.advanceTimersByTime(150);
    expect(sendTurnEvent).not.toHaveBeenCalled();
  });
});

describe('ensureToolSnapshot segment dedupe', () => {
  it('does not push a second tool segment when the snapshot is re-created after teardown', () => {
    const TOOL_ID = compactionWidgetToolId(SESSION_ID);
    const active = makeActive();
    activeAgents.set(SESSION_ID, active);

    ensureToolSnapshot(active, TOOL_ID, 'compaction');
    expect(active.streamSegments).toEqual([{ kind: 'tool', toolCallId: TOOL_ID }]);

    // First compaction completes: entry deleted, segment remains.
    active.toolCalls.delete(TOOL_ID);

    // Second compaction on the same chain re-ensures the same toolCallId.
    const recreated = ensureToolSnapshot(active, TOOL_ID, 'compaction');
    expect(recreated.status).toBe('generating');
    expect(
      active.streamSegments.filter((s) => s.kind === 'tool' && s.toolCallId === TOOL_ID),
    ).toHaveLength(1);
  });
});

describe('compactionWidgetToolId', () => {
  it('mints one id per compaction, not per session', () => {
    const first = compactionWidgetToolId(SESSION_ID);
    expect(compactionWidgetToolId(SESSION_ID)).toBe(first);

    try {
      clearCompactionState(SESSION_ID);
    } catch {}
    const second = compactionWidgetToolId(SESSION_ID);
    expect(second).not.toBe(first);
    expect(second.startsWith(`compaction-${SESSION_ID}-`)).toBe(true);
  });
});
