/**
 * Config family bindings — home config get/save plus the authorized
 * project-config read/save surface (targets authorized by
 * project/project-target.ts, not by renderer-supplied paths alone), and the
 * global/project permission-scope read/write (fix #6: the host serves its OWN
 * config layers — the machine whose permission enforcement reads them).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PermissionRule } from '../../../shared/types/ipc-boundary';
import {
  atomicWriteJson,
  ConfigManager,
  getConfig,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  PROJECT_CONFIG_NAME,
} from '../../config/loader';
import { isPlainObject } from '../../config/merge';
import { permissionsConfigSchema } from '../../config/schema';
import { withConfigSaveLock } from '../../config/write-lock';
import { invalidateAllProjectMCPManagers } from '../../mcp/project-registry';
import { clearProjectRuntimeRegistry } from '../../project/runtime';
import { resolveAuthorizedProjectDir } from '../../project/project-target';
import { resolveWindowWorkspace } from '../../session/singleton';
import {
  loadHomeConfig,
  readProjectConfig,
  saveHomeConfigUpdates,
  saveProjectConfigUpdates,
} from '../../config/persist';
import type { HostBinding, HostBindingEntries } from './types';

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

export function buildConfigBindings(): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('config.get', () => getConfig());
  bind('config.save', (_ctx, params: { updates: Record<string, unknown> }) =>
    saveHomeConfigUpdates(params.updates));
  bind('config.get_home', () => loadHomeConfig());
  // U5 additive fix: the params schema is the IPC boundary's bare directory
  // string (configReadProjectSchema), not an object wrapper.
  bind('config.read_project', (ctx, params: string) => {
    const verifiedProjectDir = resolveAuthorizedProjectDir(ctx.clientId, params);
    return readProjectConfig(verifiedProjectDir);
  });
  bind('config.save_project', (ctx, params: { projectDir: string; updates: Record<string, unknown> }) => {
    const verifiedProjectDir = resolveAuthorizedProjectDir(ctx.clientId, params.projectDir);
    return saveProjectConfigUpdates(verifiedProjectDir, params.updates).then(() => null);
  });

  // ── Permission scopes (fix #6) ────────────────────────────────────────────
  // The read/write core is byte-for-byte the Electron handler's; the host
  // resolves the caller's selected project dir and authorizes the project
  // target against its own session state. Writes serialize through the host's
  // own withConfigSaveLock (same lock path config.save already uses — a daemon
  // is a separate process from the app, so no cross-process lock is needed).

  bind('config.permission_scopes', (ctx) => {
    const workspace = resolveWindowWorkspace(ctx.clientId);
    const projectDir = workspace.status === 'valid' ? workspace.cwd : null;
    return {
      global: readPermissionLayer(HOME_CONFIG_PATH),
      project: projectDir == null
        ? {}
        : readPermissionLayer(path.join(projectDir, PROJECT_CONFIG_NAME)),
      projectDir,
    };
  });

  bind('config.save_permission_scope', (ctx, params: {
    scope: 'global' | 'project';
    updates: Record<string, PermissionRule | null>;
    expectedProjectDir?: string;
  }) => {
    let verifiedProjectDir: string | null = null;
    if (params.scope === 'project') {
      verifiedProjectDir = resolveAuthorizedProjectDir(ctx.clientId, params.expectedProjectDir ?? '');
    }

    return withConfigSaveLock(async () => {
      const filePath = verifiedProjectDir == null
        ? HOME_CONFIG_PATH
        : path.join(verifiedProjectDir, PROJECT_CONFIG_NAME);
      const layer = readConfigLayer(filePath);
      const current = permissionsConfigSchema.parse(layer.permissions ?? {});
      layer.permissions = applyPermissionUpdates(current, params.updates);
      atomicWriteJson(filePath, layer, {
        hardenDirectory: params.scope === 'global',
      });

      ConfigManager.reset();
      clearProjectRuntimeRegistry();
      invalidateAllProjectMCPManagers();
      ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
      return { status: 'saved' as const };
    });
  });

  return entries;
}
