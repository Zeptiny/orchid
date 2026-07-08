/**
 * MCP IPC handler — mcp:status.
 *
 * Wraps MCPManager from U12 to expose server status to the renderer.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';

// ── MCP manager reference (injected at startup) ─────────────────────────────

let mcpManagerRef: { getStatus: () => unknown[] } | null = null;

/**
 * Set the MCP manager reference for IPC handlers.
 * Called during app startup after MCP initialization.
 */
export function setMCPManagerRef(manager: { getStatus: () => unknown[] } | null): void {
  mcpManagerRef = manager;
}

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerMCPIPC(): void {
  // mcp:status — return status of all MCP servers
  ipcMain.handle(IPC_CHANNELS.MCP_STATUS, async () => {
    if (!mcpManagerRef) {
      return [];
    }
    return mcpManagerRef.getStatus();
  });
}

/**
 * Unregister MCP IPC handlers (for cleanup/testing).
 */
export function unregisterMCPIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STATUS);
}
