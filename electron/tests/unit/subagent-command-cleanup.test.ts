/**
 * Subagent terminal transitions terminate their owned background commands (R9).
 *
 * Two layers are covered:
 *
 * 1. `BackgroundProcessStore.terminateScope(sessionId, agentScopeId)` — the
 *    scope-filtered sweep, tested against real spawned child processes on a
 *    fresh store (the `search-process-tools.test.ts` pattern).
 *
 * 2. The `SubagentManager` hook — every terminal projection funnels through
 *    `_finishLive`, which invokes `getBackgroundStore().terminateScope(
 *    record.sessionId, record.id)`. These tests drive a real `SubagentManager`
 *    with a mock async-generator runner (the `subagent-runtime.test.ts`
 *    pattern) through all three terminal paths: completed (`markCompleted`),
 *    failed (`markFailed`), and interrupted (`cancelOne` → the run loop's
 *    runner-owned interruption boundary). Test entries are inserted with
 *    `agentScopeId: record.id`, mirroring production wiring: `_startRun`
 *    passes `agentScopeId: record.id` to the stream runner, and
 *    `execute_command` spawns background commands with that scope id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BackgroundProcessStore,
  setBackgroundStore,
} from '../../src/main/tools/process/background-store';
import { SubagentManager, SubagentState } from '../../src/main/agents/manager';
import type { Agent } from '../../src/shared/types/agent';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import { defaults } from '../../src/main/config';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
} from '../../src/main/indexing/refresh-coordinator';

const testAgent: Agent = {
  name: 'explorer',
  type: 'subagent',
  tier: 'bloom',
  description: 'test',
  system_prompt: 'You explore.',
  allowed_tools: ['read', 'grep'],
  allowed_skills: [],
};

/** Poll until the entry exits (SIGTERM delivery is asynchronous). */
async function waitForExit(
  store: BackgroundProcessStore,
  procId: number,
  timeoutMs = 3000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = store.get(procId);
    if (!entry) return null;
    if (entry.exitCode !== null) return entry.exitCode;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return store.get(procId)?.exitCode ?? null;
}

// Background spawns in this suite exit (naturally or via the scope sweeps)
// and the store's exit path marks process.cwd() dirty in the index-refresh
// coordinator. Pin the debounce high and dispose the state after each test
// so no real flush can ever fire.
beforeEach(() => {
  _setIndexRefreshCoordinatorForTests({
    configLoader: () => ({
      ...defaults(),
      index_refresh: { ...defaults().index_refresh, debounce_ms: 60_000 },
    }),
  });
});

afterEach(() => {
  disposeIndexRefreshCoordinator();
});

// ---------------------------------------------------------------------------
// Store-level scope sweep
// ---------------------------------------------------------------------------

describe('BackgroundProcessStore.terminateScope', () => {
  let store: BackgroundProcessStore;

  beforeEach(() => {
    store = new BackgroundProcessStore();
    setBackgroundStore(store);
  });

  afterEach(() => {
    store.clear();
  });

  it('terminates only entries matching both sessionId and agentScopeId', async () => {
    const targetId = await store.spawn('sleep 30', {
      sessionId: 'session-a',
      agentScopeId: 'scope-x',
    });
    const mainId = await store.spawn('sleep 30', {
      sessionId: 'session-a',
      agentScopeId: 'main',
    });
    const peerId = await store.spawn('sleep 30', {
      sessionId: 'session-a',
      agentScopeId: 'scope-y',
    });
    const otherSessionId = await store.spawn('sleep 30', {
      sessionId: 'session-b',
      agentScopeId: 'scope-x',
    });

    store.terminateScope('session-a', 'scope-x');

    expect(await waitForExit(store, targetId)).not.toBeNull();
    expect(store.get(mainId)!.exitCode).toBeNull();
    expect(store.get(peerId)!.exitCode).toBeNull();
    expect(store.get(otherSessionId)!.exitCode).toBeNull();
  });

  it('leaves already-exited entries as-is', async () => {
    const procId = await store.spawn('echo done; exit 0', {
      sessionId: 'session-a',
      agentScopeId: 'scope-x',
    });
    expect(await waitForExit(store, procId)).toBe(0);

    expect(() => store.terminateScope('session-a', 'scope-x')).not.toThrow();
    expect(store.get(procId)!.exitCode).toBe(0);
  });

  it('does not terminate anything for a null session id', async () => {
    const procId = await store.spawn('sleep 30', {
      sessionId: null,
      agentScopeId: 'scope-x',
    });

    store.terminateScope(null, 'scope-x');

    expect(store.get(procId)!.exitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manager terminal funnel
// ---------------------------------------------------------------------------

describe('SubagentManager terminal transitions clean up owned commands', () => {
  let store: BackgroundProcessStore;
  let manager: SubagentManager;

  beforeEach(() => {
    store = new BackgroundProcessStore();
    setBackgroundStore(store);
    manager = new SubagentManager();
  });

  afterEach(() => {
    store.clear();
  });

  it('completed subagent terminates its owned commands only', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      await gate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('cleanup', 'task', testAgent, {
      sessionId: 'sess-cleanup',
    });
    const ownedId = await store.spawn('sleep 30', {
      sessionId: 'sess-cleanup',
      agentScopeId: record.id,
    });
    const mainId = await store.spawn('sleep 30', {
      sessionId: 'sess-cleanup',
      agentScopeId: 'main',
    });
    const peerId = await store.spawn('sleep 30', {
      sessionId: 'sess-cleanup',
      agentScopeId: 'subagent-peer',
    });

    release();
    await manager.getRunPromise(record.id);
    expect(record.state).toBe(SubagentState.COMPLETED);

    expect(await waitForExit(store, ownedId)).not.toBeNull();
    expect(store.get(mainId)!.exitCode).toBeNull();
    expect(store.get(peerId)!.exitCode).toBeNull();
  });

  it('failed subagent terminates its owned commands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'partial' };
      await gate;
      throw new Error('boom');
    });

    const record = manager.spawn('failing', 'task', testAgent, {
      sessionId: 'sess-failed',
    });
    const ownedId = await store.spawn('sleep 30', {
      sessionId: 'sess-failed',
      agentScopeId: record.id,
    });

    release();
    await manager.getRunPromise(record.id);
    expect(record.state).toBe(SubagentState.FAILED);
    expect(record.error).toContain('boom');

    expect(await waitForExit(store, ownedId)).not.toBeNull();
  });

  it('interrupted subagent terminates its owned commands', async () => {
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'working' };
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

    const record = manager.spawn('interruptible', 'task', testAgent, {
      sessionId: 'sess-interrupted',
    });
    const ownedId = await store.spawn('sleep 30', {
      sessionId: 'sess-interrupted',
      agentScopeId: record.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record.state).toBe(SubagentState.RUNNING);

    expect(manager.cancelOne(record.id)).toBe(true);
    await manager.getRunPromise(record.id);
    expect(record.state).toBe(SubagentState.INTERRUPTED);

    expect(await waitForExit(store, ownedId)).not.toBeNull();
  });

  it('unbound (null-session) records never touch unbound entries', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      await gate;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('unbound', 'task', testAgent);
    expect(record.sessionId).toBeNull();
    const unboundId = await store.spawn('sleep 30', {
      sessionId: null,
      agentScopeId: record.id,
    });

    release();
    await manager.getRunPromise(record.id);
    expect(record.state).toBe(SubagentState.COMPLETED);

    expect(store.get(unboundId)!.exitCode).toBeNull();
  });

  it('is a one-shot sweep: later commands under a recycled scope id survive', async () => {
    manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'finish', finishReason: 'stop' };
    });

    const record = manager.spawn('recycled', 'task', testAgent, {
      sessionId: 'sess-recycle',
    });
    await manager.getRunPromise(record.id);
    expect(record.state).toBe(SubagentState.COMPLETED);

    // A follow-up resume reuses the same scope id; the sweep must not act as
    // a persistent watcher that kills commands spawned after the transition.
    const lateId = await store.spawn('sleep 30', {
      sessionId: 'sess-recycle',
      agentScopeId: record.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(store.get(lateId)!.exitCode).toBeNull();
  });
});
