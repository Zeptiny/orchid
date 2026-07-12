import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { SessionActivity } from '../../shared/types/ipc-boundary';
import {
  sessionActivityStore,
  type SessionActivityUpdate,
} from '../session/activity';
import { getBackgroundStore } from '../tools/process/background-store';

const markSeenSchema = z.object({ id: z.string().uuid() });

function backgroundProcessCount(sessionId: string): number {
  try {
    return getBackgroundStore()
      .list()
      .filter((entry) => entry.sessionId === sessionId && entry.exitCode === null)
      .length;
  } catch {
    return 0;
  }
}

function broadcast(activity: SessionActivity): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.SESSION_ACTIVITY_CHANGED, { activity });
  }
}

export function publishSessionActivity(
  sessionId: string,
  patch: SessionActivityUpdate,
): SessionActivity {
  const activity = sessionActivityStore.update(sessionId, {
    ...patch,
    backgroundProcessCount: backgroundProcessCount(sessionId),
  });
  broadcast(activity);
  return activity;
}

export function completeSessionActivity(
  sessionId: string,
  unread: boolean,
): SessionActivity {
  const activity = sessionActivityStore.complete(sessionId, unread);
  const enriched = sessionActivityStore.update(sessionId, {
    backgroundProcessCount: backgroundProcessCount(sessionId),
  });
  broadcast(enriched);
  return activity.backgroundProcessCount === enriched.backgroundProcessCount
    ? activity
    : enriched;
}

export function removeSessionActivity(sessionId: string): void {
  const previous = sessionActivityStore.get(sessionId);
  sessionActivityStore.remove(sessionId);
  if (!previous) return;
  // Tombstone: idle + seen + no bg so list filters out and renderers prune.
  broadcast({
    ...previous,
    state: 'idle',
    phase: null,
    detail: null,
    unread: false,
    canCancel: false,
    backgroundProcessCount: 0,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export function registerSessionActivityIPC(): void {
  ipcMain.handle(IPC_CHANNELS.SESSION_ACTIVITY_LIST, async () => {
    for (const activity of sessionActivityStore.list()) {
      sessionActivityStore.update(activity.sessionId, {
        backgroundProcessCount: backgroundProcessCount(activity.sessionId),
      });
    }
    return sessionActivityStore.list();
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN,
    async (_event, payload: unknown) => {
      const parsed = markSeenSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`Invalid session:activity_mark_seen payload: ${parsed.error.message}`);
      }
      const activity = sessionActivityStore.markSeen(parsed.data.id);
      if (activity) broadcast(activity);
      return activity;
    },
  );
}

export function unregisterSessionActivityIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_ACTIVITY_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN);
  sessionActivityStore.clear();
}
