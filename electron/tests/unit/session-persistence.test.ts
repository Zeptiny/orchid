import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../src/shared/types/session';
import type { Message } from '../../src/shared/types/message';
import type { Chain } from '../../src/shared/types/chain';
import { ChainStatus } from '../../src/shared/types/chain';
import type { SubagentRecord } from '../../src/shared/types/subagent';
import { SubagentStatus } from '../../src/shared/types/subagent';
import type { StorageOptions } from '../../src/main/session/storage';
import {
  saveSession,
  loadSession,
  listSavedSessions,
  deleteSession,
  updateChain,
  updateSessionFields,
  upsertSubagentRecords,
  isValidSessionId,
  _clearDbCache,
} from '../../src/main/session/storage';
import { openSqliteDb } from '../../src/main/utils/sqlite';
import { onSessionDeleted, SessionManager } from '../../src/main/session/manager';
import { sessionPermissionOverrides } from '../../src/main/permissions/session-overrides';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

let tmpDir: string;
let storageOpts: StorageOptions;

const DEFAULT_SELECTION = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'gpt-4o',
};
const ANTHROPIC_SELECTION = {
  connectionId: '22222222-2222-4222-8222-222222222222',
  modelId: 'anthropic/claude-3.5-sonnet',
};
const SESSION_SELECTION = {
  connectionId: '33333333-3333-4333-8333-333333333333',
  modelId: 'session-model',
};
const OLD_SELECTION = {
  connectionId: '44444444-4444-4444-8444-444444444444',
  modelId: 'old-model',
};
const PARAM_SELECTION = {
  connectionId: '55555555-5555-4555-8555-555555555555',
  modelId: 'param-model',
};
const NEW_SELECTION = {
  connectionId: '66666666-6666-4666-8666-666666666666',
  modelId: 'new-model',
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-test-'));
}

function makeStorageOpts(dir: string): StorageOptions {
  return {
    dbPath: path.join(dir, 'sessions.db'),
    toolOutputCacheDir: path.join(dir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(dir, 'cache', 'web-fetch'),
  };
}

function makeSession(overrides: Partial<Session> & { model?: string } = {}): Session {
  const now = new Date().toISOString();
  const selection = overrides.selection ?? DEFAULT_SELECTION;
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Session',
    selection,
    modelLabel: overrides.modelLabel ?? overrides.model ?? selection.modelId,
    cwd: overrides.cwd !== undefined ? overrides.cwd : null,
    chains: overrides.chains ?? [],
    activeChainId: overrides.activeChainId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    subagentChains: overrides.subagentChains ?? [],
    todoStore: overrides.todoStore ?? { tasks: [] },
    reasoningEffortOverride: overrides.reasoningEffortOverride ?? null,
    permissionMode: overrides.permissionMode ?? null,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Hello',
    type: overrides.type ?? 'text',
    tool_calls: overrides.tool_calls ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    name: overrides.name ?? null,
    thinking: overrides.thinking ?? null,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    usage: overrides.usage ?? null,
    hidden: overrides.hidden ?? false,
    tool_result: overrides.tool_result ?? null,
  };
}

function makeChain(sessionId: string, overrides: Partial<Chain> & { model?: string } = {}): Chain {
  const now = new Date().toISOString();
  const selection = overrides.selection ?? DEFAULT_SELECTION;
  return {
    id: overrides.id ?? `chain-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    messages: overrides.messages ?? [],
    status: overrides.status ?? ChainStatus.COMPLETED,
    selection,
    modelLabel: overrides.modelLabel ?? overrides.model ?? selection.modelId,
    agentName: overrides.agentName ?? 'General',
    agentType: overrides.agentType ?? 'internal',
    agentTier: overrides.agentTier ?? 'bloom',
    subagentRecord: overrides.subagentRecord ?? null,
    startTime: overrides.startTime ?? now,
    endTime:
      overrides.endTime !== undefined
        ? overrides.endTime
        : overrides.status === ChainStatus.ACTIVE
          ? null
          : now,
  };
}

function makeSubagentRecord(
  sessionId: string,
  overrides: Partial<SubagentRecord> = {},
): SubagentRecord {
  const chainId = overrides.chain_id ?? `sub-chain-${Math.random().toString(36).slice(2, 10)}`;
  const id = overrides.id ?? `sub-${Math.random().toString(36).slice(2, 10)}`;
  const chain =
    overrides.chain ??
    makeChain(sessionId, {
      id: chainId,
      agentName: overrides.agent_name ?? 'explorer',
      agentType: overrides.agent_type ?? 'subagent',
      agentTier: overrides.agent_tier ?? 'seed',
    });
  return {
    id,
    agent_name: overrides.agent_name ?? 'explorer',
    agent_type: overrides.agent_type ?? 'subagent',
    agent_tier: overrides.agent_tier ?? 'seed',
    task: overrides.task ?? 'explore codebase',
    status: overrides.status ?? SubagentStatus.COMPLETED,
    chain_id: chainId,
    start_time: overrides.start_time ?? new Date().toISOString(),
    end_time: overrides.end_time ?? new Date().toISOString(),
    result: overrides.result ?? 'done',
    error: overrides.error ?? null,
    parentChainIndex: overrides.parentChainIndex ?? 0,
    closed: overrides.closed ?? false,
    chain,
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  storageOpts = makeStorageOpts(tmpDir);
});

afterEach(() => {
  _clearDbCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// Save → load round-trip
// ===========================================================================

describe('saveSession → loadSession round-trip', () => {
  it('preserves canonical tool facts through session storage', () => {
    const sessionId = 'a1010101-1010-4010-8010-101010101010';
    const canonical = createCanonicalToolResult('generic', {
      status: 'complete',
      data: {
        value: {
          canonicalOnly: 'SESSION_CANONICAL_SENTINEL',
          ordered: ['first', 'last'],
        },
      },
    });
    const callMessage = makeMessage({
      role: 'assistant',
      type: 'tool_call',
      content: '',
      tool_calls: [
        {
          id: 'session-tool-call',
          type: 'function',
          function: { name: 'session_probe', arguments: '{}' },
        },
      ],
    });
    const resultMessage = makeMessage({
      role: 'tool',
      type: 'tool_result',
      content: 'exact persisted agent projection',
      tool_call_id: 'session-tool-call',
      tool_result: canonical,
    });
    const session = makeSession({
      id: sessionId,
      chains: [makeChain(sessionId, { messages: [callMessage, resultMessage] })],
    });

    saveSession(session, storageOpts);

    const loaded = loadSession(sessionId, storageOpts)!;
    const restored = loaded.chains[0].messages[1];
    expect(restored.content).toBe('exact persisted agent projection');
    expect(JSON.stringify(restored.tool_result)).toBe(JSON.stringify(canonical));
  });

  it('save then load produces identical session', () => {
    const session = makeSession({
      id: 'a1111111-1111-4111-8111-111111111111',
      name: 'Round Trip Test',
      selection: ANTHROPIC_SELECTION,
      modelLabel: ANTHROPIC_SELECTION.modelId,
    });

    saveSession(session, storageOpts);
    const loaded = loadSession('a1111111-1111-4111-8111-111111111111', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('a1111111-1111-4111-8111-111111111111');
    expect(loaded!.name).toBe('Round Trip Test');
    expect(loaded!.selection).toEqual(ANTHROPIC_SELECTION);
    expect(loaded!.modelLabel).toBe(ANTHROPIC_SELECTION.modelId);
    expect(loaded!.chains).toEqual([]);
    expect(loaded!.activeChainId).toBeNull();
    expect(loaded!.subagentChains).toEqual([]);
    expect(loaded!.todoStore).toEqual({ tasks: [] });
  });

  it('save then load preserves chains and messages', () => {
    const now = new Date().toISOString();
    const session = makeSession({
      id: 'a2222222-2222-4222-8222-222222222222',
      name: 'With Chains',
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
      chains: [
        {
          id: 'chain-1',
          sessionId: 'a2222222-2222-4222-8222-222222222222',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'Hello',
              type: 'text',
              tool_calls: null,
              tool_call_id: null,
              name: null,
              thinking: null,
              timestamp: now,
              usage: null,
              hidden: false,
              tool_result: null,
            },
            {
              id: 'msg-2',
              role: 'assistant',
              content: 'Hi there!',
              type: 'text',
              tool_calls: null,
              tool_call_id: null,
              name: null,
              thinking: null,
              timestamp: now,
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                cached_tokens: 0,
              },
              hidden: false,
              tool_result: null,
            },
          ],
          status: 'completed',
          selection: DEFAULT_SELECTION,
          modelLabel: DEFAULT_SELECTION.modelId,
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
        },
      ],
      activeChainId: 'chain-1',
    });

    saveSession(session, storageOpts);
    const loaded = loadSession('a2222222-2222-4222-8222-222222222222', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.chains).toHaveLength(1);
    expect(loaded!.chains[0].id).toBe('chain-1');
    expect(loaded!.chains[0].messages).toHaveLength(2);
    expect(loaded!.chains[0].messages[0].role).toBe('user');
    expect(loaded!.chains[0].messages[0].content).toBe('Hello');
    expect(loaded!.chains[0].messages[1].role).toBe('assistant');
    expect(loaded!.chains[0].messages[1].content).toBe('Hi there!');
    expect(loaded!.chains[0].messages[1].usage!.prompt_tokens).toBe(10);
    expect(loaded!.activeChainId).toBe('chain-1');
  });

  it('load returns null for non-existent session', () => {
    const loaded = loadSession(randomUUID(), storageOpts);
    expect(loaded).toBeNull();
  });

  it('load returns null for invalid session ID', () => {
    expect(loadSession('not-a-uuid', storageOpts)).toBeNull();
    expect(loadSession('', storageOpts)).toBeNull();
  });

  it('durably interrupts active chains once on restart and clears their active pointer', () => {
    const sessionId = 'a2929292-2929-4292-8292-292929292929';
    const first = makeChain(sessionId, { id: 'recovery-first', status: ChainStatus.ACTIVE });
    const second = makeChain(sessionId, { id: 'recovery-second', status: ChainStatus.ACTIVE });
    saveSession(
      makeSession({
        id: sessionId,
        chains: [first, second],
        activeChainId: second.id,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      storageOpts,
    );

    const firstLoad = loadSession(sessionId, storageOpts)!;
    const recoveredAt = firstLoad.chains[0]!.endTime;
    expect(firstLoad.activeChainId).toBeNull();
    expect(firstLoad.updatedAt).toBe(recoveredAt);
    expect(firstLoad.chains.map((chain) => chain.status)).toEqual([
      ChainStatus.INTERRUPTED,
      ChainStatus.INTERRUPTED,
    ]);
    expect(firstLoad.chains.map((chain) => chain.endTime)).toEqual([recoveredAt, recoveredAt]);

    const db = openSqliteDb(storageOpts.dbPath!);
    const persistedAfterFirstLoad = db.prepare(`
      SELECT s.active_chain_id, s.updated_at, c.status, c.end_time
      FROM sessions s
      JOIN chains c ON c.session_id = s.id
      WHERE s.id = ?
      ORDER BY c.ordinal
    `).all(sessionId) as Array<{
      active_chain_id: string | null;
      updated_at: string;
      status: string;
      end_time: string | null;
    }>;
    db.close();
    expect(persistedAfterFirstLoad).toEqual([
      {
        active_chain_id: null,
        updated_at: recoveredAt,
        status: ChainStatus.INTERRUPTED,
        end_time: recoveredAt,
      },
      {
        active_chain_id: null,
        updated_at: recoveredAt,
        status: ChainStatus.INTERRUPTED,
        end_time: recoveredAt,
      },
    ]);

    _clearDbCache();
    const secondLoad = loadSession(sessionId, storageOpts)!;
    expect(secondLoad.activeChainId).toBeNull();
    expect(secondLoad.updatedAt).toBe(recoveredAt);
    expect(secondLoad.chains.map((chain) => chain.status)).toEqual([
      ChainStatus.INTERRUPTED,
      ChainStatus.INTERRUPTED,
    ]);
    expect(secondLoad.chains.map((chain) => chain.endTime)).toEqual([recoveredAt, recoveredAt]);
  });

  it('save overwrites existing session', () => {
    const session1 = makeSession({
      id: 'a3333333-3333-4333-8333-333333333333',
      name: 'Original Name',
    });
    saveSession(session1, storageOpts);

    const session2 = makeSession({
      id: 'a3333333-3333-4333-8333-333333333333',
      name: 'Updated Name',
      selection: NEW_SELECTION,
      modelLabel: NEW_SELECTION.modelId,
    });
    saveSession(session2, storageOpts);

    const loaded = loadSession('a3333333-3333-4333-8333-333333333333', storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Updated Name');
    expect(loaded!.selection).toEqual(NEW_SELECTION);
    expect(loaded!.modelLabel).toBe('new-model');
  });

  it('save preserves todoStore data', () => {
    const now = new Date().toISOString();
    const session = makeSession({
      id: 'a4444444-4444-4444-8444-444444444444',
      todoStore: {
        tasks: [
          {
            id: 'task-1',
            title: 'Implement feature',
            status: 'IN_PROGRESS',
            subagent_id: null,
            created_at: now,
            updated_at: now,
          },
        ],
      },
    });

    saveSession(session, storageOpts);
    const loaded = loadSession('a4444444-4444-4444-8444-444444444444', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.todoStore.tasks).toHaveLength(1);
    expect(loaded!.todoStore.tasks[0].id).toBe('task-1');
    expect(loaded!.todoStore.tasks[0].title).toBe('Implement feature');
    expect(loaded!.todoStore.tasks[0].status).toBe('IN_PROGRESS');
  });

  it('round-trips session with null selection, cwd, and modelLabel', () => {
    const now = new Date().toISOString();
    const session: Session = {
      id: 'a5555555-5555-4555-8555-555555555555',
      name: 'Null Fields',
      selection: null,
      modelLabel: null,
      cwd: null,
      chains: [],
      activeChainId: null,
      createdAt: now,
      updatedAt: now,
      subagentChains: [],
      todoStore: { tasks: [] },
    };

    saveSession(session, storageOpts);
    const loaded = loadSession('a5555555-5555-4555-8555-555555555555', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.selection).toBeNull();
    expect(loaded!.modelLabel).toBeNull();
    expect(loaded!.cwd).toBeNull();
  });

  it('round-trips session with subagentChains and todoStore', () => {
    const sessionId = 'a6666666-6666-4666-8666-666666666666';
    const now = new Date().toISOString();
    const record = makeSubagentRecord(sessionId, {
      id: 'sub-rt',
      agent_name: 'tester',
      task: 'run tests',
      status: SubagentStatus.COMPLETED,
      result: 'all passed',
    });
    const session = makeSession({
      id: sessionId,
      subagentChains: [record],
      todoStore: {
        tasks: [
          {
            id: 'todo-rt',
            title: 'RT task',
            status: 'OPEN',
            subagent_id: null,
            created_at: now,
            updated_at: now,
          },
        ],
      },
    });

    saveSession(session, storageOpts);
    const loaded = loadSession(sessionId, storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.subagentChains).toHaveLength(1);
    expect(loaded!.subagentChains[0].id).toBe('sub-rt');
    expect(loaded!.subagentChains[0].agent_name).toBe('tester');
    expect(loaded!.subagentChains[0].result).toBe('all passed');
    expect(loaded!.todoStore.tasks).toHaveLength(1);
    expect(loaded!.todoStore.tasks[0].title).toBe('RT task');
  });

  it('round-trips typed selection whose model ID contains slashes', () => {
    const sessionId = 'a7777777-7777-4777-8777-777777777777';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    const session = makeSession({
      id: sessionId,
      selection,
      modelLabel: 'Vendor Path Model',
      chains: [
        makeChain(sessionId, {
          selection,
          modelLabel: 'Vendor Path Model',
        }),
      ],
    });

    saveSession(session, storageOpts);
    const loaded = loadSession(sessionId, storageOpts)!;
    expect(loaded.selection).toEqual(selection);
    expect(loaded.modelLabel).toBe('Vendor Path Model');
    expect(loaded.chains[0].selection).toEqual(selection);
    expect(loaded.chains[0].modelLabel).toBe('Vendor Path Model');
  });
});

// ===========================================================================
// List — multiple sessions → updatedAt order (newest first)
// ===========================================================================

describe('listSavedSessions', () => {
  it('returns empty array when no sessions exist', () => {
    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toEqual([]);
  });

  it('lists a single session', () => {
    const session = makeSession({
      id: 'a8888888-8888-4888-8888-888888888888',
      name: 'List Test',
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
    });
    saveSession(session, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('a8888888-8888-4888-8888-888888888888');
    expect(sessions[0].name).toBe('List Test');
    expect(sessions[0].modelLabel).toBe('gpt-4o');
  });

  it('lists multiple sessions sorted by updatedAt (newest first)', () => {
    const session1 = makeSession({
      id: 'a9999999-9999-4999-8999-999999999999',
      name: 'Old Session',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const session2 = makeSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'New Session',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const session3 = makeSession({
      id: 'abababab-abab-4bab-8bab-abababababab',
      name: 'Newest Session',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    saveSession(session1, storageOpts);
    saveSession(session2, storageOpts);
    saveSession(session3, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(3);
    expect(sessions[0].id).toBe('abababab-abab-4bab-8bab-abababababab');
    expect(sessions[1].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(sessions[2].id).toBe('a9999999-9999-4999-8999-999999999999');
  });

  it('includes chain count in summary', () => {
    const session = makeSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      chains: [
        makeChain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { id: 'chain-1' }),
        makeChain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { id: 'chain-2' }),
      ],
    });
    saveSession(session, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].chainCount).toBe(2);
  });

  it('reports chainCount 0 for a session with no chains', () => {
    const session = makeSession({
      id: 'bcbc0000-0000-4000-8000-000000000000',
      chains: [],
    });
    saveSession(session, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].chainCount).toBe(0);
  });

  it('includes cwd in summary', () => {
    const projectDir = path.join(tmpDir, 'project-list');
    fs.mkdirSync(projectDir, { recursive: true });
    const canonical = fs.realpathSync(projectDir);

    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION, { cwd: projectDir });

    const summaries = listSavedSessions(storageOpts);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(session.id);
    expect(summaries[0].cwd).toBe(canonical);
  });
});

// ===========================================================================
// Delete — removes session, cleans caches
// ===========================================================================

describe('deleteSession', () => {
  it('deletes session and returns true', () => {
    const session = makeSession({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    saveSession(session, storageOpts);

    expect(loadSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd', storageOpts)).not.toBeNull();

    const result = deleteSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd', storageOpts);
    expect(result).toBe(true);
    expect(loadSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd', storageOpts)).toBeNull();
  });

  it('returns false for non-existent session', () => {
    const result = deleteSession(randomUUID(), storageOpts);
    expect(result).toBe(false);
  });

  it('cleans up tool-output cache directory', () => {
    const session = makeSession({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    saveSession(session, storageOpts);

    const toolOutputDir = path.join(
      tmpDir,
      'cache',
      'tool-output',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );
    fs.mkdirSync(toolOutputDir, { recursive: true });
    fs.writeFileSync(path.join(toolOutputDir, 'output.txt'), 'cached output');

    expect(fs.existsSync(toolOutputDir)).toBe(true);

    deleteSession('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', storageOpts);

    expect(fs.existsSync(toolOutputDir)).toBe(false);
  });

  it('cleans up web-fetch cache directory', () => {
    const session = makeSession({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    saveSession(session, storageOpts);

    const webFetchDir = path.join(
      tmpDir,
      'cache',
      'web-fetch',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    fs.mkdirSync(webFetchDir, { recursive: true });
    fs.writeFileSync(path.join(webFetchDir, 'page.md'), 'cached page');

    expect(fs.existsSync(webFetchDir)).toBe(true);

    deleteSession('ffffffff-ffff-4fff-8fff-ffffffffffff', storageOpts);

    expect(fs.existsSync(webFetchDir)).toBe(false);
  });

  it('cleans up both caches simultaneously', () => {
    const session = makeSession({ id: 'a1111111-1111-4111-8111-111111111112' });
    saveSession(session, storageOpts);

    const toolOutputDir = path.join(
      tmpDir,
      'cache',
      'tool-output',
      'a1111111-1111-4111-8111-111111111112',
    );
    const webFetchDir = path.join(
      tmpDir,
      'cache',
      'web-fetch',
      'a1111111-1111-4111-8111-111111111112',
    );
    fs.mkdirSync(toolOutputDir, { recursive: true });
    fs.mkdirSync(webFetchDir, { recursive: true });
    fs.writeFileSync(path.join(toolOutputDir, 'output.txt'), 'data');
    fs.writeFileSync(path.join(webFetchDir, 'page.md'), 'data');

    deleteSession('a1111111-1111-4111-8111-111111111112', storageOpts);

    expect(fs.existsSync(toolOutputDir)).toBe(false);
    expect(fs.existsSync(webFetchDir)).toBe(false);
  });
});

// ===========================================================================
// Path traversal / invalid ID rejection
// ===========================================================================

describe('path traversal rejection', () => {
  it('isValidSessionId rejects path traversal sequences', () => {
    expect(isValidSessionId('../../etc/passwd')).toBe(false);
    expect(isValidSessionId('../steal-data')).toBe(false);
    expect(isValidSessionId('foo/bar')).toBe(false);
    expect(isValidSessionId('foo\\bar')).toBe(false);
    expect(isValidSessionId('..')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('not-a-uuid')).toBe(false);
  });

  it('isValidSessionId accepts valid UUIDs', () => {
    expect(isValidSessionId('a1111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isValidSessionId(randomUUID())).toBe(true);
  });

  it('loadSession returns null for path traversal IDs', () => {
    expect(loadSession('../../etc/passwd', storageOpts)).toBeNull();
    expect(loadSession('foo/bar', storageOpts)).toBeNull();
    expect(loadSession('foo\\bar', storageOpts)).toBeNull();
  });

  it('deleteSession returns false for path traversal IDs', () => {
    expect(deleteSession('../../etc/passwd', storageOpts)).toBe(false);
    expect(deleteSession('foo/bar', storageOpts)).toBe(false);
    expect(deleteSession('foo\\bar', storageOpts)).toBe(false);
  });

  it('saveSession throws for path traversal IDs', () => {
    const session = makeSession({ id: '../../etc/passwd' });
    expect(() => saveSession(session, storageOpts)).toThrow(/unsafe ID/);
  });
});

// ===========================================================================
// Session cwd — create / load / list / changeCwd
// ===========================================================================

describe('session cwd persistence', () => {
  it('create with cwd → load restores it', () => {
    const projectDir = path.join(tmpDir, 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });

    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION, { cwd: projectDir });

    expect(session.cwd).toBe(fs.realpathSync(projectDir));

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.cwd).toBe(session.cwd);
  });

  it('create without cwd yields null', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    expect(session.cwd).toBeNull();

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.cwd).toBeNull();
  });

  it('changeCwd persists and is visible on reload', () => {
    const projectDir = path.join(tmpDir, 'project-change');
    fs.mkdirSync(projectDir, { recursive: true });
    const canonical = fs.realpathSync(projectDir);

    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    expect(session.cwd).toBeNull();

    const updated = manager.changeCwd(session.id, projectDir);
    expect(updated.cwd).toBe(canonical);
    expect(manager.getActive()!.cwd).toBe(canonical);

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.cwd).toBe(canonical);

    const summaries = listSavedSessions(storageOpts);
    expect(summaries[0].cwd).toBe(canonical);
  });

  it('changeCwd rejects missing path without corrupting prior cwd', () => {
    const projectDir = path.join(tmpDir, 'project-keep');
    fs.mkdirSync(projectDir, { recursive: true });
    const canonical = fs.realpathSync(projectDir);

    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION, { cwd: projectDir });
    expect(session.cwd).toBe(canonical);

    const missing = path.join(tmpDir, 'does-not-exist');
    expect(() => manager.changeCwd(session.id, missing)).toThrow(/Cannot change cwd/);

    expect(manager.getActive()!.cwd).toBe(canonical);
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.cwd).toBe(canonical);
  });

  it('changeCwd rejects relative paths', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    expect(() => manager.changeCwd(session.id, 'relative/path')).toThrow(/Cannot change cwd/);
    expect(manager.getActive()!.cwd).toBeNull();
  });

  it('changeCwd rejects non-active session', () => {
    const projectDir = path.join(tmpDir, 'project-other');
    fs.mkdirSync(projectDir, { recursive: true });

    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.create(DEFAULT_SELECTION);

    expect(() => manager.changeCwd(session1.id, projectDir)).toThrow(/not active/);
  });
});

// ===========================================================================
// SessionManager — create, switch, delete, rename, changeModel
// ===========================================================================

describe('SessionManager', () => {
  it('create() produces a session with UUID and default name', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    expect(session.id).toBeTruthy();
    expect(session.selection).toEqual(DEFAULT_SELECTION);
    expect(session.modelLabel).toBe('gpt-4o');
    expect(session.name.startsWith('Session ')).toBe(true);
    expect(session.chains).toEqual([]);
    expect(session.activeChainId).toBeNull();
    expect(session.cwd).toBeNull();

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
  });

  it('create() sets the session as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    expect(manager.getActive()).toBeNull();

    const session = manager.create(DEFAULT_SELECTION);
    expect(manager.getActive()).not.toBeNull();
    expect(manager.getActive()!.id).toBe(session.id);
  });

  it('clearActive() drops active without deleting the session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    expect(manager.getActive()!.id).toBe(session.id);

    manager.clearActive();
    expect(manager.getActive()).toBeNull();

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
  });

  it('switchTo() loads session and sets as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    const session2 = manager.create(ANTHROPIC_SELECTION);

    expect(manager.getActive()!.id).toBe(session2.id);

    const switched = manager.switchTo(session1.id);
    expect(switched).not.toBeNull();
    expect(switched!.id).toBe(session1.id);
    expect(manager.getActive()!.id).toBe(session1.id);
  });

  it('switchTo() returns null for non-existent session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const result = manager.switchTo(randomUUID());
    expect(result).toBeNull();
    expect(manager.getActive()).toBeNull();
  });

  it('delete() removes session and clears active if it was active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const sessionId = session.id;

    expect(manager.getActive()!.id).toBe(sessionId);

    const result = manager.delete(sessionId);
    expect(result).toBe(true);
    expect(manager.getActive()).toBeNull();

    expect(loadSession(sessionId, storageOpts)).toBeNull();
  });

  it('delete() does not clear active if deleting a different session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    const session2 = manager.create(ANTHROPIC_SELECTION);

    manager.delete(session1.id);

    expect(manager.getActive()!.id).toBe(session2.id);
  });

  it('notifies session-scoped cleanup when a session is deleted', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const deleted: string[] = [];
    const unsubscribe = onSessionDeleted((sessionId) => deleted.push(sessionId));

    try {
      expect(manager.delete(session.id)).toBe(true);
      expect(deleted).toEqual([session.id]);
    } finally {
      unsubscribe();
    }
  });

  it('rename() updates active session name', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.rename(session.id, 'New Name');

    expect(manager.getActive()!.name).toBe('New Name');

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('New Name');
  });

  it('rename() is no-op for non-active session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.create(ANTHROPIC_SELECTION);

    manager.rename(session1.id, 'Should Not Change');

    const loaded = loadSession(session1.id, storageOpts);
    expect(loaded!.name).not.toBe('Should Not Change');
  });

  it('changeModel() updates active session model', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.changeModel(session.id, ANTHROPIC_SELECTION);

    expect(manager.getActive()!.selection).toEqual(ANTHROPIC_SELECTION);
    expect(manager.getActive()!.modelLabel).toBe('anthropic/claude-3.5-sonnet');

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.selection).toEqual(ANTHROPIC_SELECTION);
    expect(loaded!.modelLabel).toBe('anthropic/claude-3.5-sonnet');
  });

  it('load() loads session without setting as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const session2 = manager.create(ANTHROPIC_SELECTION);

    const loaded = manager.load(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);

    expect(manager.getActive()!.id).toBe(session2.id);
  });

  it('listSaved() returns sessions sorted by updatedAt', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);

    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy wait
    }

    const session2 = manager.create(ANTHROPIC_SELECTION);

    const sessions = manager.listSaved();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(session2.id);
    expect(sessions[1].id).toBe(session1.id);
  });
});

// ===========================================================================
// Auto-naming
// ===========================================================================

describe('SessionManager auto-naming', () => {
  it('autoNameActive() generates title for default-named session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'My Coding Session',
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);

    expect(session.name.startsWith('Session ')).toBe(true);

    const result = await manager.autoNameActive();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('My Coding Session');

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('My Coding Session');
  });

  it('autoNameActive() skips if name does not start with "Session "', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Should Not Apply',
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);

    manager.rename(session.id, 'Custom Name');

    const result = await manager.autoNameActive();
    expect(result!.name).toBe('Custom Name');
  });

  it('autoNameActive() skips if no generateTitle callback', async () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);

    const result = await manager.autoNameActive();
    expect(result!.name.startsWith('Session ')).toBe(true);
  });

  it('autoNameActive() returns null if no active session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Title',
      storage: storageOpts,
    });
    const result = await manager.autoNameActive();
    expect(result).toBeNull();
  });

  it('autoNameActive() keeps default name if callback returns null', async () => {
    const manager = new SessionManager({
      generateTitle: async () => null,
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });

  it('autoNameActive() keeps default name if callback returns too-long title', async () => {
    const longTitle = 'A'.repeat(100);
    const manager = new SessionManager({
      generateTitle: async () => longTitle,
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });

  it('autoNameActive() handles callback errors gracefully', async () => {
    const manager = new SessionManager({
      generateTitle: async () => {
        throw new Error('LLM unavailable');
      },
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);
    const originalName = session.name;

    const result = await manager.autoNameActive();
    expect(result!.name).toBe(originalName);
  });

  it('autoNameActive() callback receives the session', async () => {
    let receivedSession: Session | null = null;
    const manager = new SessionManager({
      generateTitle: async (s) => {
        receivedSession = s;
        return 'Generated Title';
      },
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);

    await manager.autoNameActive();

    expect(receivedSession).not.toBeNull();
    expect(receivedSession!.id).toBe(session.id);
  });
});

// ===========================================================================
// Session switching
// ===========================================================================

describe('SessionManager switching', () => {
  it('switchTo does not cancel running subagents (by design)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.create(ANTHROPIC_SELECTION);

    const switched = manager.switchTo(session1.id);
    expect(switched).not.toBeNull();
    expect(switched!.id).toBe(session1.id);
  });

  it('multiple switches preserve session data', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.rename(session1.id, 'Session 1');

    const session2 = manager.create(ANTHROPIC_SELECTION);
    manager.rename(session2.id, 'Session 2');

    manager.switchTo(session1.id);
    expect(manager.getActive()!.name).toBe('Session 1');

    manager.switchTo(session2.id);
    expect(manager.getActive()!.name).toBe('Session 2');

    manager.switchTo(session1.id);
    expect(manager.getActive()!.name).toBe('Session 1');
  });

  it('switchTo preserves the live in-memory session over stale disk state', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    const modified: Session = {
      ...session,
      name: 'Externally Modified',
      updatedAt: new Date().toISOString(),
    };
    saveSession(modified, storageOpts);

    manager.getTodoStore(session.id).create('Live todo');

    const switched = manager.switchTo(session.id);
    expect(switched!.name).toBe(session.name);
    expect(manager.getTodoStore(session.id).list()[0]?.title).toBe('Live todo');
  });
});

// ===========================================================================
// Concurrent window/session ownership
// ===========================================================================

describe('SessionManager concurrent owners', () => {
  it('keeps a distinct selected session for each window owner', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const sessionA = manager.create(DEFAULT_SELECTION, undefined, 'window-a');
    const sessionB = manager.create(ANTHROPIC_SELECTION, undefined, 'window-b');

    expect(manager.getActive('window-a')?.id).toBe(sessionA.id);
    expect(manager.getActive('window-b')?.id).toBe(sessionB.id);

    manager.clearActive('window-a');
    expect(manager.getActive('window-a')).toBeNull();
    expect(manager.getActive('window-b')?.id).toBe(sessionB.id);
  });

  it('writes chains to the explicitly addressed session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const sessionA = manager.create(DEFAULT_SELECTION, undefined, 'window-a');
    const sessionB = manager.create(DEFAULT_SELECTION, undefined, 'window-b');

    const userA = makeMessage({ id: 'owner-a-user', content: 'Question A' });
    const answerA = makeMessage({
      id: 'owner-a-answer',
      role: 'assistant',
      content: 'Answer A',
    });
    manager.startChain({ messages: [userA] }, sessionA.id);
    manager.persistTurn({ messages: [userA, answerA], status: ChainStatus.COMPLETED }, sessionA.id);

    expect(manager.getSession(sessionA.id)?.chains).toHaveLength(1);
    expect(manager.getSession(sessionA.id)?.chains[0]?.messages).toEqual([userA, answerA]);
    expect(manager.getSession(sessionB.id)?.chains).toHaveLength(0);
  });

  it('keeps todo stores isolated by session and persists the addressed store', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const sessionA = manager.create(DEFAULT_SELECTION, undefined, 'window-a');
    const sessionB = manager.create(DEFAULT_SELECTION, undefined, 'window-b');

    manager.getTodoStore(sessionA.id).create('A only');
    manager.getTodoStore(sessionB.id).create('B only');
    manager.persistTodos(sessionA.id);
    manager.persistTodos(sessionB.id);

    expect(
      manager
        .getTodoStore(sessionA.id)
        .list()
        .map((todo) => todo.title),
    ).toEqual(['A only']);
    expect(
      manager
        .getTodoStore(sessionB.id)
        .list()
        .map((todo) => todo.title),
    ).toEqual(['B only']);
    expect(loadSession(sessionA.id, storageOpts)?.todoStore.tasks[0]?.title).toBe('A only');
    expect(loadSession(sessionB.id, storageOpts)?.todoStore.tasks[0]?.title).toBe('B only');
  });

  it('shares one in-memory runtime when two windows select the same session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION, undefined, 'window-a');

    manager.switchTo(session.id, 'window-b');
    const fromA = manager.getTodoStore(session.id);
    const fromB = manager.getTodoStore(session.id);

    expect(fromB).toBe(fromA);
    fromA.create('Shared update');
    expect(fromB.list().map((todo) => todo.title)).toEqual(['Shared update']);
  });

  it('clears every owner selecting a deleted session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION, undefined, 'window-a');
    manager.switchTo(session.id, 'window-b');

    manager.delete(session.id);

    expect(manager.getActive('window-a')).toBeNull();
    expect(manager.getActive('window-b')).toBeNull();
  });
});

// ===========================================================================
// Multi-chain lifecycle — startChain / update / finish / persistTurn
// ===========================================================================

describe('SessionManager multi-chain lifecycle', () => {
  it('returns null from startChain / persistTurn when no active session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    expect(manager.startChain()).toBeNull();
    expect(manager.persistTurn({ messages: [makeMessage({ content: 'orphan' })] })).toBeNull();
  });

  it('startChain appends an ACTIVE chain and sets activeChainId', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const user = makeMessage({ id: 'u1', role: 'user', content: 'Hello' });
    const chain = manager.startChain({
      messages: [user],
      agentName: 'general',
    });

    expect(chain).not.toBeNull();
    expect(chain!.status).toBe(ChainStatus.ACTIVE);
    expect(chain!.messages).toHaveLength(1);
    expect(chain!.startTime).toBeTruthy();
    expect(chain!.endTime).toBeNull();
    const active = manager.getActive()!;
    expect(active.chains).toHaveLength(1);
    expect(active.activeChainId).toBe(chain!.id);
    expect(active.chains[0].sessionId).toBe(session.id);
  });

  it('N user turns → N chains with turn-local messages only', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);

    for (let i = 1; i <= 3; i++) {
      manager.startChain({
        messages: [makeMessage({ id: `u${i}`, role: 'user', content: `Q${i}` })],
      });
      manager.persistTurn({
        messages: [
          makeMessage({ id: `u${i}`, role: 'user', content: `Q${i}` }),
          makeMessage({ id: `a${i}`, role: 'assistant', content: `A${i}` }),
        ],
        status: ChainStatus.COMPLETED,
      });
    }

    const session = manager.getActive()!;
    expect(session.chains).toHaveLength(3);
    expect(session.activeChainId).toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(session.chains[i].messages).toHaveLength(2);
      expect(session.chains[i].messages[0].content).toBe(`Q${i + 1}`);
      expect(session.chains[i].messages[1].content).toBe(`A${i + 1}`);
      expect(session.chains[i].status).toBe(ChainStatus.COMPLETED);
      expect(session.chains[i].endTime).toBeTruthy();
    }

    const flat = session.chains.flatMap((c) => c.messages);
    expect(flat).toHaveLength(6);
  });

  it('updateActiveChainMessages writes turn-local only (not full history)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);
    manager.startChain({
      messages: [makeMessage({ content: 'turn1 user' })],
    });
    manager.persistTurn({
      messages: [
        makeMessage({ content: 'turn1 user' }),
        makeMessage({ role: 'assistant', content: 'turn1 asst' }),
      ],
    });

    manager.startChain({
      messages: [makeMessage({ content: 'turn2 user' })],
    });
    const mid = manager.updateActiveChainMessages([
      makeMessage({ content: 'turn2 user' }),
      makeMessage({ role: 'assistant', content: 'partial' }),
    ]);
    expect(mid!.chains).toHaveLength(2);
    expect(mid!.chains[0].messages).toHaveLength(2);
    expect(mid!.chains[1].messages).toHaveLength(2);
    expect(mid!.chains[1].messages[1].content).toBe('partial');
    expect(mid!.chains[1].status).toBe(ChainStatus.ACTIVE);
    expect(mid!.activeChainId).toBe(mid!.chains[1].id);
  });

  it('finishActiveChain freezes status and clears activeChainId', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);
    manager.startChain({ messages: [makeMessage({ content: 'x' })] });
    const finished = manager.finishActiveChain(ChainStatus.INTERRUPTED);
    expect(finished!.chains[0].status).toBe(ChainStatus.INTERRUPTED);
    expect(finished!.chains[0].endTime).toBeTruthy();
    expect(finished!.activeChainId).toBeNull();
  });

  it('startChain freezes a leftover ACTIVE chain as INTERRUPTED', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);
    const first = manager.startChain({
      messages: [makeMessage({ content: 'stuck' })],
    })!;
    const second = manager.startChain({
      messages: [makeMessage({ content: 'next' })],
    })!;
    const session = manager.getActive()!;
    expect(session.chains).toHaveLength(2);
    expect(session.chains[0].id).toBe(first.id);
    expect(session.chains[0].status).toBe(ChainStatus.INTERRUPTED);
    expect(session.chains[1].id).toBe(second.id);
    expect(session.chains[1].status).toBe(ChainStatus.ACTIVE);
  });

  it('persistTurn without prior startChain creates and freezes one chain', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const messages = [
      makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
      makeMessage({ id: 'a1', role: 'assistant', content: 'Hi' }),
    ];
    const result = manager.persistTurn({ messages });

    expect(result!.chains).toHaveLength(1);
    const chain = result!.chains[0];
    expect(chain.messages).toHaveLength(2);
    expect(chain.status).toBe(ChainStatus.COMPLETED);
    expect(chain.selection).toEqual(DEFAULT_SELECTION);
    expect(chain.modelLabel).toBe('gpt-4o');
    expect(chain.agentName).toBe('general');
    expect(result!.activeChainId).toBeNull();
    expect(chain.sessionId).toBe(session.id);
  });

  it('updates ACTIVE chain messages and agent metadata via persistTurn', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);
    manager.startChain({
      selection: OLD_SELECTION,
      modelLabel: OLD_SELECTION.modelId,
      agentName: 'General',
      agentType: 'internal',
      agentTier: 'bloom',
      messages: [makeMessage({ content: 'old' })],
    });

    const result = manager.persistTurn({
      messages: [
        makeMessage({ content: 'Updated' }),
        makeMessage({ role: 'assistant', content: 'Reply' }),
      ],
      status: ChainStatus.COMPLETED,
      agentName: 'coder',
    });

    expect(result!.chains).toHaveLength(1);
    expect(result!.chains[0].messages[0].content).toBe('Updated');
    expect(result!.chains[0].status).toBe(ChainStatus.COMPLETED);
    expect(result!.chains[0].selection).toEqual(OLD_SELECTION);
    expect(result!.chains[0].modelLabel).toBe('old-model');
    expect(result!.chains[0].agentName).toBe('coder');
    expect(result!.chains[0].agentType).toBe('internal');
    expect(result!.activeChainId).toBeNull();
  });

  it('applies INTERRUPTED and FAILED terminal statuses', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);

    const interrupted = manager.persistTurn({
      messages: [makeMessage({ content: 'stop' })],
      status: ChainStatus.INTERRUPTED,
    });
    expect(interrupted!.chains[0].status).toBe(ChainStatus.INTERRUPTED);

    const failed = manager.persistTurn({
      messages: [makeMessage({ content: 'boom' })],
      status: ChainStatus.FAILED,
    });
    expect(failed!.chains).toHaveLength(2);
    expect(failed!.chains[1].status).toBe(ChainStatus.FAILED);
  });

  it('selection fallback: params.selection → existing.selection → session.selection', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(SESSION_SELECTION);

    const created = manager.persistTurn({
      messages: [makeMessage({ content: 'a' })],
    });
    expect(created!.chains[0].selection).toEqual(SESSION_SELECTION);
    expect(created!.chains[0].modelLabel).toBe('session-model');

    manager.startChain({ selection: SESSION_SELECTION, modelLabel: 'session-model' });
    const withParam = manager.persistTurn({
      messages: [makeMessage({ content: 'b' })],
      selection: PARAM_SELECTION,
      modelLabel: PARAM_SELECTION.modelId,
    });
    expect(withParam!.chains[1].selection).toEqual(PARAM_SELECTION);
    expect(withParam!.chains[1].modelLabel).toBe('param-model');
  });

  it('persists multi-chain to disk and reloads', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.startChain();
    manager.persistTurn({
      messages: [
        makeMessage({ id: 'persist-u', role: 'user', content: 'persist me' }),
        makeMessage({
          id: 'persist-a',
          role: 'assistant',
          content: 'persisted',
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
            cached_tokens: 0,
          },
        }),
      ],
      status: ChainStatus.COMPLETED,
      selection: DEFAULT_SELECTION,
      modelLabel: DEFAULT_SELECTION.modelId,
      agentName: 'general',
      agentType: 'internal',
      agentTier: 'bloom',
    });
    manager.startChain();
    manager.persistTurn({
      messages: [
        makeMessage({ id: 'u2', role: 'user', content: 'second' }),
        makeMessage({ id: 'a2', role: 'assistant', content: 'ok' }),
      ],
    });

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.chains).toHaveLength(2);
    expect(loaded!.activeChainId).toBeNull();
    expect(loaded!.chains[0].messages[0].content).toBe('persist me');
    expect(loaded!.chains[0].messages[1].usage!.total_tokens).toBe(5);
    expect(loaded!.chains[0].status).toBe(ChainStatus.COMPLETED);
    expect(loaded!.chains[1].messages[0].content).toBe('second');
    expect(loaded!.chains[0].startTime).toBeTruthy();
    expect(loaded!.chains[0].endTime).toBeTruthy();
  });

  it('copies messages array (does not retain caller reference)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);
    const messages = [makeMessage({ content: 'mutable' })];

    const result = manager.persistTurn({ messages });
    (messages as Message[]).push(makeMessage({ content: 'extra' }));

    expect(result!.chains[0].messages).toHaveLength(1);
    expect(result!.chains[0].messages[0].content).toBe('mutable');
  });

  it('updates updatedAt on the session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const before = session.updatedAt;

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    const result = manager.persistTurn({
      messages: [makeMessage({ content: 'tick' })],
    });
    expect(result!.updatedAt >= before).toBe(true);
  });
});

// ===========================================================================
// subagent_chains row storage — one row per record (U6)
// ===========================================================================

function readSubagentRows(
  dbPath: string,
  sessionId: string,
): Array<{ rowid: number; subagent_id: string; record_json: string }> {
  const db = openSqliteDb(dbPath);
  try {
    return db
      .prepare(
        'SELECT rowid, subagent_id, record_json FROM subagent_chains WHERE session_id = ? ORDER BY rowid',
      )
      .all(sessionId) as Array<{ rowid: number; subagent_id: string; record_json: string }>;
  } finally {
    db.close();
  }
}

describe('subagent_chains row storage (U6)', () => {
  const SID = 'aeaeaeae-aeae-4aea-8aea-aeaeaeaeaeae';

  it('round-trips N terminal records through saveSession/loadSession', () => {
    const records = [
      makeSubagentRecord(SID, {
        id: 'sub-completed',
        status: SubagentStatus.COMPLETED,
        result: 'done',
      }),
      makeSubagentRecord(SID, {
        id: 'sub-failed',
        status: SubagentStatus.FAILED,
        result: null,
        error: 'boom',
      }),
      makeSubagentRecord(SID, {
        id: 'sub-interrupted',
        status: SubagentStatus.INTERRUPTED,
      }),
    ];
    saveSession(makeSession({ id: SID, subagentChains: records }), storageOpts);

    expect(readSubagentRows(storageOpts.dbPath!, SID).map((row) => row.subagent_id)).toEqual([
      'sub-completed',
      'sub-failed',
      'sub-interrupted',
    ]);

    const loaded = loadSession(SID, storageOpts)!;
    expect(loaded.subagentChains).toEqual(records);
  });

  it('saveSession wholesale-replaces prior subagent rows (creation/recovery primitive)', () => {
    saveSession(
      makeSession({
        id: SID,
        subagentChains: [
          makeSubagentRecord(SID, { id: 'sub-1' }),
          makeSubagentRecord(SID, { id: 'sub-2' }),
        ],
      }),
      storageOpts,
    );
    expect(readSubagentRows(storageOpts.dbPath!, SID)).toHaveLength(2);

    saveSession(
      makeSession({ id: SID, subagentChains: [makeSubagentRecord(SID, { id: 'sub-3' })] }),
      storageOpts,
    );
    expect(readSubagentRows(storageOpts.dbPath!, SID).map((row) => row.subagent_id)).toEqual([
      'sub-3',
    ]);
  });

  it('upserts only the dirty record; untouched sibling rows keep rowid and bytes', () => {
    const recA = makeSubagentRecord(SID, { id: 'sub-a', result: 'A v1' });
    const recB = makeSubagentRecord(SID, { id: 'sub-b', result: 'B v1' });
    saveSession(
      makeSession({
        id: SID,
        subagentChains: [recA, recB],
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      storageOpts,
    );

    const dbPath = storageOpts.dbPath!;
    const before = readSubagentRows(dbPath, SID);

    // A targeted upsert must never delete subagent rows.
    const db = openSqliteDb(dbPath);
    db.exec(`
      CREATE TRIGGER reject_subagent_row_delete
      BEFORE DELETE ON subagent_chains
      BEGIN
        SELECT RAISE(ABORT, 'subagent row deletion is forbidden');
      END
    `);
    db.close();

    const outcome = upsertSubagentRecords(
      SID,
      [{ ...recA, result: 'A v2' }],
      '2026-02-01T00:00:00.000Z',
      storageOpts,
    );
    expect(outcome).not.toBe(false);
    expect(outcome!.bytes).toBeGreaterThan(0);

    const after = readSubagentRows(dbPath, SID);
    expect(after.map((row) => row.rowid)).toEqual(before.map((row) => row.rowid));
    const bBefore = before.find((row) => row.subagent_id === 'sub-b')!;
    expect(after.find((row) => row.subagent_id === 'sub-b')!.record_json).toBe(bBefore.record_json);
    expect(after.find((row) => row.subagent_id === 'sub-a')!.record_json)
      .not.toBe(before.find((row) => row.subagent_id === 'sub-a')!.record_json);

    const summary = listSavedSessions(storageOpts).find((s) => s.id === SID)!;
    expect(summary.updatedAt).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
  });

  it('reports bytes as UTF-8 byte length, not UTF-16 code units', () => {
    saveSession(makeSession({ id: SID, subagentChains: [] }), storageOpts);

    const record = makeSubagentRecord(SID, {
      id: 'sub-multibyte',
      task: 'コードベースを調べる 🔍',
      result: '見つかりました 🎉',
    });
    const outcome = upsertSubagentRecords(
      SID,
      [record],
      new Date().toISOString(),
      storageOpts,
    );
    expect(outcome).not.toBe(false);

    const row = readSubagentRows(storageOpts.dbPath!, SID)
      .find((r) => r.subagent_id === 'sub-multibyte')!;
    const utf8Bytes = Buffer.byteLength(row.record_json, 'utf8');
    // The fixture embeds CJK + emoji so the two metrics genuinely diverge.
    expect(utf8Bytes).toBeGreaterThan(row.record_json.length);
    expect(outcome!.bytes).toBe(utf8Bytes);
  });

  it('returns false when the session row is missing (caller falls back to full save)', () => {
    const ghost = makeSubagentRecord(SID, { id: 'ghost' });
    expect(
      upsertSubagentRecords(SID, [ghost], new Date().toISOString(), storageOpts),
    ).toBe(false);
  });

  it('re-upserts a row deleted externally (missing-row recovery)', () => {
    const rec = makeSubagentRecord(SID, { id: 'sub-a', result: 'authoritative' });
    saveSession(makeSession({ id: SID, subagentChains: [rec] }), storageOpts);

    const db = openSqliteDb(storageOpts.dbPath!);
    db.prepare('DELETE FROM subagent_chains WHERE session_id = ? AND subagent_id = ?')
      .run(SID, 'sub-a');
    db.close();
    expect(readSubagentRows(storageOpts.dbPath!, SID)).toHaveLength(0);

    expect(
      upsertSubagentRecords(SID, [rec], new Date().toISOString(), storageOpts),
    ).not.toBe(false);

    const rows = readSubagentRows(storageOpts.dbPath!, SID);
    expect(rows).toHaveLength(1);
    expect(rows[0].subagent_id).toBe('sub-a');
  });

  it('skips corrupt subagent rows on load instead of failing the session', () => {
    saveSession(
      makeSession({ id: SID, subagentChains: [makeSubagentRecord(SID, { id: 'good' })] }),
      storageOpts,
    );

    const db = openSqliteDb(storageOpts.dbPath!);
    db.prepare(
      'INSERT INTO subagent_chains (session_id, subagent_id, record_json) VALUES (?, ?, ?)',
    ).run(SID, 'bad', '{not json');
    db.close();
    _clearDbCache();

    const loaded = loadSession(SID, storageOpts)!;
    expect(loaded.subagentChains.map((r) => r.id)).toEqual(['good']);
  });

  it('session deletion removes all its subagent rows', () => {
    saveSession(
      makeSession({
        id: SID,
        subagentChains: [
          makeSubagentRecord(SID, { id: 'sub-1' }),
          makeSubagentRecord(SID, { id: 'sub-2' }),
        ],
      }),
      storageOpts,
    );
    expect(readSubagentRows(storageOpts.dbPath!, SID)).toHaveLength(2);

    expect(deleteSession(SID, storageOpts)).toBe(true);
    expect(readSubagentRows(storageOpts.dbPath!, SID)).toHaveLength(0);
  });

  it('turn boundaries leave subagent rows untouched', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-1', result: 'stable' }),
    ]);

    const dbPath = storageOpts.dbPath!;
    const before = readSubagentRows(dbPath, session.id);
    const db = openSqliteDb(dbPath);
    db.exec(`
      CREATE TRIGGER reject_subagent_row_update
      BEFORE UPDATE ON subagent_chains
      BEGIN
        SELECT RAISE(ABORT, 'subagent row update is forbidden');
      END
    `);
    db.exec(`
      CREATE TRIGGER reject_subagent_row_delete
      BEFORE DELETE ON subagent_chains
      BEGIN
        SELECT RAISE(ABORT, 'subagent row deletion is forbidden');
      END
    `);
    db.close();

    expect(() => {
      manager.startChain({
        messages: [makeMessage({ id: 'u1', content: 'Question 1' })],
      }, session.id);
      manager.persistTurn({
        messages: [
          makeMessage({ id: 'u1', content: 'Question 1' }),
          makeMessage({ id: 'a1', role: 'assistant', content: 'Answer 1' }),
        ],
      }, session.id);
      manager.rename(session.id, 'Turn boundary session');
    }).not.toThrow();

    expect(readSubagentRows(dbPath, session.id)).toEqual(before);
  });
});

// ===========================================================================
// syncSubagentRecords — targeted dirty-record upsert + persist (U6)
// ===========================================================================

describe('SessionManager.syncSubagentRecords', () => {
  it('returns a null session for an unknown session id', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const result = manager.syncSubagentRecords(randomUUID(), [
      makeSubagentRecord('irrelevant'),
    ]);
    expect(result.session).toBeNull();
    expect(result.bytes).toBe(0);
  });

  it('upserts records as rows, reports bytes, and merges into the in-memory session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    const records = [
      makeSubagentRecord(session.id, {
        id: 'sub-1',
        agent_name: 'explorer',
        task: 'find files',
        status: SubagentStatus.COMPLETED,
        result: 'found 3',
      }),
      makeSubagentRecord(session.id, {
        id: 'sub-2',
        agent_name: 'coder',
        task: 'edit file',
        status: SubagentStatus.RUNNING,
        end_time: null,
        result: null,
      }),
    ];

    const result = manager.syncSubagentRecords(session.id, records);
    expect(result.session).not.toBeNull();
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.session!.subagentChains.map((r) => r.id)).toEqual(['sub-1', 'sub-2']);
    expect(result.session!.subagentChains[1].status).toBe(SubagentStatus.RUNNING);

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.subagentChains).toHaveLength(2);
    expect(loaded!.subagentChains[0].id).toBe('sub-1');
    expect(loaded!.subagentChains[0].task).toBe('find files');
    expect(loaded!.subagentChains[0].status).toBe(SubagentStatus.COMPLETED);
    // Restore migrates RUNNING → INTERRUPTED; memory keeps the live status.
    expect(loaded!.subagentChains[1].status).toBe(SubagentStatus.INTERRUPTED);
    expect(manager.getSession(session.id)!.subagentChains[1].status).toBe(SubagentStatus.RUNNING);
  });

  it('merges dirty records by id without dropping clean siblings', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-1', result: 'first' }),
      makeSubagentRecord(session.id, { id: 'sub-2', result: 'second' }),
    ]);

    const result = manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-2', result: 'updated' }),
      makeSubagentRecord(session.id, { id: 'sub-3', result: 'third' }),
    ]);

    expect(result.session!.subagentChains.map((r) => r.id)).toEqual(['sub-1', 'sub-2', 'sub-3']);
    expect(result.session!.subagentChains.map((r) => r.result)).toEqual([
      'first',
      'updated',
      'third',
    ]);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.subagentChains.map((r) => r.id)).toEqual(['sub-1', 'sub-2', 'sub-3']);
    expect(loaded.subagentChains.find((r) => r.id === 'sub-2')!.result).toBe('updated');
  });

  it('copies the dirtyRecords array (does not retain caller reference)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const records: SubagentRecord[] = [makeSubagentRecord(session.id, { id: 'copy-1' })];

    const result = manager.syncSubagentRecords(session.id, records);
    records.push(makeSubagentRecord(session.id, { id: 'copy-2' }));

    expect(result.session!.subagentChains).toHaveLength(1);
    expect(result.session!.subagentChains[0].id).toBe('copy-1');
  });

  it('updates updatedAt on the session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const before = session.updatedAt;

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    const result = manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'recency' }),
    ]);
    expect(result.session!.updatedAt >= before).toBe(true);
  });

  it('patches an uncached session on disk without caching it', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-1' }),
    ]);

    // A fresh manager has no cached runtime for the session.
    const fresh = new SessionManager({ storage: storageOpts });
    const result = fresh.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-2' }),
    ]);
    expect(result.session!.subagentChains.map((r) => r.id)).toEqual(['sub-1', 'sub-2']);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.subagentChains.map((r) => r.id)).toEqual(['sub-1', 'sub-2']);
  });

  it('propagates a storage failure without mutating in-memory state', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-1', result: 'before' }),
    ]);
    const before = manager.getSession(session.id)!.subagentChains;

    const db = openSqliteDb(storageOpts.dbPath!);
    db.exec(`
      CREATE TRIGGER reject_subagent_record_update
      BEFORE UPDATE ON subagent_chains
      BEGIN
        SELECT RAISE(ABORT, 'subagent record update rejected');
      END
    `);
    db.close();

    expect(() =>
      manager.syncSubagentRecords(session.id, [
        makeSubagentRecord(session.id, { id: 'sub-1', result: 'after' }),
      ]),
    ).toThrow(/subagent record update rejected/);

    expect(manager.getSession(session.id)!.subagentChains).toBe(before);
    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.subagentChains[0].result).toBe('before');
  });

  it('falls back to a full save when the session row is missing', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    const db = openSqliteDb(storageOpts.dbPath!);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    db.close();
    _clearDbCache();

    const result = manager.syncSubagentRecords(session.id, [
      makeSubagentRecord(session.id, { id: 'sub-1' }),
    ]);
    expect(result.session).not.toBeNull();

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.subagentChains.map((r) => r.id)).toEqual(['sub-1']);
  });
});

// ===========================================================================
// updateChain — targeted turn-local write (R3)
// ===========================================================================

function readChainMessagesJson(dbPath: string, chainId: string): string {
  const db = openSqliteDb(dbPath);
  try {
    const row = db
      .prepare('SELECT messages_json FROM chains WHERE id = ?')
      .get(chainId) as { messages_json: string };
    return row.messages_json;
  } finally {
    db.close();
  }
}

describe('updateChain (targeted turn-local write, R3)', () => {
  const SID = 'adadadad-adad-4ada-8ada-adadadadadad';

  it('rewrites only the target chain row, bumps recency, leaves siblings byte-identical', () => {
    const chainA = makeChain(SID, { id: 'chain-a', messages: [makeMessage({ content: 'A original' })] });
    const chainB = makeChain(SID, { id: 'chain-b', messages: [makeMessage({ content: 'B original' })] });
    saveSession(
      makeSession({
        id: SID,
        chains: [chainA, chainB],
        activeChainId: 'chain-a',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      storageOpts,
    );

    const dbPath = storageOpts.dbPath!;
    const bBefore = readChainMessagesJson(dbPath, 'chain-b');

    const updatedA: Chain = { ...chainA, messages: [makeMessage({ content: 'A updated' })] };
    expect(updateChain(updatedA, '2026-02-01T00:00:00.000Z', storageOpts)).toBe(true);

    expect(readChainMessagesJson(dbPath, 'chain-b')).toBe(bBefore);

    const loaded = loadSession(SID, storageOpts)!;
    expect(loaded.chains.find((c) => c.id === 'chain-a')!.messages.map((m) => m.content)).toEqual(['A updated']);
    expect(loaded.chains.find((c) => c.id === 'chain-b')!.messages.map((m) => m.content)).toEqual(['B original']);

    const summary = listSavedSessions(storageOpts).find((s) => s.id === SID)!;
    expect(summary.updatedAt).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
  });

  it('persists per-turn chain metadata (selection/agent) alongside messages', () => {
    const chain = makeChain(SID, { id: 'chain-m', messages: [makeMessage({ content: 'hi' })] });
    saveSession(makeSession({ id: SID, chains: [chain], activeChainId: 'chain-m' }), storageOpts);

    const updated: Chain = {
      ...chain,
      messages: [makeMessage({ content: 'hi' }), makeMessage({ role: 'assistant', content: 'yo' })],
      selection: ANTHROPIC_SELECTION,
      modelLabel: ANTHROPIC_SELECTION.modelId,
      agentName: 'Coder',
    };
    expect(updateChain(updated, new Date().toISOString(), storageOpts)).toBe(true);

    const loaded = loadSession(SID, storageOpts)!;
    const c = loaded.chains.find((x) => x.id === 'chain-m')!;
    expect(c.messages.map((m) => m.content)).toEqual(['hi', 'yo']);
    expect(c.selection).toEqual(ANTHROPIC_SELECTION);
    expect(c.agentName).toBe('Coder');
  });

  it('returns false when the chain row is missing (caller falls back to full save)', () => {
    saveSession(makeSession({ id: SID, chains: [] }), storageOpts);
    const ghost = makeChain(SID, { id: 'ghost-chain' });
    expect(updateChain(ghost, new Date().toISOString(), storageOpts)).toBe(false);
  });

  it('manager per-turn write reaches disk without rewriting the completed sibling chain', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.startChain({ messages: [makeMessage({ id: 'u1', role: 'user', content: 'Q1' })] }, session.id);
    manager.persistTurn({
      messages: [
        makeMessage({ id: 'u1', role: 'user', content: 'Q1' }),
        makeMessage({ id: 'a1', role: 'assistant', content: 'A1' }),
      ],
      status: ChainStatus.COMPLETED,
    }, session.id);

    manager.startChain({ messages: [makeMessage({ id: 'u2', role: 'user', content: 'Q2' })] }, session.id);

    const dbPath = storageOpts.dbPath!;
    const completed = manager.getActive()!.chains[0];
    const activeChainId = manager.getActive()!.activeChainId!;
    const completedBefore = readChainMessagesJson(dbPath, completed.id);

    manager.updateActiveChainMessages([
      makeMessage({ id: 'u2', role: 'user', content: 'Q2' }),
      makeMessage({ id: 'a2', role: 'assistant', content: 'A2-in-progress' }),
    ], session.id);

    expect(readChainMessagesJson(dbPath, completed.id)).toBe(completedBefore);

    _clearDbCache();
    const fresh = new SessionManager({ storage: storageOpts });
    const loaded = fresh.switchTo(session.id)!;
    const recovered = loaded.chains.find((c) => c.id === activeChainId)!;
    expect(loaded.activeChainId).toBeNull();
    expect(recovered.status).toBe(ChainStatus.INTERRUPTED);
    expect(recovered.messages.map((m) => m.content)).toEqual(['Q2', 'A2-in-progress']);
    expect(loaded.chains.find((c) => c.id === completed.id)!.messages.map((m) => m.content)).toEqual(['Q1', 'A1']);
  });
});

// ===========================================================================
// Incremental persistence — turn boundaries and session-field updates
// ===========================================================================

describe('incremental session persistence', () => {
  it('does not bind an explicitly undefined session name', () => {
    const session = makeSession({
      id: 'acacacac-acac-4aca-8aca-acacacacacac',
      name: 'Preserved name',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    saveSession(session, storageOpts);

    expect(updateSessionFields(
      session.id,
      {
        name: undefined,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      storageOpts,
    )).toBe(true);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.name).toBe('Preserved name');
    expect(loaded.updatedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('does not delete historical chain rows during ordinary lifecycle updates', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.startChain({
      messages: [makeMessage({ id: 'u1', content: 'Question 1' })],
    }, session.id);
    manager.persistTurn({
      messages: [
        makeMessage({ id: 'u1', content: 'Question 1' }),
        makeMessage({ id: 'a1', role: 'assistant', content: 'Answer 1' }),
      ],
    }, session.id);

    const firstChainId = manager.getSession(session.id)!.chains[0]!.id;
    const db = openSqliteDb(storageOpts.dbPath!);
    const firstRow = db
      .prepare('SELECT rowid FROM chains WHERE id = ?')
      .get(firstChainId) as { rowid: number };
    db.exec(`
      CREATE TRIGGER reject_historical_chain_delete
      BEFORE DELETE ON chains
      BEGIN
        SELECT RAISE(ABORT, 'historical chain deletion is forbidden');
      END
    `);
    db.close();

    expect(() => {
      manager.startChain({
        messages: [makeMessage({ id: 'u2', content: 'Question 2' })],
      }, session.id);
      manager.persistTurn({
        messages: [
          makeMessage({ id: 'u2', content: 'Question 2' }),
          makeMessage({ id: 'a2', role: 'assistant', content: 'Answer 2' }),
        ],
      }, session.id);
      manager.rename(session.id, 'Incremental session');
      manager.changeModel(session.id, ANTHROPIC_SELECTION);
      manager.getTodoStore(session.id).create('Persist incrementally');
      manager.persistTodos(session.id);
      manager.setReasoningEffortOverride(session.id, 'high');
      manager.setPermissionMode(session.id, 'allow');
      manager.syncSubagentRecords(session.id, [
        makeSubagentRecord(session.id, { id: 'incremental-sub' }),
      ]);
    }).not.toThrow();

    const verifyDb = openSqliteDb(storageOpts.dbPath!);
    const preservedRow = verifyDb
      .prepare('SELECT rowid FROM chains WHERE id = ?')
      .get(firstChainId) as { rowid: number };
    verifyDb.close();

    expect(preservedRow.rowid).toBe(firstRow.rowid);
    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.chains).toHaveLength(2);
    expect(loaded.name).toBe('Incremental session');
    expect(loaded.selection).toEqual(ANTHROPIC_SELECTION);
    expect(loaded.todoStore.tasks.map((todo) => todo.title)).toEqual([
      'Persist incrementally',
    ]);
    expect(loaded.reasoningEffortOverride).toBe('high');
    expect(loaded.permissionMode).toBe('allow');
  });

  it('rolls back a failed terminal chain update without clearing the active chain', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const chain = manager.startChain({
      messages: [makeMessage({ id: 'u1', content: 'Still running' })],
    }, session.id)!;

    const db = openSqliteDb(storageOpts.dbPath!);
    db.exec(`
      CREATE TRIGGER reject_terminal_chain_update
      BEFORE UPDATE OF status ON chains
      WHEN OLD.status = 'active' AND NEW.status != 'active'
      BEGIN
        SELECT RAISE(ABORT, 'terminal chain update rejected');
      END
    `);
    db.close();

    expect(() => manager.finishActiveChain(ChainStatus.COMPLETED, session.id))
      .toThrow(/terminal chain update rejected/);

    const active = manager.getSession(session.id)!;
    expect(active.activeChainId).toBe(chain.id);
    expect(active.chains[0]!.status).toBe(ChainStatus.ACTIVE);

    const verifyDb = openSqliteDb(storageOpts.dbPath!);
    const persisted = verifyDb
      .prepare(`
        SELECT s.active_chain_id, c.status, c.end_time
        FROM sessions s
        JOIN chains c ON c.session_id = s.id
        WHERE s.id = ? AND c.id = ?
      `)
      .get(session.id, chain.id) as {
        active_chain_id: string | null;
        status: string;
        end_time: string | null;
      };
    verifyDb.close();

    expect(persisted).toEqual({
      active_chain_id: chain.id,
      status: ChainStatus.ACTIVE,
      end_time: null,
    });
  });
});

// ===========================================================================
// Load resilience — corrupt columns must not throw or silently lose chains
// ===========================================================================

describe('loadSession resilience to corrupt columns', () => {
  const SID = 'afafafaf-afaf-4afa-8afa-afafafafafaf';

  it('returns the session with safe defaults instead of throwing', () => {
    saveSession(
      makeSession({ id: SID, chains: [makeChain(SID, { id: 'c1', messages: [makeMessage({ content: 'hi' })] })] }),
      storageOpts,
    );

    const db = openSqliteDb(storageOpts.dbPath!);
    db.prepare(
      "UPDATE sessions SET todo_store_json = '{not json', selection_json = 'oops' WHERE id = ?",
    ).run(SID);
    db.prepare("UPDATE chains SET messages_json = 'garbage' WHERE id = ?").run('c1');
    db.close();
    _clearDbCache();

    const loaded = loadSession(SID, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.selection).toBeNull();
    expect(loaded!.subagentChains).toEqual([]);
    expect(loaded!.todoStore.tasks).toEqual([]);
    // The chain survives (with empty messages) rather than being dropped.
    expect(loaded!.chains).toHaveLength(1);
    expect(loaded!.chains[0].messages).toEqual([]);
  });

  it('prunes orphan tool results on load (parity with chainFromStorageDict)', () => {
    const orphan = makeMessage({ role: 'tool', type: 'tool_result', tool_call_id: 'no-such-call', content: 'orphan' });
    const user = makeMessage({ role: 'user', content: 'q' });
    saveSession(
      makeSession({ id: SID, chains: [makeChain(SID, { id: 'c1', messages: [orphan, user] })] }),
      storageOpts,
    );

    const loaded = loadSession(SID, storageOpts)!;
    expect(loaded.chains[0].messages.map((m) => m.content)).toEqual(['q']);
  });
});

// ===========================================================================
// Corruption recovery through the storage layer (no permanent loss)
// ===========================================================================

describe('storage-layer corruption recovery', () => {
  it('recovers a corrupt DB on open, preserving a backup instead of deleting it', () => {
    const sid = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
    saveSession(makeSession({ id: sid, chains: [] }), storageOpts);
    _clearDbCache();

    // Corrupt the DB (and drop sidecars) so the next open hits corruption.
    fs.writeFileSync(storageOpts.dbPath!, Buffer.alloc(4096, 0xde));
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = storageOpts.dbPath! + suffix;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
    }

    // Storage operations heal (move-aside + rebuild → empty) instead of throwing.
    expect(loadSession(sid, storageOpts)).toBeNull();
    expect(listSavedSessions(storageOpts)).toEqual([]);

    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.corrupt-'));
    expect(backups.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SessionManager.setReasoningEffortOverride
// ===========================================================================

describe('SessionManager.setReasoningEffortOverride', () => {
  it('sets the override and advances updatedAt', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const before = session.updatedAt;

    const start = Date.now();
    while (Date.now() - start < 5) { /* tick */ }

    manager.setReasoningEffortOverride(session.id, 'high');

    const active = manager.getActive()!;
    expect(active.reasoningEffortOverride).toBe('high');
    expect(active.updatedAt >= before).toBe(true);
  });

  it('early-returns without mutation when session is not selected by any owner', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.create(ANTHROPIC_SELECTION);

    manager.setReasoningEffortOverride(session1.id, 'high');

    const loaded = loadSession(session1.id, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBeNull();
  });

  it('does not throw for an unknown session id', () => {
    const manager = new SessionManager({ storage: storageOpts });
    manager.create(DEFAULT_SELECTION);

    expect(() =>
      manager.setReasoningEffortOverride(randomUUID(), 'high'),
    ).not.toThrow();
  });

  it('persists the updated session to storage', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.setReasoningEffortOverride(session.id, 8192);

    _clearDbCache();
    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBe(8192);
  });

  it('clears the override when set to null', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.setReasoningEffortOverride(session.id, 'high');
    expect(manager.getActive()!.reasoningEffortOverride).toBe('high');

    manager.setReasoningEffortOverride(session.id, null);
    expect(manager.getActive()!.reasoningEffortOverride).toBeNull();

    _clearDbCache();
    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBeNull();
  });
});

// ===========================================================================
// reasoningEffortOverride SQLite round-trip
// ===========================================================================

describe('reasoningEffortOverride SQLite round-trip', () => {
  it('round-trips a string override', () => {
    const session = makeSession({
      id: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
      reasoningEffortOverride: 'high',
    });
    saveSession(session, storageOpts);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBe('high');
  });

  it('round-trips a numeric override', () => {
    const session = makeSession({
      id: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
      reasoningEffortOverride: 8192,
    });
    saveSession(session, storageOpts);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBe(8192);
  });

  it('deserializes a malformed stored value to null', () => {
    const sid = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
    const session = makeSession({ id: sid, reasoningEffortOverride: 'high' });
    saveSession(session, storageOpts);

    const db = openSqliteDb(storageOpts.dbPath!);
    db.prepare(
      'UPDATE sessions SET reasoning_effort_override = ? WHERE id = ?',
    ).run('{"bad":true}', sid);
    db.close();
    _clearDbCache();

    const loaded = loadSession(sid, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBeNull();
  });

  it('round-trips null override as null', () => {
    const session = makeSession({
      id: 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4',
      reasoningEffortOverride: null,
    });
    saveSession(session, storageOpts);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.reasoningEffortOverride).toBeNull();
  });
});

describe('permissionMode SQLite round-trip', () => {
  it('round-trips a permission mode string', () => {
    const session = makeSession({
      id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',
      permissionMode: 'ask' as never,
    });
    saveSession(session, storageOpts);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.permissionMode).toBe('ask');
  });

  it('round-trips null permission mode as null', () => {
    const session = makeSession({
      id: 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2',
      permissionMode: null,
    });
    saveSession(session, storageOpts);

    const loaded = loadSession(session.id, storageOpts)!;
    expect(loaded.permissionMode).toBeNull();
  });

  it('persists permission mode through SessionManager.setPermissionMode', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const created = manager.create(null, { cwd: null });
    manager.setPermissionMode(created.id, 'allow');

    _clearDbCache();

    const loaded = loadSession(created.id, storageOpts)!;
    expect(loaded.permissionMode).toBe('allow');
  });

  it('clears permission mode when set to null', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const created = manager.create(null, { cwd: null });
    manager.setPermissionMode(created.id, 'ask');
    manager.setPermissionMode(created.id, null);

    _clearDbCache();

    const loaded = loadSession(created.id, storageOpts)!;
    expect(loaded.permissionMode).toBeNull();
  });

  it('syncs the in-memory gate map so the selector takes effect this run', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const created = manager.create(null, { cwd: null });

    try {
      manager.setPermissionMode(created.id, 'allow');
      expect(sessionPermissionOverrides.get(created.id)).toBe('allow');

      manager.setPermissionMode(created.id, 'ask');
      expect(sessionPermissionOverrides.get(created.id)).toBe('ask');

      manager.setPermissionMode(created.id, null);
      expect(sessionPermissionOverrides.has(created.id)).toBe(false);
    } finally {
      sessionPermissionOverrides.delete(created.id);
    }
  });
});
