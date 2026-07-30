/**
 * Tests for flushStateCallbacks and interrupt waiter isolation (M-P0-013).
 *
 * Covers:
 * - flushStateCallbacks() resolves pending _resolveWait promises
 * - flushStateCallbacks() is a no-op when no callbacks are pending
 * - interrupt_subagents resolves waiters only for cancelled records
 *   (does not process-wide flush)
 * - Session B interrupt does not unblock session A waiters
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentType, AgentTier, type Agent } from '../../src/shared/types/agent';
import { SubagentManager } from '../../src/main/agents/manager';
import { SubagentState } from '../../src/main/agents/types';
import { buildInterruptTool } from '../../src/main/tools/subagent/interrupt';
import type { SubagentToolResult } from '../../src/main/tools/subagent/delegate';

function resultText(result: SubagentToolResult): string {
  return typeof result.data.value === 'string'
    ? result.data.value
    : JSON.stringify(result.data.value);
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const codeReviewerAgent: Agent = {
  name: 'code-reviewer',
  type: AgentType.SUBAGENT,
  tier: AgentTier.CROWN,
  description: 'Reviews code for quality and correctness',
  allowed_tools: ['read', 'grep', 'glob'],
  allowed_skills: ['*'],
};

// ── flushStateCallbacks ──────────────────────────────────────────────────────

describe('flushStateCallbacks', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it('should resolve pending _resolveWait promises on running subagents', async () => {
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markRunning(record.id);

    // Start waiting — creates a pending _resolveWait promise
    const waitPromise = manager.wait([record.id]);

    // Verify callbacks are pending
    expect(record._resolveWait).not.toBeNull();
    expect(record._resolveWait!.length).toBeGreaterThan(0);

    // Flush should resolve them
    const flushed = manager.flushStateCallbacks();

    expect(flushed).toContain(record.id);

    // The wait promise should now resolve (record is still running, but promise settled)
    const results = await waitPromise;
    expect(results.has(record.id)).toBe(true);
    // Record is still in non-terminal state since we only flushed, not cancelled
    expect(record.state).toBe(SubagentState.RUNNING);
  });

  it('should be a no-op when no callbacks are pending', () => {
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markRunning(record.id);

    // No one is waiting — _resolveWait should be empty array
    const flushed = manager.flushStateCallbacks();

    expect(flushed).toHaveLength(0);
    expect(record._resolveWait).toEqual([]);
  });

  it('should be a no-op when no subagents exist', () => {
    const flushed = manager.flushStateCallbacks();
    expect(flushed).toHaveLength(0);
  });

  it('should flush callbacks on multiple subagents', async () => {
    const a = manager.spawn('a', 'task 1', codeReviewerAgent);
    const b = manager.spawn('b', 'task 2', codeReviewerAgent);
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    // Start waiting on both
    const waitPromiseA = manager.wait([a.id]);
    const waitPromiseB = manager.wait([b.id]);

    const flushed = manager.flushStateCallbacks();

    expect(flushed).toContain(a.id);
    expect(flushed).toContain(b.id);

    // Both wait promises should resolve
    await waitPromiseA;
    await waitPromiseB;
  });

  it('should not flush callbacks on already-terminal subagents', async () => {
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markCompleted(record.id, 'done');

    // _resolveWait is null after markCompleted
    expect(record._resolveWait).toBeNull();

    const flushed = manager.flushStateCallbacks();
    expect(flushed).toHaveLength(0);
  });

  it('should set _resolveWait to null after flushing', async () => {
    const record = manager.spawn('test', 'task', codeReviewerAgent);
    manager.markRunning(record.id);

    manager.wait([record.id]); // creates pending callback
    expect(record._resolveWait).not.toBeNull();

    manager.flushStateCallbacks();

    expect(record._resolveWait).toBeNull();
  });
});

// ── interrupt_subagents waiter isolation (M-P0-013) ─────────────────────────

describe('interrupt_subagents waiter isolation', () => {
  let manager: SubagentManager;
  const sessionCtx = { cwd: '/tmp/project', sessionId: 'sess-a' };

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it('cancelOne resolves waiters for cancelled records (no process-wide flush)', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(record.id);

    const waitPromise = manager.wait([record.id]);
    expect(record._resolveWait).not.toBeNull();

    const result = (await handler(
      { subagent_ids: [record.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(resultText(result)).toContain('"interrupted"');

    const waitResult = await waitPromise;
    expect(waitResult.has(record.id)).toBe(true);
    expect(record._resolveWait).toBeNull();
  });

  it('empty-list interrupt resolves only cancelled in-session waiters', async () => {
    const { handler } = buildInterruptTool(manager);
    const a = manager.spawn('a', 'task 1', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    const b = manager.spawn('b', 'task 2', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    const waitPromiseA = manager.wait([a.id]);
    const waitPromiseB = manager.wait([b.id]);

    const result = (await handler(
      { subagent_ids: [] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(resultText(result)).toContain('"interrupted"');
    expect(a.state).toBe(SubagentState.INTERRUPTED);
    expect(b.state).toBe(SubagentState.INTERRUPTED);

    await waitPromiseA;
    await waitPromiseB;
    expect(a._resolveWait).toBeNull();
    expect(b._resolveWait).toBeNull();
  });

  it('session B interrupt does not unblock session A wait', async () => {
    const { handler } = buildInterruptTool(manager);
    const a = manager.spawn('a', 'task a', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    const b = manager.spawn('b', 'task b', codeReviewerAgent, {
      sessionId: 'sess-b',
    });
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    let aWaitSettled = false;
    const waitA = manager.wait([a.id]).then((r) => {
      aWaitSettled = true;
      return r;
    });

    // Session B interrupts its own subagent only
    const result = (await handler(
      { subagent_ids: [b.id] },
      { cwd: '/tmp/project', sessionId: 'sess-b' },
    )) as SubagentToolResult;

    expect(resultText(result)).toContain('"interrupted"');
    expect(b.state).toBe(SubagentState.INTERRUPTED);
    expect(a.state).toBe(SubagentState.RUNNING);
    expect(a._resolveWait).not.toBeNull();
    expect(aWaitSettled).toBe(false);

    // Session A still waiting until its own subagent completes
    manager.markCompleted(a.id, 'done-a');
    const results = await waitA;
    expect(results.get(a.id)?.result).toBe('done-a');
  });

  it('should handle no pending callbacks gracefully', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(record.id);

    const result = (await handler(
      { subagent_ids: [record.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(resultText(result)).toContain('"interrupted"');
  });

  it('should handle mix of found, not found, and already done', async () => {
    const { handler } = buildInterruptTool(manager);

    const running = manager.spawn('running', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(running.id);

    const completed = manager.spawn('completed', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markCompleted(completed.id, 'done');

    const waitPromise = manager.wait([running.id]);

    const result = (await handler(
      {
        subagent_ids: [running.id, completed.id, 'missing-id'],
      },
      sessionCtx,
    )) as SubagentToolResult;

    expect(resultText(result)).toContain('"interrupted"');
    expect(resultText(result)).toContain(running.id);
    expect(resultText(result)).toContain('"already_finished"');
    expect(resultText(result)).toContain(completed.id);
    expect(resultText(result)).toContain('"not_found"');
    expect(resultText(result)).toContain('missing-id');

    await waitPromise;
    expect(running._resolveWait).toBeNull();
  });
});
