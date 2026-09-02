/**
 * Turn/session event emission for the host chat pipeline.
 *
 * Thin host-side policy over the injected {@link HostEventSink}: chat-state
 * dedup lives here so every sink inherits it, while turn identity sequencing
 * and recipient fan-out belong to the installed sink.
 */
import { chatStateChanged, getHostEventSink, type HostClientId } from '../events';
import type { ActiveAgent, ChatStatePayload } from './state';

export { buildSessionUpdatedEvent } from '../events';
export type { HostClientId } from '../events';

/**
 * Send a durable session event to every client that still has that session
 * selected. The source client is deliberately subject to the same check: a
 * delayed persistence or title update must not revive a session it left.
 */
export function sendSessionEvent(
  clientId: HostClientId | null,
  sessionId: string,
  channel: string,
  payload: object,
): void {
  getHostEventSink().sendSessionEvent(clientId, sessionId, channel, payload);
}

export function sendTurnEvent(
  clientId: HostClientId,
  active: ActiveAgent,
  channel: string,
  payload: Record<string, unknown>,
): void {
  getHostEventSink().sendTurnEvent(clientId, active, channel, payload);
}

/**
 * Send state only when renderer-visible metadata changes. Streaming content is
 * intentionally excluded: it is delivered as CHAT_CHUNK and retained in the
 * explicit ChatSnapshot hydration path.
 */
export function sendChatState(
  clientId: HostClientId,
  active: ActiveAgent,
  payload: ChatStatePayload,
): void {
  if (!chatStateChanged(active.lastChatState, payload)) return;
  active.lastChatState = payload;
  getHostEventSink().sendChatState(clientId, active, payload);
}

/** Notify the client of live session (multi-chain) state after startChain. */
export function emitSessionUpdated(
  clientId: HostClientId | null,
  sessionId: string,
): void {
  getHostEventSink().emitSessionUpdated(clientId, sessionId);
}

/** Whether the installed sink can currently deliver to a client id. */
export function canDeliverTo(clientId: HostClientId): boolean {
  return getHostEventSink().canDeliverTo(clientId);
}
