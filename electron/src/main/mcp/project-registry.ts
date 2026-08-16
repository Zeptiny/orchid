/**
 * Project-scoped MCP manager catalog.
 *
 * An MCP connection can carry server process state, resources, and tools, so
 * it must be owned by the immutable project runtime captured by a turn. A
 * manager is intentionally never selected through the currently visible
 * workspace.
 */
import type { ProjectRuntime } from '../project/runtime';
import { getProjectTrustState } from '../project/trust';
import { MCPManager } from './manager';
import type { MCPServerConfig } from './schema';

function projectServers(runtime: ProjectRuntime): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    Object.entries(runtime.config.mcp_servers ?? {}).map(([name, config]) => [
      name,
      {
        ...(config as MCPServerConfig),
        // Stdio servers inherit their owning project unless explicitly pinned.
        cwd: (config as MCPServerConfig).cwd ?? runtime.projectDir,
      },
    ]),
  );
}

export class ProjectMCPManagerRegistry {
  private readonly byProject = new Map<string, {
    manager: MCPManager;
    projectDir: string;
    leases: number;
    stale: boolean;
    /** True once startAll ran — the entry may own live server processes. */
    started: boolean;
  }>();

  private projectKey(runtime: ProjectRuntime): string {
    return JSON.stringify({
      projectDir: runtime.projectDir,
      servers: runtime.config.mcp_servers ?? {},
      perServerTimeout: runtime.config.mcp_per_server_timeout,
      startupTimeout: runtime.config.mcp_startup_timeout,
    });
  }

  /**
   * Return the manager belonging to one immutable runtime and start it once.
   * Startup is non-blocking, matching the prior app-start behavior; a turn
   * uses only this project's eventual tools/resources and never a peer's.
   */
  get(runtime: ProjectRuntime): MCPManager {
    const key = this.projectKey(runtime);
    const existing = this.byProject.get(key);
    if (existing) {
      if (
        !existing.started ||
        getProjectTrustState(existing.projectDir) === 'trusted'
      ) {
        // A dormant entry owns no server processes and stays reusable while
        // the trust posture is unchanged.
        return existing.manager;
      }
      // Fingerprint drift or a revocation flipped a started manager's project
      // out of `trusted`: retire it lease-aware so its servers stop. With no
      // lease the entry shuts down now and the fall-through recreates a
      // dormant manager; a running turn keeps its manager until release.
      existing.stale = true;
      this.retireIfUnused(key, existing);
      const retained = this.byProject.get(key);
      if (retained) return retained.manager;
    }

    const manager = new MCPManager();
    const entry = {
      manager,
      projectDir: runtime.projectDir,
      leases: 0,
      stale: false,
      started: false,
    };
    this.byProject.set(key, entry);

    const servers = projectServers(runtime);
    if (Object.keys(servers).length > 0) {
      entry.started = true;
      void manager.startAll(servers, {
        perServerTimeout: runtime.config.mcp_per_server_timeout * 1000,
        startupTimeout: runtime.config.mcp_startup_timeout * 1000,
      }).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `MCP initialization failed for project '${runtime.projectDir}' (non-fatal): ${detail}`,
        );
      });
    }

    return manager;
  }

  /** Retain a manager for a running turn until its actor is disposed. */
  acquire(runtime: ProjectRuntime): MCPManager {
    const key = this.projectKey(runtime);
    const manager = this.get(runtime);
    const entry = this.byProject.get(key);
    if (entry) entry.leases += 1;
    return manager;
  }

  /** Release a running-turn lease and retire any superseded manager. */
  release(runtime: ProjectRuntime): void {
    const key = this.projectKey(runtime);
    const entry = this.byProject.get(key);
    if (!entry) return;
    entry.leases = Math.max(0, entry.leases - 1);
    this.retireIfUnused(key, entry);
  }

  /** Mark a project's historical configurations stale without interrupting turns. */
  invalidateProject(projectDir: string): void {
    for (const [key, entry] of this.byProject) {
      if (entry.projectDir !== projectDir) continue;
      entry.stale = true;
      this.retireIfUnused(key, entry);
    }
  }

  /** Mark every cached configuration stale after a home-config change. */
  invalidateAll(): void {
    for (const [key, entry] of this.byProject) {
      entry.stale = true;
      this.retireIfUnused(key, entry);
    }
  }

  private retireIfUnused(
    key: string,
    entry: { manager: MCPManager; leases: number; stale: boolean; started: boolean },
  ): void {
    if (!entry.stale || entry.leases > 0) return;
    this.byProject.delete(key);
    void entry.manager.shutdown().catch(() => {});
  }

  /** Close all project-owned transports at application shutdown. */
  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.byProject.values()].map(({ manager }) => manager.shutdown()),
    );
    this.byProject.clear();
  }
}

const projectMCPManagers = new ProjectMCPManagerRegistry();

export function getProjectMCPManager(runtime: ProjectRuntime): MCPManager {
  return projectMCPManagers.get(runtime);
}

/** Retain a project MCP manager for one live main/subagent turn. */
export function acquireProjectMCPManager(runtime: ProjectRuntime): MCPManager {
  return projectMCPManagers.acquire(runtime);
}

/** Release a manager retained by a completed or interrupted turn. */
export function releaseProjectMCPManager(runtime: ProjectRuntime): void {
  projectMCPManagers.release(runtime);
}

/** Retire stale managers after one project's runtime is invalidated. */
export function invalidateProjectMCPManagers(projectDir: string): void {
  projectMCPManagers.invalidateProject(projectDir);
}

/** Retire stale managers after global runtime invalidation. */
export function invalidateAllProjectMCPManagers(): void {
  projectMCPManagers.invalidateAll();
}

export async function shutdownProjectMCPManagers(): Promise<void> {
  await projectMCPManagers.shutdownAll();
}
