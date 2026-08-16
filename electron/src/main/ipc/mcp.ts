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
import { HOME_CONFIG_DIR } from '../config/loader';

const mcpStatusSchema = z.object({
  projectDir: z.string().optional(),
});

  function synthesizeUnavailable(servers: Record<string, unknown>): import('../../shared/types/ipc-boundary').MCPServerStatus[] {
    return Object.keys(servers).map((name) => ({
      name,
      status: 'unavailable' as const,
      toolCount: 0,
      tools: [],
      error: null,
    }));
  }

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerMCPIPC(): void {
  // mcp:status — resolve the sender's project, or an explicit projectDir when
  // provided (e.g. from ProjectConfigView editing a different project).
  ipcMain.handle(IPC_CHANNELS.MCP_STATUS, async (event, payload?: unknown) => {
    const parsed = mcpStatusSchema.safeParse(payload);
    const explicitDir = parsed.success ? parsed.data.projectDir : undefined;

    const cwd = explicitDir ?? resolveBoundProjectPath(String(event.sender.id));
    if (cwd == null) {
      try {
        const homeRuntime = getProjectRuntimeRegistry().get(HOME_CONFIG_DIR);
        const live = getProjectMCPManager(homeRuntime).getStatus();
        if (live.length > 0) return live;
        const servers = (homeRuntime.config.mcp_servers ?? {}) as Record<string, unknown>;
        if (Object.keys(servers).length > 0) return synthesizeUnavailable(servers);
        return [];
      } catch {
        return [];
      }
    }
    try {
      const runtime = getProjectRuntimeRegistry().get(cwd);
      const live = getProjectMCPManager(runtime).getStatus();
      if (live.length > 0) return live;
      const servers = (runtime.config.mcp_servers ?? {}) as Record<string, unknown>;
      if (Object.keys(servers).length > 0) return synthesizeUnavailable(servers);
      return live;
    } catch {
      return [];
    }
  });
}

/**
 * Unregister MCP IPC handlers (for cleanup/testing).
 */
export function unregisterMCPIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STATUS);
}
