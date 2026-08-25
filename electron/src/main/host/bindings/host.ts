/**
 * Host family bindings — the protocol handshake and the reconnect-resync
 * pending-state accessor (U10, R6).
 *
 * Owner-scoped snapshots answer [] for a reconnected remote client (fresh
 * connection id), so resync goes through the surface's machine-wide
 * accessors and re-binds orphaned pendings to the requester so it can
 * answer them.
 */
import {
  PROTOCOL_VERSION,
  assertProtocolVersionMatches,
  type HostHelloParams,
} from '../../../shared/host/protocol';
import { pendingApprovalEvent, pendingQuestionEvent } from './pending-events';
import type { HostBinding, HostBindingEntries, HostServerSurface } from './types';

export function buildHostBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('host.hello', (_ctx, params: HostHelloParams) => {
    assertProtocolVersionMatches(PROTOCOL_VERSION, params.protocolVersion);
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: surface.serverVersion,
      capabilities: [...surface.capabilities],
    };
  });

  bind('host.pending_state', (ctx, params: { sessionId?: string }) => {
    surface.adoptOrphanedPendingFor(ctx.clientId);
    return {
      approvals: surface.listPendingApprovals(params?.sessionId).map(pendingApprovalEvent),
      questions: surface.listPendingQuestions(params?.sessionId).map(pendingQuestionEvent),
    };
  });

  return entries;
}
