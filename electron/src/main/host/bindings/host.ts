/**
 * Host family bindings — the protocol handshake and the reconnect-resync
 * pending-state accessor (U10, R6).
 *
 * Owner-scoped snapshots answer [] for a reconnected remote client (fresh
 * connection id), so resync goes through the surface's machine-wide
 * accessors and re-binds orphaned pendings to the requester so it can
 * answer them.
 *
 * `host.pending_state` also scopes the catch-up to the caller's active
 * session (#19): sessionId + live-turn presence ride along so resync no
 * longer needs a full `chat.snapshot` (whole-history serialization) just to
 * learn them.
 */
import {
  PROTOCOL_VERSION,
  assertProtocolVersionMatches,
  type HostHelloParams,
} from '../../../shared/host/protocol';
import { getSessionManager } from '../../session/singleton';
import { getLiveChatSnapshot } from '../chat/snapshot';
import { pendingApprovalEvent, pendingQuestionEvent } from './pending-events';
import type { HostBinding, HostBindingEntries, HostServerSurface } from './types';

/** The caller client's active session id, or null (session manager unavailable / none active). */
function activeSessionIdForClient(clientId: string): string | null {
  try {
    return getSessionManager().getActive(clientId)?.id ?? null;
  } catch {
    return null;
  }
}

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
    const activeSessionId = activeSessionIdForClient(ctx.clientId);
    const liveSnapshot = activeSessionId != null ? getLiveChatSnapshot(activeSessionId) : null;
    return {
      approvals: surface.listPendingApprovals(params?.sessionId).map(pendingApprovalEvent),
      questions: surface.listPendingQuestions(params?.sessionId).map(pendingQuestionEvent),
      activeSession: {
        sessionId: activeSessionId,
        live: liveSnapshot
          ? { state: liveSnapshot.state, startedAt: liveSnapshot.startedAt }
          : null,
      },
    };
  });

  return entries;
}
