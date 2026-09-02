/**
 * Session IPC handlers — session:list, session:load, session:create,
 * session:delete, session:rename, workspace binding (get/pick/set/change_cwd).
 *
 * U5: machine-scoped handlers forward over the host protocol (`host/routing.ts`)
 * so the local machine speaks the same surface as a remote host. Fix #4 moved
 * the reasoning/tier config reads and writes onto that surface too (a window
 * driving a remote machine must read and write the remote's state). The
 * native folder dialog stays local, as do the re-exports other IPC modules use.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS, type SessionOpenResult } from '../../shared/types/ipc';
import { flattenSessionMessages, sessionForRenderer } from '../../shared/types/session';
import {
  getSessionManager,
  resolveBoundProjectPath,
  resolveWindowWorkspace,
} from '../session/singleton';
import {
  clearDraftReasoningOverrides,
} from '../session/draft-reasoning';
import {
  clearDraftTierOverrides,
} from '../session/draft-tier';
import { hostRequest } from './host-request';
import {
  bindProjectDirectory,
  resetWorkspaceWatcherReferences,
} from '../host/session-ops';
import {
  getDraftCwd,
  setDraftCwd,
  type WorkspaceInfo,
} from '../project/workspace';
import {
  sessionChangeCwdSchema,
  sessionChangeModelSchema,
  sessionDeleteSchema,
  sessionLoadSchema,
  sessionOpenSchema,
  sessionHistoryPageSchema,
  sessionRenameSchema,
  sessionSetWorkspaceSchema,
  sessionSetReasoningEffortSchema,
  sessionSetServiceTierSchema,
  sessionGetReasoningConfigSchema,
  sessionGetServiceTierConfigSchema,
} from './payload-schemas';

export {
  getSessionManager,
  resolveBoundProjectPath,
  resolveWindowWorkspace,
};

export { flattenSessionMessages, sessionForRenderer };

export { takeDraftReasoningOverride } from '../session/draft-reasoning';

// Workspace-binding + session-open core relocated to host/session-ops.ts
// (electron-free, shared with the headless host); re-exported for consumers.
export {
  bindProjectDirectory,
  reconcileClientWatcher as reconcileWindowWatcher,
  revokeProjectTrustForDir,
} from '../host/session-ops';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerSessionIPC(): void {
  // session:list — return all saved sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_LIST);
  });

  // session:load — load a session by ID; optionally set as active + seed history
  // Does NOT rewrite sticky default_project_dir (R4).
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (event, payload: unknown) => {
    const parsed = sessionLoadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:load payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_LOAD, parsed.data);
  });

  // session:open — activate a session and return its bounded renderer view in
  // one round-trip (session + loaded messages + live snapshot + workspace).
  // Replaces the prior peek + chat:snapshot + activate sequence so a switch
  // reads/parses the session file once and serializes it across IPC once.
  ipcMain.handle(IPC_CHANNELS.SESSION_OPEN, async (event, payload: unknown) => {
    const parsed = sessionOpenSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:open payload: ${parsed.error.message}`);
    }
    return hostRequest<SessionOpenResult>(String(event.sender.id), IPC_CHANNELS.SESSION_OPEN, parsed.data);
  });

  // session:history_page — bounded older-message hydration for one chain.
  // This never changes active selection or the full model-history cache.
  ipcMain.handle(IPC_CHANNELS.SESSION_HISTORY_PAGE, async (_event, payload: unknown) => {
    const parsed = sessionHistoryPageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:history_page payload: ${parsed.error.message}`);
    }
    return hostRequest(
      String(_event.sender.id),
      IPC_CHANNELS.SESSION_HISTORY_PAGE,
      parsed.data,
    );
  });

  // session:create — eagerly create + activate a session (writes to disk).
  // Prefer session:clear_active + first chat:send for draft UX; this remains
  // for tests and any callers that need an immediate empty session file.
  // Requires a valid workspace (draft or sticky); never process.cwd().
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_CREATE);
  });

  // session:clear_active — draft / new chat: no active session, no new file
  // Keeps any existing draft cwd; otherwise UI falls through to sticky default.
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAR_ACTIVE, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_CLEAR_ACTIVE);
  });

  // session:delete — delete a session
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (event, payload: unknown) => {
    const parsed = sessionDeleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:delete payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_DELETE, parsed.data);
  });

  // session:rename — rename a session
  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (event, payload: unknown) => {
    const parsed = sessionRenameSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:rename payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_RENAME, parsed.data);
  });

  // session:change_model — update model on the active session
  ipcMain.handle(IPC_CHANNELS.SESSION_CHANGE_MODEL, async (_event, payload: unknown) => {
    const parsed = sessionChangeModelSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:change_model payload: ${parsed.error.message}`);
    }

    return hostRequest(String(_event.sender.id), IPC_CHANNELS.SESSION_CHANGE_MODEL, parsed.data);
  });

  // session:get_workspace — resolve current workspace for this window.
  // Also the startup watcher seam: a fresh window whose workspace resolves
  // from the sticky default (no draft, no session) never goes through a bind
  // or an activation, so this first resolution is what attaches its watcher
  // reference. Idempotent — see reconcileWindowWatcher.
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_WORKSPACE, async (event) => {
    return hostRequest<WorkspaceInfo>(String(event.sender.id), IPC_CHANNELS.SESSION_GET_WORKSPACE);
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
    if (typeof event.sender.isDestroyed === 'function' && event.sender.isDestroyed()) {
      return workspace;
    }
    event.sender.send(IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
    return workspace;
  });

  // session:set_workspace — bind path without dialog (tests / programmatic)
  ipcMain.handle(IPC_CHANNELS.SESSION_SET_WORKSPACE, async (event, payload: unknown) => {
    const parsed = sessionSetWorkspaceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:set_workspace payload: ${parsed.error.message}`);
    }

    return hostRequest<WorkspaceInfo>(
      String(event.sender.id),
      IPC_CHANNELS.SESSION_SET_WORKSPACE,
      parsed.data,
    );
  });

  // session:change_cwd — legacy route retained for empty-session drafts.
  // A conversation that already has messages stays bound; choosing a new
  // folder opens a draft rather than mutating the old conversation.
  ipcMain.handle(IPC_CHANNELS.SESSION_CHANGE_CWD, async (event, payload: unknown) => {
    const parsed = sessionChangeCwdSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:change_cwd payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_CHANGE_CWD, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT, async (event, payload: unknown) => {
    const parsed = sessionSetReasoningEffortSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:set_reasoning_effort payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_SET_REASONING_EFFORT, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG, async (event, payload: unknown) => {
    const parsed = sessionGetReasoningConfigSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid session:get_reasoning_config payload: ${parsed.error.message}`);
    }
    // Fix #4: the active machine's host resolves its own session + provider
    // stores, so a remote-active window's picker never reads local state.
    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_GET_REASONING_CONFIG, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_SERVICE_TIER, async (event, payload: unknown) => {
    const parsed = sessionSetServiceTierSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:set_service_tier payload: ${parsed.error.message}`);
    }

    return hostRequest(String(event.sender.id), IPC_CHANNELS.SESSION_SET_SERVICE_TIER, parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG, async (event, payload: unknown) => {
    const parsed = sessionGetServiceTierConfigSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid session:get_service_tier_config payload: ${parsed.error.message}`);
    }

    return hostRequest(
      String(event.sender.id),
      IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG,
      parsed.data,
    );
  });
}

/**
 * Unregister session IPC handlers (for cleanup/testing).
 */
export function unregisterSessionIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_OPEN);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_HISTORY_PAGE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CLEAR_ACTIVE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_RENAME);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CHANGE_MODEL);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_GET_WORKSPACE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SET_WORKSPACE);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_CHANGE_CWD);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_SET_SERVICE_TIER);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG);
  clearDraftReasoningOverrides();
  clearDraftTierOverrides();
  // Watcher references (host/session-ops) are meaningless once these handlers
  // are gone (tests, shutdown); dropping them keeps the reconcile seam from
  // acting on stale state.
  resetWorkspaceWatcherReferences();
}

// Re-export draft helpers for tests that need to seed draft without IPC.
export { getDraftCwd, setDraftCwd };
export { clearDraftCwd } from '../project/workspace';
export { takeDraftPermissionOverride } from '../permissions/session-overrides';
