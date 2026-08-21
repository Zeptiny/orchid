/**
 * Durable compaction persistence (P0 data-loss regression tests).
 *
 * Between-turns compaction must write flags + summary head directly against
 * durable chain rows in one transaction. The previous implementation sourced
 * the session from loadSessionView (bounded 240-message / 2MB budgets) and
 * called saveSession, which DELETEs + reinserts only in-memory content —
 * permanently truncating pre-window history and wiping every durable
 * subagent_chains row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../src/shared/types/session';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { Chain } from '../../src/shared/types/chain';
import { ChainStatus } from '../../src/shared/types/chain';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import { SubagentStatus } from '../../src/shared/types/subagent';
import type { StorageOptions } from '../../src/main/session/storage';
import {
  saveSession,
  loadSessionForReplacement,
  loadSessionView,
  loadSessionMessages,
  loadSubagentRecords,
  upsertSubagentRecords,
  applyCompactionPersistence,
  applySubagentCompactionPersistence,
  finishChain,
  _clearDbCache,
} from '../../src/main/session/storage';
import { openSqliteDb } from '../../src/main/utils/sqlite';
import { SessionManager } from '../../src/main/session/manager';
import { buildCompactionApply } from '../../src/main/llm/compaction/apply';
import { persistCompactionBetweenTurns, attachUsageToLatestAssistant } from '../../src/main/ipc/chat/persist';

const holders = vi.hoisted(() => ({
  sessionManager: null as unknown,
}));

vi.mock('electron', () => ({
  webContents: {
    getAllWebContents: () => [],
    fromId: () => null,
  },
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: (): unknown => holders.sessionManager,
  resolveWindowWorkspace: () => ({ cwd: null, source: 'unbound', status: 'unbound' }),
}));

let tmpDir: string;
let storageOpts: StorageOptions;

const T0 = '2026-01-01T00:00:00.000Z';

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
    agentName: 'general',
    agentType: 'main',
    agentTier: 'bloom',
    subagentRecord: null,
    startTime: T0,
    endTime: T0,
    errorDetail: null,
    errorTitle: null,
  };
}

function makeSummaryChain(sessionId: string, chainId: string, messageId: string, content: string): Chain {
  return makeChain(sessionId, chainId, [
    {
      ...makeMessage(messageId, { role: MessageRole.ASSISTANT, content }),
      compacted: { rangeStart: 'm-0000', rangeEnd: 'm-0099', mode: 'simple', summarizedCount: 100 },
    },
  ]);
}

function makeSubagentRecord(sessionId: string, id: string): SubagentRecord {
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
    chain: makeChain(sessionId, `chain-${id}`, []),
  };
}

function makeSession(sessionId: string, chains: Chain[]): Session {
  return {
    id: sessionId,
    name: 'Compaction Test Session',
    selection: null,
    modelLabel: null,
    cwd: null,
    chains,
    activeChainId: null,
    createdAt: T0,
    updatedAt: T0,
    subagentChains: [],
    todoStore: { tasks: [] },
    reasoningEffortOverride: null,
    tierOverride: null,
    permissionMode: null,
  };
}

function flatIds(session: Session): string[] {
  return session.chains.flatMap((chain) => chain.messages.map((message) => message.id));
}

function readChainJson(chainId: string): string {
  const db = openSqliteDb(storageOpts.dbPath!);
  try {
    return (db
      .prepare('SELECT messages_json FROM chains WHERE id = ?')
      .get(chainId) as { messages_json: string }).messages_json;
  } finally {
    db.close();
  }
}

function readSubagentRows(sessionId: string): Array<[string, string]> {
  const db = openSqliteDb(storageOpts.dbPath!);
  try {
    return (db
      .prepare('SELECT subagent_id, record_json FROM subagent_chains WHERE session_id = ? ORDER BY subagent_id')
      .all(sessionId) as Array<{ subagent_id: string; record_json: string }>)
      .map((row) => [row.subagent_id, row.record_json] as [string, string]);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-compaction-test-'));
  storageOpts = {
    dbPath: path.join(tmpDir, 'sessions.db'),
    toolOutputCacheDir: path.join(tmpDir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(tmpDir, 'cache', 'web-fetch'),
  };
});

afterEach(() => {
  _clearDbCache();
  holders.sessionManager = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// applyCompactionPersistence — storage-level durable write
// ===========================================================================

describe('applyCompactionPersistence (targeted durable write)', () => {
  it('(a) preserves pre-window history beyond the view budget: flags the prefix, inserts the summary between prefix and preserved window', () => {
    const sessionId = 'cafe0001-0001-4001-8001-000000000001';
    // 350 messages total — far past the 240-message view budget.
    const chainA = makeChain(sessionId, 'chain-a', messages('m', 200, 0));
    const chainB = makeChain(sessionId, 'chain-b', messages('m', 100, 200));
    const chainC = makeChain(sessionId, 'chain-c', messages('m', 50, 300));
    saveSession(makeSession(sessionId, [chainA, chainB, chainC]), storageOpts);

    // Sanity: the navigation view is bounded (exactly the sessions compaction
    // targets) — old chains arrive with partial/empty message arrays.
    const view = loadSessionView(sessionId, storageOpts)!;
    const viewMessages = view.chains.reduce((total, chain) => total + chain.messages.length, 0);
    expect(viewMessages).toBeLessThan(350);
    expect(view.chains.some((chain) => chain.messagesLoaded === false)).toBe(true);

    // Flag all of chain-a; the summary lands right before chain-b starts.
    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: durable compaction');
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 200, 0),
      summaryChain: summary,
      insertBeforeMessageId: 'm-0200',
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    // (c) reload order: the summary head sits INLINE at the start of chain-b
    // (the anchor chain) — flagged prefix chains → summary head → preserved
    // window. No extra chain rows.
    expect(full.chains.map((chain) => chain.id)).toEqual([
      'chain-a',
      'chain-b',
      'chain-c',
    ]);
    // Every pre-window message survives — no truncation.
    expect(flatIds(full)).toEqual([
      ...idRange('m', 200, 0),
      'summary-head',
      ...idRange('m', 150, 200),
    ]);
    // Flagged ids are excluded from the model; the window is untouched.
    for (const message of full.chains[0]!.messages) {
      expect(message.excludeFromModel).toBe(true);
    }
    const summaryMessage = full.chains[1]!.messages[0]!;
    expect(summaryMessage.content).toBe('SUMMARY: durable compaction');
    expect(summaryMessage.compacted).toMatchObject({ mode: 'simple', summarizedCount: 100 });
    for (const message of full.chains[1]!.messages.slice(1)) {
      expect(message.excludeFromModel).toBe(false);
    }
    for (const chain of full.chains.slice(2)) {
      for (const message of chain.messages) {
        expect(message.excludeFromModel).toBe(false);
      }
    }
  });

  it('(b) never touches durable subagent_chains rows or untouched chain rows', () => {
    const sessionId = 'cafe0002-0002-4002-8002-000000000002';
    const chainA = makeChain(sessionId, 'chain-a', messages('m', 30, 0));
    const chainB = makeChain(sessionId, 'chain-b', messages('m', 30, 30));
    const chainC = makeChain(sessionId, 'chain-c', messages('m', 30, 60));
    saveSession(makeSession(sessionId, [chainA, chainB, chainC]), storageOpts);
    const subagents = [
      makeSubagentRecord(sessionId, 'sub-1'),
      makeSubagentRecord(sessionId, 'sub-2'),
    ];
    upsertSubagentRecords(sessionId, subagents, T0, storageOpts);

    const chainCJsonBefore = readChainJson('chain-c');
    const subagentRowsBefore = readSubagentRows(sessionId);

    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: subagent safety');
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 45, 0),
      summaryChain: summary,
      insertBeforeMessageId: 'm-0045',
    }, storageOpts);

    // Untouched sibling chain is byte-identical.
    expect(readChainJson('chain-c')).toBe(chainCJsonBefore);
    // Subagent rows survive untouched — the old saveSession path wiped them.
    expect(readSubagentRows(sessionId)).toEqual(subagentRowsBefore);
    expect(loadSubagentRecords(sessionId, undefined, storageOpts)).toEqual(subagents);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(full.subagentChains.map((record) => record.id)).toEqual(['sub-1', 'sub-2']);
    expect(flatIds(full)).toEqual([
      ...idRange('m', 45, 0),
      'summary-head',
      ...idRange('m', 45, 45),
    ]);
  });

  it('(c) inserts the summary INLINE into the chain spanning the cut — no split rows', () => {
    const sessionId = 'cafe0003-0003-4003-8003-000000000003';
    const chainA = makeChain(sessionId, 'chain-a', messages('m', 100, 0));
    const chainB = makeChain(sessionId, 'chain-b', messages('m', 150, 100));
    const chainC = makeChain(sessionId, 'chain-c', messages('m', 50, 250));
    saveSession(makeSession(sessionId, [chainA, chainB, chainC]), storageOpts);

    // Boundary m-0180 sits at index 80 inside chain-b → inline insertion.
    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: inline');
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 180, 0),
      summaryChain: summary,
      insertBeforeMessageId: 'm-0180',
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    // One turn stays one chain row — no split rows, no ordinal changes.
    expect(full.chains.map((chain) => chain.id)).toEqual(['chain-a', 'chain-b', 'chain-c']);
    expect(flatIds(full)).toEqual([
      ...idRange('m', 180, 0),
      'summary-head',
      ...idRange('m', 120, 180),
    ]);
    const chainARow = full.chains[0]!;
    const chainBRow = full.chains[1]!;
    expect(chainARow.messages.every((message) => message.excludeFromModel)).toBe(true);
    const headMessage = chainBRow.messages[80]!;
    expect(headMessage.id).toBe('summary-head');
    expect(headMessage.compacted).toMatchObject({ mode: 'simple' });
    expect(chainBRow.messages.slice(0, 80).every((message) => message.excludeFromModel)).toBe(true);
    expect(chainBRow.messages.slice(81).every((message) => !message.excludeFromModel)).toBe(true);
  });

  it('(c2) an ACTIVE chain compacted mid-turn keeps ACTIVE + the session pointer, summary inline', () => {
    const sessionId = 'cafe0004-0004-4004-8004-000000000004';
    const activeChain = {
      ...makeChain(sessionId, 'chain-b', messages('m', 100, 100)),
      status: ChainStatus.ACTIVE,
      endTime: null,
    };
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 100, 0)),
      activeChain,
    ]), storageOpts);
    // Point the session at the active row the way startChain does.
    const db = openSqliteDb(storageOpts.dbPath!);
    try {
      db.prepare('UPDATE sessions SET active_chain_id = ? WHERE id = ?').run('chain-b', sessionId);
    } finally {
      db.close();
    }

    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: active inline');
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 150, 0),
      summaryChain: summary,
      insertBeforeMessageId: 'm-0150',
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(full.chains.map((chain) => chain.id)).toEqual(['chain-a', 'chain-b']);
    // The turn row stays the live row: ACTIVE status preserved and the
    // session's active-chain pointer still resolves to it.
    const turnRow = full.chains[1]!;
    expect(turnRow.status).toBe(ChainStatus.ACTIVE);
    expect(full.activeChainId).toBe('chain-b');
    // Inline summary at the cut: 50 flagged, head, 50 preserved.
    expect(turnRow.messages.map((message) => message.id)).toEqual([
      ...idRange('m', 50, 100),
      'summary-head',
      ...idRange('m', 50, 150),
    ]);
    expect(turnRow.messages.slice(0, 50).every((message) => message.excludeFromModel)).toBe(true);
    expect(turnRow.messages[50]!.compacted).toMatchObject({ mode: 'simple' });
    expect(turnRow.messages.slice(51).every((message) => !message.excludeFromModel)).toBe(true);
  });

  it('(c3) re-compaction grows the SAME row — every id exactly once, user message first', () => {
    const sessionId = 'cafe000a-000a-400a-800a-00000000010a';
    // The live mid-turn shape: one ACTIVE chain holding the whole turn
    // (user + assistant work).
    const user = makeMessage('u-0000', { role: MessageRole.USER, content: 'explore' });
    const work = messages('m', 10, 0).map((message) => ({ ...message, role: MessageRole.ASSISTANT }));
    const active = {
      ...makeChain(sessionId, 'chain-turn', [user, ...work]),
      status: ChainStatus.ACTIVE,
      endTime: null,
    };
    saveSession(makeSession(sessionId, [active]), storageOpts);
    const db = openSqliteDb(storageOpts.dbPath!);
    try {
      db.prepare('UPDATE sessions SET active_chain_id = ? WHERE id = ?').run('chain-turn', sessionId);
    } finally {
      db.close();
    }

    // Compaction 1: cut at m-0005 (inside the turn). Prefix flagged, head1 inline.
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 5, 0),
      summaryChain: makeSummaryChain(sessionId, 'chain-summary-1', 'head-1', 'SUMMARY: one'),
      insertBeforeMessageId: 'm-0005',
    }, storageOpts);
    // The turn resumes; the checkpoint writes the FULL turn (model history +
    // new content m-0010..m-0011) into the same row — heads included.
    const manager = new SessionManager({ storage: storageOpts });
    const afterOne = loadSessionForReplacement(sessionId, storageOpts)!;
    manager.setCachedSession({ ...makeSession(sessionId, afterOne.chains), activeChainId: 'chain-turn' });
    manager.updateActiveChainMessages(
      [
        ...afterOne.chains[0]!.messages,
        ...messages('m', 2, 10).map((message) => ({ ...message, role: MessageRole.ASSISTANT })),
      ],
      sessionId,
    );
    // Compaction 2: cut at m-0009 — supersedes head1 (flagged) and inserts
    // head2 inline.
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:01:00.000Z',
      flaggedMessageIds: [...idRange('m', 4, 5), 'head-1'],
      summaryChain: makeSummaryChain(sessionId, 'chain-summary-2', 'head-2', 'SUMMARY: two'),
      insertBeforeMessageId: 'm-0009',
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    // Still ONE chain row, still the live turn row.
    expect(full.chains.map((chain) => chain.id)).toEqual(['chain-turn']);
    const row = full.chains[0]!;
    expect(row.status).toBe(ChainStatus.ACTIVE);
    expect(full.activeChainId).toBe('chain-turn');
    // Replay order: user, flagged prefix, superseded head1 (flagged), flagged
    // mid-range, current head2, preserved window + new content.
    expect(row.messages.map((message) => message.id)).toEqual([
      'u-0000',
      ...idRange('m', 5, 0),
      'head-1',
      ...idRange('m', 4, 5),
      'head-2',
      ...idRange('m', 1, 9),
      ...idRange('m', 2, 10),
    ]);
    expect(row.messages[0]!.excludeFromModel).toBe(false);
    expect(row.messages.find((message) => message.id === 'head-1')!.excludeFromModel).toBe(true);
    expect(row.messages.find((message) => message.id === 'head-2')!.excludeFromModel).toBe(false);
    // Every original id appears exactly once — no duplication ladder.
    const allIds = row.messages.map((message) => message.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('flags without a summary head (reclaim-only) and keeps the chain layout unchanged', () => {
    const sessionId = 'cafe0005-0005-4005-8005-000000000005';
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 40, 0)),
      makeChain(sessionId, 'chain-b', messages('m', 40, 40)),
    ]), storageOpts);

    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 10, 5),
      summaryChain: null,
      insertBeforeMessageId: null,
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(full.chains.map((chain) => chain.id)).toEqual(['chain-a', 'chain-b']);
    expect(flatIds(full)).toEqual([...idRange('m', 40, 0), ...idRange('m', 40, 40)]);
    const flagged = full.chains[0]!.messages.filter((message) => message.excludeFromModel);
    expect(flagged.map((message) => message.id)).toEqual(idRange('m', 10, 5));
  });

  it('(d) throws when a flagged message id has no durable chain', () => {
    const sessionId = 'cafe0006-0006-4006-8006-000000000006';
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 10, 0)),
    ]), storageOpts);

    expect(() => applyCompactionPersistence(sessionId, {
      updatedAt: T0,
      flaggedMessageIds: ['not-a-durable-message'],
      summaryChain: null,
      insertBeforeMessageId: null,
    }, storageOpts)).toThrow(/not-a-durable-message/);

    // The failed write must leave durable content untouched.
    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(flatIds(full)).toEqual(idRange('m', 10, 0));
    expect(full.chains[0]!.messages.every((message) => !message.excludeFromModel)).toBe(true);
  });

  it('(d) throws when the summary anchor message cannot be found', () => {
    const sessionId = 'cafe0007-0007-4007-8007-000000000007';
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 10, 0)),
    ]), storageOpts);

    expect(() => applyCompactionPersistence(sessionId, {
      updatedAt: T0,
      flaggedMessageIds: idRange('m', 5, 0),
      summaryChain: makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY'),
      insertBeforeMessageId: 'missing-anchor',
    }, storageOpts)).toThrow(/missing-anchor/);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(full.chains.map((chain) => chain.id)).toEqual(['chain-a']);
    expect(full.chains[0]!.messages.every((message) => !message.excludeFromModel)).toBe(true);
  });

  it('(d) throws for an unknown session and refuses re-inserting an existing summary row', () => {
    expect(() => applyCompactionPersistence('cafe0008-0008-4008-8008-000000000008', {
      updatedAt: T0,
      flaggedMessageIds: [],
      summaryChain: null,
      insertBeforeMessageId: null,
    }, storageOpts)).toThrow(/not found in durable rows/);

    const sessionId = 'cafe0009-0009-4009-8009-000000000009';
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 10, 0)),
    ]), storageOpts);
    const payload = {
      updatedAt: T0,
      flaggedMessageIds: idRange('m', 5, 0),
      summaryChain: makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY'),
      insertBeforeMessageId: null,
    } as const;
    applyCompactionPersistence(sessionId, payload, storageOpts);
    // Re-running the same compaction must fail loudly (PK) instead of
    // duplicating the summary row.
    expect(() => applyCompactionPersistence(sessionId, payload, storageOpts)).toThrow();
    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(full.chains.filter((chain) => chain.id === 'chain-summary')).toHaveLength(1);
  });

  it('(e) clears settle-cleared ids in the same transaction; unknown cleared ids abort the write', () => {
    const sessionId = 'cafe000d-000d-400d-800d-00000000000d';
    // m-0005 is a pre-flagged exempt user message (flagged by a prior, now
    // superseded selective run) — the settle clears it while the compaction
    // flags the prefix.
    const chainA = makeChain(sessionId, 'chain-a', [
      ...messages('m', 5, 0),
      {
        ...makeMessage('m-0005', { role: MessageRole.USER, content: 'keep me' }),
        excludeFromModel: true,
      },
      ...messages('m', 4, 6),
    ]);
    saveSession(makeSession(sessionId, [chainA]), storageOpts);

    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 5, 0),
      clearedMessageIds: ['m-0005'],
      summaryChain: null,
      insertBeforeMessageId: null,
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(flatIds(full)).toEqual([...idRange('m', 6, 0), ...idRange('m', 4, 6)]);
    for (const id of idRange('m', 5, 0)) {
      expect(full.chains[0]!.messages.find((message) => message.id === id)!.excludeFromModel)
        .toBe(true);
    }
    // DURABLY un-flagged: without the same-transaction clear the stale true
    // flag would resurrect the exclusion on reload.
    expect(full.chains[0]!.messages.find((message) => message.id === 'm-0005')!.excludeFromModel)
      .not.toBe(true);
    for (const id of idRange('m', 4, 6)) {
      expect(full.chains[0]!.messages.find((message) => message.id === id)!.excludeFromModel)
        .not.toBe(true);
    }

    // A cleared id with no durable owner is an integrity failure (mirrors the
    // flagged-id throw) and leaves the rows untouched.
    const jsonBeforeFailedWrite = readChainJson('chain-a');
    expect(() => applyCompactionPersistence(sessionId, {
      updatedAt: T0,
      flaggedMessageIds: [],
      clearedMessageIds: ['not-a-durable-message'],
      summaryChain: null,
      insertBeforeMessageId: null,
    }, storageOpts)).toThrow(/not-a-durable-message/);
    expect(readChainJson('chain-a')).toBe(jsonBeforeFailedWrite);
  });
});

// ===========================================================================
// applySubagentCompactionPersistence — subagent-chain durable write
// ===========================================================================

describe('applySubagentCompactionPersistence (targeted subagent durable write)', () => {
  it('flags and clears excludeFromModel, and inserts the summary head inline, in one durable record transaction', () => {
    const sessionId = 'cafe000e-000e-400e-800e-00000000000e';
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 4, 0)),
    ]), storageOpts);

    const base = makeSubagentRecord(sessionId, 'sub-1');
    const subMessages = [
      // Pre-flagged exempt user message (superseded selective run) — cleared.
      { ...makeMessage('sm-0000', { role: MessageRole.USER, content: 'keep me' }), excludeFromModel: true },
      ...messages('sm', 3, 1).map((message) => ({ ...message, role: MessageRole.ASSISTANT })),
    ];
    const record = { ...base, chain: makeChain(sessionId, 'chain-sub-1', subMessages) };
    upsertSubagentRecords(sessionId, [record], T0, storageOpts);

    applySubagentCompactionPersistence(sessionId, 'sub-1', {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: ['sm-0001'],
      clearedMessageIds: ['sm-0000'],
      summaryMessage: {
        ...makeMessage('sub-summary-head', { role: MessageRole.ASSISTANT, content: 'SUMMARY: subagent' }),
        compacted: { rangeStart: 'sm-0000', rangeEnd: 'sm-0001', mode: 'selective' },
      },
      insertBeforeMessageId: 'sm-0002',
    }, storageOpts);

    // The durable record is reloaded (not the in-memory snapshot) and shows
    // the settled shape: cleared id visible, flagged id excluded, summary
    // head inline before the anchor, anchor + tail untouched.
    const reloaded = loadSubagentRecords(sessionId, ['sub-1'], storageOpts)[0]!;
    expect(reloaded.chain.messages.map((message) => [message.id, message.excludeFromModel === true]))
      .toEqual([
        ['sm-0000', false], // cleared (F3)
        ['sm-0001', true],  // flagged
        ['sub-summary-head', false], // inline summary head before the anchor
        ['sm-0002', false],
        ['sm-0003', false],
      ]);

    // Unknown cleared ids abort the whole write (integrity throw).
    expect(() => applySubagentCompactionPersistence(sessionId, 'sub-1', {
      updatedAt: T0,
      flaggedMessageIds: [],
      clearedMessageIds: ['not-a-durable-message'],
      summaryMessage: null,
      insertBeforeMessageId: null,
    }, storageOpts)).toThrow(/not-a-durable-message/);
  });
});

// ===========================================================================
// persistCompactionBetweenTurns — end-to-end over a bounded in-memory view
// ===========================================================================

describe('persistCompactionBetweenTurns (durable path over partial view)', () => {
  /**
   * R31: buildCompactionApply's universal settle never flags user messages,
   * and this block verifies durable flagging of out-of-view pre-window
   * history — so its seeds use non-user (assistant) messages.
   */
  function durableMessages(prefix: string, count: number, from = 0): Message[] {
    return messages(prefix, count, from).map((message) => ({ ...message, role: MessageRole.ASSISTANT }));
  }

  function seedOverBudgetSession(sessionId: string): void {
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', durableMessages('m', 200, 0)),
      makeChain(sessionId, 'chain-b', durableMessages('m', 100, 200)),
    ]), storageOpts);
    upsertSubagentRecords(
      sessionId,
      [makeSubagentRecord(sessionId, 'durable-sub-1')],
      T0,
      storageOpts,
    );
  }

  function buildApplyFor(sessionId: string) {
    const manager = holders.sessionManager as SessionManager;
    const view = manager.getSession(sessionId)!;
    const flat = loadSessionMessages(sessionId, storageOpts);
    expect(flat).toHaveLength(300);
    return buildCompactionApply({
      messages: flat,
      chains: view.chains as Chain[],
      cutResult: {
        cutIndex: 100,
        compactableRange: { start: 0, end: 100 },
        preservedCount: 200,
        openGroupStart: null,
        preservedRange: { start: 100, end: 300 },
      },
      summaryText: 'SUMMARY: durable compaction',
      mode: 'simple',
      sessionId,
    });
  }

  beforeEach(() => {
    holders.sessionManager = new SessionManager({ storage: storageOpts });
  });

  it('persists without truncating pre-window history, keeps subagent rows, and refreshes the cache view', () => {
    const sessionId = 'cafe000a-000a-400a-800a-00000000000a';
    seedOverBudgetSession(sessionId);
    const manager = holders.sessionManager as SessionManager;

    // The in-memory session is a bounded view: chain-a arrives partial.
    const view = manager.getSession(sessionId)!;
    expect(view.chains[0]!.messagesLoaded).toBe(false);
    expect(view.chains[0]!.messages.length).toBeLessThan(200);

    const applyResult = buildApplyFor(sessionId);
    expect(applyResult.didApply).toBe(true);
    // The pure apply produces the summary carrier (single-row topology — the
    // partial view chains are never split into rows).
    expect(applyResult.newChain).not.toBeNull();

    const ok = persistCompactionBetweenTurns(sessionId, applyResult);
    expect(ok).toBe(true);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    const flatOrder = flatIds(full);
    // Pre-window ids that were NOT part of the in-memory view (m-0000…m-0059)
    // must still exist durably, flagged, in replay position.
    expect(flatOrder).toEqual([
      ...idRange('m', 100, 0),
      applyResult.summaryMessage!.id,
      ...idRange('m', 200, 100),
    ]);
    const outsideView = full.chains[0]!.messages.find((message) => message.id === 'm-0000')!;
    expect(outsideView.excludeFromModel).toBe(true);
    const preserved = full.chains.at(-1)!.messages;
    expect(preserved.every((message) => !message.excludeFromModel)).toBe(true);

    // Subagent rows survive the compaction write.
    expect(loadSubagentRecords(sessionId, undefined, storageOpts).map((record) => record.id))
      .toEqual(['durable-sub-1']);

    // In-memory cache: refreshed from durable rows — the summary sits INLINE
    // in chain-a at the cut (chain-a keeps its id and row; flags visible on
    // the prefix it holds in the bounded view).
    const cached = manager.getSession(sessionId)!;
    const cachedIds = cached.chains.map((chain) => chain.id);
    expect(cachedIds).toContain('chain-a');
    expect(cachedIds).toContain('chain-b');
    expect(cachedIds).not.toContain(applyResult.newChain!.id);
    const cachedChainA = cached.chains.find((chain) => chain.id === 'chain-a')!;
    const inlineHead = cachedChainA.messages.find((message) => message.compacted);
    expect(inlineHead).toBeDefined();
    expect(inlineHead!.id).toBe(applyResult.summaryMessage!.id);
  });

  it('returns false without durable writes when the compaction references unknown durable ids', () => {
    const sessionId = 'cafe000b-000b-400b-800b-00000000000b';
    seedOverBudgetSession(sessionId);

    const applyResult = buildApplyFor(sessionId);
    const ok = persistCompactionBetweenTurns(sessionId, {
      ...applyResult,
      flaggedIds: [...applyResult.flaggedIds, 'not-a-durable-message'],
    });
    expect(ok).toBe(false);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(flatIds(full)).toEqual(idRange('m', 300, 0));
    expect(full.chains.every((chain) => chain.messages.every((message) => !message.excludeFromModel)))
      .toBe(true);
    expect(loadSubagentRecords(sessionId, undefined, storageOpts).map((record) => record.id))
      .toEqual(['durable-sub-1']);
  });

  it('treats a didApply=false result as a no-op success', () => {
    const sessionId = 'cafe000c-000c-400c-800c-00000000000c';
    seedOverBudgetSession(sessionId);
    const manager = holders.sessionManager as SessionManager;
    manager.getSession(sessionId);

    const ok = persistCompactionBetweenTurns(sessionId, {
      updatedChains: [],
      newChain: null,
      didApply: false,
    });
    expect(ok).toBe(true);
    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(flatIds(full)).toEqual(idRange('m', 300, 0));
  });
});

// ===========================================================================
// Superseded chain reconcile — split-tail retirement (stale active row fix)
// ===========================================================================
//
// A mid-turn compaction whose cut lands inside the active chain's row splits
// that row durably: head (flagged prefix) → summary → tail (preserved window,
// cloned metadata — including the ACTIVE status). The turn then finalizes into
// the HEAD row (persistTurn rewrites it with the full turn), leaving the tail
// row orphaned: no writer targets it, no finalizer closes it, and its message
// ids duplicate the head's. Reproduced from session "Refining Unity
// Compaction Code" (tail at ordinal 2 duplicating messages 43-46, cloned
// start_time, status=active forever).
//
// Invariant restored: at rest, one turn = one chain row. Finalize retires the
// subsumed tail in the same transaction; loads heal crash orphans and
// already-damaged sessions.

describe('superseded chain reconcile (split-tail retirement)', () => {
  function chainRowsFor(sessionId: string): Array<{ id: string; status: string }> {
    const db = openSqliteDb(storageOpts.dbPath!);
    try {
      return db
        .prepare('SELECT id, status FROM chains WHERE session_id = ? ORDER BY ordinal')
        .all(sessionId) as Array<{ id: string; status: string }>;
    } finally {
      db.close();
    }
  }

  function offsetsFor(chainId: string): number {
    const db = openSqliteDb(storageOpts.dbPath!);
    try {
      return (db
        .prepare('SELECT COUNT(*) AS n FROM chain_message_offsets WHERE chain_id = ?')
        .get(chainId) as { n: number }).n;
    } finally {
      db.close();
    }
  }

  /**
   * The Unity-session shape. After the mid-turn split (head → summary → tail),
   * the resumed turn finalizes into the HEAD row with the FULL turn — which
   * includes the summary message in-position (chain0[42]) and the tail's
   * content. Both the standalone summary row and the tail row are therefore
   * subsumed duplicates of the finalized head.
   */
  function seedSplitTailSession(sessionId: string, tailStatus = ChainStatus.ACTIVE): Session {
    const summaryMessage = {
      ...makeMessage('summary-head', { role: MessageRole.ASSISTANT, content: 'SUMMARY: mid-turn handoff' }),
      compacted: { rangeStart: 'm-0000', rangeEnd: 'm-0041', mode: 'simple' as const, summarizedCount: 42 },
    };
    const head = makeChain(sessionId, 'chain-head', [
      ...messages('m', 42, 0).map((message) => ({ ...message, excludeFromModel: true })),
      summaryMessage,
      ...messages('m', 47, 43),
    ]);
    const summary = makeChain(sessionId, 'chain-summary', [summaryMessage]);
    const tail = { ...makeChain(sessionId, 'chain-tail', messages('m', 4, 43)), status: tailStatus };
    const session = makeSession(sessionId, [head, summary, tail]);
    saveSession(session, storageOpts);
    return session;
  }

  it('finishChain retires every subsumed row (tail + absorbed summary) in the same transaction', () => {
    const sessionId = 'cafe0100-0100-4100-8100-000000000100';
    const session = seedSplitTailSession(sessionId);
    const head = { ...session.chains[0]!, status: ChainStatus.ACTIVE };

    const result = finishChain(
      { ...head, status: ChainStatus.COMPLETED },
      '2026-01-02T00:00:00.000Z',
      { tasks: [] },
      storageOpts,
    );

    expect(result.ok).toBe(true);
    expect([...result.retiredChainIds]).toEqual(['chain-summary', 'chain-tail']);
    // Durable rows: the head alone survives, holding the full turn.
    expect(chainRowsFor(sessionId).map((row) => row.id)).toEqual(['chain-head']);
    expect(offsetsFor('chain-tail')).toBe(0);
    expect(offsetsFor('chain-head')).toBe(90);
    // Replay: 90 unique ids in order — the summary message survives in-position.
    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    const ids = flatIds(full);
    expect(ids).toHaveLength(90);
    expect(new Set(ids).size).toBe(90);
    expect(ids[42]).toBe('summary-head');
    expect(full.chains[0]!.messages[42]!.compacted).toMatchObject({ mode: 'simple' });
  });

  it('retires a stale duplicate row whose extra content the owner also holds (duplicated hidden carrier); the head keeps its visible sequence', () => {
    const sessionId = 'cafe0107-0107-4107-8107-000000000107';
    // Shape reproduced from session "Analyze Compaction System Implementation":
    // a stray split row duplicating two visible tool ids plus a hidden
    // usage-carrier message. When the owner holds that carrier id too, the
    // full id set (visible + hidden) is contained and the row retires.
    const head = makeChain(sessionId, 'chain-head', [
      ...messages('m', 46, 0),
      makeMessage('hidden-extra', { role: MessageRole.ASSISTANT, hidden: true }),
    ]);
    const stray = makeChain(sessionId, 'chain-stray', [
      makeMessage('m-0043'),
      makeMessage('m-0044'),
      makeMessage('hidden-extra', { role: MessageRole.ASSISTANT, hidden: true }), // duplicated carrier
    ]);
    saveSession(makeSession(sessionId, [head, stray]), storageOpts);

    const view = loadSessionView(sessionId, storageOpts)!;

    // Full id set contained in chain-head — the duplicated hidden extra does
    // not protect the row.
    expect(view.chains.map((chain) => chain.id)).toEqual(['chain-head']);
    // The surviving chain-head keeps its expected visible message sequence —
    // the retire dropped only the duplicate row, nothing else (F26).
    const surviving = view.chains[0]!;
    expect(surviving.messages.filter((message) => !message.hidden).map((message) => message.id))
      .toEqual(idRange('m', 46, 0));
  });

  it('preserves a stray row whose hidden ids the owner does not hold (no hidden-usage loss)', () => {
    const sessionId = 'cafe0108-0108-4108-8108-000000000108';
    // Same stray shape, but the hidden usage carrier is UNIQUE to the stray
    // row — retiring it would silently drop usage evidence nothing else holds.
    const head = makeChain(sessionId, 'chain-head', [
      ...messages('m', 46, 0),
      makeMessage('hidden-extra', { role: MessageRole.ASSISTANT, hidden: true }),
    ]);
    const stray = makeChain(sessionId, 'chain-stray', [
      makeMessage('m-0043'),
      makeMessage('m-0044'),
      makeMessage('stray-hidden', { role: MessageRole.ASSISTANT, hidden: true }), // unique carrier
    ]);
    saveSession(makeSession(sessionId, [head, stray]), storageOpts);

    const view = loadSessionView(sessionId, storageOpts)!;

    // Visible content is contained but the hidden carrier is not — the row
    // survives, hidden usage intact.
    expect(view.chains.map((chain) => chain.id)).toEqual(['chain-head', 'chain-stray']);
    expect(view.chains[1]!.messages.map((message) => message.id))
      .toEqual(['m-0043', 'm-0044', 'stray-hidden']);
  });

  it('finishChain leaves sibling chains alone when nothing is subsumed', () => {
    const sessionId = 'cafe0101-0101-4101-8101-000000000101';
    const chainA = makeChain(sessionId, 'chain-a', messages('m', 30, 0));
    const chainB = makeChain(sessionId, 'chain-b', messages('m', 30, 30));
    saveSession(makeSession(sessionId, [chainA, chainB]), storageOpts);

    const result = finishChain(
      { ...chainA, status: ChainStatus.COMPLETED },
      '2026-01-02T00:00:00.000Z',
      { tasks: [] },
      storageOpts,
    );

    expect(result.ok).toBe(true);
    expect(result.retiredChainIds).toEqual([]);
    expect(chainRowsFor(sessionId).map((row) => row.id)).toEqual(['chain-a', 'chain-b']);
  });

  it('load heals an orphaned split tail (crash between apply and finalize)', () => {
    const sessionId = 'cafe0102-0102-4102-8102-000000000102';
    seedSplitTailSession(sessionId);

    const view = loadSessionView(sessionId, storageOpts)!;

    expect(view.chains.map((chain) => chain.id)).toEqual(['chain-head']);
    expect(chainRowsFor(sessionId).map((row) => row.id)).toEqual(['chain-head']);
    const ids = flatIds(view);
    expect(new Set(ids).size).toBe(ids.length);
    // No chain is left claiming to be an in-flight turn.
    expect(view.chains.every((chain) => chain.status !== ChainStatus.ACTIVE)).toBe(true);
  });

  it('between-turns summary chains (not absorbed by a turn row) survive loads', () => {
    const sessionId = 'cafe0106-0106-4106-8106-000000000106';
    // Normal between-turns layout: the summary message exists ONLY in its own
    // chain — no turn row contains it, so it must never be reconciled away.
    const chainA = makeChain(sessionId, 'chain-a', messages('m', 30, 0));
    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: between turns');
    const chainB = makeChain(sessionId, 'chain-b', messages('m', 30, 30));
    saveSession(makeSession(sessionId, [chainA, summary, chainB]), storageOpts);

    const view = loadSessionView(sessionId, storageOpts)!;

    expect(view.chains.map((chain) => chain.id)).toEqual(['chain-a', 'chain-summary', 'chain-b']);
    expect(flatIds(view)).toEqual([...idRange('m', 30, 0), 'summary-head', ...idRange('m', 30, 30)]);
  });

  it('identical duplicate chains keep the earliest row only — never both, never neither', () => {
    const sessionId = 'cafe0103-0103-4103-8103-000000000103';
    const dupA = makeChain(sessionId, 'chain-dup-a', messages('m', 5, 0));
    const dupB = makeChain(sessionId, 'chain-dup-b', messages('m', 5, 0));
    saveSession(makeSession(sessionId, [dupA, dupB]), storageOpts);

    const view = loadSessionView(sessionId, storageOpts)!;

    expect(view.chains.map((chain) => chain.id)).toEqual(['chain-dup-a']);
  });

  it('never deletes the chain referenced by active_chain_id at load', () => {
    const sessionId = 'cafe0104-0104-4104-8104-000000000104';
    seedSplitTailSession(sessionId, ChainStatus.COMPLETED);
    const db = openSqliteDb(storageOpts.dbPath!);
    try {
      db.prepare('UPDATE sessions SET active_chain_id = ? WHERE id = ?').run('chain-tail', sessionId);
    } finally {
      db.close();
    }

    const view = loadSessionView(sessionId, storageOpts)!;

    // The pointer protects the tail even though the head subsumes it; the
    // absorbed summary row is still retired (nothing references it).
    expect(view.chains.map((chain) => chain.id)).toEqual(['chain-head', 'chain-tail']);
    expect(view.activeChainId).toBe('chain-tail');
  });

  it('SessionManager.finishActiveChain mirrors the durable retire in the cached session', () => {
    const sessionId = 'cafe0105-0105-4105-8105-000000000105';
    const manager = new SessionManager({ storage: storageOpts });
    const session = seedSplitTailSession(sessionId);
    const head = session.chains[0]!;
    // Cache the post-compaction in-memory shape (tail still present, head active).
    manager.setCachedSession({
      ...session,
      chains: [
        { ...head, status: ChainStatus.ACTIVE },
        session.chains[1]!,
        { ...session.chains[2]!, status: ChainStatus.ACTIVE },
      ],
      activeChainId: head.id,
    });

    const updated = manager.finishActiveChain(ChainStatus.COMPLETED, sessionId);

    expect(updated!.chains.map((chain) => chain.id)).toEqual(['chain-head']);
    expect(updated!.activeChainId).toBeNull();
    expect(chainRowsFor(sessionId).map((row) => row.id)).toEqual(['chain-head']);
    expect(manager.getSession(sessionId)!.chains.map((chain) => chain.id))
      .toEqual(['chain-head']);
  });
});

describe('attachUsageToLatestAssistant — compaction summary guard', () => {
  it('never stamps a later step usage onto a compaction summary head', () => {
    const summaryMarker = {
      rangeStart: 'start-id',
      rangeEnd: 'end-id',
      mode: 'simple' as const,
      summarizedCount: 43,
    };
    const summaryHead = makeMessage('summary-head', {
      role: MessageRole.ASSISTANT,
      type: MessageType.TEXT,
      content: '# Handoff Summary',
      compacted: summaryMarker,
    });
    const user = makeMessage('user-1', { role: MessageRole.USER });
    const realAssistant = makeMessage('assistant-1', {
      role: MessageRole.ASSISTANT,
      type: MessageType.TEXT,
      content: 'Real work.',
    });
    const usage = {
      prompt_tokens: 105577,
      completion_tokens: 895,
      total_tokens: 106472,
      cached_tokens: 0,
    };

    // Summary head is the LAST assistant text message — usage must skip it.
    const withSummaryLast = [user, realAssistant, summaryHead];
    expect(attachUsageToLatestAssistant(withSummaryLast, usage)).toBe(true);
    expect(summaryHead.usage).toBeNull();
    expect(withSummaryLast[1]!.usage).toEqual(usage);

    // Without a summary head the latest assistant still receives it.
    const plain = makeMessage('assistant-2', {
      role: MessageRole.ASSISTANT,
      type: MessageType.TEXT,
      content: 'Later work.',
    });
    const withoutSummary = [user, realAssistant, plain];
    expect(attachUsageToLatestAssistant(withoutSummary, usage)).toBe(true);
    expect(withoutSummary[2]!.usage).toEqual(usage);
  });
});
