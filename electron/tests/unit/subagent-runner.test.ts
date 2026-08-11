import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/shared/types/agent';
import type { Message } from '../../src/shared/types/message';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import type { ProjectRuntime } from '../../src/main/project/runtime';

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

vi.mock('../../src/main/config/loader', () => ({
  getConfig: mocks.getConfig,
}));

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

  it('replays the provided history to streamChat on a resumed run (U5)', async () => {
    const history = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ] as unknown as Message[];

    await collect(createSubagentStreamRunner()({
      task: 'follow up',
      history,
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
});
