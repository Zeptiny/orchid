/**
 * U5 — Project config / agents / skills reload on workspace change.
 *
 * Covers:
 * - Switching projectDir applies project `.orchid.json` overrides after reset+load
 * - Project agents/skills under `.orchid/agents|skills` become visible after switch
 * - Reload is a no-op when path is unchanged
 * - Missing project config still loads home+defaults successfully
 * - Does not touch background command store (no terminate)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyWorkspaceProjectLayers,
  getLastAppliedProjectDir,
  resetLastAppliedProjectDir,
} from '../../src/main/project/layers';
import { ConfigManager, getConfig } from '../../src/main/config/loader';
import { getAgent, listAgents, resetAgentRegistry } from '../../src/main/agents/registry';
import { getSkill, listSkills, resetSkillRegistry } from '../../src/main/skills/registry';
import { AgentTier } from '../../src/shared/types/agent';

// ---------------------------------------------------------------------------
// Temp helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let homeConfigPath: string;
let homeAgentsDir: string;
let homeSkillsDir: string;
let projectA: string;
let projectB: string;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function writeAgent(
  baseDir: string,
  agentName: string,
  frontmatter: string,
  body: string,
): void {
  const dir = path.join(baseDir, agentName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\n${frontmatter}\n---\n${body}`,
    'utf-8',
  );
}

function writeSkill(
  baseDir: string,
  skillName: string,
  frontmatter: string,
  body: string,
): void {
  const dir = path.join(baseDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n${body}`,
    'utf-8',
  );
}

function applyOpts(projectDir: string) {
  return applyWorkspaceProjectLayers(projectDir, {
    homeConfigPath,
    homeAgentsDir,
    homeSkillsDir,
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-layers-'));
  homeConfigPath = path.join(tmpRoot, 'home', 'config.json');
  homeAgentsDir = path.join(tmpRoot, 'home', 'agents');
  homeSkillsDir = path.join(tmpRoot, 'home', 'skills');
  projectA = path.join(tmpRoot, 'project-a');
  projectB = path.join(tmpRoot, 'project-b');

  fs.mkdirSync(homeAgentsDir, { recursive: true });
  fs.mkdirSync(homeSkillsDir, { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  // Home config + one home agent/skill
  writeJson(homeConfigPath, {
    default_model: 'home/model',
    command_timeout: 30,
  });
  writeAgent(
    homeAgentsDir,
    'general',
    'name: general\ntype: internal\ntier: bloom\ndescription: Home general\nallowed_tools:\n  - read\nallowed_skills:\n  - \'*\'',
    'Home prompt',
  );
  writeSkill(
    homeSkillsDir,
    'work',
    'name: work\ndescription: Home work skill',
    'Home work body',
  );

  // Project A: config override + project-only agent/skill. The planted
  // `general` file verifies that reserved internal agents cannot be overlaid.
  writeJson(path.join(projectA, '.orchid.json'), {
    default_model: 'project-a/model',
    command_timeout: 99,
  });
  writeAgent(
    path.join(projectA, '.orchid', 'agents'),
    'general',
    'name: general\ntype: internal\ntier: crown\ndescription: Project A general\nallowed_tools:\n  - read\n  - grep\nallowed_skills:\n  - work',
    'Project A prompt',
  );
  writeAgent(
    path.join(projectA, '.orchid', 'agents'),
    'proj-a-agent',
    'name: proj-a-agent\ntype: subagent\ntier: seed\ndescription: Only in project A\nallowed_tools:\n  - read',
    'A-only',
  );
  writeSkill(
    path.join(projectA, '.orchid', 'skills'),
    'work',
    'name: work\ndescription: Project A work skill',
    'Project A work body',
  );
  writeSkill(
    path.join(projectA, '.orchid', 'skills'),
    'proj-a-skill',
    'name: proj-a-skill\ndescription: Only in project A',
    'A-only skill',
  );

  // Project B: different overrides
  writeJson(path.join(projectB, '.orchid.json'), {
    default_model: 'project-b/model',
    command_timeout: 12,
  });
  writeAgent(
    path.join(projectB, '.orchid', 'agents'),
    'proj-b-agent',
    'name: proj-b-agent\ntype: subagent\ntier: sprout\ndescription: Only in project B\nallowed_tools:\n  - grep',
    'B-only',
  );
  writeSkill(
    path.join(projectB, '.orchid', 'skills'),
    'proj-b-skill',
    'name: proj-b-skill\ndescription: Only in project B',
    'B-only skill',
  );

  ConfigManager.reset();
  resetAgentRegistry();
  resetSkillRegistry();
  resetLastAppliedProjectDir();
});

afterEach(() => {
  ConfigManager.reset();
  resetAgentRegistry();
  resetSkillRegistry();
  resetLastAppliedProjectDir();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ===========================================================================
// Config reload
// ===========================================================================

describe('applyWorkspaceProjectLayers — config', () => {
  it('applies project .orchid.json overrides after reset+load', () => {
    const result = applyOpts(projectA);
    expect(result.applied).toBe(true);
    expect(result.config.default_model).toBe('project-a/model');
    expect(result.config.command_timeout).toBe(99);
    expect(getConfig().default_model).toBe('project-a/model');
  });

  it('switches project overrides when applying a different projectDir', () => {
    applyOpts(projectA);
    expect(getConfig().default_model).toBe('project-a/model');

    const resultB = applyOpts(projectB);
    expect(resultB.applied).toBe(true);
    expect(getConfig().default_model).toBe('project-b/model');
    expect(getConfig().command_timeout).toBe(12);
  });

  it('loads home+defaults successfully when project has no .orchid.json', () => {
    const bare = path.join(tmpRoot, 'bare-project');
    fs.mkdirSync(bare, { recursive: true });

    const result = applyOpts(bare);
    expect(result.applied).toBe(true);
    // Home values apply; no project override
    expect(result.config.default_model).toBe('home/model');
    expect(result.config.command_timeout).toBe(30);
  });
});

// ===========================================================================
// Agents / skills reload
// ===========================================================================

describe('applyWorkspaceProjectLayers — agents & skills', () => {
  it('makes project agents/skills visible after switch', () => {
    const result = applyOpts(projectA);
    expect(result.applied).toBe(true);

    // Reserved internal agents remain owned by the home layer.
    const general = getAgent('general');
    expect(general).toBeDefined();
    expect(general!.description).toBe('Home general');
    expect(general!.tier).toBe(AgentTier.BLOOM);
    expect(general!.allowed_tools).toEqual(['read']);

    // Project-only agent
    expect(getAgent('proj-a-agent')).toBeDefined();
    expect(getAgent('proj-a-agent')!.description).toBe('Only in project A');

    // Project skill overlay
    const work = getSkill('work');
    expect(work).toBeDefined();
    expect(work!.description).toBe('Project A work skill');
    expect(getSkill('proj-a-skill')).toBeDefined();
  });

  it('drops previous project agents/skills when switching projects', () => {
    applyOpts(projectA);
    expect(getAgent('proj-a-agent')).toBeDefined();
    expect(getSkill('proj-a-skill')).toBeDefined();

    applyOpts(projectB);

    // A-only gone
    expect(getAgent('proj-a-agent')).toBeUndefined();
    expect(getSkill('proj-a-skill')).toBeUndefined();

    // B-only present
    expect(getAgent('proj-b-agent')).toBeDefined();
    expect(getSkill('proj-b-skill')).toBeDefined();

    // Home general remains (not overlaid by B)
    const general = getAgent('general');
    expect(general).toBeDefined();
    expect(general!.description).toBe('Home general');
    expect(general!.tier).toBe(AgentTier.BLOOM);

    // Home work skill remains
    expect(getSkill('work')!.description).toBe('Home work skill');
  });

  it('project-local skill/agent appears only after applying that projectDir', () => {
    // Apply B first — A-only resources must not appear
    applyOpts(projectB);
    expect(listAgents().map((a) => a.name).sort()).toEqual([
      'general',
      'proj-b-agent',
    ]);
    expect(listSkills().map((s) => s.name).sort()).toEqual([
      'proj-b-skill',
      'work',
    ]);

    applyOpts(projectA);
    expect(getAgent('proj-a-agent')).toBeDefined();
    expect(getSkill('proj-a-skill')).toBeDefined();
    expect(getAgent('proj-b-agent')).toBeUndefined();
  });
});

// ===========================================================================
// Redundant reload skip
// ===========================================================================

describe('applyWorkspaceProjectLayers — lastApplied tracking', () => {
  it('skips reload when path is unchanged', () => {
    const first = applyOpts(projectA);
    expect(first.applied).toBe(true);
    expect(getLastAppliedProjectDir()).toBe(fs.realpathSync(projectA));

    const second = applyOpts(projectA);
    expect(second.applied).toBe(false);
    expect(second.config.default_model).toBe('project-a/model');
  });

  it('force: true reloads even when path is unchanged', () => {
    applyOpts(projectA);

    // Mutate project config on disk
    writeJson(path.join(projectA, '.orchid.json'), {
      default_model: 'project-a/forced',
    });

    const forced = applyWorkspaceProjectLayers(projectA, {
      force: true,
      homeConfigPath,
      homeAgentsDir,
      homeSkillsDir,
    });
    expect(forced.applied).toBe(true);
    expect(forced.config.default_model).toBe('project-a/forced');
  });

  it('resetLastAppliedProjectDir allows re-apply of same path', () => {
    applyOpts(projectA);
    resetLastAppliedProjectDir();
    expect(getLastAppliedProjectDir()).toBeNull();

    const again = applyOpts(projectA);
    expect(again.applied).toBe(true);
  });
});

// ===========================================================================
// Background commands safety (R5)
// ===========================================================================

describe('applyWorkspaceProjectLayers — does not kill background commands', () => {
  it('does not call background-store terminate methods', async () => {
    const { getBackgroundStore } = await import(
      '../../src/main/tools/process/background-store'
    );
    const store = getBackgroundStore();
    const terminateSpy = vi.spyOn(store, 'terminate').mockImplementation(() => {});
    const terminateAllSpy = vi
      .spyOn(store, 'terminateAll')
      .mockImplementation(() => {});
    const terminateSessionSpy = vi
      .spyOn(store, 'terminateSession')
      .mockImplementation(() => {});
    const listBefore = store.list();

    applyOpts(projectA);
    applyOpts(projectB);

    expect(terminateSpy).not.toHaveBeenCalled();
    expect(terminateAllSpy).not.toHaveBeenCalled();
    expect(terminateSessionSpy).not.toHaveBeenCalled();
    expect(store.list()).toEqual(listBefore);

    terminateSpy.mockRestore();
    terminateAllSpy.mockRestore();
    terminateSessionSpy.mockRestore();
  });
});
