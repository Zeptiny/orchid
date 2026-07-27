import { Worker } from 'node:worker_threads';

export class PoolDisposedError extends Error {
  constructor() {
    super('Worker pool has been disposed');
    this.name = 'PoolDisposedError';
  }
}

/** Raised when an abort signal cancels a worker task. */
export class WorkerTaskCancelledError extends Error {
  constructor() {
    super('Task cancelled');
    this.name = 'WorkerTaskCancelledError';
  }
}

interface WorkerEntry {
  worker: Worker;
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

export class WorkerPool {
  private readonly workerScript: string;
  private readonly size: number;
  private readonly workerData: unknown;
  private readonly workers = new Map<number, WorkerEntry>();
  private readonly tasks = new Map<number, TaskEntry>();
  private queue: QueueEntry[] = [];
  private nextTaskId = 0;
  private nextWorkerId = 0;
  private disposed = false;

  constructor(workerScript: string, size: number, workerData?: unknown) {
    this.workerScript = workerScript;
    this.size = size;
    this.workerData = workerData;
  }

  async init(): Promise<void> {
    if (this.disposed) throw new PoolDisposedError();
    const readyPromises: Promise<void>[] = [];
    for (let i = 0; i < this.size; i++) {
      readyPromises.push(this.spawnWorker());
    }
    try {
      await Promise.all(readyPromises);
    } catch (err) {
      for (const [, entry] of this.workers) {
        void entry.worker.terminate();
      }
      this.workers.clear();
      throw err;
    }
  }

  run<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new PoolDisposedError();
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
    void entry.worker.terminate();
    this.workers.delete(task.workerId);
    if (!this.disposed) {
      void this.spawnWorker()
        .then(() => this.processQueue())
        .catch((err) => {
          console.error('[worker-pool] Failed to respawn worker', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const taskId of [...this.tasks.keys()]) {
      this.takeTask(taskId)?.reject(new PoolDisposedError());
    }
    this.queue = [];
    const terminatePromises: Promise<number>[] = [];
    for (const [, entry] of this.workers) {
      terminatePromises.push(entry.worker.terminate());
    }
    this.workers.clear();
    await Promise.all(terminatePromises);
  }

  get activeCount(): number {
    let count = 0;
    for (const [, entry] of this.workers) {
      if (entry.busy) count++;
    }
    return count;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  private spawnWorker(): Promise<void> {
    const workerId = this.nextWorkerId++;
    const worker = new Worker(this.workerScript, {
      workerData: this.workerData,
      env: process.env,
    });
    const entry: WorkerEntry = { worker, busy: false, taskId: null };
    this.workers.set(workerId, entry);
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      worker.on('message', (msg: WorkerMessage) => {
        if (!ready) {
          if (msg && typeof msg === 'object' && msg.type === 'ready') {
            ready = true;
            resolve();
          }
          return;
        }
        this.handleMessage(workerId, msg);
      });
      worker.on('error', (err) => {
        if (!ready) {
          this.workers.delete(workerId);
          reject(err);
          return;
        }
        this.handleWorkerFailure(workerId);
      });
      worker.on('exit', (code) => {
        if (!ready) {
          this.workers.delete(workerId);
          reject(new Error(`Worker exited with code ${code} before ready`));
          return;
        }
        if (code !== 0) {
          this.handleWorkerFailure(workerId);
        }
      });
    });
  }

  private handleMessage(workerId: number, msg: WorkerMessage): void {
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    const entry = this.workers.get(workerId);
    if (!entry) return;
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
    if (this.disposed) return;
    void this.spawnWorker()
      .then(() => this.processQueue())
      .catch((err) => {
        console.error('[worker-pool] Failed to respawn worker', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private findIdleWorker(): number | null {
    for (const [workerId, entry] of this.workers) {
      if (!entry.busy) return workerId;
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
    if (!entry) return;
    entry.busy = true;
    entry.taskId = taskId;
    const task = this.tasks.get(taskId);
    if (task) {
      task.workerId = workerId;
    }
    entry.worker.postMessage(message);
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const idleWorkerId = this.findIdleWorker();
      if (idleWorkerId === null) break;
      const queued = this.queue.shift()!;
      this.dispatch(idleWorkerId, queued.taskId, queued.message);
    }
  }
}
