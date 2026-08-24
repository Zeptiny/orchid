/**
 * HostClient — one machine's connection handle (plan 2026-08-23-001, U5).
 *
 * Requests correlate by an auto-incrementing id; events fan out to
 * per-event subscribers while the per-connection `seq` is tracked for the
 * reconnect resync U10 builds on (`lastSeq()`).
 *
 * The handshake (`host.hello`) runs on construction and every request awaits
 * it, so a method can never arrive before the server has flipped the
 * connection's handshake gate.
 *
 * Errors: a typed {@link HostProtocolError} for protocol-level failures
 * (METHOD_NOT_FOUND, INVALID_PARAMS, PROTOCOL_MISMATCH, …) and — over an
 * in-process transport — the *original* value the binding threw, rethrown
 * verbatim (identity preserved; see `attachHostOriginalError`).
 */
import {
  HOST_ERROR_CODES,
  HOST_EVENTS,
  HOST_HELLO_METHOD,
  HOST_ORIGINAL_ERROR_KEY,
  HostProtocolError,
  PROTOCOL_VERSION,
  assertProtocolVersionMatches,
  takeHostOriginalError,
  type HostEventName,
  type HostEventParams,
  type HostErrorCode,
  type HostRequestId,
} from '../../shared/host/protocol';
import {
  supportsStructuredFrames,
  type HostTransport,
  type StructuredHostTransport,
} from './transport';

export interface HostClientOptions {
  /** Connection identity the server attributes every request to. */
  readonly clientId: string;
  /** Advertised protocol revision (defaults to PROTOCOL_VERSION). */
  readonly protocolVersion?: number;
  /**
   * Per-request deadline in ms; 0 (default) disables it. Long-running host
   * methods (indexing, discovery) must not be cut short by a client timer.
   */
  readonly requestTimeoutMs?: number;
  /** Diagnostic label used in error messages. */
  readonly label?: string;
}

type EventHandler = (params: unknown, seq: number) => void;

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

export class HostClient {
  readonly clientId: string;
  private readonly label: string;
  private readonly protocolVersion: number;
  private readonly requestTimeoutMs: number;
  private readonly transport: HostTransport;
  private readonly structured: StructuredHostTransport | null;
  private readonly pending = new Map<HostRequestId, PendingRequest>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly closeCallbacks: Array<() => void> = [];
  private nextRequestId = 0;
  private highestSeq = -1;
  private alive = true;
  private readonly handshake: Promise<void>;

  constructor(transport: HostTransport, options: HostClientOptions) {
    this.transport = transport;
    this.clientId = options.clientId;
    this.label = options.label ?? `host:${options.clientId}`;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    this.structured = supportsStructuredFrames(transport) ? transport : null;

    if (this.structured) {
      this.structured.onFrame((frame) => this.handleFrame(frame));
    } else {
      this.transport.onData((line) => {
        try {
          this.handleFrame(JSON.parse(line));
        } catch (error) {
          console.warn(`[${this.label}] dropping malformed frame:`, error);
        }
      });
    }
    this.transport.onClose(() => this.handleClosed());

    this.handshake = this.performHandshake();
    // A transport that closes before the handshake settles would otherwise
    // surface as an unhandled rejection; awaiting request() still sees it.
    this.handshake.catch(() => {});
  }

  // ── Requests ───────────────────────────────────────────────────────────────

  /**
   * Invoke a host method. Rejects with the preserved original error when the
   * transport carried one, otherwise with a typed {@link HostProtocolError}.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.handshake;
    return (await this.send(method, params)) as T;
  }

  private async performHandshake(): Promise<void> {
    const result = await this.send(HOST_HELLO_METHOD, {
      protocolVersion: this.protocolVersion,
      clientId: this.clientId,
    }) as { protocolVersion?: number } | null;
    const offered = result?.protocolVersion;
    if (typeof offered === 'number') {
      assertProtocolVersionMatches(this.protocolVersion, offered);
    }
  }

  private send(method: string, params?: unknown): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(new HostProtocolError(
        HOST_ERROR_CODES.HOST_UNAVAILABLE,
        `${this.label}: transport closed before '${method}' was sent`,
      ));
    }
    this.nextRequestId += 1;
    const id = this.nextRequestId;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new HostProtocolError(
            HOST_ERROR_CODES.TIMEOUT,
            `${this.label}: '${method}' timed out after ${this.requestTimeoutMs}ms`,
          ));
        }, this.requestTimeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, method, timer });
      const frame = { id, method, params };
      try {
        if (this.structured) {
          this.structured.writeFrame(frame);
        } else {
          this.transport.write(JSON.stringify(frame));
        }
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new HostProtocolError(
          HOST_ERROR_CODES.HOST_UNAVAILABLE,
          `${this.label}: failed to write '${method}': ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
  }

  private handleFrame(frame: unknown): void {
    if (frame == null || typeof frame !== 'object') return;
    const record = frame as {
      id?: unknown; ok?: unknown; error?: unknown; result?: unknown;
      ev?: unknown; params?: unknown; seq?: unknown;
    };

    if (record.ev !== undefined) {
      this.dispatchEvent(
        record.ev as string,
        record.params,
        typeof record.seq === 'number' ? record.seq : -1,
      );
      return;
    }
    if (record.id === undefined || record.ok === undefined) return;

    const requestId = record.id as HostRequestId;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);

    if (record.ok === true) {
      pending.resolve(record.result ?? null);
      return;
    }
    pending.reject(this.toError(record.error, pending.method));
  }

  private toError(payload: unknown, method: string): unknown {
    if (payload == null || typeof payload !== 'object') {
      return new HostProtocolError(
        HOST_ERROR_CODES.INTERNAL,
        `'${method}' failed without an error payload`,
      );
    }
    const error = payload as { code?: unknown; message?: unknown; data?: unknown };
    // Error identity: an in-process server carries the original thrown value
    // (non-enumerable field). Both carriers accept only real Error objects —
    // over a wire the JSON encoding of an Error is `{}`, and a hostile peer
    // could smuggle an arbitrary plain object under the same key, so anything
    // else must surface as the typed payload instead of a non-Error rejection.
    const fromDataPayload = error.data != null && typeof error.data === 'object'
      ? (error.data as Record<string, unknown>)[HOST_ORIGINAL_ERROR_KEY]
      : undefined;
    const fromData = fromDataPayload instanceof Error ? fromDataPayload : undefined;
    const original = takeHostOriginalError(payload as unknown as Parameters<typeof takeHostOriginalError>[0]) ?? fromData;
    if (original !== undefined) {
      return original;
    }
    const code = typeof error.code === 'string'
      ? (error.code as HostErrorCode)
      : HOST_ERROR_CODES.INTERNAL;
    return new HostProtocolError(
      code,
      typeof error.message === 'string' ? error.message : `'${method}' failed`,
      error.data,
    );
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * Subscribe to one host event. Unknown event names reject immediately so a
   * typo cannot silently swallow pushes. Returns an unsubscribe function.
   */
  subscribe<Ev extends HostEventName>(
    ev: Ev,
    handler: (params: HostEventParams<Ev>, seq: number) => void,
  ): () => void {
    if (!Object.hasOwn(HOST_EVENTS, ev)) {
      throw new Error(`Unknown host event '${ev}'`);
    }
    let set = this.handlers.get(ev);
    if (!set) {
      set = new Set();
      this.handlers.set(ev, set);
    }
    set.add(handler as EventHandler);
    return () => {
      set?.delete(handler as EventHandler);
    };
  }

  private dispatchEvent(ev: string, params: unknown, seq: number): void {
    if (seq > this.highestSeq) this.highestSeq = seq;
    const set = this.handlers.get(ev);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(params, seq);
      } catch (error) {
        console.warn(`[${this.label}] '${ev}' subscriber failed (non-fatal):`, error);
      }
    }
  }

  /** Highest per-connection event sequence observed (drives reconnect resync). */
  lastSeq(): number {
    return this.highestSeq;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  isAlive(): boolean {
    return this.alive;
  }

  onClose(callback: () => void): void {
    if (!this.alive) {
      callback();
      return;
    }
    this.closeCallbacks.push(callback);
  }

  close(): void {
    if (!this.alive) return;
    this.transport.close();
    this.handleClosed();
  }

  private handleClosed(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new HostProtocolError(
        HOST_ERROR_CODES.HOST_UNAVAILABLE,
        `${this.label}: transport closed while '${pending.method}' was in flight`,
      ));
    }
    this.pending.clear();
    for (const callback of this.closeCallbacks.splice(0)) {
      try {
        callback();
      } catch (error) {
        console.warn(`[${this.label}] close callback failed (non-fatal):`, error);
      }
    }
  }
}

export function createHostClient(transport: HostTransport, options: HostClientOptions): HostClient {
  return new HostClient(transport, options);
}
