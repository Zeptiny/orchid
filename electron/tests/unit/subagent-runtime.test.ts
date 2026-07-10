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

    const cancelled = manager.cancelRunning('session-a');
    expect(cancelled).toEqual([a.id]);
    expect(a.state).toBe(SubagentState.INTERRUPTED);
    expect(b.state).toBe(SubagentState.RUNNING);

    expect(manager.toDomainRecords('session-b')).toHaveLength(1);
    expect(manager.toDomainRecords('session-b')[0].id).toBe(b.id);
    expect(manager.toDomainRecords('session-a')[0].status).toBe('interrupted');
  });
});
