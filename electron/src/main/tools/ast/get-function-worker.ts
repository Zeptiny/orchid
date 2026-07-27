/** Worker entry point for a single cancellable get_function extraction. */
import { parentPort, workerData } from 'node:worker_threads';
import {
  extractFunction,
  type GetFunctionExtractionRequest,
} from './get-function-extraction';

type WorkerOutbound =
  | { type: 'result'; result: Awaited<ReturnType<typeof extractFunction>> }
  | { type: 'error'; error: string };

function post(message: WorkerOutbound): void {
  parentPort?.postMessage(message);
}

extractFunction(workerData as GetFunctionExtractionRequest)
  .then((result) => post({ type: 'result', result }))
  .catch((error: unknown) => {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  });
