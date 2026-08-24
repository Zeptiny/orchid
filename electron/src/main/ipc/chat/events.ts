/**
 * Electron window addressing helpers.
 *
 * U3 installed an Electron `HostEventSink` here (the window fan-out behind the
 * turn pipeline). U5 moved that fan-out to the client side: the embedded local
 * host's `HostServer` owns delivery (per-connection seq + recipient gating) and
 * `ipc/host-broadcast.ts` pushes protocol events to each window's renderer.
 *
 * What remains here is the resolver the permission / ask-question routing and
 * the force-abort paths use to address a window by its opaque client id.
 */
import { webContents as electronWebContents, type WebContents } from 'electron';

export function canSend(webContents: WebContents): boolean {
  return typeof webContents.isDestroyed !== 'function' || !webContents.isDestroyed();
}

/** Resolve WebContents for a window id (forceAbort / SESSION_UPDATED). */
export function webContentsForWindowId(windowId: string): WebContents | null {
  try {
    const id = Number(windowId);
    if (!Number.isFinite(id)) return null;
    const wc = electronWebContents?.fromId?.(id);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return null;
    }
    return wc;
  } catch {
    return null;
  }
}
