/**
 * Project-trust family bindings — trust state inspection, grant/revoke with
 * its fan-out (runtime + MCP invalidation, watcher start/stop, per-client
 * workspace refresh), and the trusted-project listing.
 */
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { canonicalizeProjectDirectory } from '../../project/path';
import {
  buildProjectTrustReport,
  getProjectTrustState,
  grantProjectTrust,
  listTrustedProjects,
} from '../../project/trust';
import { getProjectRuntimeRegistry } from '../../project/runtime';
import { ensureWorkspaceWatcherStarted } from '../../indexing/watcher';
import { invalidateProjectMCPManagers } from '../../mcp/project-registry';
import { resolveWindowWorkspace } from '../../session/singleton';
import { revokeProjectTrustForDir } from '../session-ops';
import type { HostBinding, HostBindingEntries, HostServerSurface } from './types';

export function buildProjectBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  const trustInfoFor = (dir: string) => {
    const canonical = canonicalizeProjectDirectory(dir);
    if (canonical == null) {
      return { projectDir: dir, state: 'untrusted', report: null };
    }
    const state = getProjectTrustState(canonical);
    let report: ReturnType<typeof buildProjectTrustReport> | null;
    try {
      report = buildProjectTrustReport(canonical);
    } catch (error) {
      console.warn(`Failed to build trust report for '${canonical}':`, error);
      report = null;
    }
    return { projectDir: canonical, state, report };
  };

  bind('project.trust_get', (_ctx, params: { cwd: string }) => trustInfoFor(params.cwd));

  bind('project.trust_set', async (_ctx, params: { cwd: string; trusted: boolean }) => {
    const { cwd, trusted } = params;
    let canonical: string;
    if (trusted) {
      const resolved = canonicalizeProjectDirectory(cwd);
      if (resolved == null) {
        throw new Error('Cannot trust an invalid project directory.');
      }
      canonical = resolved;
      grantProjectTrust(canonical);
      getProjectRuntimeRegistry().invalidate(canonical);
      invalidateProjectMCPManagers(canonical);
      ensureWorkspaceWatcherStarted(canonical);
    } else {
      await revokeProjectTrustForDir(cwd);
      canonical = canonicalizeProjectDirectory(cwd) ?? cwd;
    }
    const info = trustInfoFor(canonical);
    surface.emitToAll(IPC_CHANNELS.PROJECT_TRUST_CHANGED, {
      projectDir: info.projectDir,
      state: info.state,
    });
    for (const clientId of surface.listConnections()) {
      const workspace = resolveWindowWorkspace(clientId);
      if (workspace.cwd !== canonical) continue;
      surface.emitTo(clientId, IPC_CHANNELS.SESSION_WORKSPACE_CHANGED, { workspace });
    }
    return info;
  });

  bind('project.trust_list', () => listTrustedProjects());

  return entries;
}
