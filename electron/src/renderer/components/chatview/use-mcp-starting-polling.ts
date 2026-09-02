/**
 * MCP servers start in the background after the window opens, so the first
 * status snapshot often lands on "starting". Poll until every server leaves
 * that state (connected / failed / unavailable) while the inspector is open.
 */
import { useEffect } from 'react';
import type { MCPServerStatus } from '../../../shared/types/ipc-boundary';

export interface UseMCPStartingPollingOptions {
  readonly enabled: boolean;
  readonly servers: readonly MCPServerStatus[];
  readonly workspaceKey: string | null;
  readonly refresh: (workspaceKey?: string | null) => void | Promise<void>;
}

/** Keep the inspector's MCP badges live while any server is still starting. */
export function useMCPStartingPolling({
  enabled,
  servers,
  workspaceKey,
  refresh,
}: UseMCPStartingPollingOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const anyServerStarting = servers.some((server) => server.status === 'starting');
    if (!anyServerStarting) return;
    const id = setInterval(() => {
      void refresh(workspaceKey);
    }, 1500);
    return () => clearInterval(id);
  }, [enabled, servers, refresh, workspaceKey]);
}
