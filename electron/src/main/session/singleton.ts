import { SessionManager } from './manager';
import { getConfig } from '../config/loader';
import {
  isWorkspaceBound,
  resolveWorkspace,
  type WorkspaceInfo,
} from '../project/workspace';

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
