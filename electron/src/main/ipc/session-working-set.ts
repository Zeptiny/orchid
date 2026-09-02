/**
 * Working-set IPC handlers plus the Electron broadcast wiring for the
 * host-side mutations (session/working-set-live).
 */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, type WorkingSetSnapshot } from '../../shared/types/ipc';
import { isEmbeddedLocalHostRunning } from '../host/local-host';
import { hostRequest } from './host-request';
import {
  bootstrapWorkingSet,
  setWorkingSetBroadcast,
} from '../session/working-set-live';
import { sessionWorkingSet } from '../session/working-set';

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
  // Fallback only: the embedded local host's HostServer owns working-set
  // broadcasting once it is running (per-connection → client window push).
  if (!isEmbeddedLocalHostRunning()) {
    setWorkingSetBroadcast(broadcastOpenSet);
    try {
      bootstrapWorkingSet();
    } catch {
      // empty store
    }
  }

  ipcMain.handle(IPC_CHANNELS.SESSION_WORKING_SET_GET, async (event) => {
    return hostRequest<WorkingSetSnapshot>(
      ownerFromEvent(event),
      IPC_CHANNELS.SESSION_WORKING_SET_GET,
    );
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
      return hostRequest<WorkingSetSnapshot>(
        ownerFromEvent(event),
        IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS,
        parsed.data,
      );
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
      return hostRequest<WorkingSetSnapshot>(
        ownerFromEvent(event),
        IPC_CHANNELS.SESSION_WORKING_SET_CLOSE,
        parsed.data,
      );
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
      return hostRequest<WorkingSetSnapshot>(
        ownerFromEvent(event),
        IPC_CHANNELS.SESSION_WORKING_SET_REMOVE,
        parsed.data,
      );
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
      return hostRequest<WorkingSetSnapshot>(
        ownerFromEvent(event),
        IPC_CHANNELS.SESSION_WORKING_SET_SET_FOCUS,
        parsed.data,
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
  if (!isEmbeddedLocalHostRunning()) setWorkingSetBroadcast(null);
}
