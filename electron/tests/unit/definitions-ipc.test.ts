/**
 * Definitions IPC tests — definitions:list availableTools MCP inclusion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { HOST_ERROR_CODES } from '../../src/shared/host/protocol';
import { clearActiveMachine, setActiveMachine } from '../../src/main/host/routing';

const PROJECT_DIR = '/tmp/orchid-definitions-ipc-project';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  const listAll = vi.fn(() => [
    { definition: { name: 'read' } },
    { definition: { name: 'write' } },
  ]);
  const getTools = vi.fn(() => [
    { definition: { name: 'mcp::context7::query-docs' } },
    { definition: { name: 'mcp::context7::resolve-library-id' } },
  ]);
  const getManager = vi.fn(() => ({ getTools }));
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
    shell: { showItemInFolder: vi.fn() },
    resolveBoundProjectPath: vi.fn((): string | null => PROJECT_DIR),
    getProjectTrustState: vi.fn(() => 'trusted'),
    listAll,
    getTools,
    getManager,
    getRuntime,
    listManagedSkills: vi.fn(() => []),
    listManagedAgents: vi.fn(() => []),
    listManagedPersonalities: vi.fn(() => []),
    listManagedSharedPrompts: vi.fn(() => []),
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain, shell: mocks.shell }));

vi.mock('../../src/main/ipc/session', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
}));

// U5: the host-routed handler resolves the caller's project through the
// session singleton (the server binding), not the IPC re-export.
vi.mock('../../src/main/session/singleton', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
  resolveWindowWorkspace: () => ({ cwd: null, source: 'unbound', status: 'unbound' }),
  getSessionManager: () => ({ getActive: () => null, listSaved: () => [] }),
}));

vi.mock('../../src/main/defs/manage', () => ({
  listManagedSkills: mocks.listManagedSkills,
  listManagedAgents: mocks.listManagedAgents,
  listManagedPersonalities: mocks.listManagedPersonalities,
  listManagedSharedPrompts: mocks.listManagedSharedPrompts,
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
  saveAgent: vi.fn(),
  deleteAgent: vi.fn(),
  savePersonality: vi.fn(),
  deletePersonality: vi.fn(),
  saveSharedPrompt: vi.fn(),
  deleteSharedPrompt: vi.fn(),
}));

vi.mock('../../src/main/defs/paths', () => ({
  assertPathUnderOrchidRoots: vi.fn((p: string) => p),
}));

vi.mock('../../src/main/defs/reload', () => ({
  reloadDefinitionRegistries: vi.fn(),
}));

vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: mocks.getProjectTrustState,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: mocks.getRuntime }),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  getProjectMCPManager: mocks.getManager,
}));

vi.mock('../../src/main/tools', () => ({
  toolRegistry: { listAll: mocks.listAll },
  // U5: the embedded local host's HostServer installs its own notifier.
  setTodosChangedNotifier: vi.fn(),
  getSubagentManager: () => ({ addOnChangeListener: vi.fn(() => vi.fn()) }),
}));

let definitionsIpc: typeof import('../../src/main/ipc/definitions');

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.resolveBoundProjectPath.mockReset();
  mocks.resolveBoundProjectPath.mockReturnValue(PROJECT_DIR);
  mocks.getProjectTrustState.mockReset();
  mocks.getProjectTrustState.mockReturnValue('trusted');
  mocks.listAll.mockClear();
  mocks.getTools.mockClear();
  mocks.getManager.mockClear();
  mocks.getManager.mockReturnValue({ getTools: mocks.getTools });
  mocks.getRuntime.mockClear();
  mocks.getRuntime.mockReturnValue({ projectDir: PROJECT_DIR, config: {} });

  definitionsIpc = await import('../../src/main/ipc/definitions');
  definitionsIpc.registerDefinitionsIPC();
});

afterEach(() => {
  definitionsIpc.unregisterDefinitionsIPC();
});

interface DefinitionsListResult {
  availableTools: string[];
}

function getListHandler() {
  const handler = mocks.handlers.get(IPC_CHANNELS.DEFINITIONS_LIST);
  if (!handler) throw new Error('definitions:list handler not registered');
  return handler as (event: unknown) => Promise<DefinitionsListResult>;
}

describe('definitions:list availableTools', () => {
  it('includes namespaced MCP tools for a bound project', async () => {
    const result = await getListHandler()({ sender: { id: 3 } });

    expect(mocks.resolveBoundProjectPath).toHaveBeenCalledWith('3');
    expect(mocks.getRuntime).toHaveBeenCalledWith(PROJECT_DIR);
    expect(result.availableTools).toEqual([
      'mcp::context7::query-docs',
      'mcp::context7::resolve-library-id',
      'read',
      'write',
    ]);
  });

  it('omits MCP tools when the window is unbound and does not touch the manager', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    const result = await getListHandler()({ sender: { id: 4 } });

    expect(mocks.getManager).not.toHaveBeenCalled();
    expect(result.availableTools).toEqual(['read', 'write']);
  });

  it('falls back to builtin tools when MCP enumeration fails', async () => {
    mocks.getRuntime.mockImplementation(() => {
      throw new Error('runtime unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await getListHandler()({ sender: { id: 5 } });

    expect(result.availableTools).toEqual(['read', 'write']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('definition:reveal', () => {
  it('reveals a local definition path through the shell', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.DEFINITION_REVEAL);
    if (!reveal) throw new Error('definition:reveal handler not registered');

    await expect(reveal({ sender: { id: 6 } }, { path: '/home/u/.orchid/skills/x/SKILL.md' }))
      .resolves.toEqual({ status: 'ok' });
    expect(mocks.shell.showItemInFolder).toHaveBeenCalledWith('/home/u/.orchid/skills/x/SKILL.md');
  });

  it('rejects with the typed UNSUPPORTED_ON_HOST error on a remote-active window (#30)', async () => {
    setActiveMachine('6', 'ssh-remote-1');
    try {
      const reveal = mocks.handlers.get(IPC_CHANNELS.DEFINITION_REVEAL)!;
      mocks.shell.showItemInFolder.mockClear();

      // The path came from definitions:list on the REMOTE machine; the local
      // shell must degrade with the same typed capability error the daemon
      // would answer, not a misleading local-path failure.
      await expect(
        reveal({ sender: { id: 6 } }, { path: '/remote/home/.orchid/skills/x/SKILL.md' }),
      ).rejects.toMatchObject({
        code: HOST_ERROR_CODES.UNSUPPORTED_ON_HOST,
        message: expect.stringContaining("'definitions.reveal' capability"),
      });
      expect(mocks.shell.showItemInFolder).not.toHaveBeenCalled();
    } finally {
      clearActiveMachine('6');
    }
  });
});
