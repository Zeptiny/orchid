/**
 * Session IPC handlers — session:list, session:load, session:create,
 * session:delete, session:rename.
 *
 * Wraps SessionManager from U5 with zod-validated payloads.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { SessionManager } from '../session/manager';
import { getConfig } from '../config/loader';

// ── Zod validation schemas ───────────────────────────────────────────────────

const sessionLoadSchema = z.object({
  id: z.string().min(1),
});

const sessionDeleteSchema = z.object({
  id: z.string().min(1),
});

const sessionRenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

// ── Singleton session manager ────────────────────────────────────────────────

let sessionManager: SessionManager | null = null;

/**
 * Get the singleton SessionManager instance.
 *
 * Creates one lazily on first call. Exported so that other IPC modules
 * (e.g. chat.ts for auto-naming) can share the same instance.
 */
export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerSessionIPC(): void {
  // session:list — return all saved sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    const manager = getSessionManager();
    return manager.listSaved();
  });

  // session:load — load a session by ID and set as active
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_event, payload: unknown) => {
    const parsed = sessionLoadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:load payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    return manager.switchTo(parsed.data.id);
  });

  // session:create — create a new session
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async () => {
    const config = getConfig();
    const manager = getSessionManager();
    return manager.create(config.default_model);
  });

  // session:delete — delete a session
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, payload: unknown) => {
    const parsed = sessionDeleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:delete payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    const deleted = manager.delete(parsed.data.id);
    return { status: deleted ? 'deleted' : 'not_found' };
  });

  // session:rename — rename a session
  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (event, payload: unknown) => {
    const parsed = sessionRenameSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:rename payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    manager.rename(parsed.data.id, parsed.data.name);

    // Push rename event to renderer so sidebar/list updates reactively
    event.sender.send(IPC_CHANNELS.SESSION_RENAMED, {
      id: parsed.data.id,
      name: parsed.data.name,
    });

    return { status: 'renamed' };
  });
}

/**
 * Unregister session IPC handlers (for cleanup/testing).
 */
export function unregisterSessionIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_RENAME);
}
