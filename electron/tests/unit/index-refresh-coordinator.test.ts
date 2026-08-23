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
 * - Sustained sub-window churn flushes once max-wait elapses (P3 #2)
 * - A rejected flush retries once via the dirty scan, then drops (P3 #3)
 * - A wedged index branch is abandoned after the watchdog timeout (P3 #4a)
 * - Both flags disabled drops a dirty batch (dead-term collapse, P3 #9)
 * - A sentinel collision requeues only the collided index's entries (minor)
 * - disposeAsync awaits in-flight flushes and latches producers off
 * - A config-resolution failure drops the batch without wedging the pipeline
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  enqueueMutation,
  markDirty,
  cancelProjectRefresh,
  disposeIndexRefreshCoordinator,
  disposeIndexRefreshCoordinatorAsync,
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
    upsertFiles: vi.fn(async (): Promise<RAGIndexResult> => ({ ...RAG_RESULT })),
    deleteFiles: vi.fn(async (): Promise<RAGIndexResult> => ({ ...RAG_RESULT })),
    indexProject: vi.fn(async (): Promise<RAGIndexResult> => ({ ...RAG_RESULT })),
  };
}

function makeAstIndexer(): RefreshAstIndexer {
  return {
    upsertFiles: vi.fn(async (): Promise<ASTIncrementalResult> => ({ ...AST_INCREMENTAL_RESULT })),
    deleteFiles: vi.fn(async (): Promise<number> => 0),
    indexProject: vi.fn(async (): Promise<ASTIndexResult> => ({ ...AST_RESULT })),
  };
}

let config: Config;
let projectConfigOverride: Config | null;
/** When true, the per-project config resolver throws (config-load-failure path). */
let configLoadFails: boolean;
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
  configLoadFails = false;
  trustState = 'trusted';
  rag = makeRagIndexer();
  ast = makeAstIndexer();
  _setIndexRefreshCoordinatorForTests({
    ragIndexer: rag,
    astIndexer: ast,
    // Simulates the runtime-registry project layer (the production default
    // resolves registry-first with a home-config fallback).
    projectConfigResolver: () => {
      if (configLoadFails) throw new Error('config resolver boom');
      return projectConfigOverride ?? config;
    },
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
    rag.upsertFiles.mockImplementationOnce(async (): Promise<RAGIndexResult> => ({
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
    rag.indexProject.mockImplementationOnce(async (): Promise<RAGIndexResult> => ({
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

  it('does not re-arm an in-flight flush cancelled mid-run when its sentinel lands', async () => {
    const gate = deferred<RAGIndexResult>();
    rag.upsertFiles.mockImplementationOnce(() => gate.promise);
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);

    // Cancel while the flush is mid-flight (trust revoked / index cleared).
    cancelProjectRefresh(PROJECT);

    // The sentinel resolves after the cancellation — the batch must not
    // requeue or re-arm, and the indexers must not be invoked again.
    gate.resolve({ ...RAG_RESULT, errors: ['Indexing already in progress'] });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('requeues deletes that hit the RAG single-flight sentinel', async () => {
    rag.deleteFiles.mockImplementationOnce(async (): Promise<RAGIndexResult> => ({
      ...RAG_RESULT,
      errors: ['Indexing already in progress'],
    }));

    enqueueMutation(PROJECT, [{ rel: 'src/gone.ts', op: 'delete' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.deleteFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [{ rel: 'src/gone.ts', op: 'delete' }],
      dirty: false,
      timerArmed: true,
      flushing: false,
    });

    // The re-armed debounce retries the delete after the in-flight run; the
    // other index does not repeat its already-applied delete.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.deleteFiles).toHaveBeenCalledTimes(2);
    expect(ast.deleteFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).entries).toEqual([]);
    expect(_getPendingIndexRefreshForTests(PROJECT).timerArmed).toBe(false);
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

  it('flushes despite continuous churn once max-wait elapses from the first enqueue', async () => {
    // Churn faster than the debounce window (1500 < 2000): each enqueue
    // restarts the timer, so without max-wait the batch would never flush.
    // maxWaitMs = max(DEBOUNCE_MS * 3, 10_000) = 10_000 from the first enqueue.
    const CHURN_MS = 1500;
    for (let i = 0; i < 7; i++) {
      if (i > 0) await vi.advanceTimersByTimeAsync(CHURN_MS);
      enqueueMutation(PROJECT, [{ rel: `src/a${i}.ts`, op: 'upsert' }]);
      expect(rag.upsertFiles).not.toHaveBeenCalled();
    }
    // t = 9000: elapsed 9000 < 10000, and the restarted timer never expired.
    expect(_getPendingIndexRefreshForTests(PROJECT).entries).toHaveLength(7);

    // t = 10500: elapsed 10500 >= 10000 → the flush runs immediately on
    // enqueue instead of restarting the timer yet again.
    await vi.advanceTimersByTimeAsync(CHURN_MS);
    enqueueMutation(PROJECT, [{ rel: 'src/a7.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/a0.ts', 'src/a1.ts', 'src/a2.ts', 'src/a3.ts', 'src/a4.ts', 'src/a5.ts', 'src/a6.ts', 'src/a7.ts'],
      config,
    });
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);

    // The anchor resets on drain: post-flush churn starts a fresh max-wait cycle.
    await vi.advanceTimersByTimeAsync(CHURN_MS);
    enqueueMutation(PROJECT, [{ rel: 'src/a8.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(2);
    expect(rag.upsertFiles).toHaveBeenLastCalledWith({
      projectPath: PROJECT,
      rels: ['src/a8.ts'],
      config,
    });
  });

  it('re-arms a dirty-scan retry when a flush rejects, then heals cleanly', async () => {
    rag.upsertFiles.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(warnSpy).toHaveBeenCalledWith('[index-refresh] rag refresh failed', expect.any(Error));
    // Failure → dirty flag re-set + flush re-armed (entries stay consumed:
    // the hash-diff scan is the self-heal).
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).dirty).toBe(true);
    expect(_getPendingIndexRefreshForTests(PROJECT).timerArmed).toBe(true);

    // The retry flush runs the dirty scan for both indexes and succeeds.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(ast.indexProject).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });

    // The retry budget was cleared on success: a later failure retries again.
    rag.upsertFiles.mockImplementationOnce(() => Promise.reject(new Error('boom-2')));
    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(_getPendingIndexRefreshForTests(PROJECT).dirty).toBe(true);
  });

  it('drops the batch after a second consecutive flush failure instead of retrying forever', async () => {
    rag.upsertFiles.mockImplementationOnce(() => Promise.reject(new Error('boom-1')));
    rag.indexProject.mockImplementationOnce(() => Promise.reject(new Error('boom-2')));

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // failure #1 → retry armed
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // retry fails → drop

    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[index-refresh] flush failed again; dropping batch', PROJECT);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });

    // No third attempt fires.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
  });

  it('abandons a wedged index branch after the watchdog timeout and keeps flushing', async () => {
    _setIndexRefreshCoordinatorForTests({
      ragIndexer: rag,
      astIndexer: ast,
      projectConfigResolver: () => {
        if (configLoadFails) throw new Error('config resolver boom');
        return projectConfigOverride ?? config;
      },
      trustStateResolver: () => trustState,
      flushTimeoutMs: 50,
    });
    const gate = deferred<void>();
    rag.upsertFiles.mockImplementationOnce(async () => {
      await gate.promise;
      return { ...RAG_RESULT };
    });

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).flushing).toBe(true);

    // The wedged RAG branch is abandoned after the (tiny) watchdog timeout;
    // the healthy AST branch completed and the flushing flag clears.
    await vi.advanceTimersByTimeAsync(50);
    expect(warnSpy).toHaveBeenCalledWith(
      '[index-refresh] rag refresh timed out after 50ms; abandoning branch',
    );
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).flushing).toBe(false);
    expect(_getPendingIndexRefreshForTests(PROJECT).timerArmed).toBe(false);

    // The pipeline keeps working: the next mutation flushes normally.
    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(2);
    expect(rag.upsertFiles).toHaveBeenLastCalledWith({
      projectPath: PROJECT,
      rels: ['src/b.ts'],
      config,
    });
  });

  it('drops a dirty batch when both indexes are disabled (dead-term collapse)', async () => {
    config = withIndexRefresh({ rag: false, ast: false });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(PROJECT);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();
    expect(ast.indexProject).not.toHaveBeenCalled();
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('requeues only RAG entries on a sentinel collision; AST entries stay consumed', async () => {
    rag.upsertFiles.mockImplementationOnce(async (): Promise<RAGIndexResult> => ({
      ...RAG_RESULT,
      errors: ['Indexing already in progress'],
    }));

    enqueueMutation(PROJECT, [
      { rel: 'src/a.ts', op: 'upsert' },
      { rel: 'src/b.ts', op: 'upsert' },
    ]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).entries).toEqual([
      { rel: 'src/a.ts', op: 'upsert' },
      { rel: 'src/b.ts', op: 'upsert' },
    ]);

    // Retry flush: RAG re-processes the batch…
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(2);
    expect(rag.upsertFiles).toHaveBeenLastCalledWith({
      projectPath: PROJECT,
      rels: ['src/a.ts', 'src/b.ts'],
      config,
    });
    // …but AST does not repeat its (idempotent, already-applied) upserts.
    expect(ast.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('does not re-set dirty when only the mutation upsert hit the sentinel', async () => {
    rag.upsertFiles.mockImplementationOnce(async (): Promise<RAGIndexResult> => ({
      ...RAG_RESULT,
      errors: ['Indexing already in progress'],
    }));

    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(PROJECT);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // The mutation upsert collided (re-enqueued rag-only for a retry) but the
    // dirty scan itself completed, so dirty stays consumed.
    expect(rag.indexProject).toHaveBeenCalledTimes(1);
    expect(ast.indexProject).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).dirty).toBe(false);
    expect(_getPendingIndexRefreshForTests(PROJECT).entries).toEqual([
      { rel: 'src/a.ts', op: 'upsert' },
    ]);
    expect(_getPendingIndexRefreshForTests(PROJECT).timerArmed).toBe(true);
  });

  it('disposeAsync awaits in-flight flushes and no-ops later producer calls (logged once)', async () => {
    const gate = deferred<void>();
    rag.upsertFiles.mockImplementationOnce(async () => {
      await gate.promise;
      return { ...RAG_RESULT };
    });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(_getPendingIndexRefreshForTests(PROJECT).flushing).toBe(true);

    const disposed = disposeIndexRefreshCoordinatorAsync();
    // Post-dispose producers are logged no-ops — logged once, not per call.
    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    markDirty(PROJECT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[index-refresh] coordinator disposed; ignoring index refresh requests',
    );

    gate.resolve();
    await disposed;
    expect(_getPendingIndexRefreshForTests(PROJECT).flushing).toBe(false);

    // The drained timer is gone and nothing new ever flushes.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.indexProject).not.toHaveBeenCalled();
  });

  it('disposeAsync caps its wait for a wedged in-flight flush at 5s', async () => {
    const gate = deferred<void>();
    rag.upsertFiles.mockImplementationOnce(async () => {
      await gate.promise;
      return { ...RAG_RESULT };
    });
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(_getPendingIndexRefreshForTests(PROJECT).flushing).toBe(true);

    const disposed = disposeIndexRefreshCoordinatorAsync();
    let settled = false;
    void disposed.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await disposed;
    expect(settled).toBe(true);
  });

  it('drops the batch when config resolution throws, and later enqueues flush again', async () => {
    configLoadFails = true;
    enqueueMutation(PROJECT, [{ rel: 'src/a.ts', op: 'upsert' }]);
    markDirty(PROJECT);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(warnSpy).toHaveBeenCalledWith(
      '[index-refresh] config load failed; dropping batch',
      expect.any(Error),
    );
    expect(rag.upsertFiles).not.toHaveBeenCalled();
    expect(rag.indexProject).not.toHaveBeenCalled();
    expect(ast.upsertFiles).not.toHaveBeenCalled();
    expect(ast.indexProject).not.toHaveBeenCalled();
    expect(_getPendingIndexRefreshForTests(PROJECT)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });

    // A working resolver revives the pipeline for later mutations.
    configLoadFails = false;
    enqueueMutation(PROJECT, [{ rel: 'src/b.ts', op: 'upsert' }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rag.upsertFiles).toHaveBeenCalledTimes(1);
    expect(rag.upsertFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      rels: ['src/b.ts'],
      config,
    });
  });
});
