/**
 * Session activity IPC — list / mark-seen handlers plus the Electron broadcast
 * wiring for the host-side activity engine (session/activity-live).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  clearSessionActivity,
  listSessionActivity,
  markSessionActivitySeen,
  reconcileSessionActivity,
  refreshSessionActivity,
  setSessionActivityBroadcast,
} from '../session/activity-live';
import { getSubagentManager } from '../tools';
import {
  getBackgroundStore,
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
  setSessionActivityBroadcast((activity) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, { activity });
    }
  });
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

  ipcMain.handle(IPC_CHANNELS.SESSION_ACTIVITY_LIST, async () => {
    const sessionIds = new Set(listSessionActivity().map((activity) => activity.sessionId));
    try {
      for (const record of getSubagentManager().allRecords()) {
        if (record.sessionId) sessionIds.add(record.sessionId);
      }
      for (const process of getBackgroundStore().list()) {
        if (process.sessionId && process.exitCode === null) sessionIds.add(process.sessionId);
      }
    } catch {
      // Activity remains usable before optional runtime services initialize.
    }
    for (const sessionId of sessionIds) {
      reconcileSessionActivity(sessionId);
    }
    return listSessionActivity();
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
    async (_event, payload: unknown) => {
      const parsed = markSeenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid session:activity_mark_seen payload: ${parsed.error.message}`);
      }
      return markSessionActivitySeen(parsed.data.id);
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
  setSessionActivityBroadcast(null);
  clearSessionActivity();
}
