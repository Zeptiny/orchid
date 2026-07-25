/**
 * RAG Indexer — file discovery → chunking → embedding → vector store.
 *
 * Full project indexes run in a dedicated `worker_threads` worker so ONNX +
 * SQLite work does not block the Electron main process. Single-file
 *
 * Ported from Python `src/orchid/rag/indexer.py`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import {
  withDisposable,
  withDisposableAsync,
} from '../utils/with-disposable';
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
  /** Frozen, secret-free project configuration captured by the caller. */
  config?: Config;
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

/** In-flight runs keyed by project. Independent projects may index concurrently. */
const activeIndexes = new Map<string, RAGIndexProgress>();

function projectKey(projectPath: string): string {
  return path.resolve(projectPath);
}

export function isIndexing(projectPath?: string): boolean {
  return projectPath == null
    ? activeIndexes.size > 0
    : activeIndexes.has(projectKey(projectPath));
}

/** Snapshot for remounting UIs mid-index. */
export function getIndexState(projectPath?: string): {
  indexing: boolean;
  progress: RAGIndexProgress | null;
} {
  if (projectPath != null) {
    const progress = activeIndexes.get(projectKey(projectPath)) ?? null;
    return { indexing: progress != null, progress };
  }
  const progress = activeIndexes.size === 1
    ? (activeIndexes.values().next().value ?? null)
    : null;
  return {
    indexing: activeIndexes.size > 0,
    progress,
  };
}

function noteProgress(projectPath: string, progress: RAGIndexProgress): void {
  activeIndexes.set(projectKey(projectPath), progress);
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
  /** Frozen project configuration for this indexing turn. */
  config?: Config;
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
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const key = projectKey(projectPath);
  if (activeIndexes.has(key)) {
    return {
      filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
      filesDeleted: 0, chunksCreated: 0, errors: ['Indexing already in progress'],
      durationSeconds: 0,
    };
  }
  activeIndexes.set(key, {
    phase: 'discovering',
    done: 0,
    total: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    filesDeleted: 0,
    elapsedSeconds: 0,
  });
  const trackProgress: RAGIndexProgressCallback = (progress) => {
    noteProgress(projectPath, progress);
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
        options?.config,
      );
    }
    return await runIndexInWorker(
      projectPath,
      paths,
      force,
      trackProgress,
      options?.config,
    );
  } finally {
    activeIndexes.delete(key);
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
  config?: Config,
): Promise<IndexResult> {
  const cfg = config ?? getConfig();
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
    return withDisposable(new RAGStore(root), (store) => {
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
    });
  }

  return withDisposableAsync(new RAGStore(root), async (store) => {
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
  });
}

// ---------------------------------------------------------------------------
// Worker runner (main process)
// ---------------------------------------------------------------------------

async function runIndexInWorker(
  projectPath: string,
  paths: string[] | undefined,
  force: boolean | undefined,
  progressCallback?: RAGIndexProgressCallback,
  config?: Config,
): Promise<IndexResult> {
  const workerPath = path.join(__dirname, 'index-worker.js');
  if (!fs.existsSync(workerPath)) {
    // Dev fallback if worker bundle is missing — still produce a usable index.
    console.warn(
      `RAG worker not found at ${workerPath}; running index inline on the main thread`,
    );
    return runIndexProjectImpl(
      projectPath,
      paths,
      force,
      undefined,
      progressCallback,
      config,
    );
  }

  const startData: RagWorkerStartData = {
    projectPath,
    force: force === true,
    paths,
    config,
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
// Status / clear
// ---------------------------------------------------------------------------

export function getStatus(projectPath?: string): RAGStoreStatus {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const root = projectPath;
  return withDisposable(
    new RAGStore(root),
    (store) => store.status(),
  );
}

export function clearIndex(projectPath?: string): void {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const root = projectPath;
  withDisposable(
    new RAGStore(root),
    (store) => store.clear(),
  );
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
