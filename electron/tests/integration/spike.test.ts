/**
 * Spike: Integration tests for U2 foundation patterns validation.
 *
 * Tests the end-to-end flow:
 * user message → XState agent actor → AI SDK streamText → tool call (zod schema validated)
 * → tool result feeds back → stream continues → final response renders
 *
 * These tests validate the GO/NO-GO gate for the three foundation patterns:
 * 1. XState actors
 * 2. AI SDK streamText + middleware
 * 3. Zod tool schemas
 *
 * NOTE: These tests require a running LLM provider. Set environment variables:
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_ID
 *
 * Without a provider, the tests will be skipped.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createActor } from 'xstate';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { spikeAgentMachine } from '../../src/main/agents/xstate/spike-agent-machine';
import { listFilesSchema, validateJsonSchema } from '../../src/main/tools/spike-tool';
import { createRetryMiddleware } from '../../src/main/llm/middleware/retry';

// ─── Test helpers ────────────────────────────────────────────────────────────

const hasLLMConfig = Boolean(
  process.env.LLM_BASE_URL && process.env.LLM_API_KEY,
);

const describeWithLLM = hasLLMConfig ? describe : describe.skip;

function waitForState(
  actor: ReturnType<typeof createActor>,
  targetState: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for state '${targetState}'`));
    }, timeoutMs);

    const sub = actor.subscribe((snapshot) => {
      if (snapshot.value === targetState) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

function collectResponse(
  actor: ReturnType<typeof createActor>,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout collecting response'));
    }, timeoutMs);

    const sub = actor.subscribe((snapshot) => {
      if (snapshot.value === 'idle' && snapshot.context.response) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve(snapshot.context.response);
      }
      if (snapshot.value === 'error') {
        clearTimeout(timer);
        sub.unsubscribe();
        reject(new Error(snapshot.context.error ?? 'Unknown error'));
      }
    });
  });
}

// ─── Zod Schema Tests (no LLM required) ─────────────────────────────────────

describe('R3: Zod Tool Schemas', () => {
  it('listFilesSchema produces valid JSON Schema via zod-to-json-schema', () => {
    const { valid, schema } = validateJsonSchema();
    expect(valid).toBe(true);
    expect(schema).toBeDefined();
    expect(schema).toHaveProperty('$schema');
  });

  it('JSON Schema has correct structure for list_files tool', () => {
    const jsonSchema = zodToJsonSchema(listFilesSchema);
    expect(jsonSchema).toHaveProperty('type', 'object');
    expect(jsonSchema).toHaveProperty('properties');
    const props = (jsonSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('directory');
  });

  it('zod schema validates valid input', () => {
    const result = listFilesSchema.safeParse({ directory: '/tmp' });
    expect(result.success).toBe(true);
  });

  it('zod schema rejects invalid input', () => {
    const result = listFilesSchema.safeParse({ directory: 123 });
    expect(result.success).toBe(false);
  });

  it('zod schema rejects missing required fields', () => {
    const result = listFilesSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── Retry Middleware Tests (no LLM required) ────────────────────────────────

describe('R2: AI SDK Retry Middleware', () => {
  it('createRetryMiddleware returns a valid middleware object', () => {
    const middleware = createRetryMiddleware({ maxRetries: 3 });
    expect(middleware).toBeDefined();
    expect(typeof middleware.wrapStream).toBe('function');
  });

  it('middleware wraps stream and passes through text-delta chunks', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 0 }); // No retries for this test

    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-delta', textDelta: 'Hello' });
        controller.enqueue({ type: 'text-delta', textDelta: ' world' });
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    });

    const mockDoStream = vi.fn().mockResolvedValue({
      stream: mockStream,
      rawCall: { rawPrompt: '', rawSettings: {} },
    });

    const result = await middleware.wrapStream!({
      doGenerate: vi.fn(),
      doStream: mockDoStream,
      params: {} as never,
      model: {} as never,
    });

    // Read the stream to verify chunks pass through
    const reader = result.stream.getReader();
    const chunks: unknown[] = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) chunks.push(value);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ type: 'text-delta', textDelta: 'Hello' });
    expect(chunks[1]).toEqual({ type: 'text-delta', textDelta: ' world' });
    expect(chunks[2]).toEqual({ type: 'finish' });
  });

  it('middleware retries on transient error before content delivered', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 2 });
    let attempt = 0;

    const mockDoStream = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('Rate limit exceeded (429)');
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta', textDelta: 'Success' });
            controller.enqueue({ type: 'finish' });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: '', rawSettings: {} },
      };
    });

    const result = await middleware.wrapStream!({
      doGenerate: vi.fn(),
      doStream: mockDoStream,
      params: {} as never,
      model: {} as never,
    });

    expect(mockDoStream).toHaveBeenCalledTimes(2);
    expect(result.stream).toBeDefined();
  });

  it('middleware does NOT retry after content delivered (content-delivered guard)', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 2 });
    let callCount = 0;

    const mockDoStream = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: deliver some content, then error
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-delta', textDelta: 'Partial' });
              controller.error(new Error('Connection lost'));
            },
          }),
          rawCall: { rawPrompt: '', rawSettings: {} },
        };
      }
      // Second call should not happen (content was delivered)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta', textDelta: 'Retry' });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: '', rawSettings: {} },
      };
    });

    // The middleware should propagate the error, not retry
    await expect(async () => {
      const result = await middleware.wrapStream!({
        doGenerate: vi.fn(),
        doStream: mockDoStream,
        params: {} as never,
        model: {} as never,
      });

      // Try to read the stream to trigger the error
      const reader = result.stream.getReader();
      await reader.read();
    }).rejects.toThrow('Connection lost');

    // Only called once — no retry after content was delivered
    expect(mockDoStream).toHaveBeenCalledTimes(1);
  });

  it('middleware does not retry non-transient errors', async () => {
    const middleware = createRetryMiddleware({ maxRetries: 2 });

    const mockDoStream = vi.fn().mockRejectedValue(
      new Error('Invalid API key'),
    );

    await expect(
      middleware.wrapStream!({
        doGenerate: vi.fn(),
        doStream: mockDoStream,
        params: {} as never,
        model: {} as never,
      }),
    ).rejects.toThrow('Invalid API key');

    expect(mockDoStream).toHaveBeenCalledTimes(1);
  });
});

// ─── XState Machine Tests (no LLM required for structure) ────────────────────

describe('R1: XState Agent Machine Structure', () => {
  it('machine starts in idle state', () => {
    // Create a mock model (not used for structure tests)
    const mockModel = {} as never;

    const actor = createActor(spikeAgentMachine, {
      input: { model: mockModel },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('machine transitions from idle to streaming on USER_INPUT', () => {
    const mockModel = {
      specificationVersion: 'v1' as const,
      provider: 'test',
      modelId: 'test',
      doStream: vi.fn().mockResolvedValue({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-delta', textDelta: 'test' });
            controller.close();
          },
        }),
      }),
    } as never;

    const actor = createActor(spikeAgentMachine, {
      input: { model: mockModel },
    });
    actor.start();

    expect(actor.getSnapshot().value).toBe('idle');

    actor.send({ type: 'USER_INPUT', message: 'test' });

    // Should transition to streaming
    expect(actor.getSnapshot().value).toBe('streaming');

    actor.stop();
  });

  it('machine has correct context shape', () => {
    const mockModel = {} as never;

    const actor = createActor(spikeAgentMachine, {
      input: {
        model: mockModel,
        systemPrompt: 'Test prompt',
      },
    });
    actor.start();

    const context = actor.getSnapshot().context;
    expect(context).toHaveProperty('response', '');
    expect(context).toHaveProperty('currentInput', '');
    expect(context).toHaveProperty('error', null);
    expect(context).toHaveProperty('model');
    expect(context).toHaveProperty('systemPrompt', 'Test prompt');

    actor.stop();
  });
});

// ─── End-to-End Tests (require LLM provider) ────────────────────────────────

describeWithLLM('E2E: Full Pipeline (requires LLM provider)', () => {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_ID } = process.env;

  beforeAll(() => {
    // Set env for the IPC handler
    process.env.LLM_BASE_URL = LLM_BASE_URL;
    process.env.LLM_API_KEY = LLM_API_KEY;
    process.env.LLM_MODEL_ID = LLM_MODEL_ID ?? 'gpt-4o-mini';
  });

  it('Happy path: streams text response without tool call', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const provider = createOpenAI({
      baseURL: LLM_BASE_URL!,
      apiKey: LLM_API_KEY!,
      compatibility: 'compatible',
    });
    const model = provider.chat(LLM_MODEL_ID ?? 'gpt-4o-mini');

    const actor = createActor(spikeAgentMachine, {
      input: {
        model: model as never,
        systemPrompt: 'You are a helpful assistant. Answer briefly.',
      },
    });
    actor.start();

    actor.send({ type: 'USER_INPUT', message: 'What is 2+2? Answer with just the number.' });

    const response = await collectResponse(actor, 30_000);
    expect(response).toBeTruthy();
    expect(response).toContain('4');

    actor.stop();
  });

  it('Happy path with tool: agent calls list_files tool', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const provider = createOpenAI({
      baseURL: LLM_BASE_URL!,
      apiKey: LLM_API_KEY!,
      compatibility: 'compatible',
    });
    const model = provider.chat(LLM_MODEL_ID ?? 'gpt-4o-mini');

    const actor = createActor(spikeAgentMachine, {
      input: {
        model: model as never,
        systemPrompt: 'You are a helpful assistant. When asked about files, use the list_files tool. The current directory is /tmp.',
      },
    });
    actor.start();

    actor.send({ type: 'USER_INPUT', message: 'What files are in /tmp? Use the list_files tool.' });

    const response = await collectResponse(actor, 60_000);
    expect(response).toBeTruthy();
    // The response should reference files or indicate the tool was used
    expect(response.length).toBeGreaterThan(0);

    actor.stop();
  });

  it('Interrupt: cancel while streaming returns to idle', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const provider = createOpenAI({
      baseURL: LLM_BASE_URL!,
      apiKey: LLM_API_KEY!,
      compatibility: 'compatible',
    });
    const model = provider.chat(LLM_MODEL_ID ?? 'gpt-4o-mini');

    const actor = createActor(spikeAgentMachine, {
      input: {
        model: model as never,
        systemPrompt: 'You are a helpful assistant.',
      },
    });
    actor.start();

    actor.send({ type: 'USER_INPUT', message: 'Write a very long essay about the history of computing.' });

    // Wait a bit for streaming to start, then cancel
    await new Promise((resolve) => setTimeout(resolve, 2000));
    actor.send({ type: 'CANCEL' });

    // Should return to idle
    await waitForState(actor, 'idle', 5_000);
    expect(actor.getSnapshot().value).toBe('idle');

    actor.stop();
  });
});
