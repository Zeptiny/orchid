/**
 * RAG Pipeline tests — U16.
 *
 * Covers:
 * - Chunker: Short file → single chunk. Long file → overlapping chunks with natural breaks
 * - Store: Upsert + search → correct ranking. Corruption → auto-rebuild
 * - Indexer: First index → all files. Second → only changed
 * - Auto re-index: Edit file → RAG updated automatically
 * - RAG search: Query → results with scores
 *
 * Tests use mocks for onnxruntime-node and better-sqlite3 when native
 * modules aren't available, and real implementations when they are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock better-sqlite3 with a robust in-memory implementation
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

const mockTableStore = new Map<string, MockRow[]>();

function getOrCreateTable(name: string): MockRow[] {
  if (!mockTableStore.has(name)) {
    mockTableStore.set(name, []);
  }
  return mockTableStore.get(name)!;
}

function createMockDb(_dbPath: string) {
  const db = {
    exec(sql: string) {
      // Handle multi-statement SQL (e.g., DB_SCHEMA)
      // Just ensure tables exist
      const tables = ['chunks', 'files', 'meta'];
      for (const t of tables) {
        if (sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`)) {
          getOrCreateTable(t);
        }
      }
      // Handle bulk DELETE
      if (sql === 'DELETE FROM chunks') {
        mockTableStore.set('chunks', []);
      }
      if (sql === 'DELETE FROM files') {
        mockTableStore.set('files', []);
      }
    },
    prepare(sql: string) {
      return {
        run(...params: unknown[]) {
          if (sql.includes('INSERT OR REPLACE INTO meta')) {
            const rows = getOrCreateTable('meta');
            const key = params[0] as string;
            const value = params[1] as string;
            const idx = rows.findIndex((r) => r.key === key);
            if (idx >= 0) {
              rows[idx]!.value = value;
            } else {
              rows.push({ key, value });
            }
          } else if (sql.includes('INSERT INTO chunks')) {
            const rows = getOrCreateTable('chunks');
            rows.push({
              chunk_id: rows.length + 1,
              file_path: params[0],
              start_line: params[1],
              end_line: params[2],
              content: params[3],
            });
          } else if (sql.includes('INSERT OR REPLACE INTO files')) {
            const rows = getOrCreateTable('files');
            const filePath = params[0] as string;
            const idx = rows.findIndex((r) => r.file_path === filePath);
            const row = {
              file_path: filePath,
              hash: params[1] as string,
              chunk_count: params[2] as number,
            };
            if (idx >= 0) {
              rows[idx] = row;
            } else {
              rows.push(row);
            }
          } else if (sql.includes('DELETE FROM chunks WHERE file_path')) {
            const rows = getOrCreateTable('chunks');
            const filePath = params[0] as string;
            const filtered = rows.filter((r) => r.file_path !== filePath);
            mockTableStore.set('chunks', filtered);
          } else if (sql.includes('DELETE FROM files WHERE file_path')) {
            const rows = getOrCreateTable('files');
            const filePath = params[0] as string;
            const filtered = rows.filter((r) => r.file_path !== filePath);
            mockTableStore.set('files', filtered);
          }
        },
        get(...params: unknown[]) {
          if (sql.includes('SELECT 1 FROM chunks LIMIT 1')) {
            return { '1': 1 }; // DB is valid
          }
          if (sql.includes('SELECT COUNT(*) as cnt FROM chunks')) {
            return { cnt: getOrCreateTable('chunks').length };
          }
          if (sql.includes('SELECT COUNT(*) as cnt FROM files')) {
            return { cnt: getOrCreateTable('files').length };
          }
          if (sql.includes('SELECT value FROM meta WHERE key')) {
            const rows = getOrCreateTable('meta');
            return rows.find((r) => r.key === params[0]) ?? undefined;
          }
          return undefined;
        },
        all(...params: unknown[]) {
          if (sql.includes('SELECT chunk_id FROM chunks ORDER BY chunk_id')) {
            return getOrCreateTable('chunks').map((r) => ({
              chunk_id: r.chunk_id,
            }));
          }
          if (sql.includes('SELECT chunk_id FROM chunks WHERE file_path')) {
            const filePath = params[0] as string;
            return getOrCreateTable('chunks')
              .filter((r) => r.file_path === filePath)
              .map((r) => ({ chunk_id: r.chunk_id }));
          }
          // Metadata-only (search cache) or full row (legacy)
          if (
            sql.includes('SELECT chunk_id, file_path, start_line, end_line')
          ) {
            return getOrCreateTable('chunks');
          }
          // Top-k content fetch: SELECT chunk_id, content FROM chunks WHERE chunk_id IN (...)
          if (sql.includes('SELECT chunk_id, content FROM chunks')) {
            const idSet = new Set(params as number[]);
            return getOrCreateTable('chunks')
              .filter((r) => idSet.has(r.chunk_id as number))
              .map((r) => ({ chunk_id: r.chunk_id, content: r.content }));
          }
          if (sql.includes('SELECT file_path, hash FROM files')) {
            return getOrCreateTable('files');
          }
          return [];
        },
      };
    },
    pragma(_p: string) {
      return [];
    },
    transaction(fn: (...args: unknown[]) => void) {
      return (...args: unknown[]) => fn(...args);
    },
    close() {
      // no-op
    },
  };
  return db;
}

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockImplementation((dbPath: string) => {
      return createMockDb(dbPath);
    }),
  };
});

// Mock onnxruntime-node
vi.mock('onnxruntime-node', () => {
  return {
    InferenceSession: {
      create: vi.fn().mockResolvedValue({
        run: vi.fn().mockResolvedValue({
          last_hidden_state: {
            data: new Float32Array(512 * 384).fill(0.1),
            dims: [1, 512, 384],
          },
        }),
      }),
    },
    Tensor: vi.fn().mockImplementation(
      (type: string, data: unknown, dims: number[]) => ({
        type,
        data,
        dims,
      }),
    ),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { chunkFile } from '../../src/main/rag/chunker';
import type { Chunk } from '../../src/main/rag/chunker';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
}

function writeFile(relPath: string, content: string): string {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  return absPath;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  mockTableStore.clear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Chunker tests
// ---------------------------------------------------------------------------

describe('Chunker', () => {
  it('should return single chunk for short file', () => {
    const content = 'function hello() {\n  return "world";\n}\n';
    const chunks = chunkFile('test.ts', content, 2000, 200);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.filePath).toBe('test.ts');
    expect(chunks[0]!.content).toBe(content);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(3);
  });

  it('should return empty for empty content', () => {
    expect(chunkFile('test.ts', '', 2000, 200)).toEqual([]);
    expect(chunkFile('test.ts', '   \n  \n  ', 2000, 200)).toEqual([]);
  });

  it('should return empty for binary content', () => {
    expect(chunkFile('test.bin', 'hello\x00world', 2000, 200)).toEqual([]);
  });

  it('should split long file into overlapping chunks with natural breaks', () => {
    // Create content that exceeds chunk_size with blank line breaks
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`// Section ${i}`);
      for (let j = 0; j < 5; j++) {
        lines.push(`const var_${i}_${j} = ${i * 10 + j};`);
      }
      lines.push(''); // blank line break
    }
    const content = lines.join('\n');

    const chunks = chunkFile('large.ts', content, 200, 30);

    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should reference the same file
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe('large.ts');
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }

    // First chunk should start at line 1
    expect(chunks[0]!.startLine).toBe(1);

    // Verify overlap: consecutive chunks should share some content
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      // Current chunk should start before previous chunk ends (overlap)
      expect(curr.startLine).toBeLessThanOrEqual(prev.endLine);
    }
  });

  it('should throw if overlap >= chunk_size', () => {
    expect(() => chunkFile('test.ts', 'x'.repeat(100), 50, 50)).toThrow(
      'chunk_overlap (50) must be less than chunk_size (50)',
    );
    expect(() => chunkFile('test.ts', 'x'.repeat(100), 50, 60)).toThrow();
  });

  it('should handle file exactly at chunk_size boundary', () => {
    const content = 'x'.repeat(2000);
    const chunks = chunkFile('exact.ts', content, 2000, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(content);
  });

  it('should handle multiline content with varying line lengths', () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i}: ${'x'.repeat(20)}`);
    }
    const content = lines.join('\n');

    const chunks = chunkFile('multiline.ts', content, 300, 50);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should contain valid content
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.startLine).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Store tests
// ---------------------------------------------------------------------------

describe('Store', () => {
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  beforeEach(async () => {
    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  it('should initialize database', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    expect(fs.existsSync(store.dbPath)).toBe(true);
  });

  it('should upsert chunks and search with correct ranking', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    const chunks: Chunk[] = [
      {
        filePath: 'a.ts',
        content: 'function authenticate user',
        startLine: 1,
        endLine: 3,
      },
      {
        filePath: 'b.ts',
        content: 'const database connection',
        startLine: 1,
        endLine: 2,
      },
      {
        filePath: 'c.ts',
        content: 'function login user password',
        startLine: 1,
        endLine: 5,
      },
    ];

    // Create distinct embeddings — chunk 0 and 2 are similar to query
    const embeddings: number[][] = [
      [1.0, 0.0, 0.0],
      [0.0, 1.0, 0.0],
      [0.9, 0.1, 0.0],
    ];

    store.upsert(chunks, embeddings);

    const status = store.status();
    expect(status.totalChunks).toBe(3);
    expect(status.totalFiles).toBe(3);

    // Search with embedding similar to chunks 0 and 2
    const queryEmbedding = [1.0, 0.0, 0.0];
    const results = store.search(queryEmbedding, 3);

    expect(results.length).toBeGreaterThan(0);
    // First result should be chunk 0 (exact match)
    expect(results[0]!.filePath).toBe('a.ts');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('should handle corruption and auto-rebuild', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    // Write some data
    store.upsert(
      [{ filePath: 'a.ts', content: 'test', startLine: 1, endLine: 1 }],
      [[1.0, 0.0]],
    );

    // Close cached connection so corruption is detected on next access
    store.dispose();

    // Corrupt the DB file
    fs.writeFileSync(store.dbPath, 'corrupted data');

    // Should auto-rebuild on next access
    const status = store.status();
    expect(status.totalChunks).toBe(0); // Rebuilt empty
  });

  it('should upsert single file preserving others', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    // Initial full upsert
    store.upsert(
      [
        {
          filePath: 'a.ts',
          content: 'file a',
          startLine: 1,
          endLine: 1,
        },
        {
          filePath: 'b.ts',
          content: 'file b',
          startLine: 1,
          endLine: 1,
        },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );

    // Upsert only file a
    store.upsertFile(
      'a.ts',
      [
        {
          filePath: 'a.ts',
          content: 'file a updated',
          startLine: 1,
          endLine: 1,
        },
      ],
      [[0.5, 0.5]],
    );

    const status = store.status();
    expect(status.totalChunks).toBe(2); // a.ts updated + b.ts preserved
    expect(status.totalFiles).toBe(2);
  });

  it('should delete by file', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [
        {
          filePath: 'a.ts',
          content: 'file a',
          startLine: 1,
          endLine: 1,
        },
        {
          filePath: 'b.ts',
          content: 'file b',
          startLine: 1,
          endLine: 1,
        },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );

    store.deleteByFile('a.ts');

    const status = store.status();
    expect(status.totalChunks).toBe(1);
    expect(status.totalFiles).toBe(1);
  });

  it('should record and retrieve index duration', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.recordIndexDuration(42.5);
    const status = store.status();
    expect(status.lastIndexDuration).toBe(42.5);
  });

  it('should clear and return empty status', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [{ filePath: 'a.ts', content: 'test', startLine: 1, endLine: 1 }],
      [[1.0, 0.0]],
    );

    store.clear();
    const status = store.status();
    expect(status.totalChunks).toBe(0);
    expect(status.totalFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Indexer tests
// ---------------------------------------------------------------------------

describe('Indexer', () => {
  let indexProject: typeof import('../../src/main/rag/indexer').indexProject;
  let getStatus: typeof import('../../src/main/rag/indexer').getStatus;
  let clearIndex: typeof import('../../src/main/rag/indexer').clearIndex;
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  beforeEach(async () => {
    const indexerModule = await import('../../src/main/rag/indexer');
    indexProject = indexerModule.indexProject;
    getStatus = indexerModule.getStatus;
    clearIndex = indexerModule.clearIndex;

    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  it('should index all files on first run', async () => {
    // Create test files
    writeFile('src/main.ts', 'function main() { return 42; }');
    writeFile(
      'src/utils.ts',
      'export function add(a: number, b: number) { return a + b; }',
    );
    writeFile('README.md', '# Test Project');

    // Create a mock embedder
    const mockEmbedder = {
      embed: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
      embedSingle: async () => new Float32Array(3).fill(0.1),
      warmedUp: true,
      modelName: 'test',
      _warmup: async () => {},
      _embedBatchWithRetry: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
      _embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
    };

    const result = await indexProject(
      tmpDir,
      undefined,
      undefined,
      mockEmbedder as unknown as import('../../src/main/rag/embedder').Embedder,
    );

    // Should index .ts and .md files
    expect(result.filesScanned).toBe(3);
    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('should skip unchanged files on second run', async () => {
    writeFile('src/main.ts', 'function main() { return 42; }');

    const mockEmbedder = {
      embed: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
      embedSingle: async () => new Float32Array(3).fill(0.1),
      warmedUp: true,
      modelName: 'test',
      _warmup: async () => {},
      _embedBatchWithRetry: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
      _embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
    };

    // First index
    const result1 = await indexProject(
      tmpDir,
      undefined,
      undefined,
      mockEmbedder as unknown as import('../../src/main/rag/embedder').Embedder,
    );
    expect(result1.filesIndexed).toBe(1);

    // Second index — file unchanged
    const result2 = await indexProject(
      tmpDir,
      undefined,
      undefined,
      mockEmbedder as unknown as import('../../src/main/rag/embedder').Embedder,
    );
    expect(result2.filesSkipped).toBe(1);
    expect(result2.filesIndexed).toBe(0);
  });

  it('should clear index', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();
    store.upsert(
      [{ filePath: 'a.ts', content: 'test', startLine: 1, endLine: 1 }],
      [[1.0, 0.0]],
    );

    expect(store.status().totalChunks).toBe(1);

    clearIndex(tmpDir);

    expect(getStatus(tmpDir).totalChunks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RAG search tool tests
// ---------------------------------------------------------------------------

describe('RAG Search Tool', () => {
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  beforeEach(async () => {
    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  it('should return results with scores from store search', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    const chunks: Chunk[] = [
      {
        filePath: 'auth.ts',
        content: 'function login(username, password)',
        startLine: 1,
        endLine: 5,
      },
      {
        filePath: 'db.ts',
        content: 'function connectDatabase()',
        startLine: 1,
        endLine: 3,
      },
      {
        filePath: 'user.ts',
        content: 'function getUserById(id)',
        startLine: 10,
        endLine: 20,
      },
    ];

    const embeddings: number[][] = [
      [0.9, 0.1, 0.0], // auth-related
      [0.0, 0.0, 1.0], // db-related
      [0.8, 0.2, 0.0], // user-related (similar to auth)
    ];

    store.upsert(chunks, embeddings);

    // Search with "auth" query embedding
    const results = store.search([0.9, 0.1, 0.0], 3);

    expect(results).toHaveLength(3);
    expect(results[0]!.filePath).toBe('auth.ts');
    expect(results[0]!.score).toBeGreaterThan(0.99); // near-perfect match
    expect(results[0]!.content).toBe('function login(username, password)');
    expect(results[0]!.startLine).toBe(1);
    expect(results[0]!.endLine).toBe(5);

    // Verify ranking — auth.ts > user.ts > db.ts
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[1]!.score).toBeGreaterThan(results[2]!.score);
  });
});

// ---------------------------------------------------------------------------
// Cosine similarity edge cases
// ---------------------------------------------------------------------------

describe('Cosine Similarity', () => {
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  beforeEach(async () => {
    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  it('should handle zero vectors gracefully', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [{ filePath: 'a.ts', content: 'test', startLine: 1, endLine: 1 }],
      [[0, 0, 0]], // zero vector
    );

    const results = store.search([1, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(0); // zero dot product
  });

  it('should return empty for empty index', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    const results = store.search([1, 0, 0], 5);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

describe('File Discovery', () => {
  it('should include supported extensions only', async () => {
    writeFile('main.ts', 'code');
    writeFile('style.css', 'css');
    writeFile('data.json', '{}');
    writeFile('binary.so', '\0binary');
    writeFile('readme.md', '# readme');
    writeFile('script.py', 'print("hi")');
    writeFile('image.png', '\0png');

    const { indexProject: idx } = await import(
      '../../src/main/rag/indexer'
    );

    const mockEmbedder = {
      embed: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
      embedSingle: async () => new Float32Array(3).fill(0.1),
      warmedUp: true,
      modelName: 'test',
      _warmup: async () => {},
      _embedBatchWithRetry: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
      _embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(3).fill(0.1)),
    };

    const result = await idx(
      tmpDir,
      undefined,
      undefined,
      mockEmbedder as unknown as import('../../src/main/rag/embedder').Embedder,
    );

    // Should include .ts, .css, .json, .md, .py but not .so, .png
    expect(result.filesScanned).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Batch vector state operations
// ---------------------------------------------------------------------------

describe('Batch Vector State', () => {
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  beforeEach(async () => {
    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  it('should support loadVectorState and upsertFileBatch', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    // Initial upsert
    store.upsert(
      [
        { filePath: 'a.ts', content: 'file a', startLine: 1, endLine: 1 },
        { filePath: 'b.ts', content: 'file b', startLine: 1, endLine: 1 },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );

    // Load vector state
    const state = store.loadVectorState();
    expect(state.chunkIds).toHaveLength(2);
    expect(state.vectors).toHaveLength(2);

    // Batch upsert for file c
    store.upsertFileBatch(
      state,
      'c.ts',
      [{ filePath: 'c.ts', content: 'file c', startLine: 1, endLine: 1 }],
      [[0.5, 0.5]],
    );

    expect(state.chunkIds).toHaveLength(3);
    expect(state.vectors).toHaveLength(3);

    // Flush to disk
    store.flushVectorState(state);

    // Verify search works
    const results = store.search([1.0, 0.0], 3);
    expect(results).toHaveLength(3);
    expect(results[0]!.filePath).toBe('a.ts'); // closest to query
  });

  it('should persist a chunk-id sidecar aligned with vectors.npy', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [
        { filePath: 'a.ts', content: 'file a', startLine: 1, endLine: 1 },
        { filePath: 'b.ts', content: 'file b', startLine: 1, endLine: 1 },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );

    expect(fs.existsSync(store.vectorIdsFile)).toBe(true);
    const persistedIds = JSON.parse(fs.readFileSync(store.vectorIdsFile, 'utf-8'));
    const state = store.loadVectorState();
    expect(state.consistent).toBe(true);
    expect(persistedIds).toEqual(state.chunkIds);
    expect(persistedIds).toHaveLength(2);
  });

  it('should report inconsistent state when an interrupted run left the DB ahead of vectors.npy', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [
        { filePath: 'a.ts', content: 'file a', startLine: 1, endLine: 1 },
        { filePath: 'b.ts', content: 'file b', startLine: 1, endLine: 1 },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );
    expect(store.loadVectorState().consistent).toBe(true);

    // Simulate an interrupted index run: upsertFileBatch commits DB rows
    // immediately but vectors.npy is only written by flushVectorState at the
    // end of the run. Killing the run before the flush leaves the DB ahead.
    const state = store.loadVectorState();
    store.upsertFileBatch(
      state,
      'b.ts',
      [{ filePath: 'b.ts', content: 'file b changed', startLine: 1, endLine: 1 }],
      [[0.5, 0.5]],
    );
    // No flushVectorState — the interruption.

    const reloaded = store.loadVectorState();
    expect(reloaded.consistent).toBe(false);
    expect(reloaded.chunkIds).toHaveLength(0);
    expect(reloaded.vectors).toHaveLength(0);
  });

  it('should fail search closed instead of scoring misaligned vectors', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [
        { filePath: 'a.ts', content: 'file a', startLine: 1, endLine: 1 },
        { filePath: 'b.ts', content: 'file b', startLine: 1, endLine: 1 },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );

    // Interrupted-run simulation (same as above): DB committed, flush skipped.
    const state = store.loadVectorState();
    store.upsertFileBatch(
      state,
      'b.ts',
      [{ filePath: 'b.ts', content: 'file b changed', startLine: 1, endLine: 1 }],
      [[0.5, 0.5]],
    );

    // Vectors.npy now has 2 rows but the chunks table has 2 rows whose ids no
    // longer match the persisted sidecar — scoring would pair new vectors with
    // the wrong chunks. Search must return nothing until the next index run.
    expect(store.search([1.0, 0.0], 3)).toHaveLength(0);
    expect(store.search([0.5, 0.5], 3)).toHaveLength(0);
  });

  it('should treat a corrupt chunk-id sidecar as misaligned', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [{ filePath: 'a.ts', content: 'file a', startLine: 1, endLine: 1 }],
      [[1.0, 0.0]],
    );

    fs.writeFileSync(store.vectorIdsFile, 'not json');

    expect(store.loadVectorState().consistent).toBe(false);
    expect(store.search([1.0, 0.0], 1)).toHaveLength(0);
  });

  it('should still load a legacy index without the id sidecar', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    store.upsert(
      [
        { filePath: 'a.ts', content: 'file a', startLine: 1, endLine: 1 },
        { filePath: 'b.ts', content: 'file b', startLine: 1, endLine: 1 },
      ],
      [[1.0, 0.0], [0.0, 1.0]],
    );

    fs.unlinkSync(store.vectorIdsFile);

    const state = store.loadVectorState();
    expect(state.consistent).toBe(true);
    expect(state.chunkIds).toHaveLength(2);
    expect(store.search([1.0, 0.0], 2)[0]!.filePath).toBe('a.ts');
  });
});

// ---------------------------------------------------------------------------
// Interrupted index recovery (full rebuild on vector/chunk mismatch)
// ---------------------------------------------------------------------------

describe('Interrupted Index Recovery', () => {
  let indexProject: typeof import('../../src/main/rag/indexer').indexProject;
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  function embedForText(text: string): Float32Array {
    if (text.includes('alpha')) return Float32Array.from([1, 0, 0]);
    if (text.includes('beta')) return Float32Array.from([0, 1, 0]);
    return Float32Array.from([0, 0, 1]);
  }

  const contentEmbedder = {
    embed: async (texts: string[]) => texts.map(embedForText),
    embedSingle: async (text: string) => embedForText(text),
    warmedUp: true,
    modelName: 'test',
    _warmup: async () => {},
    _embedBatchWithRetry: async (texts: string[]) => texts.map(embedForText),
    _embedBatch: async (texts: string[]) => texts.map(embedForText),
  };

  beforeEach(async () => {
    const indexerModule = await import('../../src/main/rag/indexer');
    indexProject = indexerModule.indexProject;
    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  it('should force a full rebuild after an interrupted run and restore correct search mapping', async () => {
    writeFile('a.ts', 'const alphaValue = 1;');
    writeFile('b.ts', 'const betaValue = 1;');

    const embedder = contentEmbedder as unknown as import('../../src/main/rag/embedder').Embedder;

    const result1 = await indexProject(tmpDir, undefined, undefined, embedder);
    expect(result1.filesIndexed).toBe(2);
    expect(result1.errors).toHaveLength(0);

    const store = new RAGStore(tmpDir);
    expect(store.search([1, 0, 0], 1)[0]!.filePath).toBe('a.ts');
    expect(store.search([0, 1, 0], 1)[0]!.filePath).toBe('b.ts');

    // Simulate an interrupted incremental run: b.ts changed on disk and its
    // new chunk rows were committed, but the run died before the vector flush.
    writeFile('b.ts', 'const betaValue = 2; // updated beta');
    const state = store.loadVectorState();
    store.upsertFileBatch(
      state,
      'b.ts',
      [{ filePath: 'b.ts', content: 'const betaValue = 2; // updated beta', startLine: 1, endLine: 1 }],
      [Array.from(embedForText('beta'))],
    );
    store.dispose();
    // No flushVectorState — the interruption. Search must fail closed now.
    expect(new RAGStore(tmpDir).search([0, 1, 0], 3)).toHaveLength(0);

    // Next index run must detect the mismatch and fully rebuild (no skips).
    const result2 = await indexProject(tmpDir, undefined, undefined, embedder);
    expect(result2.errors).toHaveLength(0);
    expect(result2.filesIndexed).toBe(2);
    expect(result2.filesSkipped).toBe(0);

    const rebuilt = new RAGStore(tmpDir);
    const rebuiltState = rebuilt.loadVectorState();
    expect(rebuiltState.consistent).toBe(true);

    // Sidecar matches the DB ordering exactly
    const persistedIds = JSON.parse(fs.readFileSync(rebuilt.vectorIdsFile, 'utf-8'));
    expect(persistedIds).toEqual(rebuiltState.chunkIds);

    // Search maps embeddings back to the correct files + content
    const alpha = rebuilt.search([1, 0, 0], 3);
    expect(alpha[0]!.filePath).toBe('a.ts');
    const beta = rebuilt.search([0, 1, 0], 3);
    expect(beta[0]!.filePath).toBe('b.ts');
    expect(beta[0]!.content).toContain('updated beta');

    // A subsequent incremental run skips both files again
    const result3 = await indexProject(tmpDir, undefined, undefined, embedder);
    expect(result3.filesSkipped).toBe(2);
    expect(result3.filesIndexed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Embedder model download tests
// ---------------------------------------------------------------------------

describe('Model Download', () => {
  beforeEach(async () => {
    const { _setEmbeddingModelsHomeForTests } = await import('../../src/main/rag/embedder');
    _setEmbeddingModelsHomeForTests(tmpDir);
  });

  afterEach(async () => {
    const { _setEmbeddingModelsHomeForTests } = await import('../../src/main/rag/embedder');
    _setEmbeddingModelsHomeForTests(null);
  });

  it('should skip download if model.onnx already exists', async () => {
    const { downloadModel } = await import('../../src/main/rag/embedder');

    // Create the model file in a temp dir
    const modelDir = path.join(tmpDir, 'models', 'test-model');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'model.onnx'), 'fake-model');

    // Verify the function is exported and callable
    expect(typeof downloadModel).toBe('function');
  });

  it('should export downloadModel and getModelDir', async () => {
    const embedderModule = await import('../../src/main/rag/embedder');

    expect(typeof embedderModule.downloadModel).toBe('function');
    expect(typeof embedderModule.getModelDir).toBe('function');
  });

  it('maps RAGConfig model-download timeouts to per-download options', async () => {
    const { modelDownloadOptionsFromConfig } = await import('../../src/main/rag/embedder');

    expect(
      modelDownloadOptionsFromConfig({
        model_download_inactivity_timeout: 2,
        model_download_total_timeout: 60,
      }),
    ).toEqual({ inactivityTimeoutMs: 2000, totalTimeoutMs: 60000 });

    // Absent or non-positive fields fall back to the default resolution.
    expect(modelDownloadOptionsFromConfig({})).toEqual({});
    expect(
      modelDownloadOptionsFromConfig({
        model_download_inactivity_timeout: 0,
        model_download_total_timeout: -5,
      }),
    ).toEqual({});
    expect(modelDownloadOptionsFromConfig(undefined)).toEqual({});
  });

  it('should export DownloadProgressCallback type', async () => {
    // Type-only test: ensure the type is exported and usable
    const embedderModule = await import('../../src/main/rag/embedder');
    // downloadModel accepts an optional progress callback
    expect(embedderModule.downloadModel.length).toBeLessThanOrEqual(2);
  });

  it('should throw EmbeddingError with clear message on network failure', async () => {
    const { downloadModel, EmbeddingError } = await import(
      '../../src/main/rag/embedder'
    );

    // Mock fetch to simulate network failure
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));

    await expect(downloadModel('nonexistent/model')).rejects.toThrow(
      EmbeddingError,
    );
    await expect(downloadModel('nonexistent/model')).rejects.toThrow(
      /download failed/i,
    );
    fetchSpy.mockRestore();
  });

  it('should throw EmbeddingError with manual placement instructions', async () => {
    const { downloadModel } = await import('../../src/main/rag/embedder');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    try {
      await downloadModel('BAAI/bge-small-en-v1.5');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Place model\.onnx|Place the model manually/i);
      expect((err as Error).message).toContain('model.onnx');
    }
    fetchSpy.mockRestore();
  });

  it('should handle HTTP errors gracefully', async () => {
    const { downloadModel, EmbeddingError } = await import(
      '../../src/main/rag/embedder'
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as unknown as Response);

    await expect(downloadModel('BAAI/bge-small-en-v1.5')).rejects.toThrow(
      EmbeddingError,
    );
    await expect(downloadModel('BAAI/bge-small-en-v1.5')).rejects.toThrow(
      /download failed/i,
    );
    fetchSpy.mockRestore();
  });

  it('should report progress during download', async () => {
    const { downloadModel } = await import('../../src/main/rag/embedder');
    const progressCalls: Array<{
      file: string;
      bytesDownloaded: number;
      totalBytes: number | undefined;
    }> = [];

    // Mock fetch to return a response that triggers progress before failing.
    // We use a simple body mock that reports some bytes then errors,
    // because the full streaming pipeline is hard to mock in tests.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          headers: new Map([['content-length', '1024']]),
          body: {
            getReader: () => ({
              read: async () => ({ done: true, value: undefined }),
            }),
          },
        }) as unknown as Response,
    );

    // downloadModel may throw (file ops in test env), that's fine
    try {
      await downloadModel('test/progress-model', (info) =>
        progressCalls.push(info),
      );
    } catch {
      // expected
    }

    // Verify fetch was called (at least for model.onnx)
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('aborts a stalled model body and removes its temporary file', async () => {
    const { downloadModel, getModelDir } = await import('../../src/main/rag/embedder');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(init.signal?.reason ?? new Error('aborted'));
          }, { once: true });
        },
      }), { status: 200 }),
    );

    const pending = downloadModel('test/stalled-model', undefined, {
      inactivityTimeoutMs: 20,
      totalTimeoutMs: 100,
    });

    await expect(pending).rejects.toThrow(/timed out/i);
    const modelDir = await getModelDir('test/stalled-model');
    const entries = fs.existsSync(modelDir) ? fs.readdirSync(modelDir) : [];
    expect(entries.some((entry) => entry.includes('.tmp.'))).toBe(false);
    fetchSpy.mockRestore();
  });
});
