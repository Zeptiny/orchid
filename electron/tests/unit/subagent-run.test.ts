import { describe, expect, it } from 'vitest';
import { SubagentRunRegistry } from '../../src/main/agents/subagent-run';

describe('SubagentRunRegistry', () => {
  it('does not let a stale generation abort or settle a newer current run', async () => {
    const registry = new SubagentRunRegistry();
    registry.register('subagent-1');

    const first = registry.start('subagent-1');
    const firstPromise = new Promise<void>(() => {});
    registry.attachPromise(first, firstPromise);

    const second = registry.beginNext('subagent-1');
    registry.start('subagent-1');
    const secondPromise = new Promise<void>(() => {});
    registry.attachPromise(second, secondPromise);

    expect(second.generation).toBe(first.generation + 1);
    expect(registry.abort(first)).toBe(false);
    expect(registry.settle(first)).toBe(false);

    expect(registry.getGeneration('subagent-1')).toBe(second.generation);
    expect(registry.getPromise('subagent-1')).toBe(secondPromise);
    expect(second.abortController?.signal.aborted).toBe(false);

    expect(registry.settle(second)).toBe(true);
    expect(registry.getPromise('subagent-1')).toBeNull();
  });

  it('releases heavyweight execution affinity without invalidating a settling generation', () => {
    const registry = new SubagentRunRegistry();
    const runtime = { projectDir: '/tmp/project' } as never;
    registry.register('subagent-1', 1, {
      windowId: 'window-1', cwd: '/tmp/project', projectRuntime: runtime,
    });
    const run = registry.start('subagent-1');
    const promise = new Promise<void>(() => {});
    registry.attachPromise(run, promise);

    registry.releaseSeed('subagent-1');

    expect(registry.isCurrent(run)).toBe(true);
    expect(registry.getPromise('subagent-1')).toBe(promise);
    expect(registry.getSeed('subagent-1')).toEqual({ windowId: null, cwd: null });
  });

  it('reports settling only while a known run has an attached promise', () => {
    const registry = new SubagentRunRegistry();
    expect(registry.isSettling('unknown')).toBe(false);

    registry.register('subagent-1');
    const run = registry.start('subagent-1');
    registry.attachPromise(run, Promise.resolve());
    expect(registry.isSettling('subagent-1')).toBe(true);

    registry.settle(run);
    expect(registry.isSettling('subagent-1')).toBe(false);
  });
});
