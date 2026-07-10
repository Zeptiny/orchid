/**
 * RAG Indexer — file discovery → chunking → embedding → vector store.
 *
 * Ported from Python `src/orchid/rag/indexer.py`.
 *
 * - Full project index with MD5 hash change detection
 * - updateFile() for single-file re-index (post-write callback)
 * - File discovery: 25 extensions, ignored_dirs from config
 * - Auto re-index: post-write callback registered on module import
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import { chunkFile } from './chunker';
import { Embedder } from './embedder';
import { RAGStore } from './store';
import type { RAGStoreStatus } from '../../shared/types/ipc-boundary';
import type { RAGIndexResult } from '../../shared/types/ipc-boundary';

export type { RAGIndexResult } from '../../shared/types/ipc-boundary';
/** @deprecated Use RAGIndexResult from shared/types/ipc-boundary */
export type IndexResult = RAGIndexResult;

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

export function isIndexing(): boolean {
  return _indexing;
}

// ---------------------------------------------------------------------------
// Index project
// ---------------------------------------------------------------------------

/**
 * Run the full RAG indexing pipeline.
 *
 * @param projectPath - Root directory of the project. Uses cwd if undefined.
 * @param paths - Specific files/dirs to index. undefined = entire project.
 * @param force - If true, re-index everything regardless of hash.
 * @param embedder - Embedder instance. Creates one with defaults if undefined.
 * @param progressCallback - Optional (filePath, done, total) callback.
 */
export async function indexProject(
  projectPath?: string,
  paths?: string[],
  force?: boolean,
  embedder?: Embedder,
  progressCallback?: (filePath: string, done: number, total: number) => void,
): Promise<IndexResult> {
  if (_indexing) {
    return {
      filesScanned: 0, filesIndexed: 0, filesSkipped: 0,
      filesDeleted: 0, chunksCreated: 0, errors: [], durationSeconds: 0,
    };
  }
  _indexing = true;
  try {
    return await _indexProjectImpl(projectPath, paths, force, embedder, progressCallback);
  } finally {
    _indexing = false;
  }
}

async function _indexProjectImpl(
  projectPath?: string,
  paths?: string[],
  force?: boolean,
  embedder?: Embedder,
  progressCallback?: (filePath: string, done: number, total: number) => void,
): Promise<IndexResult> {
  const cfg = getConfig();
  const root = projectPath ?? process.cwd();
  const t0 = Date.now();

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

  if (files.length === 0) {
    const store = new RAGStore(root);
    store.initDb();
    store.touchLastIndexed();
    stats.durationSeconds = (Date.now() - t0) / 1000;
    return stats;
  }

  const store = new RAGStore(root);
  store.initDb();

  if (!embedder) {
    embedder = new Embedder(cfg.rag.embedding_model);
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

    if (progressCallback) {
      try {
        progressCallback(rel, i, files.length);
      } catch {
        // ignore callback errors
      }
    }

    try {
      // Read + hash
      const result = await readAndHash(filepath);
      if (!result) {
        if (existingHashes.has(rel)) {
          store.deleteByFileBatch(vectorState, rel);
        }
        continue;
      }

      const { content, hash } = result;

      // Skip unchanged
      if (!force && existingHashes.get(rel) === hash) {
        stats.filesSkipped++;
        indexedFiles.add(rel);
        continue;
      }

      // Chunk
      const chunks = chunkFile(rel, content, cfg.rag.chunk_size, cfg.rag.chunk_overlap);
      if (chunks.length === 0) {
        if (existingHashes.has(rel)) {
          store.deleteByFileBatch(vectorState, rel);
        }
        indexedFiles.add(rel);
        continue;
      }

      // Embed
      const texts = chunks.map((c) => c.content);
      const embeddingsFloat = await embedder.embed(texts);
      const embeddings = embeddingsFloat.map((e) => Array.from(e));

      store.upsertFileBatch(vectorState, rel, chunks, embeddings);
      stats.filesIndexed++;
      stats.chunksCreated += chunks.length;
      indexedFiles.add(rel);
      if (hash) fileHashes.set(rel, hash);
    } catch (err) {
      const msg = `${rel}: ${err instanceof Error ? err.message : String(err)}`;
      stats.errors.push(msg);
    }
  }

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

  stats.durationSeconds = (Date.now() - t0) / 1000;
  store.recordIndexDuration(stats.durationSeconds);

  return stats;
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
  const root = projectPath ?? process.cwd();
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
    const embedder = new Embedder(cfg.rag.embedding_model);
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
  const root = projectPath ?? process.cwd();
  const store = new RAGStore(root);
  return store.status();
}

export function clearIndex(projectPath?: string): void {
  const root = projectPath ?? process.cwd();
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
