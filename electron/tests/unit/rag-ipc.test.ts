/**
 * RAG IPC handler tests — zod, unbound workspace, in-progress guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const PROJECT_DIR = '/tmp/orchid-rag-ipc-project';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    resolveBoundProjectPath: vi.fn((): string | null => PROJECT_DIR),
    getStatus: vi.fn(() => ({
      totalChunks: 10,
      totalFiles: 2,
      lastIndexed: '2026-01-01T00:00:00.000Z',
      lastIndexDuration: 1.5,
    })),
    getIndexState: vi.fn(() => ({ phase: 'idle' as const })),
    isIndexing: vi.fn(() => false),
    indexProject: vi.fn(async () => ({
      filesScanned: 1,
      filesIndexed: 1,
      filesSkipped: 0,
      filesDeleted: 0,
      chunksCreated: 3,
      errors: [],
      durationSeconds: 0.5,
    })),
    cancelIndex: vi.fn(async () => false),
    clearIndex: vi.fn(),
    cancelProjectRefreshAsync: vi.fn(async () => {}),
    getWorkspaceWatcherState: vi.fn((): { watching: boolean; refcount: number } => ({
      watching: false,
      refcount: 0,
    })),
    getRuntime: vi.fn(() => ({ projectDir: PROJECT_DIR, config: { rag: {} } })),
    trustState: { current: 'trusted' as 'trusted' | 'untrusted' | 'changed' },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: mocks.BrowserWindow,
}));

vi.mock('../../src/main/ipc/session', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
}));

// The trust gate is fail-closed for the mocked (non-existent) project dir,
// so this fixture defaults to trusted to keep the suite on its own seams.
// Tests flip `mocks.trustState.current` to exercise the untrusted branches.
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => mocks.trustState.current,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: mocks.getRuntime }),
}));

vi.mock('../../src/main/rag/indexer', () => ({
  getStatus: mocks.getStatus,
  getIndexState: mocks.getIndexState,
  isIndexing: mocks.isIndexing,
  indexProject: mocks.indexProject,
  cancelIndex: mocks.cancelIndex,
  clearIndex: mocks.clearIndex,
}));

vi.mock('../../src/main/indexing/refresh-coordinator', () => ({
  cancelProjectRefreshAsync: mocks.cancelProjectRefreshAsync,
}));

vi.mock('../../src/main/indexing/watcher', () => ({
  getWorkspaceWatcherState: mocks.getWorkspaceWatcherState,
}));

let ragIpc: typeof import('../../src/main/ipc/rag');

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.resolveBoundProjectPath.mockReset();
  mocks.resolveBoundProjectPath.mockReturnValue(PROJECT_DIR);
  mocks.getStatus.mockClear();
  mocks.getIndexState.mockClear();
  mocks.isIndexing.mockReset();
  mocks.isIndexing.mockReturnValue(false);
  mocks.indexProject.mockClear();
  mocks.cancelIndex.mockClear();
  mocks.clearIndex.mockClear();
  mocks.cancelProjectRefreshAsync.mockClear();
  mocks.getWorkspaceWatcherState.mockReset();
  mocks.getWorkspaceWatcherState.mockReturnValue({ watching: false, refcount: 0 });
  mocks.getRuntime.mockClear();
  mocks.trustState.current = 'trusted';

  ragIpc = await import('../../src/main/ipc/rag');
  ragIpc.registerRAGIPC();
});

afterEach(() => {
  ragIpc.unregisterRAGIPC();
});

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

const event = { sender: { id: 3 } };

describe('rag:status / rag:index_state', () => {
  it('returns empty status when unbound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    await expect(handler(IPC_CHANNELS.RAG_STATUS)(event)).resolves.toEqual({
      totalChunks: 0,
      totalFiles: 0,
      lastIndexed: null,
      lastIndexDuration: null,
    });
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('returns project status when bound', async () => {
    const status = await handler(IPC_CHANNELS.RAG_STATUS)(event);
    expect(mocks.getStatus).toHaveBeenCalledWith(PROJECT_DIR);
    expect(status).toMatchObject({ totalChunks: 10, totalFiles: 2 });
  });

  it('reports the workspace watcher slice on status', async () => {
    mocks.getWorkspaceWatcherState.mockReturnValue({ watching: true, refcount: 1 });

    const status = await handler(IPC_CHANNELS.RAG_STATUS)(event);
    expect(mocks.getWorkspaceWatcherState).toHaveBeenCalledWith(PROJECT_DIR);
    expect(status).toMatchObject({
      totalChunks: 10,
      totalFiles: 2,
      watcher: { watching: true },
    });
  });

  it('degrades to the plain store status when watcher introspection fails', async () => {
    mocks.getWorkspaceWatcherState.mockImplementation(() => {
      throw new Error('watcher unavailable');
    });

    const status = await handler(IPC_CHANNELS.RAG_STATUS)(event);
    expect(status).toEqual({
      totalChunks: 10,
      totalFiles: 2,
      lastIndexed: '2026-01-01T00:00:00.000Z',
      lastIndexDuration: 1.5,
    });
  });

  it('passes project path to index state', async () => {
    await handler(IPC_CHANNELS.RAG_INDEX_STATE)(event);
    expect(mocks.getIndexState).toHaveBeenCalledWith(PROJECT_DIR);
  });
});

describe('rag:index', () => {
  it('rejects invalid force payload', async () => {
    await expect(
      handler(IPC_CHANNELS.RAG_INDEX)(event, { force: 'yes' }),
    ).rejects.toThrow(/Invalid rag:index payload/i);
  });

  it('returns no-folder error without indexing when unbound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    const result = await handler(IPC_CHANNELS.RAG_INDEX)(event, {});
    expect(result).toMatchObject({
      filesIndexed: 0,
      errors: ['No project folder selected'],
    });
    expect(mocks.indexProject).not.toHaveBeenCalled();
  });

  it('returns already-in-progress without starting another run', async () => {
    mocks.isIndexing.mockReturnValue(true);

    const result = await handler(IPC_CHANNELS.RAG_INDEX)(event, { force: true });
    expect(result).toMatchObject({
      errors: ['Indexing already in progress'],
    });
    expect(mocks.indexProject).not.toHaveBeenCalled();
  });

  it('indexes with force and project config when bound', async () => {
    await handler(IPC_CHANNELS.RAG_INDEX)(event, { force: true });

    expect(mocks.indexProject).toHaveBeenCalledWith(
      PROJECT_DIR,
      undefined,
      true,
      undefined,
      expect.any(Function),
      { config: { rag: {} } },
    );
  });
});

describe('rag:clear', () => {
  it('clears only when a project is bound', async () => {
    await expect(handler(IPC_CHANNELS.RAG_CLEAR)(event)).resolves.toEqual({
      status: 'cleared',
    });
    expect(mocks.cancelIndex).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.clearIndex).toHaveBeenCalledWith(PROJECT_DIR);

    mocks.cancelIndex.mockClear();
    mocks.clearIndex.mockClear();
    mocks.cancelProjectRefreshAsync.mockClear();
    mocks.resolveBoundProjectPath.mockReturnValue(null);
    await expect(handler(IPC_CHANNELS.RAG_CLEAR)(event)).resolves.toEqual({
      status: 'cleared',
    });
    expect(mocks.cancelIndex).not.toHaveBeenCalled();
    expect(mocks.clearIndex).not.toHaveBeenCalled();
    expect(mocks.cancelProjectRefreshAsync).not.toHaveBeenCalled();
  });

  it('drains pending index refreshes after the run cancel, before the drop', async () => {
    await handler(IPC_CHANNELS.RAG_CLEAR)(event);

    expect(mocks.cancelProjectRefreshAsync).toHaveBeenCalledWith(PROJECT_DIR);
    // Drain runs once the in-flight run is cancelled (no new flush may start
    // from stale pending state) but strictly before the store is dropped.
    expect(mocks.cancelProjectRefreshAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.cancelIndex.mock.invocationCallOrder[0],
    );
    expect(mocks.cancelProjectRefreshAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearIndex.mock.invocationCallOrder[0],
    );
  });
});

// The rag_index tool's clear action shares the drain requirement; no dedicated
// rag_index tool behavior test exists, so it is covered here alongside the IPC
// path (the indexer/coordinator mocks apply module-graph-wide).
describe('rag_index tool clear', () => {
  it('drains pending index refreshes before clearing the store', async () => {
    const { ragIndexHandler } = await import('../../src/main/tools/rag/index');

    const outcome = await ragIndexHandler({ action: 'clear' }, { cwd: PROJECT_DIR });

    expect(outcome.status).toBe('complete');
    expect(mocks.cancelIndex).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.cancelProjectRefreshAsync).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.clearIndex).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.cancelProjectRefreshAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.cancelIndex.mock.invocationCallOrder[0],
    );
    expect(mocks.cancelProjectRefreshAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearIndex.mock.invocationCallOrder[0],
    );
  });
});

describe('rag trust gate (untrusted project)', () => {
  it('status returns the empty shape without reading the store', async () => {
    mocks.trustState.current = 'untrusted';

    await expect(handler(IPC_CHANNELS.RAG_STATUS)(event)).resolves.toEqual({
      totalChunks: 0,
      totalFiles: 0,
      lastIndexed: null,
      lastIndexDuration: null,
    });
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('index returns the not-trusted error without indexing', async () => {
    mocks.trustState.current = 'untrusted';

    const result = await handler(IPC_CHANNELS.RAG_INDEX)(event, { force: true });

    expect(result).toMatchObject({
      filesScanned: 0,
      filesIndexed: 0,
      errors: ['Project folder is not trusted'],
    });
    expect(mocks.indexProject).not.toHaveBeenCalled();
  });

  it('clear is a no-op that leaves the index untouched', async () => {
    mocks.trustState.current = 'untrusted';

    await expect(handler(IPC_CHANNELS.RAG_CLEAR)(event)).resolves.toEqual({
      status: 'cleared',
    });
    expect(mocks.cancelIndex).not.toHaveBeenCalled();
    expect(mocks.clearIndex).not.toHaveBeenCalled();
    expect(mocks.cancelProjectRefreshAsync).not.toHaveBeenCalled();
  });

  it.each(['untrusted', 'changed'] as const)(
    'treats a %s project as not trusted for status',
    async (state) => {
      mocks.trustState.current = state;

      await expect(handler(IPC_CHANNELS.RAG_STATUS)(event)).resolves.toEqual({
        totalChunks: 0,
        totalFiles: 0,
        lastIndexed: null,
        lastIndexDuration: null,
      });
      expect(mocks.getStatus).not.toHaveBeenCalled();
    },
  );
});
