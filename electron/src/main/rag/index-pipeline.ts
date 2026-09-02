/**
 * RAG index pipeline — the stages one index run executes on whichever thread
 * owns it: the index worker by default, the calling thread when a custom
 * embedder or an explicit inline request forces it.
 *
 * A full pass runs discovery → vector-state preparation → per-file
 * chunk/embed/store → hash commit → scope-aware prune → vector flush, with
 * progress reported between the stages. Incremental upsert/delete reuse the
 * same stages so both threads land identical stores.
 */
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import {
  withDisposable,
  withDisposableAsync,
} from '../utils/with-disposable';
import { chunkFile, type Chunk } from './chunker';
import {
  discoverFiles,
  isInsideAnyScope,
  normalizeUpsertTargets,
  readAndHash,
  relativeToRoot,
  resolveScopeRoots,
} from './discovery';
import { createEmbedderFromConfig, type IEmbedder } from './embedder';
import {
  createProgressEmitter,
  startRunClock,
  zeroedCounters,
  type EmitIndexProgress,
  type ProgressCounters,
  type RAGIndexProgressCallback,
} from './index-progress';
import { RAGStore, type VectorState } from './store';
import type { RAGIndexResult } from '../../shared/types/ipc-boundary';

/** Arguments of one index run, collapsed into a single request object. */
export interface RagIndexRequest {
  /** Project root the run indexes; required. */
  projectPath?: string;
  /** Restrict discovery (and the deleted-file sweep) to these paths. */
  paths?: string[];
  /** Re-index every file, ignoring the stored hashes. */
  force?: boolean;
  /**
   * Pre-built embedder. It cannot cross a worker boundary, so supplying one
   * pins the run to the calling thread.
   */
  embedder?: IEmbedder;
  progressCallback?: RAGIndexProgressCallback;
  /** Frozen, secret-free project configuration captured by the caller. */
  config?: Config;
  /**
   * Vector state a caller probed immediately before this run (the upsert
   * path's consistency probe); when consistent it is used directly so
   * vectors.npy is not loaded a second time.
   */
  preloadedVectorState?: VectorState;
}

/** A zeroed result shape (sentinel / no-op incremental runs). */
export function emptyIndexResult(errors: string[] = []): RAGIndexResult {
  return {
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
    filesDeleted: 0, chunksCreated: 0, errors, durationSeconds: 0,
  };
}

/** One run's shared state, handed to every stage. */
interface IndexRun {
  root: string;
  cfg: Config;
  request: RagIndexRequest;
  force: boolean;
  files: string[];
  stats: RAGIndexResult;
  emit: EmitIndexProgress;
  elapsed: () => number;
}

/** The store-side state the per-file stages mutate. */
interface FileRun {
  run: IndexRun;
  store: RAGStore;
  vectorState: VectorState;
  vectorStateDirty: boolean;
  existingHashes: Map<string, string>;
  indexedFiles: Set<string>;
  fileHashes: Map<string, string>;
  getEmbedder: LazyEmbedder;
}

/** Embedder factory that pays construction only on first actual use. */
type LazyEmbedder = () => Promise<IEmbedder>;

/**
 * Core indexing implementation (runs on whatever thread calls it).
 *
 * Exported so the worker entry can invoke it without re-entering the
 * worker-spawning path on `indexProject`.
 */
export async function runIndexProjectImpl(
  request: RagIndexRequest,
): Promise<RAGIndexResult> {
  const cfg = request.config ?? getConfig();
  const root = request.projectPath;
  if (!root) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }

  const elapsed = startRunClock();
  const emit = createProgressEmitter(request.progressCallback, elapsed);
  emit({ phase: 'discovering', done: 0, total: 0, ...zeroedCounters() });

  const files = await discoverFiles(root, {
    paths: request.paths,
    ignoredDirs: cfg.ignored_dirs,
  });
  const run: IndexRun = {
    root,
    cfg,
    request,
    force: request.force ?? false,
    files,
    stats: { ...emptyIndexResult(), filesScanned: files.length },
    emit,
    elapsed,
  };

  emit({
    phase: files.length === 0 ? 'finalizing' : 'indexing',
    done: 0,
    total: files.length,
    ...zeroedCounters(),
  });

  if (files.length === 0) return finishEmptyRun(run);

  return withDisposableAsync(new RAGStore(root), async (store) => {
    store.initDb();
    return runIndexStages(run, store);
  });
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** A run that discovered nothing still stamps the index as refreshed. */
function finishEmptyRun(run: IndexRun): RAGIndexResult {
  return withDisposable(new RAGStore(run.root), (store) => {
    store.initDb();
    store.touchLastIndexed();
    run.stats.durationSeconds = run.elapsed();
    run.emit({
      phase: 'done',
      done: 0,
      total: 0,
      ...zeroedCounters(),
      elapsedSeconds: run.stats.durationSeconds,
    });
    return run.stats;
  });
}

async function runIndexStages(run: IndexRun, store: RAGStore): Promise<RAGIndexResult> {
  const fileRun = openFileRun(run, store);
  await indexDiscoveredFiles(fileRun);
  emitFinalizing(run);
  persistFileHashes(fileRun);
  pruneDeletedFiles(fileRun);
  commitRunState(fileRun);
  return run.stats;
}

/** Open the per-file run: alignment probe first, then the stored hashes. */
function openFileRun(run: IndexRun, store: RAGStore): FileRun {
  const { vectorState, dirty } = prepareVectorState(run, store);
  return {
    run,
    store,
    vectorState,
    vectorStateDirty: dirty,
    existingHashes: loadStoredHashes(run, store),
    indexedFiles: new Set<string>(),
    fileHashes: new Map<string, string>(),
    getEmbedder: createLazyEmbedder(run.request.embedder, run.cfg),
  };
}

/**
 * Create the embedder lazily — only when a file actually needs embedding.
 * An all-skipped (hash-identical) scan then pays neither the ONNX session
 * initialization nor the worker spawn that eager creation implies.
 */
function createLazyEmbedder(provided: IEmbedder | undefined, cfg: Config): LazyEmbedder {
  let active = provided;
  return async () => {
    if (!active) {
      active = await createEmbedderFromConfig(cfg.rag);
    }
    return active;
  };
}

/**
 * Verify vector/chunk alignment BEFORE reading file hashes. DB rows commit
 * per file while vectors.npy flushes once at the end, so an interrupted
 * previous run can leave the chunks table ahead of the vector file.
 * Continuing incrementally from that state would permanently misalign
 * vector rows against chunks (search returns wrong files), so force a full
 * rebuild instead. Clearing before the hash read also ensures unchanged
 * files are not skipped against a reset database.
 */
function prepareVectorState(
  run: IndexRun,
  store: RAGStore,
): { vectorState: VectorState; dirty: boolean } {
  const vectorState = run.request.preloadedVectorState ?? store.loadVectorState();
  if (vectorState.consistent) {
    return { vectorState, dirty: false };
  }
  console.warn(
    '[RAG] vectors.npy is out of sync with the chunk database ' +
      '(likely an interrupted index run); clearing index for full rebuild',
  );
  store.clear();
  return { vectorState: store.loadVectorState(), dirty: true };
}

/** Stored hashes, blanked when the run is forced so nothing hash-skips. */
function loadStoredHashes(run: IndexRun, store: RAGStore): Map<string, string> {
  const hashes = store.getFileHashes();
  if (run.force) {
    for (const [rel] of hashes) {
      hashes.set(rel, '');
    }
  }
  return hashes;
}

async function indexDiscoveredFiles(fileRun: FileRun): Promise<void> {
  const { run } = fileRun;
  for (let i = 0; i < run.files.length; i++) {
    const filepath = run.files[i]!;
    const rel = relativeToRoot(run.root, filepath);
    if (rel === null) continue;
    emitFileProgress(run, i, rel);
    await indexFileGuarded(fileRun, rel, filepath);
    emitFileProgress(run, i + 1, rel);
    // Yield so the worker event loop can flush progress messages promptly
    await yieldToEventLoop();
  }
}

async function indexFileGuarded(fileRun: FileRun, rel: string, filepath: string): Promise<void> {
  try {
    await indexFile(fileRun, rel, filepath);
  } catch (err) {
    const msg = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
    fileRun.run.stats.errors.push(msg);
  }
}

async function indexFile(fileRun: FileRun, rel: string, filepath: string): Promise<void> {
  const { run } = fileRun;
  const read = await readAndHash(filepath, run.cfg.rag.max_file_size);
  if (!read) {
    removeStoredFile(fileRun, rel);
    // count as processed
    return;
  }

  if (isUnchanged(fileRun, rel, read.hash)) {
    run.stats.filesSkipped++;
    fileRun.indexedFiles.add(rel);
    return;
  }

  const chunks = chunkFile(rel, read.content, run.cfg.rag.chunk_size, run.cfg.rag.chunk_overlap);
  if (chunks.length === 0) {
    removeStoredFile(fileRun, rel);
    fileRun.indexedFiles.add(rel);
    return;
  }

  await storeFileChunks(fileRun, rel, chunks, read.hash);
}

function isUnchanged(fileRun: FileRun, rel: string, hash: string): boolean {
  return !fileRun.run.force && fileRun.existingHashes.get(rel) === hash;
}

/** Drop a file's stored chunks/vectors when it is no longer indexable. */
function removeStoredFile(fileRun: FileRun, rel: string): void {
  if (!fileRun.existingHashes.has(rel)) return;
  fileRun.store.deleteByFileBatch(fileRun.vectorState, rel);
  fileRun.vectorStateDirty = true;
}

async function storeFileChunks(
  fileRun: FileRun,
  rel: string,
  chunks: Chunk[],
  hash: string,
): Promise<void> {
  // Embed (CPU/memory capped by embedder threads + batch size)
  const texts = chunks.map((c) => c.content);
  const activeEmbedder = await fileRun.getEmbedder();
  const embeddingsFloat = await activeEmbedder.embed(texts);
  const embeddings = embeddingsFloat.map((e) => Array.from(e));

  fileRun.store.upsertFileBatch(fileRun.vectorState, rel, chunks, embeddings);
  fileRun.vectorStateDirty = true;
  const stats = fileRun.run.stats;
  stats.filesIndexed++;
  stats.chunksCreated += chunks.length;
  fileRun.indexedFiles.add(rel);
  if (hash) fileRun.fileHashes.set(rel, hash);
}

/** Batch hash updates for every file this run touched. */
function persistFileHashes(fileRun: FileRun): void {
  const hashesToUpdate = new Map<string, string>();
  for (const [rel, hash] of fileRun.fileHashes) {
    if (fileRun.indexedFiles.has(rel)) {
      hashesToUpdate.set(rel, hash);
    }
  }
  if (hashesToUpdate.size === 0) return;
  try {
    fileRun.store.updateFileHashesBatch(hashesToUpdate);
  } catch (err) {
    fileRun.run.stats.errors.push(`Batch hash update failed: ${err}`);
  }
}

/**
 * Remove deleted files within the run's scope — a paths-scoped run must
 * not prune stored files it never discovered.
 */
function pruneDeletedFiles(fileRun: FileRun): void {
  const { run } = fileRun;
  const scopeRoots = resolveScopeRoots(run.root, run.request.paths);
  const currentRels = discoveredRels(run);
  for (const storedPath of fileRun.existingHashes.keys()) {
    if (currentRels.has(storedPath)) continue;
    if (!isInsideAnyScope(path.resolve(run.root, storedPath), scopeRoots)) continue;
    fileRun.store.deleteByFileBatch(fileRun.vectorState, storedPath);
    fileRun.vectorStateDirty = true;
    run.stats.filesDeleted++;
  }
}

function discoveredRels(run: IndexRun): Set<string> {
  const rels = new Set<string>();
  for (const filepath of run.files) {
    const rel = relativeToRoot(run.root, filepath);
    if (rel !== null) rels.add(rel);
  }
  return rels;
}

/**
 * A no-op scan (every file hash-skipped, nothing pruned) leaves vectorState
 * identical to what is already persisted — skip the full vectors.npy
 * rewrite and the duration churn; only state-touching runs flush.
 */
function commitRunState(fileRun: FileRun): void {
  const { run, store } = fileRun;
  if (fileRun.vectorStateDirty) {
    store.flushVectorState(fileRun.vectorState);
  }

  run.stats.durationSeconds = run.elapsed();
  if (fileRun.vectorStateDirty) {
    store.recordIndexDuration(run.stats.durationSeconds);
  }

  emitDone(run);
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

function emitFileProgress(run: IndexRun, done: number, currentFile: string): void {
  run.emit({
    phase: 'indexing',
    done,
    total: run.files.length,
    currentFile,
    ...countersOf(run.stats),
  });
}

function emitFinalizing(run: IndexRun): void {
  run.emit({
    phase: 'finalizing',
    done: run.files.length,
    total: run.files.length,
    ...countersOf(run.stats),
  });
}

function emitDone(run: IndexRun): void {
  run.emit({
    phase: 'done',
    done: run.files.length,
    total: run.files.length,
    ...countersOf(run.stats),
    elapsedSeconds: run.stats.durationSeconds,
  });
}

function countersOf(stats: RAGIndexResult): ProgressCounters {
  return {
    filesIndexed: stats.filesIndexed,
    filesSkipped: stats.filesSkipped,
    chunksCreated: stats.chunksCreated,
    filesDeleted: stats.filesDeleted,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Incremental updates (targeted upsert / delete)
// ---------------------------------------------------------------------------

/** Arguments of an inline incremental-upsert run. */
export interface RagUpsertRunRequest {
  projectPath: string;
  /** Project-relative (or absolute) file paths to upsert. */
  rels: string[];
  embedder?: IEmbedder;
  progressCallback?: RAGIndexProgressCallback;
  config?: Config;
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
export async function runUpsertFilesImpl(
  request: RagUpsertRunRequest,
): Promise<RAGIndexResult> {
  const { projectPath, embedder, progressCallback, config } = request;
  const targets = normalizeUpsertTargets(projectPath, request.rels);
  if (targets.length === 0) {
    return emptyIndexResult();
  }
  const vectorState = withDisposable(new RAGStore(projectPath), (store) => {
    store.initDb();
    return store.loadVectorState();
  });
  const consistent = vectorState.consistent;
  return runIndexProjectImpl({
    projectPath,
    paths: consistent ? targets : undefined,
    force: false,
    embedder,
    progressCallback,
    config,
    // Reuse the probed state (loaded once) instead of paying a second full
    // vectors.npy read inside the index run.
    preloadedVectorState: consistent ? vectorState : undefined,
  });
}

/**
 * Core incremental-delete implementation (runs on whatever thread calls it).
 * Exported so the index worker can run the vectors.npy rewrite off the main
 * thread. See `deleteFiles` for the consistency no-op contract.
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
