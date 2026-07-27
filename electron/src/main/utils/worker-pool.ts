import { Worker } from 'node:worker_threads';

const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPAWN_ATTEMPTS = 3;
const DEFAULT_RESPAWN_BASE_DELAY_MS = 100;

export class PoolDisposedError extends Error {
  constructor() {
    super('Worker pool has been disposed');
    this.name = 'PoolDisposedError';
  }
}

/** Raised when a task is submitted to a pool whose replacement circuit is open. */
export class WorkerPoolUnavailableError extends Error {
  constructor() {
    super('Worker pool is unavailable');
    this.name = 'WorkerPoolUnavailableError';
  }
}

/** Raised when an abort signal cancels a worker task. */
export class WorkerTaskCancelledError extends Error {
  constructor() {
    super('Task cancelled');
    this.name = 'WorkerTaskCancelledError';
  }
}

export interface WorkerPoolHealth {
  status: 'starting' | 'healthy' | 'degraded' | 'unavailable' | 'disposed';
  healthyWorkers: number;
  startingWorkers: number;
  failedWorkers: number;
  consecutiveRespawnFailures: number;
}

interface WorkerLike {
  on(event: 'message', listener: (message: WorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
}

export interface WorkerPoolOptions {
  /** Maximum time a new worker may take to post its ready message. */
  readinessTimeoutMs?: number;
  /** Number of failed replacement starts allowed before opening the circuit. */
  maxRespawnAttempts?: number;
  /** Produces a retry delay. Tests may provide a deterministic implementation. */
  respawnDelayMs?: (attempt: number) => number;
  /** Injectable scheduler for deterministic retry tests. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Injectable worker constructor for lifecycle tests. */
  workerFactory?: (workerScript: string, workerData: unknown) => WorkerLike;
}

interface WorkerEntry {
  worker: WorkerLike;
  state: 'starting' | 'healthy';
  busy: boolean;
  taskId: number | null;
}

interface TaskEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  workerId: number;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface QueueEntry {
  taskId: number;
  message: Record<string, unknown>;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; taskId: number; result: unknown }
  | { type: 'error'; taskId: number; error: string };

/**
 * Bounded pool for main-process work. A failed replacement eventually opens a
 * circuit instead of leaving queued tool calls pending forever.
 */
export class WorkerPool {
  private readonly workerScript: string;
  private readonly size: number;
  private readonly workerData: unknown;
  private readonly readinessTimeoutMs: number;
  private readonly maxRespawnAttempts: number;
  private readonly respawnDelayMs: (attempt: number) => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly workerFactory: (workerScript: string, workerData: unknown) => WorkerLike;
  private readonly workers = new Map<number, WorkerEntry>();
  private readonly tasks = new Map<number, TaskEntry>();
  private queue: QueueEntry[] = [];
  private nextTaskId = 0;
  private nextWorkerId = 0;
  private disposed = false;
  private unavailable = false;
  private consecutiveRespawnFailures = 0;
  private lifecycleGeneration = 0;

  constructor(
    workerScript: string,
    size: number,
    workerData?: unknown,
    options: WorkerPoolOptions = {},
  ) {
    this.workerScript = workerScript;
    this.size = size;
    this.workerData = workerData;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.maxRespawnAttempts = options.maxRespawnAttempts ?? DEFAULT_MAX_RESPAWN_ATTEMPTS;
    this.respawnDelayMs = options.respawnDelayMs ?? ((attempt) => {
      const baseDelay = DEFAULT_RESPAWN_BASE_DELAY_MS * 2 ** (attempt - 1);
      return baseDelay + Math.floor(Math.random() * baseDelay);
    });
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.workerFactory = options.workerFactory ?? ((script, data) => new Worker(script, {
      workerData: data,
      env: process.env,
    }));
  }

  async init(): Promise<void> {
    if (this.disposed) throw new PoolDisposedError();
    if (this.unavailable) throw new WorkerPoolUnavailableError();
    const readyPromises: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      readyPromises.push(this.spawnWorker());
    }
    try {
      await Promise.all(readyPromises);
    } catch (err) {
      await this.terminateWorkers();
      throw err;
    }
  }

  /** Rebuilds an explicitly unavailable pool after its caller has handled the outage. */
  async recover(): Promise<void> {
    if (this.disposed) throw new PoolDisposedError();
    if (!this.unavailable) return;

    this.lifecycleGeneration++;
    this.rejectAllTasks(new WorkerPoolUnavailableError());
    await this.terminateWorkers();
    this.unavailable = false;
    this.consecutiveRespawnFailures = 0;
    try {
      await this.init();
    } catch (err) {
      this.openCircuit();
      throw err;
    }
  }

  run<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new PoolDisposedError();
    if (this.unavailable) return Promise.reject(new WorkerPoolUnavailableError());
    if (signal?.aborted) return Promise.reject(new WorkerTaskCancelledError());

    const taskId = this.nextTaskId++;
    const message: Record<string, unknown> = { type: 'execute', taskId, ...payload };
    return new Promise<T>((resolve, reject) => {
      const task: TaskEntry = {
        resolve: resolve as (value: unknown) => void,
        reject,
        workerId: -1,
      };
      if (signal) {
        task.signal = signal;
        task.abortListener = () => this.terminateTask(taskId);
        signal.addEventListener('abort', task.abortListener, { once: true });
      }
      this.tasks.set(taskId, task);
      const idleWorkerId = this.findIdleWorker();
      if (idleWorkerId !== null) {
        this.dispatch(idleWorkerId, taskId, message);
      } else {
        this.queue.push({ taskId, message });
      }
    });
  }

  terminateTask(taskId: number): void {
    const task = this.takeTask(taskId);
    if (!task) return;
    task.reject(new WorkerTaskCancelledError());
    if (task.workerId < 0) {
      this.queue = this.queue.filter((q) => q.taskId !== taskId);
      return;
    }
    const entry = this.workers.get(task.workerId);
    if (!entry) return;
    this.workers.delete(task.workerId);
    void entry.worker.terminate();
    this.startReplacement();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleGeneration++;
    this.rejectAllTasks(new PoolDisposedError());
    await this.terminateWorkers();
  }

  get activeCount(): number {
    let count = 0;
    for (const [, entry] of this.workers) {
      if (entry.state === 'healthy' && entry.busy) count++;
    }
    return count;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get health(): WorkerPoolHealth {
    let healthyWorkers = 0;
    let startingWorkers = 0;
    for (const [, entry] of this.workers) {
      if (entry.state === 'healthy') healthyWorkers++;
      else startingWorkers++;
    }
    const failedWorkers = Math.max(0, this.size - healthyWorkers - startingWorkers);
    const status = this.disposed
      ? 'disposed'
      : this.unavailable
        ? 'unavailable'
        : healthyWorkers === this.size
          ? 'healthy'
          : healthyWorkers === 0 && startingWorkers > 0
            ? 'starting'
            : 'degraded';
    return {
      status,
      healthyWorkers,
      startingWorkers,
      failedWorkers,
      consecutiveRespawnFailures: this.consecutiveRespawnFailures,
    };
  }

  private async terminateWorkers(): Promise<void> {
    const entries = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(entries.map((entry) => entry.worker.terminate()));
  }

  private spawnWorker(): Promise<void> {
    const workerId = this.nextWorkerId++;
    let worker: WorkerLike;
    try {
      worker = this.workerFactory(this.workerScript, this.workerData);
    } catch (error) {
      return Promise.reject(error);
    }
    const entry: WorkerEntry = { worker, state: 'starting', busy: false, taskId: null };
    this.workers.set(workerId, entry);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readinessTimer);
        if (error) {
          this.workers.delete(workerId);
          void worker.terminate();
          reject(error);
        } else {
          const current = this.workers.get(workerId);
          if (!current || this.disposed || this.unavailable) {
            void worker.terminate();
            reject(new WorkerPoolUnavailableError());
            return;
          }
          current.state = 'healthy';
          resolve();
        }
      };

      const readinessTimer = setTimeout(() => {
        settle(new Error(`Worker did not become ready within ${this.readinessTimeoutMs}ms`));
      }, this.readinessTimeoutMs);

      worker.on('message', (msg: WorkerMessage) => {
        if (!settled) {
          if (msg && typeof msg === 'object' && msg.type === 'ready') settle();
          return;
        }
        this.handleMessage(workerId, msg);
      });
      worker.on('error', (err: Error) => {
        if (!settled) {
          settle(err);
          return;
        }
        this.handleWorkerFailure(workerId);
      });
      worker.on('exit', (code: number) => {
        if (!settled) {
          settle(new Error(`Worker exited with code ${code} before ready`));
          return;
        }
        this.handleWorkerFailure(workerId);
      });
    });
  }

  private handleMessage(workerId: number, msg: WorkerMessage): void {
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    const entry = this.workers.get(workerId);
    if (!entry || entry.state !== 'healthy') return;
    if (msg.type === 'result') {
      entry.busy = false;
      entry.taskId = null;
      this.takeTask(msg.taskId)?.resolve(msg.result);
      this.processQueue();
    } else if (msg.type === 'error') {
      entry.busy = false;
      entry.taskId = null;
      this.takeTask(msg.taskId)?.reject(new Error(msg.error));
      this.processQueue();
    }
  }

  private handleWorkerFailure(workerId: number): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;
    this.workers.delete(workerId);
    if (entry.taskId !== null) {
      this.takeTask(entry.taskId)?.reject(new Error('Worker crashed'));
    }
    this.startReplacement();
  }

  private startReplacement(): void {
    if (this.disposed || this.unavailable) return;
    const generation = this.lifecycleGeneration;
    void this.replaceWorker(generation);
  }

  private async replaceWorker(generation: number): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRespawnAttempts; attempt++) {
      if (this.disposed || this.unavailable || generation !== this.lifecycleGeneration) return;
      if (attempt > 1) {
        await this.sleep(Math.max(0, this.respawnDelayMs(attempt - 1)));
        if (this.disposed || this.unavailable || generation !== this.lifecycleGeneration) return;
      }
      try {
        await this.spawnWorker();
        this.consecutiveRespawnFailures = 0;
        this.processQueue();
        return;
      } catch (err) {
        if (this.disposed || this.unavailable || generation !== this.lifecycleGeneration) return;
        this.consecutiveRespawnFailures++;
        console.error('[worker-pool] Failed to respawn worker', {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.openCircuit();
  }

  private openCircuit(): void {
    if (this.disposed || this.unavailable) return;
    this.unavailable = true;
    this.lifecycleGeneration++;
    const queuedTaskIds = this.queue.map((entry) => entry.taskId);
    this.queue = [];
    for (const taskId of queuedTaskIds) {
      this.takeTask(taskId)?.reject(new WorkerPoolUnavailableError());
    }
  }

  private rejectAllTasks(error: Error): void {
    for (const taskId of [...this.tasks.keys()]) {
      this.takeTask(taskId)?.reject(error);
    }
    this.queue = [];
  }

  private findIdleWorker(): number | null {
    for (const [workerId, entry] of this.workers) {
      if (entry.state === 'healthy' && !entry.busy) return workerId;
    }
    return null;
  }

  private takeTask(taskId: number): TaskEntry | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    this.tasks.delete(taskId);
    if (task.signal && task.abortListener) {
      task.signal.removeEventListener('abort', task.abortListener);
    }
    return task;
  }

  private dispatch(workerId: number, taskId: number, message: Record<string, unknown>): void {
    const entry = this.workers.get(workerId);
    const task = this.tasks.get(taskId);
    if (!entry || !task || entry.state !== 'healthy') return;
    entry.busy = true;
    entry.taskId = taskId;
    task.workerId = workerId;
    try {
      entry.worker.postMessage(message);
    } catch {
      this.handleWorkerFailure(workerId);
    }
  }

  private processQueue(): void {
    if (this.unavailable || this.disposed) return;
    while (this.queue.length > 0) {
      const idleWorkerId = this.findIdleWorker();
      if (idleWorkerId === null) break;
      const queued = this.queue.shift()!;
      if (!this.tasks.has(queued.taskId)) continue;
      this.dispatch(idleWorkerId, queued.taskId, queued.message);
    }
  }
}
