/**
 * Session IPC handlers — session:list, session:load, session:create,
 * session:delete, session:rename.
 *
 * Wraps SessionManager from U5 with zod-validated payloads.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { Message } from '../../shared/types/message';
import type { Session } from '../../shared/types/session';
import { SessionManager } from '../session/manager';
import { getConfig } from '../config/loader';
import { clearChatHistory, seedChatHistory } from './chat-history';

/**
 * Lazily resolve forceAbortChat to avoid a circular init dependency:
 * chat.ts → getSessionManager (session.ts) → forceAbortChat (chat.ts).
 */
function abortChatForWindow(windowId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { forceAbortChat } = require('./chat') as typeof import('./chat');
  forceAbortChat(windowId);
}

// ── Zod validation schemas ───────────────────────────────────────────────────

const sessionLoadSchema = z.object({
  id: z.string().uuid(),
  /** When false, peek from disk without activating or seeding chat history. */
  activate: z.boolean().optional().default(true),
});

const sessionDeleteSchema = z.object({
  id: z.string().uuid(),
});

const sessionRenameSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
});

const sessionChangeModelSchema = z.object({
  id: z.string().uuid(),
  model: z.string().min(1),
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

/** Flatten all chain messages for UI + continue-chat history (chronological). */
export function flattenSessionMessages(session: Session): Message[] {
  return session.chains.flatMap((chain) => [...chain.messages]);
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerSessionIPC(): void {
  // session:list — return all saved sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    const manager = getSessionManager();
    return manager.listSaved();
  });

  // session:load — load a session by ID; optionally set as active + seed history
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (event, payload: unknown) => {
    const parsed = sessionLoadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:load payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    const { id, activate } = parsed.data;
    const windowId = String(event.sender.id);

    // Read-only peek (todos / subagents refresh) — do not switch or reseed.
    if (!activate) {
      return manager.load(id);
    }

    // Drop any in-flight stream so chunks from the previous session cannot
    // leak into the newly selected session's UI.
    abortChatForWindow(windowId);

    const session = manager.switchTo(id);

    // Seed history with ALL chains (matches renderer flatten) so the next
    // chat:send continues the full conversation, not only the active chain.
    if (session) {
      seedChatHistory(windowId, flattenSessionMessages(session));
    } else {
      clearChatHistory(windowId);
    }

    return session;
  });

  // session:create — eagerly create + activate a session (writes to disk).
  // Prefer session:clear_active + first chat:send for draft UX; this remains
  // for tests and any callers that need an immediate empty session file.
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (event) => {
    const config = getConfig();
    const manager = getSessionManager();
    const windowId = String(event.sender.id);
    abortChatForWindow(windowId);
    const session = manager.create(config.default_model);
    clearChatHistory(windowId);
    event.sender.send(IPC_CHANNELS.SESSION_CREATED, { session });
    return session;
  });

  // session:clear_active — draft / new chat: no active session, no new file
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAR_ACTIVE, async (event) => {
    const manager = getSessionManager();
    const windowId = String(event.sender.id);
    abortChatForWindow(windowId);
    manager.clearActive();
    clearChatHistory(windowId);
    return { status: 'cleared' };
  });

  // session:delete — delete a session
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (event, payload: unknown) => {
    const parsed = sessionDeleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:delete payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    const wasActive = manager.getActive()?.id === parsed.data.id;
    const deleted = manager.delete(parsed.data.id);
    if (deleted && wasActive) {
      const windowId = String(event.sender.id);
      abortChatForWindow(windowId);
      clearChatHistory(windowId);
    }
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

  // session:change_model — update model on the active session
  ipcMain.handle(IPC_CHANNELS.SESSION_CHANGE_MODEL, async (_event, payload: unknown) => {
    const parsed = sessionChangeModelSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:change_model payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    manager.changeModel(parsed.data.id, parsed.data.model);
    const active = manager.getActive();
    if (!active || active.id !== parsed.data.id) {
      return { status: 'not_active' };
    }
    return { status: 'changed', model: active.model };
  });
}

/**
 * Unregister session IPC handlers (for cleanup/testing).
 */
export function unregisterSessionIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CLEAR_ACTIVE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_RENAME);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CHANGE_MODEL);
}
