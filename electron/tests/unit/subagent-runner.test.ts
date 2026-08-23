import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/shared/types/agent';
import type { Message } from '../../src/shared/types/message';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import { NEURALWATT_TIER_MECHANISM } from '../../src/main/providers/drivers/neuralwatt';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ default_project_dir: null })),
  getSessionManager: vi.fn(() => ({
    getSession: vi.fn(() => ({ cwd: null })),
    getActive: vi.fn(() => ({ cwd: null })),
  })),
  runtimeRegistry: { get: vi.fn() },
  modelInstance: { provider: 'trusted-test-driver' },
  providerRuntime: {
    resolveLanguageModel: vi.fn(async () => ({ provider: 'trusted-test-driver' })),
    resolveTierContext: vi.fn(async () => ({ connection: {}, tierMechanism: undefined })),
    resolveExecution: vi.fn(async () => ({
      modelInstance: { provider: 'trusted-test-driver' },
      connection: {},
      model: { id: 'vendor/path/model', capabilities: { reasoning: false } },
      snapshot: {
        providerId: 'openai',
        providerDisplayName: 'OpenAI',
        connectionId: '11111111-1111-4111-8111-111111111111',
        connectionName: 'Work',
        modelId: 'vendor/path/model',
        protocol: 'openai-compatible',
        modelSource: 'catalog',
        catalogVersion: 1,
        catalogSource: 'bundled',
        catalogObservedAt: null,
        pricing: null,
        fieldProvenance: {},
        statusObservation: null,
      },
    })),
  },
  accountingStore: {},
  streamChat: vi.fn(async function* () {
    yield { type: 'content', text: 'delegated result' };
    yield { type: 'finish', finishReason: 'stop' };
  }),
  buildSystemPromptContext: vi.fn(async ({ cwd }: { cwd: string }) => ({
    cwd,
    directoryTree: '',
    subagents: [],
    todos: [],
    backgroundCommands: [],
  })),
  toolRegistry: {
    filter: vi.fn((patterns: string[]) => {
      if (patterns.length === 0) return [];
      return [
        { definition: { name: 'read_file' } },
        { definition: { name: 'delegate_to_subagent' } },
        { definition: { name: 'wait_for_subagent' } },
        { definition: { name: 'interrupt_subagents' } },
        { definition: { name: 'answer_subagent' } },
      ];
    }),
  },
  mcpManager: {},
  acquireProjectMCPManager: vi.fn(),
  releaseProjectMCPManager: vi.fn(),
  getBuiltinToolRegistryForRuntime: vi.fn(),
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return { ...actual, getConfig: mocks.getConfig };
});

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: mocks.getSessionManager,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => mocks.runtimeRegistry,
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => mocks.providerRuntime,
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => mocks.accountingStore,
}));

vi.mock('../../src/main/providers/accounting/subagent-attribution-store', () => ({
  getSubagentAttributionStore: () => ({
    insert: vi.fn(),
    finalize: vi.fn(),
  }),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: mocks.streamChat,
}));

vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: mocks.buildSystemPromptContext,
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: mocks.acquireProjectMCPManager,
  releaseProjectMCPManager: mocks.releaseProjectMCPManager,
}));

vi.mock('../../src/main/tools', () => ({
  getBuiltinToolRegistryForRuntime: mocks.getBuiltinToolRegistryForRuntime,
}));

vi.mock('../../src/main/llm/message-factories', () => ({
  makeUserMessage: (content: string) => ({ role: 'user', content }),
}));

import { createSubagentStreamRunner } from '../../src/main/agents/subagent-runner';
import type {
  SubagentCompactionPauseController,
  SubagentOverflowOutcome,
  SubagentPauseApplyOutcome,
} from '../../src/main/agents/manager';
import {
  clearCompactionPause,
  requestCompactionPause,
  shouldPauseForCompaction,
} from '../../src/main/agents/next-request-stop';

const agent: Agent = {
  name: 'worker',
  type: 'subagent',
  tier: 'bloom',
  description: 'Test worker',
  system_prompt: 'Test prompt',
  allowed_tools: ['*'],
  allowed_skills: [],
};

const selection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/path/model',
};

function runtime(overrides: Partial<Record<string, unknown>> = {}): ProjectRuntime {
  return {
    projectDir: '/tmp/project',
    config: {
      default_model: null,
      tier_models: { bloom: null },
      ...overrides,
    },
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  } as unknown as ProjectRuntime;
}

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('createSubagentStreamRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ default_project_dir: null });
    mocks.acquireProjectMCPManager.mockReturnValue(mocks.mcpManager);
    mocks.getBuiltinToolRegistryForRuntime.mockReturnValue(mocks.toolRegistry);
  });

  it('rejects a missing parent session before resolving a runtime', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-1',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'Missing session',
      detail: expect.stringContaining('explicit parent session id'),
    }]);
    expect(mocks.runtimeRegistry.get).not.toHaveBeenCalled();
  });

  it('rejects a subagent with no frozen or parent workspace', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-2',
      sessionId: 'session-2',
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'No workspace',
      detail: expect.stringContaining('project working directory'),
    }]);
    expect(mocks.runtimeRegistry.get).not.toHaveBeenCalled();
  });

  it('requires a typed selection before attempting driver execution', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection: null,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-3',
      sessionId: 'session-3',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(events).toEqual([{
      type: 'error',
      title: 'Provider connection required',
      detail: expect.stringContaining('Connect a provider'),
    }]);
  });

  it('preserves a slash-containing typed selection through the trusted runtime and stream', async () => {
    const events = await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-4',
      sessionId: 'session-4',
      windowId: 'window-10',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(events).toEqual([
      { type: 'content', text: 'delegated result' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(mocks.providerRuntime.resolveExecution).toHaveBeenCalledWith(selection, {});
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      modelInstance: expect.any(Object),
      sessionId: 'session-4',
      windowId: 'window-10',
      agentScopeId: 'scope-4',
      registry: mocks.toolRegistry,
      mcpManager: mocks.mcpManager,
      agent: expect.objectContaining({ allowed_tools: ['read_file'] }),
    }));
    expect(mocks.acquireProjectMCPManager).toHaveBeenCalledTimes(1);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeRegistry.get).not.toHaveBeenCalled();
  });

  it('releases the MCP lease when turn-local registry construction fails', async () => {
    mocks.getBuiltinToolRegistryForRuntime.mockImplementationOnce(() => {
      throw new Error('registry construction failed');
    });

    await expect(collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-5',
      sessionId: 'session-5',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }))).rejects.toThrow(/registry construction failed/i);

    expect(mocks.acquireProjectMCPManager).toHaveBeenCalledTimes(1);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
  });

  it('treats empty allowed_tools as no tools (does not coerce to *)', async () => {
    const emptyToolsAgent: Agent = {
      ...agent,
      name: 'summarizer',
      allowed_tools: [],
    };

    await collect(createSubagentStreamRunner()({
      task: 'Summarize this',
      agent: emptyToolsAgent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-empty',
      sessionId: 'session-empty',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(mocks.toolRegistry.filter).toHaveBeenCalledWith([]);
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ allowed_tools: [] }),
    }));
  });

  it('removes main-only subagent controls from wildcard child registries', async () => {
    await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-main-only-tools',
      sessionId: 'session-main-only-tools',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(mocks.toolRegistry.filter).toHaveBeenCalledWith(['*']);
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ allowed_tools: ['read_file'] }),
    }));
  });

  it('replays the provided history box to streamChat on a resumed run (U5)', async () => {
    const history = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ] as unknown as Message[];

    await collect(createSubagentStreamRunner()({
      task: 'follow up',
      historyBox: { messages: history },
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-history',
      sessionId: 'session-history',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      messages: history,
    }));
  });

  it('sends only [user(task)] to streamChat on the spawn path (no history)', async () => {
    await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-spawn-history',
      sessionId: 'session-spawn-history',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    const call = mocks.streamChat.mock.calls.at(-1)?.[0];
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Inspect the project',
    }));
  });

  it('resolves a connection tier selection into the variant tier for the subagent execution (R21/R22)', async () => {
    const tieredSnapshot = {
      providerId: 'neuralwatt',
      providerDisplayName: 'Neuralwatt',
      connectionId: '11111111-1111-4111-8111-111111111111',
      connectionName: 'Work',
      modelId: 'vendor/path/model-flex',
      protocol: 'openai-compatible',
      modelSource: 'catalog',
      catalogVersion: 1,
      catalogSource: 'bundled',
      catalogObservedAt: null,
      pricing: null,
      fieldProvenance: {},
      statusObservation: null,
      tier: {
        mechanism: 'model-name-variants' as const,
        requestedTier: 'flex',
        servedModelId: 'vendor/path/model-flex',
        baseModelId: 'vendor/path/model',
      },
    };
    mocks.providerRuntime.resolveTierContext.mockResolvedValueOnce({
      connection: { tierSelections: { 'vendor/path/model': 'flex' } },
      tierMechanism: NEURALWATT_TIER_MECHANISM,
    } as never);
    mocks.providerRuntime.resolveExecution.mockResolvedValueOnce({
      modelInstance: { provider: 'trusted-test-driver' },
      connection: { tierSelections: { 'vendor/path/model': 'flex' } },
      model: { id: 'vendor/path/model-flex', capabilities: { reasoning: false } },
      snapshot: tieredSnapshot,
      tierMechanism: NEURALWATT_TIER_MECHANISM,
    } as never);

    await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-variant-tier',
      sessionId: 'session-variant-tier',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    expect(mocks.providerRuntime.resolveExecution).toHaveBeenCalledWith(selection, { tier: 'flex' });
    // Variant mechanisms ignore the parameter form, so no serviceTier is sent (R19).
    expect(mocks.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: undefined,
      accounting: expect.objectContaining({
        snapshot: expect.objectContaining({ tier: tieredSnapshot.tier }),
      }),
    }));
  });
});

// ── Compaction pause gate (U5: R28 — mid-run pause and resume) ───────────────

describe('createSubagentStreamRunner compaction pause gate (U5)', () => {
  const PAUSE_SESSION = 'session-runner-pause';
  const PAUSE_SCOPE = 'scope-runner-pause';

  let abortController: AbortController;

  /** Manual pause controller bound to the real scoped pause registry. */
  function manualPauseController(opts?: {
    outcome?: SubagentPauseApplyOutcome;
    onApply?: () => void | Promise<void>;
    /**
     * Fired synchronously at applyAtPause entry (before the never-resolving
     * branch) so tests can handshake on "the runner reached the pause apply"
     * deterministically instead of sleeping a fixed delay.
     */
    onApplyEntered?: () => void;
    neverResolves?: boolean;
    rejects?: boolean;
  }): SubagentCompactionPauseController {
    return {
      shouldPause: () => shouldPauseForCompaction(PAUSE_SESSION, PAUSE_SCOPE),
      applyAtPause: async () => {
        opts?.onApplyEntered?.();
        if (opts?.neverResolves) {
          return new Promise<SubagentPauseApplyOutcome>(() => undefined);
        }
        // The production controller always clears the scoped gate when it
        // consumes the pause — mirror that or the restart loop would see the
        // pause still armed and spin.
        clearCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
        await opts?.onApply?.();
        if (opts?.rejects) {
          throw new Error('pause apply exploded');
        }
        return opts?.outcome ?? 'applied';
      },
      discard: () => {
        clearCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
      },
    };
  }

  function boxWith(messages: Message[]): { messages: Message[] } {
    return { messages };
  }

  /**
   * SDK-shaped early-stop segment (the natural-finish guard's input): the
   * multi-step loop evaluates the runner-bound `shouldStopEarly` predicate at
   * a step boundary and, when it returns true, ends the segment with that
   * boundary's own finish reason ('tool-calls') — never a natural model stop.
   */
  function earlyStopSegment(text: string) {
    return async function* (params: {
      shouldStopEarly?: () => boolean;
    }): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text };
      params.shouldStopEarly?.();
      yield { type: 'finish', finishReason: 'tool-calls' };
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ default_project_dir: null });
    mocks.acquireProjectMCPManager.mockReturnValue(mocks.mcpManager);
    mocks.getBuiltinToolRegistryForRuntime.mockReturnValue(mocks.toolRegistry);
    clearCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    abortController = new AbortController();
  });

  it('binds the scoped pause predicate into streamChat only for this run\'s scope', async () => {
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    const controller = manualPauseController({ neverResolves: true });
    // Handshake instead of a fixed sleep: resolve the moment the runner
    // invokes streamChat, so the assertions (and the abort below) land once
    // the segment has deterministically started.
    let signalStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      signalStreamStarted = resolve;
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      signalStreamStarted();
      yield { type: 'content', text: 'delegated result' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const runPromise = collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));
    await streamStarted;
    abortController.abort();
    await runPromise;

    const call = mocks.streamChat.mock.calls.at(-1)![0] as { shouldStopEarly?: () => boolean };
    expect(typeof call.shouldStopEarly).toBe('function');
    expect(call.shouldStopEarly!()).toBe(true);
    // The pause is scoped: the main scope and other subagent scopes stay clear.
    expect(shouldPauseForCompaction(PAUSE_SESSION, 'main')).toBe(false);
    expect(shouldPauseForCompaction(PAUSE_SESSION, 'other-scope')).toBe(false);
    clearCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
  });

  it('does not pass an early-stop predicate when no compaction controller is supplied', async () => {
    await collect(createSubagentStreamRunner()({
      task: 'Inspect the project',
      agent,
      selection,
      abortSignal: new AbortController().signal,
      agentScopeId: 'scope-no-pause',
      sessionId: 'session-no-pause',
      cwd: '/tmp/project',
      projectRuntime: runtime(),
    }));

    const call = mocks.streamChat.mock.calls.at(-1)![0] as { shouldStopEarly?: () => boolean };
    expect(call.shouldStopEarly).toBeUndefined();
  });

  it('restarts the stream with the compacted history after a pause apply (in-run progress preserved)', async () => {
    const taskHead = { id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message;
    const suffix = { id: 'tool-result-1', role: 'tool', content: 'file contents' } as unknown as Message;
    const summary = { id: 'summary-head', role: 'assistant', content: 'SUMMARY', compacted: { mode: 'simple' } } as unknown as Message;
    const box = boxWith([taskHead, { id: 'old-a', role: 'assistant', content: 'stale prefix' } as unknown as Message, suffix]);

    // Pause is already armed when the run starts; the first segment ends at
    // the (mocked) step boundary, the apply swaps the box, the restart reads it.
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    mocks.streamChat.mockImplementationOnce(earlyStopSegment('segment one'));
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'segment two' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const controller = manualPauseController({
      onApply: () => {
        box.messages = [taskHead, summary, suffix];
      },
    });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    // Events from BOTH segments flow through the single runner generator.
    expect(events).toEqual([
      { type: 'content', text: 'segment one' },
      { type: 'finish', finishReason: 'tool-calls' },
      { type: 'content', text: 'segment two' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const restartedMessages = (mocks.streamChat.mock.calls[1]![0] as { messages: Message[] }).messages;
    // Mirror of main's resetTurnForCompactionResume: the restart replays the
    // compacted history with the task head, the summary head, and ALL in-run
    // progress — never the bare task message.
    expect(restartedMessages.map((m) => m.id)).toEqual(['task-head', 'summary-head', 'tool-result-1']);
    // The pause was consumed; no third segment.
    expect(shouldPauseForCompaction(PAUSE_SESSION, PAUSE_SCOPE)).toBe(false);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
  });

  it('restarts with the accumulated history when the apply is skipped (summary unusable)', async () => {
    const box = boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]);
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    mocks.streamChat.mockImplementationOnce(earlyStopSegment('first try'));
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'resumed un-compacted' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const controller = manualPauseController({
      outcome: 'skipped',
      onApply: () => {
        box.messages = [
          { id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message,
          { id: 'accumulated', role: 'assistant', content: 'progress' } as unknown as Message,
        ];
      },
    });

    await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    const resumedMessages = (mocks.streamChat.mock.calls[1]![0] as { messages: Message[] }).messages;
    expect(resumedMessages.map((m) => m.id)).toEqual(['task-head', 'accumulated']);
  });

  it('ends the run after a degraded pause (partial report) without restarting', async () => {
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    mocks.streamChat.mockImplementationOnce(earlyStopSegment('over the window'));
    const box = boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]);
    const controller = manualPauseController({ outcome: 'degraded' });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(events.map((event) => (event as { text?: string }).text ?? event.type)).toEqual([
      'over the window',
      'finish',
    ]);
  });

  it('interrupts cleanly during the pause: abort breaks the wait, no restart, no events after', async () => {
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    mocks.streamChat.mockImplementationOnce(earlyStopSegment('before the pause'));
    const box = boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]);
    // Handshake: resolves at applyAtPause entry, deterministically parking
    // the runner inside the pause before the interrupt below fires.
    let signalApplyEntered!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      signalApplyEntered = resolve;
    });
    const controller = manualPauseController({
      neverResolves: true,
      onApplyEntered: () => signalApplyEntered(),
    });

    const runPromise = collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));
    // Wait until the runner is parked in the pause apply, then interrupt.
    await applyEntered;
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    abortController.abort();
    const events = await runPromise;

    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: 'content', text: 'before the pause' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
  });

  it('aborts during the summarizer wait without consuming a late apply result', async () => {
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    mocks.streamChat.mockImplementationOnce(earlyStopSegment('step output'));
    const box = boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]);
    let resolveApply: ((value: SubagentPauseApplyOutcome) => void) | null = null;
    let applyInvoked = false;
    // Handshake: resolves the moment applyAtPause is entered so the abort
    // below lands while the apply wait is still pending — no fixed sleep.
    let signalApplyEntered!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      signalApplyEntered = resolve;
    });
    const controller: SubagentCompactionPauseController = {
      shouldPause: () => shouldPauseForCompaction(PAUSE_SESSION, PAUSE_SCOPE),
      applyAtPause: () => {
        applyInvoked = true;
        signalApplyEntered();
        // Simulates the summarizer wait: the apply stays pending until the
        // test resolves it — after the abort already fired.
        return new Promise<SubagentPauseApplyOutcome>((resolve) => {
          resolveApply = resolve;
        });
      },
      discard: () => {
        clearCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
      },
    };

    const runPromise = collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));
    await applyEntered;
    expect(applyInvoked).toBe(true);
    abortController.abort();
    await runPromise;
    resolveApply?.('applied');
    // The late apply can only propagate through promise microtasks; one
    // macrotask turn (setImmediate runs after the microtask queue drains)
    // deterministically captures any bogus restart instead of a fixed sleep.
    await new Promise((resolve) => setImmediate(resolve));

    // The aborted restart loop exits before the late apply can trigger a
    // second provider call.
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
  });

  it('does not restart when the pause arms but the stream finishes naturally (no early stop)', async () => {
    // The prepare completes right as the model ends its response: the pause
    // is armed DURING the final (tool-less) step, so the SDK never evaluates
    // the early-stop predicate again and the segment ends with the model's
    // own finish reason. Main's `currentInput && !completed` twin: the run
    // must complete once — the pending dies with discard() at run end.
    const box = boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]);
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'natural end' };
      // The pause arms only after the model's final step — no boundary stop.
      requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
      yield { type: 'finish', finishReason: 'stop' };
    });
    const controller = manualPauseController({
      onApply: () => {
        throw new Error('applyAtPause must not run after a natural finish');
      },
    });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: 'content', text: 'natural end' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    // The pause stays armed for discard() at run end (the manual controller
    // does not auto-clear); nothing consumed it mid-run.
    expect(shouldPauseForCompaction(PAUSE_SESSION, PAUSE_SCOPE)).toBe(true);
    clearCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
  });

  it('restarts the segment (treated as skipped) when applyAtPause rejects', async () => {
    // A non-abort rejection from the pause controller must never silently end
    // the run as completed: it is logged and treated as 'skipped', so the
    // stream restarts with the existing history and completes normally.
    requestCompactionPause(PAUSE_SESSION, PAUSE_SCOPE);
    mocks.streamChat.mockImplementationOnce(earlyStopSegment('before the failing apply'));
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'restarted after rejection' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const box = boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]);
    const controller = manualPauseController({ rejects: true });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: PAUSE_SCOPE,
      sessionId: PAUSE_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: 'content', text: 'before the failing apply' },
      { type: 'finish', finishReason: 'tool-calls' },
      { type: 'content', text: 'restarted after rejection' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const restartedMessages = (mocks.streamChat.mock.calls[1]![0] as { messages: Message[] }).messages;
    expect(restartedMessages.map((m) => m.id)).toEqual(['task-head']);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
  });
});

// ── Overflow retry (U6: R30 — R29 fire point 3) ──────────────────────────────

describe('createSubagentStreamRunner overflow retry (U6)', () => {
  const OVERFLOW_SESSION = 'session-runner-overflow';
  const OVERFLOW_SCOPE = 'scope-runner-overflow';

  let abortController: AbortController;

  /** Provider-shaped context-overflow error, as classifyStreamError yields it. */
  function overflowErrorEvent(): StreamEvent {
    return {
      type: 'error',
      title: 'Provider Error',
      detail:
        "This model's maximum context length is 4096 tokens. However, your messages resulted in 5000 tokens.",
    };
  }

  function boxWith(messages: Message[]): { messages: Message[] } {
    return { messages };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ default_project_dir: null });
    mocks.acquireProjectMCPManager.mockReturnValue(mocks.mcpManager);
    mocks.getBuiltinToolRegistryForRuntime.mockReturnValue(mocks.toolRegistry);
    clearCompactionPause(OVERFLOW_SESSION, OVERFLOW_SCOPE);
    abortController = new AbortController();
  });

  it('intercepts an overflow error, compacts, swaps the box, and retries the stream once', async () => {
    const taskHead = { id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message;
    const summary = { id: 'summary-head', role: 'assistant', content: 'SUMMARY', compacted: { mode: 'simple' } } as unknown as Message;
    const box = boxWith([
      taskHead,
      { id: 'bulky-prefix', role: 'assistant', content: 'x'.repeat(5000) } as unknown as Message,
    ]);
    const compactForOverflow = vi.fn(async () => {
      box.messages = [taskHead, summary];
      return 'applied' as SubagentOverflowOutcome;
    });
    const controller: SubagentCompactionPauseController = {
      shouldPause: () => false,
      applyAtPause: async () => 'skipped',
      compactForOverflow,
      discard: () => undefined,
    };
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield overflowErrorEvent();
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'recovered after compaction' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: box,
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: OVERFLOW_SCOPE,
      sessionId: OVERFLOW_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(compactForOverflow).toHaveBeenCalledTimes(1);
    expect(compactForOverflow).toHaveBeenCalledWith({ alreadyRetried: false });
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    // The dead segment's error event never reaches the run loop; the retry's
    // events flow through the single runner generator.
    expect(events).toEqual([
      { type: 'content', text: 'recovered after compaction' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    // The retry replays the history the compaction swapped into the box.
    const retriedMessages = (mocks.streamChat.mock.calls[1]![0] as { messages: Message[] }).messages;
    expect(retriedMessages.map((m) => m.id)).toEqual(['task-head', 'summary-head']);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
  });

  it('ends the run after the second overflow (guard: exactly one compaction-retry per run)', async () => {
    const outcomes: SubagentOverflowOutcome[] = ['applied', 'degraded'];
    const compactForOverflow = vi.fn(async () => outcomes.shift() ?? 'degraded');
    const controller: SubagentCompactionPauseController = {
      shouldPause: () => false,
      applyAtPause: async () => 'skipped',
      compactForOverflow,
      discard: () => undefined,
    };
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'content', text: 'before the overflow' };
      yield overflowErrorEvent();
    });
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield overflowErrorEvent();
    });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]),
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: OVERFLOW_SCOPE,
      sessionId: OVERFLOW_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    // Exactly one compaction-retry: the second overflow is the terminal
    // (alreadyRetried) call and degrades instead of restarting.
    expect(compactForOverflow).toHaveBeenCalledTimes(2);
    expect(compactForOverflow).toHaveBeenNthCalledWith(1, { alreadyRetried: false });
    expect(compactForOverflow).toHaveBeenNthCalledWith(2, { alreadyRetried: true });
    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    // 'degraded' ends the run with the partial report on record.result — no
    // error event ever leaks to the run loop.
    expect(events).toEqual([{ type: 'content', text: 'before the overflow' }]);
  });

  it('aborts cleanly when interrupted during the overflow compaction (no retry, no leaked events)', async () => {
    let resolveCompact: ((value: SubagentOverflowOutcome) => void) | null = null;
    let compactInvoked = false;
    // Handshake: resolves the moment compactForOverflow is entered so the
    // abort below lands while the compaction wait is pending — no fixed sleep.
    let signalCompactEntered!: () => void;
    const compactEntered = new Promise<void>((resolve) => {
      signalCompactEntered = resolve;
    });
    const controller: SubagentCompactionPauseController = {
      shouldPause: () => false,
      applyAtPause: async () => 'skipped',
      compactForOverflow: () => {
        compactInvoked = true;
        signalCompactEntered();
        // Simulates the summarizer wait: the compaction stays pending until
        // the test resolves it — after the abort already fired.
        return new Promise<SubagentOverflowOutcome>((resolve) => {
          resolveCompact = resolve;
        });
      },
      discard: () => undefined,
    };
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield overflowErrorEvent();
    });

    const runPromise = collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]),
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: OVERFLOW_SCOPE,
      sessionId: OVERFLOW_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));
    await compactEntered;
    expect(compactInvoked).toBe(true);
    abortController.abort();
    const events = await runPromise;
    resolveCompact?.('applied');
    // The late compaction outcome can only propagate through promise
    // microtasks; one macrotask turn deterministically captures any bogus
    // second provider call instead of a fixed sleep.
    await new Promise((resolve) => setImmediate(resolve));

    // Interrupted retry = clean abort: no leaked error event, no second
    // provider call from the late compaction result.
    expect(events).toEqual([]);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(mocks.releaseProjectMCPManager).toHaveBeenCalledTimes(1);
  });

  it('propagates the overflow error unchanged when compaction is unavailable', async () => {
    const compactForOverflow = vi.fn(async () => 'unavailable' as SubagentOverflowOutcome);
    const controller: SubagentCompactionPauseController = {
      shouldPause: () => false,
      applyAtPause: async () => 'skipped',
      compactForOverflow,
      discard: () => undefined,
    };
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield overflowErrorEvent();
    });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]),
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: OVERFLOW_SCOPE,
      sessionId: OVERFLOW_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(compactForOverflow).toHaveBeenCalledTimes(1);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(events).toEqual([overflowErrorEvent()]);
  });

  it('does not route non-overflow stream errors through the overflow recovery', async () => {
    const compactForOverflow = vi.fn(async () => 'applied' as SubagentOverflowOutcome);
    const controller: SubagentCompactionPauseController = {
      shouldPause: () => false,
      applyAtPause: async () => 'skipped',
      compactForOverflow,
      discard: () => undefined,
    };
    const idleTimeout = {
      type: 'error',
      title: 'Stream idle timeout',
      detail: 'No LLM data received for 60s',
    } as const;
    mocks.streamChat.mockImplementationOnce(async function* () {
      yield idleTimeout;
    });

    const events = await collect(createSubagentStreamRunner()({
      task: 'Map the repo',
      historyBox: boxWith([{ id: 'task-head', role: 'user', content: 'Map the repo' } as unknown as Message]),
      agent,
      selection,
      abortSignal: abortController.signal,
      agentScopeId: OVERFLOW_SCOPE,
      sessionId: OVERFLOW_SESSION,
      cwd: '/tmp/project',
      projectRuntime: runtime(),
      compaction: controller,
    }));

    expect(compactForOverflow).not.toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(events).toEqual([idleTimeout]);
  });
});
