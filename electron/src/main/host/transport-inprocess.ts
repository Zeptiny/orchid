/**
 * Zero-copy in-process transport between a `HostClient` and an embedded
 * `HostServer` (the local machine, U5).
 *
 * The frames are the decoded protocol objects themselves — nothing is JSON
 * encoded — so results keep live object identity and a binding's thrown error
 * reaches the client as the *same* value the server caught (see
 * `attachHostOriginalError`).
 *
 * One transport owns exactly one server connection (identified by its
 * clientId). Locally the clientId is the renderer window id, which is what the
 * per-window active-session / working-set / approval-owner maps already key
 * on, so every server binding behaves exactly as the Electron IPC handler it
 * replaced.
 */
import {
  HOST_ERROR_CODES,
  isHostRequest,
  type HostRequest,
  type HostResponse,
} from '../../shared/host/protocol';
import type { HostServer, HostConnectionHandle } from './server';
import type { StructuredHostTransport } from './transport';

export interface InProcessTransportOptions {
  readonly server: HostServer;
  /** Connection identity handed to every binding (locally: the window id). */
  readonly clientId: string;
}

export class InProcessHostTransport implements StructuredHostTransport {
  readonly clientId: string;
  private readonly server: HostServer;
  private readonly connection: HostConnectionHandle;
  private frameCallback: ((frame: unknown) => void) | null = null;
  private lineCallback: ((line: string) => void) | null = null;
  private readonly closeCallbacks: Array<() => void> = [];
  private closed = false;

  constructor(options: InProcessTransportOptions) {
    this.server = options.server;
    this.clientId = options.clientId;
    // Registering eagerly is what makes this client eligible for server events
    // (an unregistered clientId gets an implicit connection with a no-op emit).
    this.connection = this.server.addConnection(options.clientId, (event) => {
      this.deliver(event as unknown);
    });
  }

  // ── HostTransport (line protocol, for parity with wire transports) ─────────

  write(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      // Framing errors are surfaced as an INTERNAL response for that request
      // id when one is recoverable, otherwise dropped (mirrors wire behavior).
      console.warn('[host-transport] dropping malformed frame:', error);
      return;
    }
    this.writeFrame(frame);
  }

  onData(cb: (line: string) => void): void {
    this.lineCallback = cb;
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.dispose();
    } catch (error) {
      console.warn('[host-transport] connection dispose failed (non-fatal):', error);
    }
    for (const callback of this.closeCallbacks.splice(0)) {
      try {
        callback();
      } catch (error) {
        console.warn('[host-transport] close callback failed (non-fatal):', error);
      }
    }
  }

  // ── StructuredHostTransport (zero-copy, used by the local client) ──────────

  onFrame(cb: (frame: unknown) => void): void {
    this.frameCallback = cb;
  }

  writeFrame(frame: unknown): void {
    if (this.closed) return;
    if (!isHostRequest(frame)) {
      console.warn('[host-transport] ignoring non-request frame from client');
      return;
    }
    const request = frame as HostRequest;
    void this.server
      .handleRequest(request, this.clientId)
      .then((response: HostResponse) => this.deliver(response as unknown))
      .catch((error: unknown) => {
        // handleRequest never rejects (it maps errors onto the error leg), so
        // this is a hard programming error — still answer the request.
        this.deliver({
          id: request.id,
          ok: false,
          error: {
            code: HOST_ERROR_CODES.INTERNAL,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }

  private deliver(frame: unknown): void {
    if (this.closed) return;
    if (this.frameCallback) {
      this.frameCallback(frame);
      return;
    }
    if (this.lineCallback) {
      try {
        this.lineCallback(JSON.stringify(frame));
      } catch (error) {
        console.warn('[host-transport] frame encode failed (non-fatal):', error);
      }
    }
  }
}

export function createInProcessTransport(options: InProcessTransportOptions): InProcessHostTransport {
  return new InProcessHostTransport(options);
}
