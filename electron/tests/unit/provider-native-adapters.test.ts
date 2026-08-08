import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importESM } from '../../src/main/utils/esm-import';
import type { ProviderConnection, ProviderDefinition } from '../../src/shared/types/provider';
import { MessageRole, MessageType, type Message } from '../../src/shared/types/message';
import type { StreamEvent } from '../../src/main/llm/stream/events';

vi.mock('../../src/main/utils/esm-import', () => ({ importESM: vi.fn() }));

function message(overrides: Partial<Message>): Message {
  return {
    id: crypto.randomUUID(),
    role: MessageRole.USER,
    content: '',
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-08-08T12:00:00.000Z',
    usage: null,
    hidden: false,
    tool_result: null,
    ...overrides,
  };
}

const mockOpenAIModel = { kind: 'openai' };
const mockOpenAIResponsesModel = { kind: 'openai-responses' };
const mockAnthropicModel = { kind: 'anthropic' };
const mockGoogleModel = { kind: 'google' };
const mockXaiModel = { kind: 'xai' };
const mockOpenAIChat = vi.fn(() => mockOpenAIModel);
const mockOpenAIResponses = vi.fn(() => mockOpenAIResponsesModel);
const mockCreateOpenAI = vi.fn(() => ({ chat: mockOpenAIChat, responses: mockOpenAIResponses }));
const mockCreateAnthropic = vi.fn(() => ({ messages: vi.fn(() => mockAnthropicModel) }));
const mockCreateGoogle = vi.fn(() => ({ languageModel: vi.fn(() => mockGoogleModel) }));
const mockCreateXai = vi.fn(() => ({ chat: vi.fn(() => mockXaiModel) }));

describe('native provider adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockImplementation(async (specifier: string) => {
      switch (specifier) {
        case '@ai-sdk/openai': return { createOpenAI: mockCreateOpenAI };
        case '@ai-sdk/anthropic': return { createAnthropic: mockCreateAnthropic };
        case '@ai-sdk/google': return { createGoogle: mockCreateGoogle };
        case '@ai-sdk/xai': return { createXai: mockCreateXai };
        default: throw new Error(`Unexpected adapter import ${specifier}`);
      }
    });
  });

  it.each([
    ['openai', 'openai-compatible', 'gpt-5.2-pro', 'openai-key', mockOpenAIModel, '@ai-sdk/openai'],
    ['anthropic', 'anthropic-messages', 'claude-opus-4-5', 'anthropic-key', mockAnthropicModel, '@ai-sdk/anthropic'],
    ['google-gemini', 'google-generative-ai', 'gemini-2.5-pro', 'google-key', mockGoogleModel, '@ai-sdk/google'],
    ['xai', 'xai', 'grok-4.3', 'xai-key', mockXaiModel, '@ai-sdk/xai'],
  ] as const)(
    'routes %s through its native %s adapter',
    async (providerId, protocol, modelId, apiKey, expected, specifier) => {
      const { createNativeLanguageModel } = await import('../../src/main/providers/drivers/native');
      const model = await createNativeLanguageModel({ providerId, protocol, modelId, apiKey });

      expect(model).toBe(expected);
      expect(importESM).toHaveBeenCalledWith(specifier);
    },
  );

  it('uses code-owned API origins and never turns a named provider into OpenAI-compatible transport', async () => {
    const { createNativeLanguageModel, BUILTIN_PROVIDER_ORIGINS } = await import('../../src/main/providers/drivers/native');

    await createNativeLanguageModel({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-opus-4-5',
      apiKey: 'anthropic-key',
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'anthropic-key',
      baseURL: BUILTIN_PROVIDER_ORIGINS.anthropic,
    });
    expect(mockCreateOpenAI).not.toHaveBeenCalled();
  });

  it('builds an OpenAI Responses model when the model protocol is openai-responses', async () => {
    const { createNativeLanguageModel, BUILTIN_PROVIDER_ORIGINS } = await import('../../src/main/providers/drivers/native');

    const model = await createNativeLanguageModel({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-5.2',
      apiKey: 'openai-key',
    });

    expect(model).toBe(mockOpenAIResponsesModel);
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'openai-key',
      baseURL: BUILTIN_PROVIDER_ORIGINS.openai,
    });
    expect(mockOpenAIResponses).toHaveBeenCalledWith('gpt-5.2');
    expect(mockOpenAIChat).not.toHaveBeenCalled();
  });

  it('rejects protocols the named provider does not support', async () => {
    const { createNativeLanguageModel } = await import('../../src/main/providers/drivers/native');

    await expect(createNativeLanguageModel({
      providerId: 'openai',
      protocol: 'anthropic-messages',
      modelId: 'gpt-5.2',
      apiKey: 'openai-key',
    })).rejects.toThrow(/openai-compatible or openai-responses/);
  });

  it('routes a per-model openai-responses selection through the trusted OpenAI driver', async () => {
    const { createNativeProviderDrivers } = await import('../../src/main/providers/drivers/native');
    const openai = createNativeProviderDrivers().find((driver) => driver.id === 'openai');
    expect(openai?.supportedProtocols).toEqual(['openai-compatible', 'openai-responses']);

    const connection: ProviderConnection = {
      id: '44444444-4444-4444-8444-444444444444',
      providerId: 'openai',
      name: 'Work',
      protocol: 'openai-responses',
      authMethod: 'api-key',
      credential: { kind: 'stored', handle: '55555555-5555-4555-8555-555555555555' },
      modelIds: ['gpt-5.2'],
      health: 'ready',
    };
    const provider: ProviderDefinition = {
      id: 'openai',
      displayName: 'OpenAI',
      supportedAuthMethods: ['api-key'],
      supportedProtocols: ['openai-compatible', 'openai-responses'],
      allowsCustomModels: false,
      models: [],
    };

    await expect(openai!.createLanguageModel({
      connection,
      provider,
      model: {
        id: 'gpt-5.2',
        displayName: 'GPT-5.2',
        protocol: 'openai-responses',
        source: 'catalog',
      },
      credential: { kind: 'api-key', apiKey: 'openai-key' },
    })).resolves.toBe(mockOpenAIResponsesModel);
    expect(mockOpenAIResponses).toHaveBeenCalledWith('gpt-5.2');
  });
});

describe('OpenAI Responses protocol end-to-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importESM).mockImplementation(async (specifier: string) => {
      if (specifier === 'ai') return vi.importActual('ai');
      if (specifier === '@ai-sdk/openai') return vi.importActual('@ai-sdk/openai');
      throw new Error(`Unexpected adapter import ${specifier}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseResponse(events: readonly unknown[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  function stubResponsesStream(fetchMock: ReturnType<typeof vi.fn>): void {
    fetchMock.mockImplementation(async () => sseResponse([
      { type: 'response.created', response: { id: 'resp_1', created_at: 1755270000, model: 'gpt-5.2' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: null } },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', summary_index: 0 },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'Reasoning about the summary.' },
      { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', summary_index: 0 },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Summary: it is Orchid.' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 25 },
          },
        },
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
  }

  async function runResponsesTurn(): Promise<StreamEvent[]> {
    const {
      createNativeLanguageModel,
      createNativeProviderDrivers,
    } = await import('../../src/main/providers/drivers/native');
    const { streamChat } = await import('../../src/main/llm/orchestrator');
    const { ToolRegistry } = await import('../../src/main/tools/registry');
    const { defaults } = await import('../../src/main/config/schema');

    const history: Message[] = [
      message({ role: MessageRole.USER, content: 'Read README.md' }),
      message({
        role: MessageRole.ASSISTANT,
        type: MessageType.TOOL_CALL,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"README.md"}' },
        }],
      }),
      // An interleaved THINKING between the call and its result must not
      // break the call/output pairing the Responses API requires.
      message({ role: MessageRole.ASSISTANT, type: MessageType.THINKING, content: 'I should read the file first.' }),
      message({
        role: MessageRole.TOOL,
        type: MessageType.TOOL_RESULT,
        tool_call_id: 'call_1',
        content: 'readme contents',
      }),
      message({ role: MessageRole.ASSISTANT, content: 'The README describes Orchid.' }),
      message({ role: MessageRole.USER, content: 'Summarize it.' }),
    ];

    const modelInstance = await createNativeLanguageModel({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-5.2',
      apiKey: 'openai-key',
    });
    const openai = createNativeProviderDrivers().find((driver) => driver.id === 'openai')!;
    const providerOptions = openai.buildReasoningOptions!('high', {
      id: 'gpt-5.2',
      displayName: 'GPT-5.2',
      protocol: 'openai-responses',
      source: 'catalog',
    });

    const events: StreamEvent[] = [];
    for await (const event of streamChat({
      messages: history,
      agent: {
        name: 'general',
        type: 'internal',
        tier: 'bloom',
        description: 'General agent',
        system_prompt: 'You are a helpful assistant.',
        allowed_tools: [],
        allowed_skills: [],
      },
      systemPrompt: 'You are a helpful assistant.',
      context: { cwd: '/tmp/orchid-responses-test' },
      config: defaults(),
      registry: new ToolRegistry(),
      mcpManager: null,
      modelInstance,
      providerOptions,
    })) {
      events.push(event);
    }
    return events;
  }

  it('maps history with tool calls to Responses input without orphaned tool results', async () => {
    const fetchMock = vi.fn();
    stubResponsesStream(fetchMock);

    const events = await runResponsesTurn();

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/responses');
    const body = JSON.parse(String((init as RequestInit).body));
    // The driver's reasoning mapping lands on the Responses request shape.
    expect(body.reasoning).toMatchObject({ effort: 'high' });

    const input = body.input as Array<Record<string, unknown>>;
    // Reasoning models receive the system prompt as a developer input item.
    expect(input.some(
      (item) => item['role'] === 'developer'
        && JSON.stringify(item).includes('You are a helpful assistant.'),
    )).toBe(true);
    const calls = input.filter((item) => item['type'] === 'function_call');
    const outputs = input.filter((item) => item['type'] === 'function_call_output');
    expect(calls).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!['call_id']).toBe('call_1');
    expect(calls[0]!['call_id']).toBe('call_1');
    // Persisted reasoning text carries no replay artifact yet (U3), so the
    // converter drops it instead of crashing the request.
    expect(input.some((item) => item['type'] === 'reasoning')).toBe(false);
    expect(input.some(
      (item) => item['role'] === 'assistant'
        && JSON.stringify(item).includes('The README describes Orchid.'),
    )).toBe(true);
  });

  it('normalizes Responses reasoning/cache usage and streams thinking', async () => {
    const fetchMock = vi.fn();
    stubResponsesStream(fetchMock);

    const events = await runResponsesTurn();

    const usageEvents = events.filter((event) => event.type === 'usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: 'usage',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 40,
        total_tokens: 160,
        cached_tokens: 80,
        reasoning_tokens: 25,
      },
    });
    const thinking = events
      .filter((event): event is Extract<StreamEvent, { type: 'thinking' }> => event.type === 'thinking')
      .map((event) => event.text)
      .join('');
    expect(thinking).toContain('Reasoning about the summary.');
    const content = events
      .filter((event): event is Extract<StreamEvent, { type: 'content' }> => event.type === 'content')
      .map((event) => event.text)
      .join('');
    expect(content).toContain('Summary: it is Orchid.');
  });
});
