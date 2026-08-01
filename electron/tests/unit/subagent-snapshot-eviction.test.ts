/**
 * Evicted terminal summaries vs durable truth (review batch 3, P1 #2/#3).
 *
 * Since U9, a terminal record confirmed persisted is evicted to a lean
 * summary (empty chain) that stays in `manager.allRecords()`. Two consumers
 * must never treat that summary as authoritative:
 *
 * - #2: recovery persistence flushes (`{ recovery: true }`, e.g. the ordinary
 *   `wait_for_subagent` rebuild path) re-serialize every runtime record and
 *   would clobber the confirmed durable row with the summary's empty chain.
 * - #3: `createSubagentSnapshot` merges stored rows with runtime records and
 *   gives runtime precedence; the empty-chain summary would win over the full
 *   stored row, dropping the renderer's chain-derived usage attribution.
 *
 * These tests drive a real SubagentManager + real SessionManager-backed
 * SQLite storage so the whole persist → confirm(evict) → recovery → reload
 * cycle is exercised end to end. Note the eviction trigger: a successful
 * checkpoint confirms + evicts every terminal record it persisted, so the
 * explicit `confirmRecordsPersisted` calls below document the lifecycle the
 * flush already performed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent } from '../../src/shared/types/agent';
import type { Usage } from '../../src/shared/types/message';
import type { Config } from '../../src/shared/types/ipc-boundary';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import {
  SubagentManager,
  SubagentState,
  runtimeToDomain,
} from '../../src/main/agents/manager';
import {
  createSubagentPersistenceScheduler,
  persistSubagentChains,
  type SubagentPersistenceFlushInfo,
} from '../../src/main/agents/persist-subagent-chains';
import { setSubagentPersistenceRecoveryScheduler } from '../../src/main/agents/subagent-persistence-recovery';
import { buildWaitTool } from '../../src/main/tools/subagent/wait';
import { createSubagentSnapshot } from '../../src/main/ipc/subagents';
import { SessionManager } from '../../src/main/session/manager';
import {
  loadSession,
  _clearDbCache,
  type StorageOptions,
} from '../../src/main/session/storage';
import { openSqliteDb } from '../../src/main/utils/sqlite';
import { defaults } from '../../src/main/config/schema';
import { sumSubagentUsage } from '../../src/shared/usage';

/** Pin subagents config (esp. terminal_retention) instead of the live user config. */
const configOverride = vi.hoisted(() => ({ current: null as Config | null }));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => configOverride.current ?? actual.getConfig(),
  };
});

/** Real per-test SessionManager behind the session accessor persistSubagentChains uses. */
const sessionManagerHolder = vi.hoisted(() => ({
  current: null as import('../../src/main/session/manager').SessionManager | null,
}));

/** The manager createSubagentSnapshot resolves through the tools registry. */
const subagentManagerHolder = vi.hoisted(() => ({
  current: null as import('../../src/main/agents/manager').SubagentManager | null,
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => sessionManagerHolder.current,
}));

vi.mock('../../src/main/tools', () => ({
  getSubagentManager: () => subagentManagerHolder.current,
}));

const testAgent: Agent = {
  name: 'explorer',
  type: 'subagent',
  tier: 'bloom',
  description: 'test',
  system_prompt: 'You explore.',
  allowed_tools: ['read', 'grep'],
  allowed_skills: [],
};

const DEFAULT_SELECTION = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'gpt-4o',
};

const RUN_USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  cached_tokens: 10,
};

/** A runner that completes with text + usage committed to the durable chain. */
function successfulRunner(text: string) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'content', text };
    yield { type: 'usage', usage: RUN_USAGE };
    yield { type: 'finish', finishReason: 'stop' };
  };
}

let tmpDir: string;
let storageOpts: StorageOptions;
let sessionManager: SessionManager;
let manager: SubagentManager;
let createdSessionIds: string[];

function makeSession(): string {
  const session = sessionManager.create(DEFAULT_SELECTION);
  createdSessionIds.push(session.id);
  return session.id;
}

/** Spawn + drive a subagent to completion; returns the full runtime record. */
async function completeSubagent(label: string, task: string, sessionId: string) {
  const record = manager.spawn(label, task, testAgent, { sessionId });
  await manager.getRunPromise(record.id);
  expect(record.state).toBe(SubagentState.COMPLETED);
  return record;
}

/** Raw persisted record_json — byte-level proof a recovery flush did not rewrite a row. */
function readRawRecordJson(sessionId: string, subagentId: string): string | undefined {
  const db = openSqliteDb(storageOpts.dbPath!);
  try {
    const row = db
      .prepare('SELECT record_json FROM subagent_chains WHERE session_id = ? AND subagent_id = ?')
      .get(sessionId, subagentId) as { record_json: string } | undefined;
    return row?.record_json;
  } finally {
    db.close();
  }
}

/**
 * Storage normalization adds keys (e.g. `excludeFromModel`), so compare the
 * semantic content: (role, content) per message plus usage on the last one.
 */
function messageDigest(messages: ReadonlyArray<{ role: string; content: string }>) {
  return messages.map((message) => [message.role, message.content]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-subagent-eviction-'));
  storageOpts = {
    dbPath: path.join(tmpDir, 'sessions.db'),
    toolOutputCacheDir: path.join(tmpDir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(tmpDir, 'cache', 'web-fetch'),
  };
  sessionManager = new SessionManager({ storage: storageOpts });
  sessionManagerHolder.current = sessionManager;
  manager = new SubagentManager();
  manager.setRunner(successfulRunner('answer text'));
  subagentManagerHolder.current = manager;
  createdSessionIds = [];
  configOverride.current = {
    ...defaults(),
    subagents: { ...defaults().subagents, terminal_retention: 5 },
  };
});

afterEach(() => {
  setSubagentPersistenceRecoveryScheduler(null);
  sessionManagerHolder.current = null;
  subagentManagerHolder.current = null;
  configOverride.current = null;
  _clearDbCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recovery flush after terminal eviction (P1 #2)', () => {
  it('keeps the confirmed durable row intact — chain messages survive a recovery flush', async () => {
    const sid = makeSession();
    const record = await completeSubagent('recover-me', 'explore the repo', sid);
    // Capture the durable shape BEFORE the flush evicts the runtime record.
    const durable = runtimeToDomain(record);
    const messageCount = durable.chain.messages.length;
    expect(messageCount).toBeGreaterThan(0);

    // Terminal wave/checkpoint: the full row is upserted, confirmed, evicted.
    persistSubagentChains(manager, sid);
    manager.confirmRecordsPersisted(sid, [record.id]);
    expect(manager.isSummary(record.id)).toBe(true);
    expect(record.chain?.messages).toEqual([]);
    const rawBefore = readRawRecordJson(sid, record.id);
    expect(rawBefore).toBeDefined();

    // The ordinary wait_for_subagent trigger: an unconditional recovery flush.
    persistSubagentChains(manager, sid, { recovery: true });

    // The durable row was not even touched (byte-identical)…
    expect(readRawRecordJson(sid, record.id)).toBe(rawBefore);
    // …and reloading yields the full conversation, not the empty summary.
    const stored = loadSession(sid, storageOpts)
      ?.subagentChains.find((row) => row.id === record.id);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('completed');
    expect(stored!.result).toBe(record.result);
    expect(stored!.chain.messages).toHaveLength(messageCount);
    expect(messageDigest(stored!.chain.messages))
      .toEqual(messageDigest(durable.chain.messages));
    expect(stored!.chain.messages.at(-1)?.usage).toMatchObject(RUN_USAGE);
  });

  it('keeps the durable row intact when recovery runs through the scheduler (recover())', async () => {
    const sid = makeSession();
    const record = await completeSubagent('scheduled', 'map the module', sid);
    const durableDigest = messageDigest(runtimeToDomain(record).chain.messages);

    persistSubagentChains(manager, sid);
    const rawBefore = readRawRecordJson(sid, record.id);

    // Mirror wireSubagentRuntime: the scheduler drives persistSubagentChains
    // with the flush's recovery flag.
    const flushes: SubagentPersistenceFlushInfo[] = [];
    const scheduler = createSubagentPersistenceScheduler((sessionId, info) => {
      flushes.push(info);
      persistSubagentChains(manager, sessionId, { recovery: info.recovery });
    });
    scheduler.recover(sid);

    expect(flushes).toEqual([{ recovery: true }]);
    expect(readRawRecordJson(sid, record.id)).toBe(rawBefore);
    const stored = loadSession(sid, storageOpts)
      ?.subagentChains.find((row) => row.id === record.id);
    expect(messageDigest(stored!.chain.messages)).toEqual(durableDigest);
  });

  it('still re-persists non-evicted records on recovery (missing-row rebuild) while preserving the evicted row', async () => {
    const sid = makeSession();
    const evicted = await completeSubagent('evicted', 'first task', sid);
    // Checkpoint persists + confirms + evicts the terminal record.
    persistSubagentChains(manager, sid);
    expect(manager.isSummary(evicted.id)).toBe(true);
    const evictedRawBefore = readRawRecordJson(sid, evicted.id);

    // A non-terminal (running) record persisted by the next checkpoint stays
    // heavy and is never confirmed/evicted.
    manager.setRunner(null);
    const retained = manager.spawn('retained', 'second task', testAgent, { sessionId: sid });
    manager.markRunning(retained.id);
    persistSubagentChains(manager, sid);
    expect(manager.isSummary(retained.id)).toBe(false);
    const retainedDigest = messageDigest(runtimeToDomain(retained).chain.messages);
    expect(readRawRecordJson(sid, retained.id)).toBeDefined();

    // Simulate missing-row damage on the retained record only.
    const db = openSqliteDb(storageOpts.dbPath!);
    db.prepare('DELETE FROM subagent_chains WHERE session_id = ? AND subagent_id = ?')
      .run(sid, retained.id);
    db.close();
    expect(readRawRecordJson(sid, retained.id)).toBeUndefined();

    persistSubagentChains(manager, sid, { recovery: true });

    // Recovery semantics preserved: the non-evicted record's row is rebuilt.
    const reloaded = loadSession(sid, storageOpts)!.subagentChains;
    const retainedRow = reloaded.find((row) => row.id === retained.id);
    expect(retainedRow).toBeDefined();
    expect(messageDigest(retainedRow!.chain.messages)).toEqual(retainedDigest);
    // The evicted summary never overwrote its confirmed row.
    expect(readRawRecordJson(sid, evicted.id)).toBe(evictedRawBefore);
    const evictedRow = reloaded.find((row) => row.id === evicted.id)!;
    expect(evictedRow.chain.messages.length).toBeGreaterThan(0);
  });

  it('keeps the summary visible to getStates and wait after eviction and recovery', async () => {
    const sid = makeSession();
    const record = await completeSubagent('visible', 'stays listed', sid);
    persistSubagentChains(manager, sid);
    manager.confirmRecordsPersisted(sid, [record.id]);
    persistSubagentChains(manager, sid, { recovery: true });

    expect(manager.getStates(sid).map((state) => state.id)).toContain(record.id);

    const results = await manager.wait([record.id]);
    const waited = results.get(record.id);
    expect(waited?.state).toBe(SubagentState.COMPLETED);
    expect(waited?.result).toBe(record.result);
  });
});

describe('subagent snapshot after terminal eviction (P1 #3)', () => {
  it('serves the stored full record — chain messages and usage intact — for an evicted summary', async () => {
    const sid = makeSession();
    const record = await completeSubagent('snapshotted', 'summarize findings', sid);
    // Capture the durable shape BEFORE the flush evicts the runtime record.
    const durableDigest = messageDigest(runtimeToDomain(record).chain.messages);
    const durableUsage = sumSubagentUsage(runtimeToDomain(record));
    const messageCount = record.chain?.messages.length ?? 0;
    expect(durableUsage).not.toBeNull();
    expect(messageCount).toBeGreaterThan(0);

    persistSubagentChains(manager, sid);
    manager.confirmRecordsPersisted(sid, [record.id]);
    expect(manager.isSummary(record.id)).toBe(true);

    const snapshot = createSubagentSnapshot(sid);
    const snap = snapshot.records.find((row) => row.id === record.id);
    expect(snap).toBeDefined();
    expect(snap!.status).toBe('completed');

    // The snapshot must equal the durable row, not the empty-chain summary.
    const stored = loadSession(sid, storageOpts)!
      .subagentChains.find((row) => row.id === record.id)!;
    expect(snap!.chain.messages).toHaveLength(messageCount);
    expect(messageDigest(snap!.chain.messages)).toEqual(messageDigest(stored.chain.messages));
    expect(messageDigest(snap!.chain.messages)).toEqual(durableDigest);
    expect(sumSubagentUsage(snap!)).toEqual(durableUsage);
  });

  it('keeps runtime precedence for active records while an evicted sibling comes from storage', async () => {
    const sid = makeSession();
    const done = await completeSubagent('done-worker', 'finished task', sid);
    persistSubagentChains(manager, sid);
    expect(manager.isSummary(done.id)).toBe(true);

    // An active record must still ride the runtime overlay.
    manager.setRunner(null);
    const active = manager.spawn('active-worker', 'in flight', testAgent, { sessionId: sid });
    expect(active.state).toBe(SubagentState.PENDING);

    const snapshot = createSubagentSnapshot(sid);
    expect(snapshot.sessionRevision).toBe(manager.getSessionRevision(sid));

    const snapDone = snapshot.records.find((row) => row.id === done.id)!;
    expect(snapDone.status).toBe('completed');
    expect(snapDone.chain.messages.length).toBeGreaterThan(0);

    const snapActive = snapshot.records.find((row) => row.id === active.id)!;
    expect(snapActive.status).toBe('pending');
    expect(snapshot.live.some((projection) => projection.subagentId === active.id))
      .toBe(true);
  });
});

describe('exact-revision checkpoint confirmation', () => {
  it('does not let a stale pre-hydrate checkpoint suppress or evict the replacement record', () => {
    const sid = makeSession();
    manager.setRunner(null);
    const record = manager.spawn('timeline', 'first task', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first result');
    const captured = manager.checkpointCandidates(sid)[0];
    const domain = runtimeToDomain(record);

    manager.confirmCheckpointCandidates([captured]);
    expect(manager.isSummary(record.id)).toBe(true);
    manager.hydrate([{
      id: record.id,
      agent: testAgent,
      domain,
      sessionId: sid,
      windowId: null,
      cwd: null,
    }]);
    expect(manager.isSummary(record.id)).toBe(false);

    manager.confirmCheckpointCandidates([captured]);
    expect(manager.isSummary(record.id)).toBe(false);
    manager.close(record.id);
    expect(manager.checkpointCandidates(sid).map((candidate) => candidate.record.id))
      .toContain(record.id);
  });

  it('does not clean or evict a resumed generation when the terminal write confirms stale', () => {
    const sid = makeSession();
    manager.setRunner(null);
    const record = manager.spawn('stale', 'first task', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first result');
    const captured = manager.checkpointCandidates(sid)[0];
    expect(captured).toBeDefined();

    const write = sessionManager.syncSubagentRecords.bind(sessionManager);
    let resumed = false;
    vi.spyOn(sessionManager, 'syncSubagentRecords').mockImplementation((sessionId, records) => {
      if (!resumed) {
        resumed = true;
        manager.followUp(record.id, 'continue with a second generation');
      }
      return write(sessionId, records);
    });

    persistSubagentChains(manager, sid);

    expect(manager.isSummary(record.id)).toBe(false);
    expect(record.state).toBe(SubagentState.PENDING);
    const current = manager.checkpointCandidates(sid).find((candidate) => candidate.record.id === record.id);
    expect(current?.checkpoint.revision).toBeGreaterThan(captured!.checkpoint.revision);
  });

  it('persists a cancelled resume-queue interruption and follow-up before eviction', () => {
    const sid = makeSession();
    configOverride.current = {
      ...defaults(),
      subagents: { ...defaults().subagents, max_active_per_session: 1 },
    };
    manager.setRunner(null);

    const target = manager.spawn('target', 'first task', testAgent, { sessionId: sid });
    manager.markCompleted(target.id, 'first result');
    const blocker = manager.spawn('blocker', 'occupy the only slot', testAgent, { sessionId: sid });
    expect(blocker.state).toBe(SubagentState.PENDING);

    manager.followUp(target.id, 'continue after review');
    expect(target.state).toBe(SubagentState.QUEUED);
    expect(manager.cancelOne(target.id)).toBe(true);
    expect(target.state).toBe(SubagentState.INTERRUPTED);
    expect(manager.isSummary(target.id)).toBe(false);

    const write = vi.spyOn(sessionManager, 'syncSubagentRecords')
      .mockImplementationOnce(() => { throw new Error('temporary storage failure'); });
    expect(() => persistSubagentChains(manager, sid)).toThrow('temporary storage failure');
    expect(manager.isSummary(target.id)).toBe(false);
    write.mockRestore();

    persistSubagentChains(manager, sid);
    const stored = loadSession(sid, storageOpts)!.subagentChains.find((row) => row.id === target.id)!;
    expect(stored.status).toBe('interrupted');
    expect(stored.chain.messages.some((message) => message.content === 'continue after review')).toBe(true);
    expect(manager.isSummary(target.id)).toBe(true);
  });

  it('defers a cancelled settling run until wait recovery can persist its finalized chain', async () => {
    const sid = makeSession();
    let releaseRunner!: () => void;
    let observeAbort!: () => void;
    const runnerReleased = new Promise<void>((resolve) => { releaseRunner = resolve; });
    const abortObserved = new Promise<void>((resolve) => { observeAbort = resolve; });
    manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
      yield { type: 'content', text: 'partial answer' };
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          params.abortSignal.removeEventListener('abort', onAbort);
          observeAbort();
          resolve();
        };
        if (params.abortSignal.aborted) {
          observeAbort();
          resolve();
          return;
        }
        params.abortSignal.addEventListener('abort', onAbort);
      });
      await runnerReleased;
      yield { type: 'finish', finishReason: 'stop' };
    });

    const scheduled = new Map<number, () => void>();
    let nextTimer = 0;
    const scheduler = createSubagentPersistenceScheduler(
      (sessionId, info) => persistSubagentChains(manager, sessionId, { recovery: info.recovery }),
      {
        setTimeout: (callback) => {
          const timer = ++nextTimer;
          scheduled.set(timer, callback);
          return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (timer) => {
          scheduled.delete(timer as unknown as number);
        },
      },
    );
    setSubagentPersistenceRecoveryScheduler(scheduler);
    manager.setOnDelta((event) => {
      if (!event.sessionId) return;
      scheduler.markDirty(event.sessionId);
      if (event.type === 'terminal') scheduler.scheduleWave(event.sessionId, 0);
    });

    const record = manager.spawn('settling', 'produce an answer', testAgent, { sessionId: sid });
    await vi.waitFor(() => expect(record.state).toBe(SubagentState.RUNNING));
    await vi.waitFor(() => {
      expect(manager.getLiveProjection(record.id)?.segments)
        .toEqual([{ kind: 'text', id: expect.any(String), content: 'partial answer' }]);
    });

    expect(manager.cancelOne(record.id)).toBe(true);
    await abortObserved;
    expect(record.state).toBe(SubagentState.INTERRUPTED);
    expect(manager.isRunSettling(record.id)).toBe(true);

    const write = vi.spyOn(sessionManager, 'syncSubagentRecords');
    await buildWaitTool(manager).handler(
      { subagent_ids: [record.id] },
      { cwd: tmpDir, sessionId: sid },
    );

    // The wait tool uses the real recovery seam, but the terminal record is
    // still runner-owned: it must not checkpoint or evict before finalization.
    expect(write).not.toHaveBeenCalled();
    expect(manager.isSummary(record.id)).toBe(false);
    expect(readRawRecordJson(sid, record.id)).toBeUndefined();

    releaseRunner();
    await manager.getRunPromise(record.id);
    expect(manager.isRunSettling(record.id)).toBe(false);
    expect(record.chain?.status).toBe('interrupted');
    expect(record.chain?.messages.some((message) => message.content === 'partial answer')).toBe(true);
    expect(scheduler.hasPending(sid)).toBe(true);

    for (const callback of [...scheduled.values()]) callback();

    const stored = loadSession(sid, storageOpts)!.subagentChains.find((row) => row.id === record.id)!;
    expect(stored.status).toBe('interrupted');
    expect(stored.chain.messages.some((message) => message.content === 'partial answer')).toBe(true);
    expect(manager.isSummary(record.id)).toBe(true);
  });

  it('rehydrates a summary, persists its next mutation, and re-evicts only after that write', () => {
    const sid = makeSession();
    manager.setRunner(null);
    const record = manager.spawn('rehydrate', 'first task', testAgent, { sessionId: sid });
    manager.markCompleted(record.id, 'first result');
    persistSubagentChains(manager, sid);
    expect(manager.isSummary(record.id)).toBe(true);
    const domain = loadSession(sid, storageOpts)!.subagentChains.find((row) => row.id === record.id)!;

    manager.hydrate([{
      id: record.id,
      agent: testAgent,
      domain,
      sessionId: sid,
      windowId: null,
      cwd: null,
    }]);
    expect(manager.isSummary(record.id)).toBe(false);
    manager.close(record.id);

    const write = vi.spyOn(sessionManager, 'syncSubagentRecords')
      .mockImplementationOnce(() => { throw new Error('retry required'); });
    expect(() => persistSubagentChains(manager, sid)).toThrow('retry required');
    expect(manager.isSummary(record.id)).toBe(false);
    write.mockRestore();

    persistSubagentChains(manager, sid);
    expect(manager.isSummary(record.id)).toBe(true);
    expect(loadSession(sid, storageOpts)!.subagentChains.find((row) => row.id === record.id)?.closed).toBe(true);
  });
});

describe('records cancelled while queued never persist (P3 #15)', () => {
  it('cancel-queued → FIFO-capped evicted summary; no durable row is written, even on recovery', () => {
    const sid = makeSession();
    configOverride.current = {
      ...defaults(),
      subagents: {
        ...defaults().subagents,
        terminal_retention: 2,
        max_active_per_session: 1,
      },
    };
    manager.setRunner(null);

    // Occupy the session's only run slot; later spawns park in the queue.
    const active = manager.spawn('active', 'anchor the slot', testAgent, { sessionId: sid });
    expect(active.state).toBe(SubagentState.PENDING);

    const queuedIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const record = manager.spawn(`queued-${i}`, 'x', testAgent, { sessionId: sid });
      expect(record.state).toBe(SubagentState.QUEUED);
      expect(manager.cancelOne(record.id)).toBe(true);
      queuedIds.push(record.id);
      // Cancelled while queued → evicted to a lean summary (chain emptied).
      expect(manager.isSummary(record.id)).toBe(true);
      expect(record.chain?.messages).toEqual([]);
    }

    // The retention FIFO capped the summaries: the oldest left allRecords.
    expect(manager.getRecord(queuedIds[0])).toBeUndefined();
    expect(manager.allRecords().filter((r) => r.sessionId === sid)).toHaveLength(3);

    // Never-admitted records want no durable row — not from an ordinary
    // checkpoint and not from a recovery flush (which treats every record as
    // dirty but must still skip evicted summaries).
    persistSubagentChains(manager, sid);
    for (const id of queuedIds) {
      expect(readRawRecordJson(sid, id)).toBeUndefined();
    }
    persistSubagentChains(manager, sid, { recovery: true });
    for (const id of queuedIds) {
      expect(readRawRecordJson(sid, id)).toBeUndefined();
    }
  });
});
