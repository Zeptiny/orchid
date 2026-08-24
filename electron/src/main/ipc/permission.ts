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
 * reads and saves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type { PermissionRule } from '../../shared/types/ipc-boundary';
import { hostRequest } from './host-request';
import { PERMISSION_MODE_VALUES } from '../../shared/types/permission';
import {
  atomicWriteJson,
  ConfigManager,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  PROJECT_CONFIG_NAME,
} from '../config/loader';
import { isPlainObject } from '../config/merge';
import { permissionsConfigSchema } from '../config/schema';
import { withConfigSaveLock } from '../config/write-lock';
import { invalidateAllProjectMCPManagers } from '../mcp/project-registry';
import { clearProjectRuntimeRegistry } from '../project/runtime';
import {
  approvalStore,
} from '../permissions/approval-store';
import { permissionConfigScopeSaveSchema } from './payload-schemas';
import { resolveAuthorizedProjectDir } from './project-target';
import { resolveWindowWorkspace } from '../session/singleton';
import {
  sessionPermissionOverrides,
  clearDraftPermissionOverrides,
} from '../permissions/session-overrides';

export { sessionPermissionOverrides };

const approvalAnswerSchema = z.object({
  toolCallId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  reason: z.string().optional(),
}).strict();

const setSessionModeSchema = z.object({
  mode: z.enum(PERMISSION_MODE_VALUES).nullable(),
  expectedSessionId: z.string().min(1).nullable(),
}).strict();

const getSessionModeSchema = z.object({
  expectedSessionId: z.string().min(1).nullable(),
}).strict();

function readConfigLayer(filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read configuration layer ${filePath}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Configuration layer must contain a JSON object: ${filePath}`);
  }
  return parsed;
}

function readPermissionLayer(filePath: string): Record<string, PermissionRule> {
  const layer = readConfigLayer(filePath);
  return permissionsConfigSchema.parse(layer.permissions ?? {});
}

function selectedProjectDir(senderId: number): string | null {
  const workspace = resolveWindowWorkspace(String(senderId));
  return workspace.status === 'valid' ? workspace.cwd : null;
}

function applyPermissionUpdates(
  current: Record<string, PermissionRule>,
  updates: Record<string, PermissionRule | null>,
): Record<string, PermissionRule> {
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) delete next[key];
    else next[key] = value;
  }
  return permissionsConfigSchema.parse(next);
}

export function registerPermissionIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PERMISSION_SNAPSHOT, (event) =>
    hostRequest(String(event.sender.id), IPC_CHANNELS.PERMISSION_SNAPSHOT));

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER,
    (event, payload: unknown) => {
      const parsed = approvalAnswerSchema.parse(payload);
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
        setSessionModeSchema.parse(payload),
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERMISSION_GET_SESSION_MODE, (event, payload: unknown) => {
    return hostRequest(
      String(event.sender.id),
      IPC_CHANNELS.PERMISSION_GET_SESSION_MODE,
      getSessionModeSchema.parse(payload),
    );
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_PERMISSION_SCOPES, (event) => {
    const projectDir = selectedProjectDir(event.sender.id);
    return {
      global: readPermissionLayer(HOME_CONFIG_PATH),
      project: projectDir == null
        ? {}
        : readPermissionLayer(path.join(projectDir, PROJECT_CONFIG_NAME)),
      projectDir,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE,
    (event, payload: unknown) => {
      const parsed = permissionConfigScopeSaveSchema.parse(payload);
      let verifiedProjectDir: string | null = null;
      if (parsed.scope === 'project') {
        verifiedProjectDir = resolveAuthorizedProjectDir(
          event.sender.id,
          parsed.expectedProjectDir,
        );
      }

      return withConfigSaveLock(async () => {
        const filePath = verifiedProjectDir == null
          ? HOME_CONFIG_PATH
          : path.join(verifiedProjectDir, PROJECT_CONFIG_NAME);
        const layer = readConfigLayer(filePath);
        const current = permissionsConfigSchema.parse(layer.permissions ?? {});
        layer.permissions = applyPermissionUpdates(current, parsed.updates);
        atomicWriteJson(filePath, layer, {
          hardenDirectory: parsed.scope === 'global',
        });

        ConfigManager.reset();
        clearProjectRuntimeRegistry();
        invalidateAllProjectMCPManagers();
        ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
        return { status: 'saved' as const };
      });
    },
  );
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
