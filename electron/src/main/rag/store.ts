/**
 * Vector Store — SQLite + Float32Array vectors with cosine similarity search.
 *
 * Ported from Python `src/orchid/rag/store.py`.
 *
 * - better-sqlite3 with WAL mode
 * - Tables: chunks, files, meta
 * - Vectors stored as .npy files (Float32Array)
 * - Cosine similarity: (V @ q) / (||V|| * ||q||)
 * - Process-level search cache
 * - Corruption recovery (auto-rebuild)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import type { Chunk } from './chunker';
import type { RAGStoreStatus } from '../../shared/types/ipc-boundary';

export type { RAGStoreStatus } from '../../shared/types/ipc-boundary';
/** @deprecated Use RAGStoreStatus from shared/types/ipc-boundary */
export type StoreStatus = RAGStoreStatus;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_RAG_DIR = '.orchid/rag';
const RAG_INDEX_DB = 'index.db';
const RAG_VECTORS_FILE = 'vectors.npy';

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
}

interface ChunkRow {
  chunk_id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
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
 * Load a .npy file as a 2D array of number[].
 */
function loadNpy(filePath: string): number[][] | null {
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

    // Read float32 data
    const dataOffset = 10 + headerLen;
    const vectors: number[][] = [];
    for (let i = 0; i < rows; i++) {
      const row: number[] = [];
      for (let j = 0; j < cols; j++) {
        row.push(buffer.readFloatLE(dataOffset + (i * cols + j) * 4));
      }
      vectors.push(row);
    }

    return vectors;
  } catch {
    // Corrupted vectors — caller should clear
    return null;
  }
}

// ---------------------------------------------------------------------------
// SQLite wrapper (lazy import for optional dependency)
// ---------------------------------------------------------------------------

type BetterSqlite3Database = import('better-sqlite3').Database;

function openDatabase(dbPath: string): BetterSqlite3Database {
  try {
    // Dynamic require — better-sqlite3 is an optional native dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (path: string) => BetterSqlite3Database;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    return db;
  } catch {
    throw new Error(
      'better-sqlite3 is not available. Install it with: npm install better-sqlite3',
    );
  }
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

  /** Cached database connection (lazy-opened, reused). */
  private _db: BetterSqlite3Database | null = null;

  /** Process-level search cache: dbPath -> {vectors, chunks} */
  private static _searchCache = new Map<
    string,
    { vectors: number[][]; chunks: ChunkRow[] }
  >();

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.ragDir = path.join(projectPath, PROJECT_RAG_DIR);
    this.dbPath = path.join(this.ragDir, RAG_INDEX_DB);
    this.vectorsFile = path.join(this.ragDir, RAG_VECTORS_FILE);
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
      const db = openDatabase(this.dbPath);
      db.exec(DB_SCHEMA);
      db.close();
    } catch {
      // Corrupted DB — rebuild
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
    if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);
    this._clearVectorsFile();
    const db = openDatabase(this.dbPath);
    db.exec(DB_SCHEMA);
    db.close();
    this._invalidateCache();
  }

  private _getDb(): BetterSqlite3Database {
    if (this._db) return this._db;
    this._ensureDir();
    try {
      this._db = openDatabase(this.dbPath);
      // Quick corruption check
      this._db.prepare('SELECT 1 FROM chunks LIMIT 1').get();
      return this._db;
    } catch {
      if (this._db) {
        try { this._db.close(); } catch { /* ignore */ }
        this._db = null;
      }
      this._rebuildDb();
      this._db = openDatabase(this.dbPath);
      return this._db;
    }
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  private _invalidateCache(): void {
    RAGStore._searchCache.delete(this.dbPath);
  }

  private _clearVectorsFile(): void {
    if (fs.existsSync(this.vectorsFile)) {
      try {
        fs.unlinkSync(this.vectorsFile);
      } catch {
        // ignore
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

    // Write vectors first — if DB commit fails, old vectors stay consistent
    this._saveVectors(embeddings);

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

    this._saveVectors(newVectors);
  }

  // -------------------------------------------------------------------------
  // Batch operations (VectorState-based)
  // -------------------------------------------------------------------------

  /**
   * Load chunk IDs + vectors, building a position index.
   * Used by the batch indexer to avoid repeated reads.
   */
  loadVectorState(): VectorState {
    const chunkIds = this._getOrderedChunkIds();
    const vectors = this._loadVectorsArray();
    if (!vectors || vectors.length !== chunkIds.length) {
      return { chunkIds: [], vectors: [], idToIndex: new Map() };
    }
    const idToIndex = new Map<number, number>();
    for (let i = 0; i < chunkIds.length; i++) {
      idToIndex.set(chunkIds[i]!, i);
    }
    return { chunkIds: [...chunkIds], vectors: [...vectors], idToIndex };
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
   * Single write of the accumulated vectors to vectors.npy.
   */
  flushVectorState(state: VectorState): void {
    this._saveVectors(state.vectors);
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
    const aligned = newIds
      .filter((cid) => idToVec.has(cid))
      .map((cid) => idToVec.get(cid)!);

    if (aligned.length > 0) {
      this._saveVectors(aligned);
    } else {
      this._clearVectorsFile();
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search for chunks similar to the query embedding.
   */
  search(
    queryEmbedding: number[],
    topK?: number,
    filePattern?: string,
  ): SearchResult[] {
    const cfg = getConfig();
    const k = topK ?? cfg.rag.top_k;

    const { vectors, chunks } = this._loadSearchData();
    if (!vectors || !chunks) return [];

    let vecs = vectors;
    let chks = chunks;

    // Handle stale index (vector/chunk count mismatch)
    if (vecs.length !== chks.length) {
      const minLen = Math.min(vecs.length, chks.length);
      vecs = vecs.slice(0, minLen);
      chks = chks.slice(0, minLen);
    }

    if (vecs.length === 0 || queryEmbedding.length === 0) return [];

    // Pre-filter by filePattern before scoring — avoids scoring + sorting
    // vectors that will be discarded. Compile regex once (P1-3).
    if (filePattern) {
      const re = compilePattern(filePattern);
      const filtered: { vec: number[]; chk: ChunkRow }[] = [];
      for (let i = 0; i < chks.length; i++) {
        if (re.test(chks[i]!.file_path)) {
          filtered.push({ vec: vecs[i]!, chk: chks[i]! });
        }
      }
      if (filtered.length === 0) return [];
      vecs = filtered.map((f) => f.vec);
      chks = filtered.map((f) => f.chk);
    }

    // Dimension check
    const dim = vecs[0]!.length;
    if (queryEmbedding.length !== dim) {
      throw new Error(
        `Query embedding dimension (${queryEmbedding.length}) does not match ` +
          `stored vector dimension (${dim}). Re-index with the correct embedding model.`,
      );
    }

    // Compute cosine similarity
    const scores = cosineSimilarity(queryEmbedding, vecs);

    // Sort by score descending
    const indexed = scores
      .map((score, idx) => ({ score, idx }))
      .sort((a, b) => b.score - a.score);

    const results: SearchResult[] = [];
    for (const { score, idx } of indexed) {
      if (results.length >= k) break;
      const chunk = chks[idx]!;
      results.push({
        filePath: chunk.file_path,
        content: chunk.content,
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

  status(): StoreStatus {
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
    if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath);
    this._clearVectorsFile();
    this._invalidateCache();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _saveVectors(embeddings: number[][]): void {
    this._ensureDir();
    if (embeddings.length === 0) {
      this._clearVectorsFile();
      this._invalidateCache();
      return;
    }

    saveNpy(this.vectorsFile, embeddings);
    this._invalidateCache();
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

  private _getAllChunks(): ChunkRow[] {
    const db = this._getDb();
    return db
      .prepare(
        'SELECT chunk_id, file_path, start_line, end_line, content FROM chunks ORDER BY chunk_id',
      )
      .all() as ChunkRow[];
  }

  private _loadSearchData(): {
    vectors: number[][] | null;
    chunks: ChunkRow[] | null;
  } {
    const cacheKey = this.dbPath;
    const cached = RAGStore._searchCache.get(cacheKey);
    if (cached) return cached;

    const vectors = this._loadVectorsArray();
    if (!vectors) return { vectors: null, chunks: null };

    const chunks = this._getAllChunks();
    if (chunks.length === 0) return { vectors: null, chunks: null };

    RAGStore._searchCache.set(cacheKey, { vectors, chunks });
    return { vectors, chunks };
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between a query vector and a matrix of vectors.
 *
 * score = (V @ q) / (||V|| * ||q||)
 */
function cosineSimilarity(query: number[], vectors: number[][]): number[] {
  const dim = query.length;
  const scores: number[] = [];

  // Precompute query norm
  let qNorm = 0;
  for (let d = 0; d < dim; d++) {
    qNorm += query[d]! * query[d]!;
  }
  qNorm = Math.sqrt(qNorm);

  if (qNorm === 0) return vectors.map(() => 0);

  for (const vec of vectors) {
    let dot = 0;
    let vNorm = 0;
    for (let d = 0; d < dim; d++) {
      dot += vec[d]! * query[d]!;
      vNorm += vec[d]! * vec[d]!;
    }
    vNorm = Math.sqrt(vNorm);
    const denom = vNorm * qNorm;
    scores.push(denom === 0 ? 0 : dot / denom);
  }

  return scores;
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
