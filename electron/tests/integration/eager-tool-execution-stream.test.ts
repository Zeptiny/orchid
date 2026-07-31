/**
 * Eager tool execution — end-to-end through streamChat (R11 headline test).
 *
 * Mocks the AI SDK (`importESM('ai')`) with a controllable `streamText` whose
 * fullStream emits two tool calls separated by a "model still generating" gate.
 * Proves the orchestrator starts the first tool executing on `tool-input-available`
 * — while the model is still generating the second tool call — rather than
 * waiting for the whole step to finish.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { importESM } from '../../src/main/utils/esm-import';
import { streamChat, type StreamEvent } from '../../src/main/llm/orchestrator';
import { ToolRegistry } from '../../src/main/tools/registry';
import { defaults } from '../../src/main/config';
import { genericToolResultDataSchema } from '../../src/shared/types/tool-result';
import type { Agent } from '../../src/shared/types/agent';
import type { ToolHandler } from '../../src/main/tools/types';

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(),
}));

const agent: Agent = {
  name: 'eager-test',
  type: 'custom' as never,
  tier: 'bloom' as never,
  description: 'test agent',
  system_prompt: '',
  allowed_tools: ['slow', 'fast'],
  allowed_skills: [],
};

describe('eager tool execution through streamChat', () => {
  let cwd: string;
  let slowHandler: ReturnType<typeof vi.fn>;
  let fastHandler: ReturnType<typeof vi.fn>;
  let releaseModel!: () => void;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-eager-stream-'));
    slowHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'slow' } }));
    fastHandler = vi.fn(async () => ({ status: 'complete' as const, data: { value: 'fast' } }));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function registerTool(registry: ToolRegistry, name: string, handler: ToolHandler): void {
    registry.register(
      {
        name,
        description: `test tool ${name}`,
        inputSchema: z.object({ x: z.number().optional() }),
        resultFamily: 'generic',
        outputDataSchema: genericToolResultDataSchema,
        category: 'search',
        riskClass: 'read',
      },
      handler,
    );
  }

  function installFakeAiSdk(): void {
    const modelGate = new Promise<void>((res) => {
      releaseModel = res;
    });
    async function* fakeFullStream(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'tool-input-available', toolCallId: 'call-A', toolName: 'slow', input: { x: 1 } };
      // The model is still generating the next tool call until the test releases.
      await modelGate;
      yield { type: 'tool-input-available', toolCallId: 'call-B', toolName: 'fast', input: { x: 2 } };
      yield { type: 'finish-step', usage: {}, finishReason: 'tool-calls' };
    }
    const fakeAi = {
      streamText: vi.fn(() => ({
        fullStream: fakeFullStream(),
        finishReason: Promise.resolve('tool-calls'),
      })),
      wrapLanguageModel: ({ model }: { model: unknown }) => model,
      isStepCount: () => () => false,
    };
    vi.mocked(importESM).mockResolvedValue(fakeAi as never);
  }

  it('starts tool A executing before the model finishes generating tool B', async () => {
    installFakeAiSdk();

    const registry = new ToolRegistry();
    registerTool(registry, 'slow', slowHandler);
    registerTool(registry, 'fast', fastHandler);

    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: '',
      context: { cwd },
      config: defaults(),
      registry,
      mcpManager: null,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });

    const events: StreamEvent[] = [];
    // Drive the generator manually (not for-await…break, which would close it).
    // Pull until tool call A is delivered, then pause — the model gate is still
    // held, so tool call B has not been generated yet.
    let sawA = false;
    while (!sawA) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
      if (value.type === 'tool_call' && value.toolCallId === 'call-A') sawA = true;
    }
    expect(sawA).toBe(true);

    // Tool A began executing from its tool-input-available chunk alone (flush the
    // permission-gate microtask), while the model is still generating tool B.
    await vi.waitFor(() => expect(slowHandler).toHaveBeenCalledOnce());
    expect(fastHandler).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool_call' && e.toolCallId === 'call-B')).toBe(false);

    // Let the model finish generating tool B and drain the rest of the stream.
    releaseModel();
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
    }

    await vi.waitFor(() => expect(fastHandler).toHaveBeenCalledOnce());
    // Each tool executed exactly once (eager start, no double-run).
    expect(slowHandler).toHaveBeenCalledOnce();

    const toolCallEvents = events.filter((e) => e.type === 'tool_call');
    const order = toolCallEvents.map((e) => (e as { toolCallId: string }).toolCallId);
    expect(order).toEqual(['call-A', 'call-B']);
    expect(events.some((e) => e.type === 'finish')).toBe(true);
  });

  function installDeltaFakeAiSdk(script: Array<Record<string, unknown>>): void {
    async function* fakeFullStream(): AsyncGenerator<Record<string, unknown>> {
      for (const part of script) yield part;
      yield { type: 'finish-step', usage: {}, finishReason: 'tool-calls' };
    }
    const fakeAi = {
      streamText: vi.fn(() => ({
        fullStream: fakeFullStream(),
        finishReason: Promise.resolve('tool-calls'),
      })),
      wrapLanguageModel: ({ model }: { model: unknown }) => model,
      isStepCount: () => () => false,
    };
    vi.mocked(importESM).mockResolvedValue(fakeAi as never);
  }

  const id = (e: StreamEvent): string => (e as { toolCallId: string }).toolCallId;

  it('executes tools from streamed deltas and emits running/completed before step end', async () => {
    // No `tool-input-available`/`tool-call` parts here — execution and UI events
    // must come entirely from the streamed-delta finalization path.
    installDeltaFakeAiSdk([
      { type: 'tool-input-start', toolCallId: 'call-A', toolName: 'slow' },
      { type: 'tool-input-delta', toolCallId: 'call-A', inputTextDelta: '{"x":' },
      { type: 'tool-input-delta', toolCallId: 'call-A', inputTextDelta: '1}' },
      // Model moves on to B → A's input is complete → A launches early (backstop).
      { type: 'tool-input-start', toolCallId: 'call-B', toolName: 'fast' },
      { type: 'tool-input-delta', toolCallId: 'call-B', inputTextDelta: '{"x":2}' },
      // B's input ends → B launches.
      { type: 'tool-input-end', toolCallId: 'call-B' },
    ]);

    const registry = new ToolRegistry();
    registerTool(registry, 'slow', slowHandler);
    registerTool(registry, 'fast', fastHandler);

    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: '',
      context: { cwd },
      config: defaults(),
      registry,
      mcpManager: null,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });

    const events: StreamEvent[] = [];
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
    }
    await vi.waitFor(() => expect(slowHandler).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fastHandler).toHaveBeenCalledOnce());

    // Both tools executed exactly once via the delta path.
    expect(slowHandler).toHaveBeenCalledOnce();
    expect(fastHandler).toHaveBeenCalledOnce();

    // `running` and `completed` events were emitted for each tool.
    const toolCalls = events.filter((e) => e.type === 'tool_call').map(id).sort();
    const toolResults = events.filter((e) => e.type === 'tool_result').map(id).sort();
    expect(toolCalls).toEqual(['call-A', 'call-B']);
    expect(toolResults).toEqual(['call-A', 'call-B']);

    // Ordering fix: A's `running` event precedes B's generation start.
    const idxCallA = events.findIndex((e) => e.type === 'tool_call' && id(e) === 'call-A');
    const idxStartB = events.findIndex((e) => e.type === 'tool_call_start' && id(e) === 'call-B');
    expect(idxCallA).toBeGreaterThanOrEqual(0);
    expect(idxStartB).toBeGreaterThan(idxCallA);

    // `completed` lands before the stream finishes (emitted during streaming).
    const idxResultA = events.findIndex((e) => e.type === 'tool_result' && id(e) === 'call-A');
    const idxFinish = events.findIndex((e) => e.type === 'finish');
    expect(idxResultA).toBeGreaterThanOrEqual(0);
    expect(idxResultA).toBeLessThan(idxFinish);
  });

  it('does not execute a tool whose streamed input is incomplete/invalid JSON', async () => {
    installDeltaFakeAiSdk([
      { type: 'tool-input-start', toolCallId: 'call-A', toolName: 'slow' },
      { type: 'tool-input-delta', toolCallId: 'call-A', inputTextDelta: '{"x":' },
      // B starts → A finalizes, but A's accumulated text is not valid JSON.
      { type: 'tool-input-start', toolCallId: 'call-B', toolName: 'fast' },
      { type: 'tool-input-delta', toolCallId: 'call-B', inputTextDelta: '{"x":2}' },
      { type: 'tool-input-end', toolCallId: 'call-B' },
    ]);

    const registry = new ToolRegistry();
    registerTool(registry, 'slow', slowHandler);
    registerTool(registry, 'fast', fastHandler);

    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: '',
      context: { cwd },
      config: defaults(),
      registry,
      mcpManager: null,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });

    while (true) {
      const { done } = await gen.next();
      if (done) break;
    }
    await vi.waitFor(() => expect(fastHandler).toHaveBeenCalledOnce());

    // A's invalid input was skipped by the delta path (no crash, no execution);
    // B (valid) still executed.
    expect(slowHandler).not.toHaveBeenCalled();
    expect(fastHandler).toHaveBeenCalledOnce();
  });

  function installGatedFakeAiSdk(
    beforeGate: Array<Record<string, unknown>>,
    afterGate: Array<Record<string, unknown>>,
    gate: Promise<void>,
  ): void {
    async function* fakeFullStream(): AsyncGenerator<Record<string, unknown>> {
      for (const part of beforeGate) yield part;
      await gate;
      for (const part of afterGate) yield part;
      yield { type: 'finish-step', usage: {}, finishReason: 'tool-calls' };
    }
    const fakeAi = {
      streamText: vi.fn(() => ({
        fullStream: fakeFullStream(),
        finishReason: Promise.resolve('tool-calls'),
      })),
      wrapLanguageModel: ({ model }: { model: unknown }) => model,
      isStepCount: () => () => false,
    };
    vi.mocked(importESM).mockResolvedValue(fakeAi as never);
  }

  it('emits exactly one tool_call and one tool_result when the delta path and the SDK batched signal both fire for the same id', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    installGatedFakeAiSdk(
      [
        { type: 'tool-input-start', toolCallId: 'call-A', toolName: 'slow' },
        { type: 'tool-input-delta', toolCallId: 'call-A', inputTextDelta: '{"x":1}' },
        // Delta path eager-starts A here.
        { type: 'tool-input-end', toolCallId: 'call-A' },
      ],
      [
        // The SDK's batched validated signal + result for the SAME id arrive later.
        { type: 'tool-input-available', toolCallId: 'call-A', toolName: 'slow', input: { x: 1 } },
        { type: 'tool-output-available', toolCallId: 'call-A', toolName: 'slow', output: {} },
      ],
      gate,
    );

    const registry = new ToolRegistry();
    registerTool(registry, 'slow', slowHandler);

    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: '',
      context: { cwd },
      config: defaults(),
      registry,
      mcpManager: null,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });

    const events: StreamEvent[] = [];
    // Drive until the delta path announces A (tool_call from the eager drain),
    // then let the SDK batched signal + result through.
    let sawCallA = false;
    while (!sawCallA) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
      if (value.type === 'tool_call' && id(value) === 'call-A') sawCallA = true;
    }
    expect(sawCallA).toBe(true);
    await vi.waitFor(() => expect(slowHandler).toHaveBeenCalledOnce());

    releaseGate();
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
    }

    // Exactly one running + one completed event for A, deduped across both paths.
    const toolCalls = events.filter((e) => e.type === 'tool_call' && id(e) === 'call-A');
    const toolResults = events.filter((e) => e.type === 'tool_result' && id(e) === 'call-A');
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    // The eager (complete) result won, not the SDK output's generic fallback.
    const result = toolResults[0] as { execution: { canonical: { status: string } } };
    expect(result.execution.canonical.status).toBe('complete');
    // And the handler ran exactly once across both triggers.
    expect(slowHandler).toHaveBeenCalledOnce();
  });

  it('cancelling the turn aborts an eagerly-started tool (settles to cancelled)', async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((res) => {
      releaseHandler = res;
    });
    let capturedSignal: AbortSignal | undefined;
    const gatingHandler = vi.fn(async (_args: unknown, ctx: { abortSignal?: AbortSignal }) => {
      capturedSignal = ctx.abortSignal;
      await handlerGate;
      return { status: 'complete' as const, data: { value: 'should-be-cancelled' } };
    });
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((res) => {
      releaseModel = res;
    });
    installGatedFakeAiSdk(
      [
        { type: 'tool-input-start', toolCallId: 'call-A', toolName: 'slow' },
        { type: 'tool-input-delta', toolCallId: 'call-A', inputTextDelta: '{"x":1}' },
        { type: 'tool-input-end', toolCallId: 'call-A' },
      ],
      [],
      modelGate,
    );

    const registry = new ToolRegistry();
    registerTool(registry, 'slow', gatingHandler);

    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: '',
      context: { cwd },
      config: defaults(),
      registry,
      mcpManager: null,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });

    const events: StreamEvent[] = [];
    let sawCallA = false;
    while (!sawCallA) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
      if (value.type === 'tool_call' && id(value) === 'call-A') sawCallA = true;
    }
    await vi.waitFor(() => expect(gatingHandler).toHaveBeenCalledOnce());

    // The eager execution received an abort signal derived from the turn signal.
    expect(capturedSignal).toBeDefined();
    controller.abort();
    expect(capturedSignal!.aborted).toBe(true);

    // Let the handler unwind; executeToolCall sees the aborted parent → cancelled.
    releaseHandler();
    releaseModel();
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
    }

    const resultA = events.find(
      (e) => e.type === 'tool_result' && id(e) === 'call-A',
    ) as { execution: { canonical: { status: string } } } | undefined;
    expect(resultA).toBeDefined();
    expect(resultA!.execution.canonical.status).toBe('cancelled');
  });

  it('idle watchdog does not abort a legitimately-running delta-path eager tool', async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((res) => {
      releaseHandler = res;
    });
    let markHandlerComplete!: () => void;
    const handlerComplete = new Promise<void>((resolve) => {
      markHandlerComplete = resolve;
    });
    const gatingHandler = vi.fn(async () => {
      await handlerGate;
      markHandlerComplete();
      return { status: 'complete' as const, data: { value: 'ok' } };
    });

    // Quiet period (300ms) longer than the idle timeout (100ms); a real stream
    // aborts here if the idle watchdog fires, so this is abort-aware.
    async function* fakeFullStream(signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'tool-input-start', toolCallId: 'call-A', toolName: 'slow' };
      yield { type: 'tool-input-delta', toolCallId: 'call-A', inputTextDelta: '{"x":1}' };
      yield { type: 'tool-input-end', toolCallId: 'call-A' };
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      yield { type: 'finish-step', usage: {}, finishReason: 'tool-calls' };
    }
    const fakeAi = {
      streamText: vi.fn((opts: { abortSignal?: AbortSignal }) => ({
        fullStream: fakeFullStream(opts.abortSignal),
        finishReason: Promise.resolve('tool-calls'),
      })),
      wrapLanguageModel: ({ model }: { model: unknown }) => model,
      isStepCount: () => () => false,
    };
    vi.mocked(importESM).mockResolvedValue(fakeAi as never);

    const registry = new ToolRegistry();
    registerTool(registry, 'slow', gatingHandler);

    const controller = new AbortController();
    const gen = streamChat({
      messages: [],
      agent,
      systemPrompt: '',
      context: { cwd },
      // 0.1s idle timeout; the tool runs (gated) through a 300ms quiet model tail.
      config: { ...defaults(), llm_stream_idle_timeout: 0.1 },
      registry,
      mcpManager: null,
      abortSignal: controller.signal,
      modelInstance: {} as never,
    });

    const events: StreamEvent[] = [];
    let released = false;
    while (true) {
      const { value, done } = await gen.next();
      if (done) break;
      events.push(value);
      if (!released && value.type === 'step_finish') {
        releaseHandler();
        await handlerComplete;
        released = true;
      }
    }

    expect(gatingHandler).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === 'finish')).toBe(true);
    expect(
      events.some((e) => e.type === 'error' && (e as { title: string }).title === 'Stream idle timeout'),
    ).toBe(false);
    const idxResult = events.findIndex((e) => e.type === 'tool_result' && id(e) === 'call-A');
    const idxFinish = events.findIndex((e) => e.type === 'finish');
    expect(idxResult).toBeGreaterThanOrEqual(0);
    expect(idxResult).toBeLessThan(idxFinish);
  });
});
