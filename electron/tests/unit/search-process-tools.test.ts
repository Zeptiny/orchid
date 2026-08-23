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
import { executeGrepOutcome, grepHandler } from '../../src/main/tools/search/grep';
import {
  executeCommand as executeCommandRaw,
  executeCommandHandler as executeCommandHandlerRaw,
  executeCommandToolDefinition,
} from '../../src/main/tools/process/execute-command';
import {
  executeReadOutput as executeReadOutputRaw,
  readOutputHandler as readOutputHandlerRaw,
  readOutputToolDefinition,
} from '../../src/main/tools/process/read-output';
import {
  executeSendInput as executeSendInputRaw,
  sendInputHandler as sendInputHandlerRaw,
  sendInputToolDefinition,
} from '../../src/main/tools/process/send-input';
import {
  executeTerminateCommand as executeTerminateCommandRaw,
  terminateCommandHandler as terminateCommandHandlerRaw,
  terminateCommandToolDefinition,
} from '../../src/main/tools/process/terminate-command';
import type { Config } from '../../src/main/config/schema';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import type { ToolDefinition } from '../../src/main/tools/types';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import { defaults } from '../../src/main/config';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
} from '../../src/main/indexing/refresh-coordinator';
import {
  createCanonicalToolResult,
  type GenericToolResultData,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../src/shared/types/tool-result';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalizeOutcome(
  definition: ToolDefinition,
  outcome: unknown,
): ToolExecutionResult {
  return finalizeToolExecutionResult({
    canonical: createCanonicalToolResult(
      'generic',
      outcome as ToolHandlerOutcome<GenericToolResultData>,
    ),
    toolName: definition.name,
    outputDataSchema: definition.outputDataSchema,
    expectedFamily: definition.resultFamily,
  });
}

const executeCommand = async (...args: Parameters<typeof executeCommandRaw>) =>
  canonicalizeOutcome(executeCommandToolDefinition, await executeCommandRaw(...args));
const executeCommandHandler = async (...args: Parameters<typeof executeCommandHandlerRaw>) =>
  canonicalizeOutcome(executeCommandToolDefinition, await executeCommandHandlerRaw(...args));
const executeReadOutput = async (...args: Parameters<typeof executeReadOutputRaw>) =>
  canonicalizeOutcome(readOutputToolDefinition, await executeReadOutputRaw(...args));
const readOutputHandler = async (...args: Parameters<typeof readOutputHandlerRaw>) =>
  canonicalizeOutcome(readOutputToolDefinition, await readOutputHandlerRaw(...args));
const executeSendInput = async (...args: Parameters<typeof executeSendInputRaw>) =>
  canonicalizeOutcome(sendInputToolDefinition, await executeSendInputRaw(...args));
const sendInputHandler = async (...args: Parameters<typeof sendInputHandlerRaw>) =>
  canonicalizeOutcome(sendInputToolDefinition, await sendInputHandlerRaw(...args));
const executeTerminateCommand = async (...args: Parameters<typeof executeTerminateCommandRaw>) =>
  canonicalizeOutcome(terminateCommandToolDefinition, await executeTerminateCommandRaw(...args));
const terminateCommandHandler = async (...args: Parameters<typeof terminateCommandHandlerRaw>) =>
  canonicalizeOutcome(terminateCommandToolDefinition, await terminateCommandHandlerRaw(...args));

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-test-'));
}

function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

// Background spawns in this suite exit (naturally or via store.clear()) and
// the store's exit path marks process.cwd() dirty in the index-refresh
// coordinator. Pin the debounce high and dispose the state after each test
// so no real flush can ever fire.
beforeEach(() => {
  _setIndexRefreshCoordinatorForTests({
    configLoader: () => ({
      ...defaults(),
      index_refresh: { ...defaults().index_refresh, debounce_ms: 60_000 },
    }),
  });
});

afterEach(() => {
  disposeIndexRefreshCoordinator();
});

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

  it('should own appended buffers so stream-pool mutation cannot corrupt snapshots', () => {
    const buf = new HeadTailBuffer();
    const chunk = Buffer.from('stable-output');
    buf.append(chunk);
    chunk.fill(0x58); // simulate Node reusing the stream buffer
    expect(buf.getTail()).toBe('stable-output');
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

    const result = await executeGrepOutcome('function', tmpDir, '*.ts');

    expect(result.status).toBe('complete');
    expect(result.data.matches.map((match) => match.path)).toEqual(['src/index.ts', 'src/utils.ts']);
    // Should not include .json files
    expect(result.data.matches.map((match) => match.path)).not.toContain('data.json');
  });

  it('should skip binary files', async () => {
    writeFile('src/code.ts', 'export function test() {}');
    // Create a binary file (contains null bytes)
    const binPath = path.join(tmpDir, 'binary.bin');
    fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]));

    const result = await executeGrepOutcome('test', tmpDir);

    expect(result.data.matches.map((match) => match.path)).toContain('src/code.ts');
    expect(result.data.matches.map((match) => match.path)).not.toContain('binary.bin');
  });

  it('should respect max_results and truncate', async () => {
    // Create many files with matches
    for (let i = 0; i < 10; i++) {
      writeFile(`src/file${i}.ts`, `function match${i}() {}\nfunction another${i}() {}\n`);
    }

    const result = await executeGrepOutcome('function', tmpDir, undefined, undefined, 5);

    expect(result.status).toBe('partial');
    expect(result.data.matches).toHaveLength(5);
    expect(result.data.limitReached).toBe(true);
  });

  it('should handle invalid regex gracefully', async () => {
    writeFile('src/test.ts', 'hello');

    const result = await executeGrepOutcome('[invalid', tmpDir);

    expect(result.status).toBe('error');
    expect(result.error.code).toBe('invalid_regex');
    expect(result.error.message).toContain('Invalid regex');
  });

  it('should handle non-existent path', async () => {
    const result = await executeGrepOutcome('test', '/nonexistent/path');

    expect(result.status).toBe('error');
    expect(result.error.code).toBe('path_not_found');
    expect(result.error.message).toContain('does not exist');
  });

  it('should search a single file when given a file path', async () => {
    writeFile('src/app.ts', 'function hello() {\n  return "world";\n}\nfunction goodbye() {\n  return "moon";\n}');
    writeFile('src/other.ts', 'function hello() { return "other"; }');

    const result = await executeGrepOutcome('function', path.join(tmpDir, 'src/app.ts'));

    expect(result.status).toBe('complete');
    expect(result.data.matches).toHaveLength(2);
    expect(result.data.matches[0].path).toBe('app.ts');
    expect(result.data.matches[0].line).toBe(1);
    expect(result.data.matches[1].line).toBe(4);
  });

  it('should return no matches message when nothing found', async () => {
    writeFile('src/test.ts', 'const x = 1;');

    const result = await executeGrepOutcome('nonexistent_pattern_xyz', tmpDir);

    expect(result.status).toBe('empty');
    expect(result.data.matches).toHaveLength(0);
  });

  it('should support case insensitive search', async () => {
    writeFile('src/test.ts', 'function Hello() {}\nFUNCTION world() {}');

    const result = await executeGrepOutcome('function', tmpDir, undefined, true);

    expect(result.data.matches.map((match) => match.text)).toEqual(['function Hello() {}', 'FUNCTION world() {}']);
  });

  it('uses frozen project grep limits and ignored directories', async () => {
    writeFile('src/a.ts', 'function first() {}');
    writeFile('src/b.ts', 'function second() {}');
    writeFile('generated/ignored.ts', 'function hidden() {}');

    const result = await grepHandler(
      { pattern: 'function', directory_path: '.' },
      {
        cwd: tmpDir,
        projectRuntime: {
          config: {
            grep_max_results: 1,
            ignored_dirs: ['generated'],
          } as Config,
        } as ProjectRuntime,
      },
    );

    expect(result.status).toBe('partial');
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.matches[0]?.path).not.toBe('generated/ignored.ts');
    expect(result.data.limitReached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execute command (foreground) tests
// ---------------------------------------------------------------------------

describe('execute_command foreground', () => {
  it('should run echo hello and return stdout with exit code 0', async () => {
    const result = await executeCommand({ command: 'echo hello' });

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('hello');
  });

  it('should capture stderr', async () => {
    const result = await executeCommand({ command: 'echo error >&2' });

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('error');
  });

  it('should report non-zero exit code', async () => {
    const result = await executeCommand({ command: 'exit 42' });

    expect(result.canonical.status).toBe('error');
  });

  it('should timeout long-running commands', async () => {
    const result = await executeCommand({ command: 'sleep 30', timeout: 1 });

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('timed out');
  }, 10_000);

  it('should kill the process group on outer abort (dispatch timeout)', async () => {
    // Marker file written only if the timer completes — must not appear after abort kill
    const markerDir = createTmpDir();
    const marker = path.join(markerDir, 'still-alive');
    const ac = new AbortController();
    const runPromise = executeCommand({
      command: `node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], ''), 30000)" "${marker}"`,
      description: 'long sleep',
      timeout: 60,
      shell: true,
      background: false,
      interactive: false,
      abortSignal: ac.signal,
    });

    await new Promise((r) => setTimeout(r, 200));
    ac.abort();

    const result = await runPromise;
    expect(result.canonical.status).toBe('cancelled');
    expect(result.agentProjection.content.toLowerCase()).toContain('cancelled');

    // Give any surviving sleep a moment; marker must not exist
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(markerDir, { recursive: true, force: true });
  }, 10_000);

  it('should use custom working directory', async () => {
    const dir = createTmpDir();
    fs.writeFileSync(path.join(dir, 'test.txt'), 'hello');
    const result = await executeCommand({
      command: 'cat test.txt',
      workingDirectory: dir,
    });

    expect(result.agentProjection.content).toContain('hello');
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
      expect(result.canonical.status).toBe('complete');
      expect(result.agentProjection.content).toContain('from-session-cwd');
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
    expect(result.status).toBe('complete');
    expect(result.data.matches).toEqual([
      expect.objectContaining({ path: 'hit.ts', line: 1, column: 17, text: 'export function findme() {}' }),
    ]);
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
    const result = await executeCommand({
      command: 'sleep 10',
      background: true,
      sessionId: 'sess-bg-1',
    });

    expect(result.canonical.status).toBe('complete');
    expect(result.canonical.status).toBe('complete');
  });

  it('should read output from background command', async () => {
    const sessionId = 'sess-read-1';
    const procId = await store.spawn('echo "hello from background"; sleep 2', {
      cwd: '.',
      sessionId,
    });

    // Wait a moment for output to arrive
    await new Promise((r) => setTimeout(r, 500));

    const result = await executeReadOutput(procId, undefined, undefined, sessionId);

    expect(result.agentProjection.content).toContain('hello from background');
  });

  it('should track exit code when background command finishes', async () => {
    const procId = await store.spawn('echo done; exit 0', { sessionId: 'sess-exit-1' });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 500));

    const entry = store.get(procId);
    expect(entry).toBeDefined();
    expect(entry!.exitCode).toBe(0);
  });

  it('handlers resolve bg commands with matching sessionId from ToolExecutionContext', async () => {
    const sessionId = 'sess-handler-match';
    const cwd = process.cwd();
    const spawnResult = await executeCommandHandler(
      { command: 'echo "session scoped"; sleep 2', background: true },
      { cwd, sessionId },
    );
    expect(spawnResult.canonical.status).toBe('complete');
    expect(spawnResult.agentProjection.content).toMatch(/id="(\d+)"/);

    const idMatch = spawnResult.agentProjection.content.match(/id="(\d+)"/);
    const procId = Number(idMatch![1]);

    await new Promise((r) => setTimeout(r, 500));

    const readResult = await readOutputHandler({ id: procId }, { cwd, sessionId });
    expect(readResult.canonical.status).toBe('complete');
    expect(readResult.agentProjection.content).toContain('session scoped');
  });

  it('read/send/terminate not found when sessionId does not match spawn', async () => {
    const cwd = process.cwd();
    const procId = await store.spawn('sleep 30', { sessionId: 'sess-owner' });

    const readMiss = await executeReadOutput(procId, undefined, undefined, 'other-session');
    expect(readMiss.canonical.status).toBe('error');
    expect(readMiss.canonical.status).toBe('error');

    const sendMiss = await executeSendInput(procId, 'x\n', 'other-session');
    expect(sendMiss.canonical.status).toBe('error');

    const termMiss = await executeTerminateCommand(procId, 'other-session');
    expect(termMiss.canonical.status).toBe('error');

    // Same session can still terminate
    const termOk = await terminateCommandHandler(
      { id: procId },
      { cwd, sessionId: 'sess-owner' },
    );
    expect(termOk.canonical.status).toBe('complete');
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
    const sessionId = 'sess-send-1';
    const procId = await store.spawn('sleep 10', { sessionId });

    const result = await executeSendInput(procId, 'hello\n', sessionId);

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('interactive=true');
  });

  it('should reject send_input for non-interactive command (even if exited)', async () => {
    const sessionId = 'sess-send-2';
    const procId = await store.spawn('echo hi; exit 0', { sessionId });

    // Wait for exit
    await new Promise((r) => setTimeout(r, 500));

    const result = await executeSendInput(procId, 'hello\n', sessionId);

    // "not interactive" check happens before "exited" check (matches Python)
    expect(result.canonical.status).toBe('error');
  });

  it('should reject send_input for non-interactive even if USER-owned', async () => {
    const sessionId = 'sess-send-3';
    const procId = await store.spawn('sleep 10', { sessionId });
    store.takeOwnership(procId);

    const result = await sendInputHandler(
      { id: procId, text: 'hello\n' },
      { cwd: process.cwd(), sessionId },
    );

    // "not interactive" check happens before "USER-owned" check (matches Python)
    expect(result.canonical.status).toBe('error');
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
    const sessionId = 'sess-term-1';
    const procId = await store.spawn('sleep 30', { sessionId });

    // Verify it's running
    const entryBefore = store.get(procId);
    expect(entryBefore!.exitCode).toBeNull();

    const result = await executeTerminateCommand(procId, sessionId);

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('sleep 30');
  });

  it('should report already exited command', async () => {
    const sessionId = 'sess-term-2';
    const procId = await store.spawn('echo done; exit 0', { sessionId });

    // Wait for exit
    await new Promise((r) => setTimeout(r, 500));

    const result = await executeTerminateCommand(procId, sessionId);

    expect(result.canonical.status).toBe('complete');
  });

  it('should return error for non-existent command', async () => {
    const result = await executeTerminateCommand(999, 'sess-term-3');

    expect(result.canonical.status).toBe('error');
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
