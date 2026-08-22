import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const PROJECT_DIR = '/projects/overlay';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    loadAgents: vi.fn(),
    loadSkills: vi.fn(),
    loadPersonalities: vi.fn(),
    registerBuiltinTools: vi.fn(),
    invalidate: vi.fn(),
    clear: vi.fn(),
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    resolveBoundProjectPath: vi.fn((): string | null => PROJECT_DIR),
    listManagedSkills: vi.fn((projectDir: string | null) => [
      { name: projectDir == null ? 'home-skill' : 'project-skill' },
    ]),
    listManagedAgents: vi.fn((projectDir: string | null) => [
      { name: projectDir == null ? 'home-agent' : 'project-agent' },
    ]),
    listManagedPersonalities: vi.fn((projectDir: string | null) => [
      { name: projectDir == null ? 'home-personality' : 'project-personality' },
    ]),
    toolRegistryListAll: vi.fn(() => []),
    trustState: { current: 'trusted' as 'trusted' | 'untrusted' | 'changed' },
  };
});

vi.mock('../../src/main/config/loader', () => ({
  HOME_AGENTS_DIR: '/home/agents',
  HOME_PERSONALITIES_DIR: '/home/personalities',
  HOME_SKILLS_DIR: '/home/skills',
}));

vi.mock('../../src/main/agents/registry', () => ({
  loadAgents: mocks.loadAgents,
}));

vi.mock('../../src/main/skills/registry', () => ({
  loadSkills: mocks.loadSkills,
}));

vi.mock('../../src/main/personality/registry', () => ({
  loadPersonalities: mocks.loadPersonalities,
}));

vi.mock('../../src/main/tools', () => ({
  registerBuiltinTools: mocks.registerBuiltinTools,
  toolRegistry: { listAll: mocks.toolRegistryListAll },
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    invalidate: mocks.invalidate,
    clear: mocks.clear,
  }),
}));

// The MCP registry imports the trust store, whose module-scope singleton
// needs config/loader exports this suite's mock does not provide. It
// defaults to trusted; definitions:list tests flip the holder to exercise
// the home-only listing gate.
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => mocks.trustState.current,
}));

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock('../../src/main/ipc/session', () => ({
  resolveBoundProjectPath: mocks.resolveBoundProjectPath,
}));

vi.mock('../../src/main/defs/manage', () => ({
  listManagedSkills: mocks.listManagedSkills,
  listManagedAgents: mocks.listManagedAgents,
  listManagedPersonalities: mocks.listManagedPersonalities,
  listManagedSharedPrompts: vi.fn(() => []),
  saveSkill: vi.fn(),
  saveAgent: vi.fn(),
  savePersonality: vi.fn(),
  saveSharedPrompt: vi.fn(),
  deleteSkill: vi.fn(),
  deleteAgent: vi.fn(),
  deletePersonality: vi.fn(),
  deleteSharedPrompt: vi.fn(),
}));

import { reloadDefinitionRegistries } from '../../src/main/defs/reload';
import {
  registerDefinitionsIPC,
  unregisterDefinitionsIPC,
} from '../../src/main/ipc/definitions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trustState.current = 'trusted';
});

describe('reloadDefinitionRegistries', () => {
  it('invalidates only the changed project runtime', () => {
    reloadDefinitionRegistries('/projects/orchid');

    expect(mocks.invalidate).toHaveBeenCalledWith('/projects/orchid');
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.loadPersonalities).not.toHaveBeenCalled();
    expect(mocks.registerBuiltinTools).not.toHaveBeenCalled();
  });

  it('rebuilds compatibility tools once after loading global agent and skill maps', () => {
    const agents = new Map([['helper', { name: 'helper' }]]);
    const skills = new Map([['work', { name: 'work' }]]);
    mocks.loadAgents.mockReturnValue(agents);
    mocks.loadSkills.mockReturnValue(skills);

    reloadDefinitionRegistries(null);

    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ homeDir: '/home/agents' });
    expect(mocks.loadSkills).toHaveBeenCalledWith({ homeDir: '/home/skills' });
    expect(mocks.registerBuiltinTools).toHaveBeenCalledTimes(1);
    expect(mocks.registerBuiltinTools).toHaveBeenCalledWith({ agents, skills });
    expect(mocks.registerBuiltinTools.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.loadSkills.mock.invocationCallOrder[0],
    );
  });
});

// No dedicated definitions-ipc suite exists, so the definitions:list trust
// gate is covered here alongside the other definition-domain behavior.
describe('definitions:list trust gate', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.resolveBoundProjectPath.mockReturnValue(PROJECT_DIR);
    registerDefinitionsIPC();
  });

  afterEach(() => {
    unregisterDefinitionsIPC();
  });

  async function listDefinitions() {
    const handler = mocks.handlers.get(IPC_CHANNELS.DEFINITIONS_LIST);
    if (!handler) throw new Error('definitions:list handler not registered');
    return (await handler({ sender: { id: 9 } })) as {
      projectDir: string | null;
      skills: { name: string }[];
      agents: { name: string }[];
      personalities: { name: string }[];
      availableSkills: string[];
    };
  }

  it('applies the project overlay when the project is trusted', async () => {
    const result = await listDefinitions();

    expect(mocks.listManagedSkills).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.listManagedAgents).toHaveBeenCalledWith(PROJECT_DIR);
    expect(mocks.listManagedPersonalities).toHaveBeenCalledWith(PROJECT_DIR);
    expect(result.skills.map((s) => s.name)).toEqual(['project-skill']);
    expect(result.agents.map((a) => a.name)).toEqual(['project-agent']);
    expect(result.personalities.map((p) => p.name)).toEqual(['project-personality']);
  });

  it('lists home-only definitions for an untrusted project', async () => {
    mocks.trustState.current = 'untrusted';

    const result = await listDefinitions();

    // The bound directory is still reported, but no overlay is loaded.
    expect(result.projectDir).toBe(PROJECT_DIR);
    expect(mocks.listManagedSkills).toHaveBeenCalledWith(null);
    expect(mocks.listManagedAgents).toHaveBeenCalledWith(null);
    expect(mocks.listManagedPersonalities).toHaveBeenCalledWith(null);
    expect(result.skills.map((s) => s.name)).toEqual(['home-skill']);
    expect(result.agents.map((a) => a.name)).toEqual(['home-agent']);
    expect(result.personalities.map((p) => p.name)).toEqual(['home-personality']);
    expect(result.availableSkills).toEqual(['home-skill']);
  });

  it('lists home-only definitions when the grant has drifted (changed)', async () => {
    mocks.trustState.current = 'changed';

    const result = await listDefinitions();

    expect(mocks.listManagedSkills).toHaveBeenCalledWith(null);
    expect(mocks.listManagedAgents).toHaveBeenCalledWith(null);
    expect(mocks.listManagedPersonalities).toHaveBeenCalledWith(null);
    expect(result.skills.map((s) => s.name)).toEqual(['home-skill']);
  });

  it('lists home-only definitions when no project is bound', async () => {
    mocks.resolveBoundProjectPath.mockReturnValue(null);

    await listDefinitions();

    expect(mocks.listManagedSkills).toHaveBeenCalledWith(null);
    expect(mocks.listManagedAgents).toHaveBeenCalledWith(null);
    expect(mocks.listManagedPersonalities).toHaveBeenCalledWith(null);
  });
});
