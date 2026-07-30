import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  executeToolCall,
  type ToolDispatchRequest,
} from '../../src/main/llm/tool-dispatch';
import { ToolRegistry } from '../../src/main/tools/registry';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';
import { WorkerTaskCancelledError } from '../../src/main/utils/worker-pool';

const workerPoolMock = vi.hoisted(() => ({
  pool: null as {
    runTask: ReturnType<typeof vi.fn>;
  } | null,
}));

vi.mock('../../src/main/llm/tool-pool', () => ({
  getToolWorkerPool: () => workerPoolMock.pool,
}));

const request: ToolDispatchRequest = {
  id: 'offloaded-cancel-call',
  name: 'offloaded',
  args: {},
};

describe('executeToolCall offloaded cancellation', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(
      {
        name: 'offloaded',
        riskClass: 'read-only',
        description: 'Offloaded test tool',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
        offload: true,
        noTimeout: true,
      },
      async () => ({ status: 'complete', data: { value: 'inline fallback' } }),
    );
  });

  afterEach(() => {
    workerPoolMock.pool = null;
  });

  it('passes parent cancellation through the offloaded worker signal', async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveWorker!: (value: unknown) => void;
    workerPoolMock.pool = {
      runTask: vi.fn(
        (
          _payload: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
          receivedSignal = options?.signal;
          const result = new Promise((resolve) => {
            resolveWorker = resolve;
          });
          result.catch(() => undefined);
          return {
            taskId: 0,
            started: Promise.resolve({ queueWaitMs: 0 }),
            result,
            timings: null,
          };
        },
      ),
    };
    const parentAbort = new AbortController();

    const pending = executeToolCall(request, registry, {
      cwd: '/tmp/orchid-tool-test-cwd',
      abortSignal: parentAbort.signal,
    });
    await vi.waitFor(() => expect(workerPoolMock.pool?.runTask).toHaveBeenCalledOnce());

    parentAbort.abort();

    expect(receivedSignal?.aborted).toBe(true);
    resolveWorker({ status: 'complete', data: { value: 'late result' } });
    await expect(pending).resolves.toMatchObject({
      canonical: { status: 'cancelled' },
    });
  });

  it('preserves timeout classification when the worker signal is aborted', async () => {
    registry.register(
      {
        name: 'timed_offload',
        riskClass: 'read-only',
        description: 'Timed offloaded test tool',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
        offload: true,
      },
      async () => ({ status: 'complete', data: { value: 'inline fallback' } }),
    );
    workerPoolMock.pool = {
      runTask: vi.fn(
        (
          _payload: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
          const result = new Promise((_, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new WorkerTaskCancelledError()),
              { once: true },
            );
          });
          result.catch(() => undefined);
          return {
            taskId: 0,
            started: Promise.resolve({ queueWaitMs: 0 }),
            result,
            timings: null,
          };
        },
      ),
    };

    const result = await executeToolCall(
      { ...request, id: 'timed-offload-call', name: 'timed_offload' },
      registry,
      { cwd: '/tmp/orchid-tool-test-cwd', timeoutSeconds: 0.05 },
    );

    expect(result.canonical.status).toBe('error');
    expect(result.canonical.error?.code).toBe('timeout');
  });

  it('classifies a cancel-before-start (started rejects) as cancelled, not handler error', async () => {
    registry.register(
      {
        name: 'queued_offload',
        riskClass: 'read-only',
        description: 'Offloaded tool cancelled while queued',
        inputSchema: z.object({}),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'test',
        offload: true,
      },
      async () => ({ status: 'complete', data: { value: 'inline fallback' } }),
    );
    // The worker pool rejects `started` when a queued task is cancelled before
    // a worker picks it up; `result` must also reject so the dispatch await
    // settles with WorkerTaskCancelledError.
    workerPoolMock.pool = {
      runTask: vi.fn(() => {
        const cancelled = Promise.reject(new WorkerTaskCancelledError());
        cancelled.catch(() => undefined);
        const started = Promise.reject(new WorkerTaskCancelledError());
        started.catch(() => undefined);
        return {
          taskId: 0,
          started,
          result: cancelled,
          timings: null,
        };
      }),
    };

    const result = await executeToolCall(
      { ...request, id: 'queued-offload-call', name: 'queued_offload' },
      registry,
      { cwd: '/tmp/orchid-tool-test-cwd' },
    );

    expect(result.canonical.status).toBe('cancelled');
  });
});
