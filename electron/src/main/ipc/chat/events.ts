import { webContents as electronWebContents, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { getSessionManager } from '../session';
import type { ActiveAgent, ChatStatePayload } from './state';

export function canSend(webContents: WebContents): boolean {
  return typeof webContents.isDestroyed !== 'function' || !webContents.isDestroyed();
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

/** Notify renderer of live session (multi-chain) state after startChain. */
export function emitSessionUpdated(webContents: WebContents, sessionId: string): void {
  try {
    const session = getSessionManager().getSession(sessionId);
    if (session && canSend(webContents)) {
      webContents.send(IPC_CHANNELS.SESSION_UPDATED, { session });
    }
  } catch {
    // non-fatal
  }
}
