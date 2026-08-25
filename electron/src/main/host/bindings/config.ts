/**
 * Config family bindings — home config get/save plus the authorized
 * project-config read/save surface (targets authorized by
 * project/project-target.ts, not by renderer-supplied paths alone).
 */
import { getConfig } from '../../config/loader';
import {
  loadHomeConfig,
  readProjectConfig,
  saveHomeConfigUpdates,
  saveProjectConfigUpdates,
} from '../../config/persist';
import { resolveAuthorizedProjectDir } from '../../project/project-target';
import type { HostBinding, HostBindingEntries } from './types';

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

  return entries;
}
