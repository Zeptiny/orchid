import { describe, expect, it, vi } from 'vitest';

import { SubagentHydrationReadiness } from '../../src/main/tools/subagent/hydration-readiness';

describe('SubagentHydrationReadiness', () => {
  it('shares in-flight work and retains successful readiness', async () => {
    const readiness = new SubagentHydrationReadiness<number>();
    const owner = {};
    let resolve!: (value: number) => void;
    const hydrate = vi.fn(() => new Promise<number>((done) => {
      resolve = done;
    }));

    const first = readiness.ensure(owner, 'session-a', hydrate);
    const concurrent = readiness.ensure(owner, 'session-a', hydrate);

    expect(concurrent).toBe(first);
    expect(hydrate).toHaveBeenCalledTimes(1);

    resolve(42);
    await expect(first).resolves.toBe(42);

    const afterReady = readiness.ensure(owner, 'session-a', hydrate);
    expect(afterReady).toBe(first);
    await expect(afterReady).resolves.toBe(42);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('drops failed work so the next caller can retry', async () => {
    const readiness = new SubagentHydrationReadiness<number>();
    const owner = {};
    const failure = new Error('hydrate failed');
    const hydrate = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(7);

    await expect(readiness.ensure(owner, 'session-a', hydrate)).rejects.toBe(failure);
    await expect(readiness.ensure(owner, 'session-a', hydrate)).resolves.toBe(7);

    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('isolates readiness by manager and session', async () => {
    const readiness = new SubagentHydrationReadiness<number>();
    const firstOwner = {};
    const secondOwner = {};
    const hydrate = vi.fn(async () => hydrate.mock.calls.length);

    await readiness.ensure(firstOwner, 'session-a', hydrate);
    await readiness.ensure(firstOwner, 'session-b', hydrate);
    await readiness.ensure(secondOwner, 'session-a', hydrate);

    expect(hydrate).toHaveBeenCalledTimes(3);
  });
});
