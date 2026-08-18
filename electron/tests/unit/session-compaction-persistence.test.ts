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
  _clearDbCache,
} from '../../src/main/session/storage';
import { openSqliteDb } from '../../src/main/utils/sqlite';
import { SessionManager } from '../../src/main/session/manager';
import { buildCompactionApply } from '../../src/main/llm/compaction/apply';
import { persistCompactionBetweenTurns } from '../../src/main/ipc/chat/persist';

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
    // (c) reload order: flagged prefix chains → summary head → preserved window.
    expect(full.chains.map((chain) => chain.id)).toEqual([
      'chain-a',
      'chain-summary',
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
    for (const chain of full.chains.slice(1)) {
      for (const message of chain.messages) {
        expect(message.excludeFromModel).toBe(false);
      }
    }
    const summaryMessage = full.chains[1]!.messages[0]!;
    expect(summaryMessage.content).toBe('SUMMARY: durable compaction');
    expect(summaryMessage.compacted).toMatchObject({ mode: 'simple', summarizedCount: 100 });
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
      splitTailChain: makeChain(sessionId, 'chain-a-tail', []),
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

  it('(c) splits the chain spanning the cut so reload order is prefix → summary → preserved suffix (synthesized tail when none supplied)', () => {
    const sessionId = 'cafe0003-0003-4003-8003-000000000003';
    const chainA = makeChain(sessionId, 'chain-a', messages('m', 100, 0));
    const chainB = makeChain(sessionId, 'chain-b', messages('m', 150, 100));
    const chainC = makeChain(sessionId, 'chain-c', messages('m', 50, 250));
    saveSession(makeSession(sessionId, [chainA, chainB, chainC]), storageOpts);

    // Boundary m-0180 sits at index 80 inside chain-b → split.
    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: split');
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 180, 0),
      summaryChain: summary,
      insertBeforeMessageId: 'm-0180',
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    const [prefix, head, summaryChainRow, tail, later] = full.chains;
    // Original id stays with the pre-boundary head; the tail gets a fresh id.
    expect(prefix!.id).toBe('chain-a');
    expect(head!.id).toBe('chain-b');
    expect(summaryChainRow!.id).toBe('chain-summary');
    expect(tail!.id).not.toBe('chain-b');
    expect(later!.id).toBe('chain-c');
    expect(full.chains.map((chain) => chain.id)).toEqual([
      'chain-a',
      'chain-b',
      'chain-summary',
      tail!.id,
      'chain-c',
    ]);
    expect(flatIds(full)).toEqual([
      ...idRange('m', 180, 0),
      'summary-head',
      ...idRange('m', 120, 180),
    ]);
    expect(prefix!.messages.every((message) => message.excludeFromModel)).toBe(true);
    expect(head!.messages.every((message) => message.excludeFromModel)).toBe(true);
    expect(tail!.messages.every((message) => !message.excludeFromModel)).toBe(true);
    // The synthesized tail clones the split chain's metadata.
    expect(tail!.agentName).toBe('general');
    expect(tail!.status).toBe(ChainStatus.COMPLETED);
  });

  it('(c2) uses the caller-supplied split tail identity when provided', () => {
    const sessionId = 'cafe0004-0004-4004-8004-000000000004';
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 100, 0)),
      makeChain(sessionId, 'chain-b', messages('m', 100, 100)),
    ]), storageOpts);

    const summary = makeSummaryChain(sessionId, 'chain-summary', 'summary-head', 'SUMMARY: tail identity');
    applyCompactionPersistence(sessionId, {
      updatedAt: '2026-01-02T00:00:00.000Z',
      flaggedMessageIds: idRange('m', 100, 0),
      summaryChain: summary,
      insertBeforeMessageId: 'm-0150',
      splitTailChain: makeChain(sessionId, 'apply-after-chain', []),
    }, storageOpts);

    const full = loadSessionForReplacement(sessionId, storageOpts)!;
    expect(full.chains.map((chain) => chain.id)).toEqual([
      'chain-a',
      'chain-b',
      'chain-summary',
      'apply-after-chain',
    ]);
    expect(full.chains[3]!.messages.map((message) => message.id)).toEqual(idRange('m', 50, 150));
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
});

// ===========================================================================
// persistCompactionBetweenTurns — end-to-end over a bounded in-memory view
// ===========================================================================

describe('persistCompactionBetweenTurns (durable path over partial view)', () => {
  function seedOverBudgetSession(sessionId: string): void {
    saveSession(makeSession(sessionId, [
      makeChain(sessionId, 'chain-a', messages('m', 200, 0)),
      makeChain(sessionId, 'chain-b', messages('m', 100, 200)),
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
    // The pure apply split the partial chain-a around the cut.
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

    // In-memory cache: summary + split tail spliced in, flags visible where
    // the view held messages.
    const cached = manager.getSession(sessionId)!;
    const cachedIds = cached.chains.map((chain) => chain.id);
    expect(cachedIds).toContain(applyResult.newChain!.id);
    expect(cachedIds).toContain('chain-a');
    expect(cachedIds).toContain('chain-b');
    const cachedFirst = cached.chains[0]!;
    expect(cachedFirst.messages.some((message) => message.excludeFromModel)).toBe(true);
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
