/**
 * Shared useProviders cache: concurrent refresh calls share one list() IPC.
 * Runs in Node (no jsdom) via the test-only store surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();

function installOrchidApi() {
  vi.stubGlobal('window', {
    orchid: {
      providers: {
        list: listMock,
        modelList: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        submitApiKey: vi.fn(),
        validate: vi.fn(),
        disable: vi.fn(),
        enable: vi.fn(),
        disconnect: vi.fn(),
        refreshStatus: vi.fn(),
      },
    },
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

describe('useProviders shared cache', () => {
  beforeEach(() => {
    vi.resetModules();
    listMock.mockReset();
    installOrchidApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces concurrent list() calls and keeps overview warm', async () => {
    let resolveList: (value: unknown) => void = () => {};
    const listPromise = new Promise((resolve) => {
      resolveList = resolve;
    });
    listMock.mockReturnValueOnce(listPromise);

    const overview = {
      connections: [{ id: 'c1', health: 'ready', modelIds: ['m1'] }],
      statuses: [],
      catalog: { providers: [] },
    };

    const { __providersCacheTest } = await import('../../src/renderer/hooks/useProviders');
    __providersCacheTest.reset();

    const first = __providersCacheTest.refresh();
    const second = __providersCacheTest.refresh();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(__providersCacheTest.getState().status).toBe('loading');

    resolveList(overview);
    await Promise.all([first, second]);

    expect(__providersCacheTest.getState()).toEqual({
      status: 'ready',
      overview,
      error: null,
    });

    // Warm refresh keeps ready + previous overview while fetching.
    listMock.mockResolvedValueOnce({
      ...overview,
      connections: [{ id: 'c2', health: 'ready', modelIds: ['m2'] }],
    });
    const warm = __providersCacheTest.refresh();
    expect(__providersCacheTest.getState().status).toBe('ready');
    expect(__providersCacheTest.getState().overview).toEqual(overview);
    await warm;
    expect(__providersCacheTest.getState().overview?.connections[0]?.id).toBe('c2');
  });

  it('returns a stable getSnapshot reference between emits', async () => {
    listMock.mockResolvedValue({
      connections: [],
      statuses: [],
      catalog: { providers: [] },
    });
    const { __providersCacheTest } = await import('../../src/renderer/hooks/useProviders');
    __providersCacheTest.reset();
    await __providersCacheTest.refresh();

    const a = __providersCacheTest.getSnapshot();
    const b = __providersCacheTest.getSnapshot();
    expect(a).toBe(b);
  });

  it('ensureModelList caches after cold overview and coalesces', async () => {
    const overview = {
      connections: [{ id: 'c1', health: 'ready', modelIds: ['m1'] }],
      statuses: [],
      catalog: { providers: [] },
    };
    const models = [
      { selection: { connectionId: 'c1', modelId: 'm1' }, available: true },
    ];
    listMock.mockResolvedValue(overview);
    const modelListMock = vi.fn().mockResolvedValue(models);
    (window as unknown as { orchid: { providers: { modelList: typeof modelListMock } } })
      .orchid.providers.modelList = modelListMock;

    const { __providersCacheTest } = await import('../../src/renderer/hooks/useProviders');
    __providersCacheTest.reset();

    const first = __providersCacheTest.ensureModelList();
    const second = __providersCacheTest.ensureModelList();
    const [a, b] = await Promise.all([first, second]);
    expect(modelListMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(models);
    expect(b).toEqual(models);
    expect(__providersCacheTest.getModelOptions()).toEqual(models);

    // Cache hit
    await __providersCacheTest.ensureModelList();
    expect(modelListMock).toHaveBeenCalledTimes(1);
  });
});
