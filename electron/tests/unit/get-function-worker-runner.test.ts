import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GetFunctionCapacityError,
  GetFunctionWorkerCancelledError,
  GetFunctionWorkerRunner,
} from '../../src/main/tools/ast/get-function-worker-runner';

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 0);
}

const existingScript = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'worker-pool-test-worker.cjs',
);
const request = { filePath: '/tmp/example.py', functionName: 'example', maxFileSize: 1_024 };
const extraction = {
  importsText: '',
  functions: [{
    name: 'example', startLine: 1, endLine: 2, body: 'def example(): pass', classContext: '',
  }],
};

describe('GetFunctionWorkerRunner', () => {
  it('runs extraction in its dedicated worker and frees the slot on completion', async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker);
    const runner = new GetFunctionWorkerRunner(existingScript, 1, createWorker);

    const pending = runner.run(request);
    expect(createWorker).toHaveBeenCalledWith(existingScript, request);
    expect(runner.activeCount).toBe(1);
    worker.emit('message', { type: 'result', result: extraction });

    await expect(pending).resolves.toEqual(extraction);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(runner.activeCount).toBe(0);
  });

  it('terminates the active worker when the parent signal aborts', async () => {
    const worker = new FakeWorker();
    const runner = new GetFunctionWorkerRunner(existingScript, 1, () => worker);
    const controller = new AbortController();
    const pending = runner.run(request, controller.signal);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(GetFunctionWorkerCancelledError);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(runner.activeCount).toBe(0);
  });

  it('rejects excess work instead of building an unbounded queue', async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker);
    const runner = new GetFunctionWorkerRunner(existingScript, 1, createWorker);

    const active = runner.run(request);
    await expect(runner.run(request)).rejects.toBeInstanceOf(GetFunctionCapacityError);
    expect(createWorker).toHaveBeenCalledOnce();

    worker.emit('message', { type: 'result', result: extraction });
    await expect(active).resolves.toEqual(extraction);
  });
});
