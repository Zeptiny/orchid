/**
 * RAG Indexer — file discovery → chunking → embedding → vector store.
 *
 * Full project indexes AND incremental upsert/delete runs execute in a
 * dedicated `worker_threads` worker so ONNX + SQLite work — including the
 * synchronous vectors.npy read/rewrite behind every incremental flush —
 * never blocks the Electron main process.
 *
 * This module is the public surface: the single-flight bookkeeping, the
 * in-flight progress snapshot the renderer reads back, cancellation, and
 * status reads. The pipeline stages live in `index-pipeline.ts` and the
 * worker-thread dispatch in `index-worker-runner.ts`.
 */
import * as path from 'node:path';
import type { Config } from '../config/schema';
import { withDisposable } from '../utils/with-disposable';
import { normalizeUpsertTargets } from './discovery';
import type { IEmbedder } from './embedder';
import {
  emptyIndexResult,
  runDeleteFilesImpl,
  runIndexProjectImpl,
  runUpsertFilesImpl,
} from './index-pipeline';
import { initialIndexProgress, type RAGIndexProgressCallback } from './index-progress';
import { runIndexInWorker, type RagWorkerRequest } from './index-worker-runner';
import { RAGStore } from './store';
import type { RAGStoreStatus } from '../../shared/types/ipc-boundary';
import type { RAGIndexProgress, RAGIndexResult } from '../../shared/types/ipc-boundary';

export type { RAGIndexProgressCallback } from './index-progress';
export type { RagWorkerOutbound, RagWorkerStartData } from './index-worker-runner';
export { runDeleteFilesImpl, runIndexProjectImpl, runUpsertFilesImpl } from './index-pipeline';

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
  const key = projectKey(projectPath);
  // Only refresh an already-claimed slot. A worker frame that lands after the
  // run's finally block released the slot must never resurrect it and wedge
  // every future index for this project on the in-progress sentinel.
  if (!activeIndexes.has(key)) return;
  activeIndexes.set(key, progress);
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

/** A run request before the project root is validated (public entry shape). */
type PendingRunRequest = Partial<RagWorkerRequest> & { inline?: boolean };

/** A validated run request, ready for dispatch on this or a worker thread. */
type IndexRunRequest = RagWorkerRequest & { inline?: boolean };

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
  return await runIndexRequest({
    projectPath,
    paths,
    force,
    embedder,
    progressCallback,
    config: options?.config,
    inline: options?.inline,
    workerPath: options?.workerPath,
    ...(options?.op ? { op: options.op, rels: options.rels ?? [] } : undefined),
  });
}

/**
 * Claim the per-project single-flight slot, then dispatch the run on the
 * thread its request implies; releases the slot when the run settles.
 */
async function runIndexRequest(request: PendingRunRequest): Promise<RAGIndexResult> {
  const { projectPath } = request;
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const key = projectKey(projectPath);
  if (activeIndexes.has(key)) {
    return emptyIndexResult(['Indexing already in progress']);
  }
  activeIndexes.set(key, initialIndexProgress());
  const tracked: IndexRunRequest = {
    ...request,
    projectPath,
    progressCallback: createProgressTracker(projectPath, request.progressCallback),
  };
  try {
    return await dispatchIndexRun(tracked, key);
  } finally {
    activeIndexes.delete(key);
    activeIndexCancels.delete(key);
  }
}

async function dispatchIndexRun(
  request: IndexRunRequest,
  key: string,
): Promise<RAGIndexResult> {
  // Custom embedder cannot be serialized into a worker — run inline.
  if (request.inline || request.embedder) {
    return await runInline(request);
  }
  return await runIndexInWorker({
    ...request,
    registerCancel: (cancel) => {
      activeIndexCancels.set(key, cancel);
    },
  });
}

async function runInline(request: IndexRunRequest): Promise<RAGIndexResult> {
  if (request.op === 'delete') {
    return await runDeleteFilesImpl(request.projectPath, request.rels ?? []);
  }
  if (request.op === 'upsert') {
    // Incremental upsert: probe + scoped-or-full decision stay on this
    // thread when forced inline; the single-flight held by the caller still
    // covers the entire run (probe included).
    return await runUpsertFilesImpl({
      projectPath: request.projectPath,
      rels: request.rels ?? [],
      embedder: request.embedder,
      progressCallback: request.progressCallback,
      config: request.config,
    });
  }
  return await runIndexProjectImpl(request);
}

/** Mirror every progress update onto the in-flight snapshot and the caller's. */
function createProgressTracker(
  projectPath: string,
  callback: RAGIndexProgressCallback | undefined,
): RAGIndexProgressCallback {
  return (progress) => {
    noteProgress(projectPath, progress);
    try {
      callback?.(progress);
    } catch {
      // ignore
    }
  };
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
  const { projectPath, config, embedder, progressCallback, workerPath, inline } = opts;
  // Pure path math (no fs access) — cheap enough for the main thread, and
  // needed here so a fully-excluded batch no-ops before touching the
  // single-flight slot.
  const targets = normalizeUpsertTargets(projectPath, opts.rels);
  if (targets.length === 0) {
    return emptyIndexResult();
  }
  return await runIndexRequest({
    projectPath,
    paths: undefined,
    force: false,
    embedder,
    progressCallback,
    config,
    inline,
    workerPath,
    op: 'upsert',
    rels: targets,
  });
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
  return await runIndexRequest({
    projectPath,
    workerPath: options?.workerPath,
    inline: options?.inline,
    op: 'delete',
    rels: unique,
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
