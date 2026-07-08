/**
 * Tests for Skill & MCP Resource Tools — U18.
 *
 * Covers:
 * - Skill with dependencies → injected in dependency order
 * - Circular dependency → error
 * - Resource read: `work/references/api-errors.md` → content, frontmatter stripped
 * - Path traversal: `../../../etc/passwd` → error
 * - Agent-scoped: only listed skills matching agent's `allowed_skills`
 * - MCP resource: valid URI → text. Unknown URI → error. Server unavailable → error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Skill } from '../../src/shared/types/skill';
import {
  buildSkillTool,
  filterSkills,
  resolveSkillDependencies,
} from '../../src/main/tools/skill/skill';
import { buildMcpResourceTool } from '../../src/main/tools/mcp/resource';
import type { MCPManager } from '../../src/main/mcp/manager';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-skill-mcp-test-'));
}

/**
 * Create a skill directory with SKILL.md and optional resource files.
 * Returns the absolute path to the SKILL.md file.
 */
function createSkillDir(
  baseDir: string,
  skillName: string,
  frontmatter: string,
  body: string,
  resources?: { dir: string; files: Record<string, string> }[],
): string {
  const dir = path.join(baseDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  const skillFile = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skillFile, `---\n${frontmatter}\n---\n${body}`, 'utf-8');

  if (resources) {
    for (const r of resources) {
      const rDir = path.join(dir, r.dir);
      fs.mkdirSync(rDir, { recursive: true });
      for (const [name, content] of Object.entries(r.files)) {
        fs.writeFileSync(path.join(rDir, name), content, 'utf-8');
      }
    }
  }

  return skillFile;
}

/**
 * Create a Skill object for testing (without file system dependency).
 */
function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
  return {
    name: overrides.name,
    description: overrides.description ?? `Description for ${overrides.name}`,
    requires: overrides.requires ?? [],
    resources: overrides.resources ?? [],
    location: overrides.location,
    content: overrides.content ?? `# ${overrides.name}\nContent for ${overrides.name}`,
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Skill filtering
// ===========================================================================

describe('filterSkills', () => {
  it('should return all skills when allowed is ["*"]', () => {
    const registry = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work' })],
      ['commit', makeSkill({ name: 'commit' })],
      ['debug', makeSkill({ name: 'debug' })],
    ]);

    const filtered = filterSkills(['*'], registry);
    expect(filtered.size).toBe(3);
  });

  it('should return only matching skills by exact name', () => {
    const registry = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work' })],
      ['commit', makeSkill({ name: 'commit' })],
      ['debug', makeSkill({ name: 'debug' })],
    ]);

    const filtered = filterSkills(['work', 'commit'], registry);
    expect(filtered.size).toBe(2);
    expect(filtered.has('work')).toBe(true);
    expect(filtered.has('commit')).toBe(true);
    expect(filtered.has('debug')).toBe(false);
  });

  it('should support glob patterns', () => {
    const registry = new Map<string, Skill>([
      ['code-review', makeSkill({ name: 'code-review' })],
      ['doc-review', makeSkill({ name: 'doc-review' })],
      ['work', makeSkill({ name: 'work' })],
    ]);

    const filtered = filterSkills(['*-review'], registry);
    expect(filtered.size).toBe(2);
    expect(filtered.has('code-review')).toBe(true);
    expect(filtered.has('doc-review')).toBe(true);
    expect(filtered.has('work')).toBe(false);
  });

  it('should return empty map when allowed is empty', () => {
    const registry = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work' })],
    ]);

    const filtered = filterSkills([], registry);
    expect(filtered.size).toBe(0);
  });
});

// ===========================================================================
// Dependency resolution
// ===========================================================================

describe('resolveSkillDependencies', () => {
  it('should return skill with no dependencies', () => {
    const registry = new Map<string, Skill>([
      ['brainstorm', makeSkill({ name: 'brainstorm', requires: [] })],
    ]);

    const result = resolveSkillDependencies('brainstorm', registry, ['*']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('brainstorm');
  });

  it('should resolve single dependency in correct order (deepest first)', () => {
    // commit has no deps, work requires commit
    const registry = new Map<string, Skill>([
      ['commit', makeSkill({ name: 'commit', requires: [] })],
      ['work', makeSkill({ name: 'work', requires: ['commit'] })],
    ]);

    const result = resolveSkillDependencies('work', registry, ['*']);
    expect(result).toHaveLength(2);
    // Deepest dependency first
    expect(result[0].name).toBe('commit');
    expect(result[1].name).toBe('work');
  });

  it('should resolve chained dependencies (A → B → C)', () => {
    const registry = new Map<string, Skill>([
      ['base', makeSkill({ name: 'base', requires: [] })],
      ['middle', makeSkill({ name: 'middle', requires: ['base'] })],
      ['top', makeSkill({ name: 'top', requires: ['middle'] })],
    ]);

    const result = resolveSkillDependencies('top', registry, ['*']);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('base');
    expect(result[1].name).toBe('middle');
    expect(result[2].name).toBe('top');
  });

  it('should resolve diamond dependencies without duplication', () => {
    // diamond: top requires a and b, both require base
    const registry = new Map<string, Skill>([
      ['base', makeSkill({ name: 'base', requires: [] })],
      ['a', makeSkill({ name: 'a', requires: ['base'] })],
      ['b', makeSkill({ name: 'b', requires: ['base'] })],
      ['top', makeSkill({ name: 'top', requires: ['a', 'b'] })],
    ]);

    const result = resolveSkillDependencies('top', registry, ['*']);
    expect(result).toHaveLength(4);
    // base first, then a, then b, then top
    expect(result[0].name).toBe('base');
    expect(result[1].name).toBe('a');
    expect(result[2].name).toBe('b');
    expect(result[3].name).toBe('top');
    // base should appear only once
    const baseCount = result.filter((s) => s.name === 'base').length;
    expect(baseCount).toBe(1);
  });

  it('should detect direct circular dependency (A → B → A)', () => {
    const registry = new Map<string, Skill>([
      ['a', makeSkill({ name: 'a', requires: ['b'] })],
      ['b', makeSkill({ name: 'b', requires: ['a'] })],
    ]);

    expect(() => resolveSkillDependencies('a', registry, ['*'])).toThrow(
      "Circular dependency detected involving 'a'",
    );
  });

  it('should detect self-referencing circular dependency (A → A)', () => {
    const registry = new Map<string, Skill>([
      ['a', makeSkill({ name: 'a', requires: ['a'] })],
    ]);

    expect(() => resolveSkillDependencies('a', registry, ['*'])).toThrow(
      "Circular dependency detected involving 'a'",
    );
  });

  it('should throw for missing skill', () => {
    const registry = new Map<string, Skill>();

    expect(() => resolveSkillDependencies('nonexistent', registry, ['*'])).toThrow(
      "Skill 'nonexistent' not found",
    );
  });

  it('should throw for missing dependency', () => {
    const registry = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work', requires: ['nonexistent'] })],
    ]);

    expect(() => resolveSkillDependencies('work', registry, ['*'])).toThrow(
      "Skill 'work' requires 'nonexistent' which does not exist",
    );
  });

  it('should throw for dependency not in allowed list', () => {
    const registry = new Map<string, Skill>([
      ['commit', makeSkill({ name: 'commit', requires: [] })],
      ['work', makeSkill({ name: 'work', requires: ['commit'] })],
    ]);

    expect(() =>
      resolveSkillDependencies('work', registry, ['work']),
    ).toThrow(
      "Skill 'work' requires 'commit' which is not available for this agent",
    );
  });
});

// ===========================================================================
// Skill tool — buildSkillTool
// ===========================================================================

describe('buildSkillTool', () => {
  it('should build a tool definition with dynamic description', () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work', description: 'Execute work efficiently' })],
      ['commit', makeSkill({ name: 'commit', description: 'Create a git commit' })],
    ]);

    const { definition } = buildSkillTool(skills);

    expect(definition.name).toBe('skill');
    expect(definition.description).toContain('Load a specialized skill');
    expect(definition.actionLabel).toBe('Loading skill...');
    expect(definition.category).toBe('skill');
  });

  it('should include available skills in parameter description', () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work', description: 'Execute work efficiently' })],
      ['commit', makeSkill({ name: 'commit', description: 'Create a git commit' })],
    ]);

    const { definition } = buildSkillTool(skills);
    // The description on the name field should list the skills
    const nameField = (definition.inputSchema as any)._def.shape().name;
    const desc = nameField._def.description as string;
    expect(desc).toContain('work');
    expect(desc).toContain('commit');
  });

  it('should filter skills when allowedSkills is provided', () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work', description: 'Execute work' })],
      ['commit', makeSkill({ name: 'commit', description: 'Create a commit' })],
      ['debug', makeSkill({ name: 'debug', description: 'Debug something' })],
    ]);

    const { definition } = buildSkillTool(skills, ['work', 'commit']);
    const nameField = (definition.inputSchema as any)._def.shape().name;
    const desc = nameField._def.description as string;
    expect(desc).toContain('work');
    expect(desc).toContain('commit');
    // debug should not be in the description
    expect(desc).not.toContain('Debug something');
  });

  it('should load skill with dependencies in correct order via handler', async () => {
    const skills = new Map<string, Skill>([
      [
        'commit',
        makeSkill({
          name: 'commit',
          description: 'Create a commit',
          content: '# Commit\nCreate a git commit.',
        }),
      ],
      [
        'work',
        makeSkill({
          name: 'work',
          description: 'Execute work',
          requires: ['commit'],
          content: '# Work\nExecute work efficiently.',
        }),
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Skill 'work' loaded");

    // Content should contain both skills, commit first
    const commitIdx = result.content.indexOf('<skill_content name="commit">');
    const workIdx = result.content.indexOf('<skill_content name="work">');
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(workIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(workIdx);
  });

  it('should return error for circular dependency', async () => {
    const skills = new Map<string, Skill>([
      ['a', makeSkill({ name: 'a', requires: ['b'] })],
      ['b', makeSkill({ name: 'b', requires: ['a'] })],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'a' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Dependency error');
    expect(result.content).toContain('Circular dependency detected');
  });

  it('should return error for unknown skill', async () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work' })],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'nonexistent' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Unknown skill: nonexistent');
    expect(result.content).toContain("does not exist");
  });

  it('should return error for skill not in allowed list', async () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work' })],
      ['debug', makeSkill({ name: 'debug' })],
    ]);

    const { handler } = buildSkillTool(skills, ['work']);
    const result = (await handler({ name: 'debug' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Skill 'debug' not available");
    expect(result.content).toContain('not available for this agent');
  });

  it('should produce XML-escaped content', async () => {
    const skills = new Map<string, Skill>([
      [
        'test',
        makeSkill({
          name: 'test',
          content: 'Content with <special> & "quotes" and \'apostrophes\'',
        }),
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'test' })) as {
      display: string;
      content: string;
    };

    expect(result.content).toContain('&lt;special&gt;');
    expect(result.content).toContain('&amp;');
    expect(result.content).toContain('&quot;quotes&quot;');
  });

  it('should list skill resources in output', async () => {
    const skills = new Map<string, Skill>([
      [
        'work',
        makeSkill({
          name: 'work',
          content: '# Work',
          resources: [
            { path: 'references/api-errors.md', description: 'API error codes' },
            { path: 'scripts/run.sh', description: 'Run script' },
          ],
        }),
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work' })) as {
      display: string;
      content: string;
    };

    expect(result.content).toContain('<skill_resources>');
    expect(result.content).toContain('references/api-errors.md');
    expect(result.content).toContain('API error codes');
    expect(result.content).toContain('scripts/run.sh');
  });
});

// ===========================================================================
// Skill resource reads
// ===========================================================================

describe('Skill resource reads', () => {
  it('should read a resource file from skill references/', async () => {
    const skillDir = path.join(tmpDir, 'work');
    const refDir = path.join(skillDir, 'references');
    fs.mkdirSync(refDir, { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(
      skillFile,
      '---\nname: work\ndescription: Execute work\n---\n# Work\nBody here',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(refDir, 'api-errors.md'),
      '---\ndescription: API error codes\n---\n# API Errors\n400: Bad Request\n404: Not Found',
      'utf-8',
    );

    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Execute work',
          requires: [],
          resources: [{ path: 'references/api-errors.md', description: 'API error codes' }],
          location: skillFile,
          content: '# Work\nBody here',
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work/references/api-errors.md' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Resource 'references/api-errors.md' from 'work'");
    expect(result.content).toContain('<skill_resource skill="work" path="references/api-errors.md">');
    // Frontmatter should be stripped — only the body
    expect(result.content).toContain('# API Errors');
    expect(result.content).toContain('400: Bad Request');
    expect(result.content).not.toContain('description: API error codes');
  });

  it('should read a non-md resource without frontmatter stripping', async () => {
    const skillDir = path.join(tmpDir, 'work');
    const refDir = path.join(skillDir, 'references');
    fs.mkdirSync(refDir, { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: work\ndescription: Work\n---\nBody', 'utf-8');
    fs.writeFileSync(
      path.join(refDir, 'config.json'),
      '{"key": "value"}',
      'utf-8',
    );

    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Work',
          requires: [],
          resources: [],
          location: skillFile,
          content: 'Body',
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work/references/config.json' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Resource 'references/config.json' from 'work'");
    // Content is XML-escaped in the output
    expect(result.content).toContain('&quot;key&quot;');
    expect(result.content).toContain('&quot;value&quot;');
  });

  it('should reject path traversal with ../..', async () => {
    const skillDir = path.join(tmpDir, 'work');
    fs.mkdirSync(skillDir, { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: work\ndescription: Work\n---\nBody', 'utf-8');

    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Work',
          requires: [],
          resources: [],
          location: skillFile,
          content: 'Body',
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work/../../../etc/passwd' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Path traversal rejected');
    expect(result.content).toContain('outside the skill directory');
  });

  it('should reject resource not in allowed subdirectory', async () => {
    const skillDir = path.join(tmpDir, 'work');
    fs.mkdirSync(path.join(skillDir, 'private'), { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: work\ndescription: Work\n---\nBody', 'utf-8');
    fs.writeFileSync(path.join(skillDir, 'private', 'secret.txt'), 'secret', 'utf-8');

    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Work',
          requires: [],
          resources: [],
          location: skillFile,
          content: 'Body',
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work/private/secret.txt' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Resource not in allowed directory');
    expect(result.content).toContain('must be in scripts/, references/, or assets/');
  });

  it('should return error for nonexistent resource file', async () => {
    const skillDir = path.join(tmpDir, 'work');
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: work\ndescription: Work\n---\nBody', 'utf-8');

    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Work',
          requires: [],
          resources: [],
          location: skillFile,
          content: 'Body',
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work/references/nonexistent.md' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Resource not found');
    expect(result.content).toContain("not found in skill 'work'");
  });

  it('should return error for skill without location', async () => {
    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Work',
          requires: [],
          resources: [],
          // No location set
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);
    const result = (await handler({ name: 'work/references/file.md' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Skill location unknown');
    expect(result.content).toContain('no file location');
  });
});

// ===========================================================================
// Agent-scoped skill filtering
// ===========================================================================

describe('Agent-scoped skill filtering', () => {
  it('should only list skills matching allowedSkills in tool description', () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work', description: 'Execute work' })],
      ['commit', makeSkill({ name: 'commit', description: 'Create a commit' })],
      ['debug', makeSkill({ name: 'debug', description: 'Debug issues' })],
      ['brainstorm', makeSkill({ name: 'brainstorm', description: 'Brainstorm ideas' })],
    ]);

    const { definition } = buildSkillTool(skills, ['work', 'commit']);
    const nameField = (definition.inputSchema as any)._def.shape().name;
    const descStr = nameField._def.description as string;

    expect(descStr).toContain('work');
    expect(descStr).toContain('commit');
    // debug and brainstorm should not appear
    expect(descStr).not.toContain('Brainstorm ideas');
    expect(descStr).not.toContain('Debug issues');
  });

  it('should reject skill load for skill not in allowed list', async () => {
    const skills = new Map<string, Skill>([
      ['work', makeSkill({ name: 'work' })],
      ['debug', makeSkill({ name: 'debug' })],
    ]);

    const { handler } = buildSkillTool(skills, ['work']);
    const result = (await handler({ name: 'debug' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Skill 'debug' not available");
  });

  it('should reject resource read for skill not in allowed list', async () => {
    const skillDir = path.join(tmpDir, 'debug');
    const refDir = path.join(skillDir, 'references');
    fs.mkdirSync(refDir, { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: debug\ndescription: Debug\n---\nBody', 'utf-8');
    fs.writeFileSync(path.join(refDir, 'guide.md'), '# Guide', 'utf-8');

    const skills = new Map<string, Skill>([
      [
        'debug',
        {
          name: 'debug',
          description: 'Debug',
          requires: [],
          resources: [],
          location: skillFile,
          content: 'Body',
        },
      ],
    ]);

    // Only allow 'work' — debug is not allowed
    const { handler } = buildSkillTool(skills, ['work']);
    const result = (await handler({ name: 'debug/references/guide.md' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Skill 'debug' not available");
  });

  it('should allow resource read for skill in allowed list', async () => {
    const skillDir = path.join(tmpDir, 'work');
    const refDir = path.join(skillDir, 'references');
    fs.mkdirSync(refDir, { recursive: true });

    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, '---\nname: work\ndescription: Work\n---\nBody', 'utf-8');
    fs.writeFileSync(
      path.join(refDir, 'guide.md'),
      '---\ndescription: A guide\n---\n# Guide\nHello',
      'utf-8',
    );

    const skills = new Map<string, Skill>([
      [
        'work',
        {
          name: 'work',
          description: 'Work',
          requires: [],
          resources: [],
          location: skillFile,
          content: 'Body',
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills, ['work']);
    const result = (await handler({ name: 'work/references/guide.md' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("Resource 'references/guide.md' from 'work'");
    expect(result.content).toContain('# Guide');
    // Frontmatter stripped
    expect(result.content).not.toContain('description: A guide');
  });
});

// ===========================================================================
// MCP Resource Tool
// ===========================================================================

describe('MCP Resource Tool', () => {
  function createMockManager(overrides: {
    getResourceServer?: (uri: string) => string | undefined;
    readResource?: (serverName: string, uri: string) => Promise<string>;
  } = {}): MCPManager {
    return {
      getResourceServer: overrides.getResourceServer ?? (() => undefined),
      readResource:
        overrides.readResource ??
        (() => Promise.resolve('default-content')),
    } as unknown as MCPManager;
  }

  it('should build a tool definition with correct metadata', () => {
    const manager = createMockManager();
    const { definition } = buildMcpResourceTool(manager);

    expect(definition.name).toBe('read_mcp_resource');
    expect(definition.description).toContain('Read a resource from an MCP server');
    expect(definition.actionLabel).toBe('Reading MCP resource...');
    expect(definition.category).toBe('mcp');
  });

  it('should return text content for a valid URI', async () => {
    const manager = createMockManager({
      getResourceServer: (uri) => (uri === 'docs://api/reference' ? 'docs-server' : undefined),
      readResource: (serverName, uri) => {
        if (serverName === 'docs-server' && uri === 'docs://api/reference') {
          return Promise.resolve('# API Reference\n\nThis is the API reference.');
        }
        return Promise.reject(new Error('not found'));
      },
    });

    const { handler } = buildMcpResourceTool(manager);
    const result = (await handler({ uri: 'docs://api/reference' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe("MCP resource 'docs://api/reference'");
    expect(result.content).toBe('# API Reference\n\nThis is the API reference.');
  });

  it('should return error for unknown URI (no server owns it)', async () => {
    const manager = createMockManager({
      getResourceServer: () => undefined,
    });

    const { handler } = buildMcpResourceTool(manager);
    const result = (await handler({ uri: 'unknown://resource' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('Resource not found');
    expect(result.content).toContain("No MCP server found for URI 'unknown://resource'");
  });

  it('should return error when server is unavailable (readResource throws)', async () => {
    const manager = createMockManager({
      getResourceServer: (uri) => (uri === 'file:///data' ? 'broken-server' : undefined),
      readResource: () => Promise.reject(new Error("MCP server 'broken-server' is not connected.")),
    });

    const { handler } = buildMcpResourceTool(manager);
    const result = (await handler({ uri: 'file:///data' })) as {
      display: string;
      content: string;
    };

    expect(result.display).toBe('MCP read error');
    expect(result.content).toContain("Error reading MCP resource");
    expect(result.content).toContain("not connected");
  });

  it('should handle multi-part text content', async () => {
    const manager = createMockManager({
      getResourceServer: () => 'server',
      readResource: () => Promise.resolve('Part 1\nPart 2'),
    });

    const { handler } = buildMcpResourceTool(manager);
    const result = (await handler({ uri: 'multi://doc' })) as {
      display: string;
      content: string;
    };

    expect(result.content).toBe('Part 1\nPart 2');
  });
});

// ===========================================================================
// Integration: skill tool with real file system
// ===========================================================================

describe('Skill tool — integration with file system', () => {
  it('should load skill with dependencies and read resource (end-to-end)', async () => {
    // Create commit skill (no deps)
    const commitFile = createSkillDir(
      tmpDir,
      'commit',
      'name: commit\ndescription: Create a git commit',
      '# Commit\nAlways write clear commit messages.',
    );

    // Create work skill (depends on commit, has resources)
    const workFile = createSkillDir(
      tmpDir,
      'work',
      'name: work\ndescription: Execute work efficiently\nrequires:\n  - commit',
      '# Work\nExecute work efficiently while maintaining quality.',
      [
        {
          dir: 'references',
          files: {
            'api-errors.md':
              '---\ndescription: Common API errors\n---\n# API Errors\n400: Bad Request\n500: Server Error',
          },
        },
        {
          dir: 'scripts',
          files: {
            'run.sh': '#!/bin/bash\necho "running"',
          },
        },
      ],
    );

    // Build skills map with location and content (simulating what registry does)
    const commitContent = fs.readFileSync(commitFile, 'utf-8');
    const workContent = fs.readFileSync(workFile, 'utf-8');
    const { body: commitBody } = parseFrontmatterLocal(commitContent);
    const { body: workBody } = parseFrontmatterLocal(workContent);

    const skills = new Map<string, Skill>([
      [
        'commit',
        {
          name: 'commit',
          description: 'Create a git commit',
          requires: [],
          resources: [],
          location: commitFile,
          content: commitBody,
        },
      ],
      [
        'work',
        {
          name: 'work',
          description: 'Execute work efficiently',
          requires: ['commit'],
          resources: [
            { path: 'references/api-errors.md', description: 'Common API errors' },
            { path: 'scripts/run.sh', description: '' },
          ],
          location: workFile,
          content: workBody,
        },
      ],
    ]);

    const { handler } = buildSkillTool(skills);

    // 1. Load work skill — should inject commit first, then work
    const loadResult = (await handler({ name: 'work' })) as {
      display: string;
      content: string;
    };

    expect(loadResult.display).toBe("Skill 'work' loaded");

    // Commit should be injected before work
    const commitIdx = loadResult.content.indexOf('<skill_content name="commit">');
    const workIdx = loadResult.content.indexOf('<skill_content name="work">');
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(workIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(workIdx);

    // Commit content
    expect(loadResult.content).toContain('Always write clear commit messages.');
    // Work content
    expect(loadResult.content).toContain('Execute work efficiently while maintaining quality.');
    // Resources listed
    expect(loadResult.content).toContain('references/api-errors.md');
    expect(loadResult.content).toContain('scripts/run.sh');

    // 2. Read a resource file
    const readResult = (await handler({ name: 'work/references/api-errors.md' })) as {
      display: string;
      content: string;
    };

    expect(readResult.display).toBe("Resource 'references/api-errors.md' from 'work'");
    // Frontmatter should be stripped
    expect(readResult.content).toContain('# API Errors');
    expect(readResult.content).toContain('400: Bad Request');
    expect(readResult.content).toContain('500: Server Error');
    expect(readResult.content).not.toContain('description: Common API errors');
    // XML wrapper
    expect(readResult.content).toContain('<skill_resource skill="work" path="references/api-errors.md">');
  });
});

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Local frontmatter parser for test setup (reuses the same logic as the app).
 */
function parseFrontmatterLocal(content: string): { metadata: Record<string, unknown>; body: string } {
  const trimmed = content.trim();
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(trimmed);
  if (!match) return { metadata: {}, body: content };
  return { metadata: {}, body: match[2] };
}
