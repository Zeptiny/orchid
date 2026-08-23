/**
 * AST Indexer — project-wide symbol indexing with hash change detection.
 *
 * Full project indexes and incremental upsert/delete batches run in a
 * dedicated `worker_threads` worker so tree-sitter WASM + SQLite work does
 * not block the Electron main process.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { langForExtension, loadQueryFile, parseFile, runQuery } from './parser';
import { ASTStore, type Symbol } from './store';
import { getConfig, type Config } from '../config';
import { INDEX_SKIP_DIR_NAMES } from '../indexing/skip-dirs';
import { withDisposable, withDisposableAsync } from '../utils/with-disposable';
import type { ASTIndexResult, ASTIndexProgress } from '../../shared/types/ipc-boundary';

export type ASTIndexProgressCallback = (progress: ASTIndexProgress) => void;

/**
 * Payload passed to the AST index worker via `workerData`.
 *
 * The `op` discriminator selects the run: omitted (or `'index'`) performs a
 * full project scan, while `'upsert'` / `'delete'` run a targeted
 * incremental batch against `rels`.
 */
export type AstWorkerStartData =
  | { op?: 'index'; projectPath: string; force?: boolean }
  | { op: 'upsert'; projectPath: string; rels: string[]; config?: Config }
  | { op: 'delete'; projectPath: string; rels: string[] };

/** Messages the AST index worker posts back to the parent. */
export type AstWorkerOutbound =
  | { type: 'progress'; progress: ASTIndexProgress }
  | { type: 'result'; result: ASTIndexResult }
  | { type: 'incremental-result'; result: ASTIncrementalResult }
  | { type: 'delete-result'; deleted: number }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AST_INCLUDE_EXTS = new Set(['.py', '.js', '.jsx', '.ts', '.tsx']);

const SKIP_DIRS = new Set(INDEX_SKIP_DIR_NAMES);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Projects with a complete AST index available for index-dependent tools. */
const initializedProjects = new Set<string>();
/** In-flight runs keyed by project. Independent projects may index concurrently. */
const activeIndexes = new Map<string, ASTIndexProgress>();
/**
 * Single-flight promises per project so concurrent ensureIndexed / indexProject
 * callers share one run instead of busy-polling activeIndexes.
 */
const activeIndexPromises = new Map<string, Promise<ASTIndexResult>>();

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
  progress: ASTIndexProgress | null;
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

function noteProgress(projectPath: string, progress: ASTIndexProgress): void {
  activeIndexes.set(projectKey(projectPath), progress);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function makeIndexResult(): ASTIndexResult {
  return {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    symbolsExtracted: 0,
    errors: [],
    durationSeconds: 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trigger a full project scan if the session hasn't been initialized.
 *
 * Index-dependent tools (find_symbol_references, rename_symbol) call this
 * before querying the store. Index-independent tools (get_file_skeleton,
 * get_function) parse files directly and do not call this.
 */
export async function ensureIndexed(projectPath?: string): Promise<void> {
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const key = projectKey(projectPath);
  if (initializedProjects.has(key)) return;
  const inFlight = activeIndexPromises.get(key);
  if (inFlight) {
    await inFlight;
    return;
  }
  await indexProject({ projectPath });
}

export interface IndexProjectOptions {
  projectPath?: string;
  force?: boolean;
  progressCallback?: ASTIndexProgressCallback;
  /**
    * Frozen per-project config (ignored_dirs, ast_max_file_size) captured by
    * the caller. Falls back to the process-wide config when omitted.
    */
  config?: Config;
  /**
   * Force the index to run on the current thread (used by the worker itself
   * and tests that need a synchronous-style progress callback).
   */
  inline?: boolean;
}

/**
 * Run a full AST indexing scan of the project.
 *
 * By default runs in a worker thread. Pass `{ inline: true }` to execute on
 * the current thread (required inside the worker).
 */
export async function indexProject(
  opts: IndexProjectOptions = {},
): Promise<ASTIndexResult> {
  if (!opts.projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }
  const key = projectKey(opts.projectPath);
  const existing = activeIndexPromises.get(key);
  if (existing) {
    // Share the in-flight run (single-flight) rather than returning an empty error.
    return existing;
  }

  const run = (async (): Promise<ASTIndexResult> => {
    activeIndexes.set(key, {
      phase: 'discovering',
      done: 0,
      total: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      symbolsExtracted: 0,
      filesDeleted: 0,
      elapsedSeconds: 0,
    });
    const trackProgress: ASTIndexProgressCallback = (progress) => {
      noteProgress(opts.projectPath!, progress);
      try {
        opts.progressCallback?.(progress);
      } catch {
        // ignore
      }
    };
    try {
      if (opts.inline) {
        const result = await runIndexProjectImpl({
          ...opts,
          progressCallback: trackProgress,
        });
        initializedProjects.add(key);
        return result;
      }
      const result = await runIndexInWorker(
        opts.projectPath!,
        opts.force === true,
        trackProgress,
        opts.config,
      );
      // Worker set its own session flag; mark main-process session as ready too
      // so ensureIndexed() short-circuits after a successful run.
      initializedProjects.add(key);
      return result;
    } finally {
      activeIndexes.delete(key);
      activeIndexPromises.delete(key);
    }
  })();

  activeIndexPromises.set(key, run);
  return run;
}

/**
 * Core indexing implementation (runs on whatever thread calls it).
 *
 * Exported so the worker entry can invoke it without re-entering the
 * worker-spawning path on `indexProject`.
 */
export async function runIndexProjectImpl(opts: {
  projectPath?: string;
  force?: boolean;
  progressCallback?: ASTIndexProgressCallback;
  config?: Config;
}): Promise<ASTIndexResult> {
  const { force = false, progressCallback } = opts;
  const { projectPath } = opts;

  const cfg = opts.config ?? getConfig();
  if (!projectPath) {
    throw new Error('projectPath is required; pass the active workspace cwd');
  }

  const t0 = Date.now();
  const elapsed = () => (Date.now() - t0) / 1000;

  const emit = (
    partial: Omit<ASTIndexProgress, 'elapsedSeconds'> & { elapsedSeconds?: number },
  ) => {
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
    symbolsExtracted: 0,
    filesDeleted: 0,
  });

  const files = await discoverFiles(projectPath, cfg.ignored_dirs);
  const result = makeIndexResult();
  result.filesScanned = files.length;

  emit({
    phase: files.length === 0 ? 'finalizing' : 'indexing',
    done: 0,
    total: files.length,
    filesIndexed: 0,
    filesSkipped: 0,
    symbolsExtracted: 0,
    filesDeleted: 0,
  });

  return withDisposableAsync(new ASTStore(projectPath), async (store) => {
    store.initDb();

  const existingHashes = store.getAllFileHashes();
  const indexedFiles = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    const filepath = files[i]!;
    let rel: string;
    try {
      rel = path.relative(projectPath, filepath);
    } catch {
      continue;
    }

    emit({
      phase: 'indexing',
      done: i,
      total: files.length,
      currentFile: rel,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      symbolsExtracted: result.symbolsExtracted,
      filesDeleted: result.filesDeleted,
    });

    try {
      const readResult = await readAndHash(filepath, cfg.ast_max_file_size);

      if (!readResult) {
        if (existingHashes[rel]) {
          store.deleteByFile(rel);
        }
      } else {
        const { content, hash } = readResult;

        if (!force && existingHashes[rel] === hash) {
          result.filesSkipped++;
          indexedFiles.add(rel);
        } else {
          const symbols = await extractSymbols(rel, content);
          store.upsertFile(rel, hash, symbols);
          result.filesIndexed++;
          result.symbolsExtracted += symbols.length;
          indexedFiles.add(rel);
        }
      }
    } catch (err) {
      const msg = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`AST indexing error: ${msg}`);
      result.errors.push(msg);
    }

    emit({
      phase: 'indexing',
      done: i + 1,
      total: files.length,
      currentFile: rel,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      symbolsExtracted: result.symbolsExtracted,
      filesDeleted: result.filesDeleted,
    });

    // Yield so the worker event loop can flush progress messages promptly
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  emit({
    phase: 'finalizing',
    done: files.length,
    total: files.length,
    filesIndexed: result.filesIndexed,
    filesSkipped: result.filesSkipped,
    symbolsExtracted: result.symbolsExtracted,
    filesDeleted: result.filesDeleted,
  });

  // Remove deleted files from the index
  for (const storedPath of Object.keys(existingHashes)) {
    if (!indexedFiles.has(storedPath)) {
      store.deleteByFile(storedPath);
      result.filesDeleted++;
    }
  }

  result.durationSeconds = elapsed();
  store.recordIndex(result.durationSeconds);

  console.log(
    `AST index complete: ${result.filesIndexed} indexed, ` +
      `${result.filesSkipped} skipped, ${result.filesDeleted} deleted, ` +
      `${result.symbolsExtracted} symbols in ${result.durationSeconds.toFixed(1)}s`,
  );

  emit({
    phase: 'done',
    done: files.length,
    total: files.length,
    filesIndexed: result.filesIndexed,
    filesSkipped: result.filesSkipped,
    symbolsExtracted: result.symbolsExtracted,
    filesDeleted: result.filesDeleted,
    elapsedSeconds: result.durationSeconds,
  });

    return result;
  });
}

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

export interface UpsertFilesOptions {
  projectPath: string;
  rels: string[];
  /**
   * Frozen per-project config (ast_max_file_size) captured by the caller.
   * Falls back to the process-wide config when omitted.
   */
  config?: Config;
  /** @internal Test-only worker entry override for deterministic worker tests. */
  workerPath?: string;
}

export interface ASTIncrementalResult {
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  symbolsExtracted: number;
  errors: string[];
}

/**
 * Incrementally index a targeted set of files (project-relative paths).
 *
 * Runs in the AST worker by default so watcher/apply_patch flush batches
 * keep their tree-sitter parses + SQLite writes off the Electron main
 * process; falls back to the calling thread when the compiled worker is
 * unavailable (tests, unbundled dev runs). Non-source rels are no-ops; rels
 * that fail re-read (missing, oversized, binary, empty) are removed from the
 * store instead of indexed.
 */
export async function upsertFiles(opts: UpsertFilesOptions): Promise<ASTIncrementalResult> {
  return runAstWorker(
    buildAstWorkerStartData('upsert', opts),
    (msg) => (msg.type === 'incremental-result' ? { value: msg.result } : undefined),
    () => runUpsertFilesImpl(opts),
    undefined,
    opts.workerPath,
  );
}

/**
 * Core upsert implementation (runs on whatever thread calls it).
 *
 * Exported so the worker entry can invoke it without re-entering the
 * worker-spawning dispatcher on `upsertFiles`.
 */
export async function runUpsertFilesImpl(opts: UpsertFilesOptions): Promise<ASTIncrementalResult> {
  const cfg = opts.config ?? getConfig();
  const result: ASTIncrementalResult = {
    filesIndexed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    symbolsExtracted: 0,
    errors: [],
  };

  return withDisposableAsync(new ASTStore(opts.projectPath), async (store) => {
    store.initDb();
    const existingHashes = store.getAllFileHashes();

    for (const rel of new Set(opts.rels)) {
      const normalized = normalizeRel(opts.projectPath, rel);
      if (!shouldInclude(normalized)) continue;

      try {
        const readResult = await readAndHash(
          path.resolve(opts.projectPath, normalized),
          cfg.ast_max_file_size,
        );

        if (!readResult) {
          if (existingHashes[normalized]) {
            store.deleteByFile(normalized);
            result.filesDeleted++;
          }
        } else if (existingHashes[normalized] === readResult.hash) {
          result.filesSkipped++;
        } else {
          const symbols = await extractSymbols(normalized, readResult.content);
          store.upsertFile(normalized, readResult.hash, symbols);
          result.filesIndexed++;
          result.symbolsExtracted += symbols.length;
        }
      } catch (err) {
        const msg = `${normalized}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`AST incremental upsert error: ${msg}`);
        result.errors.push(msg);
      }
    }

    return result;
  });
}

export interface DeleteFilesOptions {
  /** @internal Test-only worker entry override for deterministic worker tests. */
  workerPath?: string;
}

/**
 * Stamp `last_auto_refresh` for a project (see `ASTStore.recordAutoRefresh`).
 * Called by the index refresh coordinator after a background flush lands AST
 * work; manual index runs keep using `last_indexed` only.
 */
export function touchAutoRefresh(projectPath: string): void {
  withDisposable(
    new ASTStore(projectPath),
    (store) => {
      store.initDb();
      store.recordAutoRefresh();
    },
  );
}

/**
 * Remove a targeted set of files (project-relative paths) from the symbol
 * store. Runs in the AST worker by default (same fallback as
 * {@link upsertFiles}); returns the number of stored files removed.
 */
export async function deleteFiles(
  projectPath: string,
  rels: string[],
  opts: DeleteFilesOptions = {},
): Promise<number> {
  return runAstWorker(
    buildAstWorkerStartData('delete', { projectPath, rels }),
    (msg) => (msg.type === 'delete-result' ? { value: msg.deleted } : undefined),
    () => runDeleteFilesImpl(projectPath, rels),
    undefined,
    opts.workerPath,
  );
}

/**
 * Core delete implementation (runs on whatever thread calls it). Exported so
 * the worker entry can invoke it without re-entering the `deleteFiles`
 * dispatcher.
 */
export async function runDeleteFilesImpl(projectPath: string, rels: string[]): Promise<number> {
  return withDisposableAsync(new ASTStore(projectPath), async (store) => {
    store.initDb();
    const existing = store.getAllFileHashes();
    let deleted = 0;
    for (const rel of new Set(rels)) {
      const normalized = normalizeRel(projectPath, rel);
      if (!(normalized in existing)) continue;
      store.deleteByFile(normalized);
      deleted++;
    }
    return deleted;
  });
}

// ---------------------------------------------------------------------------
// Worker runner (main process)
// ---------------------------------------------------------------------------

/**
 * Build the `workerData` start payload for one AST worker op.
 *
 * The default full-index run omits `op` so its wire shape stays
 * `{ projectPath, force }`; incremental runs carry `op` plus their `rels`.
 * Extracted so the op protocol is unit-testable without spawning a worker.
 */
export function buildAstWorkerStartData(
  op: 'index',
  args: { projectPath: string; force: boolean },
): AstWorkerStartData;
export function buildAstWorkerStartData(op: 'upsert', args: UpsertFilesOptions): AstWorkerStartData;
export function buildAstWorkerStartData(
  op: 'delete',
  args: { projectPath: string; rels: string[] },
): AstWorkerStartData;
export function buildAstWorkerStartData(
  op: 'index' | 'upsert' | 'delete',
  args: { projectPath: string; force?: boolean; rels?: string[]; config?: Config },
): AstWorkerStartData {
  if (op === 'upsert') {
    return { op, projectPath: args.projectPath, rels: args.rels ?? [], config: args.config };
  }
  if (op === 'delete') {
    return { op, projectPath: args.projectPath, rels: args.rels ?? [] };
  }
  return { projectPath: args.projectPath, force: args.force === true };
}

/** Live AST worker idle-watchdog timers (test observability for leak checks). */
const armedAstWorkerWatchdogs = new Set<ReturnType<typeof setTimeout>>();

/**
 * @internal Test-only: number of AST worker idle-watchdog timers currently
 * armed. Every settled (resolved, rejected, or watchdog-fired) worker run
 * must leave this at zero.
 */
export function getAstWorkerWatchdogArmedCountForTests(): number {
  return armedAstWorkerWatchdogs.size;
}

/**
 * Spawn the AST index worker for one op and settle its result.
 *
 * Progress messages forward to `progressCallback`, `takeResult` maps the
 * op-specific result message to the resolved value, and worker error /
 * early exit reject. An idle watchdog (same discipline as the RAG worker
 * path) rejects and terminates a wedged worker that posts no messages for
 * `background_command_idle_timeout` seconds (default 900s) — re-armed on
 * every inbound message, cleared on every settle path — so the shared
 * in-flight promise can never hang a project's pipeline forever. Falls back
 * to `inlineFallback` when the compiled worker file is missing or fails to
 * start.
 */
async function runAstWorker<T>(
  startData: AstWorkerStartData,
  takeResult: (msg: AstWorkerOutbound) => { value: T } | undefined,
  inlineFallback: () => Promise<T>,
  progressCallback?: ASTIndexProgressCallback,
  workerPathOverride?: string,
): Promise<T> {
  const workerPath = workerPathOverride ?? path.join(__dirname, 'index-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.warn(
      `AST worker not found at ${workerPath}; running inline on the calling thread`,
    );
    return inlineFallback();
  }

  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: startData,
      env: process.env,
    });
  } catch (err) {
    console.warn(
      `AST worker failed to start (${err instanceof Error ? err.message : String(err)}); running inline on the calling thread`,
    );
    return inlineFallback();
  }

  // Only the upsert start data carries a config today; index/delete runs (and
  // an upsert without one) default to 900s of allowed silence.
  const workerIdleTimeoutMs = Math.max(
    1,
    (((startData as { config?: Partial<Config> }).config as Partial<Config> | undefined)
      ?.background_command_idle_timeout ?? 900) * 1000,
  );

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const disarmWatchdog = () => {
      if (!watchdog) return;
      clearTimeout(watchdog);
      armedAstWorkerWatchdogs.delete(watchdog);
      watchdog = undefined;
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      disarmWatchdog();
      fn();
    };

    const armWatchdog = () => {
      if (settled) return;
      disarmWatchdog();
      const timer = setTimeout(() => {
        // The fired timer is no longer clearable; drop it from bookkeeping
        // before finishing so settle paths see a consistent state.
        armedAstWorkerWatchdogs.delete(timer);
        watchdog = undefined;
        finish(() => {
          void worker.terminate();
          reject(new Error(`AST index worker made no progress for ${workerIdleTimeoutMs}ms`));
        });
      }, workerIdleTimeoutMs);
      watchdog = timer;
      armedAstWorkerWatchdogs.add(timer);
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    };

    armWatchdog();

    worker.on('message', (msg: AstWorkerOutbound) => {
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
      const taken = takeResult(msg);
      if (taken) {
        finish(() => {
          void worker.terminate();
          resolve(taken.value);
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
        reject(new Error(`AST index worker exited unexpectedly with code ${code}`));
      });
    });
  });
}

async function runIndexInWorker(
  projectPath: string,
  force: boolean,
  progressCallback?: ASTIndexProgressCallback,
  config?: Config,
): Promise<ASTIndexResult> {
  return runAstWorker(
    buildAstWorkerStartData('index', { projectPath, force }),
    (msg) => (msg.type === 'result' ? { value: msg.result } : undefined),
    () => runIndexProjectImpl({ projectPath, force, progressCallback, config }),
    progressCallback,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Discover all supported source files in the project directory.
 */
async function discoverFiles(root: string, ignoredDirs: string[]): Promise<string[]> {
  const skip = new Set([...ignoredDirs, ...SKIP_DIRS]);
  const files: string[] = [];
  await walk(root, skip, files);
  return files.sort();
}

async function walk(directory: string, skip: Set<string>, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const subTasks: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        subTasks.push(walk(path.join(directory, entry.name), skip, out));
      }
    } else if (entry.isFile()) {
      const p = path.join(directory, entry.name);
      if (shouldInclude(p)) {
        out.push(p);
      }
    }
  }
  if (subTasks.length > 0) {
    await Promise.all(subTasks);
  }
}

function shouldInclude(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  return AST_INCLUDE_EXTS.has(ext);
}

/**
 * Canonicalize a caller-supplied rel path to the same key form a full scan
 * stores (`path.relative(projectPath, …)`).
 */
function normalizeRel(projectPath: string, rel: string): string {
  return path.relative(projectPath, path.resolve(projectPath, rel));
}

/**
 * Read file content and compute MD5 hash.
 * Returns null for files that should be skipped (too large, empty, binary).
 */
async function readAndHash(
  filepath: string,
  maxFileSize: number,
): Promise<{ content: string; hash: string } | null> {
  try {
    const stat = await fs.promises.stat(filepath);
    if (stat.size > maxFileSize) return null;
    if (stat.size === 0) return null;

    const content = await fs.promises.readFile(filepath, 'utf-8');
    if (content.includes('\0')) return null;

    const hash = crypto.createHash('md5').update(content).digest('hex');
    return { content, hash };
  } catch {
    return null;
  }
}

/**
 * Parse a file and extract symbols from tree-sitter captures.
 */
async function extractSymbols(filePath: string, content: string): Promise<Symbol[]> {
  let langName: string;
  try {
    langName = langForExtension(filePath);
  } catch {
    return [];
  }

  const queryText = await loadQueryFile(langName);
  const tree = await parseFile(filePath, content);
  try {
    const captures = await runQuery(tree, langName, queryText, content);

    const symbols: Symbol[] = [];
    const seen = new Set<string>();

    for (const [capName, results] of Object.entries(captures)) {
      if (capName.startsWith('name.definition.')) {
        const kind = capName.slice('name.definition.'.length);
        for (const r of results) {
          const key = `${r.text}:definition:${kind}:${r.startLine}:${r.startColumn}:${r.endLine}:${r.endColumn}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              name: r.text,
              type: 'definition',
              kind,
              startLine: r.startLine,
              startColumn: r.startColumn,
              endLine: r.endLine,
              endColumn: r.endColumn,
              charStart: r.startByte,
              charEnd: r.endByte,
            });
          }
        }
      } else if (capName === 'name.reference') {
        for (const r of results) {
          const key = `${r.text}:reference::${r.startLine}:${r.startColumn}:${r.endLine}:${r.endColumn}`;
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({
              name: r.text,
              type: 'reference',
              kind: '',
              startLine: r.startLine,
              startColumn: r.startColumn,
              endLine: r.endLine,
              endColumn: r.endColumn,
              charStart: r.startByte,
              charEnd: r.endByte,
            });
          }
        }
      }
    }

    return symbols;
  } finally {
    tree.delete();
  }
}

/**
 * Reset the session initialization state (for testing).
 */
export function resetSession(): void {
  initializedProjects.clear();
  activeIndexes.clear();
  activeIndexPromises.clear();
}
