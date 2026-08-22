/**
 * RAG compiled-worker smoke — the real end-to-end worker-thread path.
 *
 * The worker wire contract (op/rels/config on workerData, progress/result/
 * error messages back) is already proven against echo-worker fixtures in
 * rag-pipeline.test.ts. This suite closes the remaining gap: it runs the
 * REAL compiled worker — dist/main/rag/index-worker.js — in an actual
 * worker_threads Worker through the production entry points (upsertFiles /
 * deleteFiles with no embedder and no inline flag), so runUpsertFilesImpl
 * and runDeleteFilesImpl execute on a worker thread with real better-sqlite3
 * and the real local ONNX embedder. Assertions then read the resulting
 * store directly on the test thread.
 *
 * Gated — the whole suite skips cleanly unless BOTH hold:
 *
 * 1. The compiled worker exists at dist/main/rag/index-worker.js
 *    (from electron/: `npm run build:main`). CI does not build dist, so
 *    the suite skips there by design.
 * 2. A local embedding model is already downloaded under
 *    ~/.orchid/models/<id>/model.onnx, probed with resolveEmbeddingModelIds
 *    exactly the way the embedder's resolveModelPath resolves candidates
 *    (storageId dir first, legacy bare-hub dir second). The suite never
 *    downloads the ~130MB model — production upserts auto-download missing
 *    models on first use, which is unacceptable in a test environment.
 *
 * Because vitest executes the TypeScript sources (not dist/), the source
 * side of upsertFiles/deleteFiles resolves its default worker entry to
 * src/main/rag/index-worker.js, which does not exist — the production
 * fallback would silently run inline. The workerPath override (the same
 * test-only hook the watchdog and op-protocol tests use) therefore points
 * every dispatch at the compiled artifact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../src/main/config/schema';
import type { RAGIndexResult } from '../../src/shared/types/ipc-boundary';
import { deleteFiles, upsertFiles } from '../../src/main/rag/indexer';
import {
  BUILTIN_LOCAL_EMBEDDING_MODELS,
  resolveEmbeddingModelIds,
} from '../../src/main/rag/embedder';
import { RAGStore } from '../../src/main/rag/store';

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const WORKER_PATH = path.join(__dirname, '../../dist/main/rag/index-worker.js');
const WORKER_PRESENT = fs.existsSync(WORKER_PATH);

/**
 * First built-in local embedding model whose model.onnx is already on disk,
 * or null when none is installed. Mirrors the candidate order of the
 * embedder's resolveModelPath so the probe and the worker agree on what
 * "the model is available" means.
 */
function probeLocalEmbeddingModel(): string | null {
  const modelsRoot = path.join(os.homedir(), '.orchid', 'models');
  for (const model of BUILTIN_LOCAL_EMBEDDING_MODELS) {
    const { storageId, hubId } = resolveEmbeddingModelIds(model);
    const candidates = [path.join(modelsRoot, storageId, 'model.onnx')];
    if (storageId !== hubId) {
      candidates.push(path.join(modelsRoot, hubId, 'model.onnx'));
    }
    if (candidates.some((candidate) => fs.existsSync(candidate))) {
      return model;
    }
  }
  return null;
}

const EMBEDDING_MODEL = probeLocalEmbeddingModel();
const MODEL_AVAILABLE = EMBEDDING_MODEL !== null;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!WORKER_PRESENT || !MODEL_AVAILABLE)(
  'RAG compiled worker (end-to-end smoke)',
  () => {
    let tmpDir: string;

    /**
     * Frozen, secret-free project config serialized onto workerData — the
     * production "caller freezes the runtime config" path. Passing it also
     * keeps the worker from loading the developer's real ~/.orchid config.
     */
    const workerConfig = {
      rag: {
        embedding_model: EMBEDDING_MODEL,
        chunk_size: 2000,
        chunk_overlap: 200,
        max_file_size: 1_000_000,
      },
      ignored_dirs: [],
    } as unknown as Config;

    const md5 = (content: string): string =>
      crypto.createHash('md5').update(content).digest('hex');

    function makeTmpDir(): string {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'rag-worker-smoke-'));
    }

    function writeFile(relPath: string, content: string): void {
      const absPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
    }

    /** Index the given rels through the compiled worker (production path). */
    function upsertViaWorker(rels: string[]): Promise<RAGIndexResult> {
      return upsertFiles({
        projectPath: tmpDir,
        rels,
        config: workerConfig,
        workerPath: WORKER_PATH,
      });
    }

    beforeEach(() => {
      tmpDir = makeTmpDir();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it(
      'upsertFiles lands chunks, hashes, and vectors through the compiled worker',
      async () => {
        const contents = {
          'src/alpha.ts': 'const alphaWorker = 1;',
          'src/beta.ts': 'export const betaWorker = "beta";',
          'notes.txt': 'worker smoke notes about the alpha worker',
        };
        for (const [rel, content] of Object.entries(contents)) {
          writeFile(rel, content);
        }

        const result = await upsertViaWorker(Object.keys(contents));

        expect(result.errors).toEqual([]);
        expect(result.filesScanned).toBe(3);
        expect(result.filesIndexed).toBe(3);
        expect(result.filesSkipped).toBe(0);
        expect(result.filesDeleted).toBe(0);
        // One chunk per tiny file at chunk_size 2000.
        expect(result.chunksCreated).toBe(3);

        const store = new RAGStore(tmpDir);
        const status = store.status();
        expect(status.totalFiles).toBe(3);
        expect(status.totalChunks).toBe(3);

        // Hashes landed for every file, keyed by project-relative path.
        const hashes = store.getFileHashes();
        for (const [rel, content] of Object.entries(contents)) {
          expect(hashes.get(rel)).toBe(md5(content));
        }

        // Vectors flushed and aligned: real ONNX embeddings, sidecar intact.
        const state = store.loadVectorState();
        expect(state.consistent).toBe(true);
        expect(state.chunkIds).toHaveLength(3);
        expect(state.vectors).toHaveLength(3);
        expect(state.vectors[0]!.length).toBeGreaterThan(0);
        expect(fs.existsSync(store.vectorsFile)).toBe(true);
        expect(fs.existsSync(store.vectorIdsFile)).toBe(true);
      },
      120_000,
    );

    it(
      'deleteFiles removes rows and vectors through the compiled worker',
      async () => {
        writeFile('src/alpha.ts', 'const alphaGone = 1;');
        writeFile('src/beta.ts', 'const betaKept = 2;');
        writeFile('notes.txt', 'kept notes');
        await upsertViaWorker(['src/alpha.ts', 'src/beta.ts', 'notes.txt']);
        expect(new RAGStore(tmpDir).status().totalChunks).toBe(3);

        // No inline flag — the delete op dispatches to the worker thread
        // (workerPath points at the compiled artifact; see the header).
        await deleteFiles(tmpDir, ['src/alpha.ts'], { workerPath: WORKER_PATH });

        const store = new RAGStore(tmpDir);
        const hashes = store.getFileHashes();
        expect(hashes.has('src/alpha.ts')).toBe(false);
        expect(hashes.has('src/beta.ts')).toBe(true);
        expect(hashes.has('notes.txt')).toBe(true);

        const status = store.status();
        expect(status.totalFiles).toBe(2);
        expect(status.totalChunks).toBe(2);

        const state = store.loadVectorState();
        expect(state.consistent).toBe(true);
        expect(state.chunkIds).toHaveLength(2);
        expect(state.vectors).toHaveLength(2);

        // Deleting a never-indexed rel stays a consistent no-op.
        await deleteFiles(tmpDir, ['src/never-indexed.ts'], {
          workerPath: WORKER_PATH,
        });
        const after = new RAGStore(tmpDir);
        expect(after.status().totalChunks).toBe(2);
        expect(after.loadVectorState().consistent).toBe(true);
      },
      120_000,
    );

    it(
      'a scoped upsert re-indexes only the changed file',
      async () => {
        const alphaV1 = 'const alphaOriginal = 1;';
        const beta = 'const betaUntouched = 2;';
        const notes = 'notes untouched';
        writeFile('src/alpha.ts', alphaV1);
        writeFile('src/beta.ts', beta);
        writeFile('notes.txt', notes);
        await upsertViaWorker(['src/alpha.ts', 'src/beta.ts', 'notes.txt']);

        const alphaV2 = 'const alphaRescanned = 2; // changed';
        writeFile('src/alpha.ts', alphaV2);

        const result = await upsertViaWorker(['src/alpha.ts']);

        // Scoped-vs-full sanity: only the changed file was re-indexed.
        expect(result.errors).toEqual([]);
        expect(result.filesScanned).toBe(1);
        expect(result.filesIndexed).toBe(1);
        expect(result.filesSkipped).toBe(0);
        expect(result.filesDeleted).toBe(0);
        expect(result.chunksCreated).toBe(1);

        const store = new RAGStore(tmpDir);
        const hashes = store.getFileHashes();
        expect(hashes.get('src/alpha.ts')).toBe(md5(alphaV2));
        expect(hashes.get('src/beta.ts')).toBe(md5(beta));
        expect(hashes.get('notes.txt')).toBe(md5(notes));

        const status = store.status();
        expect(status.totalFiles).toBe(3);
        expect(status.totalChunks).toBe(3);
        expect(store.loadVectorState().consistent).toBe(true);
      },
      120_000,
    );
  },
);
