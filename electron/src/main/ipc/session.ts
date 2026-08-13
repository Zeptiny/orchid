/**
 * Session IPC handlers — session:list, session:load, session:create,
 * session:delete, session:rename, workspace binding (get/pick/set/change_cwd).
 *
 * Wraps SessionManager from U5 with zod-validated payloads.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { flattenSessionMessages, sessionForRenderer } from '../../shared/types/session';
import { lastChainError } from '../../shared/types/chain';
import type { ModelSelection } from '../../shared/types/provider';
import {
  getSessionManager,
  resolveBoundProjectPath,
  resolveWindowWorkspace,
} from '../session/singleton';
import {
  clearDraftReasoningOverrides,
  getDraftReasoningOverride,
  setDraftReasoningOverride,
  takeDraftReasoningOverride,
} from '../session/draft-reasoning';
import {
  clearDraftTierOverrides,
  getDraftTierOverride,
  setDraftTierOverride,
} from '../session/draft-tier';
import { getConfig } from '../config/loader';
import { clearChatHistory, seedChatHistory } from './chat-history';
import { sendSessionEvent } from './chat/events';
import {
  clearDraftCwd,
  getDraftCwd,
  isWorkspaceBound,
  requireValidProjectDirectory,
  setDraftCwd,
  updateStickyDefaultProjectDir,
  type WorkspaceInfo,
} from '../project/workspace';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { canonicalizeProjectDirectory } from '../project/path';
import {
  getProjectTrustState,
  revokeProjectTrust,
  revokeProjectTrustRaw,
} from '../project/trust';
import { listConnectionModelRows } from '../providers/facets/discovery';
import { groupTierVariantRows } from '../providers/facets/tiers';
import { invalidateProjectMCPManagers } from '../mcp/project-registry';
import { cancelIndex } from '../rag/indexer';
import { clearNextRequestStop } from './next-request-stop';
import { removeSessionActivity } from './session-activity';
import {
  takeDraftPermissionOverride,
  hydrateSessionPermissionOverride,
} from '../permissions/session-overrides';
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
  sessionOpenSchema,
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

/**
 * Model selection to reason about in draft mode (no active session):
 * bound project default_model → user default_model → null.
 */
function resolveDraftModelSelection(windowId: string): ModelSelection | null {
  try {
    const info = resolveWindowWorkspace(windowId);
    if (info.cwd) {
      const projectDefault = getProjectRuntimeRegistry().get(info.cwd).config.default_model;
      if (projectDefault) return projectDefault;
    }
  } catch {
    // Workspace/runtime unresolvable — fall through to the user default.
  }
  return getConfig().default_model ?? null;
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
  const priorWorkspace = resolveWindowWorkspace(windowId);

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

  if (priorWorkspace.cwd && priorWorkspace.cwd !== canonical) {
    const {
      clearFunctionHashesForSession,
      clearFunctionHashesForWorkspace,
    } = await import('../tools/ast/get-function.js');
    clearFunctionHashesForWorkspace(priorWorkspace.cwd);
    if (active && active.chains.length === 0) {
      clearFunctionHashesForSession(active.id);
    }
  }

  return resolveWindowWorkspace(windowId);
}

/**
 * Revoke trust for one project and stop all of its activity.
 *
 * The trust record drops first so concurrent gate reads fail closed, then the
 * cached runtime and MCP managers are invalidated (lease-aware shutdown
 * retires them as running turns finish), any in-flight RAG indexing is
 * cancelled, and every session bound to the directory is force-stopped.
 *
 * A directory that can no longer be canonicalized (deleted/moved) cannot be
 * runtime-invalidated, but its store entry — keyed by the exact path string —
 * is still removed so the settings listing can recover.
 */
export async function revokeProjectTrustForDir(projectDir: string): Promise<void> {
  const canonical = canonicalizeProjectDirectory(projectDir);
  if (canonical == null) {
    try {
      revokeProjectTrustRaw(projectDir);
    } catch (error) {
      console.warn(`Failed to remove trust record for '${projectDir}':`, error);
    }
    return;
  }

  revokeProjectTrust(canonical);
  getProjectRuntimeRegistry().invalidate(canonical);
  invalidateProjectMCPManagers(canonical);

  // Trust just dropped — an in-flight index run for this directory must stop.
  void cancelIndex(canonical).catch(() => {});

  const boundSessionIds = getSessionManager()
    .listSaved()
    .filter((summary) => summary.cwd === canonical)
    .map((summary) => summary.id);
  if (boundSessionIds.length === 0) return;

  // Dynamic import avoids the session.ts <-> chat.ts circular dependency.
  // The store record is already deleted, so a load failure must not reject.
  let forceStopSession: ((sessionId: string) => unknown) | null = null;
  try {
    ({ forceStopSession } = await import('./chat.js'));
  } catch (error) {
    console.warn(`Failed to load chat module while revoking trust for '${canonical}':`, error);
  }
  if (forceStopSession == null) return;

  for (const sessionId of boundSessionIds) {
    // One failing session stop must not prevent the remaining stops.
    try {
      forceStopSession(sessionId);
    } catch (error) {
      console.warn(`Failed to force-stop session '${sessionId}' during trust revocation:`, error);
    }
  }
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

/**
 * Materialize a session's persisted subagent chains back into the runtime
 * manager so the main agent regains its subagent context after an app restart
 * (records live only in memory for the current launch). The task is detached
 * from navigation; send and lifecycle operations join the same readiness
 * promise. Session open must not fail because hydration could not run, so
 * errors are logged and left retryable.
 */
function startOpenedSessionSubagentHydration(
  sessionId: string,
  windowId: string,
): void {
  void (async () => {
    const { getSubagentManager } = await import('../tools/index.js');
    const { awaitSessionSubagentHydration } = await import('../tools/subagent/hydrate.js');
    const result = await awaitSessionSubagentHydration(
      getSubagentManager(),
      sessionId,
      { windowId },
    );
    if (result.agentMissing.length > 0) {
      console.warn(
        `[subagents] session-open hydration skipped records with missing agent definitions for ${sessionId}:`,
        result.agentMissing,
      );
    }
  })().catch((error) => {
    console.warn(`[subagents] session-open hydration failed for ${sessionId}:`, error);
  });
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
      const session = manager.load(id);
      return session ? sessionForRenderer(session) : null;
    }

    const releasedDraftCwd = getDraftCwd(windowId);
    // Selecting a session is view navigation. Work in the previously selected
    // session continues and remains addressed by its own session id.
    const session = manager.switchTo(id, windowId);

    if (session) {
      workingSetOpenOrFocus(session.id, windowId);
      // Hydrate the in-memory permission gate map from the persisted session
      // record so the override survives restarts.
      hydrateSessionPermissionOverride(session.id, session.permissionMode);
      // Restore the runtime subagent records (prompt context + wait/interrupt)
      // after a restart; the renderer already renders the stored rows.
      startOpenedSessionSubagentHydration(session.id, windowId);
    } else {
      // Drop ghost tabs when the session cannot be loaded (missing/corrupt).
      workingSetRemove(id, windowId);
    }

    // Session owns workspace now — clear draft so it doesn't shadow session.cwd.
    // Sticky default is intentionally NOT updated on load (R4).
    clearDraftCwd(windowId);
    if (releasedDraftCwd) {
      const { clearFunctionHashesForWorkspace } = await import('../tools/ast/get-function.js');
      clearFunctionHashesForWorkspace(releasedDraftCwd);
    }

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
    return session ? sessionForRenderer(session) : null;
  });

  // session:open — activate a session and return its full view payload in one
  // round-trip (session + flattened messages + live snapshot + workspace).
  // Replaces the prior peek + chat:snapshot + activate sequence so a switch
  // reads/parses the session file once and serializes it across IPC once.
  ipcMain.handle(IPC_CHANNELS.SESSION_OPEN, async (event, payload: unknown) => {
    const parsed = sessionOpenSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:open payload: ${parsed.error.message}`);
    }

    const manager = getSessionManager();
    const { id } = parsed.data;
    const windowId = String(event.sender.id);

    // Selecting a session is view navigation. Work in the previously selected
    // session continues and remains addressed by its own session id.
    const session = manager.switchTo(id, windowId);

    if (session) {
      workingSetOpenOrFocus(session.id, windowId);
      hydrateSessionPermissionOverride(session.id, session.permissionMode);
      // Restore the runtime subagent records (prompt context + wait/interrupt)
      // after a restart; the renderer already renders the stored rows.
      startOpenedSessionSubagentHydration(session.id, windowId);
    } else {
      // Drop ghost tabs when the session cannot be loaded (missing/corrupt).
      workingSetRemove(id, windowId);
    }

    // Session owns workspace now — clear draft so it doesn't shadow session.cwd.
    // Sticky default is intentionally NOT updated on open (matches session:load).
    clearDraftCwd(windowId);

    // Flatten once and reuse for both the seeded chat history (so the next
    // chat:send continues the full conversation) and the renderer payload.
    const messages = session ? flattenSessionMessages(session) : [];
    if (session) {
      seedChatHistory(session.id, messages);
    } else {
      clearChatHistory(id);
    }

    const workspace = resolveWindowWorkspace(windowId);
    emitWorkspaceChanged(event.sender, workspace);

    // Live in-flight snapshot (chat.ts owns the active-agent registry). Dynamic
    // import avoids the session.ts <-> chat.ts circular dependency.
    const { getLiveChatSnapshot } = await import('./chat.js');
    const live = getLiveChatSnapshot(id);

    return {
      session: session ? sessionForRenderer(session) : null,
      messages,
      live,
      workspace,
      lastChainError: session && !live ? lastChainError(session.chains) : null,
    };
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

    if (getProjectTrustState(workspace.cwd) !== 'trusted') {
      throw new Error(
        'Cannot create session: project folder is not trusted. Trust the project first.',
      );
    }

    const config = getProjectRuntimeRegistry().get(workspace.cwd).config;
    const created = manager.create(
      config.default_model,
      { cwd: workspace.cwd },
      windowId,
    );
    const draftOverride = takeDraftReasoningOverride(windowId);
    if (draftOverride !== undefined) {
      manager.setReasoningEffortOverride(created.id, draftOverride);
    }
    const draftPermission = takeDraftPermissionOverride(windowId);
    if (draftPermission !== undefined) {
      manager.setPermissionMode(created.id, draftPermission);
    }
    const session = manager.getSession(created.id) ?? created;
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
    const [
      { forceStopSession },
      { clearPermissionSessionState },
      { clearToolCallHistoryForSession },
      { clearFunctionHashesForSession },
    ] = await Promise.all([
      import('./chat.js'),
      import('./permission.js'),
      import('../permissions/history.js'),
      import('../tools/ast/get-function.js'),
    ]);
    forceStopSession(parsed.data.id);
    clearPermissionSessionState(parsed.data.id);
    clearToolCallHistoryForSession(parsed.data.id);
    clearFunctionHashesForSession(parsed.data.id);
    clearNextRequestStop(parsed.data.id);
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

    // Push rename event to every window currently viewing this session.
    sendSessionEvent(event.sender, parsed.data.id, IPC_CHANNELS.SESSION_RENAMED, {
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

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_REASONING_EFFORT, async (event, payload: unknown) => {
    const parsed = sessionSetReasoningEffortSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:set_reasoning_effort payload: ${parsed.error.message}`);
    }

    const windowId = String(event.sender.id);
    const manager = getSessionManager();
    const active = manager.getActive(windowId);
    if (!active) {
      // Draft mode: no session file yet — park the override until one exists.
      setDraftReasoningOverride(windowId, parsed.data.effort);
      return { status: 'ok' };
    }

    manager.setReasoningEffortOverride(active.id, parsed.data.effort);
    return { status: 'ok' };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_REASONING_CONFIG, async (event, payload: unknown) => {
    const parsed = sessionGetReasoningConfigSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid session:get_reasoning_config payload: ${parsed.error.message}`);
    }
    const draftSelection = parsed.data?.selection ?? null;
    const windowId = String(event.sender.id);
    const manager = getSessionManager();
    const active = manager.getActive(windowId);
    // Draft mode: prefer the renderer's current picker selection so switching
    // models in a draft (no session yet) immediately updates reasoning options.
    // Falls back to the project/default model for backward compat when no
    // selection is supplied.
    const selection = active?.selection ?? draftSelection ?? resolveDraftModelSelection(windowId);
    const override = active
      ? active.reasoningEffortOverride
      : getDraftReasoningOverride(windowId);

    if (!selection) {
      return { levels: [], default: null, override, supportsReasoning: false };
    }

    const { getProviderConnectionStore, getProviderCatalogStore } = await import('../providers/runtime-context.js');
    const { resolveModelSelection } = await import('../providers/resolver.js');

    const connections = await getProviderConnectionStore().list();
    const definitions = getProviderCatalogStore().getProviderDefinitions();
    const resolution = resolveModelSelection(selection, connections, definitions);

    if (resolution.kind !== 'resolved') {
      return { levels: [], default: null, override, supportsReasoning: false };
    }

    const { connection, model } = resolution;
    const supportsReasoning = model.capabilities?.reasoning ?? false;
    const modelConfig = connection.reasoningConfig?.[selection.modelId];

    return {
      levels: modelConfig?.levels ?? [],
      default: modelConfig?.default ?? null,
      override,
      supportsReasoning,
    };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_SERVICE_TIER, async (event, payload: unknown) => {
    const parsed = sessionSetServiceTierSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid session:set_service_tier payload: ${parsed.error.message}`);
    }

    const windowId = String(event.sender.id);
    const manager = getSessionManager();
    const active = manager.getActive(windowId);
    if (!active) {
      // Draft mode: park the override until a session exists.
      setDraftTierOverride(windowId, parsed.data.tier);
      return { status: 'ok' };
    }

    manager.setTierOverride(active.id, parsed.data.tier);
    return { status: 'ok' };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG, async (event, payload: unknown) => {
    const parsed = sessionGetServiceTierConfigSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid session:get_service_tier_config payload: ${parsed.error.message}`);
    }
    const draftSelection = parsed.data?.selection ?? null;
    const empty = { mechanism: null, tiers: [], selected: null, override: null, effective: null };
    const windowId = String(event.sender.id);
    const manager = getSessionManager();
    const active = manager.getActive(windowId);
    const selection = active?.selection ?? draftSelection ?? resolveDraftModelSelection(windowId);
    const override = active ? active.tierOverride : getDraftTierOverride(windowId);

    if (!selection) return { ...empty, override };

    const { getProviderConnectionStore, getProviderCatalogStore } = await import('../providers/runtime-context.js');
    const { resolveModelSelection } = await import('../providers/resolver.js');
    const { getProviderDriverRegistry } = await import('../providers/runtime-context.js');

    const connections = await getProviderConnectionStore().list();
    const definitions = getProviderCatalogStore().getProviderDefinitions();
    const resolution = resolveModelSelection(selection, connections, definitions);
    if (resolution.kind !== 'resolved') return { ...empty, override };

    const driver = getProviderDriverRegistry().get(resolution.provider.id);
    const mechanism = driver?.tierMechanism;
    if (!mechanism) return { ...empty, override };

    const selected = resolution.connection.tierSelections?.[selection.modelId] ?? null;
    // Variant-mechanism tiers are offered only when the variant model id is
    // actually present for the active model; selecting an absent variant would
    // rewrite the request to a model id the provider does not serve (R20).
    const variantTierIds = mechanism.kind === 'model-name-variants'
      ? groupTierVariantRows(
          listConnectionModelRows(resolution.connection, resolution.provider),
          mechanism,
        ).variantTiersByBase.get(resolution.model.id)
      : undefined;
    if (mechanism.kind === 'model-name-variants' && variantTierIds === undefined) {
      return { ...empty, override };
    }
    const tiers = mechanism.tiers
      .filter((tier) => variantTierIds === undefined || variantTierIds.includes(tier.id))
      .map((tier) => {
        const requiresStreaming = mechanism.kind === 'model-name-variants'
          && (tier as { requiresStreaming?: boolean }).requiresStreaming === true;
        return {
          id: tier.id,
          displayName: tier.displayName ?? null,
          description: tier.description ?? null,
          ...(requiresStreaming ? { requiresStreaming: true } : {}),
        };
      });
    const effective = override ?? selected ?? null;
    return {
      mechanism: mechanism.kind,
      tiers,
      selected,
      override,
      effective,
    };
  });
}

/**
 * Unregister session IPC handlers (for cleanup/testing).
 */
export function unregisterSessionIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD);
  ipcMain.removeHandler(IPC_CHANNELS.SESSION_OPEN);
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
}

// Re-export draft helper for tests that need to seed draft without IPC.
export { getDraftCwd, setDraftCwd, clearDraftCwd, takeDraftPermissionOverride };
