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

/**
 * Scheduling lane for a queued task. Main-agent work is dispatched ahead of
 * subagent work so background subagents cannot starve the visible agent
 * (review F-06). The pool reserves `mainAgentReserved` workers for the main
 * lane; the remaining workers are guaranteed to the subagent lane, so neither
 * lane can fully starve the other regardless of arrival pattern.
 */
export type WorkerTaskScope = 'main' | 'subagent';

/** Queue-wait vs execution breakdown for one task (review F-06 rec 5). */
export interface WorkerTaskTimings {
  /** Milliseconds between enqueue and dispatch to a worker. */
  queueWaitMs: number;
  /** Milliseconds between dispatch and settle (result or error). */
  executionMs: number;
  /** Milliseconds between enqueue and settle. Equals queueWait + execution. */
  totalMs: number;
}

/** Resolved when a task is dispatched to a worker (queue wait is over). */
export interface WorkerTaskStart {
  queueWaitMs: number;
}

export interface WorkerRunOptions {
  signal?: AbortSignal;
  /** Scheduling lane. Defaults to `main`. */
  scope?: WorkerTaskScope;
}

/**
 * Handle for a submitted task. `started` settles when the task is dispatched
 * (or rejected if it is cancelled before dispatch); `result` settles with the
 * worker outcome. `timings` is populated once the task settles.
 */
export interface WorkerTaskHandle<T> {
  readonly taskId: number;
  readonly started: Promise<WorkerTaskStart>;
  readonly result: Promise<T>;
  timings: WorkerTaskTimings | null;
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
  /**
   * Workers reserved for main-agent-scoped tasks. Clamped to `[0, size - 1]`
   * so the subagent lane always keeps at least one worker. Defaults to 1.
   */
  mainAgentReserved?: number;
  /** Injectable clock for deterministic timing tests. */
  now?: () => number;
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
  startResolve: (value: WorkerTaskStart) => void;
  startReject: (reason: unknown) => void;
  workerId: number;
  scope: WorkerTaskScope;
  enqueuedAt: number;
  startedAt: number | null;
  handle: WorkerTaskHandle<unknown>;
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
  private readonly mainAgentReserved: number;
  private readonly subagentCapacity: number;
  private readonly now: () => number;
  private readonly workers = new Map<number, WorkerEntry>();
  private readonly tasks = new Map<number, TaskEntry>();
  private mainQueue: QueueEntry[] = [];
  private subagentQueue: QueueEntry[] = [];
  private busyMain = 0;
  private busySub = 0;
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
    // Reserve at most size - 1 workers for main so the subagent lane always
    // keeps at least one guaranteed worker (no subagent starvation by design).
    const requestedReserved = Math.floor(options.mainAgentReserved ?? 1);
    this.mainAgentReserved = Math.min(Math.max(0, requestedReserved), Math.max(0, size - 1));
    this.subagentCapacity = size - this.mainAgentReserved;
    this.now = options.now ?? (() => Date.now());
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

  run<T>(payload: Record<string, unknown>, signal?: AbortSignal, scope: WorkerTaskScope = 'main'): Promise<T> {
    return this.runTask<T>(payload, { signal, scope }).result;
  }

  /**
   * Submit a task and return its handle. The handle exposes the queue-wait /
   * execution split so callers can bound execution time separately from queue
   * wait (review F-06 rec 5).
   */
  runTask<T>(payload: Record<string, unknown>, options: WorkerRunOptions = {}): WorkerTaskHandle<T> {
    if (this.disposed) throw new PoolDisposedError();
    if (this.unavailable) {
      return rejectedHandle<T>(new WorkerPoolUnavailableError());
    }
    if (options.signal?.aborted) {
      return rejectedHandle<T>(new WorkerTaskCancelledError());
    }
    return this.submit<T>(payload, options);
  }

  terminateTask(taskId: number): void {
    const task = this.takeTask(taskId);
    if (!task) return;
    this.recordTimings(task);
    task.startReject(new WorkerTaskCancelledError());
    task.reject(new WorkerTaskCancelledError());
    if (task.workerId < 0) {
      const queue = task.scope === 'main' ? this.mainQueue : this.subagentQueue;
      const index = queue.findIndex((q) => q.taskId === taskId);
      if (index >= 0) queue.splice(index, 1);
      return;
    }
    this.releaseBusy(task);
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
    return this.mainQueue.length + this.subagentQueue.length;
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
      const task = this.takeTask(msg.taskId);
      if (task) {
        this.releaseBusy(task);
        this.recordTimings(task);
        task.resolve(msg.result);
      }
      this.scheduleDispatch();
    } else if (msg.type === 'error') {
      entry.busy = false;
      entry.taskId = null;
      const task = this.takeTask(msg.taskId);
      if (task) {
        this.releaseBusy(task);
        this.recordTimings(task);
        task.reject(new Error(msg.error));
      }
      this.scheduleDispatch();
    }
  }

  private handleWorkerFailure(workerId: number): void {
    const entry = this.workers.get(workerId);
    if (!entry) return;
    this.workers.delete(workerId);
    if (entry.taskId !== null) {
      const task = this.takeTask(entry.taskId);
      if (task) {
        this.releaseBusy(task);
        this.recordTimings(task);
        task.reject(new Error('Worker crashed'));
      }
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
        this.scheduleDispatch();
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
    const queuedTaskIds = [...this.mainQueue, ...this.subagentQueue].map((entry) => entry.taskId);
    this.mainQueue = [];
    this.subagentQueue = [];
    for (const taskId of queuedTaskIds) {
      const task = this.takeTask(taskId);
      if (task) {
        this.recordTimings(task);
        task.startReject(new WorkerPoolUnavailableError());
        task.reject(new WorkerPoolUnavailableError());
      }
    }
  }

  private rejectAllTasks(error: Error): void {
    for (const taskId of [...this.tasks.keys()]) {
      const task = this.takeTask(taskId);
      if (task) {
        this.recordTimings(task);
        task.startReject(error);
        task.reject(error);
      }
    }
    this.mainQueue = [];
    this.subagentQueue = [];
    this.busyMain = 0;
    this.busySub = 0;
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

  private submit<T>(payload: Record<string, unknown>, options: WorkerRunOptions): WorkerTaskHandle<T> {
    const taskId = this.nextTaskId++;
    const scope: WorkerTaskScope = options.scope ?? 'main';
    const message: Record<string, unknown> = { type: 'execute', taskId, ...payload };

    // Capture each promise's resolvers up front so the task entry and the
    // handle are both built from fully initialized values — no field is ever
    // bootstrapped with a placeholder (promise executors run synchronously).
    let startResolve!: (value: WorkerTaskStart) => void;
    let startReject!: (reason: unknown) => void;
    const started = new Promise<WorkerTaskStart>((resolve, reject) => {
      startResolve = resolve;
      startReject = reject;
    });
    let resolveTask!: (value: unknown) => void;
    let rejectTask!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveTask = resolve as (value: unknown) => void;
      rejectTask = reject;
    });
    // A caller typically awaits only one of the two promises; observe both so
    // a rejection surfaced through the other never becomes an unhandled reject.
    started.catch(() => undefined);
    result.catch(() => undefined);

    const handle: WorkerTaskHandle<T> = { taskId, started, result, timings: null };
    const task: TaskEntry = {
      resolve: resolveTask,
      reject: rejectTask,
      startResolve,
      startReject,
      workerId: -1,
      scope,
      enqueuedAt: this.now(),
      startedAt: null,
      handle: handle as WorkerTaskHandle<unknown>,
    };

    if (options.signal) {
      task.signal = options.signal;
      task.abortListener = () => this.terminateTask(taskId);
      options.signal.addEventListener('abort', task.abortListener, { once: true });
    }

    this.tasks.set(taskId, task);
    if (scope === 'main') {
      this.mainQueue.push({ taskId, message });
    } else {
      this.subagentQueue.push({ taskId, message });
    }
    this.scheduleDispatch();
    return handle;
  }

  private releaseBusy(task: TaskEntry): void {
    if (task.startedAt === null) return;
    if (task.scope === 'main') this.busyMain = Math.max(0, this.busyMain - 1);
    else this.busySub = Math.max(0, this.busySub - 1);
  }

  private recordTimings(task: TaskEntry): void {
    if (task.handle.timings !== null) return;
    const finishedAt = this.now();
    const startedAt = task.startedAt;
    const queueWaitMs = (startedAt ?? finishedAt) - task.enqueuedAt;
    const executionMs = startedAt === null ? 0 : finishedAt - startedAt;
    task.handle.timings = {
      queueWaitMs,
      executionMs,
      totalMs: finishedAt - task.enqueuedAt,
    };
  }

  private dispatch(workerId: number, taskId: number, message: Record<string, unknown>): void {
    const entry = this.workers.get(workerId);
    const task = this.tasks.get(taskId);
    if (!entry || !task || entry.state !== 'healthy') return;
    entry.busy = true;
    entry.taskId = taskId;
    task.workerId = workerId;
    task.startedAt = this.now();
    if (task.scope === 'main') this.busyMain++;
    else this.busySub++;
    task.startResolve({ queueWaitMs: task.startedAt - task.enqueuedAt });
    try {
      entry.worker.postMessage(message);
    } catch {
      this.handleWorkerFailure(workerId);
    }
  }

  /**
   * Pick the next queued task for a freed worker. Main fills its reserved
   * share first and only spills into subagent capacity when no subagent work
   * is waiting; subagents symmetrically fill their guaranteed capacity and
   * only spill into the reserved-main workers when no main work is waiting.
   * This keeps both lanes work-conserving while guaranteeing each lane its
   * reserved workers, so neither can starve the other.
   */
  private pickQueuedTask(): QueueEntry | null {
    const mainHas = this.mainQueue.length > 0;
    const subHas = this.subagentQueue.length > 0;
    if (mainHas && (this.busyMain < this.mainAgentReserved || !subHas)) {
      return this.takeQueued(this.mainQueue);
    }
    if (subHas && (this.busySub < this.subagentCapacity || !mainHas)) {
      return this.takeQueued(this.subagentQueue);
    }
    return null;
  }

  private takeQueued(queue: QueueEntry[]): QueueEntry | null {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (this.tasks.has(entry.taskId)) return entry;
    }
    return null;
  }

  private scheduleDispatch(): void {
    if (this.unavailable || this.disposed) return;
    for (;;) {
      const idleWorkerId = this.findIdleWorker();
      if (idleWorkerId === null) break;
      const queued = this.pickQueuedTask();
      if (queued === null) break;
      this.dispatch(idleWorkerId, queued.taskId, queued.message);
    }
  }
}

/** Build a handle whose started/result promises both reject with `error`. */
function rejectedHandle<T>(error: Error): WorkerTaskHandle<T> {
  const started = Promise.reject(error) as Promise<WorkerTaskStart>;
  const result = Promise.reject(error) as Promise<T>;
  started.catch(() => undefined);
  result.catch(() => undefined);
  return { taskId: -1, started, result, timings: null };
}
