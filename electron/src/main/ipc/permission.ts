/**
 * Permission IPC — bridge approval requests and permission config between the
 * main-process approval store and the renderer.
 *
 * Approval delivery is fully unified (U9): requests and settlements flow as
 * host protocol events — `host/server.ts` forwards them to connected clients
 * and `ipc/host-broadcast.ts` pushes them to windows. An approval whose owner
 * client is not connected stays PENDING on the host; the approval store's
 * `approval_timeout` timer settles it DENIED (fail-closed, never
 * auto-approved), and `approval_timeout: 0` waits forever — the turn stays
 * blocked exactly like an unanswered prompt.
 *
 * This module only registers the zod-validated invoke channels: answering
 * approvals, session mode overrides, and global/project permission scope
 * reads and saves. Fix #6: the permission-scope surfaces route to the active
 * machine's host as well — enforcement for the visible session reads the
 * host's config layers, so the Permissions tab must edit those, never the
 * Electron shell's local `~/.orchid` while a window drives a remote.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { hostRequest } from './host-request';
import {
  permissionApprovalAnswerSchema,
  permissionGetSessionModeSchema,
  permissionSetSessionModeSchema,
} from '../../shared/types/ipc-schemas';
import { approvalStore } from '../permissions/approval-store';
import { permissionConfigScopeSaveSchema } from './payload-schemas';
import {
  sessionPermissionOverrides,
  clearDraftPermissionOverrides,
} from '../permissions/session-overrides';

export { sessionPermissionOverrides };

export function registerPermissionIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PERMISSION_SNAPSHOT, (event) =>
    hostRequest(String(event.sender.id), IPC_CHANNELS.PERMISSION_SNAPSHOT));

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER,
    (event, payload: unknown) => {
      const parsed = permissionApprovalAnswerSchema.parse(payload);
      return hostRequest(
        String(event.sender.id),
        IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER,
        parsed,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_SET_SESSION_MODE,
    (event, payload: unknown) => {
      return hostRequest(
        String(event.sender.id),
        IPC_CHANNELS.PERMISSION_SET_SESSION_MODE,
        permissionSetSessionModeSchema.parse(payload),
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERMISSION_GET_SESSION_MODE, (event, payload: unknown) => {
    return hostRequest(
      String(event.sender.id),
      IPC_CHANNELS.PERMISSION_GET_SESSION_MODE,
      permissionGetSessionModeSchema.parse(payload),
    );
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_PERMISSION_SCOPES, (event) =>
    hostRequest(String(event.sender.id), IPC_CHANNELS.CONFIG_PERMISSION_SCOPES));

  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE, (event, payload: unknown) =>
    hostRequest(
      String(event.sender.id),
      IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE,
      permissionConfigScopeSaveSchema.parse(payload),
    ));
}

export function unregisterPermissionIPC(): void {
  approvalStore.cleanupAll();
  clearDraftPermissionOverrides();
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER);
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_SET_SESSION_MODE);
  ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_GET_SESSION_MODE);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_PERMISSION_SCOPES);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE);
}
