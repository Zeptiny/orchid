/**
 * Machine connection manager (issue #112, plan unit U7).
 *
 * Owns the per-machine connection lifecycle over the SSH transport:
 * offline → connecting → connected, with unexpected transport loss moving to
 * `lost` and scheduling exponential-backoff reconnects. Connection requires a
 * pinned known-hosts file (TOFU — `host-key.ts` must pin before connect).
 *
 * Handshake detection: after spawning the transport the manager sends one
 * `host.hello` request and waits for the response with the matching id
 * (`shared/host/protocol`). A response proves the remote `orchid-agent bridge`
 * attached to a running daemon; reaching the handshake timeout without a
 * close (or a command-not-found exit) means the remote agent/daemon is not
 * answering.
 *
 * Daemon ensure (U10): the bridge protocol is request/response NDJSON over the
 * single stdio channel, so an interactive second command cannot run inside the
 * bridge session. Instead, on an agent-missing handshake failure the manager
 * closes the failed transport, runs ONE one-shot ssh command
 * (`<agentCommand> serve --socket ~/.orchid/daemon.sock --detached` — the
 * remote daemonizes, the ssh command returns immediately), waits briefly for
 * the socket to bind, then retries the normal bridge handshake on a fresh
 * transport. If that still gets no answer the failure is classified
 * agent-missing with the install hint. At most one ensure per connect cycle
 * (armed on every manual connect and re-armed after a successful connection,
 * so the backoff reconnect loop never hammers the remote).
 */
import * as fs from 'node:fs';
import {
  HOST_HELLO_METHOD,
  PROTOCOL_VERSION,
  hostHelloResultSchema,
  isHostResponse,
} from '../../shared/host/protocol';
import { knownHostsPath } from './host-key';
import {
  parseSshExit,
  spawnDaemonEnsure,
  spawnSshTransport,
  type HostTransport,
  type SshExitKind,
} from './ssh-transport';
import type { MachineRecord, RemoteMachineRecord } from '../../shared/types/machine';

/** Handshake deadline before declaring the remote agent missing. */
export const HANDSHAKE_TIMEOUT_MS = 20_000;

/** First reconnect delay; doubles per attempt up to RECONNECT_MAX_DELAY_MS. */
export const RECONNECT_INITIAL_DELAY_MS = 1_000;

/** Backoff cap per attempt. */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** Consecutive reconnect attempts before giving up (state stays `lost`). */
export const RECONNECT_MAX_ATTEMPTS = 5;

/**
 * A connection must stay up this long before the attempt counter resets, so a
 * daemon that handshakes then immediately dies cannot reset the backoff and
 * loop forever.
 */
export const RECONNECT_RESET_AFTER_MS = 30_000;

/**
 * Grace period between the one-shot `serve --detached` command returning and
 * the reconnect handshake, letting the freshly daemonized daemon bind its
 * socket.
 */
export const DAEMON_ENSURE_SETTLE_MS = 1_000;

export type MachineConnectionState = 'offline' | 'connecting' | 'connected' | 'lost';

export type MachineConnectionErrorKind =
  | SshExitKind
  | 'host-key-not-pinned'
  | 'protocol-mismatch'
  | 'handshake-failed'
  | 'transport-closed';

/** Typed connect failure carrying an actionable hint for the UI. */
export class MachineConnectionError extends Error {
  readonly kind: MachineConnectionErrorKind;
  readonly hint: string;

  constructor(kind: MachineConnectionErrorKind, message: string, hint = '') {
    super(message);
    this.name = 'MachineConnectionError';
    this.kind = kind;
    this.hint = hint;
  }
}

export interface MachineConnectionStatus {
  readonly machineId: string;
  readonly state: MachineConnectionState;
  readonly error: MachineConnectionError | null;
  /** Reconnect attempts since the last reset (success or manual connect). */
  readonly reconnectAttempts: number;
}

export type MachineStatusListener = (status: MachineConnectionStatus) => void;

/** HostTransport plus the optional stderr excerpt used for classification. */
export type MachineTransport = HostTransport & { recentStderr?(): string[] };

export type MachineTransportFactory = (machine: RemoteMachineRecord) => MachineTransport;

export interface MachineConnectionBackoff {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
  readonly resetAfterMs: number;
}

/**
 * One daemon-ensure cycle: run the one-shot
 * `serve --socket ~/.orchid/daemon.sock --detached` ssh command for the
 * machine. Resolves true when the remote accepted the command (ssh exit 0).
 * Injectable for tests.
 */
export type DaemonEnsureFn = (
  machine: RemoteMachineRecord,
  knownHostsPath: string,
) => Promise<boolean>;

export interface MachineConnectionManagerOptions {
  /** Base dir for known-hosts paths (tests); defaults to `~/.orchid`. */
  readonly homeDir?: string;
  readonly transportFactory?: MachineTransportFactory;
  /** Injectable backoff sleep (tests resolve it manually). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly handshakeTimeoutMs?: number;
  readonly backoff?: Partial<MachineConnectionBackoff>;
  /** Injectable daemon ensure (tests); defaults to the one-shot serve command. */
  readonly ensureDaemon?: DaemonEnsureFn;
  /** Settle delay after the ensure command before retrying the handshake. */
  readonly ensureSettleMs?: number;
}

interface MachineEntry {
  machine: RemoteMachineRecord;
  state: MachineConnectionState;
  error: MachineConnectionError | null;
  reconnectAttempts: number;
  transport: MachineTransport | null;
  connecting: Promise<MachineConnectionStatus> | null;
  /** Bumped by manual connect/disconnect to cancel in-flight reconnect loops. */
  generation: number;
  resetTimer: NodeJS.Timeout | null;
  /** True once this connect cycle already ran its one daemon-ensure attempt. */
  daemonEnsured: boolean;
}

/** Discriminated daemon-ensure cycle outcome (see ensureDaemonAndRetry). */
type EnsureOutcome =
  | { kind: 'no-retry' }
  | { kind: 'ensure-failed'; error: MachineConnectionError }
  | { kind: 'retry-failed'; error: MachineConnectionError }
  | { kind: 'retry-connected'; transport: MachineTransport };

/**
 * Per-machine connection state machine. All spawns happen through the
 * transport factory (default: the real SSH transport against the machine's
 * pinned known-hosts file).
 */
export class MachineConnectionManager {
  private readonly entries = new Map<string, MachineEntry>();
  private readonly listeners = new Map<string, Set<MachineStatusListener>>();
  private readonly transportFactory: MachineTransportFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly handshakeTimeoutMs: number;
  private readonly backoff: MachineConnectionBackoff;
  private readonly ensureDaemon: DaemonEnsureFn;
  private readonly ensureSettleMs: number;
  private readonly homeDir: string | undefined;
  private requestSeq = 0;

  constructor(options: MachineConnectionManagerOptions = {}) {
    this.homeDir = options.homeDir;
    this.transportFactory =
      options.transportFactory ??
      ((machine) =>
        spawnSshTransport(machine, {
          knownHostsPath: knownHostsPath(machine.id, this.homeDir),
        }));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.ensureDaemon =
      options.ensureDaemon ?? ((machine, hostsPath) => spawnDaemonEnsure(machine, { knownHostsPath: hostsPath }));
    this.ensureSettleMs = options.ensureSettleMs ?? DAEMON_ENSURE_SETTLE_MS;
    this.backoff = {
      initialMs: options.backoff?.initialMs ?? RECONNECT_INITIAL_DELAY_MS,
      maxMs: options.backoff?.maxMs ?? RECONNECT_MAX_DELAY_MS,
      maxAttempts: options.backoff?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS,
      resetAfterMs: options.backoff?.resetAfterMs ?? RECONNECT_RESET_AFTER_MS,
    };
  }

  // ── Status + subscriptions ────────────────────────────────────────────────

  /** Current status; machines never connected report `offline`. */
  getStatus(machineId: string): MachineConnectionStatus {
    const entry = this.entries.get(machineId);
    return entry === undefined
      ? { machineId, state: 'offline', error: null, reconnectAttempts: 0 }
      : this.statusOf(entry);
  }

  /**
   * Subscribe to status changes for one machine, or `'*` for every machine.
   * Returns an unsubscribe function. Notified on every state transition.
   */
  subscribe(machineId: string, listener: MachineStatusListener): () => void {
    let set = this.listeners.get(machineId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(machineId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** The live transport for a connected machine; null otherwise. */
  getTransport(machineId: string): HostTransport | null {
    const entry = this.entries.get(machineId);
    return entry !== undefined && entry.state === 'connected' ? entry.transport : null;
  }

  // ── Connect / disconnect ──────────────────────────────────────────────────

  /**
   * Connect one SSH machine: verify pinned host keys, spawn the transport,
   * complete the `host.hello` handshake, then report `connected`.
   *
   * Idempotent: concurrent calls share one attempt, and a call while connected
   * returns immediately. Rejects with `MachineConnectionError` on failure
   * (state becomes `lost`); the local machine rejects outright — it connects
   * in-process, not over SSH.
   */
  async connect(machine: MachineRecord): Promise<MachineConnectionStatus> {
    if (machine.kind !== 'ssh') {
      throw new Error(`Machine '${machine.id}' is local and connects in-process, not over SSH`);
    }
    const entry = this.ensureEntry(machine);
    entry.machine = machine;
    if (entry.state === 'connected') return this.statusOf(entry);
    if (entry.connecting !== null) return entry.connecting;

    entry.generation += 1;
    entry.reconnectAttempts = 0;
    // A manual connect starts a fresh connect cycle: the daemon-ensure budget
    // re-arms so an explicit retry can attempt to start the daemon again.
    entry.daemonEnsured = false;
    return this.startConnection(entry, entry.generation);
  }

  /** Close the transport and go `offline`; cancels any pending reconnect. */
  disconnect(machineId: string): void {
    const entry = this.entries.get(machineId);
    if (entry === undefined) return;
    entry.generation += 1;
    this.clearAttemptReset(entry);
    const transport = entry.transport;
    entry.transport = null;
    if (entry.state !== 'offline') this.transition(entry, 'offline');
    transport?.close();
  }

  /** Disconnect every machine. */
  disconnectAll(): void {
    for (const machineId of [...this.entries.keys()]) {
      this.disconnect(machineId);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private ensureEntry(machine: RemoteMachineRecord): MachineEntry {
    let entry = this.entries.get(machine.id);
    if (entry === undefined) {
      entry = {
        machine,
        state: 'offline',
        error: null,
        reconnectAttempts: 0,
        transport: null,
        connecting: null,
        generation: 0,
        resetTimer: null,
        daemonEnsured: false,
      };
      this.entries.set(machine.id, entry);
    }
    return entry;
  }

  private statusOf(entry: MachineEntry): MachineConnectionStatus {
    return {
      machineId: entry.machine.id,
      state: entry.state,
      error: entry.error,
      reconnectAttempts: entry.reconnectAttempts,
    };
  }

  private transition(
    entry: MachineEntry,
    state: MachineConnectionState,
    error: MachineConnectionError | null = null,
  ): void {
    if (state !== 'connecting') this.clearAttemptReset(entry);
    if (state === 'connected') {
      this.scheduleAttemptReset(entry);
      // A healthy connection closes the connect cycle: the daemon-ensure
      // budget re-arms so a later drop may attempt to start the daemon again.
      entry.daemonEnsured = false;
    }
    entry.state = state;
    if (state === 'lost') {
      entry.error = error;
    } else if (state === 'offline') {
      entry.error = null;
    }
    this.notify(entry);
  }

  private notify(entry: MachineEntry): void {
    const status = this.statusOf(entry);
    for (const listener of this.listeners.get(entry.machine.id) ?? []) {
      listener(status);
    }
    for (const listener of this.listeners.get('*') ?? []) {
      listener(status);
    }
  }

  private scheduleAttemptReset(entry: MachineEntry): void {
    this.clearAttemptReset(entry);
    if (this.backoff.resetAfterMs <= 0) {
      entry.reconnectAttempts = 0;
      return;
    }
    const timer = setTimeout(() => {
      entry.resetTimer = null;
      if (entry.state === 'connected') entry.reconnectAttempts = 0;
    }, this.backoff.resetAfterMs);
    timer.unref?.();
    entry.resetTimer = timer;
  }

  private clearAttemptReset(entry: MachineEntry): void {
    if (entry.resetTimer !== null) {
      clearTimeout(entry.resetTimer);
      entry.resetTimer = null;
    }
  }

  /**
   * Start one connection attempt and register it as the machine's in-flight
   * attempt, so concurrent `connect()` calls (including one arriving during an
   * auto-reconnect) share it instead of racing a second transport.
   */
  private startConnection(
    entry: MachineEntry,
    generation: number,
  ): Promise<MachineConnectionStatus> {
    const attempt = this.attemptConnection(entry, generation);
    const tracked = attempt.then(
      (status) => {
        if (entry.connecting === tracked) entry.connecting = null;
        return status;
      },
      (error: unknown) => {
        if (entry.connecting === tracked) entry.connecting = null;
        throw error;
      },
    );
    entry.connecting = tracked;
    return tracked;
  }

  /**
   * One connection attempt: pinned-key gate → transport spawn → handshake.
   * On an agent-missing handshake failure the daemon-ensure cycle runs once
   * per connect cycle (fresh transport + handshake retry). Resolves with the
   * connected status or rejects with the typed error (state left `lost`,
   * unless the machine was disconnected/superseded meanwhile).
   */
  private async attemptConnection(
    entry: MachineEntry,
    generation: number,
  ): Promise<MachineConnectionStatus> {
    this.transition(entry, 'connecting');

    // Kill any leftover transport from a superseded attempt — never leak children.
    const stale = entry.transport;
    entry.transport = null;
    stale?.close();

    const hostsPath = knownHostsPath(entry.machine.id, this.homeDir);
    if (!fs.existsSync(hostsPath)) {
      const error = new MachineConnectionError(
        'host-key-not-pinned',
        `No pinned host keys for machine '${entry.machine.id}' (${entry.machine.host}).`,
        'Re-add the machine to scan and confirm its host-key fingerprint before connecting.',
      );
      this.transition(entry, 'lost', error);
      throw error;
    }

    let transport = this.transportFactory(entry.machine);
    entry.transport = transport;
    this.watchTransport(entry, transport, generation);

    try {
      await this.handshake(transport);
    } catch (error) {
      transport.close();
      if (entry.transport === transport) entry.transport = null;
      if (entry.state !== 'connecting') throw error;

      const outcome = await this.ensureDaemonAndRetry(entry, generation, error, hostsPath);
      if (outcome.kind === 'no-retry') {
        // No ensure cycle ran — classify exactly as before.
        const typed =
          error instanceof MachineConnectionError
            ? error
            : new MachineConnectionError('unknown', String(error));
        this.transition(entry, 'lost', typed);
        throw error;
      }
      if (outcome.kind === 'ensure-failed') {
        this.transition(entry, 'lost', outcome.error);
        throw outcome.error;
      }
      if (outcome.kind === 'retry-failed') {
        // The retry transport got no usable answer: the ensured daemon did not
        // come up (a real hello answer keeps its own classification).
        const typed = this.classifyPostEnsureFailure(entry.machine, outcome.error);
        this.transition(entry, 'lost', typed);
        throw typed;
      }
      // retry-connected: the retry transport owns the connection from here.
      transport = outcome.transport;
    }

    if (entry.state !== 'connecting') {
      // Disconnected while the handshake was in flight — abandon silently.
      if (entry.transport === transport) entry.transport = null;
      transport.close();
      throw new MachineConnectionError(
        'transport-closed',
        'The connection attempt was cancelled.',
        'The machine was disconnected before the handshake completed.',
      );
    }

    this.transition(entry, 'connected');
    return this.statusOf(entry);
  }

  /** Register the unexpected-loss watcher for one live transport. */
  private watchTransport(
    entry: MachineEntry,
    transport: MachineTransport,
    generation: number,
  ): void {
    transport.onClose((code) => {
      // Only an established connection can be "lost"; during the handshake the
      // handshake's own close callback classifies the failure.
      if (entry.transport === transport && entry.state === 'connected') {
        this.handleUnexpectedLoss(entry, transport, code, generation);
      }
    });
  }

  /**
   * The daemon-ensure cycle (U10). Eligible only for agent-missing handshake
   * failures (ssh works, the remote agent/daemon did not answer) and at most
   * once per connect cycle. Runs the one-shot
   * `serve --socket ~/.orchid/daemon.sock --detached` ssh command, waits the
   * settle delay, then retries the bridge handshake on a fresh transport.
   */
  private async ensureDaemonAndRetry(
    entry: MachineEntry,
    generation: number,
    original: unknown,
    hostsPath: string,
  ): Promise<EnsureOutcome> {
    if (!(original instanceof MachineConnectionError) || original.kind !== 'agent-missing') {
      return { kind: 'no-retry' };
    }
    if (entry.daemonEnsured) return { kind: 'no-retry' };
    entry.daemonEnsured = true;

    let ensured: boolean;
    try {
      ensured = await this.ensureDaemon(entry.machine, hostsPath);
    } catch (error) {
      console.warn(`[machine-ensure] serve command threw for '${entry.machine.id}':`, error);
      ensured = false;
    }
    // The machine was disconnected or superseded while the one-shot command
    // ran — abandon without a state change (a newer attempt owns the entry).
    if (entry.generation !== generation || entry.state !== 'connecting') return { kind: 'no-retry' };

    if (!ensured) {
      // The ensure bought nothing (agent absent, PATH miss, ssh failure): the
      // original agent-missing classification is already the actionable one.
      return { kind: 'ensure-failed', error: original };
    }

    await this.sleep(this.ensureSettleMs);
    if (entry.generation !== generation || entry.state !== 'connecting') return { kind: 'no-retry' };

    const retryTransport = this.transportFactory(entry.machine);
    entry.transport = retryTransport;
    this.watchTransport(entry, retryTransport, generation);
    try {
      await this.handshake(retryTransport);
      return { kind: 'retry-connected', transport: retryTransport };
    } catch (error) {
      retryTransport.close();
      if (entry.transport === retryTransport) entry.transport = null;
      if (entry.state !== 'connecting') {
        return {
          kind: 'ensure-failed',
          error: new MachineConnectionError(
            'transport-closed',
            'The connection attempt was cancelled.',
            'The machine was disconnected before the handshake completed.',
          ),
        };
      }
      return {
        kind: 'retry-failed',
        error:
          error instanceof MachineConnectionError
            ? error
            : new MachineConnectionError('unknown', String(error)),
      };
    }
  }

  /**
   * Classify the handshake failure that followed a successful daemon-ensure
   * command. A real `host.hello` answer (mismatch / rejected hello) or an
   * ssh-level failure keeps its own classification — the daemon IS running.
   * Everything else means the ensured daemon still did not answer:
   * agent-missing with the install hint.
   */
  private classifyPostEnsureFailure(
    machine: RemoteMachineRecord,
    error: MachineConnectionError,
  ): MachineConnectionError {
    if (
      error.kind === 'protocol-mismatch'
      || error.kind === 'handshake-failed'
      || error.kind === 'host-key-mismatch'
      || error.kind === 'auth-failed'
      || error.kind === 'unreachable'
    ) {
      return error;
    }
    return new MachineConnectionError(
      'agent-missing',
      `Started the daemon on '${machine.label}' automatically, but its bridge still did not answer the handshake.`,
      'Check that `orchid-agent serve --socket ~/.orchid/daemon.sock` runs on the remote (see its ~/.orchid/logs), then reconnect.',
    );
  }

  /**
   * Send `host.hello` and await the response with the matching id. Reaching
   * the timeout means the transport stayed open (a close would have rejected
   * first), i.e. ssh works but no agent answered — see the module header for
   * where U10's daemon-ensure step slots in.
   */
  private handshake(transport: MachineTransport): Promise<void> {
    this.requestSeq += 1;
    const requestId = `host-hello-${this.requestSeq}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      // Referenced by `settle` before assignment below; only ever invoked
      // after the synchronous setup below completes, so the TDZ is never hit.
      const timer: NodeJS.Timeout = setTimeout(() => {
        settle(() => reject(this.classifyHandshakeTimeout(transport)));
      }, this.handshakeTimeoutMs);
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      transport.onData((line) => {
        if (settled) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isHostResponse(message) || message.id !== requestId) return;
        if (!message.ok) {
          settle(() => {
            reject(
              new MachineConnectionError(
                'handshake-failed',
                `host.hello was rejected by the remote: ${message.error.message}`,
              ),
            );
          });
          return;
        }
        const parsed = hostHelloResultSchema.safeParse(message.result);
        if (!parsed.success) {
          settle(() => {
            reject(
              new MachineConnectionError(
                'handshake-failed',
                `host.hello returned an invalid result: ${parsed.error.message}`,
              ),
            );
          });
          return;
        }
        if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
          settle(() => {
            reject(
              new MachineConnectionError(
                'protocol-mismatch',
                `Protocol version mismatch: app speaks ${PROTOCOL_VERSION}, remote offers ${parsed.data.protocolVersion}.`,
                'Update orchid-agent on the remote machine to a version matching the app.',
              ),
            );
          });
          return;
        }
        settle(() => resolve());
      });

      transport.onClose((code) => {
        settle(() => reject(this.classifyTransportFailure(transport, code)));
      });

      transport.write(
        JSON.stringify({
          id: requestId,
          method: HOST_HELLO_METHOD,
          params: { protocolVersion: PROTOCOL_VERSION },
        }),
      );
    });
  }

  /** Map a closed transport onto a typed error using exit code + stderr. */
  private classifyTransportFailure(
    transport: MachineTransport,
    code: number | null,
  ): MachineConnectionError {
    const stderr = transport.recentStderr?.().join('\n') ?? '';
    const classification = parseSshExit(code, stderr);
    if (classification.kind !== 'unknown') {
      return new MachineConnectionError(classification.kind, classification.message, classification.hint);
    }
    if (code === 0) {
      return new MachineConnectionError(
        'transport-closed',
        'The connection to the remote host closed.',
        'The remote daemon may have exited; reconnect will be attempted.',
      );
    }
    return new MachineConnectionError('unknown', classification.message, classification.hint);
  }

  private classifyHandshakeTimeout(transport: MachineTransport): MachineConnectionError {
    const stderr = transport.recentStderr?.().join('\n') ?? '';
    const classification = parseSshExit(null, stderr);
    if (classification.kind !== 'unknown') {
      return new MachineConnectionError(classification.kind, classification.message, classification.hint);
    }
    return new MachineConnectionError(
      'agent-missing',
      `No host.hello response within ${Math.round(this.handshakeTimeoutMs / 1000)}s; the remote agent is likely not installed or its daemon is not running.`,
      'Install orchid-agent on the remote and run `orchid-agent serve --socket ~/.orchid/daemon.sock`.',
    );
  }

  /** Unexpected close of an established connection: lost + backoff reconnect. */
  private handleUnexpectedLoss(
    entry: MachineEntry,
    transport: MachineTransport,
    code: number | null,
    generation: number,
  ): void {
    if (entry.transport !== transport) return;
    entry.transport = null;
    this.transition(entry, 'lost', this.classifyTransportFailure(transport, code));
    void this.reconnectLoop(entry, generation).catch(() => {
      // Loop cancellation surfaces through state, not rejections.
    });
  }

  private reconnectDelay(attemptsMade: number): number {
    const { initialMs, maxMs } = this.backoff;
    return Math.min(initialMs * 2 ** attemptsMade, maxMs);
  }

  /**
   * Reconnect cycle after unexpected loss: up to maxAttempts backoff retries
   * (each retry is a full runConnection), giving up once the machine stays
   * `lost`. A manual connect/disconnect bumps the generation and ends the
   * loop at the next checkpoint.
   */
  private async reconnectLoop(entry: MachineEntry, generation: number): Promise<void> {
    while (
      entry.generation === generation &&
      entry.state === 'lost' &&
      entry.reconnectAttempts < this.backoff.maxAttempts
    ) {
      const delay = this.reconnectDelay(entry.reconnectAttempts);
      entry.reconnectAttempts += 1;
      await this.sleep(delay);
      if (entry.generation !== generation || entry.state !== 'lost') return;
      try {
        await this.startConnection(entry, entry.generation);
        return;
      } catch {
        // Attempt failed; state is already `lost` — keep backing off.
      }
    }
  }
}

let manager: MachineConnectionManager | null = null;

/** Process-wide machine connection manager. */
export function getMachineConnectionManager(): MachineConnectionManager {
  if (manager === null) {
    manager = new MachineConnectionManager();
  }
  return manager;
}

/** Disconnect everything and drop the process-wide manager. For tests. */
export function _resetMachineConnectionManagerForTests(): void {
  manager?.disconnectAll();
  manager = null;
}
