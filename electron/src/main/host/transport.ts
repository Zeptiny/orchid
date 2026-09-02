/**
 * Transport-agnostic host connection (plan 2026-08-23-001, U5).
 *
 * A `HostTransport` moves framed protocol messages between one `HostClient`
 * and one host. Wire transports (stdio over SSH, a UNIX socket) speak
 * newline-delimited JSON text; the embedded local host speaks the same
 * contract with structured frames so objects pass by reference (zero-copy,
 * no JSON round-trip) and thrown errors keep their identity.
 *
 * The lifecycle contract is deliberately minimal: exactly one `onData`
 * consumer and any number of `onClose` consumers may be installed; `close()`
 * is idempotent and must trigger the close callbacks exactly once.
 */
export interface HostTransport {
  /** Send one framed message to the host (a newline-terminated JSON line). */
  write(line: string): void;
  /** Install the single receiver for framed messages coming from the host. */
  onData(cb: (line: string) => void): void;
  /** Register a callback fired once when the connection is gone. */
  onClose(cb: () => void): void;
  /** Tear the connection down; subsequent writes are ignored. */
  close(): void;
}

/**
 * Structured (zero-copy) extension an in-process transport implements. Frames
 * are the decoded request/response/event objects, so the client and the
 * embedded host share object identity — error objects and live values cross
 * the boundary untouched.
 */
export interface StructuredHostTransport extends HostTransport {
  /** Send one already-decoded frame (request) to the host. */
  writeFrame(frame: unknown): void;
  /** Install the single receiver for already-decoded frames from the host. */
  onFrame(cb: (frame: unknown) => void): void;
}

/** Whether a transport supports the structured (in-process) frame exchange. */
export function supportsStructuredFrames(
  transport: HostTransport,
): transport is StructuredHostTransport {
  const candidate = transport as Partial<StructuredHostTransport>;
  return typeof candidate.writeFrame === 'function' && typeof candidate.onFrame === 'function';
}
