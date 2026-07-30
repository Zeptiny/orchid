/**
 * Dedicated bounded capacity for interactive get_function work.
 *
 * These jobs are intentionally not queued behind the generic tool worker
 * pool: callers either acquire one of two AST slots immediately or receive a
 * retryable capacity error. Aborting a job terminates its worker.
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  GetFunctionExtraction,
  GetFunctionExtractionRequest,
} from './get-function-extraction';

export const GET_FUNCTION_MAX_CONCURRENT = 2;

export class GetFunctionCapacityError extends Error {
  constructor() {
    super('get_function is busy; retry shortly.');
    this.name = 'GetFunctionCapacityError';
  }
}

export class GetFunctionWorkerCancelledError extends Error {
  constructor() {
    super('get_function extraction was cancelled.');
    this.name = 'GetFunctionWorkerCancelledError';
  }
}

interface WorkerLike {
  on(event: 'message', listener: (message: WorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

type WorkerMessage =
  | { type: 'result'; result: GetFunctionExtraction }
  | { type: 'error'; error: string };

type WorkerFactory = (workerPath: string, request: GetFunctionExtractionRequest) => WorkerLike;

export class GetFunctionWorkerRunner {
  private readonly active = new Set<WorkerLike>();

  constructor(
    private readonly workerPath: string,
    private readonly maxConcurrent = GET_FUNCTION_MAX_CONCURRENT,
    private readonly createWorker: WorkerFactory = (scriptPath, request) => new Worker(scriptPath, {
      workerData: request,
      env: process.env,
    }),
  ) {}

  run(
    request: GetFunctionExtractionRequest,
    signal?: AbortSignal,
  ): Promise<GetFunctionExtraction> {
    if (signal?.aborted) return Promise.reject(new GetFunctionWorkerCancelledError());
    if (this.active.size >= this.maxConcurrent) {
      return Promise.reject(new GetFunctionCapacityError());
    }
    let worker: WorkerLike;
    try {
      worker = this.createWorker(this.workerPath, request);
    } catch (error) {
      return Promise.reject(error);
    }
    this.active.add(worker);

    return new Promise<GetFunctionExtraction>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.active.delete(worker);
        signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = () => {
        finish(() => {
          void worker.terminate();
          reject(new GetFunctionWorkerCancelledError());
        });
      };

      signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', (message) => {
        if (message.type === 'result') {
          finish(() => {
            void worker.terminate();
            resolve(message.result);
          });
        } else {
          finish(() => {
            void worker.terminate();
            reject(new Error(message.error));
          });
        }
      });
      worker.on('error', (error) => finish(() => {
        void worker.terminate();
        reject(error);
      }));
      worker.on('exit', (code) => {
        finish(() => reject(new Error(`get_function worker exited unexpectedly with code ${code}`)));
      });
    });
  }

  get activeCount(): number {
    return this.active.size;
  }
}

const defaultRunner = new GetFunctionWorkerRunner(
  path.join(__dirname, 'get-function-worker.js'),
);

let testRunner: ((
  request: GetFunctionExtractionRequest,
  signal?: AbortSignal,
) => Promise<GetFunctionExtraction>) | null = null;

/** Execute an extraction in the dedicated AST worker capacity. */
export function runGetFunctionInWorker(
  request: GetFunctionExtractionRequest,
  signal?: AbortSignal,
): Promise<GetFunctionExtraction> {
  return testRunner ? testRunner(request, signal) : defaultRunner.run(request, signal);
}

/** Test-only seam; production always uses the dedicated worker runner. */
export function setGetFunctionWorkerRunnerForTests(
  runner: typeof testRunner,
): void {
  testRunner = runner;
}
