/**
 * Background-process exit marks the owning workspace dirty (P2 fix).
 *
 * A background execute_command "completes" at spawn time — tool dispatch
 * deliberately skips its dirty mark for background spawns (see
 * tool-dispatch-index-refresh.test.ts) — so the BackgroundProcessStore's
 * process-exit path is what re-arms the index refresh once the command's
 * writes have actually landed. These tests drive real spawned child
 * processes on a fresh store (the subagent-command-cleanup pattern) and
 * observe the coordinator state via `_getPendingIndexRefreshForTests`,
 * with the debounce pinned high so no flush fires mid-test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackgroundProcessStore } from '../../src/main/tools/process/background-store';
import { defaults } from '../../src/main/config';
import type { Config } from '../../src/main/config';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
  _getPendingIndexRefreshForTests,
  type RefreshAstIndexer,
  type RefreshRagIndexer,
} from '../../src/main/indexing/refresh-coordinator';
import type { RAGIndexResult, ASTIndexResult } from '../../src/shared/types/ipc-boundary';
import type { ASTIncrementalResult } from '../../src/main/ast/indexer';

const DEBOUNCE_MS = 60_000;

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

function makeRagIndexer(): RefreshRagIndexer {
  return {
    upsertFiles: async (): Promise<RAGIndexResult> => ({ ...RAG_RESULT }),
    deleteFiles: async (): Promise<void> => {},
    indexProject: async (): Promise<RAGIndexResult> => ({ ...RAG_RESULT }),
    touchAutoRefresh: () => {},
  };
}

function makeAstIndexer(): RefreshAstIndexer {
  return {
    upsertFiles: async (): Promise<ASTIncrementalResult> => ({ ...AST_INCREMENTAL_RESULT }),
    deleteFiles: async (): Promise<number> => 0,
    indexProject: async (): Promise<ASTIndexResult> => ({ ...AST_RESULT }),
    touchAutoRefresh: () => {},
  };
}

/** Poll until the entry exits (signal delivery is asynchronous). */
async function waitForExit(
  store: BackgroundProcessStore,
  procId: number,
  timeoutMs = 3000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = store.get(procId);
    if (!entry) return null;
    if (entry.exitCode !== null) return entry.exitCode;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return store.get(procId)?.exitCode ?? null;
}

describe('BackgroundProcessStore exit marks the owning workspace dirty', () => {
  let store: BackgroundProcessStore;
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-bg-exit-refresh-'));
    cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd);
    store = new BackgroundProcessStore();
    const config: Config = {
      ...defaults(),
      index_refresh: { ...defaults().index_refresh, debounce_ms: DEBOUNCE_MS },
    };
    _setIndexRefreshCoordinatorForTests({
      ragIndexer: makeRagIndexer(),
      astIndexer: makeAstIndexer(),
      configLoader: () => config,
    });
  });

  afterEach(() => {
    store.clear();
    disposeIndexRefreshCoordinator();
    _setIndexRefreshCoordinatorForTests({
      ragIndexer: null,
      astIndexer: null,
      configLoader: null,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not mark dirty at spawn time', async () => {
    await store.spawn('sleep 30', { cwd });

    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [],
      dirty: false,
      timerArmed: false,
      flushing: false,
    });
  });

  it('marks the owning workspace dirty when the process exits naturally', async () => {
    const procId = await store.spawn('exit 0', { cwd });
    expect(_getPendingIndexRefreshForTests(cwd).dirty).toBe(false);

    expect(await waitForExit(store, procId)).toBe(0);

    expect(_getPendingIndexRefreshForTests(cwd)).toEqual({
      entries: [],
      dirty: true,
      timerArmed: true,
      flushing: false,
    });
  });

  it('marks dirty when a still-running process is terminated', async () => {
    const procId = await store.spawn('sleep 30', { cwd });

    store.terminate(procId);
    expect(await waitForExit(store, procId)).not.toBe(0);

    expect(_getPendingIndexRefreshForTests(cwd).dirty).toBe(true);
  });

  it('marks an interactive (PTY) process workspace dirty at exit', async () => {
    const procId = await store.spawn('exit 0', { cwd, interactive: true });

    expect(await waitForExit(store, procId)).toBe(0);

    expect(_getPendingIndexRefreshForTests(cwd).dirty).toBe(true);
  });

  it('marks only the exiting process workspace, not sibling projects', async () => {
    const other = path.join(root, 'other-workspace');
    fs.mkdirSync(other);
    const exitedId = await store.spawn('exit 0', { cwd });
    await store.spawn('sleep 30', { cwd: other });

    expect(await waitForExit(store, exitedId)).toBe(0);

    expect(_getPendingIndexRefreshForTests(cwd).dirty).toBe(true);
    expect(_getPendingIndexRefreshForTests(other).dirty).toBe(false);
  });
});
