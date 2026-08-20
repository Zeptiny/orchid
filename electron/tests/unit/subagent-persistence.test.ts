import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { Chain } from '../../src/shared/types/chain';
import { ChainStatus } from '../../src/shared/types/chain';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import { SubagentStatus } from '../../src/shared/types/subagent';
import { SubagentPersistence } from '../../src/main/agents/subagent-persistence';
import type { StorageOptions } from '../../src/main/session/storage';
import {
  saveSession,
  upsertSubagentRecords,
  loadSubagentRecord,
  applySubagentCompactionPersistence,
  _clearDbCache,
} from '../../src/main/session/storage';
import { openSqliteDb } from '../../src/main/utils/sqlite';

vi.mock('electron', () => ({
  webContents: {
    getAllWebContents: () => [],
    fromId: () => null,
  },
}));

const T0 = '2026-01-01T00:00:00.000Z';

let tmpDir: string;
let storageOpts: StorageOptions;

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: overrides.role ?? MessageRole.USER,
    content: overrides.content ?? `content-${id}`,
    type: overrides.type ?? MessageType.TEXT,
    tool_calls: overrides.tool_calls ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    name: overrides.name ?? null,
    thinking: overrides.thinking ?? null,
    timestamp: overrides.timestamp ?? T0,
    usage: overrides.usage ?? null,
    hidden: overrides.hidden ?? false,
    ...(overrides.excludeFromModel !== undefined ? { excludeFromModel: overrides.excludeFromModel } : {}),
    ...(overrides.compacted !== undefined ? { compacted: overrides.compacted } : {}),
    tool_result: overrides.tool_result ?? null,
  };
}

/** `count` messages with zero-padded ids `${prefix}-0000`… */
function messages(prefix: string, count: number, from = 0): Message[] {
  return Array.from({ length: count }, (_, index) =>
    makeMessage(`${prefix}-${String(from + index).padStart(4, '0')}`),
  );
}

function idRange(prefix: string, count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(from + index).padStart(4, '0')}`);
}

function makeChain(sessionId: string, id: string, chainMessages: Message[]): Chain {
  return {
    id,
    sessionId,
    messages: chainMessages,
    status: ChainStatus.COMPLETED,
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
  };
}

function makeSubagentRecord(sessionId: string, id: string, chainMessages: Message[]): SubagentRecord {
  return {
    id,
    agent_name: 'explorer',
    agent_type: 'subagent',
    agent_tier: 'seed',
    task: 'explore codebase',
    status: SubagentStatus.COMPLETED,
    chain_id: `chain-${id}`,
    start_time: T0,
    end_time: T0,
    result: 'found three relevant modules',
    error: null,
    parentChainIndex: 0,
    closed: false,
    chain: makeChain(sessionId, `chain-${id}`, chainMessages),
  };
}

function makeSummaryMessage(id: string, content: string): Message {
  return {
    ...makeMessage(id, { role: MessageRole.ASSISTANT, content }),
    compacted: { rangeStart: 'm-0000', rangeEnd: 'm-0099', mode: 'simple', summarizedCount: 100 },
  };
}

function readSubagentRecordJson(sessionId: string, subagentId: string): string {
  const db = openSqliteDb(storageOpts.dbPath!);
  try {
    return (db
      .prepare('SELECT record_json FROM subagent_chains WHERE session_id = ? AND subagent_id = ?')
      .get(sessionId, subagentId) as { record_json: string }).record_json;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-subagent-compaction-test-'));
  storageOpts = {
    dbPath: path.join(tmpDir, 'sessions.db'),
    toolOutputCacheDir: path.join(tmpDir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(tmpDir, 'cache', 'web-fetch'),
  };
});

afterEach(() => {
  _clearDbCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SubagentPersistence', () => {
  it('confirms only the captured terminal revision, preserving a resumed generation', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: true });
    persistence.markDirty('sub-1');
    const terminal = persistence.checkpointCandidate('sub-1', 'session-1', true)!;

    persistence.beginFollowUp('sub-1');

    expect(persistence.confirmCheckpoint(terminal)).toEqual({ evict: false, removeIds: [] });
    expect(persistence.checkpointCandidate('sub-1', 'session-1', false)?.revision)
      .toBeGreaterThan(terminal.revision);
    expect(persistence.isSummary('sub-1')).toBe(false);
  });

  it('retains summaries FIFO and resets checkpoint eligibility when rehydrated', () => {
    const persistence = new SubagentPersistence(() => 1);
    persistence.register('old', 'session-1', { admitted: true });
    persistence.register('new', 'session-1', { admitted: true });

    const old = persistence.checkpointCandidate('old', 'session-1', true)!;
    expect(persistence.confirmCheckpoint(old)).toEqual({ evict: true, removeIds: [] });
    const recent = persistence.checkpointCandidate('new', 'session-1', true)!;
    expect(persistence.confirmCheckpoint(recent)).toEqual({ evict: true, removeIds: ['old'] });

    persistence.rehydrate('new', 'session-1');
    persistence.markDirty('new');
    expect(persistence.checkpointCandidate('new', 'session-1', false)?.revision).toBe(1);
    expect(persistence.isSummary('new')).toBe(false);
  });

  it('tracks confirmed sessions for recovery and clears every owned policy fact', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: true });
    persistence.confirmCheckpoint(persistence.checkpointCandidate('sub-1', 'session-1', false)!);

    expect(persistence.trackedSessions()).toEqual(['session-1']);
    persistence.clearSession('session-1');
    expect(persistence.trackedSessions()).toEqual([]);
    expect(persistence.needsHydration('sub-1')).toBe(true);
  });

  it('rejects a terminal confirmation captured before the same id is rehydrated', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: true });
    persistence.markDirty('sub-1');
    const stale = persistence.checkpointCandidate('sub-1', 'session-1', true)!;
    expect(persistence.confirmCheckpoint(stale).evict).toBe(true);

    persistence.rehydrate('sub-1', 'session-1');
    persistence.markDirty('sub-1');
    const current = persistence.checkpointCandidate('sub-1', 'session-1', true)!;
    expect(current.revision).toBe(stale.revision);

    expect(persistence.confirmCheckpoint(stale)).toEqual({ evict: false, removeIds: [] });
    expect(persistence.isSummary('sub-1')).toBe(false);
    expect(persistence.checkpointCandidate('sub-1', 'session-1', true)?.revision)
      .toBe(current.revision);
  });

  it('admits a fresh record to checkpoint eligibility only after admission', () => {
    const persistence = new SubagentPersistence(() => 2);
    persistence.register('sub-1', 'session-1', { admitted: false });

    expect(persistence.checkpointCandidate('sub-1', 'session-1', false)).toBeNull();

    persistence.markAdmitted('sub-1');

    expect(persistence.checkpointCandidate('sub-1', 'session-1', false)).not.toBeNull();
  });

  it('uses the legacy empty-session FIFO for undurable queued cancellations', () => {
    const persistence = new SubagentPersistence(() => 1);
    persistence.register('old', null, { admitted: false });
    expect(persistence.summarizeUndurable('old')).toEqual({ evict: true, removeIds: [] });

    persistence.register('new', null, { admitted: false });
    expect(persistence.summarizeUndurable('new')).toEqual({ evict: true, removeIds: ['old'] });
  });
});

// ===========================================================================
// applySubagentCompactionPersistence — targeted subagent-chain durable write
// ===========================================================================

describe('applySubagentCompactionPersistence (targeted subagent durable write)', () => {
  const sessionId = 'cafe1001-1001-4101-8101-000000000001';
  const subagentId = 'sub-compaction-1';

  function seedSubagent(chainMessages: Message[]): void {
    saveSession({
      id: sessionId,
      name: 'Subagent Compaction Test',
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
    }, storageOpts);
    upsertSubagentRecords(
      sessionId,
      [makeSubagentRecord(sessionId, subagentId, chainMessages)],
      T0,
      storageOpts,
    );
  }

  it('(a) flags the compacted prefix and inserts the summary head at the cut in one transaction', () => {
    seedSubagent(messages('m', 100, 0));

    const summary = makeSummaryMessage('summary-head', 'SUMMARY: subagent compaction');
    const result = applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 50, 0),
        summaryMessage: summary,
        insertBeforeMessageId: 'm-0050',
      },
      storageOpts,
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.flaggedCount).toBe(50);
    expect(result.bytes).toBeGreaterThan(0);

    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    expect(loaded).not.toBeNull();
    const chain = loaded.chain.messages;
    expect(chain.map((m) => m.id)).toEqual([
      ...idRange('m', 50, 0),
      'summary-head',
      ...idRange('m', 50, 50),
    ]);
    expect(chain.slice(0, 50).every((m) => m.excludeFromModel)).toBe(true);
    expect(chain[50]!.id).toBe('summary-head');
    expect(chain[50]!.compacted).toMatchObject({ mode: 'simple', summarizedCount: 100 });
    expect(chain.slice(51).every((m) => !m.excludeFromModel)).toBe(true);
  });

  it('(b) flags without a summary head (reclaim-only) and keeps the chain layout unchanged', () => {
    seedSubagent(messages('m', 40, 0));

    const result = applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 10, 5),
        summaryMessage: null,
        insertBeforeMessageId: null,
      },
      storageOpts,
    );

    expect(result.summaryInserted).toBe(false);
    expect(result.flaggedCount).toBe(10);

    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    const chain = loaded.chain.messages;
    expect(chain.map((m) => m.id)).toEqual(idRange('m', 40, 0));
    const flagged = chain.filter((m) => m.excludeFromModel);
    expect(flagged.map((m) => m.id)).toEqual(idRange('m', 10, 5));
  });

  it('(c) appends the summary head when insertBeforeMessageId is null', () => {
    seedSubagent(messages('m', 30, 0));

    const summary = makeSummaryMessage('summary-append', 'SUMMARY: append');
    const result = applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 30, 0),
        summaryMessage: summary,
        insertBeforeMessageId: null,
      },
      storageOpts,
    );

    expect(result.summaryInserted).toBe(true);
    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    const chain = loaded.chain.messages;
    expect(chain.map((m) => m.id)).toEqual([...idRange('m', 30, 0), 'summary-append']);
    expect(chain.slice(0, 30).every((m) => m.excludeFromModel)).toBe(true);
  });

  it('(d) rolls back on failure: a flagged id not in the durable chain leaves the prior state intact', () => {
    seedSubagent(messages('m', 20, 0));
    const jsonBefore = readSubagentRecordJson(sessionId, subagentId);

    expect(() => applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: ['not-a-durable-message'],
        summaryMessage: null,
        insertBeforeMessageId: null,
      },
      storageOpts,
    )).toThrow(/not-a-durable-message/);

    expect(readSubagentRecordJson(sessionId, subagentId)).toBe(jsonBefore);
    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    expect(loaded.chain.messages.every((m) => !m.excludeFromModel)).toBe(true);
  });

  it('(d) rolls back on failure: an unknown summary anchor leaves the prior state intact', () => {
    seedSubagent(messages('m', 20, 0));
    const jsonBefore = readSubagentRecordJson(sessionId, subagentId);

    const summary = makeSummaryMessage('summary-head', 'SUMMARY');
    expect(() => applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 10, 0),
        summaryMessage: summary,
        insertBeforeMessageId: 'missing-anchor',
      },
      storageOpts,
    )).toThrow(/missing-anchor/);

    expect(readSubagentRecordJson(sessionId, subagentId)).toBe(jsonBefore);
  });

  it('(d) throws for an unknown session', () => {
    expect(() => applySubagentCompactionPersistence(
      'cafe9999-9999-4999-8999-000000000099',
      subagentId,
      {
        updatedAt: T0,
        flaggedMessageIds: [],
        summaryMessage: null,
        insertBeforeMessageId: null,
      },
      storageOpts,
    )).toThrow(/not found in durable rows/);
  });

  it('(d) throws for an unknown subagent', () => {
    saveSession({
      id: sessionId,
      name: 'Session',
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
    }, storageOpts);

    expect(() => applySubagentCompactionPersistence(
      sessionId,
      'unknown-subagent',
      {
        updatedAt: T0,
        flaggedMessageIds: [],
        summaryMessage: null,
        insertBeforeMessageId: null,
      },
      storageOpts,
    )).toThrow(/not found in durable rows/);
  });

  it('never touches sibling subagent rows or session chains', () => {
    const siblingMessages = messages('s', 10, 0);
    seedSubagent(messages('m', 50, 0));
    upsertSubagentRecords(
      sessionId,
      [makeSubagentRecord(sessionId, 'sub-sibling', siblingMessages)],
      T0,
      storageOpts,
    );

    const siblingJsonBefore = readSubagentRecordJson(sessionId, 'sub-sibling');

    const summary = makeSummaryMessage('summary-head', 'SUMMARY');
    applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 25, 0),
        summaryMessage: summary,
        insertBeforeMessageId: 'm-0025',
      },
      storageOpts,
    );

    expect(readSubagentRecordJson(sessionId, 'sub-sibling')).toBe(siblingJsonBefore);
  });
});

// ===========================================================================
// Crash-atomicity: restart-load yields one coherent state (R36)
// ===========================================================================

describe('applySubagentCompactionPersistence crash-atomicity (R36)', () => {
  const sessionId = 'cafe2001-2001-4201-8201-000000000001';
  const subagentId = 'sub-crash-1';

  function seedSubagent(chainMessages: Message[]): void {
    saveSession({
      id: sessionId,
      name: 'Crash Test Session',
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
    }, storageOpts);
    upsertSubagentRecords(
      sessionId,
      [makeSubagentRecord(sessionId, subagentId, chainMessages)],
      T0,
      storageOpts,
    );
  }

  it('restart-load after a successful write yields one coherent post-compaction state', () => {
    seedSubagent(messages('m', 100, 0));

    const summary = makeSummaryMessage('summary-head', 'SUMMARY: crash test');
    applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 50, 0),
        summaryMessage: summary,
        insertBeforeMessageId: 'm-0050',
      },
      storageOpts,
    );

    _clearDbCache();
    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    const chain = loaded.chain.messages;
    expect(chain).toHaveLength(101);
    expect(chain.map((m) => m.id)).toEqual([
      ...idRange('m', 50, 0),
      'summary-head',
      ...idRange('m', 50, 50),
    ]);
    expect(chain.slice(0, 50).every((m) => m.excludeFromModel)).toBe(true);
    expect(chain.slice(51).every((m) => !m.excludeFromModel)).toBe(true);
    expect(chain[50]!.compacted).toMatchObject({ mode: 'simple' });
  });

  it('restart-load after a failed write yields the pre-compaction state', () => {
    seedSubagent(messages('m', 50, 0));

    const summary = makeSummaryMessage('summary-head', 'SUMMARY');
    expect(() => applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: [...idRange('m', 25, 0), 'missing-id'],
        summaryMessage: summary,
        insertBeforeMessageId: 'm-0025',
      },
      storageOpts,
    )).toThrow();

    _clearDbCache();
    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    const chain = loaded.chain.messages;
    expect(chain).toHaveLength(50);
    expect(chain.map((m) => m.id)).toEqual(idRange('m', 50, 0));
    expect(chain.every((m) => !m.excludeFromModel)).toBe(true);
  });

  it('flag/chain consistency after a split-range: summary head inserted at the cut, suffix preserved', () => {
    seedSubagent(messages('m', 80, 0));

    const summary = makeSummaryMessage('summary-split', 'SUMMARY: split');
    applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 30, 10),
        summaryMessage: summary,
        insertBeforeMessageId: 'm-0040',
      },
      storageOpts,
    );

    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    const chain = loaded.chain.messages;
    expect(chain.map((m) => m.id)).toEqual([
      ...idRange('m', 10, 0),
      ...idRange('m', 30, 10),
      'summary-split',
      ...idRange('m', 40, 40),
    ]);
    const flaggedRange = chain.slice(10, 40);
    expect(flaggedRange.every((m) => m.excludeFromModel)).toBe(true);
    expect(chain.slice(0, 10).every((m) => !m.excludeFromModel)).toBe(true);
    expect(chain.slice(41).every((m) => !m.excludeFromModel)).toBe(true);
  });

  it('pre-existing flags from an earlier compaction survive a second compaction', () => {
    seedSubagent(messages('m', 100, 0));

    const summary1 = makeSummaryMessage('summary-1', 'SUMMARY: first');
    applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-02T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 30, 0),
        summaryMessage: summary1,
        insertBeforeMessageId: 'm-0030',
      },
      storageOpts,
    );

    const summary2 = makeSummaryMessage('summary-2', 'SUMMARY: second');
    applySubagentCompactionPersistence(
      sessionId,
      subagentId,
      {
        updatedAt: '2026-01-03T00:00:00.000Z',
        flaggedMessageIds: idRange('m', 30, 30),
        summaryMessage: summary2,
        insertBeforeMessageId: 'm-0060',
      },
      storageOpts,
    );

    const loaded = loadSubagentRecord(sessionId, subagentId, storageOpts)!;
    const chain = loaded.chain.messages;
    expect(chain.map((m) => m.id)).toEqual([
      ...idRange('m', 30, 0),
      'summary-1',
      ...idRange('m', 30, 30),
      'summary-2',
      ...idRange('m', 40, 60),
    ]);
    expect(chain.slice(0, 30).every((m) => m.excludeFromModel)).toBe(true);
    expect(chain.slice(31, 61).every((m) => m.excludeFromModel)).toBe(true);
    expect(chain.slice(62).every((m) => !m.excludeFromModel)).toBe(true);
  });
});
