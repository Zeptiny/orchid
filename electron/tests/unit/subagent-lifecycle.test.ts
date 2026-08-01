import { describe, expect, it, vi } from 'vitest';
import { SubagentLifecycle } from '../../src/main/agents/subagent-lifecycle';
import { SubagentState } from '../../src/main/agents/types';

function record(overrides: Partial<{
  state: SubagentState;
  result: string | null;
  error: string | null;
  startTime: number;
  queuedAt: number | null;
  startedAt: number | null;
  endTime: number | null;
  usage: unknown | null;
  closed: boolean;
}> = {}) {
  return {
    state: SubagentState.PENDING,
    result: null,
    error: null,
    startTime: 1,
    queuedAt: null,
    startedAt: null,
    endTime: null,
    usage: null,
    closed: false,
    ...overrides,
  };
}

describe('SubagentLifecycle', () => {
  it('applies valid transitions and leaves invalid transitions untouched', () => {
    const lifecycle = new SubagentLifecycle();
    const item = record({ state: SubagentState.QUEUED, queuedAt: 2 });

    expect(lifecycle.transition(item, { type: 'running', now: 3 })).toBeNull();
    expect(item.state).toBe(SubagentState.QUEUED);
    expect(lifecycle.transition(item, { type: 'admit' })).not.toBeNull();
    expect(item.state).toBe(SubagentState.PENDING);
    expect(item.queuedAt).toBe(2);
    expect(lifecycle.transition(item, { type: 'running', now: 4 })).not.toBeNull();
    expect(item.state).toBe(SubagentState.RUNNING);
    expect(item.startedAt).toBe(4);
    const completed = lifecycle.transition(item, { type: 'complete', result: 'done', now: 5 });
    expect(completed).toMatchObject({
      persist: true, resolveWaiters: true, removeFromAdmissionQueue: true,
      admitNext: true, finishProjection: true,
    });
    expect(item).toMatchObject({ state: SubagentState.COMPLETED, result: 'done', endTime: 5 });
    expect(lifecycle.transition(item, { type: 'fail', error: 'late', now: 6 })).toBeNull();
  });

  it('resets only a terminal, open record for a follow-up run', () => {
    const lifecycle = new SubagentLifecycle();
    const item = record({
      state: SubagentState.FAILED,
      result: 'old',
      error: 'failure',
      endTime: 10,
      startedAt: 2,
      usage: { totalTokens: 3 },
    });

    expect(lifecycle.transition(item, { type: 'follow-up', admitted: false, now: 20 }))
      .not.toBeNull();
    expect(item.state).toBe(SubagentState.QUEUED);
    expect(item).toMatchObject({
      result: null,
      error: null,
      endTime: null,
      startedAt: null,
      startTime: 20,
      queuedAt: 20,
      usage: null,
    });
    item.closed = true;
    item.state = SubagentState.COMPLETED;
    expect(lifecycle.transition(item, { type: 'follow-up', admitted: true, now: 21 })).toBeNull();
  });

  it('cleans only its own waiters and flushes each registered callback once', () => {
    const lifecycle = new SubagentLifecycle();
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = lifecycle.addWaiter('one', first);
    lifecycle.addWaiter('one', second);
    lifecycle.addWaiter('two', first);

    removeFirst();
    expect(lifecycle.resolveWaiters('one', 'flush')).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('flush');
    expect(lifecycle.resolveWaiters('one')).toBe(false);
    expect(lifecycle.resolveWaiters('two')).toBe(true);
    expect(first).toHaveBeenCalledWith('state-change');
  });

  it('answers, cancels, and clears question resolvers without retaining them', async () => {
    const lifecycle = new SubagentLifecycle();
    const asked = lifecycle.askQuestion('one', {
      toolCallId: 'call-1',
      questions: [{ type: 'single', title: 'Continue?', options: [{ label: 'yes' }] }],
    });
    expect(lifecycle.getPendingQuestion('one')?.toolCallId).toBe('call-1');
    expect(lifecycle.answerQuestion('one', 'wrong', { type: 'declined' })).toBe(false);
    expect(lifecycle.answerQuestion('one', 'call-1', { type: 'declined' })).toBe(true);
    await expect(asked).resolves.toEqual({ type: 'declined' });
    expect(lifecycle.getPendingQuestion('one')).toBeUndefined();

    const pending = lifecycle.askQuestion('one', {
      toolCallId: 'call-2', questions: [],
    });
    lifecycle.clear('one');
    await expect(pending).resolves.toEqual({ type: 'declined' });
  });
});
