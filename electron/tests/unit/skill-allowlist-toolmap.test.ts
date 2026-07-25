/**
 * Per-agent skill allowlist at buildToolMap time (P0-3).
 */
import { describe, it, expect } from 'vitest';
import { buildToolMap } from '../../src/main/llm/orchestrator';
import { ToolRegistry } from '../../src/main/tools/registry';
import { buildSkillTool } from '../../src/main/tools/skill/skill';
import type { Skill } from '../../src/shared/types/skill';

function makeSkill(name: string): Skill {
  return {
    name,
    description: `Desc for ${name}`,
    requires: [],
    resources: [],
    content: `# ${name}`,
  };
}

describe('buildToolMap skill allowlist', () => {
  it('filters skill tool description and invoke by allowed_skills', async () => {
    const skills = new Map<string, Skill>([
      ['commit', makeSkill('commit')],
      ['work', makeSkill('work')],
      ['plan', makeSkill('plan')],
    ]);

    // Register unfiltered skill tool (as production does at boot).
    const registry = new ToolRegistry();
    const unfiltered = buildSkillTool(skills);
    registry.register(unfiltered.definition, unfiltered.handler);

    const tools = buildToolMap(
      ['skill'],
      registry,
      null,
      { cwd: process.cwd() },
      { skills, allowedSkills: ['commit'] },
    );

    expect(tools.skill).toBeDefined();

    // Disallowed skill is rejected at invoke time
    const result = await tools.skill.execute!({ name: 'work' }, {} as never);
    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toMatch(/not available/i);

    // Allowed skill loads
    const ok = await tools.skill.execute!({ name: 'commit' }, {} as never);
    expect(ok.canonical.status).toBe('complete');
    expect(ok.agentProjection.content.toLowerCase()).toContain('commit');
  });

  it('allows all skills when allowedSkills is *', async () => {
    const skills = new Map<string, Skill>([
      ['commit', makeSkill('commit')],
      ['work', makeSkill('work')],
    ]);
    const registry = new ToolRegistry();
    const unfiltered = buildSkillTool(skills);
    registry.register(unfiltered.definition, unfiltered.handler);

    const tools = buildToolMap(
      ['skill'],
      registry,
      null,
      { cwd: process.cwd() },
      { skills, allowedSkills: ['*'] },
    );

    const ok = await tools.skill.execute!(
      { name: 'work' },
      {} as never,
    );
    expect(ok.canonical.status).toBe('complete');
  });
});
