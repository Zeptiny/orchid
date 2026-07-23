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
