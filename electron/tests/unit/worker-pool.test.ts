import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PoolDisposedError,
  WorkerPool,
  WorkerTaskCancelledError,
} from '../../src/main/utils/worker-pool';

const workerScript = path.resolve(
  __dirname,
  '../fixtures/worker-pool-test-worker.cjs',
);

const pools: WorkerPool[] = [];

function createPool(): WorkerPool {
  const pool = new WorkerPool(workerScript, 1);
  pools.push(pool);
  return pool;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for worker pool state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pendingTaskCount(pool: WorkerPool): number {
  return (pool as unknown as { tasks: Map<number, unknown> }).tasks.size;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});

describe('WorkerPool cancellation', () => {
  it('rejects an already-aborted request without retaining a task', async () => {
    const pool = createPool();
    await pool.init();
    const abortController = new AbortController();
    abortController.abort();

    await expect(pool.run({ result: 'never' }, abortController.signal)).rejects.toBeInstanceOf(
      WorkerTaskCancelledError,
    );

    expect(pool.activeCount).toBe(0);
    expect(pool.queueLength).toBe(0);
    expect(pendingTaskCount(pool)).toBe(0);
  });

  it('cancels running work, replaces its worker, and releases queued capacity', async () => {
    const pool = createPool();
    await pool.init();
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');

    const running = pool.run({ delayMs: 5_000 }, abortController.signal);
    await waitFor(() => pool.activeCount === 1);
    const queued = pool.run({ result: 'queued' });
    expect(pool.queueLength).toBe(1);

    abortController.abort();

    await expect(running).rejects.toBeInstanceOf(WorkerTaskCancelledError);
    await expect(queued).resolves.toBe('queued');
    expect(pool.activeCount).toBe(0);
    expect(pool.queueLength).toBe(0);
    expect(pendingTaskCount(pool)).toBe(0);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('removes abort listeners and task entries when disposed', async () => {
    const pool = createPool();
    await pool.init();
    const runningAbort = new AbortController();
    const queuedAbort = new AbortController();
    const removeRunningAbortListener = vi.spyOn(
      runningAbort.signal,
      'removeEventListener',
    );
    const removeQueuedAbortListener = vi.spyOn(
      queuedAbort.signal,
      'removeEventListener',
    );

    const running = pool.run({ delayMs: 5_000 }, runningAbort.signal);
    await waitFor(() => pool.activeCount === 1);
    const queued = pool.run({ result: 'never' }, queuedAbort.signal);

    const runningRejected = expect(running).rejects.toBeInstanceOf(PoolDisposedError);
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(PoolDisposedError);
    await pool.dispose();

    await runningRejected;
    await queuedRejected;
    expect(pendingTaskCount(pool)).toBe(0);
    expect(removeRunningAbortListener).toHaveBeenCalledTimes(1);
    expect(removeQueuedAbortListener).toHaveBeenCalledTimes(1);
  }, 10_000);
});
