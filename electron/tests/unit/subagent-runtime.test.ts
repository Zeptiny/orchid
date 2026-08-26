/**
 * Subagent runtime — spawn with mock runner accumulates usage on the chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SubagentManager,
  SubagentClosedError,
  SubagentEvictedError,
  SubagentNotTerminalError,
  SubagentQueueFullError,
  SubagentState,
  SubagentStillSettlingError,
  SubagentSummaryClosedError,
  runtimeToDomain,
  type SubagentRecord,
} from '../../src/main/agents/manager';
import type { Agent } from '../../src/shared/types/agent';
import type { Message } from '../../src/shared/types/message';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import { sumSubagentUsage } from '../../src/shared/usage';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import {
  summarizeSubagentRecord,
  type SubagentDeltaEvent,
  type SubagentLiveProjection,
} from '../../src/shared/types/subagent';
import {
  subagentRecordFromStorageDict,
  subagentRecordToStorageDict,
} from '../../src/shared/serialization/chain-subagent';
import { defaults } from '../../src/main/config/schema';
import type { Config } from '../../src/shared/types/ipc-boundary';
import {
  applyDeltaBatch,
  bindSubagentSession,
  createSubagentStreamState,
  seedSubagentSnapshot,
} from '../../src/renderer/utils/subagent-stream';

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

  it('keeps execution handles out of exported records', () => {
    const record = manager.spawn('opaque-run', 'inspect', testAgent);

    expect('abortController' in record).toBe(false);
    expect('_runPromise' in record).toBe(false);
    expect('runCount' in record).toBe(false);
    expect('live' in record).toBe(false);
    expect('_liveCommittedSegmentCount' in record).toBe(false);
    expect('_liveTerminalEmitted' in record).toBe(false);
    expect('_lastUsageDeltaAt' in record).toBe(false);
    expect('_resolveWait' in record).toBe(false);
    expect('pendingQuestion' in record).toBe(false);
    expect('windowId' in record).toBe(false);
    expect('cwd' in record).toBe(false);
    expect('projectRuntime' in record).toBe(false);
    expect(manager.getRunGeneration(record.id)).toBe(1);
    expect(manager.getRunPromise(record.id)).toBeNull();
  });

  it('indexes runtime records by owning session', () => {
    const first = manager.spawn('first', 'inspect A', testAgent, { sessionId: 'session-a' });
    const second = manager.spawn('second', 'inspect B', testAgent, { sessionId: 'session-b' });
    manager.spawn('unscoped', 'inspect draft', testAgent);

    expect(manager.recordsForSession('session-a')).toEqual([first]);
    expect(manager.recordsForSession('session-b')).toEqual([second]);

    manager.purgeSession('session-a');
    expect(manager.recordsForSession('session-a')).toEqual([]);
    expect(manager.recordsForSession('session-b')).toEqual([second]);
  });

  it('summarizes a durable record from its precomputed usage', () => {
    const runtime = manager.spawn('usage', 'inspect usage', testAgent, { sessionId: 'session-a' });
    const usage = {
      prompt_tokens: 13,
      completion_tokens: 5,
      total_tokens: 18,
      cached_tokens: 2,
    };
    runtime.usage = usage;
    const domain = runtimeToDomain(runtime);

    expect(domain.usage).toEqual(usage);
    expect(summarizeSubagentRecord(domain).usage).toEqual(usage);
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
    expect('windowId' in record).toBe(false);

    release();
    await manager.getRunPromise(record.id);

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
    expect(manager.getLiveProjection(record.id)?.segments)
      .toEqual([{ kind: 'text', id: expect.any(String), content: 'Hello live', startedAt: expect.any(String), endedAt: null }]);
    expect(record.chain?.messages).toHaveLength(1);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    release();
    await manager.getRunPromise(record.id);
    expect(manager.getLiveProjection(record.id)?.segments).toEqual([]);
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
    await manager.getRunPromise(record.id);

    const types = record.chain?.messages.map((message) => message.type) ?? [];
    expect(types).toEqual(['text', 'text', 'thinking', 'tool_call', 'tool_result', 'text']);
    const transcript = record.chain?.messages.slice(1) ?? [];
    expect(transcript.map((message) => message.content)).toEqual(['before', 'reason', '', 'match', 'after']);
    expect(transcript.filter((message) => message.type === 'text' || message.type === 'thinking')
      .map((message) => message.id)).toEqual(liveSegmentIds);
    expect(record.chain?.messages.at(-1)?.content).toBe('after');
    expect(manager.getLiveProjection(record.id)?.toolCalls).toEqual([]);
    expect(manager.getLiveProjection(record.id)?.segments).toEqual([]);
  });

  it('materializes text-thinking-text tails in emission order with segment IDs', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'first' };
      yield { type: 'thinking', text: 'middle' };
      yield { type: 'content', text: 'last' };
      yield { type: 'finish', finishReason: 'stop' };
    });
    const record = manager.spawn('tail-order', 'inspect', testAgent);
    await manager.getRunPromise(record.id);
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
    await manager.getRunPromise(record.id);
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
    expect(manager.getLiveProjection(record.id)?.segments.map((segment) => segment.kind === 'tool' ? '' : segment.content))
      .toEqual(['partial']);
    expect(record.chain?.messages.length).toBe(before);

    release();
    manager.cancelOne(record.id);
    await manager.getRunPromise(record.id);
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

    const tail = manager.toDomainRecord(record).chain.messages.slice(1);
    expect(tail.map((message) => [message.type, message.content])).toEqual([
      ['text', 'before'], ['thinking', 'reason'], ['text', 'after'],
    ]);
    expect(tail.filter((message) => message.type === 'text').map((message) => message.usage)).toEqual([
      null, record.usage,
    ]);

    release();
    manager.cancelOne(record.id);
    await manager.getRunPromise(record.id);
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

    const aLive = manager.getLiveProjection(a.id)!;
    const bLive = manager.getLiveProjection(b.id)!;
    expect(aLive.sessionId).toBe('session-a');
    expect(bLive.sessionId).toBe('session-b');
    expect(aLive.sequence).toBeGreaterThan(0);
    expect(bLive.sequence).toBeGreaterThan(0);
    const aDeltas = deltas.filter((event) => event.subagentId === a.id);
    const bDeltas = deltas.filter((event) => event.subagentId === b.id);
    expect(aDeltas.every((event) => event.sessionId === 'session-a')).toBe(true);
    expect(bDeltas.every((event) => event.sessionId === 'session-b')).toBe(true);
    expect(Math.max(...aDeltas.map((event) => event.sequence))).toBe(aLive.sequence);
    expect(Math.max(...bDeltas.map((event) => event.sequence))).toBe(bLive.sequence);
    manager.cancelOne(a.id);
    manager.cancelOne(b.id);
    gates.get('session-a')?.();
    gates.get('session-b')?.();
    await Promise.all([manager.getRunPromise(a.id), manager.getRunPromise(b.id)]);
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
    expect(manager.getRunPromise(record.id)).not.toBeNull();

    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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

    await manager.getRunPromise(record.id);
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
    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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
    expect(manager.getRunPromise(record.id)).toBeNull();
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
    await manager.getRunPromise(record.id);
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
    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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
      const current = manager.getLiveProjection(event.subagentId);
      if (current) lastProjection = current;
    });
    const record = manager.spawn('parity', 'x', testAgent, { sessionId: 's-parity' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastProjection).not.toBeNull();
    expect(manager.getLiveProjection(record.id)).toEqual(lastProjection);

    release();
    await manager.getRunPromise(record.id);
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
    await manager.getRunPromise(record.id);

    expect(terminal).not.toBeNull();
    expect(terminal!.record).toEqual(summarizeSubagentRecord(
      manager.toDomainRecord(record, { includeLiveTail: true }),
    ));
    expect(terminal!.record).not.toHaveProperty('chain');
    expect(terminal!.state).toBe('completed');
    expect(terminal!.usage).toEqual(record.usage);
  });

  it('reconstructs actual manager text, thinking, tool, usage, and terminal deltas in the renderer', async () => {
    const sessionId = 's-renderer-parity';
    const deltas: SubagentDeltaEvent[] = [];
    const projectionsAtEvent = new Map<number, SubagentLiveProjection | null>();
    manager.setOnDelta((event) => {
      deltas.push(event);
      projectionsAtEvent.set(event.sequence, manager.getLiveProjection(event.subagentId) ?? null);
    });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'Answer: ' };
      yield { type: 'thinking', text: 'Inspect first.' };
      yield { type: 'tool_call_start', toolCallId: 'tool-renderer', toolName: 'grep' };
      yield { type: 'tool_call_delta', toolCallId: 'tool-renderer', argsDelta: '{"pattern":' };
      yield { type: 'tool_call', toolCallId: 'tool-renderer', toolName: 'grep', args: '{"pattern":"TODO"}' };
      yield successfulToolResult('tool-renderer', 'one match');
      yield { type: 'usage', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cached_tokens: 0 } };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('renderer-parity', 'inspect', testAgent, { sessionId });
    await manager.getRunPromise(record.id);

    let renderer = seedSubagentSnapshot(
      bindSubagentSession(createSubagentStreamState(), sessionId),
      { sessionId, sessionRevision: 0, records: [], live: [] },
    );
    for (const event of deltas) {
      renderer = applyDeltaBatch(renderer, { sessionId, events: [event] });
      if (event.type === 'terminal') {
        expect(renderer.live.has(record.id)).toBe(false);
        expect(renderer.records.find((item) => item.id === record.id)).toEqual(event.record);
        expect(event.record).toEqual(summarizeSubagentRecord(manager.toDomainRecord(record)));
        continue;
      }
      if (event.type === 'text_delta' || event.type === 'thinking_delta' ||
          event.type === 'tool_start' || event.type === 'tool_args_delta' ||
          event.type === 'tool_result' || event.type === 'usage') {
        expect(renderer.live.get(record.id)).toEqual(projectionsAtEvent.get(event.sequence));
      }
    }

    expect(deltas.map((event) => event.type)).toEqual([
      'spawned', 'status_changed', 'text_delta', 'thinking_delta', 'tool_start',
      'tool_args_delta', 'tool_start', 'tool_result', 'usage', 'terminal',
    ]);
    expect(deltas.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(deltas.map((event) => event.sessionRevision)).toEqual([...deltas]
      .map((event) => event.sessionRevision)
      .sort((left, right) => left - right));
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
    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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
    await manager.getRunPromise(record.id);

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
    expect(manager.getRunPromise(third.id)).toBeNull();
    expect(third.queuedAt).not.toBeNull();
    expect(third.startedAt).toBeNull();
    // Queued records own a durable row from spawn (issue #121): a close while
    // parked in admission must still leave a record to hydrate after restart.
    expect(manager.checkpointCandidates('sess-admit').map((candidate) => candidate.record.id))
      .toContain(third.id);
    expect(manager.getQueuePosition(third.id)).toBe(1);
    expect(gates).toHaveLength(2);

    // The spawned seed carries the queued status for the third record.
    const spawnedStates = events
      .filter((event): event is Extract<SubagentDeltaEvent, { type: 'spawned' }> => event.type === 'spawned')
      .map((event) => event.record.status);
    expect(spawnedStates).toEqual(['pending', 'pending', 'queued']);

    // First terminal admits the queued record exactly once: pending→running.
    gates[0]();
    await manager.getRunPromise(first.id);
    expect(third.state).toBe(SubagentState.RUNNING);
    expect(manager.getRunPromise(third.id)).not.toBeNull();
    expect(third.startedAt).not.toBeNull();
    expect(manager.checkpointCandidates('sess-admit').map((candidate) => candidate.record.id))
      .toContain(third.id);
    expect(manager.getQueuePosition(third.id)).toBeNull();
    expect(gates).toHaveLength(3);

    gates[1]();
    gates[2]();
    await Promise.all([manager.getRunPromise(second.id), manager.getRunPromise(third.id)]);

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
    await manager.getRunPromise(a1.id);
    expect(b1.state).toBe(SubagentState.RUNNING);
    expect(a2.state).toBe(SubagentState.QUEUED);

    gates.get(b1.id)!();
    await manager.getRunPromise(b1.id);
    expect(a2.state).toBe(SubagentState.RUNNING);
    expect(b2.state).toBe(SubagentState.QUEUED);

    gates.get(a2.id)!();
    await manager.getRunPromise(a2.id);
    expect(b2.state).toBe(SubagentState.RUNNING);

    gates.get(b2.id)!();
    await manager.getRunPromise(b2.id);
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
    expect(manager.getRunPromise(queued.id)).toBeNull();
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
    await manager.getRunPromise(running.id);
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

  it('run promises are cleared after success, failure, and interruption', async () => {
    setConfig({ max_active_global: 10, max_active_per_session: 10 });
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
    await Promise.all([
      manager.getRunPromise(success.id),
      manager.getRunPromise(failure.id),
      manager.getRunPromise(interrupted.id),
    ].filter(Boolean));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(success.state).toBe(SubagentState.COMPLETED);
    expect(manager.getRunPromise(success.id)).toBeNull();
    expect(failure.state).toBe(SubagentState.FAILED);
    expect(manager.getRunPromise(failure.id)).toBeNull();
    expect(interrupted.state).toBe(SubagentState.INTERRUPTED);
    expect(manager.getRunPromise(interrupted.id)).toBeNull();
  });

  it('evicted summary retains id/state/result/error/usage/timings; chain messages empty; getStates renders', () => {
    setConfig({ terminal_retention: 5 });
    const sid = 'sess-summary';
    const record = manager.spawn('summarized', 'important task', testAgent, { sessionId: sid });
    manager.markRunning(record.id);
    record.usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    manager.markCompleted(record.id, 'the result');
    expect(manager.isSummary(record.id)).toBe(false);

    manager.confirmRecordsPersisted(sid, [record.id]);

    const summary = manager.getRecord(record.id)!;
    expect(summary).toBeDefined();
    expect(manager.isSummary(summary.id)).toBe(true);
    expect(summary.id).toBe(record.id);
    expect(summary.state).toBe(SubagentState.COMPLETED);
    expect(summary.result).toBe('the result');
    expect(summary.error).toBeNull();
    expect(summary.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    expect(summary.startTime).toBeTypeOf('number');
    expect(summary.endTime).toBeTypeOf('number');
    expect(summary.chain?.messages).toEqual([]);
    expect('projectRuntime' in summary).toBe(false);
    expect(manager.getRunPromise(summary.id)).toBeNull();
    expect('abortController' in summary).toBe(false);
    expect('_runPromise' in summary).toBe(false);
    expect('runCount' in summary).toBe(false);
    expect(manager.getLiveProjection(summary.id)?.segments).toEqual([]);
    expect(manager.getLiveProjection(summary.id)?.toolCalls).toEqual([]);

    const states = manager.getStates(sid);
    const entry = states.find((s) => s.id === record.id);
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('explorer');
    expect(entry!.state).toBe(SubagentState.COMPLETED);
    expect(entry!.task).toBe('important task');
  });

  it('summary bookkeeping never leaks into the domain (storage/IPC) record shape', () => {
    const sid = 'sess-flag-leak';
    const heavy = manager.spawn('heavy', 'task', testAgent, { sessionId: sid });
    manager.markCompleted(heavy.id, 'done');
    manager.confirmRecordsPersisted(sid, [heavy.id]);
    expect(manager.isSummary(heavy.id)).toBe(true);

    // The storage dict is built from runtimeToDomain's output; a leak here
    // would surface runtime-only state in session rows and IPC snapshots.
    expect('persistRevision' in runtimeToDomain(heavy)).toBe(false);
    expect(JSON.stringify(runtimeToDomain(heavy))).not.toContain('"persistRevision"');
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

    manager.spawn('r1', 'x', testAgent, { sessionId: sid });
    manager.spawn('r2', 'x', testAgent, { sessionId: sid });
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

  it('discardSession silently aborts and removes every session record', async () => {
    setConfig({ max_active_per_session: 1 });
    const sid = 'sess-discard';
    const events: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => events.push(event));
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => {
        if (params.abortSignal.aborted) return resolve();
        params.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'finish', finishReason: 'stop' };
    });

    manager.spawn('running', 'x', testAgent, { sessionId: sid });
    manager.spawn('queued', 'x', testAgent, { sessionId: sid });
    const other = manager.spawn('other', 'x', testAgent, { sessionId: 'other-session' });
    events.length = 0;

    manager.discardSession(sid);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.recordsForSession(sid)).toEqual([]);
    expect(manager.getRecord(other.id)).toBeDefined();
    expect(events.filter((event) => event.sessionId === sid)).toEqual([]);
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

  it('purgeSession releases a pending question resolver on a terminal record', async () => {
    const sid = 'sess-purge-question';
    const record = manager.spawn('question', 'ask', testAgent, { sessionId: sid });
    manager.markRunning(record.id);
    const question = manager.markQuestionPending(record.id, 'tool-question', []);
    manager.markCompleted(record.id, 'done');

    manager.purgeSession(sid);

    await expect(question).resolves.toEqual({ type: 'declined' });
    expect(manager.getRecord(record.id)).toBeUndefined();
  });

  it('cancelling a queued record persists it as INTERRUPTED and evicts on row confirmation (#121)', () => {
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
      // Cancelled while queued → stays a full dirty INTERRUPTED record so the
      // terminal wave can persist the row (no undurable eviction anymore).
      expect(manager.isSummary(record.id)).toBe(false);
      expect(record.state).toBe(SubagentState.INTERRUPTED);
    }

    // Confirming the written rows evicts them to lean summaries; the retention
    // FIFO caps them: oldest removed entirely, newest two kept.
    manager.confirmRecordsPersisted(sid, queuedIds);
    expect(manager.getRecord(queuedIds[0])).toBeUndefined();
    expect(manager.isSummary(queuedIds[1])).toBe(true);
    expect(manager.isSummary(queuedIds[2])).toBe(true);
    expect(manager.allRecords().filter((r) => r.sessionId === sid)
      .map((r) => r.id)).toEqual([active.id, queuedIds[1], queuedIds[2]]);

    // Re-confirming already-evicted summaries is a harmless no-op.
    manager.confirmRecordsPersisted(sid, queuedIds);
    expect(manager.isSummary(queuedIds[1])).toBe(true);
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

describe('closed flag (U1)', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
    configOverride.current = null;
  });

  afterEach(() => {
    configOverride.current = null;
  });

  it('closed survives the storage-dict round trip and defaults to false for old rows', () => {
    const open = manager.spawn('open', 'x', testAgent, { sessionId: 'sess-closed-rt' });
    manager.markCompleted(open.id, 'done');
    const domain = runtimeToDomain(open);
    expect(domain.closed).toBe(false);

    const restoredOpen = subagentRecordFromStorageDict(subagentRecordToStorageDict(domain));
    expect(restoredOpen.closed).toBe(false);

    const closedDomain = { ...domain, closed: true };
    const restoredClosed = subagentRecordFromStorageDict(
      subagentRecordToStorageDict(closedDomain),
    );
    expect(restoredClosed.closed).toBe(true);

    // Legacy rows written before the flag existed restore as open.
    const legacyDict = subagentRecordToStorageDict(closedDomain) as Record<string, unknown>;
    delete legacyDict.closed;
    expect(subagentRecordFromStorageDict(legacyDict).closed).toBe(false);
  });

  it('runtimeToDomain carries the closed flag from the runtime record', () => {
    const record = manager.spawn('flagged', 'x', testAgent, { sessionId: 'sess-closed-map' });
    manager.markCompleted(record.id, 'done');
    expect(runtimeToDomain(record).closed).toBe(false);
    record.closed = true;
    expect(runtimeToDomain(record).closed).toBe(true);
  });

  it('getStates omits closed records and stays session-scoped', () => {
    const sid = 'sess-closed-filter';
    const keep = manager.spawn('keep', 'x', testAgent, { sessionId: sid });
    const hide = manager.spawn('hide', 'x', testAgent, { sessionId: sid });
    const otherSession = manager.spawn('other', 'x', testAgent, { sessionId: 'sess-closed-other' });
    manager.markCompleted(keep.id, 'done');
    manager.markCompleted(hide.id, 'done');
    manager.markCompleted(otherSession.id, 'done');

    hide.closed = true;
    otherSession.closed = true;

    const states = manager.getStates(sid);
    expect(states.map((s) => s.id)).toEqual([keep.id]);
    // Closing does not delete the record from the manager or the other session.
    expect(manager.getRecord(hide.id)).toBeDefined();
    expect(manager.getStates('sess-closed-other')).toEqual([]);
    expect(manager.getStates().map((s) => s.id)).toEqual([keep.id]);
  });

  it('closed flag survives eviction to a summary', () => {
    const sid = 'sess-closed-evict';
    const record = manager.spawn('close-me', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');
    record.closed = true;

    manager.confirmRecordsPersisted(sid, [record.id]);

    const summary = manager.getRecord(record.id)!;
    expect(manager.isSummary(summary.id)).toBe(true);
    expect(summary.closed).toBe(true);
    expect(manager.getStates(sid)).toEqual([]);
  });
});

describe('SubagentManager hydration (U3)', () => {
  let manager: SubagentManager;

  const SELECTION = {
    connectionId: '11111111-1111-4111-8111-111111111111',
    modelId: 'model-x',
  };

  beforeEach(() => {
    manager = new SubagentManager();
    configOverride.current = null;
  });

  afterEach(() => {
    configOverride.current = null;
  });

  function setConfig(overrides: Partial<Config['subagents']>): void {
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, ...overrides },
    };
  }

  /** Round-trip a runtime record through the storage dict to mimic a loaded row. */
  function storedDomain(record: SubagentRecord) {
    return subagentRecordFromStorageDict(subagentRecordToStorageDict(runtimeToDomain(record)));
  }

  it('hydrates a persisted-only record into a getRecord-visible full record', () => {
    // A separate manager stands in for durable storage: the current manager
    // (simulating a fresh app launch) has no record for this id.
    const source = new SubagentManager();
    const original = source.spawn('review auth', 'Review the auth module', testAgent, {
      sessionId: 'sess-hydrate',
      selection: SELECTION,
      parentChainIndex: 3,
    });
    source.markCompleted(original.id, 'the result');
    const dict = subagentRecordToStorageDict(runtimeToDomain(original));
    dict.closed = true;
    const domain = subagentRecordFromStorageDict(dict);

    expect(manager.getRecord(original.id)).toBeUndefined();

    manager.hydrate([{
      id: original.id,
      agent: testAgent,
      domain,
      sessionId: 'sess-hydrate',
      windowId: 'win-1',
      cwd: '/tmp/project',
    }]);

    const record = manager.getRecord(original.id);
    expect(record).toBeDefined();
    expect(manager.isSummary(record!.id)).toBe(false);
    expect(record!.state).toBe(SubagentState.COMPLETED);
    expect(record!.label).toBe('review auth');
    expect(record!.task).toBe('Review the auth module');
    expect(record!.result).toBe('the result');
    expect(record!.closed).toBe(true);
    expect(record!.selection).toEqual(SELECTION);
    expect(record!.parentChainIndex).toBe(3);
    expect(record!.chain?.messages.length).toBeGreaterThan(0);
    expect(record!.sessionId).toBe('sess-hydrate');
    expect('windowId' in record!).toBe(false);
    expect('cwd' in record!).toBe(false);
    // Hydration restarts the persistence counter and emits nothing.
    expect(manager.checkpointCandidates('sess-hydrate').map((candidate) => candidate.record.id))
      .toContain(record!.id);
    expect(record!.startTime).toBeTypeOf('number');
    expect(record!.endTime).toBeTypeOf('number');
    // A hydrated terminal record shows in the prompt unless closed.
    expect(manager.getStates('sess-hydrate')).toEqual([]);
    record!.closed = false;
    expect(manager.getStates('sess-hydrate').map((s) => s.id)).toEqual([original.id]);
  });

  it('keeps hydrated execution affinity in runtime state for a follow-up runner', async () => {
    const source = new SubagentManager();
    const original = source.spawn('resume', 'original task', testAgent, { sessionId: 'sess-affinity' });
    source.markCompleted(original.id, 'done');
    const domain = subagentRecordFromStorageDict(subagentRecordToStorageDict(runtimeToDomain(original)));
    const runtime = { projectDir: '/tmp/hydrated-project' } as never;
    const received: Array<{ windowId?: string; cwd?: string; projectRuntime?: unknown; sessionId?: string }> = [];
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      received.push({
        windowId: params.windowId,
        cwd: params.cwd,
        projectRuntime: params.projectRuntime,
        sessionId: params.sessionId,
      });
      yield { type: 'finish', finishReason: 'stop' };
    });
    manager.hydrate([{
      id: original.id,
      agent: testAgent,
      domain,
      sessionId: 'sess-affinity',
      windowId: 'window-hydrated',
      cwd: '/tmp/hydrated-project',
      projectRuntime: runtime,
    }]);

    const resumed = manager.followUp(original.id, 'continue');
    await manager.getRunPromise(resumed.id);

    expect('windowId' in resumed).toBe(false);
    expect('cwd' in resumed).toBe(false);
    expect('projectRuntime' in resumed).toBe(false);
    expect(received).toEqual([{
      windowId: 'window-hydrated',
      cwd: '/tmp/hydrated-project',
      projectRuntime: runtime,
      sessionId: 'sess-affinity',
    }]);
  });

  it('retains cumulative usage across follow-up runs', async () => {
    let runNumber = 0;
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      runNumber += 1;
      yield { type: 'content', text: `answer-${runNumber}` };
      yield {
        type: 'usage',
        usage: {
          prompt_tokens: runNumber * 10,
          completion_tokens: runNumber,
          total_tokens: runNumber * 11,
          cached_tokens: 0,
        },
      };
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('usage', 'first', testAgent, { sessionId: 'sess-usage' });
    await manager.getRunPromise(record.id);
    expect(record.usage?.total_tokens).toBe(11);

    manager.followUp(record.id, 'second');
    await manager.getRunPromise(record.id);

    expect(record.usage).toMatchObject({
      prompt_tokens: 30,
      completion_tokens: 3,
      total_tokens: 33,
      cached_tokens: 0,
    });
    expect(sumSubagentUsage(runtimeToDomain(record))).toEqual(record.usage);
  });

  it('hydrating a live full record is a no-op (runtime record wins)', () => {
    const record = manager.spawn('live', 'task', testAgent, { sessionId: 'sess-live' });
    manager.markCompleted(record.id, 'live result');
    const before = manager.getRecord(record.id);

    // A stale stored copy (different result + closed) must NOT replace the live record.
    const dict = subagentRecordToStorageDict(runtimeToDomain(record));
    dict.closed = true;
    const domain = subagentRecordFromStorageDict(dict);
    manager.hydrate([{
      id: record.id,
      agent: testAgent,
      domain,
      sessionId: 'sess-live',
      windowId: null,
      cwd: null,
    }]);

    const after = manager.getRecord(record.id);
    expect(after).toBe(before); // same object identity — not replaced
    expect(after!.result).toBe('live result');
    expect(after!.closed).toBe(false);
  });

  it('hydrating a summary restores chain messages and materializes a full record', () => {
    const sid = 'sess-rehydrate';
    const record = manager.spawn('summarized', 'important', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'the result');
    // Capture the full durable record BEFORE eviction empties the chain.
    const domain = storedDomain(record);
    const messageCount = domain.chain.messages.length;
    expect(messageCount).toBeGreaterThan(0);

    manager.confirmRecordsPersisted(sid, [record.id]);
    const summary = manager.getRecord(record.id)!;
    expect(manager.isSummary(summary.id)).toBe(true);
    expect(summary.chain?.messages).toEqual([]);

    manager.hydrate([{
      id: record.id,
      agent: testAgent,
      domain,
      sessionId: sid,
      windowId: null,
      cwd: null,
    }]);

    const restored = manager.getRecord(record.id)!;
    expect(manager.isSummary(restored.id)).toBe(false);
    expect(restored.chain?.messages.length).toBe(messageCount);
    expect(restored.result).toBe('the result');
    expect(restored.state).toBe(SubagentState.COMPLETED);
  });

  it('skips a spec whose stored status is non-terminal (defensive guard)', () => {
    const source = new SubagentManager();
    const original = source.spawn('running', 'x', testAgent, { sessionId: 'sess-guard' });
    const domain = storedDomain(original);
    // Forge a non-terminal status; the restore migration normally prevents this.
    const nonTerminal = { ...domain, status: 'running' as const };

    manager.hydrate([{
      id: original.id,
      agent: testAgent,
      domain: nonTerminal,
      sessionId: 'sess-guard',
      windowId: null,
      cwd: null,
    }]);

    expect(manager.getRecord(original.id)).toBeUndefined();
  });

  it('hydrate untracks the retention FIFO so rolls never delete the re-materialized record', () => {
    setConfig({ terminal_retention: 2 });
    const sid = 'sess-fifo';
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const record = manager.spawn(`t-${i}`, `do ${i}`, testAgent, { sessionId: sid });
      manager.markCompleted(record.id, `result-${i}`);
      ids.push(record.id);
    }
    // Capture t-1's full durable record before eviction empties its chain.
    const target = ids[1];
    const domain = storedDomain(manager.getRecord(target)!);

    // Confirm all three: t-0 rolls off (cap 2); t-1 and t-2 remain as summaries.
    manager.confirmRecordsPersisted(sid, ids);
    expect(manager.getRecord(ids[0])).toBeUndefined();
    expect(manager.isSummary(target)).toBe(true);
    expect(manager.isSummary(ids[2])).toBe(true);

    // Hydrate t-1: it becomes a full record and leaves the retention FIFO.
    manager.hydrate([{ id: target, agent: testAgent, domain, sessionId: sid, windowId: null, cwd: null }]);
    expect(manager.isSummary(target)).toBe(false);

    // Two more terminal records roll the FIFO past the cap.
    for (let i = 3; i < 5; i += 1) {
      const record = manager.spawn(`t-${i}`, `do ${i}`, testAgent, { sessionId: sid });
      manager.markCompleted(record.id, `result-${i}`);
      manager.confirmRecordsPersisted(sid, [record.id]);
    }

    // The normally evicted summary (t-2) rolled off at the cap...
    expect(manager.getRecord(ids[2])).toBeUndefined();
    // ...but the re-materialized t-1 survived every roll and kept its chain.
    const survived = manager.getRecord(target)!;
    expect(survived).toBeDefined();
    expect(manager.isSummary(survived.id)).toBe(false);
    expect(survived.chain?.messages.length).toBeGreaterThan(0);
  });

  it('hydrate emits no deltas and does not notify on its own', () => {
    const source = new SubagentManager();
    const original = source.spawn('quiet', 'x', testAgent, { sessionId: 'sess-quiet' });
    source.markCompleted(original.id, 'done');
    const domain = storedDomain(original);

    const deltas: unknown[] = [];
    let notifyCount = 0;
    manager.setOnDelta((event) => deltas.push(event));
    manager.setOnChange(() => { notifyCount += 1; });

    manager.hydrate([{
      id: original.id,
      agent: testAgent,
      domain,
      sessionId: 'sess-quiet',
      windowId: null,
      cwd: null,
    }]);

    expect(deltas).toEqual([]);
    expect(notifyCount).toBe(0);
    expect(manager.getRecord(original.id)).toBeDefined();
  });
});

describe('SubagentManager follow-up resume (U4)', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
    configOverride.current = null;
  });

  it('advances the session revision when a terminal record is reopened', () => {
    const sid = 'sess-follow-up-revision';
    manager.setRunner(null);
    const record = manager.spawn('revision', 'first', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');
    const before = manager.getSessionRevision(sid);

    manager.followUp(record.id, 'again');

    expect(manager.getSessionRevision(sid)).toBeGreaterThan(before);
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

  /** A gate-controlled runner: each started run parks until its gate fires. */
  function gateRunner(gates: Array<() => void>): SubagentManager['_runner'] {
    return async function* (): AsyncGenerator<StreamEvent> {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      yield { type: 'content', text: 'run output' };
      yield { type: 'finish', finishReason: 'stop' };
    };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('resume admitted: terminal → RUNNING, appends user message, reopens chain, and advances generation', async () => {
    const gates: Array<() => void> = [];
    manager.setRunner(gateRunner(gates));
    const record = manager.spawn('orig', 'first task', testAgent, { sessionId: 'sess-resume' });
    await tick();
    expect(record.state).toBe(SubagentState.RUNNING);
    expect(manager.getRunGeneration(record.id)).toBe(1);
    const firstRunId = manager.getLiveProjection(record.id)!.runId;

    // Complete the first run.
    gates[0]();
    await manager.getRunPromise(record.id);
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.chain?.status).toBe('completed');
    const messagesBefore = record.chain?.messages.length ?? 0;

    // Follow up: admitted (slot free) → PENDING, then RUNNING once started.
    const resumed = manager.followUp(record.id, 'keep going');
    expect(resumed).toBe(record);
    await tick();
    expect(resumed.state).toBe(SubagentState.RUNNING);
    expect(manager.getRunPromise(resumed.id)).not.toBeNull();

    // The follow-up input is the last chain message.
    const last = resumed.chain?.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toBe('keep going');
    expect(resumed.chain?.messages.length).toBe(messagesBefore + 1);

    // Chain reopened; per-run fields reset; fresh runId; generation advanced.
    expect(resumed.chain?.status).toBe('active');
    expect(resumed.chain?.endTime).toBeNull();
    expect(manager.getLiveProjection(resumed.id)!.runId).not.toBe(firstRunId);
    expect(manager.getRunGeneration(resumed.id)).toBe(2);
    expect(resumed.result).toBeNull();
    expect(resumed.error).toBeNull();

    gates[1]();
    await manager.getRunPromise(resumed.id);
    expect(resumed.state).toBe(SubagentState.COMPLETED);
  });

  it('resume queued: over-capacity resume parks as QUEUED with a queue position; a terminal transition admits it', async () => {
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(gateRunner(gates));

    // Target completes first while the slot is free.
    const target = manager.spawn('target', 'first', testAgent, { sessionId: 'sess-rq' });
    await tick();
    gates[0]();
    await manager.getRunPromise(target.id);
    expect(target.state).toBe(SubagentState.COMPLETED);

    // Blocker occupies the only per-session slot.
    const blocker = manager.spawn('blocker', 'x', testAgent, { sessionId: 'sess-rq' });
    await tick();
    expect(blocker.state).toBe(SubagentState.RUNNING);

    const events: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => events.push(event));
    manager.followUp(target.id, 'again');
    expect(target.state).toBe(SubagentState.QUEUED);
    expect(target.queuedAt).not.toBeNull();
    expect(manager.checkpointCandidates('sess-rq').map((candidate) => candidate.record.id))
      .toContain(target.id);
    expect(manager.getQueuePosition(target.id)).toBe(1);
    // A SPAWNED delta is re-emitted carrying the queued record.
    const spawned = events.filter((event) => event.type === 'spawned');
    expect(spawned.at(-1)?.record.status).toBe('queued');

    // Completing the blocker admits the resumed record (leaves QUEUED).
    gates[1]();
    await manager.getRunPromise(blocker.id);
    await tick();
    expect(target.state).toBe(SubagentState.RUNNING);
    expect(manager.getQueuePosition(target.id)).toBeNull();

    gates[2]();
    await manager.getRunPromise(target.id);
    expect(target.state).toBe(SubagentState.COMPLETED);
  });

  it('queue full: followUp throws SubagentQueueFullError and leaves the terminal record unmutated', () => {
    setLimits({ max_active_global: 1, max_active_per_session: 1, max_queued: 1 });

    // Terminal target created while the slot is free (no runner → manual).
    const target = manager.spawn('target', 'first', testAgent, { sessionId: 'sess-qf' });
    manager.markCompleted(target.id, 'done');
    expect(target.state).toBe(SubagentState.COMPLETED);
    const messagesBefore = target.chain?.messages.length;
    const statusBefore = target.chain?.status;
    const generationBefore = manager.getRunGeneration(target.id);
    const liveRunIdBefore = manager.getLiveProjection(target.id)!.runId;

    // Fill the single active slot and the single queue slot.
    const active = manager.spawn('active', 'x', testAgent, { sessionId: 'sess-qf' });
    expect(active.state).toBe(SubagentState.PENDING);
    const queued = manager.spawn('queued', 'x', testAgent, { sessionId: 'sess-qf' });
    expect(queued.state).toBe(SubagentState.QUEUED);

    let thrown: unknown;
    try {
      manager.followUp(target.id, 'again');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SubagentQueueFullError);

    // The terminal record is completely unmutated.
    expect(target.state).toBe(SubagentState.COMPLETED);
    expect(target.closed).toBe(false);
    expect(target.result).toBe('done');
    expect(target.chain?.messages.length).toBe(messagesBefore);
    expect(target.chain?.status).toBe(statusBefore);
    expect(manager.getRunGeneration(target.id)).toBe(generationBefore);
    expect(manager.getLiveProjection(target.id)!.runId).toBe(liveRunIdBefore);
    expect(manager.getQueuePosition(target.id)).toBeNull();
  });

  it('persistence eligibility: spawn-queued and resume-queued records both own a durable row (#121)', async () => {
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(gateRunner(gates));

    const target = manager.spawn('target', 'first', testAgent, { sessionId: 'sess-elig' });
    await tick();
    gates[0]();
    await manager.getRunPromise(target.id);
    expect(target.state).toBe(SubagentState.COMPLETED);

    // Blocker occupies the slot; subsequent spawn and resume both queue.
    manager.spawn('blocker', 'x', testAgent, { sessionId: 'sess-elig' });
    await tick();

    const spawnQueued = manager.spawn('spawn-queued', 'x', testAgent, { sessionId: 'sess-elig' });
    expect(spawnQueued.state).toBe(SubagentState.QUEUED);
    expect(manager.checkpointCandidates('sess-elig').map((candidate) => candidate.record.id))
      .toContain(spawnQueued.id);

    manager.followUp(target.id, 'again');
    expect(target.state).toBe(SubagentState.QUEUED);
    expect(target.queuedAt).not.toBeNull();
    expect(target.startedAt).toBeNull();
    expect(manager.checkpointCandidates('sess-elig').map((candidate) => candidate.record.id))
      .toContain(target.id);
  });

  it('cancelOne mid-resumed-run interrupts through the runner-owned boundary', async () => {
    const record = manager.spawn('orig', 'first', testAgent, { sessionId: 'sess-int-resume' });
    manager.markCompleted(record.id, 'first result');
    expect(record.state).toBe(SubagentState.COMPLETED);

    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'resuming' };
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

    manager.followUp(record.id, 'continue');
    await tick();
    expect(record.state).toBe(SubagentState.RUNNING);
    // The runner owns the async boundary: a run promise is in flight.
    expect(manager.getRunPromise(record.id)).not.toBeNull();

    expect(manager.cancelOne(record.id)).toBe(true);
    expect(record.state).toBe(SubagentState.INTERRUPTED);
    await manager.getRunPromise(record.id);
    expect(manager.getRunPromise(record.id)).toBeNull();
    expect(record.state).toBe(SubagentState.INTERRUPTED);
    // The follow-up message survives the interruption.
    expect(record.chain?.messages.some((message) => message.content === 'continue')).toBe(true);
  });

  it('cancelOne while resume-queued takes the in-place queued path (no admission follows)', async () => {
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(gateRunner(gates));

    const target = manager.spawn('target', 'first', testAgent, { sessionId: 'sess-int-queued' });
    await tick();
    gates[0]();
    await manager.getRunPromise(target.id);
    expect(target.state).toBe(SubagentState.COMPLETED);

    const blocker = manager.spawn('blocker', 'x', testAgent, { sessionId: 'sess-int-queued' });
    await tick();
    expect(blocker.state).toBe(SubagentState.RUNNING);

    manager.followUp(target.id, 'again');
    expect(target.state).toBe(SubagentState.QUEUED);
    expect(manager.checkpointCandidates('sess-int-queued').map((candidate) => candidate.record.id))
      .toContain(target.id);

    expect(manager.cancelOne(target.id)).toBe(true);
    expect(target.state).toBe(SubagentState.INTERRUPTED);
    expect(manager.getRunPromise(target.id)).toBeNull();
    expect(manager.getQueuePosition(target.id)).toBeNull();

    // No admission followed: the blocker is untouched and no extra run started.
    expect(blocker.state).toBe(SubagentState.RUNNING);
    expect(gates).toHaveLength(2);
  });

  it('followUp rejects a record whose cancelled run is still unwinding (still-settling)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      await gate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('settling', 'x', testAgent, { sessionId: 'sess-settle' });
    await tick();
    expect(record.state).toBe(SubagentState.RUNNING);

    // cancelOne marks the record terminal but leaves the run loop unwinding:
    // the runner owns the async interruption boundary while it is settling.
    expect(manager.cancelOne(record.id)).toBe(true);
    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(manager.getRunPromise(record.id)).not.toBeNull();

    expect(() => manager.followUp(record.id, 'again')).toThrow(SubagentStillSettlingError);
    // A rejected resume leaves the record unmutated: no message appended, no
    // run bump (the chain stays ACTIVE until the runner unwinds it).
    expect(record.chain?.messages.some((message) => message.content === 'again')).toBe(false);
    expect(manager.getRunGeneration(record.id)).toBe(1);

    release();
    await manager.getRunPromise(record.id);
    expect(manager.getRunPromise(record.id)).toBeNull();
    expect(record.chain?.status).toBe('interrupted');
    // Once the zombie run unwound, the resume is allowed.
    expect(() => manager.followUp(record.id, 'again')).not.toThrow();
  });

  it('cancelling a resume-queued record keeps it a full dirty record (no eviction) so the INTERRUPTED state persists', async () => {
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(gateRunner(gates));

    const target = manager.spawn('target', 'first', testAgent, { sessionId: 'sess-rq-cancel' });
    await tick();
    gates[0]();
    await manager.getRunPromise(target.id);
    expect(target.state).toBe(SubagentState.COMPLETED);

    const blocker = manager.spawn('blocker', 'x', testAgent, { sessionId: 'sess-rq-cancel' });
    await tick();
    expect(blocker.state).toBe(SubagentState.RUNNING);

    manager.followUp(target.id, 'again');
    expect(target.state).toBe(SubagentState.QUEUED);
    expect(manager.checkpointCandidates('sess-rq-cancel').map((candidate) => candidate.record.id))
      .toContain(target.id);

    expect(manager.cancelOne(target.id)).toBe(true);
    expect(target.state).toBe(SubagentState.INTERRUPTED);
    // Not evicted: the record owns a durable row, so eviction would strand the
    // row with a stale pre-interrupt status and skip every later checkpoint.
    expect(manager.isSummary(target.id)).toBe(false);
    // The follow-up message and the reopened chain survive for the terminal wave.
    expect(target.chain?.messages.some((message) => message.content === 'again')).toBe(true);
    // A later persistence confirmation evicts it through the normal path.
    manager.confirmRecordsPersisted('sess-rq-cancel', [target.id]);
    expect(manager.isSummary(target.id)).toBe(true);
    expect(manager.getRecord(target.id)?.state).toBe(SubagentState.INTERRUPTED);
  });

  it('close on a terminal summary throws instead of silently flagging an unpersistable record', () => {
    const sid = 'sess-close-evicted';
    const record = manager.spawn('close-evict', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'done');
    manager.confirmRecordsPersisted(sid, [record.id]);
    expect(manager.isSummary(record.id)).toBe(true);

    expect(() => manager.close(record.id)).toThrow(SubagentSummaryClosedError);
    expect(manager.getRecord(record.id)?.closed).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('followUp guards: unknown, non-terminal, closed, and evicted records throw', () => {
    const sid = 'sess-guards';

    expect(() => manager.followUp('nope', 'x')).toThrow(/not found/);

    const nonTerminal = manager.spawn('running', 'x', testAgent, { sessionId: sid });
    expect(nonTerminal.state).toBe(SubagentState.PENDING);
    expect(() => manager.followUp(nonTerminal.id, 'x')).toThrow(SubagentNotTerminalError);

    const closedRecord = manager.spawn('closed', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(closedRecord.id, 'done');
    closedRecord.closed = true;
    expect(() => manager.followUp(closedRecord.id, 'x')).toThrow(SubagentClosedError);

    const evicted = manager.spawn('evicted', 'x', testAgent, { sessionId: sid });
    manager.markCompleted(evicted.id, 'done');
    manager.confirmRecordsPersisted(sid, [evicted.id]);
    expect(manager.isSummary(evicted.id)).toBe(true);
    expect(() => manager.followUp(evicted.id, 'x')).toThrow(SubagentEvictedError);
  });

  it('chain reopen: after followUp the chain is ACTIVE even though it was terminal (keepTerminal ordering)', () => {
    const record = manager.spawn('reopen', 'first', testAgent, { sessionId: 'sess-reopen' });
    manager.markCompleted(record.id, 'done');
    expect(record.chain?.status).toBe('completed');
    expect(record.chain?.endTime).not.toBeNull();

    manager.followUp(record.id, 'again');
    expect(record.chain?.status).toBe('active');
    expect(record.chain?.endTime).toBeNull();
  });

  it('generation: spawn=1, after first followUp=2, hydrate initializes 1', () => {
    const record = manager.spawn('rc', 'first', testAgent, { sessionId: 'sess-rc' });
    expect(manager.getRunGeneration(record.id)).toBe(1);
    manager.markCompleted(record.id, 'done');
    manager.followUp(record.id, 'again');
    expect(manager.getRunGeneration(record.id)).toBe(2);

    const source = new SubagentManager();
    const original = source.spawn('hyd', 'x', testAgent, { sessionId: 'sess-rc-hyd' });
    source.markCompleted(original.id, 'done');
    const domain = subagentRecordFromStorageDict(
      subagentRecordToStorageDict(runtimeToDomain(original)),
    );
    manager.hydrate([{
      id: original.id,
      agent: testAgent,
      domain,
      sessionId: 'sess-rc-hyd',
      windowId: null,
      cwd: null,
    }]);
    expect(manager.getRunGeneration(original.id)).toBe(1);
  });

  it('a queued follow-up remains checkpoint eligible after admission', async () => {
    setLimits({ max_active_per_session: 1 });
    const gates: Array<() => void> = [];
    manager.setRunner(gateRunner(gates));

    const target = manager.spawn('target', 'first', testAgent, { sessionId: 'sess-flag' });
    await tick();
    gates[0]();
    await manager.getRunPromise(target.id);
    expect(manager.getQueuePosition(target.id)).toBeNull();

    const blocker = manager.spawn('blocker', 'x', testAgent, { sessionId: 'sess-flag' });
    await tick();

    manager.followUp(target.id, 'again');
    expect(target.state).toBe(SubagentState.QUEUED);
    expect(manager.checkpointCandidates('sess-flag').map((candidate) => candidate.record.id))
      .toContain(target.id);

    gates[1]();
    await manager.getRunPromise(blocker.id);
    await tick();
    expect(target.state).toBe(SubagentState.RUNNING);
    expect(manager.checkpointCandidates('sess-flag').map((candidate) => candidate.record.id))
      .toContain(target.id);

    gates[2]();
    await manager.getRunPromise(target.id);
  });

  it('turn attribution: turnId differs between the first run and a resumed run', async () => {
    const gates: Array<() => void> = [];
    const turnIds: Array<string | undefined> = [];
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      turnIds.push(params.turnId);
      await new Promise<void>((resolve) => { gates.push(resolve); });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('attr', 'first', testAgent, { sessionId: 'sess-attr' });
    await tick();
    gates[0]();
    await manager.getRunPromise(record.id);
    expect(manager.getRunGeneration(record.id)).toBe(1);

    manager.followUp(record.id, 'again');
    await tick();
    gates[1]();
    await manager.getRunPromise(record.id);
    expect(manager.getRunGeneration(record.id)).toBe(2);

    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).toBe(`${record.id}#1`);
    expect(turnIds[1]).toBe(`${record.id}#2`);
    expect(turnIds[0]).not.toBe(turnIds[1]);
  });

  it('passes the full chain as the history box to the runner on a resume', async () => {
    const gates: Array<() => void> = [];
    const histories: Array<Message[] | undefined> = [];
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      histories.push(params.historyBox?.messages);
      await new Promise<void>((resolve) => { gates.push(resolve); });
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('hist', 'first task', testAgent, { sessionId: 'sess-hist' });
    await tick();
    gates[0]();
    await manager.getRunPromise(record.id);

    manager.followUp(record.id, 'follow up');
    await tick();
    gates[1]();
    await manager.getRunPromise(record.id);

    // Spawn path history is the single task message.
    expect(histories[0]?.map((message) => message.content)).toEqual(['first task']);
    // Resumed path replays the full chain ending in the follow-up user message.
    const resumed = histories[1] ?? [];
    expect(resumed.length).toBeGreaterThan(1);
    expect(resumed.at(-1)?.role).toBe('user');
    expect(resumed.at(-1)?.content).toBe('follow up');
  });
});
