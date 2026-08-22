/**
 * Project trust IPC — project:trust_get, project:trust_set, project:trust_list.
 *
 * Exposes the trust store to the renderer: surface-diff reports for untrusted
 * or changed projects, grant/revoke decisions, and the settings listing.
 * Granting invalidates cached project runtimes and MCP managers so services
 * pick up trust immediately, and starts the workspace watcher for projects
 * windows already reference; every decision broadcasts project:trust_changed
 * and re-emits session:workspace_changed to windows bound to the directory.
 */
import { BrowserWindow, ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type ProjectTrustInfo,
  type ProjectTrustReport,
  type TrustState,
} from '../../shared/types/ipc';
import { invalidateProjectMCPManagers } from '../mcp/project-registry';
import { canonicalizeProjectDirectory } from '../project/path';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { ensureWorkspaceWatcherStarted } from '../indexing/watcher';
import {
  buildProjectTrustReport,
  getProjectTrustState,
  grantProjectTrust,
  listTrustedProjects,
} from '../project/trust';
import { resolveWindowWorkspace } from '../session/singleton';
import { projectTrustGetSchema, projectTrustSetSchema } from './payload-schemas';
import { revokeProjectTrustForDir } from './session';

function trustInfoFor(dir: string): ProjectTrustInfo {
  const canonical = canonicalizeProjectDirectory(dir);
  if (canonical == null) {
    return { projectDir: dir, state: 'untrusted', report: null };
  }
  const state = getProjectTrustState(canonical);
  // Always build the report regardless of state: the settings panel renders it
  // read-only for trusted projects too. The payload is only fetched on explicit
  // user action (dialog open / review click), so always-including is fine.
  let report: ProjectTrustReport | null;
  try {
    report = buildProjectTrustReport(canonical);
  } catch (error) {
    // A broken symlink or hostile FS entry in the surface must not reject
    // trust_get — the grant path has to stay reachable, so keep the real
    // state and fall back to an empty report pane.
    console.warn(`Failed to build trust report for '${canonical}':`, error);
    report = null;
  }
  return { projectDir: canonical, state, report };
}

function broadcastTrustChanged(projectDir: string, state: TrustState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IPC_CHANNELS.PROJECT_TRUST_CHANGED, { projectDir, state });
    } catch (error) {
      // One destroyed/racing window must not starve the remaining windows.
      console.warn('Failed to broadcast project:trust_changed to a window:', error);
    }
  }
}

function reemitWorkspaceChanged(canonical: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      const workspace = resolveWindowWorkspace(String(win.webContents.id));
      if (workspace.cwd !== canonical) continue;
      win.webContents.send(IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
    } catch (error) {
      // One destroyed/racing window must not starve the remaining windows.
      console.warn('Failed to re-emit session:workspace_changed to a window:', error);
    }
  }
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerTrustIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_TRUST_GET, (_event, payload: unknown) => {
    const parsed = projectTrustGetSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid project:trust_get payload: ${parsed.error.message}`);
    }
    return trustInfoFor(parsed.data.cwd);
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_TRUST_SET, async (_event, payload: unknown) => {
    const parsed = projectTrustSetSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid project:trust_set payload: ${parsed.error.message}`);
    }
    const { cwd, trusted } = parsed.data;

    let canonical: string;
    if (trusted) {
      const resolved = canonicalizeProjectDirectory(cwd);
      if (resolved == null) {
        throw new Error('Cannot trust an invalid project directory.');
      }
      canonical = resolved;
      grantProjectTrust(canonical);
      getProjectRuntimeRegistry().invalidate(canonical);
      invalidateProjectMCPManagers(canonical);
      // A project bound while untrusted never started a workspace watcher
      // instance (fail-closed gate); the grant is what makes it eligible, so
      // retry for the references windows already hold.
      ensureWorkspaceWatcherStarted(canonical);
    } else {
      await revokeProjectTrustForDir(cwd);
      canonical = canonicalizeProjectDirectory(cwd) ?? cwd;
    }

    const info = trustInfoFor(canonical);
    broadcastTrustChanged(info.projectDir, info.state);
    reemitWorkspaceChanged(canonical);
    return info;
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_TRUST_LIST, () => {
    return listTrustedProjects();
  });
}

/**
 * Unregister project trust IPC handlers (for cleanup/testing).
 */
export function unregisterTrustIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.PROJECT_TRUST_GET);
  ipcMain.removeHandler(IPC_CHANNELS.PROJECT_TRUST_SET);
  ipcMain.removeHandler(IPC_CHANNELS.PROJECT_TRUST_LIST);
}
