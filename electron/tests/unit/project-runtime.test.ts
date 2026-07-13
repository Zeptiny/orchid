/**
 * Project runtime snapshots — independent config/definition layers per project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAgent,
  loadAgents,
  resetAgentRegistry,
} from '../../src/main/agents/registry';
import {
  getSkill,
  loadSkills,
  resetSkillRegistry,
} from '../../src/main/skills/registry';
import {
  getPersonality,
  loadPersonalities,
  resetPersonalityRegistry,
} from '../../src/main/personality/registry';
import { ProjectRuntimeRegistry } from '../../src/main/project/runtime';

let tmpRoot: string;
let homeConfigPath: string;
let homeAgentsDir: string;
let homeSkillsDir: string;
let homePersonalitiesDir: string;
let projectA: string;
let projectB: string;

const HOME_SELECTION = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'home/model',
};
const PROJECT_A_SELECTION = {
  connectionId: '22222222-2222-4222-8222-222222222222',
  modelId: 'project-a/model',
};
const PROJECT_B_SELECTION = {
  connectionId: '33333333-3333-4333-8333-333333333333',
  modelId: 'project-b/model',
};
const PROJECT_A_UPDATED_SELECTION = {
  connectionId: '44444444-4444-4444-8444-444444444444',
  modelId: 'project-a/updated',
};

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writeAgent(
  baseDir: string,
  name: string,
  description: string,
): void {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    [
      '---',
      `name: ${name}`,
      'type: subagent',
      'tier: bloom',
      `description: ${description}`,
      '---',
      `${description} prompt`,
    ].join('\n'),
    'utf-8',
  );
}

function writeSkill(
  baseDir: string,
  name: string,
  description: string,
): void {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      `${description} body`,
    ].join('\n'),
    'utf-8',
  );
}

function writePersonality(
  projectOrHomeDir: string,
  name: string,
  content: string,
): void {
  fs.mkdirSync(projectOrHomeDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectOrHomeDir, `${name}.md`),
    content,
    'utf-8',
  );
}

function createRegistry(): ProjectRuntimeRegistry {
  return new ProjectRuntimeRegistry({
    homeConfigPath,
    homeAgentsDir,
    homeSkillsDir,
    homePersonalitiesDir,
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-project-runtime-'));
  const homeDir = path.join(tmpRoot, 'home');
  homeConfigPath = path.join(homeDir, 'config.json');
  homeAgentsDir = path.join(homeDir, 'agents');
  homeSkillsDir = path.join(homeDir, 'skills');
  homePersonalitiesDir = path.join(homeDir, 'personalities');
  projectA = path.join(tmpRoot, 'project-a');
  projectB = path.join(tmpRoot, 'project-b');

  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  writeJson(homeConfigPath, { default_model: HOME_SELECTION });
  writeAgent(homeAgentsDir, 'shared-agent', 'Home agent');
  writeSkill(homeSkillsDir, 'shared-skill', 'Home skill');
  writePersonality(homePersonalitiesDir, 'voice', 'Home voice');

  writeJson(path.join(projectA, '.orchid.json'), {
    default_model: PROJECT_A_SELECTION,
  });
  writeAgent(
    path.join(projectA, '.orchid', 'agents'),
    'shared-agent',
    'Project A agent',
  );
  writeAgent(
    path.join(projectA, '.orchid', 'agents'),
    'a-only-agent',
    'A-only agent',
  );
  writeSkill(
    path.join(projectA, '.orchid', 'skills'),
    'shared-skill',
    'Project A skill',
  );
  writePersonality(
    path.join(projectA, '.orchid', 'personalities'),
    'voice',
    'Project A voice',
  );

  writeJson(path.join(projectB, '.orchid.json'), {
    default_model: PROJECT_B_SELECTION,
  });
  writeAgent(
    path.join(projectB, '.orchid', 'agents'),
    'shared-agent',
    'Project B agent',
  );
  writeAgent(
    path.join(projectB, '.orchid', 'agents'),
    'b-only-agent',
    'B-only agent',
  );
  writeSkill(
    path.join(projectB, '.orchid', 'skills'),
    'shared-skill',
    'Project B skill',
  );
  writePersonality(
    path.join(projectB, '.orchid', 'personalities'),
    'voice',
    'Project B voice',
  );

  resetAgentRegistry();
  resetSkillRegistry();
  resetPersonalityRegistry();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentRegistry();
  resetSkillRegistry();
  resetPersonalityRegistry();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ProjectRuntimeRegistry', () => {
  it('keeps project overrides in independent snapshots without replacing globals', () => {
    loadAgents({ homeDir: homeAgentsDir });
    loadSkills({ homeDir: homeSkillsDir });
    loadPersonalities({ homeDir: homePersonalitiesDir });

    const registry = createRegistry();
    const runtimeA = registry.get(projectA);
    const runtimeB = registry.get(projectB);

    expect(runtimeA.config.default_model).toEqual(PROJECT_A_SELECTION);
    expect(runtimeA.agents.get('shared-agent')?.description).toBe('Project A agent');
    expect(runtimeA.agents.has('a-only-agent')).toBe(true);
    expect(runtimeA.agents.has('b-only-agent')).toBe(false);
    expect(runtimeA.skills.get('shared-skill')?.description).toBe('Project A skill');
    expect(runtimeA.personalities.get('voice')).toBe('Project A voice');

    expect(runtimeB.config.default_model).toEqual(PROJECT_B_SELECTION);
    expect(runtimeB.agents.get('shared-agent')?.description).toBe('Project B agent');
    expect(runtimeB.agents.has('a-only-agent')).toBe(false);
    expect(runtimeB.agents.has('b-only-agent')).toBe(true);
    expect(runtimeB.skills.get('shared-skill')?.description).toBe('Project B skill');
    expect(runtimeB.personalities.get('voice')).toBe('Project B voice');

    // Loading B neither mutates A nor replaces the legacy global registries.
    expect(runtimeA.agents.get('shared-agent')?.description).toBe('Project A agent');
    expect(runtimeA.personalities.get('voice')).toBe('Project A voice');
    expect(getAgent('shared-agent')?.description).toBe('Home agent');
    expect(getSkill('shared-skill')?.description).toBe('Home skill');
    expect(getPersonality('voice')).toBe('Home voice');
  });

  it('keys the cache by canonical path and supports invalidation and clearing', () => {
    const alias = path.join(tmpRoot, 'project-a-alias');
    fs.symlinkSync(
      projectA,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const registry = createRegistry();

    const fromAlias = registry.get(alias);
    const fromCanonicalPath = registry.get(projectA);

    expect(fromAlias).toBe(fromCanonicalPath);
    expect(fromAlias.projectDir).toBe(fs.realpathSync(projectA));
    expect(registry.size).toBe(1);

    writeJson(path.join(projectA, '.orchid.json'), {
      default_model: PROJECT_A_UPDATED_SELECTION,
    });
    expect(registry.get(projectA).config.default_model).toEqual(PROJECT_A_SELECTION);

    expect(registry.invalidate(alias)).toBe(true);
    const reloaded = registry.get(projectA);
    expect(reloaded).not.toBe(fromAlias);
    expect(reloaded.config.default_model).toEqual(PROJECT_A_UPDATED_SELECTION);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.get(projectA)).not.toBe(reloaded);
  });

  it('requires an explicit absolute project path and never consults process.cwd', () => {
    const registry = createRegistry();

    expect(() => registry.get('relative-project')).toThrow(/absolute/i);

    const cwdSpy = vi
      .spyOn(process, 'cwd')
      .mockImplementation(() => {
        throw new Error('process.cwd must not be used');
      });

    expect(registry.get(projectA).projectDir).toBe(fs.realpathSync(projectA));
    expect(cwdSpy).not.toHaveBeenCalled();
  });
});
