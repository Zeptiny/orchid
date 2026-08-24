/**
 * MCP IPC handler — mcp:status.
 *
 * Wraps MCPManager from U12 to expose server status to the renderer.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerMCPIPC(): void {
  // mcp:status — resolve the sender's project instead of a process-global manager.
  ipcMain.handle(IPC_CHANNELS.MCP_STATUS, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.MCP_STATUS);
  });
}

/**
 * Unregister MCP IPC handlers (for cleanup/testing).
 */
export function unregisterMCPIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STATUS);
}
