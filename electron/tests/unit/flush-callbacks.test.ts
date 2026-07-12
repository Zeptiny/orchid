/**
 * Tests for flushStateCallbacks (U9).
 *
 * Covers:
 * - flushStateCallbacks() resolves pending _resolveWait promises
 * - flushStateCallbacks() is a no-op when no callbacks are pending
 * - interrupt_subagents calls flushStateCallbacks() before cancelling
 * - Interrupt during tool execution → clean state reset
 *
 * Test scenarios from plan U9.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentType, AgentTier, type Agent } from '../../src/shared/types/agent';
import { SubagentManager, SubagentState } from '../../src/main/agents/manager';
import { buildInterruptTool } from '../../src/main/tools/subagent/interrupt';
import type { SubagentToolResult } from '../../src/main/tools/subagent/delegate';

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

// ── interrupt_subagents integration with flush ───────────────────────────────

describe('interrupt_subagents with flush', () => {
  let manager: SubagentManager;
  const sessionCtx = { cwd: '/tmp/project', sessionId: 'sess-a' };

  beforeEach(() => {
    manager = new SubagentManager();
  });

  it('should flush callbacks before cancelling (happy path)', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(record.id);

    // Set up a pending wait — simulates a caller waiting on the subagent
    const waitPromise = manager.wait([record.id]);
    expect(record._resolveWait).not.toBeNull();

    const result = (await handler(
      { subagent_ids: [record.id] },
      sessionCtx,
    )) as SubagentToolResult;

    // Subagent should be interrupted
    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(result.display).toContain('Interrupted 1 subagent(s)');

    // The wait promise should have been resolved (no dangling promise)
    const waitResult = await waitPromise;
    expect(waitResult.has(record.id)).toBe(true);
    expect(record._resolveWait).toBeNull();
  });

  it('should flush callbacks when cancelling all in-session (empty IDs)', async () => {
    const { handler } = buildInterruptTool(manager);
    const a = manager.spawn('a', 'task 1', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    const b = manager.spawn('b', 'task 2', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(a.id);
    manager.markRunning(b.id);

    // Set up pending waits
    const waitPromiseA = manager.wait([a.id]);
    const waitPromiseB = manager.wait([b.id]);

    const result = (await handler(
      { subagent_ids: [] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.display).toContain('Interrupted 2 subagent(s)');
    expect(a.state).toBe(SubagentState.INTERRUPTED);
    expect(b.state).toBe(SubagentState.INTERRUPTED);

    // No dangling promises
    await waitPromiseA;
    await waitPromiseB;
    expect(a._resolveWait).toBeNull();
    expect(b._resolveWait).toBeNull();
  });

  it('should handle no pending callbacks gracefully', async () => {
    const { handler } = buildInterruptTool(manager);
    const record = manager.spawn('test', 'task', codeReviewerAgent, {
      sessionId: 'sess-a',
    });
    manager.markRunning(record.id);

    // No pending wait — just interrupt
    const result = (await handler(
      { subagent_ids: [record.id] },
      sessionCtx,
    )) as SubagentToolResult;

    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(result.display).toContain('Interrupted 1 subagent(s)');
  });

  it('should handle mix of found, not found, and already done with flush', async () => {
    const { handler } = buildInterruptTool(manager);

    const running = manager.spawn('running', 'task', codeReviewerAgent);
    manager.markRunning(running.id);

    const completed = manager.spawn('completed', 'task', codeReviewerAgent);
    manager.markCompleted(completed.id, 'done');

    // Set up a pending wait on the running subagent
    const waitPromise = manager.wait([running.id]);

    const result = (await handler(
      {
        subagent_ids: [running.id, completed.id, 'missing-id'],
      },
      sessionCtx,
    )) as SubagentToolResult;

    expect(result.content).toContain('Interrupted');
    expect(result.content).toContain(running.id);
    expect(result.content).toContain('Already finished');
    expect(result.content).toContain(completed.id);
    expect(result.content).toContain('Not found');
    expect(result.content).toContain('missing-id');

    // Wait promise should be resolved
    await waitPromise;
    expect(running._resolveWait).toBeNull();
  });
});
