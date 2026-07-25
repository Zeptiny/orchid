/**
 * Definitions CRUD — skills, agents, personalities on disk.
 * Covers review-hardened policy: rename, internal agents, conflicts, path safety.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseFrontmatter,
  serializeFrontmatter,
} from '../../src/shared/utils/frontmatter';
import {
  deleteAgent,
  deletePersonality,
  deleteSkill,
  listManagedAgents,
  listManagedPersonalities,
  listManagedSkills,
  saveAgent,
  savePersonality,
  saveSkill,
} from '../../src/main/defs/manage';
import { AgentTier, AgentType } from '../../src/shared/types/agent';
import {
  assertPathUnderOrchidRoots,
  removeDefinitionDir,
  validateDefinitionName,
} from '../../src/main/defs/paths';

// Mock home paths to a temp dir so we don't touch ~/.orchid
vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  const home = path.join(os.tmpdir(), `orchid-defs-home-${process.pid}`);
  return {
    ...actual,
    HOME_CONFIG_DIR: home,
    HOME_SKILLS_DIR: path.join(home, 'skills'),
    HOME_AGENTS_DIR: path.join(home, 'agents'),
    HOME_PERSONALITIES_DIR: path.join(home, 'personalities'),
    HOME_CONFIG_PATH: path.join(home, 'config.json'),
  };
});

import {
  HOME_AGENTS_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_SKILLS_DIR,
} from '../../src/main/config/loader';

let projectDir: string;

function writeInternalAgent(baseDir: string, name: string): void {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ntype: internal\ntier: bloom\ndescription: Internal ${name}\nallowed_tools:\n  - read\n---\nSystem prompt.\n`,
    'utf-8',
  );
}

beforeEach(() => {
  for (const dir of [HOME_SKILLS_DIR, HOME_AGENTS_DIR, HOME_PERSONALITIES_DIR]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-defs-proj-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  for (const dir of [HOME_SKILLS_DIR, HOME_AGENTS_DIR, HOME_PERSONALITIES_DIR]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('serializeFrontmatter', () => {
  it('round-trips simple skill frontmatter', () => {
    const md = serializeFrontmatter(
      { name: 'demo', description: 'A demo skill', requires: ['commit'] },
      'Body text',
    );
    const { metadata, body } = parseFrontmatter(md);
    expect(metadata.name).toBe('demo');
    expect(metadata.description).toBe('A demo skill');
    expect(metadata.requires).toEqual(['commit']);
    expect(body.trim()).toBe('Body text');
  });
});

describe('validateDefinitionName', () => {
  it('accepts valid names', () => {
    expect(validateDefinitionName('my-skill')).toBe('my-skill');
  });

  it('rejects invalid names', () => {
    expect(() => validateDefinitionName('../etc')).toThrow();
    expect(() => validateDefinitionName('1bad')).toThrow();
  });
});

describe('skills CRUD', () => {
  it('saves and lists a global skill', () => {
    const saved = saveSkill(
      {
        scope: 'global',
        name: 'demo',
        description: 'Demo skill',
        requires: ['commit'],
        content: 'Do the thing',
      },
      null,
    );
    expect(saved.path).toContain(`${path.sep}demo${path.sep}SKILL.md`);
    expect(fs.existsSync(path.join(HOME_SKILLS_DIR, 'demo', 'SKILL.md'))).toBe(true);
    const listed = listManagedSkills(null);
    expect(listed).toHaveLength(1);
    expect(listed[0].requires).toEqual(['commit']);
  });

  it('project skill overlays global listing', () => {
    saveSkill(
      { scope: 'global', name: 'shared', description: 'Global version', content: 'g' },
      projectDir,
    );
    saveSkill(
      { scope: 'project', name: 'shared', description: 'Project version', content: 'p' },
      projectDir,
    );
    const listed = listManagedSkills(projectDir);
    expect(listed).toHaveLength(2);
    expect(listed.find((s) => s.scope === 'global')!.overriddenByProject).toBe(true);
  });

  it('rename preserves resource files', () => {
    saveSkill(
      { scope: 'global', name: 'old-skill', description: 'Old', content: 'body' },
      null,
    );
    const refDir = path.join(HOME_SKILLS_DIR, 'old-skill', 'references');
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'note.md'), 'keep me', 'utf-8');

    saveSkill(
      {
        scope: 'global',
        name: 'new-skill',
        description: 'New',
        content: 'body2',
        previousName: 'old-skill',
      },
      null,
    );

    expect(fs.existsSync(path.join(HOME_SKILLS_DIR, 'old-skill'))).toBe(false);
    expect(
      fs.existsSync(path.join(HOME_SKILLS_DIR, 'new-skill', 'references', 'note.md')),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(HOME_SKILLS_DIR, 'new-skill', 'SKILL.md'), 'utf-8'),
    ).toContain('body2');
  });

  it('rename onto existing name throws', () => {
    saveSkill(
      { scope: 'global', name: 'a', description: 'A', content: 'a' },
      null,
    );
    saveSkill(
      { scope: 'global', name: 'b', description: 'B', content: 'b' },
      null,
    );
    expect(() =>
      saveSkill(
        {
          scope: 'global',
          name: 'b',
          description: 'A2',
          content: 'a2',
          previousName: 'a',
        },
        null,
      ),
    ).toThrow(/already exists/i);
    // Both still present
    expect(listManagedSkills(null).map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('deletes a skill directory from disk', () => {
    saveSkill(
      { scope: 'global', name: 'temp', description: 'Temp', content: 'x' },
      null,
    );
    deleteSkill('global', 'temp', null);
    expect(fs.existsSync(path.join(HOME_SKILLS_DIR, 'temp'))).toBe(false);
    expect(listManagedSkills(null)).toHaveLength(0);
  });

  it('rejects project scope without project dir', () => {
    expect(() =>
      saveSkill(
        { scope: 'project', name: 'x', description: 'x', content: 'x' },
        null,
      ),
    ).toThrow(/workspace/i);
  });

  it('rejects path-traversal names', () => {
    expect(() =>
      saveSkill(
        { scope: 'global', name: '../x', description: 'x', content: 'x' },
        null,
      ),
    ).toThrow(/Invalid name/);
  });
});

describe('agents CRUD + internal policy', () => {
  it('saves and lists a subagent', () => {
    const saved = saveAgent(
      {
        scope: 'global',
        name: 'helper',
        type: AgentType.SUBAGENT,
        tier: AgentTier.SEED,
        description: 'A helper',
        system_prompt: 'Be helpful.',
        allowed_tools: ['read', 'grep'],
        allowed_skills: [],
      },
      null,
    );
    expect(saved.type).toBe(AgentType.SUBAGENT);
    expect(saved.allowed_skills).toEqual(['*']);
    expect(saved.system_prompt).toBe('Be helpful.');
    expect(fs.existsSync(path.join(HOME_AGENTS_DIR, 'helper', 'AGENT.md'))).toBe(true);
  });

  it('forces subagent when client asks for type internal on create', () => {
    const saved = saveAgent(
      {
        scope: 'global',
        name: 'planted',
        type: AgentType.INTERNAL,
        tier: AgentTier.BLOOM,
        description: 'Nope',
        system_prompt: 'x',
        allowed_tools: ['read'],
        allowed_skills: ['*'],
      },
      null,
    );
    expect(saved.type).toBe(AgentType.SUBAGENT);
    const onDisk = fs.readFileSync(
      path.join(HOME_AGENTS_DIR, 'planted', 'AGENT.md'),
      'utf-8',
    );
    expect(onDisk).toContain('type: subagent');
    expect(onDisk).not.toContain('type: internal');
  });

  it('rejects create-as-internal via forged previousName', () => {
    expect(() =>
      saveAgent(
        {
          scope: 'global',
          name: 'planted',
          previousName: 'does-not-exist',
          type: AgentType.INTERNAL,
          tier: AgentTier.BLOOM,
          description: 'Nope',
          system_prompt: 'x',
          allowed_tools: ['read'],
          allowed_skills: ['*'],
        },
        null,
      ),
    ).toThrow();
    expect(fs.existsSync(path.join(HOME_AGENTS_DIR, 'planted'))).toBe(false);
  });

  it('preserves internal type on in-place edit even if client sends subagent', () => {
    writeInternalAgent(HOME_AGENTS_DIR, 'general');
    const saved = saveAgent(
      {
        scope: 'global',
        name: 'general',
        previousName: 'general',
        type: AgentType.SUBAGENT, // malicious client
        tier: AgentTier.CROWN,
        description: 'Updated general',
        system_prompt: 'New prompt',
        allowed_tools: ['read', 'write'],
        allowed_skills: ['*'],
      },
      null,
    );
    expect(saved.type).toBe(AgentType.INTERNAL);
    const onDisk = fs.readFileSync(
      path.join(HOME_AGENTS_DIR, 'general', 'AGENT.md'),
      'utf-8',
    );
    expect(onDisk).toContain('type: internal');
    expect(onDisk).toContain('New prompt');
  });

  it('blocks overwrite of internal without previousName demotion-then-delete', () => {
    writeInternalAgent(HOME_AGENTS_DIR, 'general');
    // Save without previousName onto existing internal → stays internal
    const saved = saveAgent(
      {
        scope: 'global',
        name: 'general',
        type: AgentType.SUBAGENT,
        tier: AgentTier.BLOOM,
        description: 'Hacked',
        system_prompt: 'evil',
        allowed_tools: ['*'],
        allowed_skills: ['*'],
      },
      null,
    );
    expect(saved.type).toBe(AgentType.INTERNAL);
    expect(() => deleteAgent('global', 'general', null)).toThrow(/internal|reserved/i);
    expect(fs.existsSync(path.join(HOME_AGENTS_DIR, 'general', 'AGENT.md'))).toBe(true);
  });

  it('blocks rename of internal agent', () => {
    writeInternalAgent(HOME_AGENTS_DIR, 'general');
    expect(() =>
      saveAgent(
        {
          scope: 'global',
          name: 'general-v2',
          previousName: 'general',
          type: AgentType.INTERNAL,
          tier: AgentTier.BLOOM,
          description: 'x',
          system_prompt: 'x',
          allowed_tools: ['read'],
          allowed_skills: ['*'],
        },
        null,
      ),
    ).toThrow(/cannot be renamed/i);
  });

  it('blocks delete of internal agent', () => {
    writeInternalAgent(HOME_AGENTS_DIR, 'general');
    expect(() => deleteAgent('global', 'general', null)).toThrow(/internal|reserved/i);
    expect(fs.existsSync(path.join(HOME_AGENTS_DIR, 'general', 'AGENT.md'))).toBe(true);
  });

  it('blocks project-scope reserved agent names', () => {
    expect(() =>
      saveAgent(
        {
          scope: 'project',
          name: 'general',
          type: AgentType.SUBAGENT,
          tier: AgentTier.BLOOM,
          description: 'shadow',
          system_prompt: 'x',
          allowed_tools: ['read'],
          allowed_skills: ['*'],
        },
        projectDir,
      ),
    ).toThrow(/reserved/i);
  });

  it('deletes a subagent', () => {
    saveAgent(
      {
        scope: 'global',
        name: 'gone',
        type: AgentType.SUBAGENT,
        tier: AgentTier.BLOOM,
        description: 'Gone',
        system_prompt: '',
        allowed_tools: ['read'],
        allowed_skills: [],
      },
      null,
    );
    deleteAgent('global', 'gone', null);
    expect(fs.existsSync(path.join(HOME_AGENTS_DIR, 'gone'))).toBe(false);
  });

  it('rename agent refuses target collision', () => {
    saveAgent(
      {
        scope: 'global',
        name: 'a',
        type: AgentType.SUBAGENT,
        tier: AgentTier.BLOOM,
        description: 'A',
        system_prompt: '',
        allowed_tools: ['read'],
        allowed_skills: ['*'],
      },
      null,
    );
    saveAgent(
      {
        scope: 'global',
        name: 'b',
        type: AgentType.SUBAGENT,
        tier: AgentTier.BLOOM,
        description: 'B',
        system_prompt: '',
        allowed_tools: ['read'],
        allowed_skills: ['*'],
      },
      null,
    );
    expect(() =>
      saveAgent(
        {
          scope: 'global',
          name: 'b',
          previousName: 'a',
          type: AgentType.SUBAGENT,
          tier: AgentTier.BLOOM,
          description: 'A2',
          system_prompt: '',
          allowed_tools: ['read'],
          allowed_skills: ['*'],
        },
        null,
      ),
    ).toThrow(/already exists/i);
  });
});

describe('personalities CRUD', () => {
  it('saves and renames personalities', () => {
    savePersonality(
      { scope: 'global', name: 'zen', content: 'Be calm.' },
      projectDir,
    );
    savePersonality(
      {
        scope: 'global',
        name: 'zen-v2',
        content: 'Be calmer.',
        previousName: 'zen',
      },
      projectDir,
    );
    expect(fs.existsSync(path.join(HOME_PERSONALITIES_DIR, 'zen.md'))).toBe(false);
    expect(
      fs.readFileSync(path.join(HOME_PERSONALITIES_DIR, 'zen-v2.md'), 'utf-8'),
    ).toContain('Be calmer.');
  });

  it('delete personality removes file', () => {
    savePersonality({ scope: 'global', name: 'temp', content: 'x' }, null);
    deletePersonality('global', 'temp', null);
    expect(fs.existsSync(path.join(HOME_PERSONALITIES_DIR, 'temp.md'))).toBe(false);
  });
});

describe('path safety', () => {
  it('assertPathUnderOrchidRoots rejects outside paths', () => {
    expect(() =>
      assertPathUnderOrchidRoots('/tmp/not-orchid-at-all', null),
    ).toThrow(/outside/i);
  });

  it('assertPathUnderOrchidRoots accepts a real skill file', () => {
    saveSkill(
      { scope: 'global', name: 's', description: 'S', content: 'c' },
      null,
    );
    const p = path.join(HOME_SKILLS_DIR, 's', 'SKILL.md');
    expect(assertPathUnderOrchidRoots(p, null)).toBeTruthy();
  });

  it('removeDefinitionDir refuses scope root', () => {
    expect(() => removeDefinitionDir(HOME_SKILLS_DIR, HOME_SKILLS_DIR)).toThrow(
      /scope root/i,
    );
  });
});
