import { describe, expect, it, vi } from 'vitest';

import { QuestionStore } from '../../src/main/tools/ask-question/store';

const QUESTIONS = [{ type: 'single', title: 'Choose', options: [{ label: 'A' }] }];

describe('QuestionStore', () => {
  it('settles and removes a pending wait when its turn aborts', async () => {
    const store = new QuestionStore();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const settled = vi.fn();
    store.on('question-settled', settled);
    const pending = store.create('tool-1', 'session-1', QUESTIONS, controller.signal);
    store.bindOwnerWindow('tool-1', 'window-1');

    controller.abort();

    await expect(pending).resolves.toEqual({ type: 'cancelled' });
    expect(store.get('tool-1')).toBeUndefined();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(settled).toHaveBeenCalledWith({
      toolCallId: 'tool-1',
      sessionId: 'session-1',
      ownerWindowId: 'window-1',
      result: 'cancelled',
    });
  });

  it('cleanup settles the waiter instead of silently deleting it', async () => {
    const store = new QuestionStore();
    const settled = vi.fn();
    store.on('question-settled', settled);
    const pending = store.create('tool-2', 'session-1', QUESTIONS);

    expect(store.cleanup('tool-2')).toBe(true);

    await expect(pending).resolves.toEqual({ type: 'cancelled' });
    expect(store.cleanup('tool-2')).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('emits one owner-affine settlement for answer and explicit cancel', async () => {
    const store = new QuestionStore();
    const settled = vi.fn();
    store.on('question-settled', settled);
    const answered = store.create('tool-3', 'session-1', QUESTIONS);
    const cancelled = store.create('tool-4', 'session-1', QUESTIONS);
    store.bindOwnerWindow('tool-3', 'window-1');
    store.bindOwnerWindow('tool-4', 'window-1');

    expect(store.answer('tool-3', [{ selected: ['A'], text: null, skipped: false }]))
      .toBe(true);
    expect(store.cancel('tool-4')).toBe(true);

    await expect(answered).resolves.toMatchObject({ type: 'answered' });
    await expect(cancelled).resolves.toEqual({ type: 'cancelled' });
    expect(settled.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ toolCallId: 'tool-3', result: 'answered' }),
      expect.objectContaining({ toolCallId: 'tool-4', result: 'cancelled' }),
    ]);
    expect(store.cancel('tool-4')).toBe(false);
    expect(settled).toHaveBeenCalledTimes(2);
  });
});
