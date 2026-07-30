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
});
