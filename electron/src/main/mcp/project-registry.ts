/**
 * Project-scoped MCP manager catalog.
 *
 * An MCP connection can carry server process state, resources, and tools, so
 * it must be owned by the immutable project runtime captured by a turn. A
 * manager is intentionally never selected through the currently visible
 * workspace.
 */
import type { ProjectRuntime } from '../project/runtime';
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
  private byProject = new Map<string, MCPManager>();
  private readonly managers = new Set<MCPManager>();

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
    if (existing) return existing;

    const manager = new MCPManager();
    this.byProject.set(key, manager);
    this.managers.add(manager);

    const servers = projectServers(runtime);
    if (Object.keys(servers).length > 0) {
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

  /** Close all project-owned transports at application shutdown. */
  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.managers].map((manager) => manager.shutdown()),
    );
    this.managers.clear();
    this.byProject.clear();
  }
}

const projectMCPManagers = new ProjectMCPManagerRegistry();

export function getProjectMCPManager(runtime: ProjectRuntime): MCPManager {
  return projectMCPManagers.get(runtime);
}

export async function shutdownProjectMCPManagers(): Promise<void> {
  await projectMCPManagers.shutdownAll();
}
