import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const instances: Array<{
    init: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];

  const initImpl = vi.fn(async () => undefined);

  class WorkerPool {
    readonly init = vi.fn(() => initImpl());
    readonly dispose = vi.fn(async () => undefined);

    constructor(..._args: unknown[]) {
      instances.push(this);
    }
  }

  return {
    existsSync: vi.fn(),
    initImpl,
    instances,
    WorkerPool,
  };
});

vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('../../src/main/utils/worker-pool', () => ({ WorkerPool: mocks.WorkerPool }));

let toolPool: typeof import('../../src/main/llm/tool-pool');

const config = {
  tool_worker_pool_size: 2,
  tool_worker_pool_main_agent_reserved: 1,
} as Parameters<typeof import('../../src/main/llm/tool-pool').initToolWorkerPool>[0];

beforeEach(async () => {
  vi.resetModules();
  mocks.existsSync.mockReset();
  mocks.initImpl.mockReset();
  mocks.initImpl.mockResolvedValue(undefined);
  mocks.instances.splice(0);
  toolPool = await import('../../src/main/llm/tool-pool');
});

afterEach(async () => {
  await toolPool.disposeToolWorkerPool();
});

describe('tool worker pool startup lifecycle', () => {
  it('reports disabled without constructing workers', async () => {
    await expect(toolPool.initToolWorkerPool(config, 0)).resolves.toEqual({ status: 'disabled' });

    expect(mocks.instances).toHaveLength(0);
    expect(toolPool.getToolWorkerPool()).toBeNull();
  });

  it('reports ready only after initialization and publishes the pool then', async () => {
    mocks.existsSync.mockReturnValue(true);
    let resolveInit!: () => void;
    const pendingInit = new Promise<void>((resolve) => { resolveInit = resolve; });
    mocks.initImpl.mockImplementationOnce(() => pendingInit);

    const startup = toolPool.initToolWorkerPool(config, 2);
    expect(toolPool.getToolWorkerPool()).toBeNull();
    resolveInit();

    await expect(startup).resolves.toEqual({ status: 'ready' });
    expect(toolPool.getToolWorkerPool()).toBe(mocks.instances[0]);
  });

  it('reports unavailable and leaves inline fallback selected when the script or initialization is unavailable', async () => {
    mocks.existsSync.mockReturnValue(false);
    await expect(toolPool.initToolWorkerPool(config, 2)).resolves.toEqual({ status: 'unavailable' });
    expect(toolPool.getToolWorkerPool()).toBeNull();

    mocks.existsSync.mockReturnValue(true);
    mocks.initImpl.mockRejectedValueOnce(new Error('worker init failed'));
    await expect(toolPool.initToolWorkerPool(config, 2)).resolves.toEqual({ status: 'unavailable' });
    expect(toolPool.getToolWorkerPool()).toBeNull();
  });

  it('serializes concurrent initialization requests into one candidate', async () => {
    mocks.existsSync.mockReturnValue(true);
    let resolveInit!: () => void;
    mocks.initImpl.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveInit = resolve;
    }));

    const first = toolPool.initToolWorkerPool(config, 2);
    const second = toolPool.initToolWorkerPool(config, 2);
    resolveInit();

    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'ready' }, { status: 'ready' }]);
    expect(mocks.instances).toHaveLength(1);
  });

  it('disposes an initializing candidate exactly once', async () => {
    mocks.existsSync.mockReturnValue(true);
    let resolveInit!: () => void;
    mocks.initImpl.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveInit = resolve;
    }));

    const startup = toolPool.initToolWorkerPool(config, 2);
    const dispose = toolPool.disposeToolWorkerPool();
    resolveInit();
    await Promise.all([startup, dispose]);

    expect(mocks.instances[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(toolPool.getToolWorkerPool()).toBeNull();
  });

  it('disposes a ready candidate exactly once', async () => {
    mocks.existsSync.mockReturnValue(true);
    await expect(toolPool.initToolWorkerPool(config, 2)).resolves.toEqual({ status: 'ready' });

    await Promise.all([
      toolPool.disposeToolWorkerPool(),
      toolPool.disposeToolWorkerPool(),
    ]);

    expect(mocks.instances[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(toolPool.getToolWorkerPool()).toBeNull();
  });
});
