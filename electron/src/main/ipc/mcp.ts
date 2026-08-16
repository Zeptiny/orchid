/**
 * MCP IPC handler — mcp:status.
 *
 * Wraps MCPManager from U12 to expose server status to the renderer.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { getProjectMCPManager } from '../mcp/project-registry';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { resolveBoundProjectPath } from './session';

const mcpStatusSchema = z.object({
  projectDir: z.string().optional(),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerMCPIPC(): void {
  // mcp:status — resolve the sender's project, or an explicit projectDir when
  // provided (e.g. from ProjectConfigView editing a different project).
  ipcMain.handle(IPC_CHANNELS.MCP_STATUS, async (event, payload?: unknown) => {
    const parsed = mcpStatusSchema.safeParse(payload);
    const explicitDir = parsed.success ? parsed.data.projectDir : undefined;

    const cwd = explicitDir ?? resolveBoundProjectPath(String(event.sender.id));
    if (cwd == null) {
      return [];
    }
    const runtime = getProjectRuntimeRegistry().get(cwd);
    return getProjectMCPManager(runtime).getStatus();
  });
}

/**
 * Unregister MCP IPC handlers (for cleanup/testing).
 */
export function unregisterMCPIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STATUS);
}
