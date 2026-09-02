/**
 * Session surface core — the electron-free helpers behind the session IPC
 * boundary and the host protocol: workspace binding (with the per-owner
 * workspace-watcher reference), trust revocation fan-out, and the
 * session-open hydration path (chat history seeding + subagent recovery).
 *
 * `ipc/session.ts` re-exports these so existing consumers are unchanged;
 * `host/server.ts` binds them to protocol methods.
 */
import { flattenSessionMessages, type Session } from '../../shared/types/session';
import type { Message } from '../../shared/types/message';
import { getSessionManager, resolveWindowWorkspace } from '../session/singleton';
import { seedChatHistory, clearChatHistory } from './chat/history';
import {
  clearDraftCwd,
  getDraftCwd,
  isWorkspaceBound,
  requireValidProjectDirectory,
  setDraftCwd,
  updateStickyDefaultProjectDir,
  type WorkspaceInfo,
} from '../project/workspace';
import { canonicalizeProjectDirectory } from '../project/path';
import { revokeProjectTrust, revokeProjectTrustRaw } from '../project/trust';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { invalidateProjectMCPManagers } from '../mcp/project-registry';
import { cancelIndex } from '../rag/indexer';
import { cancelProjectRefresh } from '../indexing/refresh-coordinator';
import {
  attachWorkspaceWatcher,
  detachWorkspaceWatcher,
} from '../indexing/watcher';
import {
  workingSetClearFocus,
  workingSetOpenOrFocus,
  workingSetRemove,
} from '../session/working-set-live';
import { hydrateSessionPermissionOverride } from '../permissions/session-overrides';
import { clearFunctionHashesForWorkspace } from '../tools/ast/get-function';
import { forceStopSession } from './chat/abort';

/** Seed the in-memory chat history only when the full graph is already loaded. */
export function seedCompleteChatHistory(
  session: Session,
  messages = flattenSessionMessages(session),
): void {
  if (session.chains.every((chain) => chain.messagesLoaded !== false)) {
    seedChatHistory(session.id, messages);
  }
}

/** One client's session activation: the shared core of session.load/open. */
export interface ActivatedSession {
  readonly session: Session | null;
  /** Flattened messages of the activated session ([] when it no longer exists). */
  readonly messages: Message[];
  /** Workspace as resolved after the switch (drives the workspace-changed push). */
  readonly workspace: WorkspaceInfo;
}

/**
 * Switch a client's active session and run the full activation fan-out —
 * the duplicated block the `session.load` and `session.open` host bindings
 * previously each carried:
 *
 * switchTo → working-set open/focus (or removal for a vanished session) →
 * permission-mode hydration → subagent hydration kick-off → draft-cwd
 * release → history seed/clear → workspace resolve + watcher retarget.
 *
 * `clearReleasedDraftCaches` additionally clears the AST function-hash cache
 * of the draft workspace a `session.load` just released (`session.open`
 * never did this, so it stays opt-in to keep both bindings byte-compatible).
 *
 * Emits nothing: the caller pushes `SESSION_WORKSPACE_CHANGED` with the
 * returned workspace through its own event surface.
 */
export function activateSessionForClient(
  clientId: string,
  sessionId: string,
  options: { clearReleasedDraftCaches?: boolean } = {},
): ActivatedSession {
  const manager = getSessionManager();
  const releasedDraftCwd = getDraftCwd(clientId);
  const session = manager.switchTo(sessionId, clientId);
  if (session) {
    workingSetOpenOrFocus(session.id, clientId);
    hydrateSessionPermissionOverride(session.id, session.permissionMode);
    startOpenedSessionSubagentHydration(session.id, clientId);
  } else {
    workingSetRemove(sessionId, clientId);
  }
  clearDraftCwd(clientId);
  if (releasedDraftCwd && options.clearReleasedDraftCaches) {
    // Best-effort hash cache cleanup for the released draft workspace.
    try {
      clearFunctionHashesForWorkspace(releasedDraftCwd);
    } catch {
      // non-fatal
    }
  }
  const messages = session ? flattenSessionMessages(session) : [];
  if (session) {
    seedCompleteChatHistory(session, messages);
  } else {
    clearChatHistory(sessionId);
  }
  const workspace = resolveWindowWorkspace(clientId);
  retargetWorkspaceWatcher(clientId, workspace.cwd);
  return { session, messages, workspace };
}

/**
 * Resolved cwd whose watcher reference this module last established for a
 * client — the authoritative record of the reference each client actually
 * holds. Every attach/detach goes through {@link retargetWorkspaceWatcher},
 * so the map never diverges from the refcounts it produced.
 */
const clientWatcherCwd = new Map<string, string>();

/**
 * Move the client's workspace-watcher reference after its effective workspace
 * changed (project bind, session switch). Attach is refcounted per project
 * path, so every site that can change the effective cwd must share these
 * exact semantics or references ratchet across switches. The prior reference
 * is read from {@link clientWatcherCwd}, never re-derived from the effective
 * workspace: a client whose cwd comes from the sticky default but that never
 * resolved a workspace must not detach a path another client attached.
 *
 * No-op when the cwd did not change; the next path is attached before the
 * prior one is released so a project shared with another client keeps its
 * instance. Never attaches an unbound (null) workspace.
 */
export function retargetWorkspaceWatcher(
  clientId: string,
  next: string | null,
): void {
  const prior = clientWatcherCwd.get(clientId) ?? null;
  if (prior === next) return;
  if (next != null) attachWorkspaceWatcher(next);
  if (prior != null) detachWorkspaceWatcher(prior);
  if (next != null) clientWatcherCwd.set(clientId, next);
  else clientWatcherCwd.delete(clientId);
}

/** Drop every recorded watcher reference (test teardown / shutdown). */
export function resetWorkspaceWatcherReferences(): void {
  clientWatcherCwd.clear();
}

/**
 * Bring a client's watcher reference in line with its currently resolved
 * workspace. This is the startup seam: a freshly connected client whose
 * workspace resolves from the sticky default (no draft, no session) never
 * goes through a bind or an activation, so the first workspace resolution is
 * what attaches it. Idempotent.
 */
export function reconcileClientWatcher(clientId: string, workspace: WorkspaceInfo): void {
  const next = isWorkspaceBound(workspace) ? workspace.cwd : null;
  retargetWorkspaceWatcher(clientId, next);
}

/**
 * Bind a validated absolute project directory as the current workspace.
 *
 * - If an active session exists: update session.cwd via changeCwd.
 * - Otherwise: store as draft for this client.
 * - Always updates sticky default_project_dir (intentional pick).
 */
export async function bindProjectDirectory(
  clientId: string,
  dir: string,
): Promise<WorkspaceInfo> {
  const canonical = requireValidProjectDirectory(dir);
  const priorWorkspace = resolveWindowWorkspace(clientId);

  await updateStickyDefaultProjectDir(canonical);

  const manager = getSessionManager();
  const active = manager.getActive(clientId);
  if (active) {
    if (active.chains.length === 0) {
      manager.changeCwd(active.id, canonical);
      clearDraftCwd(clientId);
    } else {
      // A conversation remains bound to the project it started in. Picking a
      // different folder opens a draft there without moving or cancelling it.
      manager.clearActive(clientId);
      workingSetClearFocus(clientId);
      setDraftCwd(clientId, canonical);
    }
  } else {
    setDraftCwd(clientId, canonical);
  }

  if (priorWorkspace.cwd !== canonical) {
    retargetWorkspaceWatcher(clientId, canonical);
    if (priorWorkspace.cwd) {
      const {
        clearFunctionHashesForSession,
        clearFunctionHashesForWorkspace,
      } = await import('../tools/ast/get-function.js');
      clearFunctionHashesForWorkspace(priorWorkspace.cwd);
      if (active && active.chains.length === 0) {
        clearFunctionHashesForSession(active.id);
      }
    }
  }

  return resolveWindowWorkspace(clientId);
}

/**
 * Revoke trust for one project and stop all of its activity.
 *
 * The trust record drops first so concurrent gate reads fail closed, then the
 * cached runtime and MCP managers are invalidated (lease-aware shutdown
 * retires them as running turns finish), any in-flight RAG indexing is
 * cancelled, queued index-refresh batches are dropped, and every session
 * bound to the directory is force-stopped.
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
  detachWorkspaceWatcher(canonical);
  // Queued refresh batches must never flush into the now-untrusted project.
  cancelProjectRefresh(canonical);

  // Trust just dropped — an in-flight index run for this directory must stop.
  void cancelIndex(canonical).catch(() => {});

  const boundSessionIds = getSessionManager()
    .listSaved()
    .filter((summary) => summary.cwd === canonical)
    .map((summary) => summary.id);
  if (boundSessionIds.length === 0) return;

  for (const sessionId of boundSessionIds) {
    // One failing session stop must not prevent the remaining stops.
    try {
      forceStopSession(sessionId);
    } catch (error) {
      console.warn(`Failed to force-stop session '${sessionId}' during trust revocation:`, error);
    }
  }
}

/**
 * Materialize a session's persisted subagent chains back into the runtime
 * manager so the main agent regains its subagent context after a host restart
 * (records live only in memory for the current launch). The task is detached
 * from navigation; send and lifecycle operations join the same readiness
 * promise. Session open must not fail because hydration could not run, so
 * errors are logged and left retryable.
 */
export function startOpenedSessionSubagentHydration(
  sessionId: string,
  clientId: string,
): void {
  void (async () => {
    const { getSubagentManager } = await import('../tools/index.js');
    const { awaitSessionSubagentHydration } = await import('../tools/subagent/hydrate.js');
    const result = await awaitSessionSubagentHydration(
      getSubagentManager(),
      sessionId,
      { windowId: clientId },
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
