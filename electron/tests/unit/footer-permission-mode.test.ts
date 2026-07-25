import { describe, expect, it, vi } from 'vitest';

import { PermissionModeCoordinator } from '../../src/renderer/components/Footer';
import type { PermissionMode } from '../../src/shared/types/permission';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PermissionModeCoordinator', () => {
  it('hydrates distinct session modes and ignores the stale session response', async () => {
    const coordinator = new PermissionModeCoordinator();
    const first = deferred<{ ok: boolean; sessionId: string | null; mode: PermissionMode | null }>();
    const commits: Array<PermissionMode | null> = [];

    const sessionA = coordinator.hydrate('session-a', () => first.promise, (mode) => commits.push(mode));
    const sessionB = coordinator.hydrate(
      'session-b',
      async (message) => ({ ok: true, sessionId: message.expectedSessionId, mode: 'ask' }),
      (mode) => commits.push(mode),
    );
    await sessionB;
    first.resolve({ ok: true, sessionId: 'session-a', mode: 'allow' });
    await sessionA;

    expect(commits).toEqual([null, null, 'ask']);
  });

  it('commits reset only after a successful IPC response', async () => {
    const coordinator = new PermissionModeCoordinator();
    const commit = vi.fn<(mode: PermissionMode | null) => void>();
    const write = deferred<{ ok: boolean; sessionId: string | null }>();

    const reset = coordinator.update('session-a', null, () => write.promise, commit);
    expect(commit).not.toHaveBeenCalled();
    write.resolve({ ok: true, sessionId: 'session-a' });
    await reset;
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(null);
  });

  it('keeps the last confirmed mode when reset fails', async () => {
    const coordinator = new PermissionModeCoordinator();
    const commit = vi.fn<(mode: PermissionMode | null) => void>();

    await coordinator.update('session-a', null, async () => ({
      ok: false,
      sessionId: 'session-b',
    }), commit);
    await coordinator.update('session-a', null, async () => { throw new Error('IPC unavailable'); }, commit);

    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores an older write that resolves after a newer selection', async () => {
    const coordinator = new PermissionModeCoordinator();
    const first = deferred<{ ok: boolean; sessionId: string | null }>();
    const commits: Array<PermissionMode | null> = [];

    const allow = coordinator.update(
      'session-a',
      'allow',
      () => first.promise,
      (mode) => commits.push(mode),
    );
    await coordinator.update(
      'session-a',
      'ask',
      async () => ({ ok: true, sessionId: 'session-a' }),
      (mode) => commits.push(mode),
    );
    first.resolve({ ok: true, sessionId: 'session-a' });
    await allow;

    expect(commits).toEqual(['ask']);
  });

  it('does not hydrate an old displayed session after main has switched', async () => {
    const coordinator = new PermissionModeCoordinator();
    const commit = vi.fn<(mode: PermissionMode | null) => void>();
    const read = vi.fn(async () => ({
      ok: false,
      sessionId: 'session-b',
      mode: null,
    }));

    await coordinator.hydrate('session-a', read, commit);

    expect(read).toHaveBeenCalledWith({ expectedSessionId: 'session-a' });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(null);
  });

  it('does not commit a successful write response for a mismatched session', async () => {
    const coordinator = new PermissionModeCoordinator();
    const commit = vi.fn<(mode: PermissionMode | null) => void>();
    const write = vi.fn(async () => ({ ok: true, sessionId: 'session-b' }));

    await coordinator.update('session-a', 'allow', write, commit);

    expect(write).toHaveBeenCalledWith({
      mode: 'allow',
      expectedSessionId: 'session-a',
    });
    expect(commit).not.toHaveBeenCalled();
  });
});
