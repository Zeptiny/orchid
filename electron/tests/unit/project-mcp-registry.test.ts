import { describe, expect, it, vi } from 'vitest';
import type { ProjectRuntime } from '../../src/main/project/runtime';

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{
    startAll: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('../../src/main/mcp/manager', () => ({
  MCPManager: class {
    startAll = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});

    constructor() {
      mocks.instances.push(this);
    }
  },
}));

import { ProjectMCPManagerRegistry } from '../../src/main/mcp/project-registry';

function runtime(projectDir: string, serverName: string): ProjectRuntime {
  return {
    projectDir,
    config: {
      mcp_servers: {
        [serverName]: { command: 'node', args: ['server.js'] },
      },
      mcp_per_server_timeout: 2,
      mcp_startup_timeout: 7,
    },
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  } as unknown as ProjectRuntime;
}

describe('ProjectMCPManagerRegistry', () => {
  it('creates independent MCP connections for separate project runtimes', async () => {
    const registry = new ProjectMCPManagerRegistry();
    const projectA = runtime('/projects/a', 'alpha');
    const projectB = runtime('/projects/b', 'beta');

    const managerA = registry.get(projectA);
    const managerAAgain = registry.get(projectA);
    const managerB = registry.get(projectB);

    expect(managerAAgain).toBe(managerA);
    expect(managerB).not.toBe(managerA);
    expect(mocks.instances).toHaveLength(2);

    await Promise.resolve();
    expect(mocks.instances[0]!.startAll).toHaveBeenCalledWith(
      { alpha: { command: 'node', args: ['server.js'], cwd: '/projects/a' } },
      { perServerTimeout: 2_000, startupTimeout: 7_000 },
    );
    expect(mocks.instances[1]!.startAll).toHaveBeenCalledWith(
      { beta: { command: 'node', args: ['server.js'], cwd: '/projects/b' } },
      { perServerTimeout: 2_000, startupTimeout: 7_000 },
    );

    await registry.shutdownAll();
    expect(mocks.instances[0]!.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.instances[1]!.shutdown).toHaveBeenCalledTimes(1);
  });

  it('retires a superseded project configuration after its turn lease releases', async () => {
    const registry = new ProjectMCPManagerRegistry();
    const project = runtime('/projects/a', 'alpha');
    registry.acquire(project);
    const manager = mocks.instances.at(-1)!;

    registry.invalidateProject('/projects/a');
    expect(manager.shutdown).not.toHaveBeenCalled();

    registry.release(project);
    await Promise.resolve();
    expect(manager.shutdown).toHaveBeenCalledTimes(1);
  });
});
