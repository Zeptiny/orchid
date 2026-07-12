import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadAgents: vi.fn(),
  loadSkills: vi.fn(),
  loadPersonalities: vi.fn(),
  applyWorkspaceProjectLayers: vi.fn(),
  resetLastAppliedProjectDir: vi.fn(),
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

vi.mock('../../src/main/project/layers', () => ({
  applyWorkspaceProjectLayers: mocks.applyWorkspaceProjectLayers,
  resetLastAppliedProjectDir: mocks.resetLastAppliedProjectDir,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    invalidate: mocks.invalidate,
    clear: mocks.clear,
  }),
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
    expect(mocks.applyWorkspaceProjectLayers).not.toHaveBeenCalled();
    expect(mocks.loadPersonalities).not.toHaveBeenCalled();
  });

  it('clears every project runtime when a global definition changes', () => {
    reloadDefinitionRegistries(null);

    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ homeDir: '/home/agents' });
    expect(mocks.loadSkills).toHaveBeenCalledWith({ homeDir: '/home/skills' });
  });
});
