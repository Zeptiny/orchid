/**
 * Host event delivery seam.
 *
 * The turn pipeline (host/chat/*) addresses clients by an opaque string id —
 * locally the renderer window id, on a headless host a connection id — and
 * never touches Electron directly. Delivery is injected via
 * {@link setHostEventSink} so the Electron shell installs the window broadcast
 * while plain-Node hosts keep the no-op default.
 */
import type { SessionUpdatedEvent } from '../../shared/types/ipc';
import type { Session } from '../../shared/types/session';
import type { ActiveAgent, ChatStatePayload } from './chat/state';

/** Opaque host-client identity: locally the renderer window id. */
export type HostClientId = string;

/** Turn identity stamped on every sequenced turn event. */
export interface TurnEventIdentity {
  sessionId: string;
  turnId: string;
  sequence: number;
}

/** Delivery target the host chat pipeline emits through. */
export interface HostEventSink {
  sendTurnEvent(
    clientId: HostClientId,
    active: ActiveAgent,
    channel: string,
    payload: Record<string, unknown>,
  ): void;
  sendSessionEvent(
    clientId: HostClientId | null,
    sessionId: string,
    channel: string,
    payload: object,
  ): void;
  sendChatState(
    clientId: HostClientId,
    active: ActiveAgent,
    payload: ChatStatePayload,
  ): void;
  emitSessionUpdated(clientId: HostClientId | null, sessionId: string): void;
  /** Whether the client can currently receive events (approval/question routing). */
  canDeliverTo(clientId: HostClientId): boolean;
}

const NOOP_HOST_EVENT_SINK: HostEventSink = {
  sendTurnEvent: () => {},
  sendSessionEvent: () => {},
  sendChatState: () => {},
  emitSessionUpdated: () => {},
  canDeliverTo: () => false,
};

let hostEventSink: HostEventSink = NOOP_HOST_EVENT_SINK;

/**
 * Install event delivery for the host chat pipeline (the Electron shell
 * installs the window broadcast). Passing null restores the no-op default.
 */
export function setHostEventSink(sink: HostEventSink | null): void {
  hostEventSink = sink ?? NOOP_HOST_EVENT_SINK;
}

export function getHostEventSink(): HostEventSink {
  return hostEventSink;
}

/** Mint the next per-turn event identity; shared by every sink implementation. */
export function nextEventIdentity(active: ActiveAgent): TurnEventIdentity {
  active.eventSequence += 1;
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    sequence: active.eventSequence,
  };
}

/**
 * Whether renderer-visible chat-state metadata changed. Streaming content is
 * intentionally excluded: it is delivered as CHAT_CHUNK and retained in the
 * explicit ChatSnapshot hydration path.
 */
export function chatStateChanged(
  previous: ChatStatePayload | null,
  payload: ChatStatePayload,
): boolean {
  return !(
    previous !== null &&
    previous.state === payload.state &&
    previous.error === payload.error &&
    previous.interruptState === payload.interruptState &&
    previous.cwd === payload.cwd
  );
}

/** Build the bounded renderer patch for the chain changed by this write. */
export function buildSessionUpdatedEvent(
  session: Session,
  chainId: string | null = session.activeChainId,
): SessionUpdatedEvent | null {
  const chain = chainId
    ? session.chains.find((candidate) => candidate.id === chainId)
    : session.chains.at(-1);
  if (!chain) return null;
  return {
    sessionId: session.id,
    chain,
    activeChainId: session.activeChainId,
    updatedAt: session.updatedAt,
  };
}
