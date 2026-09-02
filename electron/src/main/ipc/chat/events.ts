/**
 * Electron window addressing helpers.
 *
 * U3 installed an Electron `HostEventSink` here (the window fan-out behind the
 * turn pipeline). U5 moved that fan-out to the client side: the embedded local
 * host's `HostServer` owns delivery (per-connection seq + recipient gating) and
 * `ipc/host-broadcast.ts` pushes protocol events to each window's renderer.
 *
 * What remains here is the liveness check the machine-client window broadcast
 * uses to skip destroyed renderers.
 */
import type { WebContents } from 'electron';

export function canSend(webContents: WebContents): boolean {
  return typeof webContents.isDestroyed !== 'function' || !webContents.isDestroyed();
}
