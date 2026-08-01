import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { NormalizedStream } from '../../src/main/llm/stream/normalized-stream';
import type { StreamEvent } from '../../src/main/llm/stream/events';
import type { EagerToolBridge } from '../../src/main/llm/stream/eager-tool-bridge';
import type { StreamAttemptController } from '../../src/main/llm/stream/attempt-controller';
import {
  createCanonicalToolResult,
  type ToolExecutionResult,
} from '../../src/shared/types/tool-result';

function asyncIterable<T>(items: T[], error?: Error): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      if (error) throw error;
      yield* items;
    },
  };
}

function execution(content: string): ToolExecutionResult {
  return {
    canonical: createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: content },
    }),
    agentProjection: { content, completeness: 'complete' },
  };
}

function createBridge() {
  const events: Extract<StreamEvent, { type: 'tool_call' | 'tool_result' }>[] = [];
  const bridge = {
    flushActiveInput: vi.fn(),
    inputStarted: vi.fn(),
    inputDelta: vi.fn(),
    inputEnded: vi.fn(),
    sdkToolCall: vi.fn(),
    sdkToolResult: vi.fn(),
    sdkToolError: vi.fn(),
    sdkInputError: vi.fn(),
    drainEagerStarts: vi.fn(function* () {}),
    hasPendingFallbackEvents: false,
    queuePendingToolCall: vi.fn((call) => {
      events.push({ type: 'tool_call', ...call });
      bridge.hasPendingFallbackEvents = true;
    }),
    queuePendingToolResult: vi.fn((result) => {
      events.push({ type: 'tool_result', ...result });
      bridge.hasPendingFallbackEvents = true;
    }),
    drainEvents: vi.fn(function* () {
      bridge.hasPendingFallbackEvents = false;
      while (events.length) yield events.shift()!;
    }),
    flush: vi.fn(async () => {}),
  };
  return bridge as unknown as EagerToolBridge & { flush: ReturnType<typeof vi.fn> };
}

function createAttempt(overrides: Partial<StreamAttemptController> = {}) {
  return {
    signal: new AbortController().signal,
    didIdleTimeout: false,
    didUserAbort: false,
    armIdleTimer: vi.fn(),
    markDeliveredOutput: vi.fn(),
    ...overrides,
  } as unknown as StreamAttemptController;
}

function createNormalizer(
  bridge = createBridge(),
  attempt = createAttempt(),
) {
  return {
    bridge,
    attempt,
    stream: new NormalizedStream({
      coreMessages: [] as unknown as readonly ModelMessage[],
      mcpManager: null,
      attempt,
      eagerBridge: bridge,
      buildUsage: (usage) => ({
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: usage.totalTokens ?? 0,
        cached_tokens: 0,
      }),
    }),
  };
}

async function collect(stream: NormalizedStream, result: {
  fullStream: AsyncIterable<unknown>;
  textStream: AsyncIterable<string>;
  finishReason: PromiseLike<string | undefined>;
}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream.events(result)) events.push(event);
  return events;
}

describe('NormalizedStream', () => {
  it('exposes the same content/finish contract for fullStream and textStream fallback', async () => {
    const full = createNormalizer();
    const fallback = createNormalizer();

    const fullEvents = await collect(full.stream, {
      fullStream: asyncIterable([{ type: 'text-delta', text: 'answer' }]),
      textStream: asyncIterable([]),
      finishReason: Promise.resolve('stop'),
    });
    const fallbackEvents = await collect(fallback.stream, {
      fullStream: asyncIterable([], new Error('unsupported')),
      textStream: asyncIterable(['answer']),
      finishReason: Promise.resolve('stop'),
    });

    expect(fullEvents).toEqual([
      { type: 'content', text: 'answer' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(fallbackEvents).toEqual(fullEvents);
  });

  it('orders fallback pending tools/results/usage before the next text and before finish', async () => {
    const { stream } = createNormalizer();
    await stream.onStepFinish({
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      toolCalls: [{ toolCallId: 'call-1', toolName: 'read', input: { path: '/a' } }],
      toolResults: [{ toolCallId: 'call-1', output: execution('file') }],
    });

    const events = await collect(stream, {
      fullStream: asyncIterable([], new Error('unsupported')),
      textStream: asyncIterable(['next step']),
      finishReason: Promise.resolve('stop'),
    });

    expect(events.map((event) => event.type)).toEqual([
      'tool_call', 'tool_result', 'usage', 'content', 'finish',
    ]);
    expect(events[0]).toMatchObject({ toolCallId: 'call-1', args: '{"path":"/a"}' });
    expect(events[1]).toMatchObject({ toolCallId: 'call-1', content: 'file' });
  });

  it('correlates fallback results with their tool call names', async () => {
    const { stream } = createNormalizer();
    await stream.onStepFinish({
      toolCalls: [
        { toolCallId: 'invalid-result', toolName: 'read' },
        { toolCallId: 'failed-result', toolName: 'grep' },
      ],
      toolResults: [
        { toolCallId: 'invalid-result', output: { invalid: true } },
        { toolCallId: 'failed-result', error: new Error('provider failed') },
        { toolCallId: 'unmatched-result', output: { invalid: true } },
      ],
    });

    const events = await collect(stream, {
      fullStream: asyncIterable([], new Error('unsupported')),
      textStream: asyncIterable([]),
      finishReason: Promise.resolve('stop'),
    });
    const results = events.filter((event) => event.type === 'tool_result');

    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: 'invalid-result',
        content: expect.stringContaining("Tool 'read'"),
        execution: expect.objectContaining({
          canonical: expect.objectContaining({
            data: expect.objectContaining({ origin: expect.objectContaining({ name: 'read' }) }),
          }),
        }),
      }),
      expect.objectContaining({
        toolCallId: 'failed-result',
        content: expect.stringContaining('provider failed'),
        execution: expect.objectContaining({
          canonical: expect.objectContaining({
            data: expect.objectContaining({ origin: expect.objectContaining({ name: 'grep' }) }),
          }),
        }),
      }),
      expect.objectContaining({
        toolCallId: 'unmatched-result',
        content: expect.stringContaining("Tool 'unknown'"),
      }),
    ]);
  });

  it('delivers a step callback that races text before that text delta', async () => {
    const { stream } = createNormalizer();
    const result = {
      fullStream: asyncIterable([], new Error('unsupported')),
      textStream: {
        async *[Symbol.asyncIterator]() {
          await stream.onStepFinish({
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            toolCalls: [{ toolCallId: 'race', toolName: 'read', input: {} }],
            toolResults: [{ toolCallId: 'race', output: execution('ready') }],
          });
          yield 'after callback';
        },
      },
      finishReason: Promise.resolve('stop'),
    };

    const events = await collect(stream, result);
    expect(events.map((event) => event.type)).toEqual([
      'tool_call', 'tool_result', 'usage', 'content', 'finish',
    ]);
  });

  it('drops pre-stream fallback usage as soon as fullStream yields a part', async () => {
    const { stream } = createNormalizer();
    await stream.onStepFinish({ usage: { inputTokens: 9, totalTokens: 9 } });

    const events = await collect(stream, {
      fullStream: asyncIterable([{ type: 'text-delta', text: 'authoritative' }]),
      textStream: asyncIterable([]),
      finishReason: Promise.resolve('stop'),
    });

    expect(events).toEqual([
      { type: 'content', text: 'authoritative' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it('keeps an onStepFinish fallback call/result after its matching streamed start', async () => {
    const { stream } = createNormalizer();
    await stream.onStepFinish({
      toolCalls: [{ toolCallId: 'call-1', toolName: 'read', input: { path: '/a' } }],
      toolResults: [{ toolCallId: 'call-1', output: execution('file') }],
    });

    const events = await collect(stream, {
      fullStream: asyncIterable([{ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'read' }]),
      textStream: asyncIterable([]),
      finishReason: Promise.resolve('stop'),
    });

    expect(events.map((event) => event.type)).toEqual([
      'tool_call_start', 'tool_call', 'tool_result', 'finish',
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: 'tool_call_start', toolCallId: 'call-1', toolName: 'read' },
      expect.objectContaining({ type: 'tool_call', toolCallId: 'call-1' }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'call-1', content: 'file' }),
    ]);
  });

  it('rethrows an error after a fullStream part and never starts fallback', async () => {
    const { stream } = createNormalizer();
    const result = {
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: 'partial' };
          throw new Error('provider broke');
        },
      },
      textStream: asyncIterable(['must not appear']),
      finishReason: Promise.resolve('stop'),
    };
    const events: StreamEvent[] = [];

    await expect((async () => {
      for await (const event of stream.events(result)) events.push(event);
    })()).rejects.toThrow('provider broke');
    expect(events).toEqual([{ type: 'content', text: 'partial' }]);
  });

  it.each([
    ['user cancellation', { didUserAbort: true }],
    ['idle timeout', { didIdleTimeout: true }],
    ['pre-aborted signal', { signal: AbortSignal.abort() }],
  ])('rethrows a %s fullStream failure instead of falling back', async (_label, overrides) => {
    const { stream } = createNormalizer(undefined, createAttempt(overrides));
    const error = new Error('original fullStream failure');
    const textStreamStarted = vi.fn();

    await expect(collect(stream, {
      fullStream: asyncIterable([], error),
      textStream: {
        async *[Symbol.asyncIterator]() {
          textStreamStarted();
          yield 'must not appear';
        },
      },
      finishReason: Promise.resolve('stop'),
    })).rejects.toBe(error);
    expect(textStreamStarted).not.toHaveBeenCalled();
  });

  it('finishes and drains final events when finishReason rejects', async () => {
    const bridge = createBridge();
    const { stream } = createNormalizer(bridge);
    await stream.onStepFinish({
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });

    const events = await collect(stream, {
      fullStream: asyncIterable([]),
      textStream: asyncIterable([]),
      finishReason: Promise.reject(new Error('finish reason unavailable')),
    });

    expect(bridge.flush).toHaveBeenCalledOnce();
    expect(bridge.drainEvents).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['usage', 'finish']);
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
  });

  it('flushes final eager events before finish and preserves terminal warning reasons', async () => {
    const bridge = createBridge();
    bridge.flush.mockImplementation(async () => {
      bridge.queuePendingToolResult({
        toolCallId: 'last',
        content: 'done',
        execution: execution('done'),
      });
    });
    const { stream } = createNormalizer(bridge);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events = await collect(stream, {
      fullStream: asyncIterable([]),
      textStream: asyncIterable([]),
      finishReason: Promise.resolve('length'),
    });

    expect(events.map((event) => event.type)).toEqual(['tool_result', 'finish']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('max token limit'));
    warn.mockRestore();
  });
});
