/**
 * Shared prompts — registry read/seed, runtime overlay, injection helpers,
 * and defs CRUD for the fixed prompt slots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({ homeDir: '' }));

// Mock home paths to a temp dir so we don't touch ~/.orchid
vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  const home = path.join(os.tmpdir(), `orchid-prompts-home-${process.pid}`);
  mocks.homeDir = home;
  return {
    ...actual,
    HOME_CONFIG_DIR: home,
    HOME_SKILLS_DIR: path.join(home, 'skills'),
    HOME_AGENTS_DIR: path.join(home, 'agents'),
    HOME_PERSONALITIES_DIR: path.join(home, 'personalities'),
    HOME_PROMPTS_DIR: path.join(home, 'prompts'),
    HOME_CONFIG_PATH: path.join(home, 'config.json'),
  };
});

import {
  readSharedPrompts,
  seedSharedPromptsDir,
} from '../../src/main/prompts/registry';
import {
  appendSharedRules,
  appendSubagentRules,
} from '../../src/main/project/shared-prompts';
import { appendProjectPersonality } from '../../src/main/project/personality';
import {
  deleteSharedPrompt,
  listManagedSharedPrompts,
  saveSharedPrompt,
} from '../../src/main/defs/manage';
import { HOME_PROMPTS_DIR } from '../../src/main/config/loader';
import type { ProjectRuntime } from '../../src/main/project/runtime';

let projectDir: string;

function makeRuntime(
  sharedPrompts: Partial<Record<'all-agents' | 'subagents', string | null>>,
): ProjectRuntime {
  return {
    projectDir,
    config: {} as ProjectRuntime['config'],
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
    sharedPrompts: {
      'all-agents': sharedPrompts['all-agents'] ?? null,
      subagents: sharedPrompts.subagents ?? null,
    },
  };
}

beforeEach(() => {
  fs.rmSync(HOME_PROMPTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME_PROMPTS_DIR, { recursive: true });
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-prompts-proj-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(HOME_PROMPTS_DIR, { recursive: true, force: true });
});

function writeHomeSlot(slot: string, content: string): void {
  fs.writeFileSync(path.join(HOME_PROMPTS_DIR, `${slot}.md`), content, 'utf-8');
}

function writeProjectSlot(slot: string, content: string): void {
  const dir = path.join(projectDir, '.orchid', 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slot}.md`), content, 'utf-8');
}

describe('readSharedPrompts', () => {
  it('returns null for both slots when nothing exists', () => {
    expect(readSharedPrompts()).toEqual({ 'all-agents': null, subagents: null });
  });

  it('reads home slots', () => {
    writeHomeSlot('all-agents', 'Be terse.');
    expect(readSharedPrompts()).toEqual({
      'all-agents': 'Be terse.',
      subagents: null,
    });
  });

  it('treats an empty home file as absent', () => {
    writeHomeSlot('all-agents', '   \n');
    expect(readSharedPrompts()['all-agents']).toBeNull();
  });

  it('replaces the home slot with a non-empty project file', () => {
    writeHomeSlot('all-agents', 'Home rules');
    writeHomeSlot('subagents', 'Home subagent rules');
    writeProjectSlot('all-agents', 'Project rules');

    const result = readSharedPrompts({ projectDir });
    expect(result['all-agents']).toBe('Project rules');
    expect(result.subagents).toBe('Home subagent rules');
  });

  it('falls back to home when the project file is empty', () => {
    writeHomeSlot('all-agents', 'Home rules');
    writeProjectSlot('all-agents', '');

    const result = readSharedPrompts({ projectDir });
    expect(result['all-agents']).toBe('Home rules');
  });

  it('skips the home load entirely with homeDir: null', () => {
    writeHomeSlot('all-agents', 'Home rules');
    writeProjectSlot('subagents', 'Project subagent rules');

    const result = readSharedPrompts({ homeDir: null, projectDir });
    expect(result['all-agents']).toBeNull();
    expect(result.subagents).toBe('Project subagent rules');
  });
});

describe('seedSharedPromptsDir', () => {
  it('seeds a default subagents prompt once and never overwrites edits', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-prompts-seed-'));
    try {
      seedSharedPromptsDir(target);
      const seeded = path.join(target, 'subagents.md');
      expect(fs.existsSync(seeded)).toBe(true);
      expect(fs.readFileSync(seeded, 'utf-8')).toContain('subagent');

      fs.writeFileSync(seeded, 'Custom rules', 'utf-8');
      seedSharedPromptsDir(target);
      expect(fs.readFileSync(seeded, 'utf-8')).toBe('Custom rules');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('append helpers', () => {
  it('appendSharedRules appends under a Shared rules heading', () => {
    const out = appendSharedRules('Base prompt.', makeRuntime({ 'all-agents': 'Rule A' }));
    expect(out).toBe('Base prompt.\n\n## Shared rules\n\nRule A\n');
  });

  it('appendSubagentRules appends under a Subagent rules heading', () => {
    const out = appendSubagentRules('Base prompt.', makeRuntime({ subagents: 'Rule S' }));
    expect(out).toBe('Base prompt.\n\n## Subagent rules\n\nRule S\n');
  });

  it('both return the prompt unchanged when the slot is null', () => {
    const runtime = makeRuntime({});
    expect(appendSharedRules('Base.', runtime)).toBe('Base.');
    expect(appendSubagentRules('Base.', runtime)).toBe('Base.');
  });

  it('subagent composition reads shared → subagent → root order', () => {
    const runtime = makeRuntime({ 'all-agents': 'Shared', subagents: 'Sub' });
    const out = appendSubagentRules(appendSharedRules('Base.', runtime), runtime);
    expect(out.indexOf('## Shared rules')).toBeLessThan(out.indexOf('## Subagent rules'));
    expect(out.startsWith('Base.')).toBe(true);
  });

  it('main composition reads base → shared → personality order', () => {
    const runtime: ProjectRuntime = {
      ...makeRuntime({ 'all-agents': 'Shared' }),
      personalities: new Map([['p', 'Persona text']]),
      config: { personality: 'p' } as ProjectRuntime['config'],
    };
    const withShared = appendSharedRules('Base.', runtime);
    const withPersonality = appendProjectPersonality(withShared, runtime);
    expect(withPersonality.startsWith('Base.')).toBe(true);
    expect(withPersonality.indexOf('## Shared rules')).toBeLessThan(
      withPersonality.indexOf('## Personality'),
    );
    expect(withPersonality).toContain('Persona text');
  });
});

describe('shared prompt CRUD', () => {
  it('saves and lists a global slot', () => {
    const saved = saveSharedPrompt(
      { scope: 'global', slot: 'all-agents', content: 'Global rules' },
      null,
    );
    expect(saved.path).toBe(path.join(HOME_PROMPTS_DIR, 'all-agents.md'));

    const listed = listManagedSharedPrompts(null);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      slot: 'all-agents',
      content: 'Global rules',
      scope: 'global',
      overriddenByProject: false,
    });
  });

  it('saving empty content deletes the slot file (disables it) and leaves no residue', () => {
    saveSharedPrompt({ scope: 'global', slot: 'all-agents', content: 'Rules' }, null);
    saveSharedPrompt({ scope: 'global', slot: 'all-agents', content: '  ' }, null);
    expect(fs.existsSync(path.join(HOME_PROMPTS_DIR, 'all-agents.md'))).toBe(false);
    expect(listManagedSharedPrompts(null)).toHaveLength(0);
    expect(readSharedPrompts()['all-agents']).toBeNull();
  });

  it('marks the global entry overridden by a project override', () => {
    saveSharedPrompt({ scope: 'global', slot: 'subagents', content: 'Home' }, null);
    saveSharedPrompt(
      { scope: 'project', slot: 'subagents', content: 'Project' },
      projectDir,
    );

    const listed = listManagedSharedPrompts(projectDir);
    expect(listed).toHaveLength(2);
    const globalEntry = listed.find((p) => p.scope === 'global');
    const projectEntry = listed.find((p) => p.scope === 'project');
    expect(globalEntry?.overriddenByProject).toBe(true);
    expect(projectEntry?.overriddenByProject).toBe(false);
    expect(projectEntry?.path).toContain(path.join('.orchid', 'prompts'));
  });

  it('delete removes the slot file in the given scope', () => {
    saveSharedPrompt({ scope: 'project', slot: 'subagents', content: 'X' }, projectDir);
    deleteSharedPrompt('project', 'subagents', projectDir);
    expect(fs.existsSync(path.join(projectDir, '.orchid', 'prompts', 'subagents.md'))).toBe(false);
    expect(() => deleteSharedPrompt('project', 'subagents', projectDir)).toThrow(/not found/);
  });

  it('rejects unknown slot names', () => {
    expect(() =>
      saveSharedPrompt({ scope: 'global', slot: 'bogus' as 'all-agents', content: 'x' }, null),
    ).toThrow(/Invalid shared prompt slot/);
    expect(() => deleteSharedPrompt('global', 'bogus', null)).toThrow(/Invalid shared prompt slot/);
  });
});

describe('project runtime overlay', () => {
  it('includes resolved shared prompts in the runtime snapshot', async () => {
    const { ProjectRuntimeRegistry } = await import('../../src/main/project/runtime');
    writeHomeSlot('all-agents', 'Home rules');
    writeProjectSlot('all-agents', 'Project rules');

    const registry = new ProjectRuntimeRegistry({ homePromptsDir: HOME_PROMPTS_DIR });
    const runtime = registry.get(projectDir);
    expect(runtime.sharedPrompts['all-agents']).toBe('Project rules');
    expect(runtime.sharedPrompts.subagents).toBeNull();
    registry.invalidate(projectDir);
  });
});
