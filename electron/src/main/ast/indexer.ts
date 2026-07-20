/**
 * AST Indexer — project-wide symbol indexing with hash change detection.
 *
 * Full project indexes run in a dedicated `worker_threads` worker so
 * tree-sitter WASM + SQLite work does not block the Electron main process.
 *
 * Ported from Python `src/orchid/ast/indexer.py`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { langForExtension, loadQueryFile, parseFile, runQuery } from './parser';
import { ASTStore, type Symbol } from './store';
import { getConfig } from '../config';
import { sleep } from '../utils/async';
import type { ASTIndexResult, ASTIndexProgress } from '../../shared/types/ipc-boundary';

export type { ASTIndexResult, ASTIndexProgress } from '../../shared/types/ipc-boundary';
/** @deprecated Use ASTIndexResult from shared/types/ipc-boundary */
export type IndexResult = ASTIndexResult;

export type ASTIndexProgressCallback = (progress: ASTIndexProgress) => void;

/** Payload passed to the AST index worker via workerData. */
export interface AstWorkerStartData {
  projectPath: string;
  force?: boolean;
}

/** Messages the AST index worker posts back to the parent. */
export type AstWorkerOutbound =
  | { type: 'progress'; progress: ASTIndexProgress }
  | { type: 'result'; result: ASTIndexResult }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AST_INCLUDE_EXTS = new Set(['.py', '.js', '.jsx', '.ts', '.tsx']);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__',
  '.venv', 'venv', 'env',
  '.orchid', 'dist', 'build',
  '.next', '.cache', 'target',
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Projects with a complete AST index available for index-dependent tools. */
const initializedProjects = new Set<string>();
/** In-flight runs keyed by project. Independent projects may index concurrently. */
const activeIndexes = new Map<string, ASTIndexProgress>();

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
  if (activeIndexes.has(key)) {
    while (activeIndexes.has(key) && !initializedProjects.has(key)) {
      await sleep(100);
    }
    return;
  }
  await indexProject({ projectPath });
}

export interface IndexProjectOptions {
  projectPath?: string;
  force?: boolean;
  progressCallback?: ASTIndexProgressCallback;
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
  if (activeIndexes.has(key)) {
    console.warn('AST indexing already in progress, skipping');
    const empty = makeIndexResult();
    empty.errors = ['Indexing already in progress'];
    return empty;
  }
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
      opts.projectPath,
      opts.force === true,
      trackProgress,
    );
    // Worker set its own session flag; mark main-process session as ready too
    // so ensureIndexed() short-circuits after a successful run.
    initializedProjects.add(key);
    return result;
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
export async function runIndexProjectImpl(opts: {
  projectPath?: string;
  force?: boolean;
  progressCallback?: ASTIndexProgressCallback;
}): Promise<ASTIndexResult> {
  const { force = false, progressCallback } = opts;
  const { projectPath } = opts;

  const cfg = getConfig();
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

  const store = new ASTStore(projectPath);
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
      const readResult = await readAndHash(filepath);

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
}

// ---------------------------------------------------------------------------
// Worker runner (main process)
// ---------------------------------------------------------------------------

async function runIndexInWorker(
  projectPath: string,
  force: boolean,
  progressCallback?: ASTIndexProgressCallback,
): Promise<ASTIndexResult> {
  const workerPath = path.join(__dirname, 'index-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.warn(
      `AST worker not found at ${workerPath}; running index inline on the main thread`,
    );
    return runIndexProjectImpl({ projectPath, force, progressCallback });
  }

  const startData: AstWorkerStartData = {
    projectPath,
    force,
  };

  return new Promise<ASTIndexResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: startData,
      env: process.env,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    worker.on('message', (msg: AstWorkerOutbound) => {
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
        reject(new Error(`AST index worker exited unexpectedly with code ${code}`));
      });
    });
  });
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
 * Read file content and compute MD5 hash.
 * Returns null for files that should be skipped (too large, empty, binary).
 */
async function readAndHash(filepath: string): Promise<{ content: string; hash: string } | null> {
  const cfg = getConfig();
  try {
    const stat = await fs.promises.stat(filepath);
    if (stat.size > cfg.ast_max_file_size) return null;
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
}
