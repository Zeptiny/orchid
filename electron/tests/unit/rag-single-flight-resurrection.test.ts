/**
 * RAG single-flight slot — late progress frame regression.
 *
 * Pins the reliability bug where an index worker that posts one more
 * progress frame AFTER `awaitWorkerRun` has settled re-inserted the
 * project's `activeIndexes` entry through `noteProgress`, so the slot
 * never cleared and every future `indexProject` for that project wedge
 * on the "Indexing already in progress" sentinel forever.
 *
 * The run itself succeeds; only the late frame resurrects the already
 * released slot. A real worker makes this exact ordering non-deterministic
 * (the resurrection depends on the worker's late frame landing after the
 * caller's finally block runs), so the worker thread is stubbed with a
 * controllable EventEmitter — the same seam the watchdog and op-protocol
 * tests drive through the `workerPath` hook. Only the single-flight and
 * worker-settle bookkeeping under test is exercised; the pipeline stages
 * never run because the fake worker short-circuits the real thread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RAGIndexProgress, RAGIndexResult } from '../../src/shared/types/ipc-boundary';

const mockConfig = {
  rag: { embedding_model: 'test-model' },
  ignored_dirs: [] as string[],
};

vi.mock('../../src/main/config/loader', () => ({ getConfig: () => mockConfig }));
vi.mock('../../src/main/config', () => ({ getConfig: () => mockConfig }));

// Store + embedder mocks keep the native modules out of the import graph;
// the worker path never touches them on the calling thread.
vi.mock('../../src/main/rag/store', () => ({ RAGStore: class {} }));
vi.mock('../../src/main/rag/embedder', () => ({
  Embedder: class {},
  createEmbedderFromConfig: async () => ({}),
  removeModelDownloadTemps: async () => {},
}));

interface FakeRagWorker {
  emit(event: 'message', payload: unknown): boolean;
  terminate(): Promise<number>;
}

const createdWorkers = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeRagWorkerClass extends EventEmitter {
    readonly terminate = vi.fn(async () => 0);
    constructor(..._args: unknown[]) {
      super();
      createdWorkers.list.push(this);
    }
  }
  return { Worker: FakeRagWorkerClass };
});

import { indexProject, isIndexing } from '../../src/main/rag/indexer';

const ZEROED_RESULT: RAGIndexResult = {
  filesScanned: 0,
  filesIndexed: 0,
  filesSkipped: 0,
  filesDeleted: 0,
  chunksCreated: 0,
  errors: [],
  durationSeconds: 0,
};

const PROGRESS_FRAME: RAGIndexProgress = {
  phase: 'indexing',
  done: 1,
  total: 1,
  filesIndexed: 1,
  filesSkipped: 0,
  chunksCreated: 0,
  filesDeleted: 0,
  elapsedSeconds: 0,
};

describe('RAG index single-flight slot (late progress frame)', () => {
  let tmpDir: string;

  // Any existing file works — the fake Worker ignores the entry path; it only
  // needs to satisfy the fs.existsSync gate that routes onto the worker thread.
  const workerPath = path.join(__dirname, '../fixtures/rag-stalled-worker.cjs');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-single-flight-'));
    createdWorkers.list.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a progress frame arriving after the run settles does not resurrect the slot', async () => {
    expect(isIndexing(tmpDir)).toBe(false);

    const pending = indexProject(tmpDir, undefined, undefined, undefined, undefined, {
      workerPath,
    });

    // The slot is claimed synchronously and the worker is on the wire.
    expect(isIndexing(tmpDir)).toBe(true);
    const worker = createdWorkers.list[0] as FakeRagWorker | undefined;
    expect(worker).toBeDefined();

    worker!.emit('message', { type: 'result', result: ZEROED_RESULT });
    await expect(pending).resolves.toMatchObject({ errors: [] });

    // Settling released the slot.
    expect(isIndexing(tmpDir)).toBe(false);

    // The bug: one more progress frame AFTER settle used to flow into
    // noteProgress and re-claim the slot forever.
    worker!.emit('message', { type: 'progress', progress: PROGRESS_FRAME });
    expect(isIndexing(tmpDir)).toBe(false);

    // A subsequent index must not wedge on the in-progress sentinel.
    const retry = indexProject(tmpDir, undefined, undefined, undefined, undefined, {
      workerPath,
    });
    expect(isIndexing(tmpDir)).toBe(true);
    const retryWorker = createdWorkers.list[1] as FakeRagWorker | undefined;
    expect(retryWorker).toBeDefined();
    retryWorker!.emit('message', { type: 'result', result: ZEROED_RESULT });
    await expect(retry).resolves.toMatchObject({ errors: [] });
    expect(isIndexing(tmpDir)).toBe(false);
  });
});
