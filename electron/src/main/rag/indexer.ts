/**
 * RAG Indexer — file discovery → chunking → embedding → vector store.
 *
 * Full project indexes AND incremental upsert/delete runs execute in a
 * dedicated `worker_threads` worker so ONNX + SQLite work — including the
 * synchronous vectors.npy read/rewrite behind every incremental flush —
 * never blocks the Electron main process.
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
import {
  createEmbedderFromConfig,
  removeModelDownloadTemps,
  type IEmbedder,
} from './embedder';
import { RAGStore, type VectorState } from './store';
import { INDEX_SKIP_DIR_NAMES } from '../indexing/skip-dirs';
import type { RAGStoreStatus } from '../../shared/types/ipc-boundary';
import type { RAGIndexResult, RAGIndexProgress } from '../../shared/types/ipc-boundary';

export type RAGIndexProgressCallback = (progress: RAGIndexProgress) => void;

/** Payload passed to the index worker via workerData. */
export interface RagWorkerStartData {
  projectPath: string;
  force?: boolean;
  paths?: string[];
  /** Frozen, secret-free project configuration captured by the caller. */
  config?: Config;
  /**
   * Operation selector. Absent (or `'index'`) runs the standard index pass
   * over `paths`/`force`. `'upsert'` probes vector-state consistency and runs
   * a scoped (or full, on mismatch) index over `rels`; `'delete'` removes the
   * stored chunks, file rows, and vectors for `rels`. Incremental ops exist
   * so the full vectors.npy read/rewrite never runs on the main thread.
   */
  op?: 'index' | 'upsert' | 'delete';
  /** Normalized targets for the `'upsert'` / `'delete'` ops. */
  rels?: string[];
}

/** Messages the index worker posts back to the parent. */
export type RagWorkerOutbound =
  | { type: 'progress'; progress: RAGIndexProgress }
  | { type: 'result'; result: RAGIndexResult }
  | { type: 'error'; error: string };

/** A zeroed result shape (sentinel / no-op incremental runs). */
function emptyIndexResult(errors: string[] = []): RAGIndexResult {
  return {
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
    filesDeleted: 0, chunksCreated: 0, errors, durationSeconds: 0,
  };
}

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

const DEFAULT_IGNORED_DIRS = new Set(INDEX_SKIP_DIR_NAMES);

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** In-flight runs keyed by project. Independent projects may index concurrently. */
const activeIndexes = new Map<string, RAGIndexProgress>();
const activeIndexCancels = new Map<string, (reason: Error) => Promise<void>>();

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

/** Cancel a worker-backed index so a replacement run can start immediately. */
export async function cancelIndex(projectPath?: string): Promise<boolean> {
  if (!projectPath) return false;
  const cancel = activeIndexCancels.get(projectKey(projectPath));
  if (!cancel) return false;
  await cancel(new Error('RAG indexing cancelled'));
  return true;
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
  /** @internal Test-only worker entry override for deterministic watchdog tests. */
  workerPath?: string;
  /**
   * Run a targeted incremental op instead of a plain index pass: the
   * vector-state consistency probe (upsert) AND the scoped-or-full decision
   * execute on the chosen thread, so the caller never probes on the main
   * thread. `'delete'` removes the stored chunks, file rows, and vectors for
   * `rels`. Incremental ops share this function's single-flight slot,
   * progress tracking, and cancellation machinery.
   */
  op?: 'upsert' | 'delete';
  /** Normalized targets for the incremental `'upsert'` / `'delete'` ops. */
  rels?: string[];
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
): Promise<RAGIndexResult> {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const key = projectKey(projectPath);
  if (activeIndexes.has(key)) {
    return emptyIndexResult(['Indexing already in progress']);
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
      if (options?.op === 'delete') {
        return await runDeleteFilesImpl(projectPath, options.rels ?? []);
      }
      if (options?.op === 'upsert') {
        // Incremental upsert: probe + scoped-or-full decision stay on this
        // thread when forced inline; the single-flight held above still
        // covers the entire run (probe included).
        return await runUpsertFilesImpl({
          projectPath,
          rels: options.rels ?? [],
          embedder,
          progressCallback: trackProgress,
          config: options?.config,
        });
      }
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
      options?.workerPath,
      (cancel) => activeIndexCancels.set(key, cancel),
      options?.op === 'upsert' || options?.op === 'delete'
        ? { op: options.op, rels: options.rels ?? [] }
        : undefined,
    );
  } finally {
    activeIndexes.delete(key);
    activeIndexCancels.delete(key);
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
  /**
   * Vector state a caller probed immediately before this run (the upsert
   * path's consistency probe); when consistent it is used directly so
   * vectors.npy is not loaded a second time.
   */
  preloadedVectorState?: VectorState,
): Promise<RAGIndexResult> {
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
  const stats: RAGIndexResult = {
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

  // Create the embedder lazily — only when a file actually needs embedding.
  // An all-skipped (hash-identical) scan then pays neither the ONNX session
  // initialization nor the worker spawn that eager creation implies.
  let lazyEmbedder: IEmbedder | undefined = embedder;
  const getEmbedder = async (): Promise<IEmbedder> => {
    if (!lazyEmbedder) {
      lazyEmbedder = await createEmbedderFromConfig(cfg.rag);
    }
    return lazyEmbedder;
  };

  // Verify vector/chunk alignment BEFORE reading file hashes. DB rows commit
  // per file while vectors.npy flushes once at the end, so an interrupted
  // previous run can leave the chunks table ahead of the vector file.
  // Continuing incrementally from that state would permanently misalign
  // vector rows against chunks (search returns wrong files), so force a full
  // rebuild instead. Clearing before the hash read also ensures unchanged
  // files are not skipped against a reset database.
  let vectorStateDirty = false;
  let vectorState = preloadedVectorState ?? store.loadVectorState();
  if (!vectorState.consistent) {
    console.warn(
      '[RAG] vectors.npy is out of sync with the chunk database ' +
        '(likely an interrupted index run); clearing index for full rebuild',
    );
    store.clear();
    vectorState = store.loadVectorState();
    vectorStateDirty = true;
  }

  const existingHashes = store.getFileHashes();
  if (force) {
    for (const [k] of existingHashes) {
      existingHashes.set(k, '');
    }
  }

  const indexedFiles = new Set<string>();
  const fileHashes = new Map<string, string>();

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
      const result = await readAndHash(filepath, cfg.rag.max_file_size);
      if (!result) {
        if (existingHashes.has(rel)) {
          store.deleteByFileBatch(vectorState, rel);
          vectorStateDirty = true;
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
              vectorStateDirty = true;
            }
            indexedFiles.add(rel);
          } else {
            // Embed (CPU/memory capped by embedder threads + batch size)
            const texts = chunks.map((c) => c.content);
            const activeEmbedder = await getEmbedder();
            const embeddingsFloat = await activeEmbedder.embed(texts);
            const embeddings = embeddingsFloat.map((e) => Array.from(e));

            store.upsertFileBatch(vectorState, rel, chunks, embeddings);
            vectorStateDirty = true;
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

  // Remove deleted files within the run's scope — a paths-scoped run must
  // not prune stored files it never discovered
  const scopeRoots = resolveScopeRoots(root, paths);
  const currentRels = new Set<string>();
  for (const f of files) {
    try {
      currentRels.add(path.relative(root, f));
    } catch {
      // skip
    }
  }
  for (const storedPath of existingHashes.keys()) {
    if (
      !currentRels.has(storedPath) &&
      isInsideAnyScope(path.resolve(root, storedPath), scopeRoots)
    ) {
      store.deleteByFileBatch(vectorState, storedPath);
      vectorStateDirty = true;
      stats.filesDeleted++;
    }
  }

  // A no-op scan (every file hash-skipped, nothing pruned) leaves vectorState
  // identical to what is already persisted — skip the full vectors.npy
  // rewrite and the duration churn; only state-touching runs flush.
  if (vectorStateDirty) {
    store.flushVectorState(vectorState);
  }

  stats.durationSeconds = elapsed();
  if (vectorStateDirty) {
    store.recordIndexDuration(stats.durationSeconds);
  }

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
// Incremental updates (targeted upsert / delete)
// ---------------------------------------------------------------------------

/** Options for {@link upsertFiles}. */
export interface UpsertFilesOptions {
  /** Project root the update runs against. */
  projectPath: string;
  /** Project-relative (or absolute) file paths to upsert. */
  rels: string[];
  /** Frozen project configuration for this update turn. */
  config?: Config;
  /**
   * Custom embedder instance; forces the update to run inline on the current
   * thread (same rule as `indexProject`).
   */
  embedder?: IEmbedder;
  progressCallback?: RAGIndexProgressCallback;
  /** @internal Test-only worker entry override for deterministic watchdog tests. */
  workerPath?: string;
  /** Force inline execution on the calling thread (tests; same rule as `indexProject`). */
  inline?: boolean;
}

/** Dedupe, absolutize, extension-filter, and sort incremental upsert targets. */
function normalizeUpsertTargets(projectPath: string, rels: string[]): string[] {
  return [...new Set(rels)]
    .map((rel) => (path.isAbsolute(rel) ? rel : path.join(projectPath, rel)))
    .filter((abs) => shouldInclude(abs))
    .sort();
}

/**
 * Incrementally upsert a targeted set of files.
 *
 * The whole update — the vector-state consistency probe included — runs in
 * the index worker, so the synchronous vectors.npy read behind the probe
 * never blocks the Electron main thread. It still routes through
 * `indexProject`, preserving that function's single-flight sentinel
 * ("Indexing already in progress"), progress tracking, and cancellation
 * machinery for incremental runs. When the vector state is inconsistent
 * (e.g. an interrupted previous run), the update delegates to a full rebuild
 * instead — appending to a misaligned vectors.npy would permanently corrupt
 * search. An empty or fully excluded `rels` list is a no-op.
 */
export async function upsertFiles(opts: UpsertFilesOptions): Promise<RAGIndexResult> {
  const { projectPath, rels, config, embedder, progressCallback, workerPath, inline } = opts;
  // Pure path math (no fs access) — cheap enough for the main thread, and
  // needed here so a fully-excluded batch no-ops before touching the
  // single-flight slot.
  const targets = normalizeUpsertTargets(projectPath, rels);
  if (targets.length === 0) {
    return emptyIndexResult();
  }
  return indexProject(
    projectPath,
    undefined,
    false,
    embedder,
    progressCallback,
    { config, workerPath, inline, op: 'upsert', rels: targets },
  );
}

/**
 * Core incremental-upsert implementation (runs on whatever thread calls it).
 *
 * Probes the vector-state consistency, then delegates to a paths-scoped
 * {@link runIndexProjectImpl} run when consistent — hash-skip, chunking,
 * embedding, and the scope-aware deleted-file sweep behave exactly like a
 * scoped manual run — or to a full rebuild when inconsistent. Exported so
 * the index worker can run the probe off the Electron main thread.
 */
export async function runUpsertFilesImpl(opts: {
  projectPath: string;
  /** Project-relative (or absolute) file paths to upsert. */
  rels: string[];
  embedder?: IEmbedder;
  progressCallback?: RAGIndexProgressCallback;
  config?: Config;
}): Promise<RAGIndexResult> {
  const { projectPath, rels, embedder, progressCallback, config } = opts;
  const targets = normalizeUpsertTargets(projectPath, rels);
  if (targets.length === 0) {
    return emptyIndexResult();
  }
  const vectorState = withDisposable(new RAGStore(projectPath), (store) => {
    store.initDb();
    return store.loadVectorState();
  });
  const consistent = vectorState.consistent;
  return runIndexProjectImpl(
    projectPath,
    consistent ? targets : undefined,
    false,
    embedder,
    progressCallback,
    config,
    // Reuse the probed state (loaded once) instead of paying a second full
    // vectors.npy read inside the index run.
    consistent ? vectorState : undefined,
  );
}

/** Options for {@link deleteFiles}. */
export interface DeleteFilesOptions {
  /** Force inline execution on the calling thread (tests, worker itself). */
  inline?: boolean;
  /** @internal Test-only worker entry override for deterministic watchdog tests. */
  workerPath?: string;
}

/**
 * Remove the chunks, file row, and vectors for a targeted set of files.
 *
 * Deletes rewrite vectors.npy in full (plus the id sidecar), so the work is
 * dispatched to the index worker; the main thread never pays the
 * synchronous read-modify-rewrite. Routed through `indexProject`, so deletes
 * share that function's single-flight slot ("Indexing already in progress"
 * sentinel), progress tracking, and cancellation — a delete racing an
 * index/upsert run would corrupt the vector rewrite. No-ops on an
 * inconsistent vector state — nothing can be deleted safely there; the full
 * rebuild the next upsert triggers is the repair.
 */
export async function deleteFiles(
  projectPath: string,
  rels: string[],
  options?: DeleteFilesOptions,
): Promise<RAGIndexResult> {
  const unique = [...new Set(rels)];
  if (unique.length === 0) return emptyIndexResult();
  return indexProject(
    projectPath,
    undefined,
    undefined,
    undefined,
    undefined,
    { workerPath: options?.workerPath, inline: options?.inline, op: 'delete', rels: unique },
  );
}

/**
 * Core incremental-delete implementation (runs on whatever thread calls it).
 * Exported so the index worker can run the vectors.npy rewrite off the main
 * thread. See {@link deleteFiles} for the consistency no-op contract.
 */
export async function runDeleteFilesImpl(
  projectPath: string,
  rels: string[],
): Promise<RAGIndexResult> {
  const unique = [...new Set(rels)];
  const stats = emptyIndexResult();
  if (unique.length === 0) return stats;
  const t0 = Date.now();
  await withDisposableAsync(new RAGStore(projectPath), async (store) => {
    store.initDb();
    const vectorState = store.loadVectorState();
    if (!vectorState.consistent) return;
    for (const rel of unique) {
      store.deleteByFileBatch(vectorState, rel);
      stats.filesDeleted++;
    }
    store.flushVectorState(vectorState);
  });
  stats.durationSeconds = (Date.now() - t0) / 1000;
  return stats;
}

// ---------------------------------------------------------------------------
// Worker runner (main process)
// ---------------------------------------------------------------------------

/** Incremental-op payload forwarded to the index worker. */
type RagWorkerIncremental = {
  op: 'upsert' | 'delete';
  rels: string[];
};

async function runIndexInWorker(
  projectPath: string,
  paths: string[] | undefined,
  force: boolean | undefined,
  progressCallback?: RAGIndexProgressCallback,
  config?: Config,
  workerPathOverride?: string,
  registerCancel?: (cancel: (reason: Error) => Promise<void>) => void,
  incremental?: RagWorkerIncremental,
): Promise<RAGIndexResult> {
  const workerPath = workerPathOverride ?? path.join(__dirname, 'index-worker.js');
  if (!fs.existsSync(workerPath)) {
    // Dev fallback if worker bundle is missing — still produce a usable index.
    console.warn(
      `RAG worker not found at ${workerPath}; running index inline on the main thread`,
    );
    if (incremental?.op === 'delete') {
      return runDeleteFilesImpl(projectPath, incremental.rels);
    }
    if (incremental?.op === 'upsert') {
      return runUpsertFilesImpl({
        projectPath,
        rels: incremental.rels,
        progressCallback,
        config,
      });
    }
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
    ...(incremental ?? {}),
  };

  return new Promise<RAGIndexResult>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const worker = new Worker(workerPath, {
      workerData: startData,
      // Inherit env so native module resolution matches the main process
      env: process.env,
    });

    const workerIdleTimeoutMs = Math.max(
      1,
      ((config as Partial<Config> | undefined)?.background_command_idle_timeout ?? 900) * 1000,
    );
    let completion: Promise<void> | undefined;
    const cleanupInterruptedDownload = async () => {
      let modelName = (config as Partial<Config> | undefined)?.rag?.embedding_model;
      if (!modelName) {
        try {
          modelName = getConfig().rag.embedding_model;
        } catch {
          // A worker can start during early boot before global config exists.
        }
      }
      if (!modelName) return;
      try {
        await removeModelDownloadTemps(modelName);
      } catch {
        // Cleanup is best-effort; the index error remains the primary signal.
      }
    };
    const finish = (
      result: RAGIndexResult | undefined,
      error: Error | undefined,
      cleanupTempFiles: boolean,
    ): Promise<void> => {
      if (completion) return completion;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      completion = (async () => {
        try {
          await worker.terminate();
        } catch {
          // The worker may have already exited after posting its result.
        }
        if (cleanupTempFiles) await cleanupInterruptedDownload();
        if (error) reject(error);
        else resolve(result!);
      })();
      return completion;
    };
    const armWatchdog = () => {
      if (settled) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        void finish(
          undefined,
          new Error(`RAG index worker made no progress for ${workerIdleTimeoutMs}ms`),
          true,
        );
      }, workerIdleTimeoutMs);
    };
    registerCancel?.((reason) => finish(undefined, reason, true));
    armWatchdog();

    worker.on('message', (msg: RagWorkerOutbound) => {
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
      armWatchdog();
      if (msg.type === 'progress') {
        try {
          progressCallback?.(msg.progress);
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type === 'result') {
        void finish(msg.result, undefined, false);
        return;
      }
      if (msg.type === 'error') {
        void finish(undefined, new Error(msg.error), true);
      }
    });

    worker.on('error', (err) => {
      void finish(undefined, err instanceof Error ? err : new Error(String(err)), true);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      void finish(
        undefined,
        new Error(`RAG index worker exited unexpectedly with code ${code}`),
        true,
      );
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

/**
 * Stamp `last_auto_refresh` for a project (see `RAGStore.touchLastAutoRefresh`).
 * Called by the index refresh coordinator after a background flush lands RAG
 * work; manual index runs keep using `last_indexed` only.
 */
export function touchAutoRefresh(projectPath?: string): void {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  withDisposable(
    new RAGStore(projectPath),
    (store) => {
      store.initDb();
      store.touchLastAutoRefresh();
    },
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

function resolveScopeRoots(root: string, paths: string[] | undefined): string[] {
  if (paths && paths.length > 0) {
    return paths.map((p) => (
      path.resolve(path.isAbsolute(p) ? p : path.join(root, p))
    ));
  }
  return [path.resolve(root)];
}

function isInsideAnyScope(absPath: string, scopeRoots: string[]): boolean {
  return scopeRoots.some(
    (scopeRoot) => absPath === scopeRoot || absPath.startsWith(scopeRoot + path.sep),
  );
}

// ---------------------------------------------------------------------------
// Read + hash
// ---------------------------------------------------------------------------

async function readAndHash(
  filepath: string,
  maxFileSize: number,
): Promise<{ content: string; hash: string } | null> {
  try {
    const stat = await fs.promises.stat(filepath);
    if (stat.size > maxFileSize) return null;
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
