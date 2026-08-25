/**
 * SSH transport for remote machines (issue #112, plan unit U7).
 *
 * Spawns the system `ssh` binary with an app-managed per-machine known-hosts
 * file (`StrictHostKeyChecking=yes`, `BatchMode=yes` — key/agent auth only, no
 * passwords) and runs `<agentCommand> bridge ~/.orchid/daemon.sock` on the
 * remote. Stdio carries newline-delimited JSON frames decoded by
 * `shared/host/framing`.
 *
 * Tests never spawn real ssh: `spawnFn` and `commandFactory` are injectable so
 * a fixture Node bridge child can stand in for the ssh process.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { parse as shellParse } from 'shell-quote';
import { createFrameDecoder } from '../../shared/host/framing';
import type { StructuredHostTransport } from '../host/transport';
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

/**
 * HostTransport plus the structured frame seam (review fix #18): decoded
 * frames cross to the host client as objects — no stringify/parse round-trip
 * on the per-event hot path — while the line path stays available for legacy
 * line consumers (the connection manager's handshake sniffer).
 *
 * Formally extends only the local HostTransport (whose onClose carries the
 * child's exit code, so multi-inheriting StructuredHostTransport would
 * conflict); the underscored assertion below keeps the structured members
 * pinned to that interface at compile time instead.
 */
export interface SshTransport extends HostTransport {
  /** Send one already-decoded frame (request) to the daemon. */
  writeFrame(frame: unknown): void;
  /** Register a receiver for already-decoded frames from the daemon. */
  onFrame(cb: (frame: unknown) => void): void;
  /** Last ~50 stderr lines (plus `[framing] …` notes), oldest first. */
  recentStderr(): string[];
}

/** Interface-only assertion helper: `U` must extend `T` or tsc fails here. */
type _RequireExtends<T, _U extends T> = true;

/** SshTransport must satisfy StructuredHostTransport (host/transport.ts). */
type _SshTransportSatisfiesStructured = _RequireExtends<StructuredHostTransport, SshTransport>;

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

/**
 * Typed rejection for a machine `agentCommand` that is not a sequence of safe
 * plain tokens. This is the enforcement point for remote-command injection:
 * ssh re-joins everything after `--` with spaces and hands it to the remote
 * login shell, so any shell metacharacter surviving in a token would execute
 * there. (The registry's schema validation is a second, earlier layer.)
 */
export class MachineAgentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineAgentCommandError';
  }
}

/**
 * Characters allowed in one agentCommand token. shell-quote already strips
 * quoting, so every character left in a token is literal — anything outside
 * this set (backticks, `$`, spaces, `;`, `&`, `|`, `<`, `>`, `\`, parens, glob
 * wildcards, …) would pass straight through to the remote login shell. `~` is
 * deliberately allowed: tilde expansion on the remote is the only way to
 * address the remote user's home directory, which this machine cannot assume
 * to know, and a tilde alone cannot inject shell syntax.
 */
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/** First character of a token that the safe pattern rejects. */
const UNSAFE_TOKEN_CHAR = /[^A-Za-z0-9_@%+=:,./~-]/;

/** Human description of a non-string shell-quote parse node. */
function describeShellNode(node: unknown): string {
  if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    if (typeof record.pattern === 'string') return record.pattern;
    if (typeof record.op === 'string') return record.op;
    if (typeof record.comment === 'string') return `#${record.comment}`;
  }
  return String(node);
}

/** Reject one token that carries shell metacharacters, naming the character. */
function rejectUnsafeToken(command: string, token: string): never {
  const invalid = UNSAFE_TOKEN_CHAR.exec(token)?.[0] ?? '';
  throw new MachineAgentCommandError(
    `Machine agentCommand '${command}' contains the shell metacharacter '${invalid}' in token '${token}'; ` +
      'only plain command tokens (letters, digits, and _ @ % + = : , . / ~ -) are allowed. ' +
      'ssh re-joins the command with spaces for the remote login shell, so metacharacters would run there.',
  );
}

/**
 * Split a machine's `agentCommand` into argv tokens. Everything after ssh's
 * `--` is re-joined with spaces and parsed by the remote login shell, so this
 * fail-closed guard rejects anything that is not one-or-more plain string
 * tokens free of shell metacharacters (operator nodes throw; tokens must match
 * {@link SAFE_TOKEN_PATTERN}). Simple multi-token commands
 * (`orchid-agent --foo bar`) keep working.
 */
export function splitAgentCommand(command: string): string[] {
  const tokens: string[] = [];
  for (const part of shellParse(command)) {
    if (typeof part !== 'string') {
      // Operator nodes (`;`, `|`, `&&`, `(`, `)`, glob patterns, comments, …)
      // are shell syntax, never a literal command token.
      throw new MachineAgentCommandError(
        `Machine agentCommand '${command}' contains shell syntax ('${describeShellNode(part)}'); ` +
          'only plain command tokens are allowed.',
      );
    }
    if (part === '') continue;
    if (!SAFE_TOKEN_PATTERN.test(part)) rejectUnsafeToken(command, part);
    tokens.push(part);
  }
  if (tokens.length === 0) {
    throw new Error(`Machine agentCommand '${command}' produced no shell tokens`);
  }
  return tokens;
}

/**
 * Default remote daemon socket the app targets for the bridge command and
 * ensures via `serve --detached` (U10). Literal tilde on purpose: the remote
 * login shell expands it to the remote user's home, which this machine cannot
 * assume to know.
 */
export const REMOTE_DAEMON_SOCKET_PATH = '~/.orchid/daemon.sock';

/**
 * Typed rejection for a machine `host`/`user` pair whose assembled `[user@]host`
 * destination token OpenSSH would not read as a destination. This is the
 * enforcement point for destination injection: ssh parses any argument
 * starting with `-` as an option — e.g. `-oProxyCommand=cmd` executes `cmd`
 * locally during connection setup, BEFORE host-key checking — so the token
 * must be fail-closed even though the shared record schema (and the registry
 * behind it) rejects these earlier.
 */
export class MachineDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineDestinationError';
  }
}

/**
 * Quote one `-o` option value for OpenSSH's own config-line parser: ssh
 * tokenizes each `-o` argument itself and strips matching double quotes
 * (ssh_config quoting rules), so a value containing spaces — e.g. a home
 * directory like `/Users/my name/` — must be embedded as `Keyword="value"`
 * inside the single argv element. spawn never re-splits argv (there is no
 * shell); an unquoted space would either truncate the value or make older
 * ssh builds reject the option outright. A value containing a literal `"`
 * cannot be expressed — ssh then fails closed on the malformed option.
 */
function sshOptionValue(value: string): string {
  return `"${value}"`;
}

/**
 * Fail closed on a destination OpenSSH would parse as anything but
 * `[user@]host`: a leading `-` turns the token into an option (see
 * {@link MachineDestinationError}), a host segment starting with `-` mangles
 * the same way once the user prefix is absent, and a second `@`, `#`, or
 * whitespace re-splits or mangles the user/host boundary.
 */
function assertSafeDestination(machine: MachineRecord, destination: string): void {
  const atCount = (destination.match(/@/g) ?? []).length;
  const host = destination.includes('@')
    ? destination.slice(destination.indexOf('@') + 1)
    : destination;
  if (destination.startsWith('-') || host.startsWith('-') || atCount > 1 || /[\s#]/.test(destination)) {
    throw new MachineDestinationError(
      `Machine '${machine.id}' has an unsafe ssh destination '${destination}': neither the token ` +
        'nor its host segment may start with "-", and it must not contain whitespace, "#", or more ' +
        'than one "@" — ssh would parse the token as options instead of a host.',
    );
  }
}

/**
 * Shared ssh hardening + destination argv (everything before `--`):
 *
 * `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="<path>"
 * -o GlobalKnownHostsFile=none -o ConnectTimeout=10 -o ServerAliveInterval=15
 * -o ServerAliveCountMax=3 [-p port] [user@]host`
 *
 * The port flag and user prefix are emitted only for non-default values.
 */
function buildSshBaseArgv(machine: MachineRecord, knownHostsPath: string): string[] {
  if (machine.kind !== 'ssh') {
    throw new Error(`Machine '${machine.id}' is not an SSH remote`);
  }
  const destination = machine.user === '' ? machine.host : `${machine.user}@${machine.host}`;
  // Defense in depth: the record schema rejects these first, but a record
  // that bypassed validation (hand-edited state, future call sites) must
  // never reach spawn.
  assertSafeDestination(machine, destination);
  const argv = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    // One argv element; ssh strips the quotes when parsing the option value.
    `UserKnownHostsFile=${sshOptionValue(knownHostsPath)}`,
    // The per-machine pin file must be the only trust source: a system-wide
    // (/etc/ssh/ssh_known_hosts) key must never satisfy host-key checking.
    '-o',
    'GlobalKnownHostsFile=none',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    // Detect half-open connections (NAT/firewall drops): without keepalives a
    // dropped ssh bridge hangs forever and requests never time out.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];
  if (machine.port !== 22) {
    argv.push('-p', String(machine.port));
  }
  argv.push(destination);
  return argv;
}

/**
 * Build the ssh argv for one machine's stdio bridge:
 *
 * `ssh <hardening> [user@]host -- <agentCommand…> bridge ~/.orchid/daemon.sock`
 *
 * The socket path argument is required by the remote `bridge` command (the
 * literal tilde is expanded by the remote login shell) — without it every
 * remote connect exits 1 and gets misclassified.
 */
export function buildSshCommand(machine: MachineRecord, knownHostsPath: string): string[] {
  if (machine.kind !== 'ssh') {
    throw new Error(`Machine '${machine.id}' is not an SSH remote`);
  }
  return [
    ...buildSshBaseArgv(machine, knownHostsPath),
    '--',
    ...splitAgentCommand(machine.agentCommand),
    'bridge',
    REMOTE_DAEMON_SOCKET_PATH,
  ];
}

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
  /**
   * Exit code that maps to this classification even without matching stderr.
   * ssh forwards the remote command's exit status, so app-owned remote
   * commands can report dedicated codes.
   */
  readonly exitCode?: number;
}

/**
 * Exit code the remote `orchid-agent bridge` reports when it cannot connect
 * to the daemon socket — the daemon is down (set by `bridgeStdioToSocket` in
 * `host/daemon.ts`). Classifies the failure as agent-missing so the
 * connection manager's daemon-ensure cycle arms and spawns
 * `serve --detached`. Mirrored literal, twin of daemon.ts
 * `BRIDGE_DAEMON_SOCKET_EXIT_CODE`: the daemon graph must never import this
 * module (see `DEFAULT_DAEMON_SOCKET_PATH` there).
 */
export const BRIDGE_DAEMON_SOCKET_EXIT_CODE = 3;

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
    exitCode: 127,
    message: 'The remote bridge command was not found on the host.',
    hint: 'Install orchid-agent on the remote (it must be on the non-interactive PATH) and check the machine agent command.',
  },
  {
    // The `orchid-agent bridge` refusal when the daemon socket is down:
    // ECONNREFUSED for a dead daemon, ENOENT when none was ever started.
    // ssh itself connected fine, so this is a missing agent, not an
    // unreachable host — the daemon-ensure cycle arms on this classification.
    kind: 'agent-missing',
    pattern: /Cannot connect to the orchid-agent daemon socket[^\n]*(?:ECONNREFUSED|ENOENT)/i,
    exitCode: BRIDGE_DAEMON_SOCKET_EXIT_CODE,
    message: 'The remote orchid-agent daemon is not running.',
    hint: 'The app will start it with `orchid-agent serve --socket ~/.orchid/daemon.sock --detached` and retry; if it keeps failing, run that command on the remote and check its ~/.orchid/logs.',
  },
];

/** Excerpt tail length included in the `unknown` classification hint. */
const UNKNOWN_HINT_EXCERPT_CHARS = 300;

/**
 * Classify an ssh exit from its code and a stderr excerpt. Text patterns take
 * precedence; the dedicated exit codes (127 = remote command not found, the
 * bridge's socket-refusal code = daemon down) are the code-level fallback
 * when the stderr text was lost.
 */
export function parseSshExit(code: number | null, stderrExcerpt: string): SshExitClassification {
  for (const entry of SSH_EXIT_PATTERNS) {
    if (entry.pattern.test(stderrExcerpt)) {
      return { kind: entry.kind, message: entry.message, hint: entry.hint };
    }
  }
  const byExitCode =
    code === null ? undefined : SSH_EXIT_PATTERNS.find((entry) => entry.exitCode === code);
  if (byExitCode !== undefined) {
    return { kind: byExitCode.kind, message: byExitCode.message, hint: byExitCode.hint };
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
 * Spawn the ssh transport for one machine. Stdout frames are decoded once and
 * delivered as objects through the structured seam (`onFrame`), falling back
 * to one JSON line per frame for legacy `onData` consumers; framing
 * violations fail closed by killing the child (a hostile peer cannot grow the
 * buffer).
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
  const frameCallbacks: Array<(frame: unknown) => void> = [];
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

  /**
   * One decoded frame reaches its consumer without a JSON round-trip (review
   * fix #18): a structured `onFrame` consumer (the host client) receives the
   * decoded object directly; only when no structured consumer is installed
   * is the frame re-encoded as one JSON line for legacy `onData` consumers
   * (the connection manager's handshake sniffer, which settles before a
   * client ever attaches).
   */
  const deliverFrame = (frame: unknown): void => {
    if (frameCallbacks.length > 0) {
      for (const cb of frameCallbacks) cb(frame);
      return;
    }
    const line = JSON.stringify(frame);
    for (const cb of dataCallbacks) cb(line);
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
      deliverFrame(frame);
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
    // ── Structured seam: decoded objects cross without a JSON round-trip ─────
    writeFrame(frame: unknown): void {
      if (closed || child.stdin === null) return;
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    onFrame(cb: (frame: unknown) => void): void {
      frameCallbacks.push(cb);
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
