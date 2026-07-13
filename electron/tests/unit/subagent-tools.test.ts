/**
 * Tests for subagent delegation tools (U11).
 *
 * Covers:
 * - delegate_to_subagent: spawn, ID returned, unknown agent, invalid tier
 * - wait_for_subagent: result on completion, not found, empty IDs
 * - interrupt_subagents: cancel specific, cancel all, already done, not found
 * - Dynamic description: lists available agents with tiers
 * - Tier override: tier param overrides agent default
 *
 * Test scenarios from plan U11.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { AgentType, AgentTier, type Agent } from '../../src/shared/types/agent';
import { SubagentManager, SubagentState } from '../../src/main/agents/manager';
import { buildDelegateTool } from '../../src/main/tools/subagent/delegate';
import { buildWaitTool } from '../../src/main/tools/subagent/wait';
import { buildInterruptTool } from '../../src/main/tools/subagent/interrupt';
import type { SubagentToolResult } from '../../src/main/tools/subagent/delegate';
import type { ToolExecutionContext } from '../../src/main/tools/types';

const tierSelections = {
  seed: { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'model-for-seed' },
  sprout: { connectionId: '22222222-2222-4222-8222-222222222222', modelId: 'model-for-sprout' },
  bloom: { connectionId: '33333333-3333-4333-8333-333333333333', modelId: 'model-for-bloom' },
  crown: { connectionId: '44444444-4444-4444-8444-444444444444', modelId: 'model-for-crown' },
} as const;

// ── Test fixtures ────────────────────────────────────────────────────────────

const codeReviewerAgent: Agent = {
  name: 'code-reviewer',
  type: AgentType.SUBAGENT,
  tier: AgentTier.CROWN,
  description: 'Reviews code for quality and correctness',
  allowed_tools: ['read', 'grep', 'glob'],
  allowed_skills: ['*'],
};

const fileExplorerAgent: Agent = {
  name: 'file-explorer',
  type: AgentType.SUBAGENT,
  tier: AgentTier.SEED,
  description: 'Explores file structure and contents',
  allowed_tools: ['read', 'read_directory', 'glob'],
  allowed_skills: ['*'],
};

const generalAgent: Agent = {
  name: 'general',
  type: AgentType.INTERNAL,
  tier: AgentTier.BLOOM,
  description: 'General-purpose internal agent',
  allowed_tools: ['*'],
  allowed_skills: ['*'],
};

function makeAgentMap(): Map<string, Agent> {
  const map = new Map<string, Agent>();
  map.set(codeReviewerAgent.name, codeReviewerAgent);
  map.set(fileExplorerAgent.name, fileExplorerAgent);
  map.set(generalAgent.name, generalAgent);
  return map;
}

const toolContext = {
  cwd: '/tmp',
  sessionId: 'session-test',
  agentScopeId: 'main',
  projectRuntime: {
    projectDir: '/tmp',
    config: {
      default_model: tierSelections.bloom,
      tier_models: tierSelections,
    },
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  },
} as ToolExecutionContext;

// ── delegate_to_subagent ─────────────────────────────────────────────────────

describe('delegate_to_subagent', () => {
  let manager: SubagentManager;
  let agents: Map<string, Agent>;

  beforeEach(() => {
    manager = new SubagentManager();
    agents = makeAgentMap();
    vi.clearAllMocks();
  });

  it('should spawn a subagent and return ID', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    const result = (await handler({
      name: 'review auth',
      task: 'Review the authentication module for security issues',
      type: 'code-reviewer',
    }, toolContext)) as SubagentToolResult;

    expect(result.display).toContain('Subagent');
    expect(result.display).toContain('review auth');
    expect(result.display).toContain('spawned');
    expect(result.content).toContain('subagent');
    expect(result.content).toContain('pending');

    // Verify a record was created in the manager
    const records = manager.allRecords();
    expect(records).toHaveLength(1);
    expect(records[0].label).toBe('review auth');
    expect(records[0].task).toBe('Review the authentication module for security issues');
    expect(records[0].agent.name).toBe('code-reviewer');
    expect(records[0].state).toBe(SubagentState.PENDING);
  });

  it('should use agent default tier when tier not specified', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    await handler({
      name: 'explore files',
      task: 'List all TypeScript files',
      type: 'file-explorer',
    }, toolContext);

    const records = manager.allRecords();
    // file-explorer has tier SEED, so its frozen selection is exact.
    expect(records[0].selection).toEqual(tierSelections.seed);
  });

  it('should override tier when tier param is provided', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    await handler({
      name: 'deep review',
      task: 'Complex architecture review',
      type: 'file-explorer', // default tier is seed
      tier: 'crown', // override to crown
    }, toolContext);

    const records = manager.allRecords();
    expect(records[0].selection).toEqual(tierSelections.crown);
  });

  it('should return error for unknown agent type', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    const result = (await handler({
      name: 'test',
      task: 'Do something',
      type: 'nonexistent-agent',
    })) as SubagentToolResult;

    expect(result.display).toContain('Unknown agent type');
    expect(result.content).toContain('nonexistent-agent');
    expect(result.content).toContain('Available agents');
    // No subagent should be spawned
    expect(manager.allRecords()).toHaveLength(0);
  });

  it('should return error for invalid tier', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    const result = (await handler({
      name: 'test',
      task: 'Do something',
      type: 'code-reviewer',
      tier: 'invalid-tier',
    })) as SubagentToolResult;

    expect(result.display).toContain('Invalid tier');
    expect(result.content).toContain('invalid-tier');
    expect(result.content).toContain('Available tiers');
    // No subagent should be spawned
    expect(manager.allRecords()).toHaveLength(0);
  });

  it('should produce dynamic description listing available agents', () => {
    const { definition } = buildDelegateTool(agents, manager);

    // Description should mention subagent agents
    expect(definition.description).toContain('Subagents do not share your context');
    expect(definition.description).toContain('Subagents cannot create subagents');

    // The inputSchema should have the type field with agent list
    const schema = definition.inputSchema as z.ZodObject<z.RawShape>;
    const shape = schema.shape;
    expect(shape.type).toBeDefined();
    expect(shape.name).toBeDefined();
    expect(shape.task).toBeDefined();
    expect(shape.tier).toBeDefined();

    // The type field description should list subagent agents (not internal ones)
    const typeDesc = shape.type.description ?? '';
    expect(typeDesc).toContain('code-reviewer');
    expect(typeDesc).toContain('file-explorer');
    // Internal agents should NOT be listed
    expect(typeDesc).not.toContain('general');
  });

  it('should list tier descriptions in the tier field', () => {
    const { definition } = buildDelegateTool(agents, manager);
    const schema = definition.inputSchema as z.ZodObject<z.RawShape>;
    const tierDesc = schema.shape.tier.description ?? '';

    expect(tierDesc).toContain('seed');
    expect(tierDesc).toContain('sprout');
    expect(tierDesc).toContain('bloom');
    expect(tierDesc).toContain('crown');
  });

  it('should have correct action label and category', () => {
    const { definition } = buildDelegateTool(agents, manager);
    expect(definition.actionLabel).toBe('Delegating...');
    expect(definition.category).toBe('subagent');
    expect(definition.name).toBe('delegate_to_subagent');
  });

  it('should pass the typed selection to SubagentManager.spawn', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    await handler({
      name: 'test',
      task: 'test task',
      type: 'code-reviewer', // tier: crown
    }, toolContext);

    const records = manager.allRecords();
    expect(records[0].selection).toEqual(tierSelections.crown);
  });

  it('inherits the parent turn selection instead of rebinding to the worker tier', async () => {
    const { handler } = buildDelegateTool(agents, manager);
    const parentSelection = {
      connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      modelId: 'parent/vendor/model',
    };

    await handler({
      name: 'same provider',
      task: 'Use the parent provider identity',
      type: 'file-explorer',
    }, { ...toolContext, selection: parentSelection });

    expect(manager.allRecords()[0].selection).toEqual(parentSelection);
  });
});

// ── wait_for_subagent ────────────────────────────────────────────────────────

describe('wait_for_subagent', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it('should return result when subagent completes', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'do something', codeReviewerAgent);

    // Complete the subagent before waiting
    manager.markCompleted(record.id, 'Found 3 issues');

    const result = (await handler({
      subagent_ids: [record.id],
    })) as SubagentToolResult;

    expect(result.display).toContain('Waited for 1 subagent(s)');
    expect(result.content).toContain(record.id);
    expect(result.content).toContain('completed');
    expect(result.content).toContain('Found 3 issues');
  });

  it('should block until subagent completes then return result', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);

    // Start waiting (will block until subagent completes)
    const waitPromise = handler({ subagent_ids: [record.id] });

    // Complete after a small delay
    setTimeout(() => manager.markCompleted(record.id, 'Done!'), 10);

    const result = (await waitPromise) as SubagentToolResult;
    expect(result.content).toContain('Done!');
    expect(result.content).toContain('completed');
  });

  it('should return error message for empty subagent_ids', async () => {
    const { handler } = buildWaitTool(manager);

    const result = (await handler({
      subagent_ids: [],
    })) as SubagentToolResult;

    expect(result.display).toContain('No subagent IDs provided');
    expect(result.content).toContain('Error');
  });

  it('should report not found IDs', async () => {
    const { handler } = buildWaitTool(manager);

    const result = (await handler({
      subagent_ids: ['nonexistent-id-1', 'nonexistent-id-2'],
    })) as SubagentToolResult;

    expect(result.display).toContain('No subagents found');
    expect(result.content).toContain('nonexistent-id-1');
    expect(result.content).toContain('nonexistent-id-2');
  });

  it('does not expose a subagent owned by another session', async () => {
    const { handler } = buildWaitTool(manager);
    const peer = manager.spawn('peer', 'private task', codeReviewerAgent, {
      sessionId: 'sess-b',
    });
    manager.markCompleted(peer.id, 'private result');

    const result = (await handler(
      { subagent_ids: [peer.id] },
      { cwd: '/tmp/project', sessionId: 'sess-a' },
    )) as SubagentToolResult;

    expect(result.content).toContain('No subagents found');
    expect(result.content).toContain(peer.id);
    expect(result.content).not.toContain('private task');
    expect(result.content).not.toContain('private result');
  });

  it('should include task in the output', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'Review the auth module', codeReviewerAgent);
    manager.markCompleted(record.id, 'Looks good');

    const result = (await handler({
      subagent_ids: [record.id],
    })) as SubagentToolResult;

    expect(result.content).toContain('Review the auth module');
  });

  it('should include error for failed subagents', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markFailed(record.id, 'Connection timeout');

    const result = (await handler({
      subagent_ids: [record.id],
    })) as SubagentToolResult;

    expect(result.content).toContain('failed');
    expect(result.content).toContain('Connection timeout');
  });

  it('should handle mix of found and not-found IDs', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markCompleted(record.id, 'done');

    const result = (await handler({
      subagent_ids: [record.id, 'missing-id'],
    })) as SubagentToolResult;

    expect(result.content).toContain(record.id);
    expect(result.content).toContain('not_found');
    expect(result.content).toContain('missing-id');
  });

  it('should have correct tool definition', () => {
    const { definition } = buildWaitTool(manager);
    expect(definition.name).toBe('wait_for_subagent');
    expect(definition.actionLabel).toBe('Waiting...');
    expect(definition.category).toBe('subagent');
  });
});

// ── interrupt_subagents ──────────────────────────────────────────────────────

describe('interrupt_subagents', () => {
  let manager: SubagentManager;
  const sessionCtx = { cwd: '/tmp/project', sessionId: 'sess-a' };

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it('should cancel a running subagent by ID', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(record.id);

    const result = (await handler(
      { subagent_ids: [record.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toContain('Interrupted 1 subagent(s)');
    expect(result.content).toContain('Interrupted');
    expect(result.content).toContain(record.id);
    expect(record.state).toBe(SubagentState.INTERRUPTED);
  });

  it('should cancel all running subagents in this session when IDs empty', async () => {
    const { handler } = buildInterruptTool(manager);
    const a = manager.spawn('a', 'task 1', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    const b = manager.spawn('b', 'task 2', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    const result = (await handler(
      { subagent_ids: [] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toContain('Interrupted 2 subagent(s)');
    expect(result.content).toContain(a.id);
    expect(result.content).toContain(b.id);
    expect(a.state).toBe(SubagentState.INTERRUPTED);
    expect(b.state).toBe(SubagentState.INTERRUPTED);
  });

  it('empty list must not cancel subagents owned by another session', async () => {
    const { handler } = buildInterruptTool(manager);
    const mine = manager.spawn('mine', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    const peer = manager.spawn('peer', 'task', codeReviewerAgent, {
      sessionId: 'sess-b',
    });
    manager.markRunning(mine.id);
    manager.markRunning(peer.id);

    const result = (await handler(
      { subagent_ids: [] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toContain('Interrupted 1 subagent(s)');
    expect(mine.state).toBe(SubagentState.INTERRUPTED);
    expect(peer.state).toBe(SubagentState.RUNNING);
  });

  it('should report already finished subagents', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markCompleted(record.id, 'done');

    const result = (await handler(
      { subagent_ids: [record.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toBe('No subagents interrupted');
    expect(result.content).toContain('Already finished');
    expect(result.content).toContain(record.id);
  });

  it('should report not found subagents', async () => {
    const { handler } = buildInterruptTool(manager);

    const result = (await handler(
      { subagent_ids: ['nonexistent-id'] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toBe('No subagents interrupted');
    expect(result.content).toContain('Not found');
    expect(result.content).toContain('nonexistent-id');
  });

  it('does not interrupt an explicit subagent owned by another session', async () => {
    const { handler } = buildInterruptTool(manager);
    const peer = manager.spawn('peer', 'task', codeReviewerAgent, {
      sessionId: 'sess-b',
    });
    manager.markRunning(peer.id);

    const result = (await handler(
      { subagent_ids: [peer.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.content).toContain('Not found');
    expect(peer.state).toBe(SubagentState.RUNNING);
  });

  it('should handle mix of cancelled, already done, and not found', async () => {
    const { handler } = buildInterruptTool(manager);
    const running = manager.spawn('running', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(running.id);
    const completed = manager.spawn('completed', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markCompleted(completed.id, 'done');

    const result = (await handler(
      {
        subagent_ids: [running.id, completed.id, 'missing-id'],
      },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.content).toContain('Interrupted');
    expect(result.content).toContain(running.id);
    expect(result.content).toContain('Already finished');
    expect(result.content).toContain(completed.id);
    expect(result.content).toContain('Not found');
    expect(result.content).toContain('missing-id');
  });

  it('should report no running subagents when all are terminal', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markCompleted(record.id, 'done');

    const result = (await handler(
      { subagent_ids: [] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toContain('No running subagents');
    expect(result.content).toContain('No running subagents found');
  });

  it('should cancel pending (not yet running) subagents', async () => {
    const { handler } = buildInterruptTool(manager);
    const pending = manager.spawn('pending', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    // Don't mark as running — it's still PENDING

    const result = (await handler(
      { subagent_ids: [pending.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toContain('Interrupted 1 subagent(s)');
    expect(pending.state).toBe(SubagentState.INTERRUPTED);
  });

  it('should have correct tool definition', () => {
    const { definition } = buildInterruptTool(manager);
    expect(definition.name).toBe('interrupt_subagents');
    expect(definition.actionLabel).toBe('Interrupting...');
    expect(definition.category).toBe('subagent');
  });
});
