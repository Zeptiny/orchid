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
import { ipcMain } from 'electron';
import {
  IPC_CHANNELS,
  type ProjectTrustInfo,
} from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import { projectTrustGetSchema, projectTrustSetSchema } from './payload-schemas';

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerTrustIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_TRUST_GET, (event, payload: unknown) => {
    const parsed = projectTrustGetSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid project:trust_get payload: ${parsed.error.message}`);
    }
    return hostRequest<ProjectTrustInfo>(
      String(event.sender.id),
      IPC_CHANNELS.PROJECT_TRUST_GET,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_TRUST_SET, async (event, payload: unknown) => {
    const parsed = projectTrustSetSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid project:trust_set payload: ${parsed.error.message}`);
    }
    return hostRequest<ProjectTrustInfo>(
      String(event.sender.id),
      IPC_CHANNELS.PROJECT_TRUST_SET,
      parsed.data,
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_TRUST_LIST, (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.PROJECT_TRUST_LIST);
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
