import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { StartupContinueDegradedResult, StartupSnapshot } from '../../shared/types/ipc-boundary';
import { startupState, type StartupState } from '../startup';

let unsubscribe: (() => void) | null = null;

function broadcast(snapshot: StartupSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send(IPC_CHANNELS.STARTUP_CHANGED, snapshot);
    } catch {
      // A window can close between the guards and send. Startup state remains
      // authoritative, so surviving or later windows hydrate from snapshot().
      console.warn('[startup] skipped progress delivery to a closed window');
    }
  }
}

function rejectPayload(channel: string, payload: unknown[]): void {
  if (payload.length > 0) {
    throw new Error(`${channel} does not accept payloads`);
  }
}

/** Register the narrow startup surface before the normal IPC registry. */
export function registerStartupIPC(state: StartupState = startupState): void {
  unregisterStartupIPC();
  unsubscribe = state.subscribe(broadcast);

  ipcMain.handle(IPC_CHANNELS.STARTUP_SNAPSHOT, async (_event, ...payload: unknown[]) => {
    rejectPayload(IPC_CHANNELS.STARTUP_SNAPSHOT, payload);
    return state.snapshot();
  });

  ipcMain.handle(IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED, async (_event, ...payload: unknown[]): Promise<StartupContinueDegradedResult> => {
    rejectPayload(IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED, payload);
    return { ok: state.continueDegraded(), snapshot: state.snapshot() };
  });
}

export function unregisterStartupIPC(): void {
  unsubscribe?.();
  unsubscribe = null;
  ipcMain.removeHandler(IPC_CHANNELS.STARTUP_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED);
}
