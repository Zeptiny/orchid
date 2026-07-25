/**
 * ast_index tool unit tests (M-P0-023).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { astIndexDefinition, astIndexHandler } from '../../src/main/tools/ast/index-tool';
import { ASTStore } from '../../src/main/ast/store';

vi.mock('../../src/main/ast/indexer', () => ({
  indexProject: vi.fn(async () => ({
    filesScanned: 3,
    filesIndexed: 2,
    filesSkipped: 1,
    filesDeleted: 0,
    symbolsExtracted: 10,
    errors: [],
    durationSeconds: 0.5,
  })),
}));

describe('ast_index tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-ast-index-tool-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct definition metadata', () => {
    expect(astIndexDefinition.name).toBe('ast_index');
    expect(astIndexDefinition.category).toBe('ast');
    expect(astIndexDefinition.noTimeout).toBe(true);
  });

  it('status reports empty index', async () => {
    const result = await astIndexHandler(
      { action: 'status' },
      { cwd: tmpDir },
    );
    expect(result.status).toBe('complete');
    expect(result.data.value).toMatchObject({
      action: 'status',
      totalFiles: 0,
      totalSymbols: 0,
      lastIndexed: 'never',
    });
  });

  it('index returns summary from indexer', async () => {
    const result = await astIndexHandler(
      { action: 'index' },
      { cwd: tmpDir },
    );
    expect(result.status).toBe('complete');
    expect(result.data.value).toMatchObject({
      action: 'index',
      filesScanned: 3,
      symbolsExtracted: 10,
    });
  });

  it('clear drops the store', async () => {
    const store = new ASTStore(tmpDir);
    store.initDb();
    store.recordIndex(1.2);
    expect(store.status().lastIndexed).not.toBeNull();
    store.dispose();

    const result = await astIndexHandler(
      { action: 'clear' },
      { cwd: tmpDir },
    );
    expect(result.status).toBe('complete');
    expect(result.data.value).toEqual({ action: 'clear' });

    const after = new ASTStore(tmpDir);
    try {
      expect(after.status().totalFiles).toBe(0);
      expect(after.status().lastIndexed).toBeNull();
    } finally {
      after.dispose();
    }
  });
});
