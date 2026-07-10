/**
 * Architecture Validation Tests — U28/U29.
 *
 * Validates that the TS/Electron architecture delivers the properties
 * promised by the migration, by exercising REAL app modules:
 *
 * 1. Parallel subagents — SubagentManager + concurrent subagentMachines
 * 2. Reactive state updates — agentMachine tool lifecycle context
 * 3. Responsive control during stream — CANCEL / interrupt while streaming
 * 4. Correct auto-scroll — pure helpers used by ChatStream
 *
 * These are architecture-property tests, not hollow Promise.all/setTimeout
 * simulations that only prove the JavaScript runtime works.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createActor } from 'xstate';
import {
  SubagentManager,
  SubagentState,
} from '../../src/main/agents/manager';
import { agentMachine } from '../../src/main/agents/xstate/agent-machine';
import { subagentMachine } from '../../src/main/agents/xstate/subagent-machine';
import { sessionMachine } from '../../src/main/agents/xstate/session-machine';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import type { Agent } from '../../src/shared/types/agent';
import { AgentType, AgentTier } from '../../src/shared/types/agent';
import {
  AUTO_SCROLL_THRESHOLD_PX,
  isUserScrolledAwayFromBottom,
  shouldAutoScroll,
} from '../../src/renderer/components/ChatStream';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const testAgent: Agent = {
  name: 'explorer',
  type: AgentType.SUBAGENT,
  tier: AgentTier.BLOOM,
  description: 'test subagent',
  system_prompt: 'You explore.',
  allowed_tools: ['read', 'grep'],
  allowed_skills: [],
};

const mockAgent: Agent = {
  name: 'general',
  type: AgentType.INTERNAL,
  tier: AgentTier.BLOOM,
  description: 'General-purpose agent',
  allowed_tools: ['*'],
  allowed_skills: ['*'],
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Wait for an actor to reach a target state value.
 * Checks current snapshot first (handles synchronous transitions).
 */
function waitForState(
  actor: ReturnType<typeof createActor>,
  targetState: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (actor.getSnapshot().value === targetState) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      sub.unsubscribe();
      const snap = actor.getSnapshot();
      reject(
        new Error(
          `Timeout waiting for state ${targetState}. ` +
            `Current: ${JSON.stringify(snap.value)}, context.error: ${snap.context.error}`,
        ),
      );
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    const sub = actor.subscribe((snapshot) => {
      if (snapshot.value === targetState) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

function waitForContext<T>(
  actor: ReturnType<typeof createActor>,
  predicate: (ctx: T) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate(actor.getSnapshot().context as T)) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error('Timeout waiting for context condition'));
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    const sub = actor.subscribe((snapshot) => {
      if (predicate(snapshot.context as T)) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Architecture Properties (real modules)', () => {
  describe('1. Parallel subagents', () => {
    let manager: SubagentManager;

    beforeEach(() => {
      manager = new SubagentManager();
    });

    it('SubagentManager spawns 4 runners that execute in parallel', async () => {
      const DELAY_MS = 80;
      const SUBAGENT_COUNT = 4;
      const startTimes = new Map<string, number>();

      // Real manager API: setRunner drives isolated streams on spawn().
      manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
        startTimes.set(params.task, Date.now());
        try {
          await delay(DELAY_MS, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: `done:${params.task}` };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const wallStart = Date.now();
      const records = Array.from({ length: SUBAGENT_COUNT }, (_, i) =>
        manager.spawn(`explorer-${i}`, `task-${i}`, testAgent),
      );

      // Runner starts immediately for each spawn
      for (const r of records) {
        expect(r._runPromise).not.toBeNull();
      }

      const results = await manager.wait(records.map((r) => r.id));
      const wallDuration = Date.now() - wallStart;

      expect(results.size).toBe(SUBAGENT_COUNT);
      for (const r of records) {
        expect(results.get(r.id)?.state).toBe(SubagentState.COMPLETED);
        expect(results.get(r.id)?.result).toBe(`done:task-${records.indexOf(r)}`);
      }

      // Parallel: wall clock ≈ one delay, not N × delay
      expect(wallDuration).toBeLessThan(DELAY_MS * SUBAGENT_COUNT * 0.6);

      // All runners should have started near-simultaneously
      const starts = Array.from(startTimes.values());
      expect(starts).toHaveLength(SUBAGENT_COUNT);
      const maxStartSpread = Math.max(...starts) - Math.min(...starts);
      expect(maxStartSpread).toBeLessThan(DELAY_MS * 0.5);
    });

    it('concurrent subagentMachines complete in parallel (not serialized)', async () => {
      const DELAY_MS = 60;
      const COUNT = 4;
      const startedAt: number[] = [];

      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
        model?: string | null;
      }): AsyncGenerator<StreamEvent> {
        startedAt.push(Date.now());
        try {
          await delay(DELAY_MS, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: `ok:${params.message}` };
        yield { type: 'finish', finishReason: 'stop' };
      };

      const wallStart = Date.now();
      const actors = Array.from({ length: COUNT }, (_, i) =>
        createActor(subagentMachine, {
          input: {
            id: `sub-${i}`,
            label: `Sub ${i}`,
            task: `task-${i}`,
            agent: testAgent,
            systemPrompt: 'You explore.',
            streamFn,
          },
        }),
      );

      for (const a of actors) a.start();
      await Promise.all(actors.map((a) => waitForState(a, 'completed')));
      const wallDuration = Date.now() - wallStart;

      for (const a of actors) {
        expect(a.getSnapshot().context.response).toMatch(/^ok:task-/);
        a.stop();
      }

      expect(wallDuration).toBeLessThan(DELAY_MS * COUNT * 0.6);
      expect(startedAt).toHaveLength(COUNT);
      const maxStartSpread = Math.max(...startedAt) - Math.min(...startedAt);
      expect(maxStartSpread).toBeLessThan(DELAY_MS * 0.5);
    });

    it('sessionMachine can register multiple SPAWN_SUBAGENT entries concurrently', () => {
      const streamFn = async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(sessionMachine, {
        input: {
          sessionId: 'arch-parallel',
          activeAgent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          subagentStreamFn: streamFn,
          executeFn: async () => ({ content: 'ok', isError: false }),
        },
      });
      actor.start();

      // Move to active so SPAWN_SUBAGENT is accepted
      actor.send({ type: 'USER_INPUT', message: 'go' });
      for (let i = 0; i < 4; i++) {
        actor.send({
          type: 'SPAWN_SUBAGENT',
          name: `explorer-${i}`,
          task: `task-${i}`,
          agentType: 'subagent',
        });
      }

      const subagents = actor.getSnapshot().context.subagents;
      expect(subagents.size).toBe(4);
      // All registered immediately (not blocked by each other)
      for (const entry of subagents.values()) {
        expect(['pending', 'running', 'completed']).toContain(entry.state);
      }

      actor.stop();
    });
  });

  describe('2. Reactive state updates', () => {
    it('agentMachine tool lifecycle updates context between tool events', async () => {
      // Stream yields two sequential tool cycles; context must reflect each step.
      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
      }): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'Checking…' };
        yield {
          type: 'tool_call',
          toolCallId: 'tc-read',
          toolName: 'read',
          args: '{"file_path":"a.ts"}',
        };
        // Brief yield so subscribers observe intermediate state
        await delay(5, params.abortSignal);
        yield {
          type: 'tool_result',
          toolCallId: 'tc-read',
          content: 'file contents',
          isError: false,
        };
        await delay(5, params.abortSignal);
        yield {
          type: 'tool_call',
          toolCallId: 'tc-edit',
          toolName: 'edit',
          args: '{"file_path":"a.ts","old_string":"a","new_string":"b"}',
        };
        await delay(5, params.abortSignal);
        yield {
          type: 'tool_result',
          toolCallId: 'tc-edit',
          content: 'ok',
          isError: false,
        };
        yield { type: 'content', text: ' Done.' };
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(agentMachine, {
        input: {
          agent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          executeFn: async () => ({ content: 'ok', isError: false }),
          interruptResetMs: 100,
        },
      });

      // Capture reactive snapshots of toolLifecycleUpdate as events arrive
      const lifecycleSnapshots: Array<{
        toolCallId: string;
        toolName?: string;
        status: string;
      }> = [];
      const seen = new Set<string>();
      const sub = actor.subscribe((snap) => {
        const u = snap.context.toolLifecycleUpdate;
        if (!u) return;
        const key = `${u.sequence}:${u.toolCallId}:${u.status}`;
        if (seen.has(key)) return;
        seen.add(key);
        lifecycleSnapshots.push({
          toolCallId: u.toolCallId,
          toolName: u.toolName,
          status: u.status,
        });
      });

      actor.start();
      actor.send({ type: 'USER_INPUT', message: 'Edit a.ts' });

      await waitForState(actor, 'idle');
      sub.unsubscribe();

      // At least one update per tool (running + completed) — context progressed
      expect(lifecycleSnapshots.length).toBeGreaterThanOrEqual(4);
      expect(lifecycleSnapshots.map((s) => s.toolCallId)).toEqual(
        expect.arrayContaining(['tc-read', 'tc-edit']),
      );

      const statusesFor = (id: string) =>
        lifecycleSnapshots.filter((s) => s.toolCallId === id).map((s) => s.status);
      expect(statusesFor('tc-read')).toContain('running');
      expect(statusesFor('tc-read')).toContain('completed');
      expect(statusesFor('tc-edit')).toContain('running');
      expect(statusesFor('tc-edit')).toContain('completed');

      // Final context retains last lifecycle update and full response text
      const final = actor.getSnapshot().context;
      expect(final.response).toContain('Checking…');
      expect(final.response).toContain('Done.');
      expect(final.toolLifecycleUpdate?.toolCallId).toBe('tc-edit');
      expect(final.toolLifecycleUpdate?.status).toBe('completed');
      expect(final.toolUpdateSequence).toBeGreaterThanOrEqual(4);

      actor.stop();
    });

    it('SubagentManager onChange notifies as each subagent progresses', async () => {
      const changeCounts: number[] = [];
      let lastRunningCount = 0;

      const manager = new SubagentManager();
      manager.setOnChange((records) => {
        changeCounts.push(records.length);
        lastRunningCount = records.filter(
          (r) => r.state === SubagentState.RUNNING || r.state === SubagentState.COMPLETED,
        ).length;
      });

      manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
        try {
          await delay(30, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: 'done' };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const a = manager.spawn('a', 'task-a', testAgent);
      const b = manager.spawn('b', 'task-b', testAgent);

      await manager.wait([a.id, b.id]);

      // setOnChange fired for spawn + running + completion steps
      expect(changeCounts.length).toBeGreaterThanOrEqual(4);
      expect(lastRunningCount).toBe(2);
      expect(manager.getRecord(a.id)?.state).toBe(SubagentState.COMPLETED);
      expect(manager.getRecord(b.id)?.state).toBe(SubagentState.COMPLETED);
    });
  });

  describe('3. Responsive control during stream', () => {
    it('agentMachine accepts CANCEL while streaming and transitions without hang', async () => {
      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
      }): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'Starting…' };
        // Long-running stream that honors abort
        try {
          await delay(2000, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: ' should not appear' };
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(agentMachine, {
        input: {
          agent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          executeFn: async () => ({ content: 'ok', isError: false }),
          interruptResetMs: 50,
        },
      });

      actor.start();
      actor.send({ type: 'USER_INPUT', message: 'long task' });
      expect(actor.getSnapshot().value).toBe('streaming');

      await waitForContext(actor, (ctx: { response: string }) =>
        ctx.response.includes('Starting'),
      );

      // CANCEL must be processed while stream is still in flight
      actor.send({ type: 'CANCEL' });
      await waitForState(actor, 'interrupted', 2000);

      expect(actor.getSnapshot().context.wasInterrupted).toBe(true);
      expect(actor.getSnapshot().context.response).toContain('Starting');
      expect(actor.getSnapshot().context.response).not.toContain('should not appear');

      // Second CANCEL returns to idle (interrupt machine style confirmation)
      actor.send({ type: 'CANCEL' });
      await waitForState(actor, 'idle', 2000);

      actor.stop();
    }, 10000);

    it('streaming response keeps updating while interrupt remains available', async () => {
      let chunkCount = 0;
      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
      }): AsyncGenerator<StreamEvent> {
        for (let i = 0; i < 5; i++) {
          if (params.abortSignal.aborted) return;
          yield { type: 'content', text: `c${i}` };
          chunkCount++;
          await delay(15, params.abortSignal).catch(() => undefined);
          if (params.abortSignal.aborted) return;
        }
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(agentMachine, {
        input: {
          agent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          executeFn: async () => ({ content: 'ok', isError: false }),
          interruptResetMs: 100,
        },
      });

      const responses: string[] = [];
      actor.start();
      const sub = actor.subscribe((snap) => {
        if (snap.value === 'streaming' && snap.context.response) {
          responses.push(snap.context.response);
        }
      });

      actor.send({ type: 'USER_INPUT', message: 'stream me' });

      // Mid-stream: machine is still streaming and CANCEL is a valid event
      await waitForContext(actor, (ctx: { response: string }) =>
        ctx.response.length >= 4,
      );
      expect(actor.getSnapshot().value).toBe('streaming');
      // XState still accepts CANCEL in streaming (responsive control plane)
      const canCancel = actor
        .getSnapshot()
        .can({ type: 'CANCEL' });
      expect(canCancel).toBe(true);

      await waitForState(actor, 'idle');
      sub.unsubscribe();

      // Response grew reactively across multiple subscriptions
      expect(chunkCount).toBe(5);
      expect(responses.length).toBeGreaterThan(1);
      expect(actor.getSnapshot().context.response).toBe('c0c1c2c3c4');

      actor.stop();
    });
  });

  describe('4. Correct auto-scroll (ChatStream helpers)', () => {
    it('isUserScrolledAwayFromBottom matches ChatStream threshold semantics', () => {
      // Exactly at threshold → still considered at bottom
      expect(
        isUserScrolledAwayFromBottom(500, 1000, 400, AUTO_SCROLL_THRESHOLD_PX),
      ).toBe(false); // distance = 100, not > 100

      // Past threshold → scrolled up
      expect(
        isUserScrolledAwayFromBottom(400, 1000, 400, AUTO_SCROLL_THRESHOLD_PX),
      ).toBe(true); // distance = 200

      // At bottom
      expect(
        isUserScrolledAwayFromBottom(600, 1000, 400, AUTO_SCROLL_THRESHOLD_PX),
      ).toBe(false); // distance = 0
    });

    it('shouldAutoScroll is independent of message count', () => {
      // Adding messages does not flip the flag by itself — only scroll position does.
      const messageCounts = [0, 1, 10, 50, 100];
      for (const _n of messageCounts) {
        expect(shouldAutoScroll(false)).toBe(true);
        expect(shouldAutoScroll(true)).toBe(false);
      }
    });

    it('auto-scroll re-enables only after user returns near bottom', () => {
      let isUserScrolledUp = false;
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(true);

      // User scrolls up past threshold
      isUserScrolledUp = isUserScrolledAwayFromBottom(200, 2000, 400);
      expect(isUserScrolledUp).toBe(true);
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(false);

      // New messages arrive — flag stays based on scroll position, not count
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(false);

      // User scrolls back near bottom
      isUserScrolledUp = isUserScrolledAwayFromBottom(1500, 2000, 400);
      expect(isUserScrolledUp).toBe(false);
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(true);
    });
  });
});
