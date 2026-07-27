import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PoolDisposedError,
  WorkerPool,
  WorkerTaskCancelledError,
  WorkerPoolUnavailableError,
  type WorkerPoolOptions,
} from '../../src/main/utils/worker-pool';

const workerScript = path.resolve(
  __dirname,
  '../fixtures/worker-pool-test-worker.cjs',
);

const pools: WorkerPool[] = [];

function createPool(options?: WorkerPoolOptions): WorkerPool {
  const pool = new WorkerPool(workerScript, 1, undefined, options);
  pools.push(pool);
  return pool;
}

class FakeWorker extends EventEmitter {
  private terminated = false;

  constructor(
    private readonly ready: boolean,
    private readonly respondToTasks: boolean,
  ) {
    super();
    if (ready) {
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }
  }

  postMessage(message: unknown): void {
    if (!this.respondToTasks || !message || typeof message !== 'object') return;
    const task = message as { type?: string; taskId?: number; result?: unknown };
    if (task.type !== 'execute') return;
    queueMicrotask(() => this.emit('message', {
      type: 'result',
      taskId: task.taskId,
      result: task.result ?? 'done',
    }));
  }

  terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      queueMicrotask(() => this.emit('exit', 0));
    }
    return Promise.resolve(0);
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  crash(): void {
    this.emit('error', new Error('simulated worker crash'));
  }

  exitUnexpectedly(code = 0): void {
    this.emit('exit', code);
  }
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

describe('WorkerPool availability', () => {
  it('times out workers that never become ready', async () => {
    const pool = createPool({
      readinessTimeoutMs: 1,
      workerFactory: () => new FakeWorker(false, false),
    });

    await expect(pool.init()).rejects.toThrow('did not become ready');
    expect(pool.health).toMatchObject({
      status: 'degraded',
      healthyWorkers: 0,
      startingWorkers: 0,
      failedWorkers: 1,
    });
  });

  it('opens its circuit, drains queued tasks, and can be explicitly recovered', async () => {
    const workers: FakeWorker[] = [];
    let allowHealthyWorkers = false;
    const pool = createPool({
      readinessTimeoutMs: 1,
      maxRespawnAttempts: 2,
      respawnDelayMs: () => 0,
      sleep: async () => undefined,
      workerFactory: () => {
        const worker = new FakeWorker(
          workers.length === 0 || allowHealthyWorkers,
          allowHealthyWorkers,
        );
        workers.push(worker);
        return worker;
      },
    });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await pool.init();

    const queuedAbort = new AbortController();
    const removeQueuedAbortListener = vi.spyOn(
      queuedAbort.signal,
      'removeEventListener',
    );
    const running = pool.run({ result: 'running' });
    const queued = pool.run({ result: 'queued' }, queuedAbort.signal);
    const secondQueued = pool.run({ result: 'also queued' });
    const runningRejected = expect(running).rejects.toThrow('Worker crashed');
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(WorkerPoolUnavailableError);
    const secondQueuedRejected = expect(secondQueued).rejects.toBeInstanceOf(WorkerPoolUnavailableError);

    workers[0].exitUnexpectedly();

    await runningRejected;
    await queuedRejected;
    await secondQueuedRejected;
    expect(pool.health).toMatchObject({
      status: 'unavailable',
      healthyWorkers: 0,
      startingWorkers: 0,
      failedWorkers: 1,
      consecutiveRespawnFailures: 2,
    });
    expect(pool.queueLength).toBe(0);
    expect(pendingTaskCount(pool)).toBe(0);
    expect(removeQueuedAbortListener).toHaveBeenCalledTimes(1);
    await expect(pool.run({ result: 'never' })).rejects.toBeInstanceOf(WorkerPoolUnavailableError);

    allowHealthyWorkers = true;
    await pool.recover();
    expect(pool.health).toMatchObject({ status: 'healthy', healthyWorkers: 1 });
    await expect(pool.run({ result: 'recovered' })).resolves.toBe('recovered');
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it('disposes a replacement that is still starting without leaving it alive', async () => {
    const workers: FakeWorker[] = [];
    const pool = createPool({
      readinessTimeoutMs: 5_000,
      workerFactory: () => {
        const worker = new FakeWorker(workers.length === 0, false);
        workers.push(worker);
        return worker;
      },
    });
    await pool.init();

    workers[0].crash();
    await waitFor(() => pool.health.startingWorkers === 1);
    await pool.dispose();

    expect(workers[1].isTerminated).toBe(true);
    expect(pool.health.status).toBe('disposed');
  });
});
