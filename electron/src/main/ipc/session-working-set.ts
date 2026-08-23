/**
 * Working-set IPC handlers plus the Electron broadcast wiring for the
 * host-side mutations (session/working-set-live).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, type WorkingSetSnapshot } from '../../shared/types/ipc';
import { sessionWorkingSet } from '../session/working-set';
import {
  bootstrapWorkingSet,
  filterIfCatalogOk,
  mutateAndPersist,
  setWorkingSetBroadcast,
  tryListSessionCatalog,
  workingSetOpenOrFocus,
  workingSetRemove,
} from '../session/working-set-live';

export {
  bootstrapWorkingSet,
  getWorkingSetSnapshot,
  tryListSessionCatalog,
  workingSetClearFocus,
  workingSetOpenOrFocus,
  workingSetRemove,
  type SessionCatalog,
} from '../session/working-set-live';

const sessionIdSchema = z.object({ id: z.string().uuid() });
const setFocusSchema = z.object({ id: z.string().uuid().nullable() });

function ownerFromEvent(event: { sender?: { id?: number } }): string {
  const id = event?.sender?.id;
  return id != null ? String(id) : '__primary__';
}

function broadcastOpenSet(snapshot: WorkingSetSnapshot, sourceOwnerId: string): void {
  const windows =
    typeof BrowserWindow?.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [];
  for (const win of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    const ownerId = String(win.webContents.id);
    // Each window gets its own focus; open membership is shared.
    const perWindow =
      ownerId === sourceOwnerId
        ? snapshot
        : sessionWorkingSet.getSnapshot(ownerId);
    win.webContents.send(IPC_CHANNELS.SESSION_WORKING_SET_CHANGED, {
      snapshot: perWindow,
    });
  }
}

export function registerSessionWorkingSetIPC(): void {
  setWorkingSetBroadcast(broadcastOpenSet);
  try {
    bootstrapWorkingSet();
  } catch {
    // empty store
  }

  ipcMain.handle(IPC_CHANNELS.SESSION_WORKING_SET_GET, async (event) => {
    const ownerId = ownerFromEvent(event);
    const { snapshot, membershipChanged } = filterIfCatalogOk(ownerId);
    if (membershipChanged) {
      try {
        sessionWorkingSet.saveToDisk();
      } catch (err) {
        console.error('[working-set] failed to persist ui-state.json', err);
      }
      broadcastOpenSet(snapshot, ownerId);
    }
    return snapshot;
  });

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS,
    async (event, payload: unknown) => {
      const parsed = sessionIdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_open_or_focus payload: ${parsed.error.message}`,
        );
      }
      const ownerId = ownerFromEvent(event);
      const catalog = tryListSessionCatalog();
      if (catalog.status === 'ok' && !catalog.ids.has(parsed.data.id)) {
        return sessionWorkingSet.getSnapshot(ownerId);
      }
      return workingSetOpenOrFocus(parsed.data.id, ownerId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_CLOSE,
    async (event, payload: unknown) => {
      const parsed = sessionIdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_close payload: ${parsed.error.message}`,
        );
      }
      const ownerId = ownerFromEvent(event);
      const owner = ownerId;
      return mutateAndPersist(owner, () => sessionWorkingSet.close(parsed.data.id, owner));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_REMOVE,
    async (event, payload: unknown) => {
      const parsed = sessionIdSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_remove payload: ${parsed.error.message}`,
        );
      }
      return workingSetRemove(parsed.data.id, ownerFromEvent(event));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS,
    async (event, payload: unknown) => {
      const parsed = setFocusSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(
          `Invalid session:working_set_set_focus payload: ${parsed.error.message}`,
        );
      }
      const ownerId = ownerFromEvent(event);
      const owner = ownerId;
      return mutateAndPersist(owner, () =>
        sessionWorkingSet.setFocus(parsed.data.id, owner),
      );
    },
  );
}

export function unregisterSessionWorkingSetIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_GET);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_CLOSE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_REMOVE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS);
  setWorkingSetBroadcast(null);
}
