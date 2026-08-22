/**
 * Index refresh coordinator tests — U4.
 *
 * Covers:
 * - Bursts within the debounce window flush as one batch per index
 * - A late mutation restarts the debounce timer
 * - Delete-after-upsert for the same rel collapses to a single delete
 * - Concurrent flush attempts serialize (arrivals accumulate into the next batch)
 * - Per-index config flags gate their respective indexer calls
 * - Indexer rejection is swallowed, logged, and does not break the next flush
 * - markDirty triggers a full indexProject per enabled index
 * - Untrusted projects drop their batch (fail-closed trust gate)
 * - Project-level index_refresh config overrides are honored
 * - A RAG single-flight sentinel re-enqueues the drained batch for a retry
 * - dispose clears pending state
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  enqueueMutation,
  markDirty,
  cancelProjectRefresh,
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
  _getPendingIndexRefreshForTests,
  type RefreshRagIndexer,
  type RefreshAstIndexer,
} from '../../src/main/indexing/refresh-coordinator';
import { defaults } from '../../src/main/config';
import type { Config } from '../../src/main/config';
import type { TrustState } from '../../src/shared/types/ipc';
import type {
  RAGIndexResult,
  ASTIndexResult,
} from '../../src/shared/types/ipc-boundary';
import type { ASTIncrementalResult } from '../../src/main/ast/indexer';

const PROJECT = path.resolve('/tmp/orchid-index-refresh-proj');
const DEBOUNCE_MS = 2000;

const RAG_RESULT: RAGIndexResult = {
  filesScanned: 0,
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  chunksCreated: 0,
  errors: [],
  durationSeconds: 0,
};

const AST_RESULT: ASTIndexResult = {
  filesScanned: 0,
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  symbolsExtracted: 0,
  errors: [],
  durationSeconds: 0,
};

const AST_INCREMENTAL_RESULT: ASTIncrementalResult = {
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  symbolsExtracted: 0,
  errors: [],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeRagIndexer(): RefreshRagIndexer {
  return {
    upsertFiles: vi.fn(async (): RAGIndexResult => ({ ...RAG_RESULT })),
    deleteFiles: vi.fn(async (): Promise<void> => {}),
    indexProject: vi.fn(async (): RAGIndexResult => ({ ...RAG_RESULT })),
  };
}

function makeAstIndexer(): RefreshAstIndexer {
  return {
    upsertFiles: vi.fn(async (): ASTIncrementalResult => ({ ...AST_INCREMENTAL_RESULT })),
    deleteFiles: vi.fn(async (): Promise<number> => 0),
    indexProject: vi.fn(async (): ASTIndexResult => ({ ...AST_RESULT })),
  };
}

let config: Config;
let projectConfigOverride: Config | null;
let trustState: TrustState;
let rag: RefreshRagIndexer;
let ast: RefreshAstIndexer;
let warnSpy: ReturnType<typeof vi.spyOn>;

function withIndexRefresh(overrides: Partial<Config['index_refresh']>): Config {
  return {
    ...defaults(),
    index_refresh: { ...defaults().index_refresh, ...overrides },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  config = withIndexRefresh({ debounce_ms: DEBOUNCE_MS });
  projectConfigOverride = null;
  trustState = 'trusted';
  rag = makeRagIndexer();
  ast = makeAstIndexer();
  _setIndexRefreshCoordinatorForTests({
    ragIndexer: rag,
    astIndexer: ast,
    // Simulates the runtime-registry project layer (the production default
    // resolves registry-first with a home-config fallback).
    projectConfigResolver: () => projectConfigOverride ?? config,
    trustStateResolver: () => trustState,
  });
});

afterEach(() => {
  disposeIndexRefreshCoordinator();
  _setIndexRefreshCoordinatorForTests({
    ragIndexer: null,
    astIndexer: null,
    configLoader: null,
  });
  warnSpy.mockRestore();
  vi.useRealTimers();
});

describe('index refresh coordinator', () => {
  it('flushes a burst within the debounce window as one batch per index', async () => {
    enqueueMutation(PROJECT, [
      { rel: 'src/a.ts', op: 'upsert' },
      { rel: 'src/b.ts', op: 'upsert' },
    ]);
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    enqueueMutation(PROJECT, [{ rel: 'src/old.ts', op: 'delete' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts', 'src/b.ts'],
      config,
    });
    expect(rag.deleteFiles).toHaveBeenCalledTimes(1);
    expect(rag.deleteFiles).toHaveBeenCalledWith(PROJECT, ['src/old.ts']);
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(ast.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts', 'src/b.ts'],
      config,
    });
    expect(ast.deleteFiles).toHaveBeenCalledWith(PROJECT, ['src/old.ts']);
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.indexProject).not.toHaveBeenCalled();
  });

  it('restarts the debounce timer on a late mutation', async () => {
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);

    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(rag.upsertFiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts', 'src/b.ts'],
      config,
    });
  });

  it('collapses a delete-after-upsert for the same rel to a single delete', async () => {
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'delete' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.deleteFiles).toHaveBeenCalledTimes(1);
    expect(rag.deleteFiles).toHaveBeenCalledWith(PROJECT, ['src/a.ts']);
    expect(ast.upsertFiles).not.toHaveBeenCalled();
    expect(ast.deleteFiles).toHaveBeenCalledWith(PROJECT, ['src/a.ts']);
  });

  it('collapses an upsert-after-delete for the same rel to a single upsert', async () => {
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'delete' }]);
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.deleteFiles).not.toHaveBeenCalled();
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts'],
      config,
    });
  });

  it('serializes flushes: arrivals during a run accumulate into the next batch', async () => {
    const gate = deferred<void>();
    rag.upsertFiles.mockImplementationOnce(async () => {
      await gate.promise;
      return { ...RAG_RESULT };
    });

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);

    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).entries).toEqual([
      { rel: 'src/b.ts', op: 'upsert' },
    ]);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(2);
    expect(rag.upsertFiles).toHaveBeenLastCalledWith({
      projectPath: PROJECT,
      rels: ['src/b.ts'],
      config,
    });
  });

  it('gates RAG calls when index_refresh.rag is false', async () => {
    config = withIndexRefresh({ rag: false });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.deleteFiles).not.toHaveBeenCalled();
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(ast.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts'],
      config,
    });
  });

  it('gates AST calls when index_refresh.ast is false', async () => {
    config = withIndexRefresh({ ast: false });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(ast.upsertFiles).not.toHaveBeenCalled();
    expect(ast.deleteFiles).not.toHaveBeenCalled();
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts'],
      config,
    });
  });

  it('drops the batch when both indexes are disabled', async () => {
    config = withIndexRefresh({ rag: false, ast: false });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.indexProject).not.toHaveBeenCalled();
  });

  it('swallows and logs an indexer rejection without breaking the next flush', async () => {
    rag.upsertFiles.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(warnSpy).toHaveBeenCalledWith(
      '[index-refresh] rag refresh failed',
      expect.any(Error),
    );
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).flushing).toBe(false);

    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(2);
    expect(rag.upsertFiles).toHaveBeenLastCalledWith({
      projectPath: PROJECT,
      rels: ['src/b.ts'],
      config,
    });
  });

  it('runs a full scan per enabled index when markDirty flushed', async () => {
    markDirty(PROJECT);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(rag.indexProject).toHaveBeenCalledWith(
      PROJECT,
      undefined,
      false,
      undefined,
      undefined,
      { config },
    );
    expect(ast.indexProject).toHaveBeenCalledTimes(1);
    expect(ast.indexProject).toHaveBeenCalledWith({ projectPath: PROJECT, config });
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();
  });

  it('gates the dirty scan per index flag', async () => {
    config = withIndexRefresh({ rag: false });
    markDirty(PROJECT);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.indexProject).toHaveBeenCalledTimes(1);
  });

  it('flushes queued mutations together with a dirty scan', async () => {
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(PROJECT);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(ast.indexProject).toHaveBeenCalledTimes(1);
  });

  it('drops the batch when the project is not trusted', async () => {
    trustState = 'untrusted';
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(PROJECT);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.deleteFiles).not.toHaveBeenCalled();
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();
    expect(ast.indexProject).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[index-refresh] project not trusted; dropping batch',
      PROJECT,
    );
    // The drained batch is dropped, not re-armed.
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('honors project-level index_refresh config over the home config', async () => {
    projectConfigOverride = withIndexRefresh({ rag: false });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(ast.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts'],
      config: projectConfigOverride,
    });
  });

  it('re-enqueues a drained batch when RAG reports the single-flight sentinel', async () => {
    rag.upsertFiles.mockImplementationOnce(async (): RAGIndexResult => ({
      ...RAG_RESULT,
      errors: ['Indexing already in progress'],
    }));

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [{ rel: 'src/a.ts', op: 'upsert' }],
      dirty: false,
      timerArmed: true,
      flushing: false,
    });

    // The re-armed debounce retries the batch after the in-flight run.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(2);
    expect(rag.upsertFiles).toHaveBeenLastCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts'],
      config,
    });
    expect(_getPendingIndexRefreshForTests(PROJECT).entries).toEqual([]);
    expect(_getPendingIndexRefreshForTests(PROJECT).timerArmed).toBe(false);
  });

  it('re-sets the dirty flag when the RAG dirty scan reports the sentinel', async () => {
    rag.indexProject.mockImplementationOnce(async (): RAGIndexResult => ({
      ...RAG_RESULT,
      errors: ['Indexing already in progress'],
    }));

    markDirty(PROJECT);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.indexProject).toHaveBeenCalledTimes(2);
    expect(_getPendingIndexRefreshForTests(PROJECT).dirty).toBe(false);
  });

  it('cancels one project without touching other projects pending state', async () => {
    const other = path.resolve('/tmp/orchid-index-refresh-other');
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(other);

    cancelProjectRefresh(PROJECT);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
    expect(_getPendingIndexRefreshForTests(other).timerArmed).toBe(true);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(rag.indexProject).toHaveBeenCalledWith(
      other,
      undefined,
      false,
      undefined,
      undefined,
      { config },
    );
  });

  it('clears pending state on dispose', async () => {
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(PROJECT);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [{ rel: 'src/a.ts', op: 'upsert' }],
      dirty: true,
      timerArmed: true,
      flushing: false,
    });

    disposeIndexRefreshCoordinator();
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();
  });
});
