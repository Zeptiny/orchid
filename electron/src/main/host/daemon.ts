/**
 * Transport plumbing for the `orchid-agent` daemon — transport-agnostic
 * wiring between Node streams/sockets and a {@link HostServer}.
 *
 * All transports speak the newline-delimited JSON framing from
 * shared/host/framing.ts. Requests are dispatched through the server;
 * responses and events are written back on the same stream.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { createFrameDecoder, encodeMessage, FrameError } from '../../shared/host/framing';
import { isHostRequest, type HostRequest } from '../../shared/host/protocol';
import { createHostServer, type HostServer } from './server';

/** Fixed client id of the single stdio connection. */
export const STDIO_CLIENT_ID = 'stdio';

const SOCKET_MODE = 0o600;

/**
 * Env key marking the detached child re-entry of `serve --socket --detached`
 * (U10). The parent spawns a fresh process running the same entrypoint with
 * this key set; that child recognizes itself and serves in the foreground.
 */
export const DETACHED_SERVE_ENV = 'ORCHID_AGENT_SERVE_DETACHED';

interface TransportOptions {
  /** Server to dispatch through (one is created when omitted). */
  readonly server?: HostServer;
}

function logError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[orchid-agent:${scope}] ${message}`);
}

/**
 * Wire one readable/writable pair to the server as a single connection.
 *
 * Frames are decoded from `input`; requests produce responses on `output`.
 * Framing violations are reported on stderr and end the connection — a
 * hostile or corrupt peer must never crash the daemon.
 */
export function attachStreamConnection(
  server: HostServer,
  input: NodeJS.ReadableStream & { destroy?: () => void },
  output: NodeJS.WritableStream,
  clientId: string,
): { readonly close: () => void; readonly closed: Promise<void> } {
  const decoder = createFrameDecoder();
  const handle = server.addConnection(clientId, (event) => {
    try {
      output.write(encodeMessage(event));
    } catch (error) {
      logError('event', error);
    }
  });

  const dispatch = (message: unknown): void => {
    if (!isHostRequest(message)) return;
    const request = message as HostRequest;
    void server.handleRequest(request, clientId).then((response) => {
      try {
        output.write(encodeMessage(response));
      } catch (error) {
        logError('response', error);
      }
    }, (error: unknown) => {
      logError('dispatch', error);
    });
  };

  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const finish = () => {
    handle.dispose();
    closedResolve();
  };

  input.on('data', (chunk: Buffer | string) => {
    try {
      for (const message of decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
        dispatch(message);
      }
    } catch (error) {
      if (error instanceof FrameError) {
        logError('framing', error);
      } else {
        logError('decode', error);
      }
      finish();
      input.destroy?.();
    }
  });
  input.on('end', finish);
  input.on('error', (error: unknown) => {
    logError('input', error);
    finish();
  });

  return { close: finish, closed };
}

/**
 * `serve --stdio`: one connection over the process's own stdin/stdout.
 * Resolves when stdin ends. Diagnostics go to stderr, never stdout.
 */
export async function serveStdio(
  options: TransportOptions = {},
): Promise<void> {
  const server = options.server ?? createHostServer();
  const { closed } = attachStreamConnection(server, process.stdin, process.stdout, STDIO_CLIENT_ID);
  await closed;
}

/**
 * `serve --socket <path>`: a UNIX-socket listener owning `~/.orchid` state.
 *
 * Multiple concurrent connections are supported, each with its own
 * `conn-<n>` client id. The socket is created with mode 0600 immediately
 * after listen (same-user only). Server-side errors are logged to stderr and
 * never crash the process.
 */
export function serveSocket(
  socketPath: string,
  options: TransportOptions = {},
): Promise<net.Server> {
  const server = options.server ?? createHostServer();
  let nextConnectionNumber = 1;

  return new Promise((resolve, reject) => {
    const netServer = net.createServer((socket) => {
      const clientId = `conn-${nextConnectionNumber}`;
      nextConnectionNumber += 1;
      const connection = attachStreamConnection(server, socket, socket, clientId);
      socket.on('error', (error) => logError('socket', error));
      void connection.closed.then(() => {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      });
    });

    netServer.on('error', (error) => {
      logError('listen', error);
      reject(error);
    });

    netServer.listen(socketPath, () => {
      // Same-user only: the daemon owns this machine's ~/.orchid state.
      try {
        fs.chmodSync(socketPath, SOCKET_MODE);
      } catch (error) {
        logError('chmod', error);
      }
      resolve(netServer);
    });
  });
}

/**
 * Spawn-detached (the classic double-fork equivalent on POSIX): the child runs
 * in its own process group with all stdio ignored and is unref'd, so it
 * survives the parent's exit and never blocks it. Injectable spawn for tests.
 */
export function spawnDetachedChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  spawnFn: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
): ChildProcess {
  const child = spawnFn(command, args, {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return child;
}

export interface DetachedServeOptions {
  /**
   * Absolute path of the runnable entrypoint to re-spawn (the CLI bundle).
   * Only the parent path uses it; the child runs `serve` directly.
   */
  readonly entryPath: string;
  /** Foreground serve the detached child runs; never called in the parent. */
  readonly serve: (socketPath: string) => Promise<unknown> | unknown;
  /** Spawn target override (tests); defaults to `process.execPath <entryPath>`. */
  readonly spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly env?: NodeJS.ProcessEnv;
  /** Exit hook override (tests); the parent exits 0 right after spawning. */
  readonly exit?: (code: number) => void;
}

/**
 * `serve --socket <path> --detached` (U10): daemonize the serve command so a
 * one-shot `ssh <host> orchid-agent serve --socket ~/.orchid/daemon.sock
 * --detached` returns immediately while the daemon keeps serving the socket.
 *
 * - Child re-entry (env marker set): run `serve` in the foreground.
 * - Parent: spawn the detached child (stdio ignored, new process group,
 *   unref'd), report its pid on stderr, and exit 0 without initializing the
 *   runtime — the whole point is that the parent does no work.
 */
export async function serveSocketDetached(
  socketPath: string,
  options: DetachedServeOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  if (env[DETACHED_SERVE_ENV] === '1') {
    await options.serve(socketPath);
    return;
  }
  const child = spawnDetachedChild(
    process.execPath,
    [options.entryPath, 'serve', '--socket', socketPath, '--detached'],
    { ...env, [DETACHED_SERVE_ENV]: '1' },
    options.spawnFn,
  );
  process.stderr.write(`orchid-agent daemon started detached (pid ${child.pid ?? '?'}) on ${socketPath}\n`);
  (options.exit ?? ((code: number) => {
    process.exitCode = code;
  }))(0);
}

/**
 * `bridge <socketPath>`: connect to a running daemon socket and pipe the
 * process's stdio to it in both directions. Exits non-zero with an
 * actionable message when the daemon is not listening.
 */
export async function bridgeStdioToSocket(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(socketPath);

    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Cannot connect to the orchid-agent daemon socket at ${socketPath} (${message}). ` +
          `Is \`orchid-agent serve --socket ${socketPath}\` running?`,
      );
      process.exitCode = 1;
      reject(error);
    };

    socket.once('error', fail);
    socket.once('connect', () => {
      socket.removeListener('error', fail);
      socket.on('error', (error) => logError('bridge', error));

      process.stdin.pipe(socket);
      socket.pipe(process.stdout);

      const finish = () => {
        try {
          socket.end();
        } catch {
          // already gone
        }
        resolve();
      };
      process.stdin.once('end', finish);
      process.stdin.once('error', (error) => {
        logError('bridge-stdin', error);
        finish();
      });
      socket.once('close', () => resolve());
    });
  });
}
