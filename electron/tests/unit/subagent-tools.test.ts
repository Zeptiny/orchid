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
import {
  SubagentManager,
  SubagentState,
  getDefaultWaitTimeoutMs,
  type SubagentRecord,
} from '../../src/main/agents/manager';
import { buildDelegateTool as buildDelegateToolRaw } from '../../src/main/tools/subagent/delegate';
import { buildWaitTool as buildWaitToolRaw } from '../../src/main/tools/subagent/wait';
import { buildInterruptTool as buildInterruptToolRaw } from '../../src/main/tools/subagent/interrupt';
import { buildAnswerSubagentTool as buildAnswerSubagentToolRaw } from '../../src/main/tools/subagent/answer';
import type { ToolDefinition, ToolExecutionContext, ToolHandler } from '../../src/main/tools/types';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import {
  createCanonicalToolResult,
  type GenericToolResultData,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../src/shared/types/tool-result';

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

function canonicalizeTool(tool: { definition: ToolDefinition; handler: ToolHandler }) {
  return {
    ...tool,
    handler: async (
      input: unknown,
      ctx: ToolExecutionContext = { cwd: '/tmp' },
    ): Promise<ToolExecutionResult> => {
      const outcome = await tool.handler(input, ctx) as ToolHandlerOutcome<GenericToolResultData>;
      return finalizeToolExecutionResult({
        canonical: createCanonicalToolResult('generic', outcome),
        toolName: tool.definition.name,
        outputDataSchema: tool.definition.outputDataSchema,
        expectedFamily: tool.definition.resultFamily,
      });
    },
  };
}

const buildDelegateTool = (...args: Parameters<typeof buildDelegateToolRaw>) =>
  canonicalizeTool(buildDelegateToolRaw(...args));
const buildWaitTool = (...args: Parameters<typeof buildWaitToolRaw>) =>
  canonicalizeTool(buildWaitToolRaw(...args));
const buildInterruptTool = (...args: Parameters<typeof buildInterruptToolRaw>) =>
  canonicalizeTool(buildInterruptToolRaw(...args));
const buildAnswerSubagentTool = (...args: Parameters<typeof buildAnswerSubagentToolRaw>) =>
  canonicalizeTool(buildAnswerSubagentToolRaw(...args));

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
    }, toolContext)) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.canonical.status).toBe('complete');
    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('subagent');
    expect(result.agentProjection.content).toContain('pending');

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
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('nonexistent-agent');
    expect(result.agentProjection.content).toContain('Available agents');
    // No subagent should be spawned
    expect(manager.allRecords()).toHaveLength(0);
  });

  it('should reject invalid tier at schema boundary', async () => {
    const { definition } = buildDelegateToolRaw(agents, manager);

    const parsed = definition.inputSchema.safeParse({
      name: 'test',
      task: 'Do something',
      type: 'code-reviewer',
      tier: 'invalid-tier',
    });
    expect(parsed.success).toBe(false);
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
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain(record.id);
    expect(result.agentProjection.content).toContain('completed');
    expect(result.agentProjection.content).toContain('Found 3 issues');
  });

  it('should block until subagent completes then return result', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);

    // Start waiting (will block until subagent completes)
    const waitPromise = handler({ subagent_ids: [record.id] });

    // Complete after a small delay
    setTimeout(() => manager.markCompleted(record.id, 'Done!'), 10);

    const result = (await waitPromise) as ToolExecutionResult;
    expect(result.agentProjection.content).toContain('Done!');
    expect(result.agentProjection.content).toContain('completed');
  });

  it('should return error message for empty subagent_ids', async () => {
    const { handler } = buildWaitTool(manager);

    const result = (await handler({
      subagent_ids: [],
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('Error');
  });

  it('should report not found IDs', async () => {
    const { handler } = buildWaitTool(manager);

    const result = (await handler({
      subagent_ids: ['nonexistent-id-1', 'nonexistent-id-2'],
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(result.agentProjection.content).toContain('nonexistent-id-1');
    expect(result.agentProjection.content).toContain('nonexistent-id-2');
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
    )) as ToolExecutionResult;

    expect(result.agentProjection.content).toContain('No subagents found');
    expect(result.agentProjection.content).toContain(peer.id);
    expect(result.agentProjection.content).not.toContain('private task');
    expect(result.agentProjection.content).not.toContain('private result');
  });

  it('omits the task from the output (already in delegate args + system prompt)', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'Review the auth module', codeReviewerAgent);
    manager.markCompleted(record.id, 'Looks good');

    const result = (await handler({
      subagent_ids: [record.id],
    })) as ToolExecutionResult;

    expect(result.agentProjection.content).not.toContain('Review the auth module');
    expect(result.agentProjection.content).not.toContain('<task>');
    expect(result.agentProjection.content).toContain('Looks good');
  });

  it('formats elapsed time and omits token usage from the output', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { handler } = buildWaitTool(manager);
      const record = manager.spawn('test', 'task', codeReviewerAgent);
      record.usage = {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        cached_tokens: 10,
      };
      vi.setSystemTime(125_000);
      manager.markCompleted(record.id, 'done');

      const result = (await handler({
        subagent_ids: [record.id],
      })) as ToolExecutionResult;

      expect(result.agentProjection.content).toContain('elapsed="2m 5s"');
      expect(result.agentProjection.content).not.toContain('prompt_tokens=');
      expect(result.agentProjection.content).not.toContain('completion_tokens=');
      expect(result.agentProjection.content).not.toContain('cached_tokens=');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should include error for failed subagents', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markFailed(record.id, 'Connection timeout');

    const result = (await handler({
      subagent_ids: [record.id],
    })) as ToolExecutionResult;

    expect(result.agentProjection.content).toContain('failed');
    expect(result.agentProjection.content).toContain('Connection timeout');
  });

  it('should handle mix of found and not-found IDs', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markCompleted(record.id, 'done');

    const result = (await handler({
      subagent_ids: [record.id, 'missing-id'],
    })) as ToolExecutionResult;

    expect(result.agentProjection.content).toContain(record.id);
    expect(result.agentProjection.content).toContain('not_found');
    expect(result.agentProjection.content).toContain('missing-id');
  });

  it('should have correct tool definition', () => {
    const { definition } = buildWaitTool(manager);
    expect(definition.name).toBe('wait_for_subagent');
    expect(definition.category).toBe('subagent');
  });

  it('hang → isError timeout; subagent remains RUNNING', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('hang', 'long task', codeReviewerAgent);
    manager.markRunning(record.id);

    // Short-circuit the default 300s budget while exercising real wait timeout.
    const origWait = manager.wait.bind(manager);
    const waitSpy = vi.spyOn(manager, 'wait').mockImplementation((ids, _opts) =>
      origWait(ids, { timeoutMs: 40 }),
    );

    const result = (await handler({
      subagent_ids: [record.id],
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('Only the wait tool stopped waiting');
    expect(result.agentProjection.content).toContain('were not cancelled or interrupted');
    expect(result.agentProjection.content).toContain(record.id);
    expect(record.state).toBe(SubagentState.RUNNING);
    waitSpy.mockRestore();
  });

  it('uses the frozen turn-start wait timeout, ignoring live config changes', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'session-test',
    });
    manager.markCompleted(record.id, 'done');

    // The turn-start snapshot freezes a non-default wait budget (42s).
    const frozenCtx = {
      cwd: '/tmp',
      sessionId: 'session-test',
      projectRuntime: {
        projectDir: '/tmp',
        config: { subagent_wait_timeout: 42 },
        agents: new Map(),
        skills: new Map(),
        personalities: new Map(),
      },
    } as unknown as ToolExecutionContext;

    let capturedTimeoutMs: number | undefined;
    const waitSpy = vi.spyOn(manager, 'wait').mockImplementation(async (_ids, opts) => {
      capturedTimeoutMs = opts?.timeoutMs;
      return new Map<string, SubagentRecord>();
    });

    try {
      await handler({ subagent_ids: [record.id] }, frozenCtx);
    } finally {
      waitSpy.mockRestore();
    }

    // The frozen 42s budget wins; the live default differs, so a mid-turn
    // config change cannot alter the in-flight wait timeout.
    expect(capturedTimeoutMs).toBe(42_000);
    expect(getDefaultWaitTimeoutMs()).not.toBe(42_000);
  });

  it('returns early with a pending_question block when a subagent asks a question', async () => {
    const { handler } = buildWaitTool(manager);
    const record = manager.spawn('test', 'Review the auth module', codeReviewerAgent);
    manager.markRunning(record.id);

    const waitPromise = handler({ subagent_ids: [record.id] });

    // The subagent pauses to ask a question, which unblocks the wait early.
    const questionPromise = manager.markQuestionPending(record.id, 'tc-123<&"', [
      {
        type: 'single',
        title: 'Which framework?',
        description: 'Pick one',
        options: [
          { label: 'React', description: 'A UI library' },
          { label: 'Vue' },
        ],
      },
    ]);

    const result = (await waitPromise) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('status="question_pending"');
    expect(result.agentProjection.content).toContain(
      '<pending_question tool_call_id="tc-123&lt;&amp;&quot;">',
    );
    expect(result.agentProjection.content).toContain(
      '<question type="single" title="Which framework?" description="Pick one">',
    );
    expect(result.agentProjection.content).toContain('<option label="React" description="A UI library"/>');
    expect(result.agentProjection.content).toContain('<option label="Vue"/>');
    // The record is still running — only the wait returned early.
    expect(record.state).toBe(SubagentState.RUNNING);

    // Resolve the pending question so the promise does not dangle.
    manager.answerSubagentQuestion(record.id, 'tc-123<&"', { type: 'declined' });
    await questionPromise;
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
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('<interrupted>');
    expect(result.agentProjection.content).toContain(record.id);
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
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain(a.id);
    expect(result.agentProjection.content).toContain(b.id);
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
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
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
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(result.agentProjection.content).toContain('<already_finished>');
    expect(result.agentProjection.content).toContain(record.id);
  });

  it('should report not found subagents', async () => {
    const { handler } = buildInterruptTool(manager);

    const result = (await handler(
      { subagent_ids: ['nonexistent-id'] },
      sessionCtx,
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(result.agentProjection.content).toContain('<not_found>');
    expect(result.agentProjection.content).toContain('nonexistent-id');
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
    )) as ToolExecutionResult;

    expect(result.agentProjection.content).toContain('<not_found>');
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
    )) as ToolExecutionResult;

    expect(result.agentProjection.content).toContain('<interrupted>');
    expect(result.agentProjection.content).toContain(running.id);
    expect(result.agentProjection.content).toContain('<already_finished>');
    expect(result.agentProjection.content).toContain(completed.id);
    expect(result.agentProjection.content).toContain('<not_found>');
    expect(result.agentProjection.content).toContain('missing-id');
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
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(result.agentProjection.content).toContain('No running subagents found');
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
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(pending.state).toBe(SubagentState.INTERRUPTED);
  });

  it('should have correct tool definition', () => {
    const { definition } = buildInterruptTool(manager);
    expect(definition.name).toBe('interrupt_subagents');
    expect(definition.category).toBe('subagent');
  });
});

// ── answer_subagent ──────────────────────────────────────────────────────────

describe('answer_subagent', () => {
  let manager: SubagentManager;

  const sampleQuestions = [
    {
      type: 'single' as const,
      title: 'Which framework?',
      options: [{ label: 'React' }, { label: 'Vue' }],
    },
  ];

  beforeEach(() => {
    manager = new SubagentManager();
  });

  function spawnWithPendingQuestion(sessionId?: string) {
    const record = manager.spawn('test', 'task', codeReviewerAgent, { sessionId });
    manager.markRunning(record.id);
    const questionPromise = manager.markQuestionPending(record.id, 'tc-1', sampleQuestions);
    return { id: record.id, questionPromise };
  }

  it('answers a pending question and resolves the subagent with the answers', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion();

    const answers = [{ selected: ['React'], text: null, skipped: false }];
    const result = (await handler({ subagent_id: id, tool_call_id: 'tc-1', answers })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('answered');
    expect(result.agentProjection.content).toContain(id);
    await expect(questionPromise).resolves.toEqual({ type: 'answered', answers });
  });

  it('declines a pending question', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion();

    const result = (await handler({ subagent_id: id, tool_call_id: 'tc-1', decline: true })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(result.agentProjection.content).toContain('declined');
    await expect(questionPromise).resolves.toEqual({ type: 'declined' });
  });

  it('rejects attempts from a subagent scope and leaves the question pending', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion('sess-a');

    try {
      const result = (await handler(
        { subagent_id: id, tool_call_id: 'tc-1', decline: true },
        { cwd: '/tmp/project', sessionId: 'sess-a', agentScopeId: 'subagent-peer' },
      )) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toMatch(/main agent/i);
      expect(manager.getRecord(id)?.pendingQuestion).not.toBeNull();
    } finally {
      manager.answerSubagentQuestion(id, 'tc-1', { type: 'declined' });
      await questionPromise;
    }
  });

  it('rejects attempts from another session and leaves the question pending', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion('sess-owner');

    try {
      const result = (await handler(
        { subagent_id: id, tool_call_id: 'tc-1', decline: true },
        { cwd: '/tmp/project', sessionId: 'sess-other', agentScopeId: 'main' },
      )) as ToolExecutionResult;

      expect(result.canonical.status).toBe('error');
      expect(result.agentProjection.content).toContain('no pending question');
      expect(manager.getRecord(id)?.pendingQuestion).not.toBeNull();
    } finally {
      manager.answerSubagentQuestion(id, 'tc-1', { type: 'declined' });
      await questionPromise;
    }
  });

  it('errors when both answers and decline are provided', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion();

    const result = (await handler({
      subagent_id: id,
      tool_call_id: 'tc-1',
      answers: [{ selected: ['React'], text: null, skipped: false }],
      decline: true,
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('exactly one');
    // The pending question is left untouched; clean it up.
    manager.answerSubagentQuestion(id, 'tc-1', { type: 'declined' });
    await questionPromise;
  });

  it('errors when neither answers nor decline is provided', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion();

    const result = (await handler({ subagent_id: id, tool_call_id: 'tc-1' })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('exactly one');
    manager.answerSubagentQuestion(id, 'tc-1', { type: 'declined' });
    await questionPromise;
  });

  it('errors when the subagent has no pending question', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent);

    const result = (await handler({
      subagent_id: record.id,
      tool_call_id: 'tc-missing',
      decline: true,
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('no pending question');
  });

  it('should have correct tool definition', () => {
    const { definition } = buildAnswerSubagentTool(manager);
    expect(definition.name).toBe('answer_subagent');
    expect(definition.category).toBe('subagent');
    expect(definition.description).toContain('tool_call_id');
    expect(definition.inputSchema.safeParse({
      subagent_id: 'subagent-1',
      decline: true,
    }).success).toBe(false);
    expect(definition.inputSchema.safeParse({
      subagent_id: 'subagent-1',
      tool_call_id: 'tc-1',
      decline: true,
    }).success).toBe(true);
  });

  it('rejects the wrong question identity without settling the pending question', async () => {
    const { handler } = buildAnswerSubagentTool(manager);
    const { id, questionPromise } = spawnWithPendingQuestion();

    const result = (await handler({
      subagent_id: id,
      tool_call_id: 'tc-stale',
      decline: true,
    })) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('tc-stale');
    expect(manager.getRecord(id)?.pendingQuestion?.toolCallId).toBe('tc-1');
    manager.answerSubagentQuestion(id, 'tc-1', { type: 'declined' });
    await questionPromise;
  });
});
