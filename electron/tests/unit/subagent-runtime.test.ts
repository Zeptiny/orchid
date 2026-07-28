/**
 * Subagent runtime — spawn with mock runner accumulates usage on the chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SubagentManager,
  SubagentQueueFullError,
  SubagentState,
  runtimeToDomain,
} from '../../src/main/agents/manager';
import type { Agent } from '../../src/shared/types/agent';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import { sumSubagentUsage } from '../../src/shared/usage';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import type { SubagentDeltaEvent, SubagentLiveProjection } from '../../src/shared/types/subagent';
import { defaults } from '../../src/main/config/schema';
import type { Config } from '../../src/shared/types/ipc-boundary';

/**
 * The manager reads `subagents.usage_event_interval_ms` from the live config
 * at emission time through a top-level `getConfig` import (a lazy `require`
 * of the TS loader does not resolve under Vitest, which would pin tests to
 * the fallback). Overriding `getConfig` here lets a test pin that interval;
 * when no override is set the real loader is used so every other test keeps
 * its existing behavior.
 */
const configOverride = vi.hoisted(() => ({ current: null as Config | null }));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => configOverride.current ?? actual.getConfig(),
  };
});

function successfulToolResult(
  toolCallId: string,
  content: string,
): Extract<StreamEvent, { type: 'tool_result' }> {
  const canonical = createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: content },
  });
  return {
    type: 'tool_result',
    toolCallId,
    content,
    isError: false,
    execution: {
      canonical,
      agentProjection: { content, completeness: 'complete' },
    },
  };
}

const testAgent: Agent = {
  name: 'explorer',
  type: 'subagent',
  tier: 'bloom',
  description: 'test',
  system_prompt: 'You explore.',
  allowed_tools: ['read', 'grep'],
  allowed_skills: [],
};

describe('SubagentManager runtime', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
    configOverride.current = null;
  });

  afterEach(() => {
    configOverride.current = null;
  });

  it('preserves frozen owner-window affinity into a background runner', async () => {
    let release!: () => void;
    const parentTurnFinalized = new Promise<void>((resolve) => { release = resolve; });
    const received: Array<{ sessionId?: string; windowId?: string }> = [];
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      await parentTurnFinalized;
      received.push({ sessionId: params.sessionId, windowId: params.windowId });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('affinity', 'inspect', testAgent, {
      sessionId: 'session-affinity',
      windowId: 'window-10',
    });
    expect(record.windowId).toBe('window-10');

    release();
    await record._runPromise;

    expect(received).toEqual([{ sessionId: 'session-affinity', windowId: 'window-10' }]);
  });

  it('exposes live text and ordered changes before completion', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'Hello ' };
      yield { type: 'content', text: 'live' };
      await paused;
      yield { type: 'finish', finishReason: 'stop' };
    });
    const sequences: number[] = [];
    manager.setOnDelta((event) => {
      sequences.push(event.sequence);
    });

    const record = manager.spawn('live', 'watch', testAgent, { sessionId: 's-live' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(record.state).toBe(SubagentState.RUNNING);
    expect(record.live.segments).toEqual([{ kind: 'text', id: expect.any(String), content: 'Hello live' }]);
    expect(record.chain?.messages).toHaveLength(1);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    release();
    await record._runPromise;
    expect(record.live.segments).toEqual([]);
    expect(record.chain?.messages.filter((message) => message.content === 'Hello live')).toHaveLength(1);
  });

  it('keeps text, thinking, and tool snapshots in stable chronological order', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'before' };
      yield { type: 'thinking', text: 'reason' };
      yield { type: 'tool_call_start', toolCallId: 'tool-1', toolName: 'grep' };
      yield { type: 'tool_call_delta', toolCallId: 'tool-1', argsDelta: '{"q":' };
      yield { type: 'tool_call', toolCallId: 'tool-1', toolName: 'grep', args: '{"q":1}' };
      yield successfulToolResult('tool-1', 'match');
      yield { type: 'content', text: 'after' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const liveSegmentIds: string[] = [];
    manager.setOnDelta((event) => {
      if (
        (event.type === 'text_delta' || event.type === 'thinking_delta') &&
        !liveSegmentIds.includes(event.segmentId)
      ) {
        liveSegmentIds.push(event.segmentId);
      }
    });
    const record = manager.spawn('ordered', 'inspect', testAgent);
    await record._runPromise;

    const types = record.chain?.messages.map((message) => message.type) ?? [];
    expect(types).toEqual(['text', 'text', 'thinking', 'tool_call', 'tool_result', 'text']);
    const transcript = record.chain?.messages.slice(1) ?? [];
    expect(transcript.map((message) => message.content)).toEqual(['before', 'reason', '', 'match', 'after']);
    expect(transcript.filter((message) => message.type === 'text' || message.type === 'thinking')
      .map((message) => message.id)).toEqual(liveSegmentIds);
    expect(record.chain?.messages.at(-1)?.content).toBe('after');
    expect(record.live.toolCalls).toEqual([]);
    expect(record.live.segments).toEqual([]);
  });

  it('materializes text-thinking-text tails in emission order with segment IDs', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'first' };
      yield { type: 'thinking', text: 'middle' };
      yield { type: 'content', text: 'last' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const record = manager.spawn('tail-order', 'inspect', testAgent);
    await record._runPromise;
    const messages = record.chain?.messages.slice(1) ?? [];
    expect(messages.map((message) => message.content)).toEqual(['first', 'middle', 'last']);
    expect(messages.map((message) => message.type)).toEqual(['text', 'thinking', 'text']);
    expect(new Set(messages.map((message) => message.id)).size).toBe(3);
  });

  it('commits a thinking-text prefix before a tool boundary', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'thinking', text: 'reason first' };
      yield { type: 'content', text: 'answer next' };
      yield { type: 'tool_call', toolCallId: 'tool-prefix', toolName: 'grep', args: '{}' };
      yield successfulToolResult('tool-prefix', 'done');
      yield { type: 'finish', finishReason: 'stop' };
    });
    const record = manager.spawn('prefix-order', 'inspect', testAgent);
    await record._runPromise;
    expect((record.chain?.messages ?? []).slice(1).map((message) => message.type))
      .toEqual(['thinking', 'text', 'tool_call', 'tool_result']);
  });

  it('checkpoint conversion materializes a live tail without mutating canonical messages', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'partial' };
      await paused;
    });
    const record = manager.spawn('checkpoint', 'partial', testAgent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const before = record.chain?.messages.length;
    const checkpoint = manager.toDomainRecords()[0];
    const canonical = runtimeToDomain(record, { includeLiveTail: false });
    expect(checkpoint.chain.messages.at(-1)?.content).toBe('partial');
    expect(canonical.chain.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(record.live.segments.map((segment) => segment.content)).toEqual(['partial']);
    expect(record.chain?.messages.length).toBe(before);

    release();
    manager.cancelOne(record.id);
    await record._runPromise;
  });

  it('materializes interleaved live segments chronologically with usage on text', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'before' };
      yield { type: 'thinking', text: 'reason' };
      yield { type: 'content', text: 'after' };
      yield { type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cached_tokens: 0 } };
      await paused;
    });
    const record = manager.spawn('ordered-tail', 'partial', testAgent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tail = runtimeToDomain(record).chain.messages.slice(1);
    expect(tail.map((message) => [message.type, message.content])).toEqual([
      ['text', 'before'], ['thinking', 'reason'], ['text', 'after'],
    ]);
    expect(tail.filter((message) => message.type === 'text').map((message) => message.usage)).toEqual([
      null, record.usage,
    ]);

    release();
    manager.cancelOne(record.id);
    await record._runPromise;
  });

  it('isolates live sequence identity and ownership for concurrent sessions', async () => {
    const gates = new Map<string, () => void>();
    manager.setRunner(async function* ({ sessionId }): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: sessionId };
      await new Promise<void>((resolve) => gates.set(sessionId!, resolve));
    });
    const deltas: Array<{ sessionId: string; subagentId: string; sequence: number }> = [];
    manager.setOnDelta((event) => deltas.push({
      sessionId: event.sessionId,
      subagentId: event.subagentId,
      sequence: event.sequence,
    }));
    const a = manager.spawn('a', 'a', testAgent, { sessionId: 'session-a' });
    const b = manager.spawn('b', 'b', testAgent, { sessionId: 'session-b' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(a.live.sessionId).toBe('session-a');
    expect(b.live.sessionId).toBe('session-b');
    expect(a.live.sequence).toBeGreaterThan(0);
    expect(b.live.sequence).toBeGreaterThan(0);
    const aDeltas = deltas.filter((event) => event.subagentId === a.id);
    const bDeltas = deltas.filter((event) => event.subagentId === b.id);
    expect(aDeltas.every((event) => event.sessionId === 'session-a')).toBe(true);
    expect(bDeltas.every((event) => event.sessionId === 'session-b')).toBe(true);
    expect(Math.max(...aDeltas.map((event) => event.sequence))).toBe(a.live.sequence);
    expect(Math.max(...bDeltas.map((event) => event.sequence))).toBe(b.live.sequence);
    manager.cancelOne(a.id);
    manager.cancelOne(b.id);
    gates.get('session-a')?.();
    gates.get('session-b')?.();
    await Promise.all([a._runPromise, b._runPromise]);
  });

  it('starts a runner and records usage on the chain', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'Hello ' };
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 50,
          context: {
            input_tokens: 100,
            output_tokens: 20,
            used_tokens: 120,
            system_tokens: 10,
            tools_tokens: 20,
            tool_use_tokens: 30,
            user_tokens: 40,
            assistant_tokens: 20,
          },
        },
      };
      yield { type: 'content', text: 'world' };
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cached_tokens: 0,
          context: {
            input_tokens: 10,
            output_tokens: 5,
            used_tokens: 15,
            system_tokens: 1,
            tools_tokens: 2,
            tool_use_tokens: 3,
            user_tokens: 4,
            assistant_tokens: 5,
          },
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('t1', 'do stuff', testAgent, {
      parentChainIndex: 2,
    });
    // Runner starts immediately — may already be running before we await.
    expect(record._runPromise).not.toBeNull();

    await record._runPromise;

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.result).toBe('Hello world');
    expect(record.usage?.prompt_tokens).toBe(110);
    expect(record.usage?.completion_tokens).toBe(25);
    expect(record.usage?.cached_tokens).toBe(50);
    expect(record.usage?.context).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      used_tokens: 15,
    });

    const domain = runtimeToDomain(record);
    expect(domain.parentChainIndex).toBe(2);
    expect(domain.status).toBe('completed');
    const summed = sumSubagentUsage(domain);
    expect(summed?.prompt_tokens).toBe(110);
    expect(summed?.completion_tokens).toBe(25);
    expect(summed?.context).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      used_tokens: 15,
    });
    expect(domain.chain?.messages.at(-1)?.usage?.context).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      used_tokens: 15,
    });
  });

  it('records tools interleaved with text', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'Looking…' };
      yield {
        type: 'tool_call',
        toolCallId: 'tc1',
        toolName: 'grep',
        args: '{"pattern":"foo"}',
      };
      yield successfulToolResult('tc1', 'match');
      yield { type: 'content', text: 'Found it.' };
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 40,
          completion_tokens: 8,
          total_tokens: 48,
          cached_tokens: 0,
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('t2', 'find foo', testAgent);
    await record._runPromise;

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.result).toBe('Looking…Found it.');
    const types = record.chain?.messages.map((m) => m.type) ?? [];
    // user, asst (Looking), tool_call, tool_result, asst (Found it)
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types.filter((t) => t === 'text').length).toBeGreaterThanOrEqual(2);
  });

  it('marks failed when runner throws', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'partial' };
      throw new Error('boom');
    });

    const record = manager.spawn('t3', 'fail', testAgent);
    await record._runPromise;

    expect(record.state).toBe(SubagentState.FAILED);
    expect(record.error).toContain('boom');
  });

  it('cancelOne aborts a running subagent', async () => {
    let released = false;
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'start' };
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (params.abortSignal.aborted || released) {
            clearInterval(t);
            resolve();
          }
        }, 10);
      });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('t4', 'slow', testAgent);
    // Let it enter running
    await new Promise((r) => setTimeout(r, 30));
    expect(record.state).toBe(SubagentState.RUNNING);

    const cancelled = manager.cancelOne(record.id);
    released = true;
    expect(cancelled).toBe(true);
    expect(record.state).toBe(SubagentState.INTERRUPTED);

    await record._runPromise;
  });

  it('commits the partial tail before the terminal interruption projection', async () => {
    manager.setRunner(async function* ({ abortSignal }): AsyncGenerator<StreamEvent> {
      yield { type: 'thinking', text: 'reason' };
      yield { type: 'content', text: 'partial' };
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (abortSignal.aborted) { clearInterval(timer); resolve(); }
        }, 5);
      });
    });
    const terminalChanges: Array<{ state: string; messages: string[] }> = [];
    manager.setOnDelta((event) => {
      if (event.type !== 'terminal') return;
      const current = manager.getRecord(event.subagentId);
      terminalChanges.push({
        state: event.state,
        messages: (current?.chain?.messages ?? []).map((message) => message.content),
      });
    });
    const record = manager.spawn('interrupt-tail', 'partial', testAgent, { sessionId: 's-interrupt' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.cancelOne(record.id)).toBe(true);
    await record._runPromise;

    expect(terminalChanges).toHaveLength(1);
    expect(terminalChanges[0]).toEqual({ state: SubagentState.INTERRUPTED, messages: ['partial', 'reason', 'partial'] });
    expect(record.chain?.messages.map((message) => message.content)).toEqual(['partial', 'reason', 'partial']);
  });

  it('interrupt flushes in-flight partial assistant text into chain/result', async () => {
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'partial answer' };
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          params.abortSignal.removeEventListener('abort', onAbort);
          resolve();
        };
        if (params.abortSignal.aborted) {
          resolve();
          return;
        }
        params.abortSignal.addEventListener('abort', onAbort);
      });
    });

    const record = manager.spawn('t-partial', 'stream then cancel', testAgent, {
      sessionId: 'session-partial',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(record.state).toBe(SubagentState.RUNNING);

    expect(manager.cancelOne(record.id)).toBe(true);
    await record._runPromise;

    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(record.result).toBe('partial answer');
    const texts =
      record.chain?.messages
        .filter((m) => m.type === 'text' && m.role === 'assistant')
        .map((m) => m.content) ?? [];
    expect(texts.some((t) => t?.includes('partial answer'))).toBe(true);
    expect(record.chain?.status).toBe('interrupted');
  });

  it('chain.sessionId is parent session UUID, not subagent id', () => {
    const parentSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const record = manager.spawn('explorer', 'inspect', testAgent, {
      sessionId: parentSessionId,
    });

    expect(record.sessionId).toBe(parentSessionId);
    expect(record.chain).not.toBeNull();
    expect(record.chain!.sessionId).toBe(parentSessionId);
    expect(record.chain!.sessionId).not.toBe(record.id);
    expect(record.chain!.id).not.toBe(record.id);

    const domain = runtimeToDomain(record);
    expect(domain.chain?.sessionId).toBe(parentSessionId);
  });

  it('persists the assigned display name and registry role', () => {
    const record = manager.spawn('review auth flow', 'Review authentication', testAgent);

    const domain = runtimeToDomain(record);

    expect(domain.agent_name).toBe('review auth flow');
    expect(domain.agent_type).toBe('explorer');
  });

  it('without runner stays pending until markCompleted', () => {
    const record = manager.spawn('manual', 'task', testAgent);
    expect(record.state).toBe(SubagentState.PENDING);
    expect(record._runPromise).toBeNull();
    manager.markCompleted(record.id, 'done');
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.result).toBe('done');
  });

  it('toDomainRecords includes chain usage for session sync', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'ok' };
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
          cached_tokens: 0,
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const record = manager.spawn('t5', 'x', testAgent, { parentChainIndex: 0 });
    await record._runPromise;
    const domain = manager.toDomainRecords();
    expect(domain).toHaveLength(1);
    expect(domain[0].id).toBe(record.id);
    expect(sumSubagentUsage(domain[0])?.prompt_tokens).toBe(5);
  });

  it('tracks sessionId on spawn and scopes cancelRunning / toDomainRecords', () => {
    const a = manager.spawn('a', 'task a', testAgent, { sessionId: 'session-a' });
    const b = manager.spawn('b', 'task b', testAgent, { sessionId: 'session-b' });
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    expect(a.sessionId).toBe('session-a');
    expect(b.sessionId).toBe('session-b');
    expect(a.chain?.sessionId).toBe('session-a');
    expect(b.chain?.sessionId).toBe('session-b');

    const cancelled = manager.cancelRunning('session-a');
    expect(cancelled).toEqual([a.id]);
    expect(a.state).toBe(SubagentState.INTERRUPTED);
    expect(b.state).toBe(SubagentState.RUNNING);

    expect(manager.toDomainRecords('session-b')).toHaveLength(1);
    expect(manager.toDomainRecords('session-b')[0].id).toBe(b.id);
    expect(manager.toDomainRecords('session-a')[0].status).toBe('interrupted');
  });
});

describe('SubagentManager delta emission (U2)', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
  });

  /** Assert a delta list is strictly monotonic (unique + ascending) on a field. */
  function expectStrictlyMonotonic(values: number[]): void {
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  }

  it('emits one text_delta per content event plus a single spawned and terminal', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'Hello ' };
      yield { type: 'content', text: 'delta ' };
      yield { type: 'content', text: 'world' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const deltas: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => deltas.push(event));

    const record = manager.spawn('delta-text', 'watch', testAgent, { sessionId: 's-delta-text' });
    await record._runPromise;

    const textDeltas = deltas.filter(
      (d): d is Extract<SubagentDeltaEvent, { type: 'text_delta' }> => d.type === 'text_delta',
    );
    expect(deltas.filter((d) => d.type === 'spawned')).toHaveLength(1);
    expect(deltas.filter((d) => d.type === 'terminal')).toHaveLength(1);
    expect(textDeltas).toHaveLength(3);

    // All appends target one segment and concatenate to the final content (no re-sends).
    expect(new Set(textDeltas.map((d) => d.segmentId)).size).toBe(1);
    expect(textDeltas.map((d) => d.append).join('')).toBe('Hello delta world');
  });

  it('keeps sequence and sessionRevision strictly monotonic on the success path', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'a' };
      yield { type: 'content', text: 'b' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const deltas: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => deltas.push(event));
    const record = manager.spawn('mono-ok', 'x', testAgent, { sessionId: 's-mono-ok' });
    await record._runPromise;

    expect(deltas.length).toBeGreaterThanOrEqual(4);
    expectStrictlyMonotonic(deltas.map((d) => d.sequence));
    expectStrictlyMonotonic(deltas.map((d) => d.sessionRevision));
  });

  it('keeps sequence and sessionRevision strictly monotonic on the interrupt path', async () => {
    manager.setRunner(async function* ({ abortSignal }): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'partial' };
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (abortSignal.aborted) { clearInterval(timer); resolve(); }
        }, 5);
      });
    });
    const deltas: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => deltas.push(event));
    const record = manager.spawn('mono-int', 'x', testAgent, { sessionId: 's-mono-int' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.cancelOne(record.id)).toBe(true);
    await record._runPromise;

    expect(deltas.filter((d) => d.type === 'terminal')).toHaveLength(1);
    expect(deltas.at(-1)?.type).toBe('terminal');
    expectStrictlyMonotonic(deltas.map((d) => d.sequence));
    expectStrictlyMonotonic(deltas.map((d) => d.sessionRevision));
  });

  it('serves a live snapshot deep-equal to the projection at the last emitted delta', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'snap' };
      yield { type: 'thinking', text: 'thought' };
      yield { type: 'tool_call_start', toolCallId: 'tc-snap', toolName: 'grep' };
      await paused;
      yield { type: 'finish', finishReason: 'stop' };
    });
    let lastProjection: SubagentLiveProjection | null = null;
    manager.setOnDelta((event) => {
      const current = manager.getRecord(event.subagentId);
      if (current) lastProjection = structuredClone(current.live);
    });
    const record = manager.spawn('parity', 'x', testAgent, { sessionId: 's-parity' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastProjection).not.toBeNull();
    expect(manager.getLiveProjection(record.id)).toEqual(lastProjection);

    release();
    await record._runPromise;
  });

  it('carries the authoritative durable record on the terminal delta', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'done' };
      yield { type: 'usage', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 0 } };
      yield { type: 'finish', finishReason: 'stop' };
    });
    let terminal: Extract<SubagentDeltaEvent, { type: 'terminal' }> | null = null;
    manager.setOnDelta((event) => {
      if (event.type === 'terminal') terminal = event;
    });
    const record = manager.spawn('terminal-record', 'x', testAgent, { sessionId: 's-terminal' });
    await record._runPromise;

    expect(terminal).not.toBeNull();
    expect(terminal!.record).toEqual(runtimeToDomain(record, { includeLiveTail: true }));
    expect(terminal!.state).toBe('completed');
    expect(terminal!.usage).toEqual(record.usage);
  });

  it('throttles usage deltas within one interval and carries final usage on terminal', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      for (let i = 0; i < 5; i += 1) {
        yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 } };
      }
      yield { type: 'finish', finishReason: 'stop' };
    });
    const usageDeltas: Array<Extract<SubagentDeltaEvent, { type: 'usage' }>> = [];
    let terminal: Extract<SubagentDeltaEvent, { type: 'terminal' }> | null = null;
    manager.setOnDelta((event) => {
      if (event.type === 'usage') usageDeltas.push(event);
      if (event.type === 'terminal') terminal = event;
    });
    const record = manager.spawn('usage-throttle', 'x', testAgent, { sessionId: 's-usage' });
    await record._runPromise;

    // Five usage events in one interval collapse to a throttled emission (first only).
    expect(usageDeltas.length).toBeGreaterThanOrEqual(1);
    expect(usageDeltas.length).toBeLessThanOrEqual(2);
    expect(record.usage?.total_tokens).toBe(10);
    expect(terminal!.usage).toEqual(record.usage);
  });

  it('suppresses intermediate usage deltas when subagents.usage_event_interval_ms is large', async () => {
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, usage_event_interval_ms: 3_600_000 },
    };
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      for (let i = 0; i < 5; i += 1) {
        yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 } };
      }
      yield { type: 'finish', finishReason: 'stop' };
    });
    const usageDeltas: Array<Extract<SubagentDeltaEvent, { type: 'usage' }>> = [];
    manager.setOnDelta((event) => {
      if (event.type === 'usage') usageDeltas.push(event);
    });
    const record = manager.spawn('usage-large-interval', 'x', testAgent, { sessionId: 's-usage-large' });
    await record._runPromise;

    // A huge interval read live from config keeps only the first (seed) emission.
    expect(usageDeltas).toHaveLength(1);
    expect(record.usage?.total_tokens).toBe(10);
  });

  it('emits every usage delta when subagents.usage_event_interval_ms is 0', async () => {
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, usage_event_interval_ms: 0 },
    };
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      for (let i = 0; i < 5; i += 1) {
        yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 } };
      }
      yield { type: 'finish', finishReason: 'stop' };
    });
    const usageDeltas: Array<Extract<SubagentDeltaEvent, { type: 'usage' }>> = [];
    manager.setOnDelta((event) => {
      if (event.type === 'usage') usageDeltas.push(event);
    });
    const record = manager.spawn('usage-zero-interval', 'x', testAgent, { sessionId: 's-usage-zero' });
    await record._runPromise;

    // A zero interval disables throttling: one delta per provider usage event.
    expect(usageDeltas).toHaveLength(5);
    expect(record.usage?.total_tokens).toBe(10);
  });

  it('deep-copies live projections so sequential reads never alias run state', () => {
    const record = manager.spawn('copy', 'x', testAgent, { sessionId: 's-copy' });
    const first = manager.getLiveProjection(record.id);
    const second = manager.getLiveProjection(record.id);
    expect(first).not.toBe(second);
    expect(first?.segments).not.toBe(second?.segments);
    expect(first).toEqual(second);
  });
});

describe('SubagentManager admission control (U7)', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
    configOverride.current = null;
  });

  afterEach(() => {
    configOverride.current = null;
    vi.useRealTimers();
  });

  function setLimits(overrides: Partial<Config['subagents']>): void {
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, ...overrides },
    };
  }

  it('parks a third spawn as queued under max_active_per_session 2 and admits it exactly once on the first terminal', async () => {
    setLimits({ max_active_per_session: 2 });
    const gates: Array<() => void> = [];
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      yield { type: 'content', text: 'done' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const events: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => events.push(event));

    const first = manager.spawn('first', 'x', testAgent, { sessionId: 'sess-admit' });
    const second = manager.spawn('second', 'x', testAgent, { sessionId: 'sess-admit' });
    const third = manager.spawn('third', 'x', testAgent, { sessionId: 'sess-admit' });

    expect(first.state).toBe(SubagentState.RUNNING);
    expect(second.state).toBe(SubagentState.RUNNING);
    expect(third.state).toBe(SubagentState.QUEUED);
    expect(third._runPromise).toBeNull();
    expect(third.queuedAt).not.toBeNull();
    expect(third.startedAt).toBeNull();
    // Queued records stay out of durable tracking until admission.
    expect(third.persistRevision).toBe(0);
    expect(manager.getQueuePosition(third.id)).toBe(1);
    expect(gates).toHaveLength(2);

    // The spawned seed carries the queued status for the third record.
    const spawnedStates = events
      .filter((event): event is Extract<SubagentDeltaEvent, { type: 'spawned' }> => event.type === 'spawned')
      .map((event) => event.record.status);
    expect(spawnedStates).toEqual(['pending', 'pending', 'queued']);

    // First terminal admits the queued record exactly once: pending→running.
    gates[0]();
    await first._runPromise;
    expect(third.state).toBe(SubagentState.RUNNING);
    expect(third._runPromise).not.toBeNull();
    expect(third.startedAt).not.toBeNull();
    expect(third.persistRevision).toBeGreaterThan(0);
    expect(manager.getQueuePosition(third.id)).toBeNull();
    expect(gates).toHaveLength(3);

    gates[1]();
    gates[2]();
    await Promise.all([second._runPromise, third._runPromise]);

    const terminalOrder = events
      .filter((event) => event.type === 'terminal')
      .map((event) => event.subagentId);
    expect(terminalOrder[0]).toBe(first.id);
    expect(new Set(terminalOrder)).toEqual(new Set([first.id, second.id, third.id]));
  });

  it('admits queued sessions round-robin when max_active_global is 1', async () => {
    setLimits({ max_active_global: 1 });
    const gates = new Map<string, () => void>();
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => { gates.set(params.agentScopeId, resolve); });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const a1 = manager.spawn('a1', 'x', testAgent, { sessionId: 'session-a' });
    const b1 = manager.spawn('b1', 'x', testAgent, { sessionId: 'session-b' });
    const a2 = manager.spawn('a2', 'x', testAgent, { sessionId: 'session-a' });
    const b2 = manager.spawn('b2', 'x', testAgent, { sessionId: 'session-b' });

    expect(a1.state).toBe(SubagentState.RUNNING);
    expect(b1.state).toBe(SubagentState.QUEUED);
    expect(a2.state).toBe(SubagentState.QUEUED);
    expect(b2.state).toBe(SubagentState.QUEUED);

    gates.get(a1.id)!();
    await a1._runPromise;
    expect(b1.state).toBe(SubagentState.RUNNING);
    expect(a2.state).toBe(SubagentState.QUEUED);

    gates.get(b1.id)!();
    await b1._runPromise;
    expect(a2.state).toBe(SubagentState.RUNNING);
    expect(b2.state).toBe(SubagentState.QUEUED);

    gates.get(a2.id)!();
    await a2._runPromise;
    expect(b2.state).toBe(SubagentState.RUNNING);

    gates.get(b2.id)!();
    await b2._runPromise;
    expect(manager.allRecords().every((record) => record.state === SubagentState.COMPLETED)).toBe(true);
  });

  it('rejects spawns with SubagentQueueFullError when the queue is full, leaking no record', () => {
    setLimits({ max_active_global: 1, max_active_per_session: 1, max_queued: 2 });

    manager.spawn('active', 'x', testAgent, { sessionId: 'sess-full' });
    const q1 = manager.spawn('q1', 'x', testAgent, { sessionId: 'sess-full' });
    const q2 = manager.spawn('q2', 'x', testAgent, { sessionId: 'sess-full' });
    expect(q1.state).toBe(SubagentState.QUEUED);
    expect(q2.state).toBe(SubagentState.QUEUED);
    expect(manager.getQueuePosition(q2.id)).toBe(2);

    let thrown: unknown;
    try {
      manager.spawn('q3', 'x', testAgent, { sessionId: 'sess-full' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SubagentQueueFullError);
    const queueFull = thrown as SubagentQueueFullError;
    expect(queueFull.maxQueued).toBe(2);
    expect(queueFull.message).toContain('max_queued=2');
    expect(queueFull.message).toContain('max_active_global=1');
    expect(manager.allRecords()).toHaveLength(3);
    expect(manager.allRecords().some((record) => record.label === 'q3')).toBe(false);
  });

  it('cancelling a queued record emits terminal interrupted without consuming a run slot', async () => {
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const running = manager.spawn('running', 'x', testAgent, { sessionId: 'sess-cancel' });
    const queued = manager.spawn('queued', 'x', testAgent, { sessionId: 'sess-cancel' });
    const queued2 = manager.spawn('queued2', 'x', testAgent, { sessionId: 'sess-cancel' });
    expect(queued.state).toBe(SubagentState.QUEUED);

    const events: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => events.push(event));
    const waitPromise = manager.wait([queued.id]);

    expect(manager.cancelOne(queued.id)).toBe(true);
    expect(queued.state).toBe(SubagentState.INTERRUPTED);
    expect(queued.endTime).not.toBeNull();
    expect(queued._runPromise).toBeNull();
    expect(queued.startedAt).toBeNull();
    expect(manager.getQueuePosition(queued.id)).toBeNull();

    const terminal = events.find(
      (event): event is Extract<SubagentDeltaEvent, { type: 'terminal' }> =>
        event.type === 'terminal' && event.subagentId === queued.id,
    );
    expect(terminal).toBeDefined();
    expect(terminal!.state).toBe('interrupted');
    expect(terminal!.record.status).toBe('interrupted');

    const waited = await waitPromise;
    expect(waited.get(queued.id)?.state).toBe(SubagentState.INTERRUPTED);

    // No slot was freed: the running record and the second queued record are untouched.
    expect(running.state).toBe(SubagentState.RUNNING);
    expect(queued2.state).toBe(SubagentState.QUEUED);
    expect(gates).toHaveLength(1);

    gates[0]();
    await running._runPromise;
    // The running terminal admits queued2, never the cancelled record.
    expect(queued2.state).toBe(SubagentState.RUNNING);
  });

  it('reports queue wait and execution time separately in record timing', async () => {
    vi.useFakeTimers();
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const first = manager.spawn('first', 'x', testAgent, { sessionId: 'sess-timing' });
    vi.advanceTimersByTime(100);
    const second = manager.spawn('second', 'x', testAgent, { sessionId: 'sess-timing' });
    expect(second.state).toBe(SubagentState.QUEUED);
    expect(second.queuedAt).toBe(Date.now());
    expect(second.startedAt).toBeNull();

    const stateOf = (id: string) => manager.getStates('sess-timing').find((entry) => entry.id === id)!;
    expect(stateOf(second.id).state).toBe(SubagentState.QUEUED);
    expect(stateOf(second.id).elapsed).toBe(0);
    vi.advanceTimersByTime(500);
    // A queued entry's prompt-context elapsed is its queue wait.
    expect(stateOf(second.id).elapsed).toBe(500);

    gates[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.state).toBe(SubagentState.RUNNING);
    expect(second.startedAt).toBe(second.queuedAt! + 500);
    // Post-admission elapsed excludes the queue wait.
    expect(stateOf(second.id).elapsed).toBe(0);

    await vi.advanceTimersByTimeAsync(10);
    gates[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.state).toBe(SubagentState.COMPLETED);

    const queueWait = second.startedAt! - second.queuedAt!;
    const execution = second.endTime! - second.startedAt!;
    expect(queueWait).toBe(500);
    expect(execution).toBe(10);
    expect(second.endTime! - second.queuedAt!).toBe(queueWait + execution);
    expect(stateOf(second.id).elapsed).toBe(execution);
    expect(first.state).toBe(SubagentState.COMPLETED);
  });
});

describe('SubagentManager terminal eviction and session purge (U9)', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
    configOverride.current = null;
  });

  afterEach(() => {
    configOverride.current = null;
    vi.useRealTimers();
  });

  function setConfig(overrides: Partial<Config['subagents']>): void {
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, ...overrides },
    };
  }

  it('K > retention terminal completions: manager holds at most retention summaries plus active records', () => {
    setConfig({ terminal_retention: 3 });
    const sid = 'sess-evict';
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const record = manager.spawn(`task-${i}`, `do ${i}`, testAgent, { sessionId: sid });
      manager.markCompleted(record.id, `result-${i}`);
      ids.push(record.id);
    }
    // All 5 are terminal; confirm persistence for all.
    manager.confirmRecordsPersisted(sid, ids);

    const remaining = manager.allRecords().filter((r) => r.sessionId === sid);
    expect(remaining).toHaveLength(3);
    // Oldest two evicted entirely.
    expect(remaining.map((r) => r.id)).toEqual(ids.slice(2));
    // Surviving summaries retain terminal state.
    for (const record of remaining) {
      expect(record.state).toBe(SubagentState.COMPLETED);
      expect(record.chain?.messages).toEqual([]);
    }
  });

  it('active records are never evicted even when over retention', () => {
    setConfig({ terminal_retention: 2 });
    const sid = 'sess-active-safe';
    const terminalIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const record = manager.spawn(`t-${i}`, 'x', testAgent, { sessionId: sid });
      manager.markCompleted(record.id, 'done');
      terminalIds.push(record.id);
    }
    const active = manager.spawn('active', 'x', testAgent, { sessionId: sid });
    manager.confirmRecordsPersisted(sid, terminalIds);

    const remaining = manager.allRecords().filter((r) => r.sessionId === sid);
    // 2 summaries + 1 active
    expect(remaining).toHaveLength(3);
    expect(remaining.some((r) => r.id === active.id)).toBe(true);
    expect(active.state).toBe(SubagentState.PENDING);
  });

  it('queued records are never evicted', () => {
    setConfig({ terminal_retention: 1, max_active_per_session: 1 });
    const sid = 'sess-queued-safe';
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'finish', finishReason: 'stop' };
    });
    const running = manager.spawn('running', 'x', testAgent, { sessionId: sid });
    const queued = manager.spawn('queued', 'x', testAgent, { sessionId: sid });
    expect(queued.state).toBe(SubagentState.QUEUED);

    manager.markCompleted(running.id, 'done');
    manager.confirmRecordsPersisted(sid, [running.id, queued.id]);

    // Queued record is not terminal, so confirmRecordsPersisted ignores it.
    expect(manager.getRecord(queued.id)).toBeDefined();
  });

  it('_runPromise is null after settlement on success, failure, and interrupt paths', async () => {
    const gates: Array<() => void> = [];
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      if (params.task === 'fail') throw new Error('boom');
      yield { type: 'content', text: 'ok' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const success = manager.spawn('s', 'succeed', testAgent, { sessionId: 's-rp' });
    const failure = manager.spawn('f', 'fail', testAgent, { sessionId: 's-rp' });
    const interrupted = manager.spawn('i', 'interrupt-me', testAgent, { sessionId: 's-rp' });

    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.cancelOne(interrupted.id);

    gates[0]();
    gates[1]();
    gates[2]();
    await Promise.all([success._runPromise, failure._runPromise, interrupted._runPromise].filter(Boolean));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(success.state).toBe(SubagentState.COMPLETED);
    expect(success._runPromise).toBeNull();
    expect(failure.state).toBe(SubagentState.FAILED);
    expect(failure._runPromise).toBeNull();
    expect(interrupted.state).toBe(SubagentState.INTERRUPTED);
    expect(interrupted._runPromise).toBeNull();
  });

  it('evicted summary retains id/state/result/error/usage/timings; chain messages empty; getStates renders', () => {
    setConfig({ terminal_retention: 5 });
    const sid = 'sess-summary';
    const record = manager.spawn('summarized', 'important task', testAgent, { sessionId: sid });
    manager.markRunning(record.id);
    record.usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    manager.markCompleted(record.id, 'the result');
    expect(record._evicted).toBe(false);

    manager.confirmRecordsPersisted(sid, [record.id]);

    const summary = manager.getRecord(record.id)!;
    expect(summary).toBeDefined();
    expect(summary._evicted).toBe(true);
    expect(summary.id).toBe(record.id);
    expect(summary.state).toBe(SubagentState.COMPLETED);
    expect(summary.result).toBe('the result');
    expect(summary.error).toBeNull();
    expect(summary.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(summary.startTime).toBeTypeOf('number');
    expect(summary.endTime).toBeTypeOf('number');
    expect(summary.chain?.messages).toEqual([]);
    expect(summary.projectRuntime).toBeUndefined();
    expect(summary._runPromise).toBeNull();
    expect(summary.abortController).toBeNull();
    expect(summary.live.segments).toEqual([]);
    expect(summary.live.toolCalls).toEqual([]);

    const states = manager.getStates(sid);
    const entry = states.find((s) => s.id === record.id);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('explorer');
    expect(entry!.state).toBe(SubagentState.COMPLETED);
    expect(entry!.task).toBe('important task');
  });

  it('the _evicted flag never leaks into the domain (storage/IPC) record shape', () => {
    const sid = 'sess-flag-leak';
    const heavy = manager.spawn('heavy', 'task', testAgent, { sessionId: sid });
    manager.markCompleted(heavy.id, 'done');
    manager.confirmRecordsPersisted(sid, [heavy.id]);
    expect(heavy._evicted).toBe(true);

    // The storage dict is built from runtimeToDomain's output; a leak here
    // would surface runtime-only state in session rows and IPC snapshots.
    expect('_evicted' in runtimeToDomain(heavy)).toBe(false);
    expect(JSON.stringify(runtimeToDomain(heavy))).not.toContain('"_evicted"');
  });

  it('eviction does NOT happen if the flush fails (record stays heavy)', () => {
    setConfig({ terminal_retention: 1 });
    const sid = 'sess-noflush';
    const record = manager.spawn('heavy', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');

    // Without calling confirmRecordsPersisted, the record stays heavy.
    expect(record.chain?.messages.length).toBeGreaterThan(0);
    expect(manager.allRecords().filter((r) => r.sessionId === sid)).toHaveLength(1);
    expect(record.chain?.messages.length).toBeGreaterThan(0);
  });

  it('session purge: 2 running + 1 queued + 1 terminal → all removed, running cancelled with terminal deltas', async () => {
    setConfig({ max_active_per_session: 2 });
    const sid = 'sess-purge';
    const events: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => events.push(event));
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (params.abortSignal.aborted) return resolve();
        params.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const run1 = manager.spawn('r1', 'x', testAgent, { sessionId: sid });
    const run2 = manager.spawn('r2', 'x', testAgent, { sessionId: sid });
    const queued = manager.spawn('q1', 'x', testAgent, { sessionId: sid });
    const otherSession = manager.spawn('t1', 'x', testAgent, { sessionId: 'other-session' });
    manager.markCompleted(otherSession.id, 'done');

    const termInSession = manager.spawn('t2', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(termInSession.id, 'done');

    expect(queued.state).toBe(SubagentState.QUEUED);
    const beforeCount = manager.allRecords().filter((r) => r.sessionId === sid).length;
    expect(beforeCount).toBe(4);

    manager.purgeSession(sid);
    // Allow abort-aware runners to settle their async paths.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterRecords = manager.allRecords().filter((r) => r.sessionId === sid);
    expect(afterRecords).toHaveLength(0);
    expect(manager.getRecord(otherSession.id)).toBeDefined();

    // Terminal deltas emitted for the cancelled running and queued records.
    const terminalEvents = events.filter(
      (e) => e.type === 'terminal' && e.sessionId === sid,
    );
    expect(terminalEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('purgeSession resets the per-session revision counter (no slow leak, review #11)', () => {
    const sid = 'sess-purge-revisions';
    const record = manager.spawn('r1', 'x', testAgent, { sessionId: sid });
    manager.markRunning(record.id);
    expect(manager.getSessionRevision(sid)).toBeGreaterThan(0);

    manager.purgeSession(sid);

    expect(manager.getSessionRevision(sid)).toBe(0);
    // A same-id session recreated later starts the revision sequence fresh.
    const replacement = manager.spawn('r2', 'x', testAgent, { sessionId: sid });
    expect(manager.getSessionRevision(sid)).toBe(0);
    manager.markRunning(replacement.id);
    expect(manager.getSessionRevision(sid)).toBeGreaterThan(0);
  });

  it('cancelling a queued record evicts it to a retention-capped summary (review #15)', () => {
    setConfig({ terminal_retention: 2, max_active_per_session: 1 });
    const sid = 'sess-queued-evict';
    // One admitted record holds the only run slot; later spawns park in queue.
    const active = manager.spawn('active', 'x', testAgent, { sessionId: sid });
    expect(active.state).toBe(SubagentState.PENDING);

    const queuedIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const record = manager.spawn(`q-${i}`, 'x', testAgent, { sessionId: sid });
      expect(record.state).toBe(SubagentState.QUEUED);
      expect(manager.cancelOne(record.id)).toBe(true);
      queuedIds.push(record.id);
      // Cancelled while queued → evicted to a lean summary, not a full record.
      expect(record._evicted).toBe(true);
      expect(record.state).toBe(SubagentState.INTERRUPTED);
      expect(record.chain?.messages).toEqual([]);
    }

    // The retention FIFO caps them: oldest removed entirely, newest two kept.
    expect(manager.getRecord(queuedIds[0])).toBeUndefined();
    expect(manager.allRecords().filter((r) => r.sessionId === sid)
      .map((r) => r.id)).toEqual([active.id, queuedIds[1], queuedIds[2]]);

    // Re-confirming already-evicted summaries is a harmless no-op.
    manager.confirmRecordsPersisted(sid, queuedIds);
    expect(manager.getRecord(queuedIds[1])?._evicted).toBe(true);
    expect(manager.allRecords().filter((r) => r.sessionId === sid)).toHaveLength(3);
  });

  it('wait_for_subagent on an evicted terminal record resolves with correct status', async () => {
    setConfig({ terminal_retention: 5 });
    const sid = 'sess-wait-evicted';
    const record = manager.spawn('waited', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'wait-result');
    manager.confirmRecordsPersisted(sid, [record.id]);

    // Record is now a summary but still in the manager.
    const summary = manager.getRecord(record.id)!;
    expect(summary.state).toBe(SubagentState.COMPLETED);

    const results = await manager.wait([record.id]);
    const waited = results.get(record.id);
    expect(waited).toBeDefined();
    expect(waited!.state).toBe(SubagentState.COMPLETED);
    expect(waited!.result).toBe('wait-result');
  });
});
