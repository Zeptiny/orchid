/**
 * Tests for XState agent hierarchy (U10).
 *
 * Covers:
 * - Agent machine: idle → streaming → idle (text response)
 * - Agent machine: streaming tool events → idle (provider-managed tool loop)
 * - Subagent machine: pending → running → completed (result to parent)
 * - Interrupt flow: first Esc → confirmAgent, second Esc → idle
 * - Interrupt timeout: auto-reset to idle
 * - Subagent isolation: child tool calls don't affect parent state
 * - SubagentManager: spawn, wait, cancel operations
 *
 * Test scenarios from plan U10.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import {
  agentMachine,
  type AgentContext,
} from '../../src/main/agents/xstate/agent-machine';
import { interruptMachine } from '../../src/main/agents/xstate/interrupt-machine';
import { SubagentManager, SubagentState } from '../../src/main/agents/manager';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import type { Agent } from '../../src/shared/types/agent';
import { AgentType, AgentTier } from '../../src/shared/types/agent';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

// ── Helpers ─────────────────────────────────────────────────────────────────

const mockAgent: Agent = {
  name: 'general',
  type: AgentType.INTERNAL,
  tier: AgentTier.BLOOM,
  description: 'General-purpose agent',
  allowed_tools: ['*'],
  allowed_skills: ['*'],
};

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

/**
 * Create a mock stream function that yields a sequence of StreamEvents.
 * Properly handles abort signal to avoid hanging timers.
 */
function mockStreamFn(events: StreamEvent[]) {
  return async function* (params: {
    message: string;
    agent: Agent;
    systemPrompt: string;
    abortSignal: AbortSignal;
    model?: string | null;
  }): AsyncGenerator<StreamEvent> {
    for (const event of events) {
      if (params.abortSignal.aborted) return;
      yield event;
      // Small delay with abort handling
      await new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(timer); resolve(); };
        params.abortSignal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
          params.abortSignal.removeEventListener('abort', onAbort);
          resolve();
        }, 2);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      });
    }
  };
}

/**
 * Create a mock stream function that waits for cancellation.
 * Yields a content chunk, then waits for abort signal (simulating a long stream).
 */
function mockCancellableStreamFn() {
  return async function* (params: {
    message: string;
    agent: Agent;
    systemPrompt: string;
    abortSignal: AbortSignal;
    model?: string | null;
  }): AsyncGenerator<StreamEvent> {
    yield { type: 'content', text: 'Starting...' };

    // Wait for abort — use a short timeout to avoid hanging tests
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      params.abortSignal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        params.abortSignal.removeEventListener('abort', onAbort);
        resolve();
      }, 2000);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    });

    if (!params.abortSignal.aborted) {
      yield { type: 'finish', finishReason: 'stop' };
    }
  };
}

/**
 * Wait for an actor to reach a target state.
 * Uses subscription pattern (more reliable than xstate's waitFor in tests).
 * Checks the current state first to handle synchronous transitions.
 */
function waitForState(
  actor: ReturnType<typeof createActor>,
  targetState: string | Record<string, unknown>,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const matches = (value: string | Record<string, unknown>) =>
      typeof targetState === 'string'
        ? value === targetState
        : JSON.stringify(value) === JSON.stringify(targetState);

    // Check current state first (handles synchronous transitions)
    if (matches(actor.getSnapshot().value as string)) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      sub.unsubscribe();
      const snap = actor.getSnapshot();
      reject(
        new Error(
          `Timeout waiting for state ${JSON.stringify(targetState)}. ` +
          `Current: ${JSON.stringify(snap.value)}, context.error: ${snap.context.error}`,
        ),
      );
    }, timeoutMs);

    const sub = actor.subscribe((snapshot) => {
      if (matches(snapshot.value as string)) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Wait for an actor's context to satisfy a predicate.
 */
function waitForContext<T>(
  actor: ReturnType<typeof createActor>,
  predicate: (ctx: T) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error('Timeout waiting for context condition'));
    }, timeoutMs);

    const sub = actor.subscribe((snapshot) => {
      if (predicate(snapshot.context as T)) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

// ── Agent Machine Tests ─────────────────────────────────────────────────────

describe('Agent Machine', () => {
  it('idle → user input → streaming → text → idle', async () => {
    const streamFn = mockStreamFn([
      { type: 'content', text: 'Hello!' },
      { type: 'finish', finishReason: 'stop' },
    ]);

    const actor = createActor(agentMachine, {
      input: {
        agent: mockAgent,
        systemPrompt: 'You are helpful.',
        streamFn,
        interruptResetMs: 100, // Short timeout for tests
      },
    });

    actor.start();
    expect(actor.getSnapshot().value).toBe('idle');

    actor.send({ type: 'USER_INPUT', message: 'Hi' });
    expect(actor.getSnapshot().value).toBe('streaming');

    await waitForState(actor, 'idle');
    expect(actor.getSnapshot().context.response).toBe('Hello!');
    expect(actor.getSnapshot().context.error).toBeNull();
  });

  it('accumulates usage across model steps and keeps the latest context snapshot', async () => {
    const firstContext = {
      input_tokens: 100,
      output_tokens: 20,
      used_tokens: 120,
      system_tokens: 20,
      tools_tokens: 10,
      tool_use_tokens: 0,
      user_tokens: 70,
      assistant_tokens: 20,
    };
    const latestContext = {
      input_tokens: 180,
      output_tokens: 30,
      used_tokens: 210,
      system_tokens: 20,
      tools_tokens: 10,
      tool_use_tokens: 50,
      user_tokens: 70,
      assistant_tokens: 60,
    };
    const streamFn = mockStreamFn([
      {
        type: 'usage',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cached_tokens: 25,
          context: firstContext,
        },
      },
      {
        type: 'usage',
        usage: {
          prompt_tokens: 180,
          completion_tokens: 30,
          total_tokens: 210,
          cached_tokens: 80,
          context: latestContext,
        },
      },
      { type: 'finish', finishReason: 'stop' },
    ]);

    const actor = createActor(agentMachine, {
      input: {
        agent: mockAgent,
        systemPrompt: 'You are helpful.',
        streamFn,
        interruptResetMs: 100,
      },
    });

    actor.start();
    actor.send({ type: 'USER_INPUT', message: 'Inspect the project' });
    await waitForContext<AgentContext>(
      actor,
      (context) => context.usage?.prompt_tokens === 100,
    );

    expect(actor.getSnapshot().value).toBe('streaming');
    expect(actor.getSnapshot().context.usage?.context).toEqual(firstContext);

    await waitForState(actor, 'idle');

    expect(actor.getSnapshot().context.usage).toEqual({
      prompt_tokens: 280,
      completion_tokens: 50,
      total_tokens: 330,
      cached_tokens: 105,
      context: latestContext,
    });
  });

  it('streaming tool events → idle', async () => {
    // Simulate a stream that yields content, then tool_call, then more content, then finish.
    // AI SDK handles tool loops internally; the machine only tracks the events
    // emitted by the provider stream for UI lifecycle updates.
    const streamFn = async function* (_params: {
      message: string;
      agent: Agent;
      systemPrompt: string;
      abortSignal: AbortSignal;
      model?: string | null;
    }): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'Let me check...' };
      yield {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        args: '{"file_path":"README.md"}',
      };
      // After tool call, the stream pauses. Tool executes, result feeds back.
      // In the real flow, AI SDK handles this. For testing, we simulate.
      yield successfulToolResult('tc-1', 'file contents');
      yield { type: 'content', text: ' Done.' };
      yield { type: 'finish', finishReason: 'stop' };
    };

    const actor = createActor(agentMachine, {
      input: {
        agent: mockAgent,
        systemPrompt: 'You are helpful.',
        streamFn,
        interruptResetMs: 100,
      },
    });

    actor.start();
    actor.send({ type: 'USER_INPUT', message: 'Read the file' });

    await waitForState(actor, 'idle');
    expect(actor.getSnapshot().context.response).toContain('Let me check...');
    expect(actor.getSnapshot().context.error).toBeNull();
  });

  it('tracks streamed tool args and lifecycle updates', async () => {
    const streamFn = mockStreamFn([
      { type: 'tool_call_start', toolCallId: 'tc-1', toolName: 'read_file' },
      { type: 'tool_call_delta', toolCallId: 'tc-1', argsDelta: '{"file_path":' },
      { type: 'tool_call_delta', toolCallId: 'tc-1', argsDelta: '"README.md"}' },
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        args: '{"file_path":"README.md"}',
      },
      successfulToolResult('tc-1', 'file contents'),
      { type: 'finish', finishReason: 'stop' },
    ]);

    const actor = createActor(agentMachine, {
      input: {
        agent: mockAgent,
        systemPrompt: 'You are helpful.',
        streamFn,
        interruptResetMs: 100,
      },
    });

    actor.start();
    actor.send({ type: 'USER_INPUT', message: 'Read the file' });

    await waitForState(actor, 'idle');
    const update = actor.getSnapshot().context.toolLifecycleUpdate;
    expect(update).toMatchObject({
      toolCallId: 'tc-1',
      toolName: 'read_file',
      status: 'complete',
      content: 'file contents',
      toolResult: expect.objectContaining({ status: 'complete' }),
    });
    expect(actor.getSnapshot().context.toolUpdateSequence).toBe(2);
  });

  it('streaming → CANCEL → interrupted → (manual CANCEL) → idle', async () => {
    const streamFn = mockCancellableStreamFn();

    const actor = createActor(agentMachine, {
      input: {
        agent: mockAgent,
        systemPrompt: 'You are helpful.',
        streamFn,
        interruptResetMs: 100,
      },
    });

    actor.start();
    actor.send({ type: 'USER_INPUT', message: 'Long task' });

    // Wait for stream to start yielding
    await waitForContext(actor, (ctx: { response: string }) => ctx.response.length > 0);

    actor.send({ type: 'CANCEL' });
    await waitForState(actor, 'interrupted');

    // Manual cancel to transition to idle
    actor.send({ type: 'CANCEL' });
    await waitForState(actor, 'idle');
  }, 10000);

  it('error → USER_INPUT → streaming (recovery)', async () => {
    let callCount = 0;
    const streamFn = async function* (): AsyncGenerator<StreamEvent> {
      callCount++;
      if (callCount === 1) {
        yield { type: 'error', title: 'Error', detail: 'Rate limit' };
      } else {
        yield { type: 'content', text: 'Success!' };
        yield { type: 'finish', finishReason: 'stop' };
      }
    };

    const actor = createActor(agentMachine, {
      input: {
        agent: mockAgent,
        systemPrompt: 'You are helpful.',
        streamFn,
        interruptResetMs: 100,
      },
    });

    actor.start();

    // First attempt fails
    actor.send({ type: 'USER_INPUT', message: 'Test' });
    await waitForState(actor, 'error');
    expect(actor.getSnapshot().context.error).toBe('Rate limit');

    // Retry succeeds
    actor.send({ type: 'USER_INPUT', message: 'Test again' });
    await waitForState(actor, 'idle');
    expect(actor.getSnapshot().context.response).toBe('Success!');
  });
});

// ── Interrupt Machine Tests ─────────────────────────────────────────────────

describe('Interrupt Machine', () => {
  it('IDLE → INTERRUPT → CONFIRM_AGENT', () => {
    const actor = createActor(interruptMachine);
    actor.start();

    expect(actor.getSnapshot().value).toBe('idle');

    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmAgent');

    actor.stop();
  });

  it('CONFIRM_AGENT → INTERRUPT → CONFIRM_SUBAGENTS', () => {
    const actor = createActor(interruptMachine);
    actor.start();

    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmAgent');

    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmSubagents');

    actor.stop();
  });

  it('IDLE → INTERRUPT → INTERRUPT_TIMEOUT → idle (auto-reset)', () => {
    const actor = createActor(interruptMachine);
    actor.start();

    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmAgent');

    // Simulate timeout event (in production, a timer fires this)
    actor.send({ type: 'INTERRUPT_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('idle');

    actor.stop();
  });

  it('multiple Esc presses cycle through states', () => {
    const actor = createActor(interruptMachine);
    actor.start();

    // First Esc → confirmAgent
    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmAgent');

    // Second Esc → confirmSubagents (stream cancelled, subagents pending)
    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmSubagents');

    // Third Esc → idle
    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('idle');

    // Fourth Esc → confirmAgent again
    actor.send({ type: 'INTERRUPT' });
    expect(actor.getSnapshot().value).toBe('confirmAgent');

    // Timeout → idle
    actor.send({ type: 'INTERRUPT_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('idle');

    actor.stop();
  });
});

// ── SubagentManager Tests ───────────────────────────────────────────────────

describe('SubagentManager', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it('spawn creates a record in PENDING state', () => {
    const record = manager.spawn('test', 'do something', mockAgent);

    expect(record.state).toBe(SubagentState.PENDING);
    expect(record.label).toBe('test');
    expect(record.task).toBe('do something');
    expect(record.result).toBeNull();
    expect(record.error).toBeNull();
  });

  it('allRecords returns all spawned records', () => {
    manager.spawn('first', 'task 1', mockAgent);
    manager.spawn('second', 'task 2', mockAgent);

    const records = manager.allRecords();
    expect(records).toHaveLength(2);
    expect(records[0].label).toBe('first');
    expect(records[1].label).toBe('second');
  });

  it('getStates returns state info for all subagents', () => {
    manager.spawn('test', 'task', mockAgent);

    const states = manager.getStates();
    expect(states).toHaveLength(1);
    expect(states[0].name).toBe('general');
    expect(states[0].state).toBe('pending');
  });

  it('markCompleted transitions to COMPLETED and resolves waiters', async () => {
    const record = manager.spawn('test', 'task', mockAgent);

    const waitPromise = manager.wait([record.id]);
    manager.markCompleted(record.id, 'Done!');

    const results = await waitPromise;
    expect(results.get(record.id)?.state).toBe(SubagentState.COMPLETED);
    expect(results.get(record.id)?.result).toBe('Done!');
  });

  it('markFailed transitions to FAILED and resolves waiters', async () => {
    const record = manager.spawn('test', 'task', mockAgent);

    const waitPromise = manager.wait([record.id]);
    manager.markFailed(record.id, 'Something broke');

    const results = await waitPromise;
    expect(results.get(record.id)?.state).toBe(SubagentState.FAILED);
    expect(results.get(record.id)?.error).toBe('Something broke');
  });

  it('cancelOne returns true for non-terminal, false for terminal', () => {
    const pending = manager.spawn('pending', 'task', mockAgent);
    const completed = manager.spawn('completed', 'task', mockAgent);
    manager.markCompleted(completed.id, 'done');

    expect(manager.cancelOne(pending.id)).toBe(true);
    expect(pending.state).toBe(SubagentState.INTERRUPTED);

    expect(manager.cancelOne(completed.id)).toBe(false);
  });

  it('cancelAll cancels all non-terminal subagents', () => {
    const a = manager.spawn('a', 'task', mockAgent);
    const b = manager.spawn('b', 'task', mockAgent);
    manager.markCompleted(b.id, 'done');
    const c = manager.spawn('c', 'task', mockAgent);

    const cancelled = manager.cancelAll();

    expect(cancelled).toContain(a.id);
    expect(cancelled).not.toContain(b.id);
    expect(cancelled).toContain(c.id);
  });

  it('cancelRunning cancels only running subagents', () => {
    const pending = manager.spawn('pending', 'task', mockAgent);
    manager.markRunning(pending.id);
    const completed = manager.spawn('completed', 'task', mockAgent);
    manager.markCompleted(completed.id, 'done');

    const cancelled = manager.cancelRunning();

    expect(cancelled).toContain(pending.id);
    expect(cancelled).not.toContain(completed.id);
  });

  it('wait resolves immediately for already-terminal subagents', async () => {
    const record = manager.spawn('test', 'task', mockAgent);
    manager.markCompleted(record.id, 'done');

    const results = await manager.wait([record.id]);
    expect(results.get(record.id)?.state).toBe(SubagentState.COMPLETED);
  });

  it('wait resolves immediately when a requested subagent already has a pending question', async () => {
    const record = manager.spawn('test', 'task', mockAgent);
    manager.markRunning(record.id);
    const questionPromise = manager.markQuestionPending(record.id, 'tc-before-wait', [
      {
        type: 'single',
        title: 'Choose a direction',
        options: [{ label: 'Continue' }],
      },
    ]);

    try {
      const results = await manager.wait([record.id], { timeoutMs: 30 });
      expect(results.get(record.id)?.pendingQuestion?.toolCallId).toBe('tc-before-wait');
    } finally {
      manager.answerSubagentQuestion(record.id, 'tc-before-wait', { type: 'declined' });
      await questionPromise;
    }
  });

  it('declines a second concurrent question without replacing the first', async () => {
    const record = manager.spawn('test', 'task', mockAgent);
    manager.markRunning(record.id);

    const first = manager.markQuestionPending(record.id, 'tc-first', [
      {
        type: 'single',
        title: 'First question',
        options: [{ label: 'Continue' }],
      },
    ]);
    const second = manager.markQuestionPending(record.id, 'tc-second', [
      {
        type: 'single',
        title: 'Second question',
        options: [{ label: 'Continue' }],
      },
    ]);

    await expect(second).resolves.toEqual({ type: 'declined' });
    expect(record.pendingQuestion?.toolCallId).toBe('tc-first');
    expect(manager.answerSubagentQuestion(record.id, 'tc-first', { type: 'declined' })).toBe(true);
    await expect(first).resolves.toEqual({ type: 'declined' });
  });

  it('rejects a delayed answer after the next question is installed', async () => {
    const record = manager.spawn('test', 'task', mockAgent);
    manager.markRunning(record.id);

    const first = manager.markQuestionPending(record.id, 'tc-first', []);
    expect(manager.answerSubagentQuestion(record.id, 'tc-first', { type: 'declined' })).toBe(true);
    await expect(first).resolves.toEqual({ type: 'declined' });

    const second = manager.markQuestionPending(record.id, 'tc-second', []);
    expect(manager.answerSubagentQuestion(record.id, 'tc-first', { type: 'declined' })).toBe(false);
    expect(record.pendingQuestion?.toolCallId).toBe('tc-second');
    expect(manager.answerSubagentQuestion(record.id, 'tc-second', { type: 'declined' })).toBe(true);
    await expect(second).resolves.toEqual({ type: 'declined' });
  });

  it('getRecord returns a single record by ID', () => {
    const record = manager.spawn('test', 'task', mockAgent);

    expect(manager.getRecord(record.id)).toBe(record);
    expect(manager.getRecord('nonexistent')).toBeUndefined();
  });

  it('wait resolves when one of multiple subagents completes', async () => {
    const a = manager.spawn('a', 'task 1', mockAgent);
    const b = manager.spawn('b', 'task 2', mockAgent);

    const waitPromise = manager.wait([a.id, b.id]);

    // Complete one immediately
    manager.markCompleted(a.id, 'result a');

    // Complete the other after a small delay
    setTimeout(() => manager.markCompleted(b.id, 'result b'), 10);

    const results = await waitPromise;
    expect(results.size).toBe(2);
    expect(results.get(a.id)?.result).toBe('result a');
    expect(results.get(b.id)?.result).toBe('result b');
  });

  it('wait resolves on the first pending question in a multi-target wait and cleans peer waiters', async () => {
    const a = manager.spawn('a', 'task 1', mockAgent);
    const b = manager.spawn('b', 'task 2', mockAgent);
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    const waitPromise = manager.wait([a.id, b.id], { timeoutMs: 30 });
    const questionPromise = manager.markQuestionPending(a.id, 'tc-first-question', [
      {
        type: 'single',
        title: 'Need parent input',
        options: [{ label: 'Proceed' }],
      },
    ]);

    try {
      const results = await waitPromise;
      expect(results.get(a.id)?.pendingQuestion?.toolCallId).toBe('tc-first-question');
      expect(results.get(b.id)?.state).toBe(SubagentState.RUNNING);
      expect(b._resolveWait).toBeNull();
    } finally {
      manager.answerSubagentQuestion(a.id, 'tc-first-question', { type: 'declined' });
      await questionPromise;
    }
  });

  it('wait timeout errors without cancelling running subagents', async () => {
    const record = manager.spawn('hang', 'never ends', mockAgent);
    manager.markRunning(record.id);

    await expect(
      manager.wait([record.id], { timeoutMs: 30 }),
    ).rejects.toMatchObject({
      name: 'SubagentWaitTimeoutError',
      message: expect.stringContaining('Only the wait tool stopped waiting'),
    });

    expect(record.state).toBe(SubagentState.RUNNING);
    expect(record._resolveWait).toBeNull();
  });

  it('wait abort signal unblocks without cancelling children', async () => {
    const record = manager.spawn('hang', 'never ends', mockAgent);
    manager.markRunning(record.id);
    const ac = new AbortController();

    const waitPromise = manager.wait([record.id], { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);

    await expect(waitPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(record.state).toBe(SubagentState.RUNNING);
  });
});
