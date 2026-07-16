/**
 * Session IPC handlers — session:list, session:load, session:create,
 * session:delete, session:rename, workspace binding (get/pick/set/change_cwd).
 *
 * Wraps SessionManager from U5 with zod-validated payloads.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { flattenSessionMessages } from '../../shared/types/session';
import { SessionManager } from '../session/manager';
import { getConfig } from '../config/loader';
import { clearChatHistory, seedChatHistory } from './chat-history';
import {
  clearDraftCwd,
  getDraftCwd,
  isWorkspaceBound,
  requireValidProjectDirectory,
  resolveWorkspace,
  setDraftCwd,
  updateStickyDefaultProjectDir,
  type WorkspaceInfo,
} from '../project/workspace';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { removeSessionActivity } from './session-activity';
import {
  workingSetClearFocus,
  workingSetOpenOrFocus,
  workingSetRemove,
} from './session-working-set';
import {
  sessionChangeCwdSchema,
  sessionChangeModelSchema,
  sessionDeleteSchema,
  sessionLoadSchema,
  sessionRenameSchema,
  sessionSetWorkspaceSchema,
} from './payload-schemas';

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

export { flattenSessionMessages };

/**
 * Resolve workspace for a window using draft + active session + sticky default.
 */
export function resolveWindowWorkspace(windowId: string): WorkspaceInfo {
  const active = getSessionManager().getActive(windowId);
  return resolveWorkspace(windowId, {
    sessionCwd: active?.cwd ?? null,
    stickyDefault: getConfig().default_project_dir,
  });
}

/**
 * Bound project path for IPC tools/indexers: draft → session → sticky, only when bound.
 */
export function resolveBoundProjectPath(windowId?: string): string | null {
  try {
    const info = resolveWindowWorkspace(windowId ?? '');
    if (isWorkspaceBound(info) && info.cwd != null) {
      return info.cwd;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Bind a validated absolute project directory as the current workspace.
 *
 * - If an active session exists: update session.cwd via changeCwd.
 * - Otherwise: store as draft for this window.
 * - Always updates sticky default_project_dir (intentional pick).
 */
export async function bindProjectDirectory(
  windowId: string,
  dir: string,
): Promise<WorkspaceInfo> {
  const canonical = requireValidProjectDirectory(dir);

  await updateStickyDefaultProjectDir(canonical);

  const manager = getSessionManager();
  const active = manager.getActive(windowId);
  if (active) {
    if (active.chains.length === 0) {
      manager.changeCwd(active.id, canonical);
      clearDraftCwd(windowId);
    } else {
      // A conversation remains bound to the project it started in. Picking a
      // different folder opens a draft there without moving or cancelling it.
      manager.clearActive(windowId);
      workingSetClearFocus(windowId);
      setDraftCwd(windowId, canonical);
    }
  } else {
    setDraftCwd(windowId, canonical);
  }

  return resolveWindowWorkspace(windowId);
}

/** Emit session:workspace_changed to the sender window. */
function emitWorkspaceChanged(
  sender: Electron.WebContents,
  workspace: WorkspaceInfo,
): void {
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
    return;
  }
  sender.send(IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerSessionIPC(): void {
  // session:list — return all saved sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    const manager = getSessionManager();
    return manager.listSaved();
  });

  // session:load — load a session by ID; optionally set as active + seed history
  // Does NOT rewrite sticky default_project_dir (R4).
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

    // Selecting a session is view navigation. Work in the previously selected
    // session continues and remains addressed by its own session id.
    const session = manager.switchTo(id, windowId);

    if (session) {
      workingSetOpenOrFocus(session.id, windowId);
    } else {
      // Drop ghost tabs when the session cannot be loaded (missing/corrupt).
      workingSetRemove(id, windowId);
    }

    // Session owns workspace now — clear draft so it doesn't shadow session.cwd.
    // Sticky default is intentionally NOT updated on load (R4).
    clearDraftCwd(windowId);

    // Seed history with ALL chains (matches renderer flatten) so the next
    // chat:send continues the full conversation, not only the active chain.
    if (session) {
      seedChatHistory(session.id, flattenSessionMessages(session));
    } else {
      clearChatHistory(id);
    }

    // Project config and definitions are resolved from each turn's captured
    // runtime. Selecting a session must not replace process-wide layers that
    // another running session could still depend on.
    const workspace = resolveWindowWorkspace(windowId);

    emitWorkspaceChanged(event.sender, workspace);
    return session;
  });

  // session:create — eagerly create + activate a session (writes to disk).
  // Prefer session:clear_active + first chat:send for draft UX; this remains
  // for tests and any callers that need an immediate empty session file.
  // Requires a valid workspace (draft or sticky); never process.cwd().
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (event) => {
    const manager = getSessionManager();
    const windowId = String(event.sender.id);

    const workspace = resolveWindowWorkspace(windowId);
    if (!isWorkspaceBound(workspace) || workspace.cwd == null) {
      throw new Error(
        'Cannot create session: no project folder selected. Choose a folder first.',
      );
    }

    const config = getProjectRuntimeRegistry().get(workspace.cwd).config;
    const session = manager.create(
      config.default_model,
      { cwd: workspace.cwd },
      windowId,
    );
    // Draft was promoted into the session.
    clearDraftCwd(windowId);
    clearChatHistory(session.id);
    workingSetOpenOrFocus(session.id, windowId);
    event.sender.send(IPC_CHANNELS.SESSION_CREATED, { session });
    emitWorkspaceChanged(event.sender, resolveWindowWorkspace(windowId));
    return session;
  });

  // session:clear_active — draft / new chat: no active session, no new file
  // Keeps any existing draft cwd; otherwise UI falls through to sticky default.
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAR_ACTIVE, async (event) => {
    const manager = getSessionManager();
    const windowId = String(event.sender.id);
    const selected = manager.getActive(windowId);
    if (selected?.cwd) setDraftCwd(windowId, selected.cwd);
    manager.clearActive(windowId);
    workingSetClearFocus(windowId);
    const workspace = resolveWindowWorkspace(windowId);
    emitWorkspaceChanged(event.sender, workspace);
    return { status: 'cleared' };
  });

  // session:delete — delete a session
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (event, payload: unknown) => {
    const parsed = sessionDeleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:delete payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    const wasActive = manager.getActive(String(event.sender.id))?.id === parsed.data.id;
    // A deleted background session must not keep spending provider/tool work or
    // recreate activity after it disappears from the catalog.
    const { forceStopSession } = await import('./chat');
    forceStopSession(parsed.data.id);
    const deleted = manager.delete(parsed.data.id);
    if (deleted) {
      removeSessionActivity(parsed.data.id);
      workingSetRemove(parsed.data.id, String(event.sender.id));
    }
    if (deleted && wasActive) {
      const windowId = String(event.sender.id);
      clearChatHistory(parsed.data.id);
      emitWorkspaceChanged(event.sender, resolveWindowWorkspace(windowId));
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
    const existing = manager.getSession(parsed.data.id);
    if (!existing) {
      return { status: 'not_found' };
    }
    if (existing.name === parsed.data.name) {
      return { status: 'unchanged', name: existing.name };
    }

    manager.rename(parsed.data.id, parsed.data.name);
    const after = manager.getSession(parsed.data.id);
    if (!after || after.name !== parsed.data.name) {
      return { status: 'not_active' };
    }

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
    const existing = manager.getSession(parsed.data.id);
    if (!existing) {
      return { status: 'not_found' };
    }

    const nextLabel = parsed.data.modelLabel ?? parsed.data.selection?.modelId ?? null;
    const sameSelection =
      (existing.selection === null && parsed.data.selection === null) ||
      (existing.selection !== null &&
        parsed.data.selection !== null &&
        existing.selection.connectionId === parsed.data.selection.connectionId &&
        existing.selection.modelId === parsed.data.selection.modelId);
    if (sameSelection && existing.modelLabel === nextLabel) {
      return {
        status: 'unchanged',
        selection: existing.selection,
        modelLabel: existing.modelLabel,
      };
    }

    manager.changeModel(parsed.data.id, parsed.data.selection, nextLabel);
    const after = manager.getSession(parsed.data.id);
    if (!after) {
      return { status: 'not_found' };
    }
    const afterSame =
      (after.selection === null && parsed.data.selection === null) ||
      (after.selection !== null &&
        parsed.data.selection !== null &&
        after.selection.connectionId === parsed.data.selection.connectionId &&
        after.selection.modelId === parsed.data.selection.modelId);
    if (!afterSame || after.modelLabel !== nextLabel) {
      return { status: 'not_active' };
    }
    return {
      status: 'changed',
      selection: after.selection,
      modelLabel: after.modelLabel,
    };
  });

  // session:get_workspace — resolve current workspace for this window
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_WORKSPACE, async (event) => {
    const windowId = String(event.sender.id);
    return resolveWindowWorkspace(windowId);
  });

  // session:pick_project_dir — native directory dialog → bind + sticky
  ipcMain.handle(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR, async (event) => {
    const windowId = String(event.sender.id);
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOpts = {
      properties: ['openDirectory' as const],
      title: 'Choose project folder',
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);

    if (result.canceled || !result.filePaths[0]) {
      // User cancelled — return current workspace unchanged.
      return resolveWindowWorkspace(windowId);
    }

    const workspace = await bindProjectDirectory(windowId, result.filePaths[0]);
    emitWorkspaceChanged(event.sender, workspace);
    return workspace;
  });

  // session:set_workspace — bind path without dialog (tests / programmatic)
  ipcMain.handle(IPC_CHANNELS.SESSION_SET_WORKSPACE, async (event, payload: unknown) => {
    const parsed = sessionSetWorkspaceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:set_workspace payload: ${parsed.error.message}`);
    }

    const windowId = String(event.sender.id);
    const workspace = await bindProjectDirectory(windowId, parsed.data.cwd);
    emitWorkspaceChanged(event.sender, workspace);
    return workspace;
  });

  // session:change_cwd — legacy route retained for empty-session drafts.
  // A conversation that already has messages stays bound; choosing a new
  // folder opens a draft rather than mutating the old conversation.
  ipcMain.handle(IPC_CHANNELS.SESSION_CHANGE_CWD, async (event, payload: unknown) => {
    const parsed = sessionChangeCwdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:change_cwd payload: ${parsed.error.message}`);
    }

    const windowId = String(event.sender.id);
    const manager = getSessionManager();
    const active = manager.getActive(windowId);
    if (!active || active.id !== parsed.data.id) {
      throw new Error('Cannot change project for a session that is not selected.');
    }

    const hadConversation = active.chains.length > 0;
    const workspace = await bindProjectDirectory(windowId, parsed.data.cwd);
    emitWorkspaceChanged(event.sender, workspace);
    return hadConversation ? null : manager.getActive(windowId);
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
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_GET_WORKSPACE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SET_WORKSPACE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CHANGE_CWD);
}

// Re-export draft helper for tests that need to seed draft without IPC.
export { getDraftCwd, setDraftCwd, clearDraftCwd };
