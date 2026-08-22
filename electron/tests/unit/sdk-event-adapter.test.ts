import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  classifyStreamError,
  createToolNameResolver,
  SdkEventAdapter,
  toProviderMcpToolName,
} from '../../src/main/llm/stream/sdk-event-adapter';
import type { MCPManager } from '../../src/main/mcp/manager';
import type { EagerToolBridge } from '../../src/main/llm/stream/eager-tool-bridge';
import type { StreamAttemptController } from '../../src/main/llm/stream/attempt-controller';
import {
  createCanonicalToolResult,
  type ToolExecutionResult,
} from '../../src/shared/types/tool-result';
import type { Usage } from '../../src/shared/types/message';

function execution(content: string): ToolExecutionResult {
  return {
    canonical: createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value: content },
    }),
    agentProjection: { content, completeness: 'complete' },
  };
}

function createAdapter() {
  const attempt = {
    armIdleTimer: vi.fn(),
    markDeliveredOutput: vi.fn(),
  } as unknown as Pick<StreamAttemptController, 'armIdleTimer' | 'markDeliveredOutput'>;
  const bridge = {
    flushActiveInput: vi.fn(),
    inputStarted: vi.fn(),
    inputDelta: vi.fn(),
    inputEnded: vi.fn(),
    sdkToolCall: vi.fn(({ toolCallId, toolName, args }) => ({
      type: 'tool_call' as const, toolCallId, toolName, args,
    })),
    sdkToolResult: vi.fn((toolCallId, result) => ({
      type: 'tool_result' as const,
      toolCallId,
      content: (result as ToolExecutionResult).agentProjection.content,
      execution: result,
    })),
    sdkToolError: vi.fn((toolCallId, result) => ({
      type: 'tool_result' as const,
      toolCallId,
      content: (result as ToolExecutionResult).agentProjection.content,
      execution: result,
    })),
    sdkInputError: vi.fn(({ toolCallId, toolName, args, execution: result }) => [
      { type: 'tool_call' as const, toolCallId, toolName, args },
      {
        type: 'tool_result' as const,
        toolCallId,
        content: (result as ToolExecutionResult).agentProjection.content,
        execution: result as ToolExecutionResult,
      },
    ]),
    drainEagerStarts: vi.fn(function* () {}),
    drainEvents: vi.fn(function* () {}),
  } as unknown as EagerToolBridge;
  const buildUsage = vi.fn((usage: { inputTokens?: number }, messages: readonly ModelMessage[]): Usage => ({
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: 2,
    total_tokens: (usage.inputTokens ?? 0) + 2,
    cached_tokens: 0,
    context: {
      input_tokens: messages.length,
      output_tokens: 2,
      used_tokens: (usage.inputTokens ?? 0) + 2,
      system_tokens: 0,
      tools_tokens: 0,
      tool_use_tokens: 0,
      user_tokens: messages.length,
      assistant_tokens: 0,
    },
  }));
  const initialMessages = [{ role: 'user', content: 'initial' }] as unknown as readonly ModelMessage[];
  return {
    adapter: new SdkEventAdapter({
      coreMessages: initialMessages,
      resolveToolName: (toolName) => toolName,
      attempt,
      eagerBridge: bridge,
      buildUsage,
    }),
    attempt,
    bridge,
    buildUsage,
  };
}

function adapt(adapter: SdkEventAdapter, part: Record<string, unknown>) {
  return [...adapter.adapt(part)];
}

describe('SdkEventAdapter', () => {
  it('captures start-step request messages and emits indexed finish-step usage', () => {
    const { adapter, bridge, buildUsage } = createAdapter();
    const requestMessages = [{ role: 'user', content: 'fresh request' }] as unknown as ModelMessage[];

    expect(adapt(adapter, { type: 'start-step', request: { messages: requestMessages } })).toEqual([]);
    expect(adapt(adapter, { type: 'finish-step', finishReason: 'tool-calls', usage: { inputTokens: 7 } })).toEqual([
      expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ prompt_tokens: 7 }) }),
      { type: 'step_finish', stepIndex: 0, finishReason: 'tool-calls' },
    ]);
    expect(adapt(adapter, { type: 'finish-step', usage: { inputTokens: 9 } })).toEqual([
      expect.anything(),
      { type: 'step_finish', stepIndex: 1, finishReason: 'unknown' },
    ]);
    expect(buildUsage.mock.calls[0]?.[1]).toBe(requestMessages);
    expect(bridge.flushActiveInput).toHaveBeenCalledTimes(2);
  });

  it('restores compaction summary markers the SDK echo dropped (R19)', () => {
    const marker = { rangeStart: 'a', rangeEnd: 'b', mode: 'simple' as const };
    const attempt = { armIdleTimer: vi.fn(), markDeliveredOutput: vi.fn() } as unknown as Pick<StreamAttemptController, 'armIdleTimer' | 'markDeliveredOutput'>;
    const buildUsage = vi.fn((): Usage => ({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
    }));
    const coreMessages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'handoff', compacted: marker },
    ] as unknown as readonly ModelMessage[];
    const adapter = new SdkEventAdapter({
      coreMessages,
      resolveToolName: (toolName) => toolName,
      attempt,
      eagerBridge: { flushActiveInput: vi.fn(), drainEagerStarts: vi.fn(function* () {}), drainEvents: vi.fn(function* () {}) } as unknown as EagerToolBridge,
      buildUsage,
    });

    // SDK rebuilt the prefix without the marker and appended a step response.
    const echo = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'handoff' },
      { role: 'assistant', content: 'new step text' },
    ] as unknown as ModelMessage[];

    adapt(adapter, { type: 'start-step', request: { messages: echo } });
    adapt(adapter, { type: 'finish-step', usage: { inputTokens: 5 } });

    const passed = buildUsage.mock.calls[0]?.[1] as Array<{ compacted?: unknown }>;
    expect(passed).toHaveLength(3);
    expect(passed[1]?.compacted).toEqual(marker);
    // Untouched entries stay by reference; the appended step response is not annotated.
    expect(passed[0]).toBe(echo[0]);
    expect(passed[2]?.compacted).toBeUndefined();
  });

  it('passes per-step output chars to buildUsage and resets them each step', () => {
    const { adapter, buildUsage } = createAdapter();

    adapt(adapter, { type: 'start-step' });
    adapt(adapter, { type: 'text-delta', text: 'answer' });
    adapt(adapter, { type: 'reasoning-delta', delta: 'think hard' });
    adapt(adapter, { type: 'tool-input-delta', toolCallId: 'tc-1', delta: '{"a":1}' });
    adapt(adapter, { type: 'finish-step', usage: { inputTokens: 7 } });

    expect(buildUsage.mock.calls[0]?.[2]).toEqual({
      reasoning: 10,
      text: 6,
      tool: 7,
    });

    adapt(adapter, { type: 'start-step' });
    adapt(adapter, { type: 'text-delta', text: 'second' });
    adapt(adapter, { type: 'finish-step', usage: { inputTokens: 9 } });

    expect(buildUsage.mock.calls[1]?.[2]).toEqual({ reasoning: 0, text: 6, tool: 0 });
  });

  it('normalizes text/textDelta and reasoning text/delta while notifying the attempt', () => {
    const { adapter, attempt, bridge } = createAdapter();

    expect(adapt(adapter, { type: 'text-delta', text: 'hello' })).toEqual([{ type: 'content', text: 'hello' }]);
    expect(adapt(adapter, { type: 'text-delta', textDelta: ' world' })).toEqual([{ type: 'content', text: ' world' }]);
    expect(adapt(adapter, { type: 'reasoning-delta', text: 'think' })).toEqual([{ type: 'thinking', text: 'think' }]);
    expect(adapt(adapter, { type: 'reasoning', delta: ' more' })).toEqual([{ type: 'thinking', text: ' more' }]);
    expect(attempt.armIdleTimer).toHaveBeenCalledTimes(4);
    expect(attempt.markDeliveredOutput).toHaveBeenCalledTimes(4);
    expect(bridge.flushActiveInput).toHaveBeenCalledTimes(4);
  });

  it('normalizes streamed input aliases and both available/call tool shapes', () => {
    const { adapter, bridge } = createAdapter();

    expect(adapt(adapter, { type: 'tool-input-start', id: 'one', toolName: 'read' })).toEqual([
      { type: 'tool_call_start', toolCallId: 'one', toolName: 'read' },
    ]);
    expect(adapt(adapter, { type: 'tool-input-delta', id: 'one', delta: '{"path"' })).toEqual([
      { type: 'tool_call_delta', toolCallId: 'one', argsDelta: '{"path"' },
    ]);
    expect(adapt(adapter, { type: 'tool-input-end', id: 'one' })).toEqual([]);
    expect(adapt(adapter, { type: 'tool-input-available', toolCallId: 'one', toolName: 'read', input: { path: '/a' } })).toEqual([
      { type: 'tool_call', toolCallId: 'one', toolName: 'read', args: '{"path":"/a"}' },
    ]);
    expect(adapt(adapter, { type: 'tool-call', id: 'two', toolName: 'grep', args: { pattern: 'x' } })).toEqual([
      { type: 'tool_call', toolCallId: 'two', toolName: 'grep', args: '{"pattern":"x"}' },
    ]);
    expect(bridge.inputStarted).toHaveBeenCalledWith('one', 'read');
    expect(bridge.inputDelta).toHaveBeenCalledWith('one', '{"path"');
    expect(bridge.inputEnded).toHaveBeenCalledWith('one');
    expect(bridge.sdkToolCall).toHaveBeenCalledTimes(2);
  });

  it('counts whole-delivered tool input as tool-use chars, deduped against streamed deltas', () => {
    const { adapter, buildUsage } = createAdapter();
    adapt(adapter, { type: 'start-step' });

    // Whole delivery: no tool-input-delta parts preceded this call.
    adapt(adapter, { type: 'tool-call', toolCallId: 'whole', toolName: 'read', input: { path: '/a/b/c'.repeat(20) } });
    // Streamed delivery: chars arrive via deltas, the final part must not
    // double-count them.
    adapt(adapter, { type: 'tool-input-start', toolCallId: 'streamed', toolName: 'grep' });
    adapt(adapter, { type: 'tool-input-delta', toolCallId: 'streamed', inputTextDelta: '{"pattern":"x' });
    adapt(adapter, { type: 'tool-input-delta', toolCallId: 'streamed', inputTextDelta: '"}' });
    adapt(adapter, { type: 'tool-input-available', toolCallId: 'streamed', toolName: 'grep', input: { pattern: 'x' } });
    adapt(adapter, {
      type: 'finish-step',
      usage: { inputTokens: 10, outputTokens: 40 },
    });

    const chars = buildUsage.mock.calls[0]?.[2];
    expect(chars?.tool).toBe(JSON.stringify({ path: '/a/b/c'.repeat(20) }).length + '{"pattern":"x"}'.length);
  });

  it('resets per-step tool-input dedupe state at the next start-step', () => {
    const { adapter, buildUsage } = createAdapter();
    adapt(adapter, { type: 'start-step' });
    adapt(adapter, { type: 'tool-call', toolCallId: 'whole', toolName: 'read', input: { path: '/a' } });
    adapt(adapter, { type: 'finish-step', usage: { inputTokens: 10, outputTokens: 40 } });
    // Next step re-delivers the same call id — it must count again (fresh
    // dedupe state), not be suppressed by the previous step's set.
    adapt(adapter, { type: 'start-step' });
    adapt(adapter, { type: 'tool-call', toolCallId: 'whole', toolName: 'read', input: { path: '/a' } });
    adapt(adapter, { type: 'finish-step', usage: { inputTokens: 12, outputTokens: 40 } });

    const stepOne = buildUsage.mock.calls[0]?.[2];
    const stepTwo = buildUsage.mock.calls[1]?.[2];
    expect(stepOne?.tool).toBe(JSON.stringify({ path: '/a' }).length);
    expect(stepTwo?.tool).toBe(JSON.stringify({ path: '/a' }).length);
  });

  it('emits finalized eager starts before a new streamed start without draining completions', () => {
    const { adapter, bridge } = createAdapter();
    vi.mocked(bridge.drainEagerStarts).mockImplementation(function* () {
      yield { type: 'tool_call', toolCallId: 'eager', toolName: 'read', args: '{}' };
    });
    vi.mocked(bridge.drainEvents).mockImplementation(function* () {
      yield {
        type: 'tool_result',
        toolCallId: 'eager',
        content: 'done',
        execution: execution('done'),
      };
    });

    expect(adapt(adapter, {
      type: 'tool-input-start',
      toolCallId: 'streaming',
      toolName: 'grep',
    })).toEqual([
      { type: 'tool_call', toolCallId: 'eager', toolName: 'read', args: '{}' },
      { type: 'tool_call_start', toolCallId: 'streaming', toolName: 'grep' },
    ]);
    expect(bridge.drainEvents).not.toHaveBeenCalled();
  });

  it('reverses provider-safe MCP aliases before invoking the bridge', () => {
    const { bridge } = createAdapter();
    const internalName = 'mcp::filesystem/read file';
    const getTools = vi.fn(() => [{ definition: { name: internalName } }]);
    const mcpManager = {
      getTools,
    } as unknown as MCPManager;
    const aliasAdapter = new SdkEventAdapter({
      coreMessages: [] as unknown as readonly ModelMessage[],
      resolveToolName: createToolNameResolver(mcpManager),
      attempt: {
        armIdleTimer: vi.fn(),
        markDeliveredOutput: vi.fn(),
      } as unknown as Pick<StreamAttemptController, 'armIdleTimer' | 'markDeliveredOutput'>,
      eagerBridge: bridge,
      buildUsage: () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 }),
    });

    expect(adapt(aliasAdapter, {
      type: 'tool-call',
      toolCallId: 'mcp-call',
      toolName: toProviderMcpToolName(internalName),
      input: {},
    })).toEqual([
      { type: 'tool_call', toolCallId: 'mcp-call', toolName: internalName, args: '{}' },
    ]);
    adapt(aliasAdapter, {
      type: 'tool-input-start',
      toolCallId: 'mcp-call-2',
      toolName: toProviderMcpToolName(internalName),
    });
    expect(getTools).toHaveBeenCalledOnce();
  });

  it('normalizes successful, error, and invalid-input tool terminal paths', () => {
    const { adapter, bridge } = createAdapter();
    const result = execution('ok');

    expect(adapt(adapter, { type: 'tool-output-available', toolCallId: 'ok', toolName: 'read', output: result })).toEqual([
      expect.objectContaining({ type: 'tool_result', toolCallId: 'ok', content: 'ok' }),
    ]);
    expect(adapt(adapter, { type: 'tool-error', id: 'bad', toolName: 'read', errorText: 'provider failed' })).toEqual([
      expect.objectContaining({ type: 'tool_result', toolCallId: 'bad', content: expect.stringContaining('provider failed') }),
    ]);
    expect(adapt(adapter, { type: 'tool-input-error', id: 'invalid', toolName: 'read', input: { path: 1 }, error: 'bad input' })).toEqual([
      { type: 'tool_call', toolCallId: 'invalid', toolName: 'read', args: '{"path":1}' },
      expect.objectContaining({ type: 'tool_result', toolCallId: 'invalid', content: expect.stringContaining('bad input') }),
    ]);
    expect(bridge.sdkToolResult).toHaveBeenCalledWith('ok', result);
    expect(bridge.sdkToolError).toHaveBeenCalledOnce();
    expect(bridge.sdkInputError).toHaveBeenCalledOnce();
  });

  it('classifies provider error parts without treating them as thrown stream failures', () => {
    const { adapter } = createAdapter();
    expect(adapt(adapter, { type: 'error', errorText: 'request timed out waiting for provider' })).toEqual([
      { type: 'error', title: 'Request Timed Out', detail: 'request timed out waiting for provider' },
    ]);
  });

  it('bounds nested error extraction while preserving ordinary and last-error messages', () => {
    expect(classifyStreamError({
      errors: [new Error('first'), new Error('last')],
    }).detail).toBe('last');

    const cyclic: { errors: unknown[] } = { errors: [] };
    cyclic.errors.push(cyclic);
    expect(classifyStreamError(cyclic)).toEqual({
      title: 'Unexpected Error',
      detail: '[object Object]',
    });
  });
});
