/**
 * Host binding contracts — the shapes every per-family binding module in
 * host/bindings/ shares, independent of the HostServer class itself.
 */
import type { HostCapability } from '../../../shared/host/protocol';
import type { PendingApprovalWithOwner } from '../../permissions/approval-store';
import type { PendingQuestionWithOwner } from '../../tools/ask-question/store';
import type { HostClientId } from '../events';

/** Execution context handed to every method binding. */
export interface HostRequestContext {
  readonly clientId: HostClientId;
}

/** One protocol method's handler: receives the calling client + parsed params. */
export type HostBinding<P = unknown> = (
  ctx: HostRequestContext,
  params: P,
) => unknown | Promise<unknown>;

/** One family's method → binding table (composed by bindings/index.ts). */
export type HostBindingEntries = ReadonlyArray<[string, HostBinding<never>]>;

/**
 * The HostServer surface a binding family receives: the server's own
 * capabilities, emitters, and pending-store accessors as a plain typed
 * object — no `HostServer` instance and no closure back into the class.
 * Families reach their domain services through ordinary module imports;
 * only server-owned policy (capability gates, recipient-gated emission,
 * pending owner promotion) flows through this interface.
 */
export interface HostServerSurface {
  /** Server version advertised in the handshake. */
  readonly serverVersion: string;
  /** Capabilities this host declares (gates capability-scoped methods). */
  readonly capabilities: ReadonlySet<string>;
  /** Throw UNSUPPORTED_ON_HOST unless `capability` is declared. */
  requireCapability(capability: HostCapability, method: string): void;
  /** Deliver one event to a single connected client (no-op if disconnected). */
  emitTo(clientId: string, channel: string, params: unknown): void;
  /** Deliver one event to every connected client. */
  emitToAll(channel: string, params: unknown): void;
  /** Deliver one event to every client bound to `projectPath` (rag/ast gating). */
  emitToProject(projectPath: string, channel: string, params: unknown): void;
  /** Connected client ids. */
  listConnections(): string[];
  /** Re-bind orphaned pendings to a (re)connecting client (reconnect resync). */
  adoptOrphanedPendingFor(clientId: string): void;
  /** Pending approvals for reconnect resync, tagged with owner + createdAt. */
  listPendingApprovals(sessionId?: string): PendingApprovalWithOwner[];
  /** Pending questions for reconnect resync, tagged with owner + createdAt. */
  listPendingQuestions(sessionId?: string): PendingQuestionWithOwner[];
}
