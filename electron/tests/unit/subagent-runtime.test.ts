/**
 * Subagent runtime — spawn with mock runner accumulates usage on the chain.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SubagentManager,
  SubagentState,
  runtimeToDomain,
} from '../../src/main/agents/manager';
import type { Agent } from '../../src/shared/types/agent';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import { sumSubagentUsage } from '../../src/shared/usage';

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
    const changes: number[] = [];
    manager.setOnLiveChange((change) => {
      changes.push(change.sequence);
    });

    const record = manager.spawn('live', 'watch', testAgent, { sessionId: 's-live' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(record.state).toBe(SubagentState.RUNNING);
    expect(record.live.segments).toEqual([{ kind: 'text', id: expect.any(String), content: 'Hello live' }]);
    expect(record.chain?.messages).toHaveLength(1);
    expect(changes).toEqual([...changes].sort((a, b) => a - b));
    expect(new Set(changes).size).toBe(changes.length);

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
      yield { type: 'tool_result', toolCallId: 'tool-1', content: 'match', isError: false };
      yield { type: 'content', text: 'after' };
      yield { type: 'finish', finishReason: 'stop' };
    });

    let lastLiveIds: string[] = [];
    manager.setOnLiveChange((change) => {
      if (change.projection.state === SubagentState.RUNNING) {
        lastLiveIds = change.projection.segments
          .filter((segment) => segment.kind !== 'tool')
          .map((segment) => segment.id);
      }
    });
    const record = manager.spawn('ordered', 'inspect', testAgent);
    await record._runPromise;

    const types = record.chain?.messages.map((message) => message.type) ?? [];
    expect(types).toEqual(['text', 'text', 'thinking', 'tool_call', 'tool_result', 'text']);
    const transcript = record.chain?.messages.slice(1) ?? [];
    expect(transcript.map((message) => message.content)).toEqual(['before', 'reason', '', 'match', 'after']);
    expect(transcript.filter((message) => message.type === 'text' || message.type === 'thinking')
      .map((message) => message.id)).toEqual(lastLiveIds);
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
      yield { type: 'tool_result', toolCallId: 'tool-prefix', content: 'done', isError: false };
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
    const changes: Array<{ sessionId: string | null; sequence: number }> = [];
    manager.setOnLiveChange(({ sessionId, sequence }) => changes.push({ sessionId, sequence }));
    const a = manager.spawn('a', 'a', testAgent, { sessionId: 'session-a' });
    const b = manager.spawn('b', 'b', testAgent, { sessionId: 'session-b' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(a.live.sessionId).toBe('session-a');
    expect(b.live.sessionId).toBe('session-b');
    expect(a.live.sequence).toBeGreaterThan(0);
    expect(b.live.sequence).toBeGreaterThan(0);
    expect(changes.filter((change) => change.sessionId === 'session-a').map((change) => change.sequence))
      .toEqual(expect.arrayContaining([a.live.sequence]));
    expect(changes.filter((change) => change.sessionId === 'session-b').map((change) => change.sequence))
      .toEqual(expect.arrayContaining([b.live.sequence]));
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

    const domain = runtimeToDomain(record);
    expect(domain.parentChainIndex).toBe(2);
    expect(domain.status).toBe('completed');
    const summed = sumSubagentUsage(domain);
    expect(summed?.prompt_tokens).toBe(110);
    expect(summed?.completion_tokens).toBe(25);
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
      yield {
        type: 'tool_result',
        toolCallId: 'tc1',
        content: 'match',
        isError: false,
      };
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
    const changes: Array<{ state: string; messages: string[] }> = [];
    manager.setOnLiveChange(({ projection }) => {
      const current = manager.getRecord(projection.subagentId);
      changes.push({
        state: projection.state,
        messages: (current?.chain?.messages ?? []).map((message) => message.content),
      });
    });
    const record = manager.spawn('interrupt-tail', 'partial', testAgent, { sessionId: 's-interrupt' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.cancelOne(record.id)).toBe(true);
    await record._runPromise;

    expect(changes.at(-1)).toEqual({ state: SubagentState.INTERRUPTED, messages: ['partial', 'reason', 'partial'] });
    expect(record.chain?.messages.map((message) => message.content)).toEqual(['partial', 'reason', 'partial']);
    expect(changes.filter((change) => change.state === SubagentState.INTERRUPTED)).toHaveLength(1);
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
