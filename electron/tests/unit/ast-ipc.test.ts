/**
 * AST IPC handler tests — zod, unbound workspace, in-progress guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const PROJECT_DIR = '/tmp/orchid-ast-ipc-project';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const status = vi.fn(() => ({
    totalFiles: 4,
    totalSymbols: 20,
    lastIndexed: null,
    lastIndexDuration: null,
    lastAutoRefresh: null,
  }));
  const dispose = vi.fn();

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
    ASTStore: vi.fn(function MockASTStore(this: {
      status: typeof status;
      dispose: typeof dispose;
    }) {
      this.status = status;
      this.dispose = dispose;
    }),
    status,
    dispose,
    getIndexState: vi.fn(() => ({ phase: 'idle' as const })),
    isIndexing: vi.fn(() => false),
    indexProject: vi.fn(async () => ({
      filesScanned: 2,
      filesIndexed: 2,
      filesSkipped: 0,
      filesDeleted: 0,
      symbolsExtracted: 8,
      errors: [],
      durationSeconds: 0.2,
    })),
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

vi.mock('../../src/main/ast/store', () => ({
  ASTStore: mocks.ASTStore,
}));

vi.mock('../../src/main/ast/indexer', () => ({
  getIndexState: mocks.getIndexState,
  isIndexing: mocks.isIndexing,
  indexProject: mocks.indexProject,
}));

let astIpc: typeof import('../../src/main/ipc/ast');

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.resolveBoundProjectPath.mockReset();
  mocks.resolveBoundProjectPath.mockReturnValue(PROJECT_DIR);
  mocks.status.mockClear();
  mocks.dispose.mockClear();
  mocks.ASTStore.mockClear();
  mocks.getIndexState.mockClear();
  mocks.isIndexing.mockReset();
  mocks.isIndexing.mockReturnValue(false);
  mocks.indexProject.mockClear();
  mocks.trustState.current = 'trusted';

  astIpc = await import('../../src/main/ipc/ast');
  astIpc.registerASTIPC();
});

afterEach(() => {
  astIpc.unregisterASTIPC();
});

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

const event = { sender: { id: 5 } };

describe('ast:status / ast:index_state', () => {
  it('returns empty status when unbound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    await expect(handler(IPC_CHANNELS.AST_STATUS)(event)).resolves.toEqual({
      totalFiles: 0,
      totalSymbols: 0,
      lastIndexed: null,
      lastIndexDuration: null,
      lastAutoRefresh: null,
    });
    expect(mocks.ASTStore).not.toHaveBeenCalled();
  });

  it('reads status from ASTStore for the bound project', async () => {
    const status = await handler(IPC_CHANNELS.AST_STATUS)(event);
    expect(mocks.ASTStore).toHaveBeenCalledWith(PROJECT_DIR);
    expect(status).toMatchObject({ totalFiles: 4, totalSymbols: 20 });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('disposes ASTStore when reading status fails', async () => {
    mocks.status.mockImplementationOnce(() => {
      throw new Error('status failed');
    });

    await expect(handler(IPC_CHANNELS.AST_STATUS)(event))
      .rejects.toThrow('status failed');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('passes project path to index state', async () => {
    await handler(IPC_CHANNELS.AST_INDEX_STATE)(event);
    expect(mocks.getIndexState).toHaveBeenCalledWith(PROJECT_DIR);
  });
});

describe('ast:index', () => {
  it('rejects invalid force payload', async () => {
    await expect(
      handler(IPC_CHANNELS.AST_INDEX)(event, { force: 1 }),
    ).rejects.toThrow(/Invalid ast:index payload/i);
  });

  it('returns no-folder error without indexing when unbound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    const result = await handler(IPC_CHANNELS.AST_INDEX)(event, {});
    expect(result).toMatchObject({
      filesIndexed: 0,
      errors: ['No project folder selected'],
    });
    expect(mocks.indexProject).not.toHaveBeenCalled();
  });

  it('returns already-in-progress without starting another run', async () => {
    mocks.isIndexing.mockReturnValue(true);

    const result = await handler(IPC_CHANNELS.AST_INDEX)(event, { force: true });
    expect(result).toMatchObject({
      errors: ['Indexing already in progress'],
    });
    expect(mocks.indexProject).not.toHaveBeenCalled();
  });

  it('indexes with force when bound', async () => {
    await handler(IPC_CHANNELS.AST_INDEX)(event, { force: true });

    expect(mocks.indexProject).toHaveBeenCalledWith({
      force: true,
      projectPath: PROJECT_DIR,
      progressCallback: expect.any(Function),
    });
  });
});

describe('ast trust gate (untrusted project)', () => {
  it('status returns the empty shape without opening the store', async () => {
    mocks.trustState.current = 'untrusted';

    await expect(handler(IPC_CHANNELS.AST_STATUS)(event)).resolves.toEqual({
      totalFiles: 0,
      totalSymbols: 0,
      lastIndexed: null,
      lastIndexDuration: null,
      lastAutoRefresh: null,
    });
    expect(mocks.ASTStore).not.toHaveBeenCalled();
  });

  it('index returns the not-trusted error without starting a run', async () => {
    mocks.trustState.current = 'untrusted';

    const result = await handler(IPC_CHANNELS.AST_INDEX)(event, { force: true });

    expect(result).toMatchObject({
      filesScanned: 0,
      filesIndexed: 0,
      symbolsExtracted: 0,
      errors: ['Project folder is not trusted'],
    });
    expect(mocks.indexProject).not.toHaveBeenCalled();
  });

  it.each(['untrusted', 'changed'] as const)(
    'treats a %s project as not trusted for status',
    async (state) => {
      mocks.trustState.current = state;

      await expect(handler(IPC_CHANNELS.AST_STATUS)(event)).resolves.toEqual({
        totalFiles: 0,
        totalSymbols: 0,
        lastIndexed: null,
        lastIndexDuration: null,
        lastAutoRefresh: null,
      });
      expect(mocks.ASTStore).not.toHaveBeenCalled();
    },
  );
});
