import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAgents: vi.fn(),
  loadSkills: vi.fn(),
  loadPersonalities: vi.fn(),
  registerBuiltinTools: vi.fn(),
  invalidate: vi.fn(),
  clear: vi.fn(),
}));

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
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    invalidate: mocks.invalidate,
    clear: mocks.clear,
  }),
}));

// The MCP registry imports the trust store, whose module-scope singleton
// needs config/loader exports this suite's mock does not provide.
vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => 'trusted',
}));

import { reloadDefinitionRegistries } from '../../src/main/defs/reload';

beforeEach(() => {
  vi.clearAllMocks();
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
