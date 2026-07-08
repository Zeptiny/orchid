/**
 * Tests for filesystem tools (U13).
 *
 * Covers:
 * - read: lines 10-20 of 100-line file, empty file, binary detection, offset > line count
 * - edit: single match, multiple match guard, replace_all, diff produced, post-write callbacks
 * - write: new file with parent dirs, existing file overwrite, post-write callbacks
 * - read_directory: tree structure, depth limiting, hidden file filtering
 * - glob: all TS files sorted by mtime, hidden file filtering
 * - Post-write callbacks: edit triggers RAG and AST re-indexing
 *
 * Test scenarios from plan U13.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readHandler } from '../../src/main/tools/filesystem/read';
import { editHandler } from '../../src/main/tools/filesystem/edit';
import { writeHandler } from '../../src/main/tools/filesystem/write';
import { readDirectoryHandler } from '../../src/main/tools/filesystem/read-directory';
import { globHandler } from '../../src/main/tools/filesystem/glob';
import {
  registerPostWriteCallback,
  clearPostWriteCallbacks,
  callbackCount,
} from '../../src/main/tools/filesystem/callbacks';

// ── Test fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-tools-test-'));
}

function writeFile(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, relPath), 'utf-8');
}

function exists(relPath: string): boolean {
  return fs.existsSync(path.join(tmpDir, relPath));
}

/**
 * Generate a file with N lines, each containing "line N".
 */
function generateLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = createTmpDir();
  clearPostWriteCallbacks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  clearPostWriteCallbacks();
});

// ── read tool ──────────────────────────────────────────────────────────────

describe('read tool', () => {
  it('should read lines 10-20 of a 100-line file', async () => {
    const filePath = writeFile('hundred.txt', generateLines(100));

    const result = await readHandler({
      file_path: filePath,
      offset: 10,
      limit: 11,
    });

    expect(result.display).toContain('Read');
    expect(result.display).toContain('10-20');
    expect(result.content).toContain('Showing lines 10-20 of 100');
    expect(result.content).toContain('10 | line 10');
    expect(result.content).toContain('20 | line 20');
    // Should NOT contain line 9 or 21
    expect(result.content).not.toContain('9 | line 9');
    expect(result.content).not.toContain('21 | line 21');
  });

  it('should handle empty file', async () => {
    const filePath = writeFile('empty.txt', '');

    const result = await readHandler({ file_path: filePath });

    expect(result.display).toContain('empty');
    expect(result.content).toContain('empty');
    expect(result.content).toContain('0 lines');
  });

  it('should use default limit from config when not specified', async () => {
    const filePath = writeFile('long.txt', generateLines(2000));

    const result = await readHandler({ file_path: filePath });

    // Default limit is 1000
    expect(result.content).toContain('Showing lines 1-1000 of 2000');
    expect(result.content).toContain('1 | line 1');
    expect(result.content).toContain('1000 | line 1000');
  });

  it('should detect and skip binary files', async () => {
    const filePath = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    fs.writeFileSync(filePath, buf);

    const result = await readHandler({ file_path: filePath });

    expect(result.display).toContain('error');
    expect(result.content).toContain('binary');
  });

  it('should return error when offset > line count', async () => {
    const filePath = writeFile('short.txt', 'line 1\nline 2\nline 3');

    const result = await readHandler({
      file_path: filePath,
      offset: 10,
      limit: 5,
    });

    expect(result.display).toContain('out of range');
    expect(result.content).toContain('Offset of 10 is greater than the file line count 3');
  });

  it('should return error for nonexistent file', async () => {
    const result = await readHandler({
      file_path: path.join(tmpDir, 'nonexistent.txt'),
    });

    expect(result.display).toContain('error');
    expect(result.content).toContain('Error reading file');
  });
});

// ── edit tool ──────────────────────────────────────────────────────────────

describe('edit tool', () => {
  it('should replace a single match', async () => {
    const filePath = writeFile('edit.txt', 'hello world\nfoo bar\nhello again');

    const result = await editHandler({
      file_path: filePath,
      old_string: 'foo bar',
      new_string: 'baz qux',
    });

    expect(result.display).toContain('Edited');
    const content = readFile('edit.txt');
    expect(content).toContain('baz qux');
    expect(content).not.toContain('foo bar');
  });

  it('should refuse multiple matches when replace_all is false', async () => {
    const filePath = writeFile(
      'multi.txt',
      'hello world\nhello again\nhello third',
    );

    const result = await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });

    expect(result.display).toContain('Multiple matches');
    expect(result.content).toContain('found 3 times');
    // File should be unchanged
    const content = readFile('multi.txt');
    expect(content).toContain('hello world');
  });

  it('should replace all occurrences when replace_all is true', async () => {
    const filePath = writeFile(
      'multi.txt',
      'hello world\nhello again\nhello third',
    );

    const result = await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
      replace_all: true,
    });

    expect(result.display).toContain('Edited');
    const content = readFile('multi.txt');
    expect(content).toContain('goodbye world');
    expect(content).toContain('goodbye again');
    expect(content).toContain('goodbye third');
    expect(content).not.toContain('hello');
  });

  it('should return error when string not found', async () => {
    const filePath = writeFile('edit.txt', 'hello world');

    const result = await editHandler({
      file_path: filePath,
      old_string: 'nonexistent',
      new_string: 'replacement',
    });

    expect(result.display).toContain('not found');
    expect(result.content).toContain('not found');
  });

  it('should produce a diff', async () => {
    const filePath = writeFile('diff.txt', 'line 1\nline 2\nline 3');

    const result = await editHandler({
      file_path: filePath,
      old_string: 'line 2',
      new_string: 'modified line 2',
    });

    expect(result.content).toContain('---');
    expect(result.content).toContain('+++');
    expect(result.content).toContain('-line 2');
    expect(result.content).toContain('+modified line 2');
  });

  it('should trigger post-write callbacks after edit', async () => {
    const filePath = writeFile('callback.txt', 'hello world');
    const calledWith: string[] = [];

    registerPostWriteCallback(async (fp: string) => {
      calledWith.push(fp);
    });

    await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });

    expect(calledWith).toHaveLength(1);
    expect(calledWith[0]).toBe(filePath);
  });

  it('should preserve file permissions after edit', async () => {
    const filePath = writeFile('perm.txt', 'hello world');
    // Set specific permissions (read-write for owner only)
    fs.chmodSync(filePath, 0o600);
    const beforeStat = fs.statSync(filePath);

    await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });

    const afterStat = fs.statSync(filePath);
    expect(afterStat.mode).toBe(beforeStat.mode);
    // Verify content was actually changed
    expect(readFile('perm.txt')).toBe('goodbye world');
  });

  it('should preserve executable permissions after edit', async () => {
    const filePath = writeFile('script.sh', '#!/bin/bash\necho hello');
    // Set executable permissions
    fs.chmodSync(filePath, 0o755);
    const beforeStat = fs.statSync(filePath);

    await editHandler({
      file_path: filePath,
      old_string: 'echo hello',
      new_string: 'echo world',
    });

    const afterStat = fs.statSync(filePath);
    expect(afterStat.mode).toBe(beforeStat.mode);
    expect(afterStat.mode & 0o111).toBe(0o111); // Executable bits preserved
  });
});

// ── write tool ─────────────────────────────────────────────────────────────

describe('write tool', () => {
  it('should create a new file with parent directories', async () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');

    const result = await writeHandler({
      file_path: filePath,
      content: 'hello world',
    });

    expect(result.display).toContain('Wrote');
    expect(result.display).toContain('1 lines');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('should overwrite an existing file', async () => {
    const filePath = writeFile('existing.txt', 'old content');

    const result = await writeHandler({
      file_path: filePath,
      content: 'new content',
    });

    expect(result.display).toContain('Wrote');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('should trigger post-write callbacks after write', async () => {
    const filePath = path.join(tmpDir, 'cb-write.txt');
    const calledWith: string[] = [];

    registerPostWriteCallback(async (fp: string) => {
      calledWith.push(fp);
    });

    await writeHandler({
      file_path: filePath,
      content: 'test',
    });

    expect(calledWith).toHaveLength(1);
    expect(calledWith[0]).toBe(filePath);
  });

  it('should return file content with line numbers in result', async () => {
    const filePath = path.join(tmpDir, 'numbered.txt');

    const result = await writeHandler({
      file_path: filePath,
      content: 'first\nsecond\nthird',
    });

    expect(result.content).toContain('1 | first');
    expect(result.content).toContain('2 | second');
    expect(result.content).toContain('3 | third');
  });

  it('should preserve file permissions when overwriting existing file', async () => {
    const filePath = writeFile('perm-write.txt', 'old content');
    // Set specific permissions
    fs.chmodSync(filePath, 0o640);
    const beforeStat = fs.statSync(filePath);

    await writeHandler({
      file_path: filePath,
      content: 'new content',
    });

    const afterStat = fs.statSync(filePath);
    expect(afterStat.mode).toBe(beforeStat.mode);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('should use default permissions (0o644) for new files', async () => {
    const filePath = path.join(tmpDir, 'new-perm.txt');

    await writeHandler({
      file_path: filePath,
      content: 'new file content',
    });

    const stat = fs.statSync(filePath);
    // Check that the file has 0o644 permissions (masked with umask)
    // The actual mode may be affected by umask, so we check the key bits
    expect(stat.mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new file content');
  });
});

// ── read_directory tool ────────────────────────────────────────────────────

describe('read_directory tool', () => {
  it('should return ASCII tree of directory contents', async () => {
    writeFile('src/index.ts', '');
    writeFile('src/utils.ts', '');
    writeFile('package.json', '');

    const result = await readDirectoryHandler({
      directory_path: tmpDir,
    });

    expect(result.display).toContain('Read directory');
    expect(result.content).toContain('package.json');
    expect(result.content).toContain('src/');
    expect(result.content).toContain('├──');
    expect(result.content).toContain('└──');
  });

  it('should respect max_depth parameter', async () => {
    writeFile('a/b/c/d/file.txt', '');

    const result = await readDirectoryHandler({
      directory_path: tmpDir,
      max_depth: 2,
    });

    // Depth 2: should show a/ and b/ but not c/ or deeper
    expect(result.content).toContain('a/');
    expect(result.content).toContain('b/');
    expect(result.content).not.toContain('c/');
  });

  it('should exclude hidden files by default', async () => {
    writeFile('.hidden-file', '');
    writeFile('.hidden-dir/secret.txt', '');
    writeFile('visible.txt', '');

    const result = await readDirectoryHandler({
      directory_path: tmpDir,
    });

    expect(result.content).toContain('visible.txt');
    expect(result.content).not.toContain('.hidden-file');
    expect(result.content).not.toContain('.hidden-dir');
  });

  it('should include hidden files when include_hidden is true', async () => {
    writeFile('.hidden-file', '');
    writeFile('visible.txt', '');

    const result = await readDirectoryHandler({
      directory_path: tmpDir,
      include_hidden: true,
    });

    expect(result.content).toContain('visible.txt');
    expect(result.content).toContain('.hidden-file');
  });
});

// ── glob tool ──────────────────────────────────────────────────────────────

describe('glob tool', () => {
  it('should find all TS files matching **/*.ts sorted by mtime', async () => {
    // Create files with deliberate mtime ordering
    const file1 = writeFile('src/a.ts', '');
    const file2 = writeFile('src/b.ts', '');
    const file3 = writeFile('src/c.js', '');

    // Set mtimes: b.ts is newest, a.ts is oldest
    const now = Date.now();
    fs.utimesSync(file1, now / 1000 - 300, now / 1000 - 300);
    fs.utimesSync(file2, now / 1000, now / 1000);
    fs.utimesSync(file3, now / 1000 - 100, now / 1000 - 100);

    const result = await globHandler({
      directory_path: tmpDir,
      pattern: '**/*.ts',
    });

    expect(result.display).toContain('Found');
    expect(result.display).toContain('matches');
    // Should find a.ts and b.ts, not c.js
    expect(result.content).toContain('a.ts');
    expect(result.content).toContain('b.ts');
    expect(result.content).not.toContain('c.js');

    // Should be sorted by mtime newest first
    const lines = result.content.split('\n').slice(1); // skip header
    expect(lines[0]).toContain('b.ts'); // newest
    expect(lines[1]).toContain('a.ts'); // oldest
  });

  it('should return "no matches" for pattern with no results', async () => {
    writeFile('src/index.ts', '');

    const result = await globHandler({
      directory_path: tmpDir,
      pattern: '**/*.py',
    });

    expect(result.display).toContain('No matches');
    expect(result.content).toContain('No files found');
  });

  it('should exclude hidden files by default', async () => {
    writeFile('.hidden.ts', '');
    writeFile('visible.ts', '');

    const result = await globHandler({
      directory_path: tmpDir,
      pattern: '**/*.ts',
    });

    expect(result.content).toContain('visible.ts');
    expect(result.content).not.toContain('.hidden.ts');
  });

  it('should include hidden files when include_hidden is true', async () => {
    writeFile('.hidden.ts', '');
    writeFile('visible.ts', '');

    const result = await globHandler({
      directory_path: tmpDir,
      pattern: '*.ts',
      include_hidden: true,
    });

    expect(result.content).toContain('visible.ts');
    expect(result.content).toContain('.hidden.ts');
  });
});

// ── Post-write callbacks ───────────────────────────────────────────────────

describe('post-write callbacks', () => {
  it('should register and invoke callbacks for edit', async () => {
    const filePath = writeFile('cb.txt', 'hello');
    const calls: string[] = [];

    registerPostWriteCallback(async (fp) => {
      calls.push(`rag:${fp}`);
    });
    registerPostWriteCallback(async (fp) => {
      calls.push(`ast:${fp}`);
    });

    expect(callbackCount()).toBe(2);

    await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'world',
    });

    expect(calls).toHaveLength(2);
    expect(calls).toContain(`rag:${filePath}`);
    expect(calls).toContain(`ast:${filePath}`);
  });

  it('should register and invoke callbacks for write', async () => {
    const filePath = path.join(tmpDir, 'cb-write.txt');
    const calls: string[] = [];

    registerPostWriteCallback(async (fp) => {
      calls.push(`rag:${fp}`);
    });
    registerPostWriteCallback(async (fp) => {
      calls.push(`ast:${fp}`);
    });

    await writeHandler({
      file_path: filePath,
      content: 'test content',
    });

    expect(calls).toHaveLength(2);
    expect(calls).toContain(`rag:${filePath}`);
    expect(calls).toContain(`ast:${filePath}`);
  });

  it('should report callback failures in display', async () => {
    const filePath = writeFile('fail.txt', 'hello');

    registerPostWriteCallback(async () => {
      throw new Error('RAG indexing failed');
    });

    const result = await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'world',
    });

    expect(result.display).toContain('warnings');
    expect(result.display).toContain('1 callback(s) failed');
  });

  it('should continue editing even if callback fails', async () => {
    const filePath = writeFile('fail.txt', 'hello');

    registerPostWriteCallback(async () => {
      throw new Error('RAG indexing failed');
    });

    const result = await editHandler({
      file_path: filePath,
      old_string: 'hello',
      new_string: 'world',
    });

    // Edit should still succeed
    expect(result.display).toContain('Edited');
    expect(readFile('fail.txt')).toBe('world');
  });

  it('should not duplicate the same callback function', () => {
    const cb = async () => {};
    registerPostWriteCallback(cb);
    registerPostWriteCallback(cb);
    expect(callbackCount()).toBe(1);
  });

  it('should clear callbacks', () => {
    registerPostWriteCallback(async () => {});
    registerPostWriteCallback(async () => {});
    expect(callbackCount()).toBe(2);

    clearPostWriteCallbacks();
    expect(callbackCount()).toBe(0);
  });
});
