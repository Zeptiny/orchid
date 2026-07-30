/**
 * Tests for the AI SDK middleware layer.
 *
 * Covers:
 * - Retry middleware: transient error → retried with backoff, second attempt succeeds
 * - Retry guard: first token delivered → transient error → NOT retried
 * - Transient error detection: class, status, and message paths covered
 * - Throttle: thinking yields are rate-limited
 * - Middleware stack composition
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  createRetryMiddleware,
  createThrottleMiddleware,
  createMiddlewareStack,
} from '../../src/main/llm/middleware/index';
import {
  isTransientError,
} from '../../src/main/llm/middleware/error-classification';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock stream that yields the given chunks. */
function createMockStream(
  chunks: LanguageModelV4StreamPart[],
): ReadableStream<LanguageModelV4StreamPart> {
  let index = 0;
  return new ReadableStream<LanguageModelV4StreamPart>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

/** Create a mock doStream that returns the given chunks. */
function createMockDoStream(chunks: LanguageModelV4StreamPart[]) {
  return async () => ({
    stream: createMockStream(chunks),
    rawCall: { rawPrompt: '', rawSettings: {} },
    rawResponse: {},
    request: { body: '{}' },
    response: {},
  });
}

/** Create a mock doStream that fails with the given error. */
function createFailingDoStream(error: Error) {
  return async () => {
    throw error;
  };
}

/** Create a mock doStream that fails N times then succeeds. */
function createFailThenSucceedDoStream(
  failCount: number,
  error: Error,
  chunks: LanguageModelV4StreamPart[],
) {
  let attempts = 0;
  return async () => {
    if (attempts < failCount) {
      attempts++;
      throw error;
    }
    return createMockDoStream(chunks)();
  };
}

/** Collect all chunks from a stream. */
async function collectStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
  const chunks: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/** Create minimal doGenerate mock. */
function mockDoGenerate() {
  return Promise.resolve({
    text: '',
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: 'stop' as const,
    rawCall: { rawPrompt: '', rawSettings: {} },
    rawResponse: {},
    request: { body: '{}' },
    response: {},
  });
}

/** Create minimal params mock. */
function mockParams(abortSignal?: AbortSignal) {
  return {
    mode: { type: 'regular' as const },
    prompt: [],
    maxTokens: 1000,
    ...(abortSignal ? { abortSignal } : {}),
  };
}

/** Create minimal model mock. */
function mockModel() {
  return {
    specificationVersion: 'v4' as const,
    provider: 'test',
    modelId: 'test-model',
    defaultObjectGenerationMode: undefined,
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Retry middleware tests
// ---------------------------------------------------------------------------

describe('Retry middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient error with backoff and succeeds on second attempt', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 3 });
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'text-delta', id: 'txt-0', delta: 'Hello' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, textTokens: 5, reasoningTokens: undefined }, totalTokens: 15 } },
    ];

    const error = createHttpError('Rate limit exceeded', 429);
    const doStream = createFailThenSucceedDoStream(1, error, chunks);

    // Start the middleware — it will fail once then retry
    const resultPromise = middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    // Advance timers for the backoff delay
    await vi.advanceTimersByTimeAsync(500);

    const result = await resultPromise;
    const collected = await collectStream(result.stream);

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ type: 'text-delta', id: 'txt-0', delta: 'Hello' });
  });

  it('does not retry non-transient errors', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 3 });
    const error = createHttpError('Invalid request', 400);

    const doStream = createFailingDoStream(error);

    await expect(
      middleware.wrapStream!({
        doStream,
        doGenerate: mockDoGenerate,
        params: mockParams(),
        model: mockModel(),
      }),
    ).rejects.toThrow('Invalid request');
  });

  it('exhausts retries and throws last error', async () => {
    // Restore real timers for this test since we need actual backoff delays
    vi.useRealTimers();

    const middleware = createRetryMiddleware({ maxRetries: 2 });

    let doStreamCalls = 0;
    const doStream = async () => {
      doStreamCalls++;
      throw createHttpError('Server error', 500);
    };

    const resultPromise = middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    await expect(resultPromise).rejects.toThrow('Server error');
    expect(doStreamCalls).toBe(3); // initial + 2 retries
  }, 10000);

  it('cancels a setup retry backoff without starting another provider attempt', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 3 });
    const abortController = new AbortController();
    const cancellation = new Error('cancel setup retry');
    const doStream = vi.fn(async () => {
      throw createHttpError('Rate limit exceeded', 429);
    });

    const resultPromise = middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(abortController.signal),
      model: mockModel(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(doStream).toHaveBeenCalledTimes(1);

    abortController.abort(cancellation);

    await expect(resultPromise).rejects.toThrow('cancel setup retry');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(doStream).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Retry guard: no retry after content delivered
// ---------------------------------------------------------------------------

describe('Retry guard: no retry after content delivered', () => {
  it('does NOT retry after first token has been delivered', async () => {
    // Simulate: stream starts, delivers "Hello", then a transient error occurs.
    // The middleware should NOT retry because content was already delivered.
    const middleware = createRetryMiddleware({ maxRetries: 3 });

    let doStreamCalls = 0;
    const doStream = async () => {
      doStreamCalls++;
      if (doStreamCalls === 1) {
        // Yield content, then error on a later pull so contentDelivered is
        // set before the failure (sync enqueue+error can surface as error-first).
        let pulled = 0;
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            pulled++;
            if (pulled === 1) {
              controller.enqueue({ type: 'text-delta', id: 'txt-0', delta: 'Hello' });
              return;
            }
            controller.error(createHttpError('Rate limit mid-stream', 429));
          },
        });
        return {
          stream,
          rawCall: { rawPrompt: '', rawSettings: {} },
          rawResponse: {},
          request: { body: '{}' },
          response: {},
        };
      }
      // Should not reach here
      return createMockDoStream([])();
    };

    const result = await middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    const reader = result.stream.getReader();
    // Content is delivered first
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: 'text-delta', id: 'txt-0', delta: 'Hello' });
    // Then the mid-stream error propagates without retry
    await expect(reader.read()).rejects.toThrow('Rate limit mid-stream');

    // Should NOT have retried (only 1 doStream call)
    expect(doStreamCalls).toBe(1);
  });

  it('does not retry mid-stream after tool-call content was delivered', async () => {
    vi.useRealTimers();
    const middleware = createRetryMiddleware({ maxRetries: 3 });

    let doStreamCalls = 0;
    const doStream = async () => {
      doStreamCalls++;
      if (doStreamCalls === 1) {
        let pulled = 0;
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          pull(controller) {
            pulled++;
            if (pulled === 1) {
              controller.enqueue({
                type: 'tool-input-start',
                id: 'call-1',
                toolName: 'read',
              } as LanguageModelV4StreamPart);
              return;
            }
            controller.error(createHttpError('Rate limit after tool start', 429));
          },
        });
        return {
          stream,
          rawCall: { rawPrompt: '', rawSettings: {} },
          rawResponse: {},
          request: { body: '{}' },
          response: {},
        };
      }
      return createMockDoStream([])();
    };

    const result = await middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    const reader = result.stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('tool-input-start');
    await expect(reader.read()).rejects.toThrow('Rate limit after tool start');
    expect(doStreamCalls).toBe(1);
  });

  it('retries mid-stream transient error when no content was delivered yet', async () => {
    vi.useRealTimers();
    const middleware = createRetryMiddleware({ maxRetries: 3 });

    let doStreamCalls = 0;
    const doStream = async () => {
      doStreamCalls++;
      if (doStreamCalls === 1) {
        // Pre-content drop: stream errors before any text-delta
        const stream = new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.error(createHttpError('Connection reset before tokens', 502));
          },
        });
        return {
          stream,
          rawCall: { rawPrompt: '', rawSettings: {} },
          rawResponse: {},
          request: { body: '{}' },
          response: {},
        };
      }
      return createMockDoStream([
        { type: 'text-delta', id: 'txt-0', delta: 'Recovered' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, textTokens: 1, reasoningTokens: undefined },
            totalTokens: 2,
          },
        },
      ])();
    };

    const result = await middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    const collected = await collectStream(result.stream);
    expect(collected[0]).toEqual({ type: 'text-delta', id: 'txt-0', delta: 'Recovered' });
    expect(doStreamCalls).toBe(2);
  }, 10000);

  it('cancels a mid-stream retry backoff without starting another provider attempt', async () => {
    vi.useFakeTimers();
    const middleware = createRetryMiddleware({ maxRetries: 3 });
    const abortController = new AbortController();
    const cancellation = new Error('cancel stream retry');
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.error(createHttpError('Connection reset before tokens', 502));
        },
      }),
      rawCall: { rawPrompt: '', rawSettings: {} },
      rawResponse: {},
      request: { body: '{}' },
      response: {},
    }));

    const result = await middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(abortController.signal),
      model: mockModel(),
    });
    const reader = result.stream.getReader();
    const readPromise = reader.read();

    await vi.advanceTimersByTimeAsync(0);
    expect(doStream).toHaveBeenCalledTimes(1);

    abortController.abort(cancellation);

    await expect(readPromise).rejects.toThrow('cancel stream retry');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(doStream).toHaveBeenCalledTimes(1);
  });

  it('cancels the active provider reader when the request aborts', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 3 });
    const abortController = new AbortController();
    const cancellation = new Error('cancel active stream');
    const cancelProviderStream = vi.fn();
    let beganPulling: (() => void) | undefined;
    const pulling = new Promise<void>((resolve) => {
      beganPulling = resolve;
    });
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        pull() {
          beganPulling?.();
          return new Promise<void>(() => {});
        },
        cancel: cancelProviderStream,
      }),
      rawCall: { rawPrompt: '', rawSettings: {} },
      rawResponse: {},
      request: { body: '{}' },
      response: {},
    }));

    const result = await middleware.wrapStream!({
      doStream,
      doGenerate: mockDoGenerate,
      params: mockParams(abortController.signal),
      model: mockModel(),
    });
    const reader = result.stream.getReader();
    const readPromise = reader.read();
    await pulling;

    abortController.abort(cancellation);

    expect(cancelProviderStream).toHaveBeenCalledWith(cancellation);
    await expect(readPromise).rejects.toThrow('cancel active stream');
  });
});

// ---------------------------------------------------------------------------
// Transient error detection tests
// ---------------------------------------------------------------------------

describe('Transient error detection', () => {
  it('identifies errors with transient status codes', () => {
    expect(isTransientError({ statusCode: 429 })).toBe(true);
    expect(isTransientError({ statusCode: 500 })).toBe(true);
    expect(isTransientError({ statusCode: 502 })).toBe(true);
    expect(isTransientError({ statusCode: 503 })).toBe(true);
    expect(isTransientError({ statusCode: 504 })).toBe(true);
    expect(isTransientError({ statusCode: 408 })).toBe(true);
  });

  it('identifies errors with transient messages', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
    expect(isTransientError(new Error('Request timed out'))).toBe(true);
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('does NOT identify non-transient status codes as transient', () => {
    expect(isTransientError({ statusCode: 400 })).toBe(false);
    expect(isTransientError({ statusCode: 401 })).toBe(false);
  });

  it('does NOT identify unknown errors as transient', () => {
    expect(isTransientError(new Error('something weird'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Throttle middleware tests
// ---------------------------------------------------------------------------

describe('Throttle middleware', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through non-reasoning chunks immediately', async () => {
    const middleware = createThrottleMiddleware({ intervalMs: 100 });
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'text-delta', id: 'txt-0', delta: 'Hello' },
      { type: 'text-delta', id: 'txt-0', delta: ' world' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, textTokens: 5, reasoningTokens: undefined }, totalTokens: 15 } },
    ];

    const result = await middleware.wrapStream!({
      doStream: createMockDoStream(chunks),
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    const collected = await collectStream(result.stream);
    expect(collected).toEqual(chunks);
  });

  it('throttles reasoning chunks', async () => {
    const middleware = createThrottleMiddleware({ intervalMs: 100 });
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'Thinking...' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: ' still thinking' },
      { type: 'text-delta', id: 'txt-0', delta: 'Answer' },
    ];

    const result = await middleware.wrapStream!({
      doStream: createMockDoStream(chunks),
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    // First reasoning chunk should pass through immediately
    const reader = result.stream.getReader();
    const first = await reader.read();
    expect(first.value).toEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'Thinking...' });

    // Second reasoning chunk should be buffered
    // Advance time to trigger flush
    await vi.advanceTimersByTimeAsync(150);

    const second = await reader.read();
    expect(second.value).toEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: ' still thinking' });

    // Text chunk should come through
    const third = await reader.read();
    expect(third.value).toEqual({ type: 'text-delta', id: 'txt-0', delta: 'Answer' });
  });

  it('does not enqueue after stream cancel when timer fires', async () => {
    const middleware = createThrottleMiddleware({ intervalMs: 100 });
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'first' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: ' buffered' },
    ];

    const result = await middleware.wrapStream!({
      doStream: createMockDoStream(chunks),
      doGenerate: mockDoGenerate,
      params: mockParams(),
      model: mockModel(),
    });

    const reader = result.stream.getReader();
    const first = await reader.read();
    expect(first.value).toEqual({ type: 'reasoning-delta', id: 'reasoning-0', delta: 'first' });

    await reader.cancel();
    await vi.advanceTimersByTimeAsync(200);

    const after = await reader.read();
    expect(after.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Middleware stack composition tests
// ---------------------------------------------------------------------------

describe('Middleware stack composition', () => {
  it('creates a stack with retry + throttle', () => {
    const stack = createMiddlewareStack();
    expect(stack).toHaveLength(2);
  });

  it('accepts custom retry options', () => {
    const stack = createMiddlewareStack({
      retry: { maxRetries: 5 },
    });
    expect(stack).toHaveLength(2);
  });

  it('accepts custom throttle options', () => {
    const stack = createMiddlewareStack({
      throttle: { intervalMs: 200 },
    });
    expect(stack).toHaveLength(2);
  });
});
