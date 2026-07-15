import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { WorkingSetSnapshot } from '../session/working-set';
import { sessionWorkingSet } from '../session/working-set';
import { getSessionManager } from './session';

const sessionIdSchema = z.object({ id: z.string().uuid() });
const setFocusSchema = z.object({ id: z.string().uuid().nullable() });

function broadcast(snapshot: WorkingSetSnapshot): void {
  const windows =
    typeof BrowserWindow?.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [];
  for (const win of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(IPC_CHANNELS.SESSION_WORKING_SET_CHANGED, { snapshot });
  }
}

function mutateAndPersist(
  run: () => WorkingSetSnapshot,
): WorkingSetSnapshot {
  const snapshot = run();
  try {
    sessionWorkingSet.saveToDisk();
  } catch (err) {
    // Non-fatal — in-memory state remains authoritative for this process.
    console.error('[working-set] failed to persist ui-state.json', err);
  }
  broadcast(snapshot);
  return snapshot;
}

function existingSessionIds(): Set<string> {
  const manager = getSessionManager();
  return new Set(manager.listSaved().map((s) => s.id));
}

/** Load durable working set at process start (call once from app boot if needed). */
export function bootstrapWorkingSet(): WorkingSetSnapshot {
  sessionWorkingSet.loadFromDisk();
  return mutateAndPersist(() =>
    sessionWorkingSet.filterExisting(existingSessionIds()),
  );
}

export function registerSessionWorkingSetIPC(): void {
  try {
    sessionWorkingSet.loadFromDisk();
    // Persist filtered set so deleted sessions do not reappear after restart.
    mutateAndPersist(() => sessionWorkingSet.filterExisting(existingSessionIds()));
  } catch {
    // empty store
  }

  ipcMain.handle(IPC_CHANNELS.SESSION_WORKING_SET_GET, async () => {
    return sessionWorkingSet.filterExisting(existingSessionIds());
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS,
    async (_event, payload: unknown) => {
      const parsed = sessionIdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_open_or_focus payload: ${parsed.error.message}`,
        );
      }
      if (!existingSessionIds().has(parsed.data.id)) {
        return sessionWorkingSet.getSnapshot();
      }
      return mutateAndPersist(() => sessionWorkingSet.openOrFocus(parsed.data.id));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_CLOSE,
    async (_event, payload: unknown) => {
      const parsed = sessionIdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_close payload: ${parsed.error.message}`,
        );
      }
      return mutateAndPersist(() => sessionWorkingSet.close(parsed.data.id));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_REMOVE,
    async (_event, payload: unknown) => {
      const parsed = sessionIdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_remove payload: ${parsed.error.message}`,
        );
      }
      return mutateAndPersist(() => sessionWorkingSet.remove(parsed.data.id));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS,
    async (_event, payload: unknown) => {
      const parsed = setFocusSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_set_focus payload: ${parsed.error.message}`,
        );
      }
      return mutateAndPersist(() => sessionWorkingSet.setFocus(parsed.data.id));
    },
  );
}

export function unregisterSessionWorkingSetIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_GET);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_CLOSE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_REMOVE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS);
}

/** Called from session:load activate path so open-set stays in sync. */
export function workingSetOpenOrFocus(id: string): WorkingSetSnapshot {
  return mutateAndPersist(() => sessionWorkingSet.openOrFocus(id));
}

/** Called from session:delete so ghost tabs disappear. */
export function workingSetRemove(id: string): WorkingSetSnapshot {
  return mutateAndPersist(() => sessionWorkingSet.remove(id));
}

/** Draft mode: clear focused id without removing open session tabs. */
export function workingSetClearFocus(): WorkingSetSnapshot {
  return mutateAndPersist(() => sessionWorkingSet.setFocus(null));
}

export function getWorkingSetSnapshot(): WorkingSetSnapshot {
  return sessionWorkingSet.getSnapshot();
}
