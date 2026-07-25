import { describe, expect, it, vi } from 'vitest';

import { ApprovalStore } from '../../src/main/permissions/approval-store';

describe('ApprovalStore cancellation', () => {
  it('settles an aborted approval as denied and removes its abort listener', async () => {
    const store = new ApprovalStore();
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = store.create(
      'tool-call',
      'session',
      'execute_command',
      'execution',
      { command: 'npm test' },
      '/tmp/project',
      undefined,
      controller.signal,
      'window-1',
    );

    controller.abort();

    await expect(pending).resolves.toEqual({
      decision: 'denied',
      reason: 'cancelled',
    });
    expect(store.get('tool-call')).toBeUndefined();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('fails closed without creating a pending entry when already aborted', async () => {
    const store = new ApprovalStore();
    const controller = new AbortController();
    controller.abort();

    await expect(store.create(
      'tool-call',
      'session',
      'execute_command',
      'execution',
      { command: 'npm test' },
      '/tmp/project',
      undefined,
      controller.signal,
      'window-1',
    )).resolves.toEqual({ decision: 'denied', reason: 'cancelled' });
    expect(store.get('tool-call')).toBeUndefined();
  });
});

describe('ApprovalStore timeout', () => {
  it('fails closed with approval-timeout when never answered', async () => {
    vi.useFakeTimers();
    try {
      const store = new ApprovalStore(20);
      const pending = store.create(
        'tool-call',
        'session',
        'execute_command',
        'execution',
        { command: 'npm test' },
        '/tmp/project',
        undefined,
        undefined,
        'window-1',
      );

      vi.advanceTimersByTime(20);

      await expect(pending).resolves.toEqual({
        decision: 'denied',
        reason: 'approval-timeout',
      });
      expect(store.get('tool-call')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves approved when answered before the timeout and does not double-settle', async () => {
    vi.useFakeTimers();
    try {
      const store = new ApprovalStore(50);
      const pending = store.create(
        'tool-call',
        'session',
        'execute_command',
        'execution',
        { command: 'npm test' },
        '/tmp/project',
        undefined,
        undefined,
        'window-1',
      );

      expect(store.answer('tool-call', 'approved')).toBe(true);
      await expect(pending).resolves.toEqual({ decision: 'approved' });

      const settled = vi.fn();
      store.on('approval-settled', settled);
      vi.advanceTimersByTime(100);

      expect(settled).not.toHaveBeenCalled();
      expect(store.get('tool-call')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout timer when cancelled so it never flips to approval-timeout', async () => {
    vi.useFakeTimers();
    try {
      const store = new ApprovalStore(30);
      const pending = store.create(
        'tool-call',
        'session',
        'execute_command',
        'execution',
        { command: 'npm test' },
        '/tmp/project',
        undefined,
        undefined,
        'window-1',
      );

      expect(store.cancel('tool-call')).toBe(true);
      await expect(pending).resolves.toEqual({
        decision: 'denied',
        reason: 'cancelled',
      });

      const settled = vi.fn();
      store.on('approval-settled', settled);
      vi.advanceTimersByTime(100);

      expect(settled).not.toHaveBeenCalled();
      expect(store.get('tool-call')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
