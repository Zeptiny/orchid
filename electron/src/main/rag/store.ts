/**
 * Vector Store — SQLite + Float32Array vectors with cosine similarity search.
 *
 * - better-sqlite3 with WAL mode
 * - Tables: chunks, files, meta
 * - Vectors stored as .npy files (Float32Array)
 * - Cosine similarity: (V @ q) / (||V|| * ||q||)
 * - Process-level search cache (LRU-bounded; vectors as compact Float32 matrix;
 *   chunk text loaded only for top-k hits)
 * - Corruption recovery (auto-rebuild)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import { openSqliteDb, isSqliteCorruptionError, deleteSqliteDb, type SqliteDatabase } from '../utils/sqlite';
import type { Chunk } from './chunker';
import type { RAGStoreStatus } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_RAG_DIR = '.orchid/rag';
const RAG_INDEX_DB = 'index.db';
const RAG_VECTORS_FILE = 'vectors.npy';
const RAG_VECTOR_IDS_FILE = 'vector_ids.json';

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    file_path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface VectorState {
  chunkIds: number[];
  vectors: number[][];
  idToIndex: Map<number, number>;
  /**
   * False when vectors.npy does not line up with the chunks table (e.g. a
   * previous index run was interrupted before the final vector flush).
   * Callers must force a full rebuild instead of continuing incrementally,
   * or vector rows would be scored against the wrong chunks.
   */
  consistent: boolean;
}

/** Lightweight chunk row used for search scoring (no content payload). */
interface ChunkMeta {
  chunk_id: number;
  file_path: string;
  start_line: number;
  end_line: number;
}

/** Compact row-major float32 matrix used by the search path. */
interface SearchMatrix {
  data: Float32Array;
  rows: number;
  cols: number;
}

interface SearchCacheEntry {
  matrix: SearchMatrix;
  chunks: ChunkMeta[];
}

/** Max projects kept in the process-level search cache (LRU). */
const MAX_SEARCH_CACHE_ENTRIES = 3;

/**
 * OOM protection: max total bytes across all cached entries.
 * A 50k-chunk project with 384 dims uses ~76MB for the Float32 matrix alone.
 * Capping at 200MB keeps the main process heap safe even with 2–3 large projects.
 */
const MAX_SEARCH_CACHE_BYTES = 200 * 1024 * 1024;

/**
 * OOM protection: entries larger than this are not cached at all.
 * A single massive index (>100MB) is loaded from disk on each search rather
 * than pinning the main process heap.
 */
const MAX_SINGLE_ENTRY_BYTES = 100 * 1024 * 1024;

/** Estimate the byte size of a search cache entry (matrix + chunk metadata). */
function estimateSearchCacheEntryBytes(entry: SearchCacheEntry): number {
  // Float32Array data buffer (rows * cols * 4 bytes)
  const matrixBytes = entry.matrix.data.byteLength;
  // ChunkMeta: ~200 bytes average per row (file_path string + 3 integers)
  const chunkMetaBytes = entry.chunks.length * 200;
  return matrixBytes + chunkMetaBytes;
}

// ---------------------------------------------------------------------------
// Helpers — .npy format
// ---------------------------------------------------------------------------

/**
 * Serialize a 2D Float32Array to .npy format (numpy compatible).
 */
function saveNpy(filePath: string, vectors: number[][]): void {
  if (vectors.length === 0) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }

  const rows = vectors.length;
  const cols = vectors[0]!.length;
  const data = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      data[i * cols + j] = vectors[i]![j]!;
    }
  }

  // .npy format: header + raw data
  // numpy v1.0 header: {'descr': '<f4', 'fortran_order': False, 'shape': (N, M)}
  // The total size of: magic(6) + major(1) + minor(1) + headerLen(2) + header
  // must be evenly divisible by 16 for alignment.
  const preambleLen = 10; // 6 + 1 + 1 + 2
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${cols})}`;
  // Pad header so (preambleLen + header.length + 1) % 16 == 0 (+1 for the trailing \n)
  const currentLen = preambleLen + header.length + 1;
  const padding = (16 - (currentLen % 16)) % 16;
  header = header + ' '.repeat(padding) + '\n';
  const headerBytes = Buffer.from(header, 'ascii');

  // Magic: \x93NUMPY + version 1.0 + header_len (2 bytes LE) + header
  const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]); // \x93NUMPY
  const version = Buffer.from([0x01, 0x00]); // 1.0
  const headerLen = Buffer.alloc(2);
  headerLen.writeUInt16LE(headerBytes.length);

  const buffer = Buffer.concat([
    magic,
    version,
    headerLen,
    headerBytes,
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  ]);

  // Atomic write
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, filePath);
}

/**
 * Load a .npy file as a compact row-major Float32Array matrix.
 * Prefer this for search — ~4× less memory than number[][] and better locality.
 */
function loadNpyMatrix(filePath: string): SearchMatrix | null {
  if (!fs.existsSync(filePath)) return null;

  try {
    const buffer = fs.readFileSync(filePath);

    // Verify magic
    if (buffer[0] !== 0x93 || buffer.toString('ascii', 1, 6) !== 'NUMPY') {
      throw new Error('Invalid .npy magic');
    }

    // Parse header length (offset 8-9 for v1.0)
    const headerLen = buffer.readUInt16LE(8);
    const headerStr = buffer.toString('ascii', 10, 10 + headerLen);

    // Extract shape — handle both {'shape': (N, M)} and shape=(N, M) formats
    const shapeMatch = headerStr.match(/'shape':\s*\((\d+),\s*(\d+)\)/);
    if (!shapeMatch) throw new Error('Cannot parse .npy shape');
    const rows = parseInt(shapeMatch[1]!, 10);
    const cols = parseInt(shapeMatch[2]!, 10);

    const dataOffset = 10 + headerLen;
    const expectedBytes = rows * cols * 4;
    if (buffer.byteLength < dataOffset + expectedBytes) {
      throw new Error('Truncated .npy data');
    }

    // Copy into a dedicated Float32Array so the full file buffer can be GC'd.
    // Node Buffer endianness is platform-native; .npy '<f4' is little-endian.
    const data = new Float32Array(rows * cols);
    for (let i = 0; i < data.length; i++) {
      data[i] = buffer.readFloatLE(dataOffset + i * 4);
    }

    return { data, rows, cols };
  } catch {
    // Corrupted vectors — caller should clear
    return null;
  }
}

/**
 * Load a .npy file as a 2D array of number[] (write/update path).
 */
function loadNpy(filePath: string): number[][] | null {
  const matrix = loadNpyMatrix(filePath);
  if (!matrix) return null;

  const { data, rows, cols } = matrix;
  const vectors: number[][] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const row = new Array<number>(cols);
    const base = i * cols;
    for (let j = 0; j < cols; j++) {
      row[j] = data[base + j]!;
    }
    vectors[i] = row;
  }
  return vectors;
}

/** True when two ordered ID lists contain identical values at every index. */
function idListsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// RAGStore
// ---------------------------------------------------------------------------

/**
 * Vector store backed by SQLite + .npy files.
 *
 * Provides upsert, search, and file-level operations for the RAG pipeline.
 * Uses WAL mode for concurrent reads and process-level caching for search.
 */
export class RAGStore {
  readonly projectPath: string;
  readonly ragDir: string;
  readonly dbPath: string;
  readonly vectorsFile: string;
  /** Sidecar mapping vectors.npy rows to chunk IDs (alignment verification). */
  readonly vectorIdsFile: string;

  /** Cached database connection (lazy-opened, reused). */
  private _db: SqliteDatabase | null = null;

  /**
   * Process-level search cache: dbPath -> compact matrix + chunk meta.
   * LRU-bounded (Map insertion order); content is NOT cached.
   */
  private static _searchCache = new Map<string, SearchCacheEntry>();

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.ragDir = path.join(projectPath, PROJECT_RAG_DIR);
    this.dbPath = path.join(this.ragDir, RAG_INDEX_DB);
    this.vectorsFile = path.join(this.ragDir, RAG_VECTORS_FILE);
    this.vectorIdsFile = path.join(this.ragDir, RAG_VECTOR_IDS_FILE);
  }

  /**
   * Close the cached database connection. Call on shutdown or when the
   * store is no longer needed.
   */
  dispose(): void {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        // ignore
      }
      this._db = null;
    }
  }

  // -------------------------------------------------------------------------
  // Database init / recovery
  // -------------------------------------------------------------------------

  /** Ensure the RAG directory and database schema exist. */
  initDb(): void {
    this._ensureDir();
    try {
      const db = openSqliteDb(this.dbPath);
      db.exec(DB_SCHEMA);
      db.close();
    } catch (err) {
      if (!isSqliteCorruptionError(err)) throw err;
      this._rebuildDb();
    }
    // Close any cached connection so _getDb() picks up the schema
    this.dispose();
  }

  private _ensureDir(): void {
    fs.mkdirSync(this.ragDir, { recursive: true });
  }

  private _rebuildDb(): void {
    this.dispose();
    deleteSqliteDb(this.dbPath);
    this._clearVectorsFile();
    const db = openSqliteDb(this.dbPath);
    db.exec(DB_SCHEMA);
    db.close();
    this._invalidateCache();
  }

  private _getDb(): SqliteDatabase {
    if (this._db) return this._db;
    this._ensureDir();
    try {
      this._db = openSqliteDb(this.dbPath);
      // Quick corruption check
      this._db.prepare('SELECT 1 FROM chunks LIMIT 1').get();
      return this._db;
    } catch (err) {
      if (!isSqliteCorruptionError(err) && !(err instanceof Error && err.message.includes('no such table'))) {
        throw err;
      }
      if (this._db) {
        try { this._db.close(); } catch { /* ignore */ }
        this._db = null;
      }
      this._rebuildDb();
      this._db = openSqliteDb(this.dbPath);
      return this._db;
    }
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  private _invalidateCache(): void {
    RAGStore._searchCache.delete(this.dbPath);
  }

  /** Sum of estimated bytes across all cached entries. */
  private static _totalCacheBytes(): number {
    let total = 0;
    for (const entry of RAGStore._searchCache.values()) {
      total += estimateSearchCacheEntryBytes(entry);
    }
    return total;
  }

  /**
   * Clear all cached search data across all projects.
   * Call on memory pressure or when bulk-invalidation is needed.
   */
  static clearCache(): void {
    RAGStore._searchCache.clear();
  }

  /** Return current cache statistics (entries and estimated byte usage). */
  static cacheStats(): { entries: number; estimatedBytes: number } {
    return {
      entries: RAGStore._searchCache.size,
      estimatedBytes: RAGStore._totalCacheBytes(),
    };
  }

  /** Insert/refresh a cache entry and evict least-recently-used over capacity. */
  private _setSearchCache(entry: SearchCacheEntry): void {
    const key = this.dbPath;
    const entryBytes = estimateSearchCacheEntryBytes(entry);

    // Skip caching entries that are too large — loading from disk on each
    // search is cheaper than pinning hundreds of MB in the main process heap.
    if (entryBytes > MAX_SINGLE_ENTRY_BYTES) return;

    // Re-insert to mark as most recently used (Map preserves insertion order).
    RAGStore._searchCache.delete(key);
    RAGStore._searchCache.set(key, entry);

    // Evict LRU entries until both count and byte limits are satisfied.
    // Keep at least one entry (the just-inserted one) to avoid thrashing.
    while (
      RAGStore._searchCache.size > MAX_SEARCH_CACHE_ENTRIES ||
      RAGStore._totalCacheBytes() > MAX_SEARCH_CACHE_BYTES
    ) {
      if (RAGStore._searchCache.size <= 1) break;
      const oldest = RAGStore._searchCache.keys().next().value;
      if (oldest === undefined) break;
      RAGStore._searchCache.delete(oldest);
    }
  }

  private _getSearchCache(): SearchCacheEntry | undefined {
    const key = this.dbPath;
    const entry = RAGStore._searchCache.get(key);
    if (!entry) return undefined;
    // Touch: move to end (most recently used).
    RAGStore._searchCache.delete(key);
    RAGStore._searchCache.set(key, entry);
    return entry;
  }

  private _clearVectorsFile(): void {
    for (const file of [this.vectorsFile, this.vectorIdsFile]) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Upsert (full replace)
  // -------------------------------------------------------------------------

  /**
   * Replace ALL chunks and vectors (full re-index).
   */
  upsert(chunks: Chunk[], embeddings: number[][]): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `Chunks (${chunks.length}) and embeddings (${embeddings.length}) count mismatch`,
      );
    }

    this._ensureDir();
    this._invalidateCache();

    const db = this._getDb();
    db.exec('DELETE FROM chunks');
    db.exec('DELETE FROM files');

    if (chunks.length > 0) {
      const insertChunk = db.prepare(
        'INSERT INTO chunks (file_path, start_line, end_line, content) VALUES (?, ?, ?, ?)',
      );
      const insertMany = db.transaction((rows: Chunk[]) => {
        for (const c of rows) {
          insertChunk.run(c.filePath, c.startLine, c.endLine, c.content);
        }
      });
      insertMany(chunks);

      // Count chunks per file
      const fileChunks = new Map<string, number>();
      for (const c of chunks) {
        fileChunks.set(c.filePath, (fileChunks.get(c.filePath) ?? 0) + 1);
      }

      const insertFile = db.prepare(
        'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
      );
      for (const [fp, count] of fileChunks) {
        insertFile.run(fp, '', count);
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ).run('last_indexed', now);

    // Write vectors after the DB commit, alongside the committed chunk IDs,
    // so the persisted id sidecar keeps vector rows verifiable against the
    // chunks table. If this write is interrupted, loadVectorState() detects
    // the mismatch and the next index run forces a full rebuild.
    const chunkIds = this._getOrderedChunkIds();
    this._saveVectors(embeddings, chunkIds);
  }

  // -------------------------------------------------------------------------
  // Upsert single file (preserves other files)
  // -------------------------------------------------------------------------

  /**
   * Replace chunks and embeddings for a single file.
   * Preserves chunks and vectors for all other files.
   */
  upsertFile(
    filePath: string,
    chunks: Chunk[],
    embeddings: number[][],
  ): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `Chunks (${chunks.length}) and embeddings (${embeddings.length}) count mismatch`,
      );
    }

    this._invalidateCache();

    const oldIds = this._getOrderedChunkIds();
    const oldVectors = this._loadVectorsArray();

    if (oldIds.length > 0 && (!oldVectors || oldVectors.length !== oldIds.length)) {
      console.warn(
        `[RAGStore] upsertFile: vectors missing/corrupted or length mismatch ` +
          `(oldIds=${oldIds.length}, vectors=${oldVectors?.length ?? 'null'}). ` +
          `Clearing tables and vectors file; full reindex recommended. ` +
          `Rebuilding index with current file only to maintain consistency.`,
      );
      const dbToReset = this._getDb();
      dbToReset.exec('DELETE FROM chunks');
      dbToReset.exec('DELETE FROM files');
      this._clearVectorsFile();
      const freshDb = this._getDb();
      if (chunks.length > 0) {
        const insertChunk = freshDb.prepare(
          'INSERT INTO chunks (file_path, start_line, end_line, content) VALUES (?, ?, ?, ?)',
        );
        for (const c of chunks) {
          insertChunk.run(c.filePath, c.startLine, c.endLine, c.content);
        }
        freshDb
          .prepare(
            'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
          )
          .run(filePath, '', chunks.length);
      } else {
        freshDb
          .prepare(
            'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
          )
          .run(filePath, '', 0);
      }
      freshDb
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('last_indexed', new Date().toISOString());
      this._saveVectors(embeddings, this._chunkIdsForFile(filePath));
      return;
    }

    const idToVec = new Map<number, number[]>();
    if (oldVectors && oldVectors.length === oldIds.length) {
      for (let i = 0; i < oldIds.length; i++) {
        idToVec.set(oldIds[i]!, oldVectors[i]!);
      }
    }

    const db = this._getDb();
    db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);

    if (chunks.length > 0) {
      const insertChunk = db.prepare(
        'INSERT INTO chunks (file_path, start_line, end_line, content) VALUES (?, ?, ?, ?)',
      );
      for (const c of chunks) {
        insertChunk.run(c.filePath, c.startLine, c.endLine, c.content);
      }
      db.prepare(
        'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
      ).run(filePath, '', chunks.length);
    } else {
      db.prepare(
        'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
      ).run(filePath, '', 0);
    }

    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ).run('last_indexed', now);

    // Rebuild vectors: keep old vectors for surviving chunks, append new
    const fileNewIdSet = new Set(this._chunkIdsForFile(filePath));
    if (fileNewIdSet.size !== embeddings.length) {
      throw new Error(
        `upsertFile: file chunk ID count (${fileNewIdSet.size}) does not match embeddings count (${embeddings.length}) for ${filePath}`,
      );
    }
    const newIds = this._getOrderedChunkIds();
    const newVectors: number[][] = [];
    let embedIdx = 0;
    for (const cid of newIds) {
      if (idToVec.has(cid)) {
        newVectors.push(idToVec.get(cid)!);
      } else if (fileNewIdSet.has(cid) && embedIdx < embeddings.length) {
        newVectors.push(embeddings[embedIdx]!);
        embedIdx++;
      }
    }

    if (newVectors.length !== newIds.length) {
      throw new Error(
        `upsertFile: rebuilt vectors length (${newVectors.length}) does not match chunk IDs length (${newIds.length}); refusing to save truncated vectors`,
      );
    }

    this._saveVectors(newVectors, newIds);
  }

  // -------------------------------------------------------------------------
  // Batch operations (VectorState-based)
  // -------------------------------------------------------------------------

  /**
   * Load chunk IDs + vectors, building a position index.
   * Used by the batch indexer to avoid repeated reads.
   *
   * When vectors.npy does not line up with the chunks table — a count
   * mismatch or a disagreement with the persisted chunk-id sidecar, e.g.
   * after an interrupted index run — returns an empty state with
   * `consistent: false`. Callers must force a full rebuild instead of
   * continuing incrementally, or vector rows would be permanently scored
   * against the wrong chunks.
   */
  loadVectorState(): VectorState {
    const empty = (consistent: boolean): VectorState => ({
      chunkIds: [],
      vectors: [],
      idToIndex: new Map(),
      consistent,
    });

    const chunkIds = this._getOrderedChunkIds();
    const vectors = this._loadVectorsArray();

    if (chunkIds.length === 0) {
      return empty(!vectors || vectors.length === 0);
    }
    if (!vectors || vectors.length !== chunkIds.length) {
      return empty(false);
    }

    const persistedIds = this._loadVectorIds();
    if (persistedIds && !idListsEqual(persistedIds, chunkIds)) {
      return empty(false);
    }

    const idToIndex = new Map<number, number>();
    for (let i = 0; i < chunkIds.length; i++) {
      idToIndex.set(chunkIds[i]!, i);
    }
    return { chunkIds: [...chunkIds], vectors: [...vectors], idToIndex, consistent: true };
  }

  /**
   * Batch upsert: mutate state in place, do NOT write vectors.npy.
   * SQLite is updated; new chunk IDs + embeddings appended to state.
   */
  upsertFileBatch(
    state: VectorState,
    filePath: string,
    chunks: Chunk[],
    embeddings: number[][],
  ): void {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `Chunks (${chunks.length}) and embeddings (${embeddings.length}) count mismatch`,
      );
    }

    this._invalidateCache();

    const oldIds = this._chunkIdsForFile(filePath);

    const db = this._getDb();
    db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);

    if (chunks.length > 0) {
      const insertChunk = db.prepare(
        'INSERT INTO chunks (file_path, start_line, end_line, content) VALUES (?, ?, ?, ?)',
      );
      for (const c of chunks) {
        insertChunk.run(c.filePath, c.startLine, c.endLine, c.content);
      }
      db.prepare(
        'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
      ).run(filePath, '', chunks.length);
    } else {
      db.prepare(
        'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) VALUES (?, ?, ?)',
      ).run(filePath, '', 0);
    }

    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ).run('last_indexed', now);

    // Drop old vectors for this file from state
    const dropIndices = oldIds
      .filter((cid) => state.idToIndex.has(cid))
      .map((cid) => state.idToIndex.get(cid)!)
      .sort((a, b) => b - a); // descending for safe removal

    for (const idx of dropIndices) {
      state.chunkIds.splice(idx, 1);
      state.vectors.splice(idx, 1);
    }

    // Get new chunk IDs after DB write
    const newIds = this._chunkIdsForFile(filePath);

    // Append new chunk IDs + embeddings
    for (let i = 0; i < newIds.length; i++) {
      state.chunkIds.push(newIds[i]!);
      state.vectors.push(embeddings[i]!);
    }

    // Rebuild position index
    state.idToIndex = new Map<number, number>();
    for (let i = 0; i < state.chunkIds.length; i++) {
      state.idToIndex.set(state.chunkIds[i]!, i);
    }
  }

  /**
   * Batch delete: mutate state in place, do NOT write vectors.npy.
   */
  deleteByFileBatch(state: VectorState, filePath: string): void {
    this._invalidateCache();

    const oldIds = this._chunkIdsForFile(filePath);

    const db = this._getDb();
    db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);

    const dropIndices = oldIds
      .filter((cid) => state.idToIndex.has(cid))
      .map((cid) => state.idToIndex.get(cid)!)
      .sort((a, b) => b - a);

    for (const idx of dropIndices) {
      state.chunkIds.splice(idx, 1);
      state.vectors.splice(idx, 1);
    }

    state.idToIndex = new Map<number, number>();
    for (let i = 0; i < state.chunkIds.length; i++) {
      state.idToIndex.set(state.chunkIds[i]!, i);
    }
  }

  /**
   * Single write of the accumulated vectors to vectors.npy (+ id sidecar).
   */
  flushVectorState(state: VectorState): void {
    this._saveVectors(state.vectors, state.chunkIds);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /**
   * Delete all chunks and embeddings for a single file.
   */
  deleteByFile(filePath: string): void {
    this._invalidateCache();

    const oldIds = this._getOrderedChunkIds();
    const vectors = this._loadVectorsArray();

    const db = this._getDb();
    db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);

    if (!vectors || vectors.length !== oldIds.length) {
      this._clearVectorsFile();
      return;
    }

    const idToVec = new Map<number, number[]>();
    for (let i = 0; i < oldIds.length; i++) {
      idToVec.set(oldIds[i]!, vectors[i]!);
    }

    const newIds = this._getOrderedChunkIds();
    const alignedIds = newIds.filter((cid) => idToVec.has(cid));
    const aligned = alignedIds.map((cid) => idToVec.get(cid)!);

    if (aligned.length > 0) {
      this._saveVectors(aligned, alignedIds);
    } else {
      this._clearVectorsFile();
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search for chunks similar to the query embedding.
   *
   * Uses a compact Float32 matrix + metadata-only cache; chunk text is loaded
   * only for the top-k hits after scoring.
   */
  search(
    queryEmbedding: number[],
    topK?: number,
    filePattern?: string,
  ): SearchResult[] {
    const cfg = getConfig();
    const k = topK ?? cfg.rag.top_k;

    const data = this._loadSearchData();
    if (!data) return [];

    const { matrix, chunks } = data;
    // _loadSearchData() only returns aligned data (vector row i ↔ chunks[i]);
    // a misaligned store returns null above instead of scoring wrong chunks.
    const n = chunks.length;
    if (n === 0 || queryEmbedding.length === 0 || matrix.cols === 0) return [];

    // Dimension check
    if (queryEmbedding.length !== matrix.cols) {
      throw new Error(
        `Query embedding dimension (${queryEmbedding.length}) does not match ` +
          `stored vector dimension (${matrix.cols}). Re-index with the correct embedding model.`,
      );
    }

    // Pre-filter by filePattern before scoring — score only matching rows by
    // index (no vector copy). Compile regex once (P1-3).
    let candidateIndices: number[] | null = null;
    if (filePattern) {
      const re = compilePattern(filePattern);
      candidateIndices = [];
      for (let i = 0; i < n; i++) {
        if (re.test(chunks[i]!.file_path)) {
          candidateIndices.push(i);
        }
      }
      if (candidateIndices.length === 0) return [];
    }

    // Score candidates (or all rows) in-place against the Float32 matrix.
    const top = cosineTopK(queryEmbedding, matrix, k, candidateIndices, n);

    // Fetch text only for top-k hits.
    const contentById = this._getChunkContents(top.map((t) => chunks[t.idx]!.chunk_id));

    const results: SearchResult[] = [];
    for (const { score, idx } of top) {
      const chunk = chunks[idx]!;
      results.push({
        filePath: chunk.file_path,
        content: contentById.get(chunk.chunk_id) ?? '',
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        score,
      });
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Status / metadata
  // -------------------------------------------------------------------------

  status(): RAGStoreStatus {
    if (!fs.existsSync(this.dbPath)) {
      return { totalChunks: 0, totalFiles: 0, lastIndexed: null, lastIndexDuration: null };
    }

    const db = this._getDb();
    const chunkCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }
    ).cnt;
    const fileCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }
    ).cnt;
    const lastRow = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('last_indexed') as { value: string } | undefined;
    const durationRow = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('last_index_duration') as { value: string } | undefined;

    return {
      totalChunks: chunkCount,
      totalFiles: fileCount,
      lastIndexed: lastRow?.value ?? null,
      lastIndexDuration: durationRow ? parseFloat(durationRow.value) : null,
    };
  }

  recordIndexDuration(duration: number): void {
    this._invalidateCache();
    const db = this._getDb();
    db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ).run('last_index_duration', String(duration));
  }

  touchLastIndexed(): void {
    this._invalidateCache();
    const db = this._getDb();
    db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    ).run('last_indexed', new Date().toISOString());
  }

  getFileHashes(): Map<string, string> {
    if (!fs.existsSync(this.dbPath)) return new Map();

    const db = this._getDb();
    const rows = db.prepare('SELECT file_path, hash FROM files').all() as {
      file_path: string;
      hash: string;
    }[];
    return new Map(rows.map((r) => [r.file_path, r.hash]));
  }

  updateFileHash(filePath: string, hash: string): void {
    this.updateFileHashesBatch(new Map([[filePath, hash]]));
  }

  updateFileHashesBatch(hashes: Map<string, string>): void {
    if (hashes.size === 0) return;
    this._invalidateCache();
    const db = this._getDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO files (file_path, hash, chunk_count) ' +
        'VALUES (?, ?, COALESCE((SELECT chunk_count FROM files WHERE file_path = ?), 0))',
    );
    for (const [fp, h] of hashes) {
      stmt.run(fp, h, fp);
    }
  }

  // -------------------------------------------------------------------------
  // Clear
  // -------------------------------------------------------------------------

  clear(): void {
    this.dispose();
    deleteSqliteDb(this.dbPath);
    this._clearVectorsFile();
    this._invalidateCache();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _saveVectors(embeddings: number[][], chunkIds: number[]): void {
    this._ensureDir();
    if (embeddings.length === 0) {
      this._clearVectorsFile();
      this._invalidateCache();
      return;
    }
    if (embeddings.length !== chunkIds.length) {
      throw new Error(
        `_saveVectors: embeddings (${embeddings.length}) and chunk ids (${chunkIds.length}) count mismatch`,
      );
    }

    saveNpy(this.vectorsFile, embeddings);
    this._saveVectorIds(chunkIds);
    this._invalidateCache();
  }

  /**
   * Atomically persist the ordered chunk IDs that vectors.npy rows correspond
   * to. Makes row↔chunk alignment verifiable after crashes/interruptions
   * instead of relying on positional coincidence.
   */
  private _saveVectorIds(chunkIds: number[]): void {
    this._ensureDir();
    const tmpPath = `${this.vectorIdsFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(chunkIds));
    fs.renameSync(tmpPath, this.vectorIdsFile);
  }

  /**
   * Load the persisted vector-row → chunk-ID mapping.
   * Returns null when the sidecar is absent (legacy index written before the
   * sidecar existed) and [] when it is corrupt — a corrupt sidecar cannot
   * prove alignment, so it is treated as a mismatch.
   */
  private _loadVectorIds(): number[] | null {
    if (!fs.existsSync(this.vectorIdsFile)) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.vectorIdsFile, 'utf-8'));
      if (
        Array.isArray(parsed) &&
        parsed.every((v) => typeof v === 'number' && Number.isInteger(v))
      ) {
        return parsed as number[];
      }
      return [];
    } catch {
      return [];
    }
  }

  private _loadVectorsArray(): number[][] | null {
    if (!fs.existsSync(this.vectorsFile)) return null;
    const vectors = loadNpy(this.vectorsFile);
    if (!vectors) {
      // Corrupted — clear index
      this.clear();
      return null;
    }
    return vectors;
  }

  private _getOrderedChunkIds(): number[] {
    const db = this._getDb();
    const rows = db
      .prepare('SELECT chunk_id FROM chunks ORDER BY chunk_id')
      .all() as { chunk_id: number }[];
    return rows.map((r) => r.chunk_id);
  }

  private _chunkIdsForFile(filePath: string): number[] {
    const db = this._getDb();
    const rows = db
      .prepare(
        'SELECT chunk_id FROM chunks WHERE file_path = ? ORDER BY chunk_id',
      )
      .all(filePath) as { chunk_id: number }[];
    return rows.map((r) => r.chunk_id);
  }

  /** Metadata only — content is fetched for top-k hits after scoring. */
  private _getChunkMetas(): ChunkMeta[] {
    const db = this._getDb();
    return db
      .prepare(
        'SELECT chunk_id, file_path, start_line, end_line FROM chunks ORDER BY chunk_id',
      )
      .all() as ChunkMeta[];
  }

  /** Load content for the given chunk IDs (top-k only). */
  private _getChunkContents(ids: number[]): Map<number, string> {
    if (ids.length === 0) return new Map();
    const db = this._getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT chunk_id, content FROM chunks WHERE chunk_id IN (${placeholders})`,
      )
      .all(...ids) as { chunk_id: number; content: string }[];
    return new Map(rows.map((r) => [r.chunk_id, r.content]));
  }

  private _loadSearchData(): SearchCacheEntry | null {
    const cached = this._getSearchCache();
    if (cached) return cached;

    const matrix = this._loadVectorsMatrix();
    if (!matrix) return null;

    const chunks = this._getChunkMetas();
    if (chunks.length === 0) return null;

    // Alignment guard: search pairs vector row i with chunks[i] (ordered by
    // chunk_id). If the vector file and the chunks table disagree — e.g. an
    // index run was interrupted before the final flush — scoring would match
    // embeddings to the wrong chunks and silently return wrong files. Fail
    // closed (empty results) instead; the next full index repairs the store.
    if (!this._alignmentConsistent(matrix.rows, chunks)) {
      return null;
    }

    const entry: SearchCacheEntry = { matrix, chunks };
    this._setSearchCache(entry);
    return entry;
  }

  /**
   * Verify vector rows align with DB chunks before scoring. Uses the persisted
   * chunk-id sidecar when present (exact alignment), otherwise falls back to a
   * row-count comparison for legacy indexes.
   */
  private _alignmentConsistent(vectorRows: number, chunks: ChunkMeta[]): boolean {
    const persistedIds = this._loadVectorIds();
    if (persistedIds) {
      if (persistedIds.length !== chunks.length) return false;
      for (let i = 0; i < chunks.length; i++) {
        if (persistedIds[i] !== chunks[i]!.chunk_id) return false;
      }
      return true;
    }
    return vectorRows === chunks.length;
  }

  private _loadVectorsMatrix(): SearchMatrix | null {
    if (!fs.existsSync(this.vectorsFile)) return null;
    const matrix = loadNpyMatrix(this.vectorsFile);
    if (!matrix) {
      // Corrupted — clear index
      this.clear();
      return null;
    }
    return matrix;
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity (Float32 matrix + top-k selection)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity against a compact row-major Float32 matrix, returning only
 * the top-k highest scores. Optionally restricts scoring to candidateIndices
 * (e.g. after file-pattern filter) without copying vectors.
 *
 * score = (v · q) / (||v|| * ||q||)
 */
function cosineTopK(
  query: number[],
  matrix: SearchMatrix,
  k: number,
  candidateIndices: number[] | null,
  rowLimit: number,
): { score: number; idx: number }[] {
  const dim = matrix.cols;
  const data = matrix.data;
  const take = Math.max(0, Math.min(k, candidateIndices?.length ?? rowLimit));
  if (take === 0) return [];

  // Precompute query as Float32 + norm
  const q = new Float32Array(dim);
  let qNormSq = 0;
  for (let d = 0; d < dim; d++) {
    const v = query[d]!;
    q[d] = v;
    qNormSq += v * v;
  }
  const qNorm = Math.sqrt(qNormSq);
  if (qNorm === 0) return [];

  // Bounded min-heap of size `take` (heap[0] = lowest score among top-k).
  // Avoids sorting all N candidates when N >> k.
  const heap: { score: number; idx: number }[] = [];

  const consider = (idx: number): void => {
    const base = idx * dim;
    let dot = 0;
    let vNormSq = 0;
    for (let d = 0; d < dim; d++) {
      const v = data[base + d]!;
      dot += v * q[d]!;
      vNormSq += v * v;
    }
    const vNorm = Math.sqrt(vNormSq);
    const denom = vNorm * qNorm;
    const score = denom === 0 ? 0 : dot / denom;

    if (heap.length < take) {
      heap.push({ score, idx });
      if (heap.length === take) {
        // Establish min-heap order once full
        heap.sort((a, b) => a.score - b.score);
      }
    } else if (score > heap[0]!.score) {
      heap[0] = { score, idx };
      // Restore min-heap property for small k (typical top_k is 5–20)
      siftDownMin(heap, 0);
    }
  };

  if (candidateIndices) {
    for (const idx of candidateIndices) {
      if (idx >= 0 && idx < rowLimit) consider(idx);
    }
  } else {
    for (let idx = 0; idx < rowLimit; idx++) consider(idx);
  }

  // Highest score first
  heap.sort((a, b) => b.score - a.score);
  return heap;
}

/** Sift down at index i for a min-heap ordered by .score */
function siftDownMin(heap: { score: number; idx: number }[], i: number): void {
  const n = heap.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < n && heap[left]!.score < heap[smallest]!.score) smallest = left;
    if (right < n && heap[right]!.score < heap[smallest]!.score) smallest = right;
    if (smallest === i) break;
    const tmp = heap[i]!;
    heap[i] = heap[smallest]!;
    heap[smallest] = tmp;
    i = smallest;
  }
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Compile a glob pattern to a RegExp. Compile once, reuse for many matches.
 */
function compilePattern(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

function _matchPattern(filePath: string, pattern: string): boolean {
  return compilePattern(pattern).test(filePath);
}
