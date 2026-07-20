/**
 * MCP IPC handler tests — mcp:status project binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const PROJECT_DIR = '/tmp/orchid-mcp-ipc-project';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const getStatus = vi.fn(() => [
    { name: 'filesystem', status: 'connected' as const, tools: 3 },
  ]);
  const getManager = vi.fn(() => ({ getStatus }));
  const getRuntime = vi.fn(() => ({ projectDir: PROJECT_DIR, config: {} }));

  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    resolveBoundProjectPath: vi.fn((): string | null => PROJECT_DIR),
    getManager,
    getStatus,
    getRuntime,
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain }));

vi.mock('../../src/main/ipc/session', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: mocks.getRuntime }),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  getProjectMCPManager: mocks.getManager,
}));

let mcpIpc: typeof import('../../src/main/ipc/mcp');

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.resolveBoundProjectPath.mockReset();
  mocks.resolveBoundProjectPath.mockReturnValue(PROJECT_DIR);
  mocks.getStatus.mockClear();
  mocks.getStatus.mockReturnValue([
    { name: 'filesystem', status: 'connected' as const, tools: 3 },
  ]);
  mocks.getManager.mockClear();
  mocks.getManager.mockReturnValue({ getStatus: mocks.getStatus });
  mocks.getRuntime.mockClear();
  mocks.getRuntime.mockReturnValue({ projectDir: PROJECT_DIR, config: {} });

  mcpIpc = await import('../../src/main/ipc/mcp');
  mcpIpc.registerMCPIPC();
});

afterEach(() => {
  mcpIpc.unregisterMCPIPC();
});

function getHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.MCP_STATUS);
  if (!handler) throw new Error('mcp:status handler not registered');
  return handler;
}

describe('mcp:status', () => {
  it('returns empty list when workspace is unbound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    await expect(getHandler()({ sender: { id: 1 } })).resolves.toEqual([]);
    expect(mocks.getManager).not.toHaveBeenCalled();
  });

  it('resolves project runtime from the sender window and returns status', async () => {
    const status = await getHandler()({ sender: { id: 9 } });

    expect(mocks.resolveBoundProjectPath).toHaveBeenCalledWith('9');
    expect(mocks.getRuntime).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.getManager).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: PROJECT_DIR }),
    );
    expect(status).toEqual([
      { name: 'filesystem', status: 'connected', tools: 3 },
    ]);
  });
});
