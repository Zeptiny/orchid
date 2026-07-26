/**
 * Agent & Skill Loading Tests — U6.
 *
 * Covers:
 * - Frontmatter parsing (key-value, lists, body extraction)
 * - Load all 27 agents → correct tiers, types, tools
 * - Load all 15 skills → correct dependencies, resources
 * - Merge: home overlaid by project (project wins on conflict)
 * - Seeding: empty dirs → defaults copied, existing → not overwritten
 * - Skill resources: references/*.md → discovered with descriptions
 * - Tier resolution: getTierModelSelection(config, tier) returns a typed
 *   connection-scoped selection or null
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseFrontmatter,
  getString,
  getStringArray,
} from '../../src/shared/utils/frontmatter';
import {
  loadAgents,
  getAgent,
  listAgents,
  seedAgentsDir,
  resetAgentRegistry,
} from '../../src/main/agents/registry';
import {
  loadSkills,
  getSkill,
  listSkills,
  seedSkillsDir,
  resetSkillRegistry,
} from '../../src/main/skills/registry';
import { AgentType, AgentTier } from '../../src/shared/types/agent';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-agent-skill-test-'));
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
  resources?: { dir: string; files: Record<string, string> }[],
): void {
  const dir = path.join(baseDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n${body}`,
    'utf-8',
  );

  if (resources) {
    for (const r of resources) {
      const rDir = path.join(dir, r.dir);
      fs.mkdirSync(rDir, { recursive: true });
      for (const [name, content] of Object.entries(r.files)) {
        fs.writeFileSync(path.join(rDir, name), content, 'utf-8');
      }
    }
  }
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  resetAgentRegistry();
  resetSkillRegistry();
});

afterEach(() => {
  resetAgentRegistry();
  resetSkillRegistry();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Frontmatter parser
// ===========================================================================

describe('parseFrontmatter', () => {
  it('should parse key-value pairs', () => {
    const { metadata, body } = parseFrontmatter(
      '---\nname: general\ntype: internal\n---\nHello world',
    );
    expect(metadata.name).toBe('general');
    expect(metadata.type).toBe('internal');
    expect(body).toBe('Hello world');
  });

  it('should parse list values', () => {
    const { metadata } = parseFrontmatter(
      '---\nname: test\nallowed_tools:\n  - read\n  - grep\n  - edit\n---\nBody',
    );
    expect(metadata.name).toBe('test');
    expect(metadata.allowed_tools).toEqual(['read', 'grep', 'edit']);
  });

  it('should handle quoted values', () => {
    const { metadata } = parseFrontmatter(
      "---\nname: 'quoted'\ndescription: \"double quoted\"\n---\nBody",
    );
    expect(metadata.name).toBe('quoted');
    expect(metadata.description).toBe('double quoted');
  });

  it('should return empty metadata for content without frontmatter', () => {
    const { metadata, body } = parseFrontmatter('No frontmatter here');
    expect(metadata).toEqual({});
    expect(body).toBe('No frontmatter here');
  });

  it('should handle empty body', () => {
    const { metadata, body } = parseFrontmatter('---\nname: test\n---\n');
    expect(metadata.name).toBe('test');
    expect(body).toBe('');
  });

  it('should handle mixed keys and lists', () => {
    const { metadata } = parseFrontmatter(
      '---\nname: general\ntype: internal\ntier: bloom\ndescription: Test agent\nallowed_tools:\n  - read\n  - grep\nallowed_skills:\n  - work\n  - commit\n---\nBody text',
    );
    expect(metadata.name).toBe('general');
    expect(metadata.type).toBe('internal');
    expect(metadata.tier).toBe('bloom');
    expect(metadata.description).toBe('Test agent');
    expect(metadata.allowed_tools).toEqual(['read', 'grep']);
    expect(metadata.allowed_skills).toEqual(['work', 'commit']);
  });

  it('should strip quotes from list items', () => {
    const { metadata } = parseFrontmatter(
      '---\nrequires:\n  - "commit"\n  - \'debug\'\n---\nBody',
    );
    expect(metadata.requires).toEqual(['commit', 'debug']);
  });
});

describe('getString', () => {
  it('should return string value', () => {
    expect(getString({ name: 'test' }, 'name')).toBe('test');
  });

  it('should return fallback for missing key', () => {
    expect(getString({}, 'name', 'default')).toBe('default');
  });

  it('should return first element of array', () => {
    expect(getString({ name: ['a', 'b'] }, 'name')).toBe('a');
  });

  it('should return fallback for empty array', () => {
    expect(getString({ name: [] }, 'name', 'default')).toBe('default');
  });
});

describe('getStringArray', () => {
  it('should return array value', () => {
    expect(getStringArray({ tools: ['a', 'b'] }, 'tools')).toEqual(['a', 'b']);
  });

  it('should split comma-separated string', () => {
    expect(getStringArray({ tools: 'a, b, c' }, 'tools')).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('should return empty array for "[]"', () => {
    expect(getStringArray({ tools: '[]' }, 'tools')).toEqual([]);
  });

  it('should return fallback for missing key', () => {
    expect(getStringArray({}, 'tools', ['default'])).toEqual(['default']);
  });

  it('should return empty array for empty string', () => {
    expect(getStringArray({ tools: '' }, 'tools')).toEqual([]);
  });
});

// ===========================================================================
// Agent Loading — All 27 Defaults
// ===========================================================================

describe('Agent Loading — Defaults', () => {
  it('should load all 27 default agents', () => {
    const agents = loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    expect(agents.size).toBe(28);

    const names = Array.from(agents.keys()).sort();
    expect(names).toEqual([
      'adversarial-document-reviewer',
      'adversarial-reviewer',
      'agent-native-reviewer',
      'api-contract-reviewer',
      'architecture-strategist',
      'code-simplicity-reviewer',
      'coherence-reviewer',
      'correctness-reviewer',
      'data-integrity-guardian',
      'explorer',
      'feasibility-reviewer',
      'general',
      'implementer',
      'learnings-researcher',
      'maintainability-reviewer',
      'performance-reviewer',
      'permission-evaluator',
      'pr-comment-resolver',
      'product-lens-reviewer',
      'reliability-reviewer',
      'reviewer',
      'scope-guardian-reviewer',
      'security-reviewer',
      'session-namer',
      'spec-flow-analyzer',
      'testing-reviewer',
      'web-fetch',
      'web-researcher',
    ]);
  });

  it('should load general agent with correct properties', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const general = getAgent('general');
    expect(general).toBeDefined();
    expect(general!.type).toBe(AgentType.INTERNAL);
    expect(general!.tier).toBe(AgentTier.BLOOM);
    expect(general!.description).toBe(
      'General internal agent, cannot be called as subagent',
    );
    expect(general!.allowed_tools).toContain('read');
    expect(general!.allowed_tools).toContain('grep');
    expect(general!.allowed_tools).toContain('edit');
    expect(general!.allowed_tools).toContain('write');
    expect(general!.allowed_tools).toContain('apply_patch');
    expect(general!.allowed_tools).toContain('delegate_to_subagent');
    expect(general!.allowed_tools).toContain('plan_symbol_rename');
    expect(general!.allowed_skills).toEqual(['*']);
  });

  it('should load explorer agent with seed tier', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const explorer = getAgent('explorer');
    expect(explorer).toBeDefined();
    expect(explorer!.type).toBe(AgentType.SUBAGENT);
    expect(explorer!.tier).toBe(AgentTier.SEED);
    expect(explorer!.allowed_tools).toContain('read');
    expect(explorer!.allowed_tools).toContain('glob');
    expect(explorer!.allowed_tools).toContain('grep');
    expect(explorer!.allowed_tools).not.toContain('edit');
    expect(explorer!.allowed_tools).not.toContain('write');
  });

  it('should load reviewer agent with crown tier', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const reviewer = getAgent('reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.type).toBe(AgentType.SUBAGENT);
    expect(reviewer!.tier).toBe(AgentTier.CROWN);
  });

  it('should load web-fetch agent with empty allowed_tools', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const webFetch = getAgent('web-fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.type).toBe(AgentType.INTERNAL);
    expect(webFetch!.tier).toBe(AgentTier.SEED);
    expect(webFetch!.allowed_tools).toEqual([]);
  });

  it('should load session-namer as a tool-free internal seed agent', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const sessionNamer = getAgent('session-namer');
    expect(sessionNamer).toBeDefined();
    expect(sessionNamer!.type).toBe(AgentType.INTERNAL);
    expect(sessionNamer!.tier).toBe(AgentTier.SEED);
    expect(sessionNamer!.allowed_tools).toEqual([]);
    expect(sessionNamer!.allowed_skills).toEqual([]);
    expect(sessionNamer!.system_prompt).toContain('3-6 word');
  });

  it('should load implementer agent with correct tools and skills', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const impl = getAgent('implementer');
    expect(impl).toBeDefined();
    expect(impl!.type).toBe(AgentType.SUBAGENT);
    expect(impl!.tier).toBe(AgentTier.BLOOM);
    expect(impl!.allowed_tools).toContain('read');
    expect(impl!.allowed_tools).toContain('edit');
    expect(impl!.allowed_tools).toContain('write');
    expect(impl!.allowed_tools).toContain('apply_patch');
    expect(impl!.allowed_tools).toContain('execute_command');
    expect(impl!.allowed_tools).toContain('plan_symbol_rename');
    expect(impl!.allowed_skills).toContain('work');
    expect(impl!.allowed_skills).toContain('commit');
    expect(impl!.allowed_skills).toContain('debug');
  });

  it('should have correct tiers across all agents', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const agents = listAgents();
    const tierCounts = {
      seed: 0,
      sprout: 0,
      bloom: 0,
      crown: 0,
    };

    for (const agent of agents) {
      tierCounts[agent.tier]++;
    }

    // Verify tier distribution matches Python defaults
    expect(tierCounts.seed).toBe(4); // explorer, web-fetch, session-namer
    expect(tierCounts.sprout).toBe(2); // web-researcher, learnings-researcher
    expect(tierCounts.bloom).toBe(11); // general, implementer, api-contract, etc.
    expect(tierCounts.crown).toBe(11); // reviewers, adversarial, etc.
  });

  it('should have correct types across all agents', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const agents = listAgents();
    const internalAgents = agents.filter((a) => a.type === AgentType.INTERNAL);
    const subagentAgents = agents.filter(
      (a) => a.type === AgentType.SUBAGENT,
    );

    // Only bundled runtime-only agents are internal
    expect(internalAgents).toHaveLength(4);
    expect(internalAgents.map((a) => a.name).sort()).toEqual([
      'general',
      'permission-evaluator',
      'session-namer',
      'web-fetch',
    ]);

    // All others are subagents
    expect(subagentAgents).toHaveLength(24);
  });

  it('should list all agents via listAgents()', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const agents = listAgents();
    expect(agents).toHaveLength(28);
    expect(agents.every((a) => a.name && a.description)).toBe(true);
  });
});

// ===========================================================================
// Skill Loading — All 15 Defaults
// ===========================================================================

describe('Skill Loading — Defaults', () => {
  it('should load all 15 default skills', () => {
    const skills = loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    expect(skills.size).toBe(15);

    const names = Array.from(skills.keys()).sort();
    expect(names).toEqual([
      'brainstorm',
      'code-review',
      'commit',
      'commit-push-pr',
      'compound',
      'compound-refresh',
      'debug',
      'doc-review',
      'ideate',
      'lfg',
      'plan',
      'resolve-pr-feedback',
      'simplify-code',
      'strategy',
      'work',
    ]);
  });

  it('should load work skill with requires dependency', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const work = getSkill('work');
    expect(work).toBeDefined();
    expect(work!.description).toContain('Execute work efficiently');
    expect(work!.requires).toContain('commit');
  });

  it('should load brainstorm skill without dependencies', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const brainstorm = getSkill('brainstorm');
    expect(brainstorm).toBeDefined();
    expect(brainstorm!.description).toContain('Explore requirements');
    expect(brainstorm!.requires).toEqual([]);
  });

  it('should load commit-push-pr skill', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const commitPushPr = getSkill('commit-push-pr');
    expect(commitPushPr).toBeDefined();
    expect(commitPushPr!.description).toContain('Commit, push, and open a PR');
  });

  it('should list all skills via listSkills()', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const skills = listSkills();
    expect(skills).toHaveLength(15);
    expect(skills.every((s) => s.name && s.description)).toBe(true);
  });

  it('should discover skill resources from references/', () => {
    const homeDir = path.join(tmpDir, 'skills-home');
    const refDir = path.join(homeDir, 'my-skill', 'references');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill\n---\nBody',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(refDir, 'guide.md'),
      '---\ndescription: A helpful guide\n---\n# Guide\nContent here',
      'utf-8',
    );
    fs.writeFileSync(path.join(refDir, 'data.json'), '{"key":"value"}', 'utf-8');

    const skills = loadSkills({
      homeDir,
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const skill = skills.get('my-skill');
    expect(skill).toBeDefined();
    expect(skill!.resources).toHaveLength(2);

    const mdResource = skill!.resources.find((r) => r.path === 'references/guide.md');
    expect(mdResource).toBeDefined();
    expect(mdResource!.description).toBe('A helpful guide');

    const jsonResource = skill!.resources.find(
      (r) => r.path === 'references/data.json',
    );
    expect(jsonResource).toBeDefined();
    // JSON is parseable but has no frontmatter description
    expect(jsonResource!.description).toBe('');
  });

  it('should discover skill resources from scripts/', () => {
    const homeDir = path.join(tmpDir, 'skills-home');
    const scriptsDir = path.join(homeDir, 'my-skill', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill\n---\nBody',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(scriptsDir, 'run.sh'),
      '#!/bin/bash\necho hello',
      'utf-8',
    );

    const skills = loadSkills({
      homeDir,
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const skill = skills.get('my-skill');
    expect(skill).toBeDefined();
    expect(skill!.resources).toHaveLength(1);
    expect(skill!.resources[0].path).toBe('scripts/run.sh');
  });
});

// ===========================================================================
// Merge: Home overlaid by Project
// ===========================================================================

describe('Agent & Skill Merge', () => {
  it('should overlay project agents on home agents (project wins for non-internal)', () => {
    const homeDir = path.join(tmpDir, 'home-agents');
    const projectDir = path.join(tmpDir, 'project-agents');

    // Home has a subagent
    writeAgent(
      homeDir,
      'helper',
      'name: helper\ntype: subagent\ntier: bloom\ndescription: Home helper\nallowed_tools:\n  - \'*\'\nallowed_skills:\n  - \'*\'',
      'Home system prompt',
    );

    // Project overrides helper
    writeAgent(
      projectDir,
      'helper',
      'name: helper\ntype: subagent\ntier: crown\ndescription: Project helper\nallowed_tools:\n  - read\n  - grep\nallowed_skills:\n  - work',
      'Project system prompt',
    );

    // Project tries to shadow reserved internal general — must NOT win
    writeAgent(
      homeDir,
      'general',
      'name: general\ntype: internal\ntier: bloom\ndescription: Home general\nallowed_tools:\n  - \'*\'\nallowed_skills:\n  - \'*\'',
      'Home system prompt',
    );
    writeAgent(
      projectDir,
      'general',
      'name: general\ntype: subagent\ntier: crown\ndescription: Project general\nallowed_tools:\n  - read\nallowed_skills:\n  - work',
      'Project system prompt',
    );

    const agents = loadAgents({ homeDir, projectDir });

    const helper = agents.get('helper');
    expect(helper).toBeDefined();
    expect(helper!.tier).toBe(AgentTier.CROWN);
    expect(helper!.description).toBe('Project helper');
    expect(helper!.allowed_tools).toEqual(['read', 'grep']);

    const general = agents.get('general');
    expect(general).toBeDefined();
    // Reserved/internal home agent is not project-shadowed
    expect(general!.tier).toBe(AgentTier.BLOOM);
    expect(general!.description).toBe('Home general');
    expect(general!.type).toBe(AgentType.INTERNAL);
  });

  it('should keep home agents not overridden by project', () => {
    const homeDir = path.join(tmpDir, 'home-agents');
    const projectDir = path.join(tmpDir, 'project-agents');

    writeAgent(
      homeDir,
      'explorer',
      'name: explorer\ntype: subagent\ntier: seed\ndescription: Explorer\nallowed_tools:\n  - read\n  - glob',
      'Explorer prompt',
    );

    writeAgent(
      projectDir,
      'custom',
      'name: custom\ntype: subagent\ntier: bloom\ndescription: Custom agent\nallowed_tools:\n  - read',
      'Custom prompt',
    );

    const agents = loadAgents({ homeDir, projectDir });

    expect(agents.size).toBe(2);
    expect(agents.has('explorer')).toBe(true);
    expect(agents.has('custom')).toBe(true);
  });

  it('should overlay project skills on home skills', () => {
    const homeDir = path.join(tmpDir, 'home-skills');
    const projectDir = path.join(tmpDir, 'project-skills');

    writeSkill(
      homeDir,
      'work',
      'name: work\ndescription: Home work skill\nrequires:\n  - commit',
      'Home body',
    );

    writeSkill(
      projectDir,
      'work',
      'name: work\ndescription: Project work skill\nrequires:\n  - commit\n  - debug',
      'Project body',
    );

    const skills = loadSkills({ homeDir, projectDir });

    const work = skills.get('work');
    expect(work).toBeDefined();
    expect(work!.description).toBe('Project work skill');
    expect(work!.requires).toEqual(['commit', 'debug']);
  });
});

// ===========================================================================
// Seeding
// ===========================================================================

describe('Seeding', () => {
  it('should seed agents into empty directory', () => {
    const targetDir = path.join(tmpDir, 'agents-target');
    seedAgentsDir(targetDir);

    // Should have all 27 agent subdirectories
    const entries = fs.readdirSync(targetDir).filter((e) => {
      const stat = fs.statSync(path.join(targetDir, e));
      return stat.isDirectory();
    });
    expect(entries.length).toBe(28);

    // Each should have an AGENT.md
    for (const entry of entries) {
      const agentFile = path.join(targetDir, entry, 'AGENT.md');
      expect(fs.existsSync(agentFile)).toBe(true);
    }
  });

  it('should not overwrite existing agent files during seeding', () => {
    const targetDir = path.join(tmpDir, 'agents-target');
    const generalDir = path.join(targetDir, 'general');
    fs.mkdirSync(generalDir, { recursive: true });
    fs.writeFileSync(
      path.join(generalDir, 'AGENT.md'),
      '---\nname: general\ntype: internal\ntier: bloom\ndescription: Custom general\nallowed_tools:\n  - read\n---\nCustom body',
      'utf-8',
    );

    seedAgentsDir(targetDir);

    // Our custom file should not be overwritten
    const content = fs.readFileSync(
      path.join(generalDir, 'AGENT.md'),
      'utf-8',
    );
    expect(content).toContain('Custom general');
    expect(content).toContain('Custom body');
  });

  it('should seed skills into empty directory', () => {
    const targetDir = path.join(tmpDir, 'skills-target');
    seedSkillsDir(targetDir);

    const entries = fs.readdirSync(targetDir).filter((e) => {
      const stat = fs.statSync(path.join(targetDir, e));
      return stat.isDirectory();
    });
    expect(entries.length).toBe(15);

    for (const entry of entries) {
      const skillFile = path.join(targetDir, entry, 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);
    }
  });

  it('should seed skill resource subtrees (scripts/references/assets)', () => {
    const targetDir = path.join(tmpDir, 'skills-resources');
    seedSkillsDir(targetDir);

    // work ships with references/; compound ships with scripts/, references/, assets/
    expect(fs.existsSync(path.join(targetDir, 'work', 'references'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'compound', 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'compound', 'references'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'compound', 'assets'))).toBe(true);
    expect(
      fs.existsSync(path.join(targetDir, 'resolve-pr-feedback', 'scripts')),
    ).toBe(true);
  });

  it('should not overwrite existing skill files during seeding', () => {
    const targetDir = path.join(tmpDir, 'skills-target');
    const workDir = path.join(targetDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'SKILL.md'),
      '---\nname: work\ndescription: Custom work\n---\nCustom body',
      'utf-8',
    );

    seedSkillsDir(targetDir);

    const content = fs.readFileSync(path.join(workDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Custom work');
    expect(content).toContain('Custom body');
  });

  it('should fill missing skill resource subtrees without clobbering SKILL.md', () => {
    const targetDir = path.join(tmpDir, 'skills-fill');
    const workDir = path.join(targetDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(workDir, 'SKILL.md'),
      '---\nname: work\ndescription: Custom work\n---\nCustom body',
      'utf-8',
    );

    seedSkillsDir(targetDir);

    const content = fs.readFileSync(path.join(workDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Custom work');
    expect(fs.existsSync(path.join(workDir, 'references'))).toBe(true);
  });
});

// ===========================================================================
// Tier Resolution
// ===========================================================================

describe('Tier Resolution', () => {
  it('should have all four tiers represented in agent defaults', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const agents = listAgents();
    const tiers = new Set(agents.map((a) => a.tier));
    expect(tiers.has(AgentTier.SEED)).toBe(true);
    expect(tiers.has(AgentTier.SPROUT)).toBe(true);
    expect(tiers.has(AgentTier.BLOOM)).toBe(true);
    expect(tiers.has(AgentTier.CROWN)).toBe(true);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('Edge cases', () => {
  it('should handle non-existent directories gracefully', () => {
    const agents = loadAgents({
      homeDir: path.join(tmpDir, 'nonexistent-home'),
      projectDir: path.join(tmpDir, 'nonexistent-project'),
    });
    expect(agents.size).toBe(0);
  });

  it('should skip agent files with missing description', () => {
    const homeDir = path.join(tmpDir, 'home-agents');
    writeAgent(
      homeDir,
      'no-desc',
      'name: no-desc\ntype: subagent\ntier: bloom\nallowed_tools:\n  - read',
      'Body without description',
    );

    const agents = loadAgents({
      homeDir,
      projectDir: path.join(tmpDir, 'empty-project'),
    });
    expect(agents.size).toBe(0);
  });

  it('should skip agent files with invalid type', () => {
    const homeDir = path.join(tmpDir, 'home-agents');
    writeAgent(
      homeDir,
      'bad-type',
      'name: bad-type\ntype: invalid_type\ntier: bloom\ndescription: Bad type\nallowed_tools:\n  - read',
      'Body',
    );

    const agents = loadAgents({
      homeDir,
      projectDir: path.join(tmpDir, 'empty-project'),
    });
    expect(agents.size).toBe(0);
  });

  it('should skip skill files with missing description', () => {
    const homeDir = path.join(tmpDir, 'home-skills');
    writeSkill(
      homeDir,
      'no-desc',
      'name: no-desc',
      'Body without description',
    );

    const skills = loadSkills({
      homeDir,
      projectDir: path.join(tmpDir, 'empty-project'),
    });
    expect(skills.size).toBe(0);
  });

  it('should handle skill with no requires field', () => {
    const homeDir = path.join(tmpDir, 'home-skills');
    writeSkill(
      homeDir,
      'simple',
      'name: simple\ndescription: Simple skill',
      'Body',
    );

    const skills = loadSkills({
      homeDir,
      projectDir: path.join(tmpDir, 'empty-project'),
    });
    const simple = skills.get('simple');
    expect(simple).toBeDefined();
    expect(simple!.requires).toEqual([]);
    expect(simple!.resources).toEqual([]);
  });

  it('should freeze agent arrays', () => {
    loadAgents({
      homeDir: path.join(__dirname, '../../src/main/agents/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const general = getAgent('general')!;
    expect(() => {
      (general.allowed_tools as string[]).push('new_tool');
    }).toThrow();
  });

  it('should freeze skill arrays', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const work = getSkill('work')!;
    expect(() => {
      (work.requires as string[]).push('new_dep');
    }).toThrow();
  });
});
