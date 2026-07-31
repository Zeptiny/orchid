import { describe, expect, it, vi } from 'vitest';
import { EagerToolExecutor } from '../../src/main/llm/eager-tool-executor';
import {
  EagerToolBridge,
  type EagerToolBridgeEvent,
} from '../../src/main/llm/stream/eager-tool-bridge';
import {
  createCanonicalToolResult,
  type ToolExecutionResult,
} from '../../src/shared/types/tool-result';

function execution(value: string): ToolExecutionResult {
  return {
    canonical: createCanonicalToolResult('generic', {
      status: 'complete',
      data: { value },
    }),
    agentProjection: { content: value, completeness: 'complete' },
  };
}

function createBridge() {
  const eager = new EagerToolExecutor();
  const pauseIdleForTool = vi.fn();
  const resumeIdleAfterTool = vi.fn();
  const markDeliveredOutput = vi.fn();
  const bridge = new EagerToolBridge({
    eager,
    abortSignal: new AbortController().signal,
    pauseIdleForTool,
    resumeIdleAfterTool,
    markDeliveredOutput,
  });
  return { eager, bridge, pauseIdleForTool, resumeIdleAfterTool, markDeliveredOutput };
}

function drain(bridge: EagerToolBridge): EagerToolBridgeEvent[] {
  return [...bridge.drainEvents()];
}

describe('EagerToolBridge', () => {
  it('launches valid streamed JSON at input end and drains its early events', async () => {
    const { eager, bridge, pauseIdleForTool, resumeIdleAfterTool } = createBridge();
    const launch = vi.fn(async (_id: string, input: unknown) => execution(JSON.stringify(input)));
    eager.registerLauncher('read', launch);

    bridge.inputStarted('call-1', 'read');
    bridge.inputDelta('call-1', '{"path":"/tmp/a"}');
    bridge.inputEnded('call-1');

    expect(drain(bridge)).toEqual([
      { type: 'tool_call', toolCallId: 'call-1', toolName: 'read', args: '{"path":"/tmp/a"}' },
    ]);
    await bridge.flush();
    expect(drain(bridge)).toEqual([
      expect.objectContaining({ type: 'tool_result', toolCallId: 'call-1', content: '{"path":"/tmp/a"}' }),
    ]);
    expect(launch).toHaveBeenCalledOnce();
    expect(pauseIdleForTool).toHaveBeenCalledOnce();
    expect(resumeIdleAfterTool).toHaveBeenCalledOnce();
  });

  it('leaves incomplete JSON to the SDK validation path', () => {
    const { eager, bridge, pauseIdleForTool } = createBridge();
    const launch = vi.fn(async () => execution('unexpected'));
    eager.registerLauncher('read', launch);

    bridge.inputStarted('call-bad', 'read');
    bridge.inputDelta('call-bad', '{"path":');
    bridge.inputEnded('call-bad');

    expect(drain(bridge)).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(pauseIdleForTool).not.toHaveBeenCalled();
  });

  it('uses next-input and text boundaries as input-end backstops', async () => {
    const { eager, bridge } = createBridge();
    const launch = vi.fn(async (id: string) => execution(id));
    eager.registerLauncher('read', launch);

    bridge.inputStarted('call-a', 'read');
    bridge.inputDelta('call-a', '{"n":1}');
    bridge.inputStarted('call-b', 'read'); // finalizes A without input-end
    bridge.inputDelta('call-b', '{"n":2}');
    bridge.flushActiveInput(); // text/reasoning/step boundary finalizes B

    expect(drain(bridge).map((event) => event.toolCallId)).toEqual(['call-a', 'call-b']);
    await bridge.flush();
    expect(launch.mock.calls.map(([id]) => id)).toEqual(['call-a', 'call-b']);
  });

  it('reconciles SDK calls with an eager run exactly once', async () => {
    const { eager, bridge } = createBridge();
    const launch = vi.fn(async () => execution('done'));
    eager.registerLauncher('read', launch);

    bridge.inputStarted('call-once', 'read');
    bridge.inputDelta('call-once', '{"path":"a"}');
    bridge.inputEnded('call-once');
    expect(drain(bridge)).toHaveLength(1);

    expect(bridge.sdkToolCall({
      toolCallId: 'call-once',
      toolName: 'read',
      args: '{"path":"a"}',
      rawInput: { path: 'a' },
      providerExecuted: false,
      invalid: false,
    })).toBeUndefined();
    await bridge.flush();
    expect(launch).toHaveBeenCalledOnce();
    expect(drain(bridge)).toHaveLength(1);
  });

  it('drains an eager completion before the SDK emits its batch result', async () => {
    const { eager, bridge } = createBridge();
    let resolve!: (result: ToolExecutionResult) => void;
    const pending = new Promise<ToolExecutionResult>((done) => { resolve = done; });
    eager.registerLauncher('read', () => pending);

    bridge.inputStarted('call-early', 'read');
    bridge.inputDelta('call-early', '{"path":"a"}');
    bridge.inputEnded('call-early');
    drain(bridge);
    resolve(execution('early result'));
    await bridge.flush();

    expect(drain(bridge)).toEqual([
      expect.objectContaining({ type: 'tool_result', toolCallId: 'call-early', content: 'early result' }),
    ]);
  });

  it('deduplicates SDK and step-fallback call/result IDs', () => {
    const { bridge } = createBridge();
    const sdk = bridge.sdkToolCall({
      toolCallId: 'call-dupe', toolName: 'read', args: '{}', rawInput: {},
      providerExecuted: true, invalid: false,
    });
    bridge.queuePendingToolCall({ toolCallId: 'call-dupe', toolName: 'read', args: '{}' });
    bridge.queuePendingToolResult({ toolCallId: 'call-dupe', content: 'fallback', execution: execution('fallback') });
    const result = bridge.sdkToolResult('call-dupe', execution('sdk'));

    expect(sdk).toMatchObject({ type: 'tool_call', toolCallId: 'call-dupe' });
    expect(result).toMatchObject({ type: 'tool_result', toolCallId: 'call-dupe', content: 'sdk' });
    expect(drain(bridge)).toEqual([]);
  });

  it('balances pause/resume accounting for overlapping eager tools', async () => {
    const { eager, bridge, pauseIdleForTool, resumeIdleAfterTool } = createBridge();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = new Promise<ToolExecutionResult>((done) => { releaseA = () => done(execution('a')); });
    const b = new Promise<ToolExecutionResult>((done) => { releaseB = () => done(execution('b')); });
    eager.registerLauncher('read', (id) => id === 'call-a' ? a : b);

    bridge.inputStarted('call-a', 'read');
    bridge.inputDelta('call-a', '{}');
    bridge.inputEnded('call-a');
    bridge.inputStarted('call-b', 'read');
    bridge.inputDelta('call-b', '{}');
    bridge.inputEnded('call-b');
    expect(pauseIdleForTool).toHaveBeenCalledTimes(2);

    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resumeIdleAfterTool).toHaveBeenCalledTimes(1);
    releaseB();
    await bridge.flush();
    expect(resumeIdleAfterTool).toHaveBeenCalledTimes(2);
  });
});
