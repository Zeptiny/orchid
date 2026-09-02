/**
 * Electron-side facade over the machine-routing host request.
 *
 * Every host-routed IPC handler goes through this function instead of calling
 * `host/routing.ts` directly, so the client-side window broadcast
 * (`ipc/host-broadcast.ts`) is wired before the first request regardless of
 * which IPC family a host first serves — the app startup order and any
 * embedding (including tests) both work.
 */
import { hostRequest as routedHostRequest } from '../host/routing';
import { wireLocalHostWindowBroadcast } from './host-broadcast';

export function hostRequest<T = unknown>(
  windowId: string,
  channel: string,
  payload?: unknown,
): Promise<T> {
  wireLocalHostWindowBroadcast();
  return routedHostRequest<T>(windowId, channel, payload);
}
