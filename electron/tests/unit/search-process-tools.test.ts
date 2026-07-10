/**
 * Tests for search and process tools.
 *
 * Covers: grep (search), execute_command (foreground + background),
 * read_output, send_input, terminate_command, HeadTailBuffer, LRU eviction.
 *
 * Ported from Python test expectations per U14 plan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HeadTailBuffer, HEAD_CAP, TAIL_CAP, TOTAL_CAP } from '../../src/main/tools/process/head-tail-buffer';
import {
  BackgroundProcessStore,
  setBackgroundStore,
} from '../../src/main/tools/process/background-store';
import { executeGrep, grepHandler } from '../../src/main/tools/search/grep';
import {
  executeCommand,
  executeCommandHandler,
} from '../../src/main/tools/process/execute-command';
import { executeReadOutput } from '../../src/main/tools/process/read-output';
import { executeSendInput } from '../../src/main/tools/process/send-input';
import { executeTerminateCommand } from '../../src/main/tools/process/terminate-command';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-test-'));
}

function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// HeadTailBuffer tests
// ---------------------------------------------------------------------------

describe('HeadTailBuffer', () => {
  it('should append data under the cap', () => {
    const buf = new HeadTailBuffer();
    buf.append(Buffer.from('hello '));
    buf.append(Buffer.from('world'));

    expect(buf.getTail()).toBe('hello world');
    expect(buf.totalBytes()).toBe(11);
  });

  it('should keep head + tail when exceeding cap', () => {
    const buf = new HeadTailBuffer();

    // Write enough data to exceed TOTAL_CAP (~1 MiB)
    // Write 600KB to head, then 600KB more to trigger cap
    const chunk600k = Buffer.alloc(600 * 1024, 0x41); // 'A'
    buf.append(chunk600k);
    expect(buf.totalBytes()).toBe(600 * 1024);

    // Still under cap (600KB < 1MB)
    const chunk200k = Buffer.alloc(200 * 1024, 0x42); // 'B'
    buf.append(chunk200k);
    expect(buf.totalBytes()).toBe(800 * 1024);

    // Now exceed the cap with another 400KB
    const chunk400k = Buffer.alloc(400 * 1024, 0x43); // 'C'
    buf.append(chunk400k);

    // Should have head + tail, total <= TOTAL_CAP
    expect(buf.totalBytes()).toBeLessThanOrEqual(TOTAL_CAP);
    expect(buf.head.length).toBe(HEAD_CAP);
    // Tail should contain the end portion
    expect(buf.tail.length).toBeGreaterThan(0);
    expect(buf.tail.length).toBeLessThanOrEqual(TAIL_CAP);
  });

  it('should preserve head and drop middle for >1MB data', () => {
    const buf = new HeadTailBuffer();

    // Write 1.5MB of data
    const bigChunk = Buffer.alloc(1536 * 1024, 0x58); // 'X'
    buf.append(bigChunk);

    // Head should be exactly HEAD_CAP
    expect(buf.head.length).toBe(HEAD_CAP);
    // Tail should be <= TAIL_CAP
    expect(buf.tail.length).toBeLessThanOrEqual(TAIL_CAP);
    // Total should be <= TOTAL_CAP
    expect(buf.totalBytes()).toBeLessThanOrEqual(TOTAL_CAP);

    // Head should contain the first 512KB of data
    const headByte = buf.head[0];
    expect(headByte).toBe(0x58); // 'X'
  });

  it('should handle getTail with last_n lines', () => {
    const buf = new HeadTailBuffer();
    buf.append(Buffer.from('line1\nline2\nline3\nline4\nline5\n'));

    expect(buf.getTail(3)).toBe('line3\nline4\nline5\n');
    expect(buf.getTail(1)).toBe('line5\n');
    expect(buf.getTail(0)).toBe('');
  });

  it('should report totalWritten correctly', () => {
    const buf = new HeadTailBuffer();
    buf.append(Buffer.alloc(1000));
    buf.append(Buffer.alloc(2000));

    expect(buf.totalWritten).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Grep tests
// ---------------------------------------------------------------------------

describe('grep tool', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should search for "function" in .ts files', async () => {
    writeFile('src/index.ts', 'export function hello() {\n  return "world";\n}\n');
    writeFile('src/utils.ts', 'const helper = () => {};\nexport function helperFn() {}\n');
    writeFile('src/data.json', '{"key": "value"}');

    const result = await executeGrep('function', tmpDir, '*.ts');

    expect(result.display).toContain('Found');
    expect(result.content).toContain('src/index.ts');
    expect(result.content).toContain('src/utils.ts');
    // Should not include .json files
    expect(result.content).not.toContain('data.json');
  });

  it('should skip binary files', async () => {
    writeFile('src/code.ts', 'export function test() {}');
    // Create a binary file (contains null bytes)
    const binPath = path.join(tmpDir, 'binary.bin');
    fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));

    const result = await executeGrep('test', tmpDir);

    expect(result.content).toContain('code.ts');
    expect(result.content).not.toContain('binary.bin');
  });

  it('should respect max_results and truncate', async () => {
    // Create many files with matches
    for (let i = 0; i < 10; i++) {
      writeFile(`src/file${i}.ts`, `function match${i}() {}\nfunction another${i}() {}\n`);
    }

    const result = await executeGrep('function', tmpDir, undefined, undefined, 5);

    expect(result.display).toContain('5');
    expect(result.content).toContain('truncated to 5');
  });

  it('should handle invalid regex gracefully', async () => {
    writeFile('src/test.ts', 'hello');

    const result = await executeGrep('[invalid', tmpDir);

    expect(result.display).toContain('Invalid regex');
    expect(result.content).toContain('Error');
  });

  it('should handle non-existent directory', async () => {
    const result = await executeGrep('test', '/nonexistent/path');

    expect(result.display).toContain('Directory not found');
    expect(result.content).toContain('does not exist');
  });

  it('should return no matches message when nothing found', async () => {
    writeFile('src/test.ts', 'const x = 1;');

    const result = await executeGrep('nonexistent_pattern_xyz', tmpDir);

    expect(result.display).toContain('No matches');
    expect(result.content).toContain('No matches found');
  });

  it('should support case insensitive search', async () => {
    writeFile('src/test.ts', 'function Hello() {}\nFUNCTION world() {}');

    const result = await executeGrep('function', tmpDir, undefined, true);

    expect(result.content).toContain('Hello');
    expect(result.content).toContain('world');
  });
});

// ---------------------------------------------------------------------------
// Execute command (foreground) tests
// ---------------------------------------------------------------------------

describe('execute_command foreground', () => {
  it('should run echo hello and return stdout with exit code 0', async () => {
    const result = await executeCommand('echo hello');

    expect(result.display).toContain('exit code: 0');
    expect(result.content).toContain('hello');
  });

  it('should capture stderr', async () => {
    const result = await executeCommand('echo error >&2');

    expect(result.display).toContain('exit code: 0');
    expect(result.content).toContain('error');
  });

  it('should report non-zero exit code', async () => {
    const result = await executeCommand('exit 42');

    expect(result.display).toContain('exit code: 42');
  });

  it('should timeout long-running commands', async () => {
    const result = await executeCommand('sleep 30', undefined, undefined, 1);

    expect(result.display).toContain('Timed out');
    expect(result.content).toContain('timed out');
  }, 10_000);

  it('should use custom working directory', async () => {
    const dir = createTmpDir();
    fs.writeFileSync(path.join(dir, 'test.txt'), 'hello');
    const result = await executeCommand('cat test.txt', undefined, dir);

    expect(result.content).toContain('hello');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handler defaults working directory to session ctx.cwd', async () => {
    const dir = createTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'session-cwd.txt'), 'from-session-cwd');
      const result = await executeCommandHandler(
        { command: 'cat session-cwd.txt' },
        { cwd: dir },
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('from-session-cwd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grep handler session cwd', () => {
  it('resolves relative directory_path against ctx.cwd', async () => {
    writeFile('src/hit.ts', 'export function findme() {}\n');
    const result = await grepHandler(
      {
        pattern: 'findme',
        directory_path: 'src',
      },
      { cwd: tmpDir },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('findme');
  });
});

// ---------------------------------------------------------------------------
// Execute command (background) tests
// ---------------------------------------------------------------------------

describe('execute_command background', () => {
  let store: BackgroundProcessStore;

  beforeEach(() => {
    store = new BackgroundProcessStore();
    setBackgroundStore(store);
  });

  afterEach(() => {
    store.clear();
  });

  it('should return ID for background sleep command', async () => {
    const result = await executeCommand('sleep 10', undefined, undefined, undefined, undefined, true);

    expect(result.display).toContain('id:');
    expect(result.display).toContain('background');
  });

  it('should read output from background command', async () => {
    const procId = await store.spawn('echo "hello from background"; sleep 2', {
      cwd: '.',
    });

    // Wait a moment for output to arrive
    await new Promise((r) => setTimeout(r, 500));

    const result = await executeReadOutput(procId);

    expect(result.content).toContain('hello from background');
  });

  it('should track exit code when background command finishes', async () => {
    const procId = await store.spawn('echo done; exit 0');

    // Wait for completion
    await new Promise((r) => setTimeout(r, 500));

    const entry = store.get(procId);
    expect(entry).toBeDefined();
    expect(entry!.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Send input tests
// ---------------------------------------------------------------------------

describe('send_input', () => {
  let store: BackgroundProcessStore;

  beforeEach(() => {
    store = new BackgroundProcessStore();
    setBackgroundStore(store);
  });

  afterEach(() => {
    store.clear();
  });

  it('should reject send_input for non-interactive command', async () => {
    const procId = await store.spawn('sleep 10');

    const result = await executeSendInput(procId, 'hello\n');

    expect(result.display).toContain('not interactive');
    expect(result.content).toContain('interactive=true');
  });

  it('should reject send_input for non-interactive command (even if exited)', async () => {
    const procId = await store.spawn('echo hi; exit 0');

    // Wait for exit
    await new Promise((r) => setTimeout(r, 500));

    const result = await executeSendInput(procId, 'hello\n');

    // "not interactive" check happens before "exited" check (matches Python)
    expect(result.display).toContain('not interactive');
  });

  it('should reject send_input for non-interactive even if USER-owned', async () => {
    const procId = await store.spawn('sleep 10');
    store.takeOwnership(procId);

    const result = await executeSendInput(procId, 'hello\n');

    // "not interactive" check happens before "USER-owned" check (matches Python)
    expect(result.display).toContain('not interactive');
  });
});

// ---------------------------------------------------------------------------
// Terminate command tests
// ---------------------------------------------------------------------------

describe('terminate_command', () => {
  let store: BackgroundProcessStore;

  beforeEach(() => {
    store = new BackgroundProcessStore();
    setBackgroundStore(store);
  });

  afterEach(() => {
    store.clear();
  });

  it('should terminate a running background command', async () => {
    const procId = await store.spawn('sleep 30');

    // Verify it's running
    const entryBefore = store.get(procId);
    expect(entryBefore!.exitCode).toBeNull();

    const result = await executeTerminateCommand(procId);

    expect(result.display).toContain('Terminated');
    expect(result.content).toContain('sleep 30');
  });

  it('should report already exited command', async () => {
    const procId = await store.spawn('echo done; exit 0');

    // Wait for exit
    await new Promise((r) => setTimeout(r, 500));

    const result = await executeTerminateCommand(procId);

    expect(result.display).toContain('already exited');
  });

  it('should return error for non-existent command', async () => {
    const result = await executeTerminateCommand(999);

    expect(result.display).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// LRU eviction tests
// ---------------------------------------------------------------------------

describe('LRU eviction', () => {
  let store: BackgroundProcessStore;

  beforeEach(() => {
    store = new BackgroundProcessStore();
    setBackgroundStore(store);
  });

  afterEach(() => {
    store.clear();
  });

  it('should evict oldest entry when exceeding 64 entries', async () => {
    // Spawn 65 commands (64 + 1 to trigger eviction)
    const ids: number[] = [];
    for (let i = 0; i < 65; i++) {
      const id = await store.spawn(`echo ${i}; sleep 30`);
      ids.push(id);
      // Small delay to ensure distinct createdAt timestamps
      await new Promise((r) => setTimeout(r, 5));
    }

    // First entry (oldest) should have been evicted
    const oldestEntry = store.get(ids[0]);
    expect(oldestEntry).toBeUndefined();

    // Most recent entries should still exist
    const newestEntry = store.get(ids[64]);
    expect(newestEntry).toBeDefined();

    // Total entries should be <= 64
    expect(store.list().length).toBeLessThanOrEqual(64);
  });

  it('should protect the 8 most recent entries from eviction', async () => {
    // Spawn 65 commands
    const ids: number[] = [];
    for (let i = 0; i < 65; i++) {
      const id = await store.spawn(`echo ${i}; sleep 30`);
      ids.push(id);
      await new Promise((r) => setTimeout(r, 5));
    }

    // The last 8 entries should definitely still exist
    for (let i = 57; i < 65; i++) {
      const entry = store.get(ids[i]);
      expect(entry).toBeDefined();
    }
  });
});
