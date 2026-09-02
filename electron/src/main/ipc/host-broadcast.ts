/**
 * Client-side window broadcast — the Electron half of host event delivery.
 *
 * The embedded local host (host/local-host.ts) owns the *server* side: it
 * stamps per-connection sequence numbers and decides which connections are
 * eligible (the requesting client plus every client whose active session or
 * bound project matches). This module is the *client* side: every protocol
 * event arriving on a window's HostClient is pushed to that window's
 * renderer on the channel with the very same name.
 *
 * That replaces the Electron HostEventSink (ipc/chat/events.ts) plus the
 * per-module window broadcasts (todos, subagent deltas, working set, activity,
 * bgcmd, index auto-refresh, approvals, questions) with one seam, so local and
 * remote machines are indistinguishable from the renderer's point of view.
 */
import { BrowserWindow, webContents as electronWebContents, type WebContents } from 'electron';
import { HOST_EVENTS, type HostEventName } from '../../shared/host/protocol';
import { MACHINE_ID_LOCAL } from '../../shared/types/machine';
import { activeMachineFor } from '../host/routing';
import { getLocalHostClient, setLocalClientListener, setLocalClientSweep } from '../host/local-host';
import type { HostClient } from '../host/client';
import { canSend } from './chat/events';

/** Resolve the renderer a window-scoped client delivers to, if it is alive. */
export function webContentsForClientId(clientId: string): WebContents | null {
  try {
    const id = Number(clientId);
    if (Number.isFinite(id)) {
      const wc = electronWebContents?.fromId?.(id);
      // Validate the id: fromId may answer with a stale/other window.
      if (wc && String(wc.id) === clientId && canSend(wc)) return wc;
    }
  } catch {
    // fall through to the enumeration
  }
  // Same id space: webContents.fromId covers live renderers, but a window that
  // never served a request is still addressable through the enumerations.
  for (const wc of enumerateWebContents()) {
    if (String(wc.id) === clientId && canSend(wc)) return wc;
  }
  return null;
}

/** Every renderer the shell can currently address (deduped by id). */
function enumerateWebContents(): WebContents[] {
  const byId = new Map<string, WebContents>();
  try {
    const windows = typeof BrowserWindow?.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [];
    for (const win of windows) {
      if (win.isDestroyed?.()) continue;
      const wc = win.webContents;
      if (wc) byId.set(String(wc.id), wc);
    }
  } catch {
    // fall through to the webContents enumeration
  }
  try {
    for (const wc of electronWebContents?.getAllWebContents?.() ?? []) {
      byId.set(String(wc.id), wc);
    }
  } catch {
    // non-fatal
  }
  return [...byId.values()];
}

/** Subscribe one client to every host event and push each to its window. */
function attachWindowBroadcast(client: HostClient, clientId: string): void {
  for (const ev of Object.keys(HOST_EVENTS) as HostEventName[]) {
    client.subscribe(ev, (params) => {
      // A window switched to a remote machine must not receive LOCAL host
      // events (working-set/activity/deleted pushes would bleed cross-machine
      // state into its renderer): mirror the remote twin's gate in
      // machines/remote-clients.ts deliverToMachineWindows. The renderer
      // re-scopes itself on machine switches (ChatView's machine-scope effect
      // re-fetches sessions/workspace/providers), so no extra refresh signal
      // is needed here — only the suspension.
      if (activeMachineFor(clientId) !== MACHINE_ID_LOCAL) return;
      const target = webContentsForClientId(clientId);
      if (!target) return;
      try {
        target.send(ev, params);
      } catch (error) {
        console.debug(`[host-broadcast] '${ev}' to window ${clientId} failed (non-fatal):`, error);
      }
    });
  }
}

/**
 * Wire the broadcast once, when the local host starts (before IPC
 * registration, so every lazily created per-window client is covered).
 */
export function wireLocalHostWindowBroadcast(): void {
  setLocalClientListener((client, clientId) => attachWindowBroadcast(client, clientId));
  // A window that has not sent a request yet must still receive events for the
  // session it views: connect every live renderer window before serving a
  // request from any of them.
  setLocalClientSweep(() => {
    for (const clientId of knownWindowClientIds()) {
      getLocalHostClient(clientId);
    }
  });
}

/** Detach (tests / shutdown). */
export function unwireLocalHostWindowBroadcast(): void {
  setLocalClientListener(null);
  setLocalClientSweep(null);
}

/** Union of renderer window ids the shell can currently address. */
function knownWindowClientIds(): string[] {
  const ids = new Set<string>();
  for (const wc of enumerateWebContents()) {
    if (canSend(wc)) ids.add(String(wc.id));
  }
  return [...ids];
}
