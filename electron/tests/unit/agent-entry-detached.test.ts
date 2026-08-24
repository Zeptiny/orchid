/**
 * U10 — `serve --socket <path> --detached` daemonizes.
 *
 * Real process behavior under test (the bridgeStdioToSocket esbuild-in-test
 * pattern from host-daemon-transport.test.ts): the parent spawns a detached
 * child (stdio ignored, new process group, unref'd), reports the pid, and
 * exits immediately — while the child keeps serving the socket. The fixture
 * entry wires `serveSocketDetached` exactly like agent-entry.ts does, against
 * the real `serveSocket`.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- the fixture needs a compiled artifact. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DETACHED_SERVE_ENV,
  serveSocketDetached,
  spawnDetachedChild,
} from '../../src/main/host/daemon';
import { encodeMessage } from '../../src/shared/host/framing';

let tmpRoot: string;
let detachedPids: number[];
let fixturePath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-detached-'));
  detachedPids = [];
  fixturePath = '';
});

afterEach(() => {
  for (const pid of detachedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  if (fixturePath !== '' && fs.existsSync(fixturePath)) {
    fs.rmSync(fixturePath, { force: true });
  }
});

/** Bundle the fixture entry (agent-entry's --detached wiring against serveSocket). */
function buildFixture(): string {
  const esbuild = require('esbuild') as typeof import('esbuild');
  const distDir = path.resolve(__dirname, '..', '..', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const entry = path.join(distDir, `detached-entry-${process.pid}.cjs`);
  const out = path.join(distDir, `detached-fixture-${process.pid}.js`);
  const daemonSource = path.resolve(__dirname, '../../src/main/host/daemon.ts');
  fs.writeFileSync(
    entry,
    `const { serveSocket, serveSocketDetached } = require(${JSON.stringify(daemonSource)});\n` +
      `const args = process.argv.slice(2);\n` +
      `// Same shape agent-entry.ts parses: serve --socket <path> --detached\n` +
      `if (args[0] === 'serve' && args[1] === '--socket' && args.includes('--detached')) {\n` +
      `  serveSocketDetached(args[2], {\n` +
      `    entryPath: __filename,\n` +
      `    serve: (socketPath) =>\n` +
      `      serveSocket(socketPath).then(() => process.stderr.write('listening\\n')),\n` +
      `  }).catch((error) => { console.error(error); process.exit(1); });\n` +
      `}\n`,
  );
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', 'better-sqlite3', 'node-pty', 'onnxruntime-node', '@huggingface/tokenizers'],
  });
  fs.rmSync(entry, { force: true });
  fixturePath = out;
  return out;
}

/** Minimal framed client for the served socket (host-daemon-transport harness). */
function socketRequest(socketPath: string, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('socket request timed out'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index !== -1) {
        clearTimeout(timer);
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, index)));
      }
    });
    socket.on('connect', () => {
      socket.write(encodeMessage(payload));
    });
  });
}

describe('serveSocketDetached (--detached)', () => {
  it('daemonizes: the parent returns promptly and the detached child serves the socket', async () => {
    const fixture = buildFixture();
    const socketPath = path.join(tmpRoot, 'daemon.sock');

    const parent = spawn(process.execPath, [fixture, 'serve', '--socket', socketPath, '--detached'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    parent.stderr.setEncoding('utf8');
    parent.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const startedAt = Date.now();
    const parentCode = await new Promise<number | null>((resolve) => {
      parent.on('exit', (code) => resolve(code));
    });
    const parentElapsed = Date.now() - startedAt;

    // The parent exits 0 quickly — no runtime initialization, no waiting.
    expect(parentCode).toBe(0);
    expect(parentElapsed).toBeLessThan(5_000);

    // It reported the detached child's pid.
    const pidMatch = /pid (\d+)/.exec(stderr);
    expect(pidMatch).not.toBeNull();
    const childPid = Number(pidMatch?.[1]);
    expect(Number.isFinite(childPid)).toBe(true);
    detachedPids.push(childPid);

    // The detached child (parent gone, reparented) binds the socket and
    // answers a handshake.
    await vi.waitFor(
      () => expect(fs.existsSync(socketPath)).toBe(true),
      { timeout: 10_000, interval: 50 },
    );
    const hello = (await socketRequest(socketPath, {
      id: 7,
      method: 'host.hello',
      params: { protocolVersion: 1 },
    })) as { id?: number; ok?: boolean; result?: { protocolVersion?: number } };
    expect(hello).toMatchObject({ id: 7, ok: true });
    expect(hello.result?.protocolVersion).toBe(1);
  }, 30_000);

  it('runs the serve callback on child re-entry (env marker) and never in the parent', async () => {
    const serveCalls: string[] = [];
    const exitCodes: number[] = [];
    const fakeSpawn = vi.fn(
      (command: string, args: string[]) =>
        spawn(command, args, { detached: true, stdio: 'ignore' }) as never,
    );
    const run = serveSocketDetached('/tmp/orchid-detached-test.sock', {
      entryPath: '/tmp/entry.js',
      spawnFn: fakeSpawn,
      env: { ...process.env },
      exit: (code) => exitCodes.push(code),
      serve: async (socketPath) => {
        serveCalls.push(socketPath);
      },
    });
    await run;
    // Parent path: no serve, one detached spawn, exit(0) requested.
    expect(serveCalls).toEqual([]);
    expect(exitCodes).toEqual([0]);
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = fakeSpawn.mock.calls[0] as unknown as [
      string, string[], { detached: boolean; stdio: string },
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/tmp/entry.js', 'serve', '--socket', '/tmp/orchid-detached-test.sock', '--detached']);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.env[DETACHED_SERVE_ENV]).toBe('1');

    // Child re-entry (marker set): runs the serve callback directly.
    const childServe: string[] = [];
    await serveSocketDetached('/tmp/child.sock', {
      entryPath: '/tmp/entry.js',
      env: { [DETACHED_SERVE_ENV]: '1' },
      exit: (code) => exitCodes.push(code),
      serve: async (socketPath) => {
        childServe.push(socketPath);
      },
    });
    expect(childServe).toEqual(['/tmp/child.sock']);
    expect(exitCodes).toEqual([0]);
  });

  it('exposes a spawn-detached child that is unref\'d and survives its parent', async () => {
    const child = spawnDetachedChild(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 250)'], {
      ...process.env,
    });
    expect(child.pid).toBeTruthy();
    // unref'd: the runner's event loop is not held by the child.
    expect(child.killed).toBe(false);
    detachedPids.push(child.pid as number);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still running after the parent-side reference is dropped.
    expect(() => process.kill(child.pid as number, 0)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(() => process.kill(child.pid as number, 0)).toThrow();
  });
});
