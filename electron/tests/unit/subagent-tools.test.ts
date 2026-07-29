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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { AgentType, AgentTier, type Agent } from '../../src/shared/types/agent';
import {
  SubagentManager,
  SubagentState,
  getDefaultWaitTimeoutMs,
  runtimeToDomain,
  type SubagentRecord,
} from '../../src/main/agents/manager';
import {
  subagentRecordFromStorageDict,
  subagentRecordToStorageDict,
} from '../../src/shared/types/subagent';
import {
  forgetSubagentPersistedRevision,
  persistSubagentChains,
} from '../../src/main/agents/persist-subagent-chains';
import { hydrateSubagentRecords } from '../../src/main/tools/subagent/hydrate';
import { recoverSubagentPersistence } from '../../src/main/agents/wire-subagents';
import { buildDelegateTool as buildDelegateToolRaw } from '../../src/main/tools/subagent/delegate';
import { buildWaitTool as buildWaitToolRaw } from '../../src/main/tools/subagent/wait';
import { buildInterruptTool as buildInterruptToolRaw } from '../../src/main/tools/subagent/interrupt';
import { buildCloseTool as buildCloseToolRaw } from '../../src/main/tools/subagent/close';
import { buildAnswerSubagentTool as buildAnswerSubagentToolRaw } from '../../src/main/tools/subagent/answer';
import { buildFollowUpTool as buildFollowUpToolRaw } from '../../src/main/tools/subagent/follow-up';
import { RiskClass } from '../../src/shared/types/permission';
import type { ToolDefinition, ToolExecutionContext, ToolHandler } from '../../src/main/tools/types';
import { finalizeToolExecutionResult } from '../../src/main/tools/result';
import {
  createCanonicalToolResult,
  type GenericToolResultData,
  type ToolExecutionResult,
  type ToolHandlerOutcome,
} from '../../src/shared/types/tool-result';
import { defaults } from '../../src/main/config/schema';
import type { Config } from '../../src/shared/types/ipc-boundary';

/**
 * Admission limits are read from the live config inside `SubagentManager`
 * (top-level `getConfig` import). Overriding `getConfig` here pins the
 * `subagents.*` limits for the queue tests; with no override the real loader
 * is used so every other test keeps its existing behavior.
 */
const configOverride = vi.hoisted(() => ({ current: null as Config | null }));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => configOverride.current ?? actual.getConfig(),
  };
});

/**
 * The hydrate helper resolves stored records through the session manager via a
 * lazy `await import('../../ipc/session')` (mockable, unlike createRequire). A
 * per-test holder drives it; when unset, a null-returning stub keeps the other
 * tool handlers (delegate reads `getSession`) on their no-session path.
 */
interface FakeSessionManager {
  getSession: (id: string) => unknown;
  getActive: () => unknown;
  syncSubagentRecords?: (
    sessionId: string,
    records: unknown[],
  ) => { session: unknown; bytes: number };
}
const sessionManagerHolder = vi.hoisted(() => ({ current: null as FakeSessionManager | null }));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () =>
    sessionManagerHolder.current ?? {
      getSession: () => null,
      getActive: () => null,
      // Benign no-op so the wait tool's legacy persistence fallback (which reads
      // the session manager directly) does not throw against the bare stub.
      syncSubagentRecords: () => ({ session: null, bytes: 0 }),
    },
}));

/**
 * The close tool flushes the closed flag through `recoverSubagentPersistence`
 * via a lazy `await import('../../agents/wire-subagents')` (same pattern as
 * wait.ts). Spy on that entry point so the persistence-trigger test can assert
 * it fires. A plain factory (no `importOriginal`) is required: loading the real
 * module here pre-populates the module cache and the dependency's dynamic import
 * would bypass the mock. `persistSubagentChains` is the wait tool's legacy
 * fallback export — stub it too so the wait tests stay isolated from disk/IPC.
 */
vi.mock('../../src/main/agents/wire-subagents', () => ({
  recoverSubagentPersistence: vi.fn(),
  persistSubagentChains: vi.fn(),
}));

const recoverSpy = vi.mocked(recoverSubagentPersistence);

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
const buildCloseTool = (...args: Parameters<typeof buildCloseToolRaw>) =>
  canonicalizeTool(buildCloseToolRaw(...args));
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

  it('omits the task from the projection (already in args + system prompt)', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    const result = (await handler({
      name: 'review auth',
      task: 'Review the authentication module for security issues',
      type: 'code-reviewer',
    }, toolContext)) as ToolExecutionResult;

    expect(result.agentProjection.content).not.toContain('Review the authentication module');
    expect(result.agentProjection.content).not.toContain('<task>');
    expect(result.agentProjection.content).toContain('review auth');
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

// ── close_subagents (U2) ─────────────────────────────────────────────────────

describe('close_subagents', () => {
  let manager: SubagentManager;
  const sid = 'sess-close';

  beforeEach(() => {
    manager = new SubagentManager();
    sessionManagerHolder.current = null;
    recoverSpy.mockClear();
  });

  afterEach(() => {
    sessionManagerHolder.current = null;
  });

  function makeCtx(agents: Map<string, Agent>, overrides: Partial<ToolExecutionContext> = {}) {
    return {
      cwd: '/tmp/turn',
      sessionId: sid,
      projectRuntime: {
        projectDir: '/tmp',
        config: defaults(),
        agents,
        skills: new Map(),
        personalities: new Map(),
      },
      ...overrides,
    } as unknown as ToolExecutionContext;
  }

  /** Round-trip a runtime record through the storage dict to mimic a loaded row. */
  function storedDomain(record: SubagentRecord) {
    return subagentRecordFromStorageDict(subagentRecordToStorageDict(runtimeToDomain(record)));
  }

  function setSession(subagentChains: unknown[], cwd: string | null = '/tmp/session') {
    const session = { id: sid, cwd, subagentChains };
    sessionManagerHolder.current = {
      getSession: (id: string) => (id === sid ? session : null),
      getActive: () => null,
    };
    return session;
  }

  /** Extract the structured outcome value (no dedicated renderer for this tool). */
  function outcomeValue(result: ToolExecutionResult) {
    return (result.canonical.data as { value: Record<string, string[]> }).value;
  }

  it('closes a terminal record, hides it from getStates, and reports it closed', async () => {
    const { handler } = buildCloseTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');
    expect(manager.getStates(sid).some((s) => s.id === record.id)).toBe(true);

    const result = (await handler(
      { subagent_ids: [record.id] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(outcomeValue(result).closed).toContain(record.id);
    expect(manager.getRecord(record.id)?.closed).toBe(true);
    // R1: the closed record disappears from the prompt-facing state list.
    expect(manager.getStates(sid).some((s) => s.id === record.id)).toBe(false);
    // R2: the durable record and its terminal state stay intact.
    expect(manager.getRecord(record.id)?.state).toBe(SubagentState.COMPLETED);
    expect(manager.getRecord(record.id)?.result).toBe('done');
    expect(result.agentProjection.content).toContain(record.id);
  });

  it('rejects a running record as not_terminal with interrupt guidance', async () => {
    const { handler } = buildCloseTool(manager);
    const record = manager.spawn('running', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markRunning(record.id);

    const result = (await handler(
      { subagent_ids: [record.id] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(outcomeValue(result).not_terminal).toContain(record.id);
    expect(manager.getRecord(record.id)?.closed).toBe(false);
  });

  it('reports an unknown id as not_found', async () => {
    const { handler } = buildCloseTool(manager);

    const result = (await handler(
      { subagent_ids: ['nonexistent-id'] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(outcomeValue(result).not_found).toContain('nonexistent-id');
  });

  it('reports a subagent owned by another session as not_found and leaves it open', async () => {
    const { handler } = buildCloseTool(manager);
    const peer = manager.spawn('peer', 'task', codeReviewerAgent, { sessionId: 'sess-other' });
    manager.markCompleted(peer.id, 'done');

    const result = (await handler(
      { subagent_ids: [peer.id] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;

    expect(outcomeValue(result).not_found).toContain(peer.id);
    expect(manager.getRecord(peer.id)?.closed).toBe(false);
  });

  it('reports an already-closed record as already_closed (idempotent re-close)', async () => {
    const { handler } = buildCloseTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');

    const first = (await handler(
      { subagent_ids: [record.id] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;
    expect(first.canonical.status).toBe('complete');
    expect(outcomeValue(first).closed).toContain(record.id);

    const second = (await handler(
      { subagent_ids: [record.id] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;
    expect(second.canonical.status).toBe('empty');
    expect(outcomeValue(second).already_closed).toContain(record.id);
    expect(outcomeValue(second).closed).toEqual([]);
    expect(manager.getRecord(record.id)?.closed).toBe(true);
  });

  it('triggers a recovery persistence flush after a successful close', async () => {
    const { handler } = buildCloseTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');

    await handler({ subagent_ids: [record.id] }, makeCtx(makeAgentMap()));

    expect(recoverSpy).toHaveBeenCalledWith(sid);
  });

  it('does not trigger a persistence flush when nothing was closed', async () => {
    const { handler } = buildCloseTool(manager);

    await handler({ subagent_ids: ['nonexistent-id'] }, makeCtx(makeAgentMap()));

    expect(recoverSpy).not.toHaveBeenCalled();
  });

  it('hydrates an evicted record first, then flags and reports it closed', async () => {
    const { handler } = buildCloseTool(manager);
    const record = manager.spawn('evicted', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first');
    const domain = storedDomain(record);
    // Confirming persistence evicts the runtime record to a lean summary.
    manager.confirmRecordsPersisted(sid, [record.id]);
    expect(manager.getRecord(record.id)?._evicted).toBe(true);
    setSession([domain]);

    const result = (await handler(
      { subagent_ids: [record.id] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    expect(outcomeValue(result).closed).toContain(record.id);
    const restored = manager.getRecord(record.id)!;
    expect(restored._evicted).toBe(false);
    expect(restored.closed).toBe(true);
    expect(restored.state).toBe(SubagentState.COMPLETED);
  });

  it('surfaces a stored record whose agent definition is gone as agent_missing', async () => {
    const { handler } = buildCloseTool(manager);
    const source = new SubagentManager();
    const original = source.spawn('orphan', 'task', codeReviewerAgent, { sessionId: sid });
    source.markCompleted(original.id, 'stored');
    setSession([storedDomain(original)]);
    // Registry WITHOUT code-reviewer, which the stored record references.
    const agents = new Map<string, Agent>();
    agents.set(fileExplorerAgent.name, fileExplorerAgent);

    const result = (await handler(
      { subagent_ids: [original.id] },
      makeCtx(agents),
    )) as ToolExecutionResult;

    const value = outcomeValue(result);
    expect(value.agent_missing).toContain(original.id);
    expect(value.not_found).not.toContain(original.id);
    expect(value.closed).toEqual([]);
  });

  it('returns an error outcome for an empty id list', async () => {
    const { handler } = buildCloseTool(manager);

    const result = (await handler(
      { subagent_ids: [] },
      makeCtx(makeAgentMap()),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('non-empty');
  });

  it('should have correct tool definition', () => {
    const { definition } = buildCloseTool(manager);
    expect(definition.name).toBe('close_subagents');
    expect(definition.category).toBe('subagent');
    expect(definition.riskClass).toBe('delegation');
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

// ── delegate_to_subagent admission control (U7) ─────────────────────────────

describe('delegate_to_subagent admission control', () => {
  let manager: SubagentManager;
  let agents: Map<string, Agent>;

  beforeEach(() => {
    manager = new SubagentManager();
    agents = makeAgentMap();
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, max_active_per_session: 1, max_queued: 2 },
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    configOverride.current = null;
  });

  it('surfaces queued status and queue position when over capacity', async () => {
    const { handler } = buildDelegateTool(agents, manager);

    const first = (await handler({
      name: 'first', task: 'task one', type: 'code-reviewer',
    }, toolContext)) as ToolExecutionResult;
    expect(first.canonical.status).toBe('complete');
    expect(first.agentProjection.content).toContain('status="pending"');
    expect(first.agentProjection.content).not.toContain('queue_position');

    const second = (await handler({
      name: 'second', task: 'task two', type: 'code-reviewer',
    }, toolContext)) as ToolExecutionResult;
    expect(second.canonical.status).toBe('complete');
    expect(second.agentProjection.content).toContain('status="queued"');
    expect(second.agentProjection.content).toContain('queue_position="1"');

    const data = second.canonical.data as GenericToolResultData;
    const value = data.value as { status: string; queue_position: number };
    expect(value.status).toBe(SubagentState.QUEUED);
    expect(value.queue_position).toBe(1);
  });

  it('returns a structured error naming the limit when the queue is full', async () => {
    const { handler } = buildDelegateTool(agents, manager);
    const spawnOne = (name: string) => handler({
      name, task: 'task', type: 'code-reviewer',
    }, toolContext);

    await spawnOne('active');
    await spawnOne('queued-1');
    await spawnOne('queued-2');
    const refused = (await spawnOne('refused')) as ToolExecutionResult;

    expect(refused.canonical.status).toBe('error');
    expect(refused.agentProjection.content).toContain('max_queued=2');
    expect(refused.agentProjection.content).toContain('max_active_per_session=1');
    // No record leaks into the manager for the refused spawn.
    expect(manager.allRecords()).toHaveLength(3);
    expect(manager.allRecords().some((record) => record.label === 'refused')).toBe(false);
  });
});

// ── hydrateSubagentRecords helper (U3) ──────────────────────────────────────

describe('hydrateSubagentRecords helper', () => {
  let manager: SubagentManager;
  const sid = 'sess-hydrate-helper';

  beforeEach(() => {
    manager = new SubagentManager();
    sessionManagerHolder.current = null;
  });

  afterEach(() => {
    sessionManagerHolder.current = null;
  });

  function makeCtx(agents: Map<string, Agent>, overrides: Partial<ToolExecutionContext> = {}) {
    return {
      cwd: '/tmp/turn',
      sessionId: sid,
      projectRuntime: {
        projectDir: '/tmp',
        config: defaults(),
        agents,
        skills: new Map(),
        personalities: new Map(),
      },
      ...overrides,
    } as unknown as ToolExecutionContext;
  }

  /** Round-trip a runtime record through the storage dict to mimic a loaded row. */
  function storedDomain(record: SubagentRecord) {
    return subagentRecordFromStorageDict(subagentRecordToStorageDict(runtimeToDomain(record)));
  }

  /** Build a durable domain record (in a side manager) for the helper to load. */
  function storedRecord(label: string, agent: Agent) {
    const source = new SubagentManager();
    const original = source.spawn(label, 'task text', agent, { sessionId: sid });
    source.markCompleted(original.id, 'stored result');
    return { id: original.id, domain: storedDomain(original) };
  }

  function setSession(
    subagentChains: unknown[],
    opts: { cwd?: string | null; sync?: FakeSessionManager['syncSubagentRecords'] } = {},
  ) {
    const session = { id: sid, cwd: opts.cwd ?? '/tmp/session', subagentChains };
    sessionManagerHolder.current = {
      getSession: (id: string) => (id === sid ? session : null),
      getActive: () => null,
      ...(opts.sync ? { syncSubagentRecords: opts.sync } : {}),
    };
    return session;
  }

  it('skips live full records and leaves storage-missing ids unreported', async () => {
    const agents = makeAgentMap();
    const live = manager.spawn('live', 'x', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(live.id, 'live');
    setSession([]); // durable storage has nothing

    const result = await hydrateSubagentRecords(manager, sid, [live.id, 'ghost-id'], makeCtx(agents));

    // Live full record is skipped; ghost-id is absent from storage, so it is
    // neither hydrated nor agentMissing — the caller reports it as not found.
    expect(result).toEqual({ hydrated: [], agentMissing: [] });
    expect(manager.getRecord(live.id)?.result).toBe('live');
  });

  it('hydrates a persisted-only id from session.subagentChains', async () => {
    const agents = makeAgentMap();
    const { id, domain } = storedRecord('persisted', codeReviewerAgent);
    setSession([domain]);
    expect(manager.getRecord(id)).toBeUndefined();

    const result = await hydrateSubagentRecords(
      manager,
      sid,
      [id],
      makeCtx(agents, { windowId: 'win-9', cwd: '/tmp/turn' }),
    );

    expect(result).toEqual({ hydrated: [id], agentMissing: [] });
    const record = manager.getRecord(id)!;
    expect(record._evicted).toBe(false);
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.label).toBe('persisted');
    expect(record.result).toBe('stored result');
    expect(record.chain?.messages.length).toBeGreaterThan(0);
    // session.cwd wins over the turn cwd; windowId comes from the turn context.
    expect(record.cwd).toBe('/tmp/session');
    expect(record.windowId).toBe('win-9');
  });

  it('hydrates an evicted in-session summary back into a full record', async () => {
    const agents = makeAgentMap();
    const record = manager.spawn('evicted', 'x', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first');
    const domain = storedDomain(record);
    const messageCount = domain.chain.messages.length;
    manager.confirmRecordsPersisted(sid, [record.id]);
    expect(manager.getRecord(record.id)?._evicted).toBe(true);
    setSession([domain]);

    const result = await hydrateSubagentRecords(manager, sid, [record.id], makeCtx(agents));

    expect(result.hydrated).toEqual([record.id]);
    const restored = manager.getRecord(record.id)!;
    expect(restored._evicted).toBe(false);
    expect(restored.chain?.messages.length).toBe(messageCount);
  });

  it('reports agentMissing when the stored agent_type is not in the registry', async () => {
    // Registry WITHOUT code-reviewer, which the stored record references.
    const agents = new Map<string, Agent>();
    agents.set(fileExplorerAgent.name, fileExplorerAgent);
    const { id, domain } = storedRecord('orphan', codeReviewerAgent);
    setSession([domain]);

    const result = await hydrateSubagentRecords(manager, sid, [id], makeCtx(agents));

    expect(result).toEqual({ hydrated: [], agentMissing: [id] });
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it('returns empty when the session is not found', async () => {
    sessionManagerHolder.current = {
      getSession: () => null,
      getActive: () => null,
    };
    const result = await hydrateSubagentRecords(
      manager,
      sid,
      ['any-id'],
      makeCtx(makeAgentMap()),
    );
    expect(result).toEqual({ hydrated: [], agentMissing: [] });
  });

  it('resets the revision tracker so a post-hydrate mutation persists again', async () => {
    const agents = makeAgentMap();
    // A live record persisted once (establishes a lastPersistedRevision entry),
    // then evicted — mirroring a record whose durable row already exists.
    const record = manager.spawn('tracked', 'x', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first');
    const domain = storedDomain(record);

    const synced: Array<{ id: string }> = [];
    setSession([domain], {
      sync: (_sessionId, records) => {
        synced.push(...(records as Array<{ id: string }>));
        return { session: { id: sid }, bytes: 1 };
      },
    });

    // First checkpoint writes the full terminal record, then evicts it.
    persistSubagentChains(manager, sid);
    const writesBefore = synced.filter((r) => r.id === record.id).length;
    expect(writesBefore).toBe(1);
    expect(manager.getRecord(record.id)?._evicted).toBe(true);

    // Hydrate via the helper: materializes the record AND forgets the tracker entry.
    const result = await hydrateSubagentRecords(manager, sid, [record.id], makeCtx(agents));
    expect(result.hydrated).toEqual([record.id]);
    expect(manager.getRecord(record.id)?._evicted).toBe(false);

    // A dirtying mutation restarts the counter at 1; without the tracker reset
    // the revision gate (1 <= 1) would skip this record forever.
    manager.getRecord(record.id)!.persistRevision += 1;
    persistSubagentChains(manager, sid);

    const writesAfter = synced.filter((r) => r.id === record.id).length;
    expect(writesAfter).toBe(writesBefore + 1);
  });

  it('forgetSubagentPersistedRevision is a safe no-op for untracked sessions/ids', () => {
    expect(() => forgetSubagentPersistedRevision('no-such-session', 'no-such-id')).not.toThrow();
  });
});

// ── follow_up_subagent (U6) ──────────────────────────────────────────────────

const buildFollowUpTool = (...args: Parameters<typeof buildFollowUpToolRaw>) =>
  canonicalizeTool(buildFollowUpToolRaw(...args));

describe('follow_up_subagent', () => {
  let manager: SubagentManager;
  let agents: Map<string, Agent>;
  const sid = 'sess-follow-up';

  beforeEach(() => {
    manager = new SubagentManager();
    agents = makeAgentMap();
    sessionManagerHolder.current = null;
  });

  afterEach(() => {
    sessionManagerHolder.current = null;
    configOverride.current = null;
  });

  function makeCtx(ctxAgents: Map<string, Agent>) {
    return {
      cwd: '/tmp/turn',
      sessionId: sid,
      projectRuntime: {
        projectDir: '/tmp',
        config: defaults(),
        agents: ctxAgents,
        skills: new Map(),
        personalities: new Map(),
      },
    } as unknown as ToolExecutionContext;
  }

  /** Round-trip a runtime record through the storage dict to mimic a loaded row. */
  function storedDomain(record: SubagentRecord) {
    return subagentRecordFromStorageDict(subagentRecordToStorageDict(runtimeToDomain(record)));
  }

  function setSession(subagentChains: unknown[]) {
    const session = { id: sid, cwd: '/tmp/session', subagentChains };
    sessionManagerHolder.current = {
      getSession: (id: string) => (id === sid ? session : null),
      getActive: () => null,
    };
    return session;
  }

  it('should have correct tool definition', () => {
    const { definition } = buildFollowUpTool(manager);
    expect(definition.name).toBe('follow_up_subagent');
    expect(definition.category).toBe('subagent');
    expect(definition.riskClass).toBe(RiskClass.DELEGATION);
    expect(definition.description).toContain('wait_for_subagent');
    expect(definition.inputSchema.safeParse({ subagent_id: 'x' }).success).toBe(false);
    expect(definition.inputSchema.safeParse({ subagent_id: 'x', input: 'y' }).success).toBe(true);
  });

  it('resumes a terminal record and mirrors the delegate result envelope', async () => {
    const { handler } = buildFollowUpTool(manager);
    const record = manager.spawn('review auth', 'original task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first result');

    const result = (await handler(
      { subagent_id: record.id, input: 'please also fix issue 2' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    const data = result.canonical.data as GenericToolResultData;
    const value = data.value as { id: string; name: string; status: string; queue_position?: number };
    expect(value.id).toBe(record.id);
    expect(value.name).toBe('review auth');
    // No runner is configured, so an admitted resume stays PENDING.
    expect(value.status).toBe(SubagentState.PENDING);
    expect(value.queue_position).toBeUndefined();
    expect(result.agentProjection.content).toContain(record.id);

    // R5: the chain is reopened with the follow-up message appended.
    const resumed = manager.getRecord(record.id)!;
    expect(resumed.state).toBe(SubagentState.PENDING);
    expect(resumed.runCount).toBe(2);
    const messages = resumed.chain?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[messages.length - 1].role).toBe('user');
    expect(messages[messages.length - 1].content).toBe('please also fix issue 2');
  });

  it('hydrates a persisted-only record (app restart) then resumes it', async () => {
    const { handler } = buildFollowUpTool(manager);
    // Build a durable record in a side manager, mimicking a pre-restart row.
    const source = new SubagentManager();
    const original = source.spawn('persisted', 'task text', codeReviewerAgent, { sessionId: sid });
    source.markCompleted(original.id, 'stored result');
    setSession([storedDomain(original)]);
    expect(manager.getRecord(original.id)).toBeUndefined();

    const result = (await handler(
      { subagent_id: original.id, input: 'continue where you left off' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    const resumed = manager.getRecord(original.id)!;
    expect(resumed._evicted).toBe(false);
    expect(resumed.state).toBe(SubagentState.PENDING);
    expect(resumed.runCount).toBe(2);
    const messages = resumed.chain?.messages ?? [];
    expect(messages[messages.length - 1].content).toBe('continue where you left off');
  });

  it('hydrates an evicted in-session summary then resumes it', async () => {
    const { handler } = buildFollowUpTool(manager);
    const record = manager.spawn('evicted', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first');
    const domain = storedDomain(record);
    manager.confirmRecordsPersisted(sid, [record.id]);
    expect(manager.getRecord(record.id)?._evicted).toBe(true);
    setSession([domain]);

    const result = (await handler(
      { subagent_id: record.id, input: 'try again' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    const restored = manager.getRecord(record.id)!;
    expect(restored._evicted).toBe(false);
    expect(restored.state).toBe(SubagentState.PENDING);
    expect(restored.runCount).toBe(2);
  });

  it('parks the resumed run in the FIFO queue when admission is full', async () => {
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, max_active_per_session: 1, max_queued: 2 },
    };
    const { handler } = buildFollowUpTool(manager);
    // Terminal target first (while the slot is free), then occupy the slot.
    const target = manager.spawn('target', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(target.id, 'done');
    const blocker = manager.spawn('blocker', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markRunning(blocker.id);

    const result = (await handler(
      { subagent_id: target.id, input: 'one more thing' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('complete');
    const data = result.canonical.data as GenericToolResultData;
    const value = data.value as { status: string; queue_position: number };
    expect(value.status).toBe(SubagentState.QUEUED);
    expect(value.queue_position).toBe(1);
    expect(result.agentProjection.content).toContain('queued');
    expect(manager.getRecord(target.id)?.state).toBe(SubagentState.QUEUED);
  });

  it('rejects a closed subagent with a named error', async () => {
    const { handler } = buildFollowUpTool(manager);
    const record = manager.spawn('closed one', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');
    manager.getRecord(record.id)!.closed = true;

    const result = (await handler(
      { subagent_id: record.id, input: 'more' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('cannot follow up on a closed subagent');
    // The terminal record is left unmutated.
    expect(manager.getRecord(record.id)?.runCount).toBe(1);
  });

  it('rejects a running subagent with wait/interrupt guidance', async () => {
    const { handler } = buildFollowUpTool(manager);
    const record = manager.spawn('running one', 'task', codeReviewerAgent, { sessionId: sid });
    manager.markRunning(record.id);

    const result = (await handler(
      { subagent_id: record.id, input: 'more' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('not terminal');
    expect(result.agentProjection.content).toContain('wait_for_subagent');
    expect(result.agentProjection.content).toContain('interrupt_subagents');
  });

  it('reports an unknown id as not found', async () => {
    const { handler } = buildFollowUpTool(manager);
    setSession([]); // durable storage has nothing

    const result = (await handler(
      { subagent_id: 'ghost-id', input: 'more' },
      makeCtx(agents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('ghost-id');
    expect(result.agentProjection.content).toContain('not found');
  });

  it('reports a subagent owned by another session as not found and leaves it untouched', async () => {
    const { handler } = buildFollowUpTool(manager);
    const peer = manager.spawn('peer', 'private task', codeReviewerAgent, { sessionId: 'sess-other' });
    manager.markCompleted(peer.id, 'private result');

    const result = (await handler(
      { subagent_id: peer.id, input: 'more' },
      makeCtx(agents), // sessionId: sid ≠ sess-other
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('not found');
    expect(manager.getRecord(peer.id)?.state).toBe(SubagentState.COMPLETED);
    expect(manager.getRecord(peer.id)?.runCount).toBe(1);
  });

  it('reports a named error when the stored agent definition is missing', async () => {
    const { handler } = buildFollowUpTool(manager);
    // Durable record references code-reviewer; the turn registry lacks it.
    const source = new SubagentManager();
    const original = source.spawn('orphan', 'task text', codeReviewerAgent, { sessionId: sid });
    source.markCompleted(original.id, 'stored result');
    setSession([storedDomain(original)]);
    const registryAgents = new Map<string, Agent>();
    registryAgents.set(fileExplorerAgent.name, fileExplorerAgent);

    const result = (await handler(
      { subagent_id: original.id, input: 'more' },
      makeCtx(registryAgents),
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('error');
    expect(result.agentProjection.content).toContain('no longer available');
    expect(result.agentProjection.content).toContain('cannot resume');
    expect(manager.getRecord(original.id)).toBeUndefined();
  });

  it('returns early without a session context', async () => {
    const { handler } = buildFollowUpTool(manager);

    const result = (await handler(
      { subagent_id: 'any-id', input: 'more' },
      { cwd: '/tmp' },
    )) as ToolExecutionResult;

    expect(result.canonical.status).toBe('empty');
    expect(result.agentProjection.content).toContain('No session context');
  });
});
