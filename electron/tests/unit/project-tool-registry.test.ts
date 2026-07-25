import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/shared/types/agent';
import { AgentTier, AgentType } from '../../src/shared/types/agent';
import type { Skill } from '../../src/shared/types/skill';
import { createBuiltinToolRegistry } from '../../src/main/tools';
import { SubagentManager } from '../../src/main/agents/manager';
import type { ToolExecutionContext } from '../../src/main/tools/types';

function subagent(name: string, description: string): Agent {
  return {
    name,
    type: AgentType.SUBAGENT,
    tier: AgentTier.BLOOM,
    description,
    system_prompt: `${description} prompt`,
    allowed_tools: Object.freeze(['*']),
    allowed_skills: Object.freeze(['*']),
  };
}

function skill(name: string, description: string): Skill {
  return {
    name,
    description,
    requires: [],
    resources: [],
  };
}

describe('project-scoped tool registries', () => {
  it('keeps dynamic agent and skill definitions independent per registry', async () => {
    const projectAManager = new SubagentManager();
    const projectBManager = new SubagentManager();
    const projectARegistry = createBuiltinToolRegistry({
      agents: new Map([['a-worker', subagent('a-worker', 'Project A worker')]]),
      skills: new Map([['a-skill', skill('a-skill', 'Project A skill')]]),
      subagentManager: projectAManager,
    });
    const projectBRegistry = createBuiltinToolRegistry({
      agents: new Map([['b-worker', subagent('b-worker', 'Project B worker')]]),
      skills: new Map([['b-skill', skill('b-skill', 'Project B skill')]]),
      subagentManager: projectBManager,
    });

    const aDelegate = projectARegistry.get('delegate_to_subagent');
    const bDelegate = projectBRegistry.get('delegate_to_subagent');
    const aSkill = projectARegistry.get('skill');
    const bSkill = projectBRegistry.get('skill');

    expect(aDelegate).toBeDefined();
    expect(bDelegate).toBeDefined();
    expect(aSkill).toBeDefined();
    expect(bSkill).toBeDefined();

    const runtimeContext = {
      cwd: '/tmp',
      sessionId: 'session-test',
      agentScopeId: 'main',
      projectRuntime: {
        projectDir: '/tmp',
        config: { default_model: 'test/model', tier_models: { bloom: 'test/model' } },
        agents: new Map(),
        skills: new Map(),
        personalities: new Map(),
      },
    } as ToolExecutionContext;
    const aSpawn = await aDelegate!.handler(
      { name: 'A task', task: 'Inspect project A', type: 'a-worker' },
      runtimeContext,
    );
    const aCannotSpawnB = await aDelegate!.handler(
      { name: 'Wrong task', task: 'Inspect project B', type: 'b-worker' },
      runtimeContext,
    );
    const bSpawn = await bDelegate!.handler(
      { name: 'B task', task: 'Inspect project B', type: 'b-worker' },
      runtimeContext,
    );
    const aSkillResult = await aSkill!.handler(
      { name: 'a-skill' },
      { cwd: '/tmp', agentScopeId: 'main' },
    );
    const aCannotLoadB = await aSkill!.handler(
      { name: 'b-skill' },
      { cwd: '/tmp', agentScopeId: 'main' },
    );

    expect(aSpawn.status).toBe('complete');
    expect(aCannotSpawnB.status).toBe('error');
    expect(bSpawn.status).toBe('complete');
    expect(projectAManager.allRecords().map((record) => record.agent.name)).toEqual(['a-worker']);
    expect(projectBManager.allRecords().map((record) => record.agent.name)).toEqual(['b-worker']);
    expect(aSkillResult.status).toBe('complete');
    expect(aCannotLoadB.status).toBe('error');
  });
});
