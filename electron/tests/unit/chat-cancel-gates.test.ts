/**
 * Esc interrupt gates (issue #145).
 *
 * Behavioral coverage for the cancel-serialization primitives and the global
 * Escape ownership resolver: the subagent-cancel confirmation is the
 * destructive terminal layer and must always require a deliberate fresh
 * keypress, and Esc must reach chat cancellation while the session owns
 * running subagents even without a live main-agent turn.
 */
import { describe, expect, it } from 'vitest';
import {
  beginCancelRequest,
  consumePendingCancel,
  discardPendingCancel,
  resetCancelQueue,
  type CancelQueueState,
} from '../../src/renderer/hooks/useChat';
import { resolveInputEscapeAction } from '../../src/renderer/components/InputArea';

function freshQueue(): CancelQueueState {
  return { inFlight: false, pending: false };
}

describe('cancel queue hardening', () => {
  it('drains a staged Esc after a non-terminal cancel phase', () => {
    const state = freshQueue();
    expect(beginCancelRequest(state)).toBe('run');
    // Esc pressed while the first IPC is in flight.
    expect(beginCancelRequest(state)).toBe('queued');
    // 'confirming' (layer 1) is not destructive: the staged Esc advances.
    expect(consumePendingCancel(state)).toBe(true);
    expect(state.inFlight).toBe(true);

    // No further staged press: the mutex releases.
    expect(consumePendingCancel(state)).toBe(false);
    expect(state.inFlight).toBe(false);
  });

  it('discards staged Esc presses once the subagent-cancel phase is reached', () => {
    const state = freshQueue();
    beginCancelRequest(state);
    beginCancelRequest(state); // staged during the layer-1 RTT

    // 'confirming_subagents' is the destructive terminal layer: staged
    // presses are dropped so layer 3 needs a fresh keypress.
    discardPendingCancel(state);
    expect(state).toEqual({ inFlight: false, pending: false });

    // A deliberate new Esc starts a fresh cancel IPC.
    expect(beginCancelRequest(state)).toBe('run');
  });

  it('resetCancelQueue releases everything', () => {
    const state = freshQueue();
    beginCancelRequest(state);
    beginCancelRequest(state);
    resetCancelQueue(state);
    expect(state).toEqual({ inFlight: false, pending: false });
  });
});

describe('resolveInputEscapeAction with running subagents', () => {
  const base = {
    hasActiveQuestion: false,
    isSlashMode: false,
    isViewActive: false,
    settingsOpen: false,
  };

  it('allows Esc to cancel while subagents run without a live main turn', () => {
    expect(resolveInputEscapeAction({
      ...base,
      canInterrupt: false,
      hasRunningSubagents: true,
    })).toBe('cancel-chat');
  });

  it('keeps the original gates when no subagents run', () => {
    expect(resolveInputEscapeAction({
      ...base,
      canInterrupt: false,
      hasRunningSubagents: false,
    })).toBe('none');
    expect(resolveInputEscapeAction({
      ...base,
      canInterrupt: true,
      hasRunningSubagents: false,
    })).toBe('cancel-chat');
  });

  it('still yields to questions, slash mode, inactive views, and settings', () => {
    expect(resolveInputEscapeAction({
      ...base,
      hasActiveQuestion: true,
      canInterrupt: false,
      hasRunningSubagents: true,
    })).toBe('cancel-question');
    expect(resolveInputEscapeAction({
      ...base,
      isSlashMode: true,
      canInterrupt: true,
      hasRunningSubagents: true,
    })).toBe('none');
    expect(resolveInputEscapeAction({
      ...base,
      isViewActive: true,
      canInterrupt: true,
      hasRunningSubagents: true,
    })).toBe('none');
    expect(resolveInputEscapeAction({
      ...base,
      settingsOpen: true,
      canInterrupt: true,
      hasRunningSubagents: true,
    })).toBe('none');
  });
});
