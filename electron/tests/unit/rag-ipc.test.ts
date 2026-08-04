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
    getRuntime: vi.fn(() => ({ projectDir: PROJECT_DIR, config: { rag: {} } })),
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
// so this fixture resolves as trusted to keep the suite on its own seams.
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
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
  mocks.getRuntime.mockClear();

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
    mocks.resolveBoundProjectPath.mockReturnValue(null);
    await expect(handler(IPC_CHANNELS.RAG_CLEAR)(event)).resolves.toEqual({
      status: 'cleared',
    });
    expect(mocks.cancelIndex).not.toHaveBeenCalled();
    expect(mocks.clearIndex).not.toHaveBeenCalled();
  });
});
