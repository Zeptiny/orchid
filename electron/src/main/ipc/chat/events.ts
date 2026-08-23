/**
 * Electron implementation of the host event sink (host/events.ts).
 *
 * Window fan-out stays Electron-side: turn/session events reach every
 * webContents still viewing the session, turn identity sequencing comes from
 * the shared host helpers, and `webContentsForWindowId` remains the resolver
 * the permission / ask-question routing uses.
 */
import { webContents as electronWebContents, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { getSessionManager } from '../../session/singleton';
import {
  buildSessionUpdatedEvent,
  nextEventIdentity,
  type HostClientId,
  type HostEventSink,
} from '../../host/events';
import type { ActiveAgent } from '../../host/chat/state';

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

function deliverSessionEvent(
  clientId: HostClientId | null,
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

  const source = clientId == null ? null : webContentsForWindowId(clientId);
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

function deliverTurnEvent(
  clientId: HostClientId,
  active: ActiveAgent,
  channel: string,
  payload: Record<string, unknown>,
): void {
  const identity = nextEventIdentity(active);
  const recipients = new Map<number, WebContents>();
  const source = clientId == null ? null : webContentsForWindowId(clientId);
  if (source) recipients.set(source.id, source);
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

/** The sink the Electron shell installs for the host chat pipeline. */
export const electronHostEventSink: HostEventSink = {
  sendSessionEvent: deliverSessionEvent,
  sendTurnEvent: deliverTurnEvent,
  sendChatState: (clientId, active, payload) => {
    deliverTurnEvent(clientId, active, IPC_CHANNELS.CHAT_STATE, payload);
  },
  emitSessionUpdated: (clientId, sessionId) => {
    try {
      const session = getSessionManager().getSession(sessionId);
      const update = session ? buildSessionUpdatedEvent(session) : null;
      if (update) {
        deliverSessionEvent(clientId, sessionId, IPC_CHANNELS.SESSION_UPDATED, update);
      }
    } catch {
      // non-fatal
    }
  },
  canDeliverTo: (clientId) => webContentsForWindowId(clientId) != null,
};
