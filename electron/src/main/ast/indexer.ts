/**
 * AST Indexer — project-wide symbol indexing with hash change detection.
 *
 * Walks the project directory, parses supported files, extracts symbols
 * via tree-sitter queries, and stores them in the SQLite symbol store.
 *
 * Features:
 * - Hash change detection (only re-parses modified files)
 * - Single-file update (for post-write callbacks)
 * - Lazy initialization (ensureIndexed)
 *
 * Ported from Python `src/orchid/ast/indexer.py`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { langForExtension, loadQueryFile, parseFile, runQuery } from './parser';
import { ASTStore, type Symbol } from './store';
import { getConfig } from '../config';

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

let _sessionInitialized = false;
let _indexing = false;

export function isIndexing(): boolean {
  return _indexing;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesDeleted: number;
  symbolsExtracted: number;
  errors: string[];
  durationSeconds: number;
}

function makeIndexResult(): IndexResult {
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
  if (_sessionInitialized) return;
  if (_indexing) {
    while (_indexing && !_sessionInitialized) {
      await sleep(100);
    }
    return;
  }
  await indexProject({ projectPath });
}

/**
 * Re-index a single file (used by post-write callbacks).
 */
export async function updateFile(
  filePath: string,
  projectPath?: string,
): Promise<void> {
  if (!projectPath) {
    projectPath = process.cwd();
  }

  let absPath = filePath;
  if (!path.isAbsolute(absPath)) {
    absPath = path.join(projectPath, filePath);
  }

  let rel: string;
  try {
    rel = path.relative(projectPath, absPath);
  } catch {
    return;
  }

  const store = new ASTStore(projectPath);
  store.initDb();

  const readResult = readAndHash(absPath);
  if (!readResult) {
    store.deleteByFile(rel);
    return;
  }

  const { content, hash } = readResult;
  const symbols = await extractSymbols(rel, content);
  store.upsertFile(rel, hash, symbols);
}

/**
 * Run a full AST indexing scan of the project.
 */
export async function indexProject(opts: {
  projectPath?: string;
  force?: boolean;
  progressCallback?: (filePath: string, done: number, total: number) => void;
} = {}): Promise<IndexResult> {
  if (_indexing) {
    console.warn('AST indexing already in progress, skipping');
    return makeIndexResult();
  }
  _indexing = true;
  try {
    return await indexProjectImpl(opts);
  } finally {
    _indexing = false;
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function indexProjectImpl(opts: {
  projectPath?: string;
  force?: boolean;
  progressCallback?: (filePath: string, done: number, total: number) => void;
}): Promise<IndexResult> {
  const { force = false, progressCallback } = opts;
  let { projectPath } = opts;

  const cfg = getConfig();
  if (!projectPath) {
    projectPath = process.cwd();
  }

  const t0 = Date.now();

  const files = discoverFiles(projectPath, cfg.ignored_dirs);
  const result = makeIndexResult();
  result.filesScanned = files.length;

  const store = new ASTStore(projectPath);
  store.initDb();

  const existingHashes = store.getAllFileHashes();
  const indexedFiles = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    const filepath = files[i];
    let rel: string;
    try {
      rel = path.relative(projectPath, filepath);
    } catch {
      continue;
    }

    if (progressCallback) {
      try {
        progressCallback(rel, i, files.length);
      } catch {
        // ignore callback errors
      }
    }

    try {
      const readResult = readAndHash(filepath);

      if (!readResult) {
        if (existingHashes[rel]) {
          store.deleteByFile(rel);
        }
        continue;
      }

      const { content, hash } = readResult;

      if (!force && existingHashes[rel] === hash) {
        result.filesSkipped++;
        indexedFiles.add(rel);
        continue;
      }

      const symbols = await extractSymbols(rel, content);
      store.upsertFile(rel, hash, symbols);
      result.filesIndexed++;
      result.symbolsExtracted += symbols.length;
      indexedFiles.add(rel);
    } catch (err) {
      const msg = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`AST indexing error: ${msg}`);
      result.errors.push(msg);
    }
  }

  // Remove deleted files from the index
  for (const storedPath of Object.keys(existingHashes)) {
    if (!indexedFiles.has(storedPath)) {
      store.deleteByFile(storedPath);
      result.filesDeleted++;
    }
  }

  result.durationSeconds = (Date.now() - t0) / 1000;
  _sessionInitialized = true;

  store.recordIndex(result.durationSeconds);

  console.log(
    `AST index complete: ${result.filesIndexed} indexed, ` +
    `${result.filesSkipped} skipped, ${result.filesDeleted} deleted, ` +
    `${result.symbolsExtracted} symbols in ${result.durationSeconds.toFixed(1)}s`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discover all supported source files in the project directory.
 */
function discoverFiles(root: string, ignoredDirs: string[]): string[] {
  const skip = new Set([...ignoredDirs, ...SKIP_DIRS]);
  const files: string[] = [];
  walk(root, skip, files);
  return files.sort();
}

function walk(directory: string, skip: Set<string>, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        walk(path.join(directory, entry.name), skip, out);
      }
    } else if (entry.isFile()) {
      const p = path.join(directory, entry.name);
      if (shouldInclude(p)) {
        out.push(p);
      }
    }
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
function readAndHash(filepath: string): { content: string; hash: string } | null {
  const cfg = getConfig();
  try {
    const stat = fs.statSync(filepath);
    if (stat.size > cfg.ast_max_file_size) return null;
    if (stat.size === 0) return null;

    const content = fs.readFileSync(filepath, 'utf-8');
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
  _sessionInitialized = false;
  _indexing = false;
}
