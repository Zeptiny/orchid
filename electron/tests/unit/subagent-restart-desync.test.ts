/**
 * Reproduction for issue #121 — subagent status desynchronized after app
 * close/restart.
 *
 * Three claimed data-loss paths were audited against the report:
 *  (a) a spawn still parked in the admission queue when the app closes never
 *      becomes durable-eligible, so no flush path (checkpoint, terminal wave,
 *      shutdown flushAll) can write its row — after restart the record simply
 *      does not exist while the frozen transcript still says status "queued".
 *  (b) the persistence breaker: after maxRetries+1 failed writes a session is
 *      degraded and flush() early-returns — including inside flushAll() at
 *      orderly shutdown, so a terminal status completed in-memory is never
 *      written. The last good row says "running", which the restore migration
 *      turns into "interrupted".
 *  (c) hydration permanently caching empty results — NOT reproduced at HEAD:
 *      SubagentHydrationReadiness evicts rejections and agentMissing results
 *      (retain callback), and the send path re-runs hydration with a resolved
 *      project runtime. Covered by subagent-hydration-readiness.test.ts.
 *
 * Both paths are fixed and these tests pin the fix end-to-end through the
 * same collaborators production uses: SubagentManager, the persistence
 * scheduler, the storage layer's restore migration, and manager.hydrate (the
 * exact path build-prompt-context's mapSubagents reads via getStates after a
 * restart).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentTier, AgentType, type Agent } from '../../src/shared/types/agent';
import { SubagentManager } from '../../src/main/agents/manager';
import { SubagentState } from '../../src/main/agents/types';
import { SubagentStatus } from '../../src/shared/types/subagent';
import { createSubagentPersistenceScheduler } from '../../src/main/agents/persist-subagent-chains';
import {
  _clearDbCache,
  loadSubagentRecords,
  saveSession,
  upsertSubagentRecords,
  type StorageOptions,
} from '../../src/main/session/storage';
import type { Session } from '../../src/shared/types/session';
import type { SubagentRecord } from '../../src/shared/types/subagent';

vi.mock('electron', () => ({
  webContents: {
    getAllWebContents: () => [],
    fromId: () => null,
  },
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => ({
    getSession: vi.fn(() => ({ cwd: null })),
    getActive: vi.fn(() => ({ cwd: null })),
  }),
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: vi.fn() }),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => ({ resolveExecution: vi.fn() }),
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => ({}),
}));

vi.mock('../../src/main/providers/accounting/subagent-attribution-store', () => ({
  getSubagentAttributionStore: () => ({ insert: vi.fn(), finalize: vi.fn() }),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: vi.fn(),
}));

vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: vi.fn(async () => ({})),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: vi.fn(),
  releaseProjectMCPManager: vi.fn(),
}));

const T0 = '2026-01-01T00:00:00.000Z';
const SESSION_ID = 'cafe4211-4211-4211-8211-000000000121';

const explorerAgent: Agent = {
  name: 'explorer',
  type: AgentType.SUBAGENT,
  tier: AgentTier.SEED,
  description: 'Explores and searches a codebase',
  allowed_tools: ['read', 'grep', 'glob'],
  allowed_skills: ['*'],
};

let tmpDir: string;
let storageOpts: StorageOptions;

function makeStoredRecord(status: SubagentStatus): SubagentRecord {
  return {
    id: `sub-issue-121-${status}`,
    agent_name: 'explorer',
    agent_type: 'subagent',
    agent_tier: 'seed',
    task: 'explore codebase',
    status,
    chain_id: `chain-issue-121-${status}`,
    start_time: T0,
    end_time: status === SubagentStatus.RUNNING ? null : T0,
    result: status === SubagentStatus.COMPLETED ? 'found three modules' : null,
    error: null,
    parentChainIndex: 0,
    closed: false,
    chain: {
      id: `chain-issue-121-${status}`,
      sessionId: SESSION_ID,
      messages: [],
      status: 'completed',
      selection: null,
      modelLabel: null,
      agentName: 'explorer',
      agentType: 'subagent',
      agentTier: 'seed',
      subagentRecord: null,
      startTime: T0,
      endTime: T0,
      errorDetail: null,
      errorTitle: null,
    },
  };
}

function seedSession(): void {
  const session: Session = {
    id: SESSION_ID,
    name: 'Issue 121 Repro',
    selection: null,
    modelLabel: null,
    cwd: null,
    chains: [],
    activeChainId: null,
    createdAt: T0,
    updatedAt: T0,
    subagentChains: [],
    todoStore: { tasks: [] },
    reasoningEffortOverride: null,
    tierOverride: null,
    permissionMode: null,
  };
  saveSession(session, storageOpts);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-issue-121-repro-'));
  storageOpts = {
    dbPath: path.join(tmpDir, 'sessions.db'),
    toolOutputCacheDir: path.join(tmpDir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(tmpDir, 'cache', 'web-fetch'),
  };
});

afterEach(() => {
  _clearDbCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('issue #121 (a): queued-at-close spawn leaves no durable row', () => {
  it('a spawn parked in the admission queue is included in the checkpoint candidate set', () => {
    const manager = new SubagentManager();

    // Saturate the active limits until one spawn parks in the queue. The
    // runner is unset (unit-test convention), so admitted spawns stay PENDING
    // and hold their admission slots.
    let queuedId: string | null = null;
    for (let i = 0; i < 64 && queuedId === null; i += 1) {
      const record = manager.spawn(`probe-${i}`, 'explore things', explorerAgent, {
        sessionId: SESSION_ID,
      });
      if (record.state === SubagentState.QUEUED) queuedId = record.id;
    }
    expect(queuedId).not.toBeNull();

    // The delegate_to_subagent result froze this status into the transcript.
    const queued = manager.getRecord(queuedId!);
    expect(queued?.state).toBe(SubagentState.QUEUED);

    // Every flush path — debounced checkpoint, terminal wave, and the shutdown
    // flushAll — serializes exactly manager.checkpointCandidates(sessionId).
    // Queued spawns register durably, so the row is written even if the app
    // closes before admission.
    const persistedIds = manager
      .checkpointCandidates(SESSION_ID)
      .map((candidate) => candidate.record.id);
    expect(persistedIds).toContain(queuedId);

    // A recovery flush (the missing-row contract) covers it too.
    const recoveryIds = manager
      .checkpointCandidates(SESSION_ID, { recovery: true })
      .map((candidate) => candidate.record.id);
    expect(recoveryIds).toContain(queuedId);
  });

  it('a queued row written before close restores as INTERRUPTED in the post-restart prompt states', () => {
    seedSession();

    // Spawn to saturation so one record parks in the admission queue, then
    // write the checkpoint exactly like the shutdown flushAll does.
    const manager = new SubagentManager();
    let queued: ReturnType<SubagentManager['spawn']> | null = null;
    for (let i = 0; i < 64 && queued === null; i += 1) {
      const record = manager.spawn(`probe-${i}`, 'explore things', explorerAgent, {
        sessionId: SESSION_ID,
      });
      if (record.state === SubagentState.QUEUED) queued = record;
    }
    expect(queued).not.toBeNull();

    const candidates = manager.checkpointCandidates(SESSION_ID);
    const domainRecords = candidates.map(({ record }) => manager.toDomainRecord(record));
    upsertSubagentRecords(SESSION_ID, domainRecords, T0, storageOpts);

    // App restarts: the row exists and the restore migration flips the queued
    // status to interrupted (an app restart never resumes an admission queue).
    const restored = loadSubagentRecords(SESSION_ID, undefined, storageOpts);
    const restoredQueued = restored.find((record) => record.id === queued!.id);
    expect(restoredQueued).toBeDefined();
    expect(restoredQueued!.status).toBe(SubagentStatus.INTERRUPTED);

    // Hydration materializes it into the fresh manager — the system-prompt
    // source now reports an accurate terminal state instead of omitting the
    // subagent while the frozen transcript still says status "queued".
    const restarted = new SubagentManager();
    restarted.hydrate([{
      id: restoredQueued!.id,
      agent: explorerAgent,
      domain: restoredQueued!,
      sessionId: SESSION_ID,
      windowId: null,
      cwd: null,
    }]);
    const states = restarted.getStates(SESSION_ID);
    expect(states.find((state) => state.id === queued!.id)?.state)
      .toBe(SubagentState.INTERRUPTED);
  });
});

describe('issue #121 (b): degraded persistence breaker drops the shutdown flush', () => {
  it('the shutdown flushAll bypasses the degraded breaker and writes terminal status', () => {
    vi.useFakeTimers();
    const write = vi.fn(() => {
      throw new Error('simulated storage failure');
    });
    const scheduler = createSubagentPersistenceScheduler(write);

    // Debounced checkpoint fires at t=2000 and fails (attempt 1), scheduling
    // exponential retries at +100/+200/+400ms. The fourth failure exceeds
    // maxRetries=3 and trips the breaker.
    scheduler.markDirty(SESSION_ID);
    vi.advanceTimersByTime(2000 + 100 + 200 + 400);
    expect(scheduler.isDegraded(SESSION_ID)).toBe(true);
    const attemptsWhenDegraded = write.mock.calls.length;
    expect(attemptsWhenDegraded).toBe(4);

    // Storage recovers (disk freed, DB rebuilt). Orderly shutdown runs
    // flushSubagentPersistence() → scheduler.flushAll(), which forces the
    // flush past the degraded breaker: the terminal status held in memory is
    // written, and a success reopens the session.
    write.mockImplementation(() => {});
    scheduler.flushAll();
    expect(write.mock.calls.length).toBe(attemptsWhenDegraded + 1);
    expect(scheduler.isDegraded(SESSION_ID)).toBe(false);

    scheduler.dispose();
  });

  it('a failing forced shutdown flush is final: logged, not counted, never rescheduled', () => {
    vi.useFakeTimers();
    const write = vi.fn(() => {
      throw new Error('simulated storage failure');
    });
    const scheduler = createSubagentPersistenceScheduler(write, undefined, { maxRetries: 0 });

    scheduler.markDirty(SESSION_ID);
    vi.advanceTimersByTime(2000);
    expect(scheduler.isDegraded(SESSION_ID)).toBe(true);
    const attemptsWhenDegraded = write.mock.calls.length;
    expect(attemptsWhenDegraded).toBe(1);

    // Storage is still broken at shutdown. The forced flush attempts the
    // write once, does not re-trip anything, and schedules no retry timer
    // that could never fire in an exiting process.
    scheduler.flushAll();
    expect(write.mock.calls.length).toBe(attemptsWhenDegraded + 1);
    vi.advanceTimersByTime(10_000);
    expect(write.mock.calls.length).toBe(attemptsWhenDegraded + 1);

    scheduler.dispose();
  });

  it('the RUNNING row left behind by the lost terminal write restores as INTERRUPTED in the prompt states', () => {
    seedSession();

    // Last good checkpoint before the terminal wave was dropped: status RUNNING.
    const running = makeStoredRecord(SubagentStatus.RUNNING);
    upsertSubagentRecords(SESSION_ID, [running], T0, storageOpts);

    // App restarts: the read path migrates queued/pending/running → interrupted.
    const restored = loadSubagentRecords(SESSION_ID, undefined, storageOpts);
    expect(restored).toHaveLength(1);
    expect(restored[0].status).toBe(SubagentStatus.INTERRUPTED);

    // Session-open/send hydration materializes the row into the fresh manager
    // (the exact call chain build-prompt-context.mapSubagents reads).
    const manager = new SubagentManager();
    manager.hydrate([{
      id: restored[0].id,
      agent: explorerAgent,
      domain: restored[0],
      sessionId: SESSION_ID,
      windowId: null,
      cwd: null,
    }]);

    const states = manager.getStates(SESSION_ID);
    expect(states).toHaveLength(1);
    // The subagent actually COMPLETED before the app closed.
    expect(states[0].state).toBe(SubagentState.INTERRUPTED);
  });

  it('contrast: a persisted COMPLETED row restores as COMPLETED (the normal flow is correct)', () => {
    seedSession();
    upsertSubagentRecords(
      SESSION_ID,
      [makeStoredRecord(SubagentStatus.COMPLETED)],
      T0,
      storageOpts,
    );

    const restored = loadSubagentRecords(SESSION_ID, undefined, storageOpts);
    expect(restored[0].status).toBe(SubagentStatus.COMPLETED);

    const manager = new SubagentManager();
    manager.hydrate([{
      id: restored[0].id,
      agent: explorerAgent,
      domain: restored[0],
      sessionId: SESSION_ID,
      windowId: null,
      cwd: null,
    }]);
    expect(manager.getStates(SESSION_ID)[0].state).toBe(SubagentState.COMPLETED);
  });
});
