/**
 * Unit tests for thinking replay-artifact persistence and policy-driven
 * replay (U3, R15/R16):
 *
 * - Anthropic tool loops replay signed + redacted thinking blocks unmodified.
 * - Responses models replay encrypted reasoning items; chat-completions
 *   protocol omits thinking.
 * - Switching provider/model strips prior artifacts from replay.
 * - Storage round-trips the payload; older messages replay as plain text.
 * - The stream adapter captures signatures/encrypted content/summaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import {
  agentMachine,
} from '../../src/main/agents/xstate/agent-machine';
import type { Message, ThinkingReplayPayload } from '../../src/shared/types/message';
import {
  MessageRole,
  MessageType,
  ThinkingArtifactKind,
  messageFromStorageDict,
  messageToStorageDict,
} from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import type { Agent } from '../../src/shared/types/agent';
import { AgentTier, AgentType } from '../../src/shared/types/agent';
import { toApiMessages, type ThinkingReplayContext } from '../../src/main/llm/history';
import { toModelMessages } from '../../src/main/llm/model-messages';
import { makeThinkingMessage } from '../../src/main/llm/message-factories';
import {
  ANTHROPIC_THINKING_POLICY,
  DEFAULT_THINKING_POLICY,
  OPENAI_OPAQUE_THINKING_POLICY,
  OPENAI_RESPONSES_THINKING_POLICY,
} from '../../src/main/providers/facets/thinking';
import {
  SdkEventAdapter,
  type SdkEventAdapterOptions,
} from '../../src/main/llm/stream/sdk-event-adapter';
import type { StreamEvent } from '../../src/main/llm/stream/events';
import { SubagentRunAssembler } from '../../src/main/agents/subagent-run-assembler';
import { streamChat, type StreamChatParams } from '../../src/main/llm/orchestrator';
import { ToolRegistry } from '../../src/main/tools/registry';
import { defaults } from '../../src/main/config/schema';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    tool_result: null,
    ...overrides,
  };
}

function makeToolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function signedPayload(overrides: Partial<ThinkingReplayPayload> = {}): ThinkingReplayPayload {
  return {
    providerId: 'anthropic',
    modelId: 'claude-1',
    kind: ThinkingArtifactKind.SIGNED,
    blob: 'sig-1',
    displayText: 'Let me analyze',
    ...overrides,
  };
}

function encryptedPayload(overrides: Partial<ThinkingReplayPayload> = {}): ThinkingReplayPayload {
  return {
    providerId: 'openai',
    modelId: 'gpt-5',
    kind: ThinkingArtifactKind.ENCRYPTED,
    blob: 'enc-1',
    displayText: 'summary text',
    itemId: 'rs_1',
    ...overrides,
  };
}

const anthropicReplay: ThinkingReplayContext = {
  policy: ANTHROPIC_THINKING_POLICY,
  selection: { providerId: 'anthropic', modelId: 'claude-1' },
};

const responsesReplay: ThinkingReplayContext = {
  policy: OPENAI_RESPONSES_THINKING_POLICY,
  selection: { providerId: 'openai', modelId: 'gpt-5' },
};

/** An Anthropic extended-thinking tool loop: user → signed thinking → redacted → call → result. */
function anthropicToolLoopMessages(): Message[] {
  return [
    makeMessage({ role: MessageRole.USER, content: 'Fix the bug' }),
    makeMessage({
      type: MessageType.THINKING,
      content: 'Let me analyze',
      thinking: 'Let me analyze',
      thinking_payload: signedPayload(),
    }),
    makeMessage({
      type: MessageType.THINKING,
      content: '',
      thinking: '',
      thinking_payload: signedPayload({
        kind: ThinkingArtifactKind.REDACTED,
        blob: 'redacted-1',
        displayText: null,
      }),
    }),
    makeMessage({
      type: MessageType.TOOL_CALL,
      tool_calls: [makeToolCall('tc-1', 'read')],
      tool_call_id: 'tc-1',
    }),
    makeMessage({
      role: MessageRole.TOOL,
      type: MessageType.TOOL_RESULT,
      content: 'file contents',
      tool_call_id: 'tc-1',
    }),
  ];
}

// ---------------------------------------------------------------------------
// History replay (policy-driven)
// ---------------------------------------------------------------------------

describe('toApiMessages thinking replay', () => {
  it('replays anthropic signed and redacted blocks unmodified through a tool loop', () => {
    const api = toApiMessages(anthropicToolLoopMessages(), anthropicReplay);

    expect(api).toHaveLength(5);
    expect(api[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'Let me analyze',
        providerOptions: { anthropic: { signature: 'sig-1' } },
      }],
    });
    expect(api[2]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: '',
        providerOptions: { anthropic: { redactedData: 'redacted-1' } },
      }],
    });
    // The tool call/result pairing survives the interleaved thinking replay.
    expect(api[3].tool_calls?.map((call) => call.id)).toEqual(['tc-1']);
    expect(api[4]).toMatchObject({ role: 'tool', tool_call_id: 'tc-1' });
  });

  it('carries providerOptions through toModelMessages onto reasoning parts', () => {
    const modelMessages = toModelMessages(toApiMessages(anthropicToolLoopMessages(), anthropicReplay));

    expect(modelMessages[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'Let me analyze',
        providerOptions: { anthropic: { signature: 'sig-1' } },
      }],
    });
    expect(modelMessages[2]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: '',
        providerOptions: { anthropic: { redactedData: 'redacted-1' } },
      }],
    });
    expect(modelMessages[3]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'read', input: {} },
      ],
    });
    expect(modelMessages[4]).toMatchObject({ role: 'tool' });
  });

  it('replays encrypted reasoning items for a responses model', () => {
    const api = toApiMessages([
      makeMessage({ role: MessageRole.USER, content: 'Summarize' }),
      makeMessage({
        type: MessageType.THINKING,
        content: 'summary text',
        thinking: 'summary text',
        thinking_payload: encryptedPayload(),
      }),
    ], responsesReplay);

    expect(api[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'summary text',
        providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-1' } },
      }],
    });

    const modelMessages = toModelMessages(api);
    expect(modelMessages[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'summary text',
        providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-1' } },
      }],
    });
  });

  it('omits thinking for the chat-completions protocol without breaking tool pairing', () => {
    const chatCompletionsReplay: ThinkingReplayContext = {
      policy: OPENAI_OPAQUE_THINKING_POLICY,
      selection: { providerId: 'openai', modelId: 'gpt-5' },
    };
    const api = toApiMessages([
      makeMessage({
        type: MessageType.TOOL_CALL,
        tool_calls: [makeToolCall('tc-1', 'read')],
        tool_call_id: 'tc-1',
      }),
      makeMessage({
        type: MessageType.THINKING,
        content: '',
        thinking: '',
        thinking_payload: encryptedPayload({ displayText: null }),
      }),
      makeMessage({
        role: MessageRole.TOOL,
        type: MessageType.TOOL_RESULT,
        content: 'file contents',
        tool_call_id: 'tc-1',
      }),
    ], chatCompletionsReplay);

    expect(api.map((message) => message.role)).toEqual(['assistant', 'tool']);
    expect(api[0].tool_calls?.map((call) => call.id)).toEqual(['tc-1']);
  });

  it('strips prior artifacts when the provider or model changes', () => {
    const thinking = makeMessage({
      type: MessageType.THINKING,
      content: 'Let me analyze',
      thinking: 'Let me analyze',
      thinking_payload: signedPayload(),
    });

    // Provider switch: the artifact is stripped; readable text degrades to
    // plain reasoning under the new model's recommended policy.
    expect(toApiMessages([thinking], responsesReplay)[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'Let me analyze' }],
    });

    // Model switch within a mandatory provider: no artifact, no replay.
    expect(toApiMessages([thinking], {
      policy: ANTHROPIC_THINKING_POLICY,
      selection: { providerId: 'anthropic', modelId: 'claude-2' },
    })).toEqual([]);
  });

  it('replays older payload-free messages as plain text', () => {
    const legacy = makeMessage({
      type: MessageType.THINKING,
      content: 'old reasoning',
      thinking: 'old reasoning',
    });

    // Historical behavior without a replay context.
    expect(toApiMessages([legacy])).toEqual([{
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'old reasoning' }],
    }]);

    // Default policy keeps the same plain-text replay.
    expect(toApiMessages([legacy], {
      policy: DEFAULT_THINKING_POLICY,
      selection: { providerId: 'glm', modelId: 'glm-4.6' },
    })).toEqual([{
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'old reasoning' }],
    }]);
  });
});

// ---------------------------------------------------------------------------
// Storage round-trip
// ---------------------------------------------------------------------------

describe('thinking_payload storage', () => {
  it('round-trips the payload through the storage dict', () => {
    const message = makeThinkingMessage('Let me analyze', 'seg-1', signedPayload());
    const restored = messageFromStorageDict(
      JSON.parse(JSON.stringify(messageToStorageDict(message))),
    );
    expect(restored.thinking_payload).toEqual(signedPayload());
    expect(restored.content).toBe('Let me analyze');
  });

  it('round-trips encrypted payloads with item ids and token counts', () => {
    const message = makeThinkingMessage('', 'seg-2', encryptedPayload({ reasoningTokenCount: 128 }));
    const restored = messageFromStorageDict(
      JSON.parse(JSON.stringify(messageToStorageDict(message))),
    );
    expect(restored.thinking_payload).toEqual(encryptedPayload({ reasoningTokenCount: 128 }));
  });

  it('drops malformed payloads and tolerates missing ones', () => {
    const malformed = messageFromStorageDict({
      ...messageToStorageDict(makeThinkingMessage('text')),
      thinking_payload: { providerId: 'anthropic', kind: 'bogus' },
    });
    expect(malformed.thinking_payload).toBeUndefined();

    const legacy = messageFromStorageDict({
      role: 'assistant',
      type: 'thinking',
      content: 'old reasoning',
    });
    expect(legacy.thinking_payload).toBeUndefined();
    expect(legacy.content).toBe('old reasoning');
  });
});

// ---------------------------------------------------------------------------
// Stream adapter capture
// ---------------------------------------------------------------------------

function makeAdapterOptions(
  overrides: Partial<SdkEventAdapterOptions> = {},
): SdkEventAdapterOptions {
  return {
    coreMessages: [],
    resolveToolName: (name) => name,
    attempt: { armIdleTimer: vi.fn(), markDeliveredOutput: vi.fn() },
    eagerBridge: {
      flushActiveInput: vi.fn(),
      inputStarted: vi.fn(),
      inputDelta: vi.fn(),
      inputEnded: vi.fn(),
      sdkToolCall: vi.fn(),
      sdkToolResult: vi.fn(),
      sdkToolError: vi.fn(),
      sdkInputError: vi.fn(),
      drainEagerStarts: vi.fn(),
      drainEvents: vi.fn(),
    } as unknown as SdkEventAdapterOptions['eagerBridge'],
    buildUsage: () => ({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
    }),
    ...overrides,
  };
}

function adaptAll(
  adapter: SdkEventAdapter,
  parts: Array<Record<string, unknown>>,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const part of parts) {
    events.push(...adapter.adapt(part));
  }
  return events;
}

describe('SdkEventAdapter thinking artifact capture', () => {
  const identity = { providerId: 'anthropic', modelId: 'claude-1' };

  it('captures the anthropic signature when the reasoning sequence closes', () => {
    const adapter = new SdkEventAdapter(makeAdapterOptions({ artifactIdentity: identity }));
    const events = adaptAll(adapter, [
      { type: 'reasoning-start', id: '0' },
      { type: 'reasoning-delta', id: '0', delta: 'Let me ' },
      { type: 'reasoning-delta', id: '0', delta: 'analyze' },
      {
        type: 'reasoning-delta',
        id: '0',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-1' } },
      },
      { type: 'reasoning-end', id: '0' },
    ]);

    expect(events).toEqual([
      { type: 'thinking', text: 'Let me ' },
      { type: 'thinking', text: 'analyze' },
      {
        type: 'thinking_artifact',
        hasText: true,
        payload: signedPayload(),
      },
    ]);
  });

  it('captures redacted thinking as a text-less artifact', () => {
    const adapter = new SdkEventAdapter(makeAdapterOptions({ artifactIdentity: identity }));
    const events = adaptAll(adapter, [
      {
        type: 'reasoning-start',
        id: '1',
        providerMetadata: { anthropic: { redactedData: 'redacted-1' } },
      },
      { type: 'reasoning-end', id: '1' },
    ]);

    expect(events).toEqual([{
      type: 'thinking_artifact',
      hasText: false,
      payload: signedPayload({
        kind: ThinkingArtifactKind.REDACTED,
        blob: 'redacted-1',
        displayText: null,
      }),
    }]);
  });

  it('captures responses item id and encrypted content with the summary text', () => {
    const adapter = new SdkEventAdapter(makeAdapterOptions({
      artifactIdentity: { providerId: 'openai', modelId: 'gpt-5' },
    }));
    const events = adaptAll(adapter, [
      {
        type: 'reasoning-start',
        id: 'rs_1:0',
        providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-1' } },
      },
      {
        type: 'reasoning-delta',
        id: 'rs_1:0',
        delta: 'summary text',
        providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: null } },
      },
      {
        type: 'reasoning-end',
        id: 'rs_1:0',
        providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-1' } },
      },
    ]);

    expect(events).toEqual([
      { type: 'thinking', text: 'summary text' },
      {
        type: 'thinking_artifact',
        hasText: true,
        payload: encryptedPayload(),
      },
    ]);
  });

  it('drains unclosed reasoning sequences at step finish', () => {
    const adapter = new SdkEventAdapter(makeAdapterOptions({ artifactIdentity: identity }));
    const events = adaptAll(adapter, [
      { type: 'reasoning-start', id: '0' },
      { type: 'reasoning-delta', id: '0', delta: 'truncated thought' },
      {
        type: 'reasoning-delta',
        id: '0',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-1' } },
      },
      { type: 'finish-step', usage: {}, finishReason: 'stop' },
    ]);

    expect(events[0]).toEqual({ type: 'thinking', text: 'truncated thought' });
    expect(events[1]).toEqual({
      type: 'thinking_artifact',
      hasText: true,
      payload: signedPayload({ displayText: 'truncated thought' }),
    });
    expect(events[1].type).toBe('thinking_artifact');
    expect(events[2].type).toBe('usage');
  });

  it('captures nothing without an artifact identity', () => {
    const adapter = new SdkEventAdapter(makeAdapterOptions());
    const events = adaptAll(adapter, [
      {
        type: 'reasoning-start',
        id: '0',
        providerMetadata: { anthropic: { redactedData: 'redacted-1' } },
      },
      { type: 'reasoning-end', id: '0' },
    ]);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Subagent chain persistence
// ---------------------------------------------------------------------------

describe('SubagentRunAssembler thinking payloads', () => {
  it('attaches a closed sequence payload to its thinking message', () => {
    const assembler = new SubagentRunAssembler([]);
    assembler.accept({ type: 'thinking', text: 'Let me analyze' });
    assembler.accept({ type: 'thinking_artifact', payload: signedPayload(), hasText: true });
    const finalization = assembler.complete();

    expect(finalization.messages).toHaveLength(1);
    expect(finalization.messages[0]).toMatchObject({
      type: MessageType.THINKING,
      content: 'Let me analyze',
      thinking_payload: signedPayload(),
    });
  });

  it('persists artifact-only reasoning as its own text-less message', () => {
    const assembler = new SubagentRunAssembler([]);
    const effects = assembler.accept({
      type: 'thinking_artifact',
      payload: signedPayload({
        kind: ThinkingArtifactKind.REDACTED,
        blob: 'redacted-1',
        displayText: null,
      }),
      hasText: false,
    });
    const finalization = assembler.complete();

    expect(effects[0]?.type).toBe('thinking_artifact');
    expect(finalization.messages).toHaveLength(1);
    expect(finalization.messages[0]).toMatchObject({
      type: MessageType.THINKING,
      content: '',
      thinking_payload: signedPayload({
        kind: ThinkingArtifactKind.REDACTED,
        blob: 'redacted-1',
        displayText: null,
      }),
    });
  });

  it('stamps reported reasoning tokens onto a single text-less artifact (R17)', () => {
    const assembler = new SubagentRunAssembler([]);
    assembler.accept({
      type: 'thinking_artifact',
      payload: encryptedPayload({ displayText: null }),
      hasText: false,
    });
    assembler.accept({
      type: 'usage',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        cached_tokens: 0,
        reasoning_tokens: 42,
      },
    });
    const finalization = assembler.complete();

    expect(finalization.messages[0]?.thinking_payload?.reasoningTokenCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Agent machine artifact accumulation
// ---------------------------------------------------------------------------

describe('agentMachine thinking artifacts', () => {
  it('keys text-bearing payloads at the accumulated thinking offset', async () => {
    const streamFn = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'thinking', text: 'Let me ' };
      yield { type: 'thinking', text: 'analyze' };
      yield { type: 'thinking_artifact', payload: signedPayload(), hasText: true };
      yield {
        type: 'thinking_artifact',
        payload: signedPayload({
          kind: ThinkingArtifactKind.REDACTED,
          blob: 'redacted-1',
          displayText: null,
        }),
        hasText: false,
      };
      yield { type: 'finish', finishReason: 'stop' };
    };

    const actor = createActor(agentMachine, {
      input: { agent: makeAgent(), systemPrompt: 'You are helpful.', streamFn },
    });
    actor.start();
    actor.send({ type: 'USER_INPUT', message: 'Hi' });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toBe('idle');
    });

    const context = actor.getSnapshot().context;
    expect(context.thinking).toBe('Let me analyze');
    expect(context.thinkingPayloads).toEqual({ ['Let me analyze'.length]: signedPayload() });
    expect(context.thinkingArtifacts).toEqual([signedPayload({
      kind: ThinkingArtifactKind.REDACTED,
      blob: 'redacted-1',
      displayText: null,
    })]);
    actor.stop();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator end-to-end (mocked AI SDK)
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

function createAsyncIterable<T>(items: T[], error?: Error): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      if (error) throw error;
      for (const item of items) yield item;
    },
  };
}

function makeAgent(): Agent {
  return {
    name: 'general',
    type: AgentType.INTERNAL,
    tier: AgentTier.BLOOM,
    description: 'General-purpose agent',
    allowed_tools: [],
    allowed_skills: [],
  };
}

function makeStreamChatParams(overrides: Partial<StreamChatParams> = {}): StreamChatParams {
  return {
    messages: overrides.messages ?? [makeMessage({ role: MessageRole.USER, content: 'Hi' })],
    agent: overrides.agent ?? makeAgent(),
    systemPrompt: 'You are a helpful assistant.',
    context: overrides.context ?? { cwd: '/tmp/orchid-test' },
    config: overrides.config ?? defaults(),
    registry: overrides.registry ?? new ToolRegistry(),
    mcpManager: null,
    modelInstance: overrides.modelInstance ?? ({
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'test-model',
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    } as StreamChatParams['modelInstance']),
    ...overrides,
  };
}

describe('streamChat thinking replay', () => {
  beforeEach(() => {
    aiSdkMocks.streamText.mockReset();
    aiSdkMocks.wrapLanguageModel.mockClear();
    aiSdkMocks.isStepCount.mockClear();
  });

  it('sends policy-shaped reasoning parts to the model', async () => {
    let captured: { messages?: unknown } = {};
    aiSdkMocks.streamText.mockImplementation((params: { messages?: unknown }) => {
      captured = params;
      return {
        fullStream: createAsyncIterable([{ type: 'text-delta', text: 'Done' }]),
        textStream: createAsyncIterable([]),
        finishReason: Promise.resolve('stop'),
      };
    });

    const events: StreamEvent[] = [];
    for await (const event of streamChat(makeStreamChatParams({
      messages: anthropicToolLoopMessages(),
      thinkingReplay: anthropicReplay,
    }))) {
      events.push(event);
    }

    const messages = captured.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'Let me analyze',
        providerOptions: { anthropic: { signature: 'sig-1' } },
      }],
    });
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: '',
        providerOptions: { anthropic: { redactedData: 'redacted-1' } },
      }],
    });
    expect(events.some((event) => event.type === 'finish')).toBe(true);
  });

  it('emits thinking and artifact events from anthropic reasoning stream parts', async () => {
    aiSdkMocks.streamText.mockImplementation(() => ({
      fullStream: createAsyncIterable([
        { type: 'reasoning-start', id: '0' },
        { type: 'reasoning-delta', id: '0', delta: 'Let me analyze' },
        {
          type: 'reasoning-delta',
          id: '0',
          delta: '',
          providerMetadata: { anthropic: { signature: 'sig-1' } },
        },
        { type: 'reasoning-end', id: '0' },
        { type: 'tool-input-available', toolCallId: 'tc-1', toolName: 'read', input: {} },
        { type: 'finish-step', usage: {}, finishReason: 'tool-calls' },
        { type: 'text-delta', text: 'Fixed.' },
      ]),
      textStream: createAsyncIterable([]),
      finishReason: Promise.resolve('stop'),
    }));

    const events: StreamEvent[] = [];
    for await (const event of streamChat(makeStreamChatParams({
      thinkingReplay: anthropicReplay,
    }))) {
      events.push(event);
    }

    const artifactIndex = events.findIndex((event) => event.type === 'thinking_artifact');
    const toolCallIndex = events.findIndex((event) => event.type === 'tool_call');
    expect(events[0]).toEqual({ type: 'thinking', text: 'Let me analyze' });
    expect(events[artifactIndex]).toEqual({
      type: 'thinking_artifact',
      hasText: true,
      payload: signedPayload(),
    });
    // The artifact lands before the tool call so persistence order replays
    // signed thinking ahead of the tool use it belongs to.
    expect(artifactIndex).toBeGreaterThan(-1);
    expect(toolCallIndex).toBeGreaterThan(artifactIndex);
  });

  it('recovers thinking text and artifacts in the textStream fallback', async () => {
    aiSdkMocks.streamText.mockImplementation((params: {
      onStepFinish?: (step: Record<string, unknown>) => void;
    }) => {
      params.onStepFinish?.({
        usage: {},
        content: [{
          type: 'reasoning',
          text: 'Let me analyze',
          providerMetadata: { anthropic: { signature: 'sig-1' } },
        }],
      });
      return {
        fullStream: createAsyncIterable([], new Error('stream exploded')),
        textStream: createAsyncIterable(['Done']),
        finishReason: Promise.resolve('stop'),
      };
    });

    const events: StreamEvent[] = [];
    for await (const event of streamChat(makeStreamChatParams({
      thinkingReplay: anthropicReplay,
    }))) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'thinking', text: 'Let me analyze' });
    expect(events).toContainEqual({
      type: 'thinking_artifact',
      hasText: true,
      payload: signedPayload(),
    });
    expect(events).toContainEqual({ type: 'content', text: 'Done' });
  });
});
