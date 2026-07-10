/**
 * RAG Indexer — file discovery → chunking → embedding → vector store.
 *
 * Full project indexes run in a dedicated `worker_threads` worker so ONNX +
 * SQLite work does not block the Electron main process. Single-file
 * `updateFile` stays on the caller thread (post-write path).
 *
 * Ported from Python `src/orchid/rag/indexer.py`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getConfig } from '../config/loader';
import { chunkFile } from './chunker';
import { createEmbedderFromConfig, type IEmbedder } from './embedder';
import { RAGStore } from './store';
import type { RAGStoreStatus } from '../../shared/types/ipc-boundary';
import type { RAGIndexResult, RAGIndexProgress } from '../../shared/types/ipc-boundary';

export type { RAGIndexResult, RAGIndexProgress } from '../../shared/types/ipc-boundary';
/** @deprecated Use RAGIndexResult from shared/types/ipc-boundary */
export type IndexResult = RAGIndexResult;

export type RAGIndexProgressCallback = (progress: RAGIndexProgress) => void;

/** Payload passed to the index worker via workerData. */
export interface RagWorkerStartData {
  projectPath: string;
  force?: boolean;
  paths?: string[];
}

/** Messages the index worker posts back to the parent. */
export type RagWorkerOutbound =
  | { type: 'progress'; progress: RAGIndexProgress }
  | { type: 'result'; result: RAGIndexResult }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INCLUDE_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.md', '.txt',
  '.yaml', '.yml', '.toml', '.json', '.sql', '.sh',
  '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.css', '.html', '.rb', '.php', '.swift', '.kt',
]);

const SKIP_EXTS = new Set(['.pyc', '.pyo', '.pyd', '.so', '.dll', '.exe']);

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__',
  '.venv', 'venv', 'env',
  '.orchid', 'dist', 'build',
  '.next', '.cache', 'target',
]);

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _indexing = false;
/** Latest progress while a run is active (for late UI subscribers / tab switches). */
let _lastProgress: RAGIndexProgress | null = null;

export function isIndexing(): boolean {
  return _indexing;
}

/** Snapshot for remounting UIs mid-index. */
export function getIndexState(): {
  indexing: boolean;
  progress: RAGIndexProgress | null;
} {
  return {
    indexing: _indexing,
    progress: _indexing ? _lastProgress : null,
  };
}

function noteProgress(progress: RAGIndexProgress): void {
  _lastProgress = progress;
}

// ---------------------------------------------------------------------------
// Index project
// ---------------------------------------------------------------------------

export interface IndexProjectOptions {
  /**
   * Force the index to run on the current thread (used by the worker itself,
   * tests, or when a custom Embedder instance is supplied).
   */
  inline?: boolean;
}

/**
 * Run the full RAG indexing pipeline.
 *
 * By default runs in a worker thread. Pass `embedder` or `{ inline: true }`
 * to execute on the current thread (required inside the worker).
 */
export async function indexProject(
  projectPath?: string,
  paths?: string[],
  force?: boolean,
  embedder?: IEmbedder,
  progressCallback?: RAGIndexProgressCallback,
  options?: IndexProjectOptions,
): Promise<IndexResult> {
  if (_indexing) {
    return {
      filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
      filesDeleted: 0, chunksCreated: 0, errors: ['Indexing already in progress'],
      durationSeconds: 0,
    };
  }
  _indexing = true;
  _lastProgress = {
    phase: 'discovering',
    done: 0,
    total: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    filesDeleted: 0,
    elapsedSeconds: 0,
  };
  const trackProgress: RAGIndexProgressCallback = (progress) => {
    noteProgress(progress);
    try {
      progressCallback?.(progress);
    } catch {
      // ignore
    }
  };
  try {
    // Custom embedder cannot be serialized into a worker — run inline.
    if (options?.inline || embedder) {
      return await runIndexProjectImpl(
        projectPath,
        paths,
        force,
        embedder,
        trackProgress,
      );
    }
    if (!projectPath) {
      throw new Error('projectPath is required; pass the active workspace cwd');
    }
    return await runIndexInWorker(projectPath, paths, force, trackProgress);
  } finally {
    _indexing = false;
    _lastProgress = null;
  }
}

/**
 * Core indexing implementation (runs on whatever thread calls it).
 *
 * Exported so the worker entry can invoke it without re-entering the
 * worker-spawning path on `indexProject`.
 */
export async function runIndexProjectImpl(
  projectPath?: string,
  paths?: string[],
  force?: boolean,
  embedder?: IEmbedder,
  progressCallback?: RAGIndexProgressCallback,
): Promise<IndexResult> {
  const cfg = getConfig();
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const root = projectPath;
  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;

  const emit = (partial: Omit<RAGIndexProgress, 'elapsedSeconds'> & { elapsedSeconds?: number }) => {
    if (!progressCallback) return;
    try {
      progressCallback({
        ...partial,
        elapsedSeconds: partial.elapsedSeconds ?? elapsed(),
      });
    } catch {
      // ignore callback errors
    }
  };

  emit({
    phase: 'discovering',
    done: 0,
    total: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    filesDeleted: 0,
  });

  // File discovery
  const files = await discoverFiles(root, paths, cfg.ignored_dirs);
  const stats: IndexResult = {
    filesScanned: files.length,
    filesIndexed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    chunksCreated: 0,
    errors: [],
    durationSeconds: 0,
  };

  emit({
    phase: files.length === 0 ? 'finalizing' : 'indexing',
    done: 0,
    total: files.length,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    filesDeleted: 0,
  });

  if (files.length === 0) {
    const store = new RAGStore(root);
    store.initDb();
    store.touchLastIndexed();
    stats.durationSeconds = elapsed();
    emit({
      phase: 'done',
      done: 0,
      total: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      chunksCreated: 0,
      filesDeleted: 0,
      elapsedSeconds: stats.durationSeconds,
    });
    return stats;
  }

  const store = new RAGStore(root);
  store.initDb();

  if (!embedder) {
    embedder = await createEmbedderFromConfig();
  }

  const existingHashes = store.getFileHashes();
  if (force) {
    for (const [k] of existingHashes) {
      existingHashes.set(k, '');
    }
  }

  const indexedFiles = new Set<string>();
  const fileHashes = new Map<string, string>();

  // Load vector state once; batch ops mutate it in place and flush at end
  const vectorState = store.loadVectorState();

  for (let i = 0; i < files.length; i++) {
    const filepath = files[i]!;
    let rel: string;
    try {
      rel = path.relative(root, filepath);
    } catch {
      continue;
    }

    emit({
      phase: 'indexing',
      done: i,
      total: files.length,
      currentFile: rel,
      filesIndexed: stats.filesIndexed,
      filesSkipped: stats.filesSkipped,
      chunksCreated: stats.chunksCreated,
      filesDeleted: stats.filesDeleted,
    });

    try {
      // Read + hash
      const result = await readAndHash(filepath);
      if (!result) {
        if (existingHashes.has(rel)) {
          store.deleteByFileBatch(vectorState, rel);
        }
        // count as processed
      } else {
        const { content, hash } = result;

        // Skip unchanged
        if (!force && existingHashes.get(rel) === hash) {
          stats.filesSkipped++;
          indexedFiles.add(rel);
        } else {
          // Chunk
          const chunks = chunkFile(rel, content, cfg.rag.chunk_size, cfg.rag.chunk_overlap);
          if (chunks.length === 0) {
            if (existingHashes.has(rel)) {
              store.deleteByFileBatch(vectorState, rel);
            }
            indexedFiles.add(rel);
          } else {
            // Embed (CPU/memory capped by embedder threads + batch size)
            const texts = chunks.map((c) => c.content);
            const embeddingsFloat = await embedder.embed(texts);
            const embeddings = embeddingsFloat.map((e) => Array.from(e));

            store.upsertFileBatch(vectorState, rel, chunks, embeddings);
            stats.filesIndexed++;
            stats.chunksCreated += chunks.length;
            indexedFiles.add(rel);
            if (hash) fileHashes.set(rel, hash);
          }
        }
      }
    } catch (err) {
      const msg = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
      stats.errors.push(msg);
    }

    emit({
      phase: 'indexing',
      done: i + 1,
      total: files.length,
      currentFile: rel,
      filesIndexed: stats.filesIndexed,
      filesSkipped: stats.filesSkipped,
      chunksCreated: stats.chunksCreated,
      filesDeleted: stats.filesDeleted,
    });

    // Yield so the worker event loop can flush progress messages promptly
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  emit({
    phase: 'finalizing',
    done: files.length,
    total: files.length,
    filesIndexed: stats.filesIndexed,
    filesSkipped: stats.filesSkipped,
    chunksCreated: stats.chunksCreated,
    filesDeleted: stats.filesDeleted,
  });

  // Batch hash updates
  const hashesToUpdate = new Map<string, string>();
  for (const [rel, h] of fileHashes) {
    if (indexedFiles.has(rel)) hashesToUpdate.set(rel, h);
  }
  if (hashesToUpdate.size > 0) {
    try {
      store.updateFileHashesBatch(hashesToUpdate);
    } catch (err) {
      stats.errors.push(`Batch hash update failed: ${err}`);
    }
  }

  // Remove deleted files
  const currentRels = new Set<string>();
  for (const f of files) {
    try {
      currentRels.add(path.relative(root, f));
    } catch {
      // skip
    }
  }
  for (const storedPath of existingHashes.keys()) {
    if (!currentRels.has(storedPath)) {
      store.deleteByFileBatch(vectorState, storedPath);
      stats.filesDeleted++;
    }
  }

  store.flushVectorState(vectorState);

  stats.durationSeconds = elapsed();
  store.recordIndexDuration(stats.durationSeconds);

  emit({
    phase: 'done',
    done: files.length,
    total: files.length,
    filesIndexed: stats.filesIndexed,
    filesSkipped: stats.filesSkipped,
    chunksCreated: stats.chunksCreated,
    filesDeleted: stats.filesDeleted,
    elapsedSeconds: stats.durationSeconds,
  });

  return stats;
}

// ---------------------------------------------------------------------------
// Worker runner (main process)
// ---------------------------------------------------------------------------

async function runIndexInWorker(
  projectPath: string,
  paths: string[] | undefined,
  force: boolean | undefined,
  progressCallback?: RAGIndexProgressCallback,
): Promise<IndexResult> {
  const workerPath = path.join(__dirname, 'index-worker.js');
  if (!fs.existsSync(workerPath)) {
    // Dev fallback if worker bundle is missing — still produce a usable index.
    console.warn(
      `RAG worker not found at ${workerPath}; running index inline on the main thread`,
    );
    return runIndexProjectImpl(projectPath, paths, force, undefined, progressCallback);
  }

  const startData: RagWorkerStartData = {
    projectPath,
    force: force === true,
    paths,
  };

  return new Promise<IndexResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: startData,
      // Inherit env so native module resolution matches the main process
      env: process.env,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    worker.on('message', (msg: RagWorkerOutbound) => {
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      if (msg.type === 'progress') {
        try {
          progressCallback?.(msg.progress);
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type === 'result') {
        finish(() => {
          void worker.terminate();
          resolve(msg.result);
        });
        return;
      }
      if (msg.type === 'error') {
        finish(() => {
          void worker.terminate();
          reject(new Error(msg.error));
        });
      }
    });

    worker.on('error', (err) => {
      finish(() => reject(err));
    });

    worker.on('exit', (code) => {
      if (settled) return;
      finish(() => {
        reject(new Error(`RAG index worker exited unexpectedly with code ${code}`));
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Single-file re-index (post-write callback)
// ---------------------------------------------------------------------------

/**
 * Re-index a single file in the RAG store.
 * Used by post-write callbacks from edit/write tools.
 */
export async function updateFile(
  filePath: string,
  projectPath?: string,
): Promise<void> {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const root = projectPath;
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);

  let rel: string;
  try {
    rel = path.relative(root, absPath);
  } catch {
    return;
  }

  const store = new RAGStore(root);
  store.initDb();

  if (!shouldInclude(absPath)) {
    store.deleteByFile(rel);
    return;
  }

  const result = await readAndHash(absPath);
  if (!result) {
    store.deleteByFile(rel);
    return;
  }

  const cfg = getConfig();
  const chunks = chunkFile(rel, result.content, cfg.rag.chunk_size, cfg.rag.chunk_overlap);
  if (chunks.length === 0) {
    store.deleteByFile(rel);
    return;
  }

  try {
    const embedder = await createEmbedderFromConfig();
    const texts = chunks.map((c) => c.content);
    const embeddingsFloat = await embedder.embed(texts);
    const embeddings = embeddingsFloat.map((e) => Array.from(e));

    // Batch path: load vector state, upsert, flush
    const state = store.loadVectorState();
    store.upsertFileBatch(state, rel, chunks, embeddings);
    store.flushVectorState(state);
    if (result.hash) store.updateFileHash(rel, result.hash);
  } catch {
    // Graceful failure — file won't be indexed but no crash
  }
}

// ---------------------------------------------------------------------------
// Status / clear
// ---------------------------------------------------------------------------

export function getStatus(projectPath?: string): RAGStoreStatus {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const root = projectPath;
  const store = new RAGStore(root);
  return store.status();
}

export function clearIndex(projectPath?: string): void {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const root = projectPath;
  const store = new RAGStore(root);
  store.clear();
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function discoverFiles(
  root: string,
  paths: string[] | undefined,
  ignoredDirs: string[],
): Promise<string[]> {
  const skip = new Set([...ignoredDirs, ...DEFAULT_IGNORED_DIRS]);

  if (paths && paths.length > 0) {
    const result: string[] = [];
    for (const p of paths) {
      const abs = path.isAbsolute(p) ? p : path.join(root, p);
      const stat = await safeStat(abs);
      if (stat?.isFile() && shouldInclude(abs)) {
        result.push(abs);
      } else if (stat?.isDirectory()) {
        result.push(...(await walkDir(abs, skip)));
      }
    }
    return [...new Set(result)].sort();
  }

  return (await walkDir(root, skip)).sort();
}

async function walkDir(directory: string, skip: Set<string>): Promise<string[]> {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  const subDirPromises: Promise<string[]>[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !skip.has(entry.name)) {
      subDirPromises.push(walkDir(path.join(directory, entry.name), skip));
    } else if (entry.isFile()) {
      const p = path.join(directory, entry.name);
      if (shouldInclude(p)) files.push(p);
    }
  }
  if (subDirPromises.length > 0) {
    const subResults = await Promise.all(subDirPromises);
    for (const sub of subResults) {
      files.push(...sub);
    }
  }
  return files;
}

function shouldInclude(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return false;
  return INCLUDE_EXTS.has(ext);
}

// ---------------------------------------------------------------------------
// Read + hash
// ---------------------------------------------------------------------------

async function readAndHash(
  filepath: string,
): Promise<{ content: string; hash: string } | null> {
  const cfg = getConfig();
  try {
    const stat = await fs.promises.stat(filepath);
    if (stat.size > cfg.rag.max_file_size) return null;
    if (stat.size === 0) return null;

    const content = await fs.promises.readFile(filepath, 'utf-8');
    if (content.includes('\0')) return null; // binary

    const hash = crypto.createHash('md5').update(content).digest('hex');
    return { content, hash };
  } catch {
    return null;
  }
}

async function safeStat(filepath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filepath);
  } catch {
    return null;
  }
}
