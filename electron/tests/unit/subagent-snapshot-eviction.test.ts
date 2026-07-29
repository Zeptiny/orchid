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
  clearSubagentPersistenceTracking,
  createSubagentPersistenceScheduler,
  persistSubagentChains,
  type SubagentPersistenceFlushInfo,
} from '../../src/main/agents/persist-subagent-chains';
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

/** Real per-test SessionManager behind the ipc accessor persistSubagentChains uses. */
const sessionManagerHolder = vi.hoisted(() => ({
  current: null as import('../../src/main/session/manager').SessionManager | null,
}));

/** The manager createSubagentSnapshot resolves through the tools registry. */
const subagentManagerHolder = vi.hoisted(() => ({
  current: null as import('../../src/main/agents/manager').SubagentManager | null,
}));

vi.mock('../../src/main/ipc/session', () => ({
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
  await record._runPromise;
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
  for (const sessionId of createdSessionIds) {
    clearSubagentPersistenceTracking(sessionId);
  }
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
    expect(record._evicted).toBe(true);
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
    expect(evicted._evicted).toBe(true);
    const evictedRawBefore = readRawRecordJson(sid, evicted.id);

    // A non-terminal (running) record persisted by the next checkpoint stays
    // heavy and is never confirmed/evicted.
    manager.setRunner(null);
    const retained = manager.spawn('retained', 'second task', testAgent, { sessionId: sid });
    manager.markRunning(retained.id);
    persistSubagentChains(manager, sid);
    expect(retained._evicted).toBe(false);
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
    expect(record._evicted).toBe(true);

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
    expect(done._evicted).toBe(true);

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
      expect(record._evicted).toBe(true);
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
