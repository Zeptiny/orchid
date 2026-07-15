import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import { z } from 'zod';
import { IPC_CHANNELS, type WorkingSetSnapshot } from '../../shared/types/ipc';
import { sessionWorkingSet } from '../session/working-set';
import { SESSIONS_DIR } from '../session/storage';
import { getSessionManager } from './session';

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

function mutateAndPersist(
  ownerId: string,
  run: () => WorkingSetSnapshot,
): WorkingSetSnapshot {
  const snapshot = run();
  try {
    sessionWorkingSet.saveToDisk();
  } catch (err) {
    console.error('[working-set] failed to persist ui-state.json', err);
  }
  broadcastOpenSet(snapshot, ownerId);
  return snapshot;
}

export type SessionCatalog =
  | { status: 'ok'; ids: Set<string> }
  | { status: 'io_error'; error: string };

/** Distinguish true empty catalog from sessions-dir I/O failure. */
export function tryListSessionCatalog(): SessionCatalog {
  try {
    fs.readdirSync(SESSIONS_DIR);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'io_error', error: message };
  }
  try {
    const manager = getSessionManager();
    return {
      status: 'ok',
      ids: new Set(manager.listSaved().map((s) => s.id)),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'io_error', error: message };
  }
}

function filterIfCatalogOk(ownerId: string): WorkingSetSnapshot {
  const catalog = tryListSessionCatalog();
  if (catalog.status === 'io_error') {
    console.error('[working-set] skip filterExisting; session list I/O failed', catalog.error);
    return sessionWorkingSet.getSnapshot(ownerId);
  }
  return sessionWorkingSet.filterExisting(catalog.ids);
}

export function bootstrapWorkingSet(): WorkingSetSnapshot {
  sessionWorkingSet.loadFromDisk();
  return mutateAndPersist('__primary__', () => filterIfCatalogOk('__primary__'));
}

export function registerSessionWorkingSetIPC(): void {
  try {
    sessionWorkingSet.loadFromDisk();
    mutateAndPersist('__primary__', () => filterIfCatalogOk('__primary__'));
  } catch {
    // empty store
  }

  ipcMain.handle(IPC_CHANNELS.SESSION_WORKING_SET_GET, async (event) => {
    const ownerId = ownerFromEvent(event);
    return filterIfCatalogOk(ownerId);
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
      return mutateAndPersist(ownerId, () =>
        sessionWorkingSet.openOrFocus(parsed.data.id, ownerId),
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
      const ownerId = ownerFromEvent(event);
      return mutateAndPersist(ownerId, () =>
        sessionWorkingSet.close(parsed.data.id, ownerId),
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
      const ownerId = ownerFromEvent(event);
      return mutateAndPersist(ownerId, () =>
        sessionWorkingSet.remove(parsed.data.id, ownerId),
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
      const ownerId = ownerFromEvent(event);
      return mutateAndPersist(ownerId, () =>
        sessionWorkingSet.setFocus(parsed.data.id, ownerId),
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
}

/** Called from session:load activate path so open-set stays in sync. */
export function workingSetOpenOrFocus(
  id: string,
  ownerId?: string,
): WorkingSetSnapshot {
  const owner = ownerId ?? '__primary__';
  return mutateAndPersist(owner, () => sessionWorkingSet.openOrFocus(id, owner));
}

/** Called from session:delete so ghost tabs disappear. */
export function workingSetRemove(id: string, ownerId?: string): WorkingSetSnapshot {
  const owner = ownerId ?? '__primary__';
  return mutateAndPersist(owner, () => sessionWorkingSet.remove(id, owner));
}

/** Draft mode: clear focused id without removing open session tabs. */
export function workingSetClearFocus(ownerId?: string): WorkingSetSnapshot {
  const owner = ownerId ?? '__primary__';
  return mutateAndPersist(owner, () => sessionWorkingSet.setFocus(null, owner));
}

export function getWorkingSetSnapshot(ownerId?: string): WorkingSetSnapshot {
  return sessionWorkingSet.getSnapshot(ownerId ?? '__primary__');
}
