import { webContents as electronWebContents, type WebContents } from 'electron';
import { IPC_CHANNELS, type SessionUpdatedEvent } from '../../../shared/types/ipc';
import type { Session } from '../../../shared/types/session';
import { getSessionManager } from '../../session/singleton';
import type { ActiveAgent, ChatStatePayload } from './state';

export function canSend(webContents: WebContents): boolean {
  return typeof webContents.isDestroyed !== 'function' || !webContents.isDestroyed();
}

/**
 * Send a durable session event to every window that still has that session
 * selected. The source window is deliberately subject to the same check: a
 * delayed persistence or title update must not revive a session it left.
 */
export function sendSessionEvent(
  source: WebContents | null,
  sessionId: string,
  channel: string,
  payload: object,
): void {
  const recipients = new Map<number, WebContents>();
  const addIfSelected = (candidate: WebContents): void => {
    if (getSessionManager().getActive(String(candidate.id))?.id === sessionId) {
      recipients.set(candidate.id, candidate);
    }
  };

  if (source) addIfSelected(source);
  for (const candidate of electronWebContents.getAllWebContents?.() ?? []) {
    addIfSelected(candidate);
  }

  for (const recipient of recipients.values()) {
    if (canSend(recipient)) {
      recipient.send(channel, payload);
    }
  }
}

/** Resolve WebContents for a window id (forceAbort / SESSION_UPDATED). */
export function webContentsForWindowId(windowId: string): WebContents | null {
  try {
    const id = Number(windowId);
    if (!Number.isFinite(id)) return null;
    const wc = electronWebContents.fromId(id);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return null;
    }
    return wc;
  } catch {
    return null;
  }
}

function nextEventIdentity(active: ActiveAgent) {
  active.eventSequence += 1;
  return {
    sessionId: active.sessionId,
    turnId: active.turnId,
    sequence: active.eventSequence,
  };
}

export function sendTurnEvent(
  webContents: WebContents,
  active: ActiveAgent,
  channel: string,
  payload: Record<string, unknown>,
): void {
  const identity = nextEventIdentity(active);
  const recipients = new Map<number, WebContents>();
  recipients.set(webContents.id, webContents);
  const allWebContents = electronWebContents.getAllWebContents?.() ?? [];
  for (const candidate of allWebContents) {
    if (getSessionManager().getActive(String(candidate.id))?.id === active.sessionId) {
      recipients.set(candidate.id, candidate);
    }
  }
  for (const recipient of recipients.values()) {
    if (canSend(recipient)) {
      recipient.send(channel, { ...identity, ...payload });
    }
  }
}

/**
 * Send state only when renderer-visible metadata changes. Streaming content is
 * intentionally excluded: it is delivered as CHAT_CHUNK and retained in the
 * explicit ChatSnapshot hydration path.
 */
export function sendChatState(
  webContents: WebContents,
  active: ActiveAgent,
  payload: ChatStatePayload,
): void {
  const previous = active.lastChatState;
  if (
    previous &&
    previous.state === payload.state &&
    previous.error === payload.error &&
    previous.interruptState === payload.interruptState &&
    previous.cwd === payload.cwd
  ) {
    return;
  }

  active.lastChatState = payload;
  sendTurnEvent(webContents, active, IPC_CHANNELS.CHAT_STATE, payload);
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

/** Notify renderer of live session (multi-chain) state after startChain. */
export function emitSessionUpdated(webContents: WebContents, sessionId: string): void {
  try {
    const session = getSessionManager().getSession(sessionId);
    const update = session ? buildSessionUpdatedEvent(session) : null;
    if (update) {
      sendSessionEvent(webContents, sessionId, IPC_CHANNELS.SESSION_UPDATED, update);
    }
  } catch {
    // non-fatal
  }
}
