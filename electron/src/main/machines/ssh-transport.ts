/**
 * SSH transport for remote machines (issue #112, plan unit U7).
 *
 * Spawns the system `ssh` binary with an app-managed per-machine known-hosts
 * file (`StrictHostKeyChecking=yes`, `BatchMode=yes` — key/agent auth only, no
 * passwords) and runs `<agentCommand> bridge` on the remote. Stdio carries
 * newline-delimited JSON frames decoded by `shared/host/framing`.
 *
 * Tests never spawn real ssh: `spawnFn` and `commandFactory` are injectable so
 * a fixture Node bridge child can stand in for the ssh process.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { parse as shellParse } from 'shell-quote';
import { createFrameDecoder } from '../../shared/host/framing';
import { knownHostsPath as defaultKnownHostsPath } from './host-key';
import type { MachineRecord } from '../../shared/types/machine';

/** Connect timeout passed to ssh via `-o ConnectTimeout` (seconds). */
export const SSH_CONNECT_TIMEOUT_SECONDS = 10;

/** Ring-buffer size for the recent stderr excerpt surfaced to callers. */
export const STDERR_BUFFER_LINES = 50;

/**
 * Line-oriented transport over a spawned child's stdio (U5's host client
 * consumes this; the in-process local transport mirrors the same shape).
 */
export interface HostTransport {
  /** Write one frame; a trailing newline is appended when missing. */
  write(line: string): void;
  /** Register a callback invoked once per decoded stdout frame. */
  onData(cb: (line: string) => void): void;
  /** Register a callback invoked once when the child exits (code is null when killed). */
  onClose(cb: (code: number | null) => void): void;
  /** Kill the child process. Registered close callbacks fire with code null. */
  close(): void;
}

/** HostTransport plus the stderr excerpt the connection manager classifies. */
export interface SshTransport extends HostTransport {
  /** Last ~50 stderr lines (plus `[framing] …` notes), oldest first. */
  recentStderr(): string[];
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

/**
 * Split a machine's `agentCommand` into argv tokens using the same shell-quote
 * handling as the execute-command tool (glob objects map to their pattern).
 */
export function splitAgentCommand(command: string): string[] {
  const tokens = shellParse(command)
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null && 'op' in part) {
        return String((part as { pattern?: string }).pattern ?? part);
      }
      return String(part);
    })
    .filter((token) => token !== '');
  if (tokens.length === 0) {
    throw new Error(`Machine agentCommand '${command}' produced no shell tokens`);
  }
  return tokens;
}

/**
 * Shared ssh hardening + destination argv (everything before `--`):
 *
 * `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<path>
 * -o ConnectTimeout=10 [-p port] [user@]host`
 *
 * The port flag and user prefix are emitted only for non-default values.
 */
function buildSshBaseArgv(machine: MachineRecord, knownHostsPath: string): string[] {
  if (machine.kind !== 'ssh') {
    throw new Error(`Machine '${machine.id}' is not an SSH remote`);
  }
  const argv = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
  ];
  if (machine.port !== 22) {
    argv.push('-p', String(machine.port));
  }
  argv.push(machine.user === '' ? machine.host : `${machine.user}@${machine.host}`);
  return argv;
}

/**
 * Build the ssh argv for one machine's stdio bridge:
 *
 * `ssh <hardening> [user@]host -- <agentCommand…> bridge`
 */
export function buildSshCommand(machine: MachineRecord, knownHostsPath: string): string[] {
  if (machine.kind !== 'ssh') {
    throw new Error(`Machine '${machine.id}' is not an SSH remote`);
  }
  return [...buildSshBaseArgv(machine, knownHostsPath), '--', ...splitAgentCommand(machine.agentCommand), 'bridge'];
}

/**
 * Default remote daemon socket the app ensures via `serve --detached` (U10).
 * Literal tilde on purpose: the remote login shell expands it to the remote
 * user's home, which this machine cannot assume to know.
 */
export const REMOTE_DAEMON_SOCKET_PATH = '~/.orchid/daemon.sock';

/**
 * Build the one-shot ssh argv that starts the remote daemon detached (U10):
 *
 * `ssh <same hardening as buildSshCommand> [user@]host --
 *   <agentCommand…> serve --socket ~/.orchid/daemon.sock --detached`
 *
 * The remote `--detached` daemonizes and returns, so this ssh command exits
 * immediately instead of holding the stdio bridge channel open.
 */
export function buildSshServeCommand(machine: MachineRecord, knownHostsPath: string): string[] {
  if (machine.kind !== 'ssh') {
    throw new Error(`Machine '${machine.id}' is not an SSH remote`);
  }
  return [
    ...buildSshBaseArgv(machine, knownHostsPath),
    '--',
    ...splitAgentCommand(machine.agentCommand),
    'serve',
    '--socket',
    REMOTE_DAEMON_SOCKET_PATH,
    '--detached',
  ];
}

// ---------------------------------------------------------------------------
// Exit classification
// ---------------------------------------------------------------------------

/** Actionable ssh failure categories surfaced by the connection manager. */
export type SshExitKind =
  | 'host-key-mismatch'
  | 'auth-failed'
  | 'unreachable'
  | 'agent-missing'
  | 'unknown';

export interface SshExitClassification {
  readonly kind: SshExitKind;
  readonly message: string;
  readonly hint: string;
}

interface SshExitPattern {
  readonly kind: Exclude<SshExitKind, 'unknown'>;
  readonly pattern: RegExp;
  readonly message: string;
  readonly hint: string;
}

/** Ordered by precedence: the first matching stderr pattern wins. */
const SSH_EXIT_PATTERNS: readonly SshExitPattern[] = [
  {
    kind: 'host-key-mismatch',
    pattern: /REMOTE HOST IDENTIFICATION HAS CHANGED|OFFENDING KEY|Host key verification failed/i,
    message: 'The remote host key no longer matches the pinned known-hosts entry.',
    hint: 'Re-scan the host key (ssh-keyscan), confirm the new fingerprint, and re-pin it for this machine.',
  },
  {
    kind: 'auth-failed',
    pattern: /Permission denied|No supported authentication methods/i,
    message: 'SSH key/agent authentication failed (passwords are disabled by BatchMode).',
    hint: 'Ensure your key is authorized on the remote, is loaded into ssh-agent (ssh-add), and the machine user is correct.',
  },
  {
    kind: 'unreachable',
    pattern:
      /Connection timed out|Connection refused|Could not resolve hostname|No route to host|Network is unreachable/i,
    message: 'Could not reach the remote host over SSH.',
    hint: 'Check the host and port, that sshd is running on the remote, and network or VPN connectivity.',
  },
  {
    kind: 'agent-missing',
    pattern: /command not found/i,
    message: 'The remote bridge command was not found on the host.',
    hint: 'Install orchid-agent on the remote (it must be on the non-interactive PATH) and check the machine agent command.',
  },
];

/** Excerpt tail length included in the `unknown` classification hint. */
const UNKNOWN_HINT_EXCERPT_CHARS = 300;

/**
 * Classify an ssh exit from its code and a stderr excerpt. Text patterns take
 * precedence; exit 127 (remote command not found) is the code-level fallback.
 */
export function parseSshExit(code: number | null, stderrExcerpt: string): SshExitClassification {
  for (const entry of SSH_EXIT_PATTERNS) {
    if (entry.pattern.test(stderrExcerpt)) {
      return { kind: entry.kind, message: entry.message, hint: entry.hint };
    }
  }
  const agentMissing = SSH_EXIT_PATTERNS[3];
  if (code === 127 && agentMissing !== undefined) {
    return { kind: agentMissing.kind, message: agentMissing.message, hint: agentMissing.hint };
  }
  const excerpt = stderrExcerpt.trim().slice(-UNKNOWN_HINT_EXCERPT_CHARS);
  return {
    kind: 'unknown',
    message: `ssh exited with code ${code === null ? 'null (killed)' : code}.`,
    hint: excerpt !== '' ? excerpt : 'Inspect the machine connection stderr and retry.',
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Injectable spawn (tests substitute a fixture bridge child). */
export type SshSpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Injectable argv builder (tests replace ssh with `node <fixture>`). */
export type SshCommandFactory = (machine: MachineRecord, knownHostsPath: string) => string[];

export interface SpawnSshTransportOptions {
  readonly spawnFn?: SshSpawnFn;
  readonly commandFactory?: SshCommandFactory;
  /** Known-hosts path override; defaults to the machine's pinned file. */
  readonly knownHostsPath?: string;
  /** Frame cap forwarded to the decoder (default MAX_FRAME_BYTES). */
  readonly maxFrameBytes?: number;
}

/**
 * Spawn the ssh transport for one machine. Stdout frames are decoded and
 * re-emitted as one JSON line per frame; framing violations fail closed by
 * killing the child (a hostile peer cannot grow the buffer).
 */
export function spawnSshTransport(
  machine: MachineRecord,
  options: SpawnSshTransportOptions = {},
): SshTransport {
  const spawnFn = options.spawnFn ?? spawn;
  const commandFactory = options.commandFactory ?? buildSshCommand;
  const hostsPath = options.knownHostsPath ?? defaultKnownHostsPath(machine.id);
  const argv = commandFactory(machine, hostsPath);

  const child = spawnFn(argv[0] as string, argv.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const decoder = createFrameDecoder({ maxFrameBytes: options.maxFrameBytes });
  const dataCallbacks: Array<(line: string) => void> = [];
  const closeCallbacks: Array<(code: number | null) => void> = [];
  const stderrLines: string[] = [];
  let stderrTail = '';
  let closed = false;
  let lastCode: number | null = null;

  const pushStderrLine = (line: string): void => {
    if (line === '') return;
    stderrLines.push(line);
    if (stderrLines.length > STDERR_BUFFER_LINES) {
      stderrLines.splice(0, stderrLines.length - STDERR_BUFFER_LINES);
    }
  };

  /** Chunk-safe stderr line buffering; a dangling partial stays in the tail. */
  const recordStderr = (text: string): void => {
    if (text === '') return;
    stderrTail += text;
    const pieces = stderrTail.split('\n');
    stderrTail = pieces.pop() ?? '';
    for (const piece of pieces) pushStderrLine(piece);
  };

  const fireClose = (code: number | null): void => {
    if (closed) return;
    closed = true;
    lastCode = code;
    if (stderrTail !== '') pushStderrLine(stderrTail);
    stderrTail = '';
    for (const cb of closeCallbacks) cb(code);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      recordStderr(`[framing] ${String(error)}\n`);
      child.kill();
      return;
    }
    for (const frame of frames) {
      for (const cb of dataCallbacks) cb(JSON.stringify(frame));
    }
  });
  child.stdout?.on('end', () => {
    try {
      decoder.finish();
    } catch (error) {
      recordStderr(`[framing] ${String(error)}\n`);
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', recordStderr);

  const swallowStreamError = (): void => {};
  child.stdin?.on('error', swallowStreamError);
  child.stdout?.on('error', swallowStreamError);
  child.stderr?.on('error', swallowStreamError);

  child.on('error', (error) => {
    recordStderr(String(error));
    fireClose(null);
  });
  child.on('close', (code) => fireClose(code));

  return {
    write(line: string): void {
      if (closed || child.stdin === null) return;
      child.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
    },
    onData(cb: (line: string) => void): void {
      dataCallbacks.push(cb);
    },
    onClose(cb: (code: number | null) => void): void {
      closeCallbacks.push(cb);
      if (closed) cb(lastCode);
    },
    close(): void {
      child.kill();
    },
    recentStderr(): string[] {
      return [...stderrLines];
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon ensure (U10)
// ---------------------------------------------------------------------------

/** Ceiling for the one-shot `serve --detached` ssh command (connect + spawn). */
export const DAEMON_ENSURE_TIMEOUT_MS = 30_000;

export interface SpawnDaemonEnsureOptions {
  readonly spawnFn?: SshSpawnFn;
  readonly commandFactory?: SshCommandFactory;
  /** Known-hosts path override; defaults to the machine's pinned file. */
  readonly knownHostsPath?: string;
  /** Deadline for the one-shot ssh command (default DAEMON_ENSURE_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/**
 * Run the one-shot `serve --socket ~/.orchid/daemon.sock --detached` ssh
 * command for a machine. Resolves `true` when ssh exited 0 (the remote
 * daemonized the daemon and the command returned), `false` on a non-zero
 * exit, a spawn error, or the deadline. Never rejects.
 */
export function spawnDaemonEnsure(
  machine: MachineRecord,
  options: SpawnDaemonEnsureOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let argv: string[];
    try {
      argv = (options.commandFactory ?? buildSshServeCommand)(
        machine,
        options.knownHostsPath ?? defaultKnownHostsPath(machine.id),
      );
    } catch (error) {
      console.warn(`[machine-ensure] failed to build the serve command:`, error);
      resolve(false);
      return;
    }
    let settled = false;
    // Referenced by `finish` before assignment below; only ever invoked after
    // the synchronous setup completes, so the TDZ is never hit.
    const timer: NodeJS.Timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(false);
    }, options.timeoutMs ?? DAEMON_ENSURE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    let child: ChildProcess;
    try {
      child = (options.spawnFn ?? spawn)(argv[0] as string, argv.slice(1), {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      console.warn(`[machine-ensure] failed to spawn the serve command:`, error);
      finish(false);
      return;
    }
    // A detached remote daemon never writes stdio; drain defensively anyway so
    // a chatty ssh cannot block on full pipes before exiting.
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
