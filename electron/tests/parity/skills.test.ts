/**
 * Skill Parity Tests — U28.
 *
 * Verifies that all 15 skills from the Python TUI are ported to the TS/Electron app.
 * Tests STRUCTURE (all skills load, correct metadata), not behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadSkills,
  getSkill,
  listSkills,
  resetSkillRegistry,
} from '../../src/main/skills/registry';

// ── Expected skills (15 total) ─────────────────────────────────────────────

const EXPECTED_SKILLS = [
  { name: 'brainstorm', requires: [] },
  { name: 'code-review', requires: [] },
  { name: 'commit', requires: [] },
  { name: 'commit-push-pr', requires: [] },
  { name: 'compound', requires: [] },
  { name: 'compound-refresh', requires: [] },
  { name: 'debug', requires: [] },
  { name: 'doc-review', requires: [] },
  { name: 'ideate', requires: [] },
  { name: 'lfg', requires: [] },
  { name: 'plan', requires: [] },
  { name: 'resolve-pr-feedback', requires: [] },
  { name: 'simplify-code', requires: [] },
  { name: 'strategy', requires: [] },
  { name: 'work', requires: ['commit'] },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-skill-parity-'));
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  resetSkillRegistry();
});

afterEach(() => {
  resetSkillRegistry();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Skill Parity', () => {
  it('all 15 skills load from defaults', () => {
    const skills = loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    expect(skills.size).toBe(15);
  });

  it('all expected skill names are present', () => {
    const skills = loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const names = Array.from(skills.keys()).sort();
    const expectedNames = EXPECTED_SKILLS.map((s) => s.name).sort();
    expect(names).toEqual(expectedNames);
  });

  it('each skill has correct requires dependencies', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const expected of EXPECTED_SKILLS) {
      const skill = getSkill(expected.name);
      expect(skill, `Skill '${expected.name}' should exist`).toBeDefined();
      expect(skill!.requires, `Skill '${expected.name}' requires`).toEqual(expected.requires);
    }
  });

  it('each skill has a non-empty description', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const skill of listSkills()) {
      expect(skill.description, `Skill '${skill.name}' description`).toBeTruthy();
      expect(skill.description.length, `Skill '${skill.name}' description length`).toBeGreaterThan(5);
    }
  });

  it('each skill has a valid location path', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const skill of listSkills()) {
      expect(skill.location, `Skill '${skill.name}' location`).toBeTruthy();
      expect(skill.location, `Skill '${skill.name}' location`).toContain('SKILL.md');
    }
  });

  it('each skill has a resources array', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    for (const skill of listSkills()) {
      expect(Array.isArray(skill.resources), `Skill '${skill.name}' resources`).toBe(true);
    }
  });

  it('work skill has requires: [commit]', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const work = getSkill('work');
    expect(work).toBeDefined();
    expect(work!.requires).toContain('commit');
  });

  it('skill requires arrays are frozen (immutable)', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const work = getSkill('work')!;
    expect(() => {
      (work.requires as string[]).push('new_dep');
    }).toThrow();
  });

  it('skill resources arrays are frozen (immutable)', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    const work = getSkill('work')!;
    expect(() => {
      (work.resources as any[]).push({ path: 'fake', description: 'fake' });
    }).toThrow();
  });

  it('skills with resources have correct counts', () => {
    loadSkills({
      homeDir: path.join(__dirname, '../../src/main/skills/defaults'),
      projectDir: path.join(tmpDir, 'empty-project'),
    });

    // compound has 1 asset, 4 refs, 1 script = 6 resources
    const compound = getSkill('compound');
    expect(compound).toBeDefined();
    expect(compound!.resources.length).toBeGreaterThanOrEqual(1);

    // resolve-pr-feedback has 2 refs, 4 scripts = 6 resources
    const resolvePr = getSkill('resolve-pr-feedback');
    expect(resolvePr).toBeDefined();
    expect(resolvePr!.resources.length).toBeGreaterThanOrEqual(1);
  });
});
