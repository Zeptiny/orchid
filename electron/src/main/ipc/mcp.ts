/**
 * MCP IPC handler — mcp:status.
 *
 * Wraps MCPManager from U12 to expose server status to the renderer.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getProjectMCPManager } from '../mcp/project-registry';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { isWorkspaceBound } from '../project/workspace';
import { resolveWindowWorkspace } from './session';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerMCPIPC(): void {
  // mcp:status — resolve the sender's project instead of a process-global manager.
  ipcMain.handle(IPC_CHANNELS.MCP_STATUS, async (event) => {
    const workspace = resolveWindowWorkspace(String(event.sender.id));
    if (!isWorkspaceBound(workspace) || !workspace.cwd) {
      return [];
    }
    const runtime = getProjectRuntimeRegistry().get(workspace.cwd);
    return getProjectMCPManager(runtime).getStatus();
  });
}

/**
 * Unregister MCP IPC handlers (for cleanup/testing).
 */
export function unregisterMCPIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STATUS);
}
