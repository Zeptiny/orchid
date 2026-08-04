/**
 * Indexing concurrency guards tests — U8.
 *
 * Covers:
 * - RAG indexer: _indexing flag lifecycle, isIndexing() export, concurrent call rejection
 * - AST indexer: _indexing flag lifecycle, isIndexing() export, concurrent call rejection
 * - Flag resets after success and completion
 * - RAG and AST flags are independent (separate modules)
 *
 * Mocks store, embedder, and parser modules so only the guard logic is exercised.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mock classes — must be in vi.hoisted() since vi.mock is hoisted
// ---------------------------------------------------------------------------

const { MockRAGStore, MockEmbedder, MockASTStore } = vi.hoisted(() => {
  class MockRAGStore {
    static lastInstance: MockRAGStore | undefined;

    constructor() {
      MockRAGStore.lastInstance = this;
    }

    initDb = vi.fn();
    getFileHashes = vi.fn().mockReturnValue(new Map());
    loadVectorState = vi.fn().mockReturnValue({
      chunkIds: [],
      vectors: [],
      idToIndex: new Map(),
      consistent: true,
    });
    upsertFileBatch = vi.fn();
    deleteByFileBatch = vi.fn();
    flushVectorState = vi.fn();
    updateFileHashesBatch = vi.fn();
    touchLastIndexed = vi.fn();
    recordIndexDuration = vi.fn();
    status = vi.fn().mockReturnValue({
      totalChunks: 0,
      totalFiles: 0,
      lastIndexed: null,
      indexDuration: 0,
      dbSize: 0,
      vectorsSize: 0,
    });
    clear = vi.fn();
    deleteByFile = vi.fn();
    updateFileHash = vi.fn();
    dispose = vi.fn();
  }

  class MockEmbedder {
    embed = vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]);
  }

  class MockASTStore {
    static lastInstance: MockASTStore | undefined;

    constructor() {
      MockASTStore.lastInstance = this;
    }

    initDb = vi.fn();
    getAllFileHashes = vi.fn().mockReturnValue({});
    upsertFile = vi.fn();
    deleteByFile = vi.fn();
    recordIndex = vi.fn();
    status = vi.fn().mockReturnValue({
      totalSymbols: 0,
      totalFiles: 0,
      lastIndexed: null,
      indexDuration: 0,
      dbSize: 0,
    });
    dispose = vi.fn();
  }

  return { MockRAGStore, MockEmbedder, MockASTStore };
});

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

const mockConfig = {
  rag: {
    embedding_model: 'test-model',
    chunk_size: 500,
    chunk_overlap: 50,
    max_file_size: 1_000_000,
    embedding_threads: 2,
    embedding_batch_size: 16,
  },
  ast_max_file_size: 1_000_000,
  ignored_dirs: [] as string[],
};

vi.mock('../../src/main/config/loader', () => ({
  getConfig: () => mockConfig,
}));

vi.mock('../../src/main/config', () => ({
  getConfig: () => mockConfig,
}));

// ---------------------------------------------------------------------------
// Mock RAG store — avoids better-sqlite3 native dependency
// ---------------------------------------------------------------------------

vi.mock('../../src/main/rag/store', () => ({
  RAGStore: MockRAGStore,
}));

// ---------------------------------------------------------------------------
// Mock RAG embedder — avoids onnxruntime-node native dependency
// ---------------------------------------------------------------------------

vi.mock('../../src/main/rag/embedder', () => ({
  Embedder: MockEmbedder,
  createEmbedderFromConfig: async () => new MockEmbedder(),
}));

// ---------------------------------------------------------------------------
// Mock AST store — avoids better-sqlite3 native dependency
// ---------------------------------------------------------------------------

vi.mock('../../src/main/ast/store', () => ({
  ASTStore: MockASTStore,
}));

// ---------------------------------------------------------------------------
// Mock AST parser — avoids tree-sitter native dependency
// ---------------------------------------------------------------------------

vi.mock('../../src/main/ast/parser', () => ({
  langForExtension: vi.fn().mockReturnValue('typescript'),
  loadQueryFile: vi.fn().mockResolvedValue(''),
  parseFile: vi.fn().mockResolvedValue({
    delete: vi.fn(),
  }),
  runQuery: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  cancelIndex as cancelRagIndex,
  indexProject as ragIndexProject,
  isIndexing as ragIsIndexing,
} from '../../src/main/rag/indexer';

import {
  indexProject as astIndexProject,
  isIndexing as astIsIndexing,
  resetSession as astResetSession,
} from '../../src/main/ast/indexer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'indexing-guards-'));
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// RAG Indexer Guard Tests
// ---------------------------------------------------------------------------

describe('RAG indexing concurrency guard', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isIndexing() returns false initially', () => {
    expect(ragIsIndexing()).toBe(false);
  });

  it('first indexing call proceeds normally', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    expect(ragIsIndexing()).toBe(false);
    const result = await ragIndexProject(tmpDir);
    expect(result).toBeDefined();
    expect(result.filesScanned).toBeGreaterThanOrEqual(0);
    expect(MockRAGStore.lastInstance?.dispose).toHaveBeenCalledTimes(1);
    expect(ragIsIndexing()).toBe(false);
  });

  it('isIndexing() returns true during indexProject execution', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    let isIndexingDuringExecution = false;
    const promise = ragIndexProject(tmpDir, undefined, undefined, undefined, () => {
      isIndexingDuringExecution = ragIsIndexing();
    });

    await promise;
    expect(isIndexingDuringExecution).toBe(true);
    expect(ragIsIndexing()).toBe(false);
  });

  it('second call while first is running returns zeroed result', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');
    writeFile(tmpDir, 'test2.ts', 'const y = 2;\n');

    // Start first indexing — it should proceed
    const firstPromise = ragIndexProject(tmpDir);

    // Immediately try a second call — should be rejected
    const secondResult = await ragIndexProject(tmpDir);
    expect(secondResult.filesScanned).toBe(0);
    expect(secondResult.filesIndexed).toBe(0);
    expect(secondResult.chunksCreated).toBe(0);
    expect(secondResult.durationSeconds).toBe(0);

    // First call completes normally
    const firstResult = await firstPromise;
    expect(firstResult.filesScanned).toBeGreaterThanOrEqual(0);
  });

  it('allows a different project to index while this project is indexing', async () => {
    const projectB = makeTmpDir();
    try {
      writeFile(tmpDir, 'a.ts', 'const a = 1;\n');
      writeFile(projectB, 'b.ts', 'const b = 2;\n');

      const firstProject = ragIndexProject(tmpDir);
      const otherProject = await ragIndexProject(projectB);

      expect(otherProject.filesScanned).toBeGreaterThan(0);
      await firstProject;
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('flag resets after successful completion', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    expect(ragIsIndexing()).toBe(false);
    await ragIndexProject(tmpDir);
    expect(ragIsIndexing()).toBe(false);

    // Can index again after completion
    const result = await ragIndexProject(tmpDir);
    expect(result).toBeDefined();
    expect(ragIsIndexing()).toBe(false);
  });

  it('flag resets when indexProject completes (finally block)', async () => {
    expect(ragIsIndexing()).toBe(false);
    await ragIndexProject(tmpDir);
    expect(ragIsIndexing()).toBe(false);
  });

  it('terminates a stalled worker watchdog and releases the project lock', async () => {
    const stalledWorker = path.join(__dirname, '../fixtures/rag-stalled-worker.cjs');
    const pending = ragIndexProject(
      tmpDir,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workerPath: stalledWorker,
        config: {
          background_command_idle_timeout: 0.01,
          rag: { embedding_model: 'test-model' },
        } as unknown as import('../../src/main/config/schema').Config,
      },
    );

    await expect(pending).rejects.toThrow(/made no progress/i);
    expect(ragIsIndexing(tmpDir)).toBe(false);

    const retry = await ragIndexProject(
      tmpDir,
      undefined,
      undefined,
      new MockEmbedder() as unknown as import('../../src/main/rag/embedder').IEmbedder,
    );
    expect(retry).toBeDefined();
  });

  it('explicit cancellation terminates a worker and releases the project lock', async () => {
    const stalledWorker = path.join(__dirname, '../fixtures/rag-stalled-worker.cjs');
    const pending = ragIndexProject(
      tmpDir,
      undefined,
      undefined,
      undefined,
      undefined,
      { workerPath: stalledWorker },
    );

    await expect(cancelRagIndex(tmpDir)).resolves.toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(ragIsIndexing(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AST Indexer Guard Tests
// ---------------------------------------------------------------------------

describe('AST indexing concurrency guard', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    astResetSession();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isIndexing() returns false initially', () => {
    expect(astIsIndexing()).toBe(false);
  });

  it('first indexing call proceeds normally', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    expect(astIsIndexing()).toBe(false);
    const result = await astIndexProject({ projectPath: tmpDir, inline: true });
    expect(result).toBeDefined();
    expect(result.filesScanned).toBeGreaterThanOrEqual(0);
    expect(MockASTStore.lastInstance?.dispose).toHaveBeenCalledTimes(1);
    expect(astIsIndexing()).toBe(false);
  });

  it('isIndexing() returns true during indexProject execution', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    let isIndexingDuringExecution = false;
    const promise = astIndexProject({ projectPath: tmpDir, inline: true, progressCallback: () => {
        isIndexingDuringExecution = astIsIndexing();
      },
    });

    await promise;
    expect(isIndexingDuringExecution).toBe(true);
    expect(astIsIndexing()).toBe(false);
  });

  it('second call while first is running shares the single-flight result', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');
    writeFile(tmpDir, 'test2.ts', 'const y = 2;\n');

    // Start first indexing
    const firstPromise = astIndexProject({ projectPath: tmpDir, inline: true });

    // Immediately try a second call — shares the in-flight promise (no busy-poll / no empty error)
    const secondResult = await astIndexProject({ projectPath: tmpDir, inline: true });
    const firstResult = await firstPromise;
    expect(secondResult).toBe(firstResult);
    expect(firstResult.filesScanned).toBeGreaterThanOrEqual(0);
    expect(firstResult.errors).not.toContain('Indexing already in progress');
  });

  it('allows a different project to index while this project is indexing', async () => {
    const projectB = makeTmpDir();
    try {
      writeFile(tmpDir, 'a.ts', 'const a = 1;\n');
      writeFile(projectB, 'b.ts', 'const b = 2;\n');

      const firstProject = astIndexProject({ projectPath: tmpDir, inline: true });
      const otherProject = await astIndexProject({ projectPath: projectB, inline: true });

      expect(otherProject.filesScanned).toBeGreaterThan(0);
      await firstProject;
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('flag resets after successful completion', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    expect(astIsIndexing()).toBe(false);
    await astIndexProject({ projectPath: tmpDir, inline: true });
    expect(astIsIndexing()).toBe(false);

    // Can index again
    const result = await astIndexProject({ projectPath: tmpDir, inline: true });
    expect(result).toBeDefined();
    expect(astIsIndexing()).toBe(false);
  });

  it('flag resets when indexProject completes (finally block)', async () => {
    expect(astIsIndexing()).toBe(false);
    await astIndexProject({ projectPath: tmpDir, inline: true });
    expect(astIsIndexing()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Independence of RAG and AST flags
// ---------------------------------------------------------------------------

describe('RAG and AST indexing independence', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    astResetSession();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('RAG and AST use separate _indexing flags', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    // Both start as not-indexing
    expect(ragIsIndexing()).toBe(false);
    expect(astIsIndexing()).toBe(false);

    // Start RAG indexing
    const ragPromise = ragIndexProject(tmpDir);

    // RAG should be indexing, AST should not — verified after completion
    await ragPromise;
    expect(ragIsIndexing()).toBe(false);
    expect(astIsIndexing()).toBe(false);

    // Start AST indexing
    const astPromise = astIndexProject({ projectPath: tmpDir, inline: true });
    await astPromise;
    expect(ragIsIndexing()).toBe(false);
    expect(astIsIndexing()).toBe(false);
  });

  it('RAG and AST can both complete independently', async () => {
    writeFile(tmpDir, 'test.ts', 'const x = 1;\n');

    const ragResult = await ragIndexProject(tmpDir);
    const astResult = await astIndexProject({ projectPath: tmpDir, inline: true });

    expect(ragResult).toBeDefined();
    expect(astResult).toBeDefined();
    expect(ragIsIndexing()).toBe(false);
    expect(astIsIndexing()).toBe(false);
  });
});
