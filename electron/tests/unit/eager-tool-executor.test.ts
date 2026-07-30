/**
 * Eager tool execution coordinator tests (U1).
 *
 * Covers the pure coordination logic: launcher registration, single memoized
 * execution per toolCallId regardless of whether `start` (stream loop) or
 * `getOrStart` (execute shim) runs first, undefined for unregistered tools,
 * synchronous-failure capture, and per-tool isolation. The coordinator never
 * inspects the result value, so a sentinel stands in for a ToolExecutionResult.
 */
import { describe, expect, it, vi } from 'vitest';

import { EagerToolExecutor } from '../../src/main/llm/eager-tool-executor';
import type { ToolExecutionResult } from '../../src/shared/types/tool-result';

const sentinel = { canonical: { status: 'success' } } as unknown as ToolExecutionResult;

function deferred(): {
  promise: Promise<ToolExecutionResult>;
  resolve: (value: ToolExecutionResult) => void;
} {
  let resolve!: (value: ToolExecutionResult) => void;
  const promise = new Promise<ToolExecutionResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('EagerToolExecutor', () => {
  it('getOrStart creates the execution on first call and memoizes it', () => {
    const executor = new EagerToolExecutor();
    const launcher = vi.fn().mockResolvedValue(sentinel);
    executor.registerLauncher('read', launcher);

    const first = executor.getOrStart('call-1', 'read', { file_path: 'a.ts' });
    const second = executor.getOrStart('call-1', 'read', { file_path: 'a.ts' });

    expect(launcher).toHaveBeenCalledOnce();
    expect(launcher).toHaveBeenCalledWith('call-1', { file_path: 'a.ts' });
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);
  });

  it('getOrStart returns undefined and stores nothing when no launcher is registered', () => {
    const executor = new EagerToolExecutor();
    expect(executor.getOrStart('call-1', 'unregistered', {})).toBeUndefined();
    // A later launcher registration does not retroactively pick up the old id.
    executor.registerLauncher('unregistered', vi.fn().mockResolvedValue(sentinel));
    expect(executor.getOrStart('call-1', 'unregistered', {})).toBeInstanceOf(Promise);
  });

  it('start() and getOrStart() share one execution (stream-loop first)', async () => {
    const executor = new EagerToolExecutor();
    const { promise, resolve } = deferred();
    const launcher = vi.fn(() => promise);
    executor.registerLauncher('grep', launcher);

    executor.start('call-1', 'grep', { pattern: 'x' });
    const fromShim = executor.getOrStart('call-1', 'grep', { pattern: 'x' });

    expect(launcher).toHaveBeenCalledOnce();
    expect(fromShim).toBe(promise);
    resolve(sentinel);
    await expect(fromShim).resolves.toBe(sentinel);
  });

  it('runs exactly once when the execute shim (getOrStart) beats start()', () => {
    const executor = new EagerToolExecutor();
    const launcher = vi.fn().mockResolvedValue(sentinel);
    executor.registerLauncher('edit', launcher);

    // Shim path wins the race and starts the execution…
    const fromShim = executor.getOrStart('call-1', 'edit', {});
    // …then the stream loop's start() must be a no-op.
    executor.start('call-1', 'edit', {});

    expect(launcher).toHaveBeenCalledOnce();
    expect(fromShim).toBeInstanceOf(Promise);
  });

  it('is idempotent per toolCallId across repeated start() calls', () => {
    const executor = new EagerToolExecutor();
    const launcher = vi.fn().mockResolvedValue(sentinel);
    executor.registerLauncher('grep', launcher);

    executor.start('call-1', 'grep', { pattern: 'x' });
    executor.start('call-1', 'grep', { pattern: 'x' });

    expect(launcher).toHaveBeenCalledOnce();
  });

  it('captures a synchronous launcher throw as a rejected memoized promise', async () => {
    const executor = new EagerToolExecutor();
    const boom = new Error('launcher exploded');
    executor.registerLauncher('edit', () => {
      throw boom;
    });

    const first = executor.getOrStart('call-1', 'edit', {});
    const second = executor.getOrStart('call-1', 'edit', {});

    expect(first).toBe(second);
    await expect(first).rejects.toBe(boom);
  });

  it('tracks multiple tool calls independently', async () => {
    const executor = new EagerToolExecutor();
    const a = deferred();
    const b = deferred();
    executor.registerLauncher('read', () => a.promise);
    executor.registerLauncher('grep', () => b.promise);

    const inflightA = executor.getOrStart('call-a', 'read', {})!;
    const inflightB = executor.getOrStart('call-b', 'grep', {})!;
    expect(inflightA).not.toBe(inflightB);

    a.resolve(sentinel);
    b.resolve(sentinel);
    await expect(inflightA).resolves.toBe(sentinel);
    await expect(inflightB).resolves.toBe(sentinel);
  });

  it('last launcher registration wins for a tool name', () => {
    const executor = new EagerToolExecutor();
    const first = vi.fn().mockResolvedValue(sentinel);
    const second = vi.fn().mockResolvedValue(sentinel);
    executor.registerLauncher('read', first);
    executor.registerLauncher('read', second);

    executor.start('call-1', 'read', {});

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
