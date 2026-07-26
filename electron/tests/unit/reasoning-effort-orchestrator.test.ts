/**
 * U4 — reasoning effort orchestration wiring.
 *
 * Covers the resolved-effort → driver-mapping → streamText chain for both the
 * main agent and subagent turns:
 * - orchestrator.ts forwards `providerOptions` to `streamText`
 * - ProviderRuntime.resolveExecution exposes a driver-bound buildReasoningOptions
 * - main agent cascade (session override → connection default → omit)
 * - subagent cascade (agent field → tier config → connection default → omit)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type {
  ProviderConnection,
  ProviderDefinition,
} from '../../src/shared/types/provider';
import type { ProviderDriver } from '../../src/main/providers/drivers/types';
import type { Agent } from '../../src/shared/types/agent';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import type { StreamChatParams } from '../../src/main/llm/orchestrator';
import { ToolRegistry } from '../../src/main/tools/registry';
import { defaults } from '../../src/main/config/schema';

// ---------------------------------------------------------------------------
// AI SDK mock (streamChat imports `ai` via importESM)
// ---------------------------------------------------------------------------

const aiSdkMocks = vi.hoisted(() => {
  const streamText = vi.fn();
  const wrapLanguageModel = vi.fn(({ model }: { model: unknown }) => model);
  const isStepCount = vi.fn((count: number) => ({ type: 'step-count' as const, count }));
  return { streamText, wrapLanguageModel, isStepCount };
});

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async (specifier: string) => {
    if (specifier === 'ai') {
      return {
        streamText: aiSdkMocks.streamText,
        wrapLanguageModel: aiSdkMocks.wrapLanguageModel,
        isStepCount: aiSdkMocks.isStepCount,
      };
    }
    throw new Error(`Unexpected importESM specifier in test: ${specifier}`);
  }),
}));

// ---------------------------------------------------------------------------
// Subagent-runner infrastructure mocks (orchestrator + reasoning-effort stay real)
// ---------------------------------------------------------------------------

const infra = vi.hoisted(() => ({
  getConfig: vi.fn(() => ({ default_project_dir: null })),
  getSessionManager: vi.fn(() => ({
    getSession: vi.fn(() => ({ cwd: null })),
    getActive: vi.fn(() => ({ cwd: null })),
  })),
  runtimeRegistry: { get: vi.fn() },
  providerRuntime: { resolveExecution: vi.fn() },
  accountingStore: {},
  buildSystemPromptContext: vi.fn(async ({ cwd }: { cwd: string }) => ({ cwd })),
  acquireProjectMCPManager: vi.fn(() => ({ getTools: () => [] })),
  releaseProjectMCPManager: vi.fn(),
  getBuiltinToolRegistryForRuntime: vi.fn(() => ({ filter: vi.fn(() => []) })),
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return { ...actual, getConfig: infra.getConfig };
});
vi.mock('../../src/main/ipc/session', () => ({ getSessionManager: infra.getSessionManager }));
vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => infra.runtimeRegistry,
}));
vi.mock('../../src/main/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/providers')>();
  return { ...actual, getProviderRuntime: () => infra.providerRuntime };
});
vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => infra.accountingStore,
}));
vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: infra.buildSystemPromptContext,
}));
vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: infra.acquireProjectMCPManager,
  releaseProjectMCPManager: infra.releaseProjectMCPManager,
}));
vi.mock('../../src/main/tools', () => ({
  getBuiltinToolRegistryForRuntime: infra.getBuiltinToolRegistryForRuntime,
  getSkillsRegistry: () => new Map(),
}));

import { streamChat } from '../../src/main/llm/orchestrator';
import { ProviderRuntime } from '../../src/main/providers';
import { ProviderDriverRegistry } from '../../src/main/providers/drivers/registry';
import { resolveMainAgentEffort } from '../../src/main/llm/reasoning-effort';
import { createSubagentStreamRunner } from '../../src/main/agents/subagent-runner';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const MODEL_ID = 'gpt-reasoning';

function fakeModelInstance(): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  } as unknown as LanguageModelV4;
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}

function setupStreamText(): void {
  aiSdkMocks.streamText.mockImplementation(() => ({
    fullStream: emptyAsyncIterable(),
    textStream: emptyAsyncIterable(),
    finishReason: Promise.resolve('stop'),
  }));
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

function lastStreamTextProviderOptions(): unknown {
  return aiSdkMocks.streamText.mock.calls[0]?.[0]?.providerOptions;
}

function makeStreamChatParams(
  overrides: Partial<StreamChatParams> = {},
): StreamChatParams {
  return {
    messages: overrides.messages ?? [],
    agent: overrides.agent ?? {
      name: 'general',
      type: 'internal',
      tier: 'bloom',
      description: 'General agent',
      system_prompt: 'You are a helpful assistant.',
      allowed_tools: [],
      allowed_skills: [],
    },
    systemPrompt: overrides.systemPrompt ?? 'You are a helpful assistant.',
    context: overrides.context ?? { cwd: '/tmp/orchid-reasoning-test' },
    config: overrides.config ?? defaults(),
    registry: overrides.registry ?? new ToolRegistry(),
    mcpManager: overrides.mcpManager ?? null,
    modelInstance: overrides.modelInstance ?? fakeModelInstance(),
    providerOptions: overrides.providerOptions,
  };
}

function makeConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: CONNECTION_ID,
    providerId: 'openai',
    name: 'Work',
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
    modelIds: [MODEL_ID],
    health: 'ready',
    ...overrides,
  };
}

function makeProvider(reasoning: boolean): ProviderDefinition {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomModels: false,
    models: [{
      id: MODEL_ID,
      displayName: 'GPT Reasoning',
      protocol: 'openai-compatible',
      capabilities: {
        inputModalities: ['text'],
        outputModalities: ['text'],
        tools: true,
        reasoning,
      },
    }],
  };
}

function makeDriver(
  buildReasoningOptions?: ProviderDriver['buildReasoningOptions'],
): ProviderDriver {
  return {
    id: 'openai',
    supportedAuthMethods: ['api-key'],
    supportedProtocols: ['openai-compatible'],
    allowsCustomEndpoint: false,
    origin: 'https://api.openai.com/v1',
    createLanguageModel: vi.fn(async () => fakeModelInstance()),
    ...(buildReasoningOptions ? { buildReasoningOptions } : {}),
  };
}

function makeRuntime(connection: ProviderConnection, driver: ProviderDriver): ProviderRuntime {
  return new ProviderRuntime({
    catalog: { getProviderDefinitions: () => [makeProvider(true)] },
    connections: { list: async () => [connection] },
    vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'test-key' })) },
    registry: new ProviderDriverRegistry([driver]),
  });
}

/** OpenAI-shaped effort mapping used to stand in for a reasoning-capable driver. */
function openaiReasoningOptions(
  effort: string | number,
): Record<string, Record<string, unknown>> {
  return typeof effort === 'number'
    ? { openai: { maxReasoningTokens: effort } }
    : { openai: { reasoningEffort: effort } };
}

// ---------------------------------------------------------------------------
// Orchestrator: providerOptions forwarding
// ---------------------------------------------------------------------------

describe('streamChat providerOptions forwarding', () => {
  beforeEach(() => {
    aiSdkMocks.streamText.mockReset();
    setupStreamText();
  });

  it('forwards providerOptions to streamText when provided', async () => {
    const providerOptions = { openai: { reasoningEffort: 'high' } };
    await drain(streamChat(makeStreamChatParams({ providerOptions })));

    expect(aiSdkMocks.streamText).toHaveBeenCalledTimes(1);
    expect(lastStreamTextProviderOptions()).toEqual(providerOptions);
  });

  it('passes undefined providerOptions to streamText when omitted', async () => {
    await drain(streamChat(makeStreamChatParams()));

    expect(aiSdkMocks.streamText).toHaveBeenCalledTimes(1);
    expect(lastStreamTextProviderOptions()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ProviderRuntime: driver-bound buildReasoningOptions
// ---------------------------------------------------------------------------

describe('ProviderRuntime.resolveExecution reasoning binding', () => {
  it('exposes connection, model, and a driver-bound buildReasoningOptions', async () => {
    const connection = makeConnection();
    const buildReasoningOptions = vi.fn(openaiReasoningOptions);
    const runtime = makeRuntime(connection, makeDriver(buildReasoningOptions));

    const execution = await runtime.resolveExecution({
      connectionId: CONNECTION_ID,
      modelId: MODEL_ID,
    });

    expect(execution.connection.id).toBe(CONNECTION_ID);
    expect(execution.model.capabilities?.reasoning).toBe(true);
    expect(execution.buildReasoningOptions?.('high')).toEqual({
      openai: { reasoningEffort: 'high' },
    });
    expect(buildReasoningOptions).toHaveBeenCalledWith(
      'high',
      expect.objectContaining({ id: MODEL_ID }),
    );
  });

  it('leaves buildReasoningOptions undefined when the driver lacks reasoning support', async () => {
    const runtime = makeRuntime(makeConnection(), makeDriver(undefined));

    const execution = await runtime.resolveExecution({
      connectionId: CONNECTION_ID,
      modelId: MODEL_ID,
    });

    expect(execution.buildReasoningOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Main agent wiring: session override → driver mapping → streamText
// ---------------------------------------------------------------------------

describe('main agent effort wiring', () => {
  beforeEach(() => {
    aiSdkMocks.streamText.mockReset();
    setupStreamText();
  });

  async function runMainAgentTurn(input: {
    reasoningEffortOverride: string | number | null;
    modelReasoning: boolean;
    reasoningConfig?: ProviderConnection['reasoningConfig'];
  }): Promise<unknown> {
    const connection = makeConnection({ reasoningConfig: input.reasoningConfig });
    const driver = makeDriver(openaiReasoningOptions);
    const runtime = new ProviderRuntime({
      catalog: { getProviderDefinitions: () => [makeProvider(input.modelReasoning)] },
      connections: { list: async () => [connection] },
      vault: { readSecret: vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'test-key' })) },
      registry: new ProviderDriverRegistry([driver]),
    });
    const selection = { connectionId: CONNECTION_ID, modelId: MODEL_ID };
    const execution = await runtime.resolveExecution(selection);

    const effort = resolveMainAgentEffort(
      { reasoningEffortOverride: input.reasoningEffortOverride },
      execution.connection,
      selection.modelId,
      execution.model.capabilities?.reasoning === true,
    );
    const providerOptions =
      effort === undefined ? undefined : execution.buildReasoningOptions?.(effort);

    await drain(streamChat(makeStreamChatParams({
      providerOptions,
      modelInstance: execution.modelInstance,
    })));
    return lastStreamTextProviderOptions();
  }

  it('maps a session override of "high" into openai providerOptions', async () => {
    await expect(runMainAgentTurn({ reasoningEffortOverride: 'high', modelReasoning: true }))
      .resolves.toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('maps a numeric session override into a token budget (AE2)', async () => {
    await expect(runMainAgentTurn({ reasoningEffortOverride: 4096, modelReasoning: true }))
      .resolves.toEqual({ openai: { maxReasoningTokens: 4096 } });
  });

  it('falls back to the connection default when no session override is set', async () => {
    await expect(runMainAgentTurn({
      reasoningEffortOverride: null,
      modelReasoning: true,
      reasoningConfig: { [MODEL_ID]: { levels: ['low', 'high'], default: 'low' } },
    })).resolves.toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('sends no providerOptions when no effort is configured', async () => {
    await expect(runMainAgentTurn({ reasoningEffortOverride: null, modelReasoning: true }))
      .resolves.toBeUndefined();
  });

  it('sends no providerOptions for a model without reasoning capability', async () => {
    await expect(runMainAgentTurn({ reasoningEffortOverride: 'high', modelReasoning: false }))
      .resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Subagent wiring: tier config → driver mapping → streamText
// ---------------------------------------------------------------------------

describe('subagent effort wiring', () => {
  const agent: Agent = {
    name: 'worker',
    type: 'subagent',
    tier: 'bloom',
    description: 'Test worker',
    system_prompt: 'Test prompt',
    allowed_tools: ['*'],
    allowed_skills: [],
  };
  const selection = { connectionId: CONNECTION_ID, modelId: MODEL_ID };

  function subagentRuntime(
    tierReasoningEffort: Record<string, string | number | null>,
    projectDir: string,
  ): ProjectRuntime {
    return {
      projectDir,
      config: { ...defaults(), tier_reasoning_effort: tierReasoningEffort },
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
    } as unknown as ProjectRuntime;
  }

  function mockExecution(input: {
    modelReasoning: boolean;
    buildReasoningOptions?: (effort: string | number) => Record<string, Record<string, unknown>> | undefined;
  }): void {
    infra.providerRuntime.resolveExecution.mockResolvedValue({
      modelInstance: fakeModelInstance(),
      snapshot: {
        providerId: 'openai',
        providerDisplayName: 'OpenAI',
        connectionId: CONNECTION_ID,
        connectionName: 'Work',
        modelId: MODEL_ID,
        protocol: 'openai-compatible',
        modelSource: 'catalog',
        catalogVersion: 1,
        catalogSource: 'bundled',
        catalogObservedAt: null,
        pricing: null,
        fieldProvenance: {},
        statusObservation: null,
      },
      connection: makeConnection(),
      model: {
        id: MODEL_ID,
        displayName: 'GPT Reasoning',
        protocol: 'openai-compatible',
        source: 'catalog',
        capabilities: {
          inputModalities: ['text'],
          outputModalities: ['text'],
          tools: true,
          reasoning: input.modelReasoning,
        },
      },
      buildReasoningOptions: input.buildReasoningOptions,
    });
  }

  async function runSubagent(
    tierEffort: Record<string, string | number | null>,
    agentOverride: Partial<Agent> = {},
  ): Promise<unknown> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-reasoning-subagent-'));
    try {
      await drain(createSubagentStreamRunner()({
        task: 'Inspect the project',
        agent: { ...agent, ...agentOverride },
        selection,
        abortSignal: new AbortController().signal,
        agentScopeId: 'scope-reasoning',
        sessionId: 'session-reasoning',
        cwd: workspace,
        projectRuntime: subagentRuntime(tierEffort, workspace),
      }));
      return lastStreamTextProviderOptions();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    aiSdkMocks.streamText.mockReset();
    setupStreamText();
    infra.providerRuntime.resolveExecution.mockReset();
  });

  it('maps tier effort "low" into providerOptions (AE3)', async () => {
    mockExecution({ modelReasoning: true, buildReasoningOptions: openaiReasoningOptions });

    await expect(runSubagent({ bloom: 'low' }))
      .resolves.toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('prefers the agent definition reasoning_effort over tier config (AE4)', async () => {
    mockExecution({ modelReasoning: true, buildReasoningOptions: openaiReasoningOptions });

    await expect(runSubagent({ bloom: 'low' }, { reasoning_effort: 'high' }))
      .resolves.toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('sends no providerOptions for a model without reasoning capability', async () => {
    mockExecution({ modelReasoning: false, buildReasoningOptions: openaiReasoningOptions });

    await expect(runSubagent({ bloom: 'low' })).resolves.toBeUndefined();
  });

  it('sends no providerOptions when the driver cannot map effort', async () => {
    mockExecution({ modelReasoning: true, buildReasoningOptions: () => undefined });

    await expect(runSubagent({ bloom: 'low' })).resolves.toBeUndefined();
  });
});
