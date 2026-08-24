/**
 * Session activity IPC — list / mark-seen handlers plus the Electron broadcast
 * wiring for the host-side activity engine (session/activity-live).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { isEmbeddedLocalHostRunning } from '../host/local-host';
import { hostRequest } from './host-request';
import {
  clearSessionActivity,
  refreshSessionActivity,
  setSessionActivityBroadcast,
} from '../session/activity-live';
import { getSubagentManager } from '../tools';
import {
  subscribeBackgroundProcessChanges,
} from '../tools/process/background-store';

export {
  completeSessionActivity,
  publishSessionActivity,
  refreshSessionActivity,
  removeSessionActivity,
} from '../session/activity-live';

const markSeenSchema = z.object({ id: z.string().uuid() });

let removeSubagentChangeListener: (() => void) | null = null;
let removeBackgroundProcessChangeListener: (() => void) | null = null;

export function registerSessionActivityIPC(): void {
  // Fallback only: the embedded local host's HostServer owns activity
  // broadcasting once it is running (per-connection → client window push).
  if (!isEmbeddedLocalHostRunning()) {
    setSessionActivityBroadcast((activity) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        win.webContents.send(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, { activity });
      }
    });
  }
  removeSubagentChangeListener ??= getSubagentManager().addOnChangeListener((records) => {
    for (const sessionId of new Set(
      records.map((record) => record.sessionId).filter((id): id is string => id !== null),
    )) {
      refreshSessionActivity(sessionId);
    }
  });
  removeBackgroundProcessChangeListener ??= subscribeBackgroundProcessChanges((sessionId) => {
    if (sessionId) refreshSessionActivity(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_ACTIVITY_LIST, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_ACTIVITY_LIST);
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
    async (event, payload: unknown) => {
      const parsed = markSeenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid session:activity_mark_seen payload: ${parsed.error.message}`);
      }
      return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN, parsed.data);
    },
  );
}

export function unregisterSessionActivityIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_ACTIVITY_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN);
  removeSubagentChangeListener?.();
  removeSubagentChangeListener = null;
  removeBackgroundProcessChangeListener?.();
  removeBackgroundProcessChangeListener = null;
  if (!isEmbeddedLocalHostRunning()) setSessionActivityBroadcast(null);
  clearSessionActivity();
}
