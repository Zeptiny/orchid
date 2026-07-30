import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PoolDisposedError,
  WorkerPool,
  WorkerTaskCancelledError,
  WorkerPoolUnavailableError,
  type WorkerPoolOptions,
  type WorkerTaskHandle,
} from '../../src/main/utils/worker-pool';
import { withTimeoutPromise } from '../../src/main/utils/async';
import { resolveMainAgentReserved } from '../../src/main/llm/tool-pool';

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

/**
 * Worker whose task completions are driven manually, so tests control exactly
 * when each task starts and finishes (unlike FakeWorker, which auto-completes).
 */
class ManualWorker extends EventEmitter {
  readonly executed: Array<{ taskId: number; message: Record<string, unknown> }> = [];
  private terminated = false;

  constructor() {
    super();
    queueMicrotask(() => this.emit('message', { type: 'ready' }));
  }

  postMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const task = message as { type?: string; taskId?: number };
    if (task.type !== 'execute' || typeof task.taskId !== 'number') return;
    this.executed.push({ taskId: task.taskId, message: message as Record<string, unknown> });
  }

  complete(taskId: number, result: unknown = 'done'): void {
    this.emit('message', { type: 'result', taskId, result });
  }

  terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      queueMicrotask(() => this.emit('exit', 0));
    }
    return Promise.resolve(0);
  }
}

function createManualPool(opts: {
  size: number;
  mainAgentReserved?: number;
  now?: () => number;
}): { pool: WorkerPool; workers: ManualWorker[] } {
  const workers: ManualWorker[] = [];
  const pool = new WorkerPool(workerScript, opts.size, undefined, {
    mainAgentReserved: opts.mainAgentReserved,
    now: opts.now,
    workerFactory: () => {
      const worker = new ManualWorker();
      workers.push(worker);
      return worker;
    },
  });
  pools.push(pool);
  return { pool, workers };
}

function dispatchedTags(workers: ManualWorker[]): string[] {
  return workers.flatMap((w) => w.executed.map((e) => String(e.message.tag)));
}

/** Let queued microtasks (ready signals, promise callbacks) run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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

describe('WorkerPool main-agent priority (review F-06)', () => {
  it('dispatches a later main-agent task ahead of an earlier queued subagent task', async () => {
    const { pool, workers } = createManualPool({ size: 2, mainAgentReserved: 1 });
    await pool.init();
    expect(workers).toHaveLength(2);

    // Saturate both workers with subagent work; a third subagent queues.
    pool.runTask({ tag: 'subA' }, { scope: 'subagent' });
    pool.runTask({ tag: 'subB' }, { scope: 'subagent' });
    const subC = pool.runTask({ tag: 'subC' }, { scope: 'subagent' });
    await flush();
    expect(dispatchedTags(workers).sort()).toEqual(['subA', 'subB']);
    expect(pool.queueLength).toBe(1);

    // A main-agent task queued now sits behind nothing on the main lane.
    const mainM = pool.runTask({ tag: 'mainM' }, { scope: 'main' });
    await flush();
    expect(pool.queueLength).toBe(2); // subC + mainM

    let mainStarted = false;
    let subCStarted = false;
    void mainM.started.then(() => { mainStarted = true; }, () => undefined);
    void subC.started.then(() => { subCStarted = true; }, () => undefined);

    // Free one worker; the reserved main-agent slot admits mainM, not subC.
    const busyWorker = workers.find((w) => w.executed.length > 0)!;
    busyWorker.complete(busyWorker.executed[0].taskId, 'first-done');
    await flush();

    expect(mainStarted).toBe(true);
    expect(subCStarted).toBe(false);
    expect(dispatchedTags(workers)).toContain('mainM');
    expect(dispatchedTags(workers)).not.toContain('subC');
  });

  it('does not starve subagent tasks under sustained main-agent load', async () => {
    const { pool, workers } = createManualPool({ size: 2, mainAgentReserved: 1 });
    await pool.init();

    const findWorker = (taskId: number): ManualWorker | undefined =>
      workers.find((w) => w.executed.some((e) => e.taskId === taskId));
    const completedIds = new Set<number>();
    const runningIds = (): number[] =>
      workers
        .flatMap((w) => w.executed.map((e) => e.taskId))
        .filter((id) => !completedIds.has(id));
    const completeOne = (): void => {
      const ids = runningIds();
      if (ids.length === 0) return;
      const taskId = ids[0];
      completedIds.add(taskId);
      findWorker(taskId)!.complete(taskId, 'done');
    };

    // Keep the main lane saturated throughout (2 running + 2 queued).
    let mainCounter = 0;
    const submitMain = (): void => {
      pool.runTask({ tag: `main-${mainCounter++}` }, { scope: 'main' });
    };
    for (let i = 0; i < 4; i++) submitMain();
    await flush();
    expect(pool.activeCount).toBe(2);

    // Over K rounds a freshly queued subagent must always be admitted and
    // complete even though the main queue is never empty.
    const K = 6;
    for (let round = 0; round < K; round++) {
      const sub = pool.runTask({ tag: `sub-${round}` }, { scope: 'subagent' });
      let subSettled = false;
      void sub.result.then(
        () => { subSettled = true; },
        () => { subSettled = true; },
      );

      let guard = 0;
      while (!subSettled) {
        completeOne();
        submitMain(); // refill so the main lane stays saturated
        await flush();
        if (++guard > 50) {
          throw new Error(`starvation: sub-${round} never completed`);
        }
      }
      expect(subSettled).toBe(true);
    }
  });

  it('floors a configured 0 reservation to 1 so queued subagents cannot starve the main lane', async () => {
    // The config path (tool-pool) floors 0 → 1; the pool then behaves exactly
    // like mainAgentReserved: 1, so a queued subagent wave cannot starve a
    // later main-agent task.
    expect(resolveMainAgentReserved(0)).toBe(1);
    expect(resolveMainAgentReserved(3)).toBe(3);

    const { pool, workers } = createManualPool({ size: 2, mainAgentReserved: resolveMainAgentReserved(0) });
    await pool.init();
    expect(pool.reservedMainAgents).toBe(1);

    pool.runTask({ tag: 'subA' }, { scope: 'subagent' });
    pool.runTask({ tag: 'subB' }, { scope: 'subagent' });
    const subC = pool.runTask({ tag: 'subC' }, { scope: 'subagent' });
    await flush();
    expect(pool.activeCount).toBe(2);

    const mainM = pool.runTask({ tag: 'mainM' }, { scope: 'main' });
    let subCStarted = false;
    void subC.started.then(() => { subCStarted = true; }, () => undefined);
    await flush();

    const busyWorker = workers.find((w) => w.executed.length > 0)!;
    busyWorker.complete(busyWorker.executed[0].taskId, 'first-done');
    await flush();

    await expect(mainM.started).resolves.toBeDefined();
    expect(subCStarted).toBe(false);
  });

  it('falls through to the alternate lane when the selected lane only held cancelled entries', async () => {
    const { pool, workers } = createManualPool({ size: 2, mainAgentReserved: 1 });
    await pool.init();

    pool.runTask({ tag: 'subA' }, { scope: 'subagent' });
    pool.runTask({ tag: 'subB' }, { scope: 'subagent' });
    await flush();
    expect(pool.activeCount).toBe(2);

    // Queue a main task (reserved lane) and a subagent task, then cancel the
    // main task before any worker frees: the freed worker must fall through
    // to subC instead of idling on the drained main lane.
    const abort = new AbortController();
    pool.runTask({ tag: 'mainM' }, { scope: 'main', signal: abort.signal });
    const subC = pool.runTask({ tag: 'subC' }, { scope: 'subagent' });
    let subCStarted = false;
    void subC.started.then(() => { subCStarted = true; }, () => undefined);
    abort.abort();
    await flush();

    const busyWorker = workers.find((w) => w.executed.length > 0)!;
    busyWorker.complete(busyWorker.executed[0].taskId, 'first-done');
    await flush();

    expect(subCStarted).toBe(true);
    expect(dispatchedTags(workers)).toContain('subC');
  });

  it('falls back to the default reservation for non-finite configured values', () => {
    const nanPool = createManualPool({ size: 2, mainAgentReserved: Number.NaN });
    expect(nanPool.pool.reservedMainAgents).toBe(1);
    const infPool = createManualPool({ size: 4, mainAgentReserved: Number.POSITIVE_INFINITY });
    expect(infPool.pool.reservedMainAgents).toBe(1);
  });

  it('reports queue-wait and execution timings separately, summing to total latency', async () => {
    let clock = 1_000;
    const { pool, workers } = createManualPool({
      size: 1,
      now: () => clock,
    });
    await pool.init();

    const blocker = pool.runTask({ tag: 'blocker' }, { scope: 'main' });
    // Blocker dispatches immediately (idle worker) at clock=1000.
    const target = pool.runTask({ tag: 'target' }, { scope: 'main' });
    // Target enqueues at 1000 and waits behind the blocker.

    clock = 1_050; // 50ms of queue wait elapses
    workers[0].complete(blocker.taskId, 'blocker-done'); // target starts now
    clock = 1_080; // 30ms of execution elapses
    workers[0].complete(target.taskId, 'target-done');

    await expect(target.result).resolves.toBe('target-done');
    expect(target.timings).toEqual({ queueWaitMs: 50, executionMs: 30, totalMs: 80 });
    expect(target.timings!.queueWaitMs + target.timings!.executionMs).toBe(
      target.timings!.totalMs,
    );

    // The blocker ran immediately: zero queue wait, all execution.
    expect(blocker.timings).toEqual({ queueWaitMs: 0, executionMs: 50, totalMs: 50 });
  });

  it('succeeds when queue wait exceeds the timeout but execution stays within it', async () => {
    // Real timers: the blocker holds the single worker ~200ms, so the target
    // queues well past the 80ms execution budget before its ~20ms execution.
    const pool = new WorkerPool(workerScript, 1);
    pools.push(pool);
    await pool.init();

    const executionTimeoutMs = 80;
    const blocker = pool.run({ delayMs: 200, result: 'blocker' });
    const target = pool.runTask({ delayMs: 20, result: 'target' }, { scope: 'main' });

    // Queue wait is NOT counted against the timeout: the timer starts only
    // once the task is dispatched (mirrors tool-dispatch's execution-only race).
    await target.started;
    const result = await withTimeoutPromise(
      target.result,
      executionTimeoutMs,
      'execution timed out',
    );

    expect(result).toBe('target');
    expect(target.timings!.queueWaitMs).toBeGreaterThan(executionTimeoutMs);
    expect(target.timings!.executionMs).toBeLessThan(executionTimeoutMs);
    await expect(blocker).resolves.toBe('blocker');
  }, 10_000);
});
