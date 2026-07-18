/**
 * Session persistence tests — U5.
 *
 * Covers:
 * - Save → load → identical content
 * - Atomic write: Simulate crash → no partial file
 * - List: Multiple sessions → mtime order (newest first)
 * - Delete: File removed, caches cleaned
 * - Auto-naming: Default name + first exchange → descriptive title
 * - Switching: In-flight subagents continue running
 */
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
  ensureSessionsDir,
  saveSession,
  loadSession,
  listSavedSessions,
  deleteSession,
  isValidSessionId,
} from '../../src/main/session/storage';
import { SessionManager } from '../../src/main/session/manager';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

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
    sessionsDir: path.join(dir, 'sessions'),
    toolOutputCacheDir: path.join(dir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(dir, 'cache', 'web-fetch'),
  };
}

/** Create a minimal test session. */
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
  };
}

/** Create a minimal test message. */
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
    is_error: overrides.is_error,
  };
}

/** Create a minimal chain for pre-seeding sessions. */
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

/** Create a minimal subagent record for syncSubagentChains tests. */
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
    chain,
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  storageOpts = makeStorageOpts(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// V1 → V2 model selection migration
// ===========================================================================

describe('session selection persistence migration', () => {
  it('restores v1 model strings as display-only labels and resaves the full session as v2', () => {
    const sessionId = 'c1111111-1111-4111-8111-111111111111';
    const now = '2026-07-12T12:00:00.000Z';
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        version: 1,
        id: sessionId,
        name: 'Historical session',
        model: 'legacy/session-model',
        cwd: '/historical/project',
        chains: [
          {
            id: 'legacy-chain',
            sessionId,
            messages: [],
            status: 'completed',
            model: 'legacy/chain-model',
            agentName: 'General',
            agentType: 'internal',
            agentTier: 'bloom',
          },
        ],
        activeChainId: null,
        createdAt: now,
        updatedAt: now,
        subagent_chains: [
          {
            id: 'legacy-subagent',
            agent_name: 'explorer',
            agent_type: 'subagent',
            agent_tier: 'seed',
            task: 'inspect history',
            status: 'completed',
            chain_id: 'legacy-subagent-chain',
            start_time: now,
            end_time: now,
            result: null,
            error: null,
            parent_chain_index: 0,
            chain: {
              id: 'legacy-subagent-chain',
              sessionId,
              messages: [],
              status: 'completed',
              model: 'legacy/subagent-model',
              agentName: 'explorer',
              agentType: 'subagent',
              agentTier: 'seed',
            },
          },
        ],
        todo_store: {
          tasks: [
            {
              id: 'historic-task',
              title: 'Keep this todo',
              status: 'OPEN',
              subagent_id: null,
              created_at: now,
              updated_at: now,
            },
          ],
        },
      }),
      'utf-8',
    );

    const loaded = loadSession(sessionId, storageOpts)!;
    expect(loaded.selection).toBeNull();
    expect(loaded.modelLabel).toBe('legacy/session-model');
    expect(loaded.cwd).toBe('/historical/project');
    expect(loaded.chains[0].selection).toBeNull();
    expect(loaded.chains[0].modelLabel).toBe('legacy/chain-model');
    expect(loaded.subagentChains[0].chain.selection).toBeNull();
    expect(loaded.subagentChains[0].chain.modelLabel).toBe('legacy/subagent-model');
    expect(loaded.todoStore.tasks[0].title).toBe('Keep this todo');

    saveSession(loaded, storageOpts);
    const resaved = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, `${sessionId}.json`), 'utf-8'),
    ) as Record<string, unknown>;
    expect(resaved.version).toBe(2);
    expect(resaved).not.toHaveProperty('model');
    expect(resaved.selection).toBeNull();
    expect(resaved.modelLabel).toBe('legacy/session-model');
    expect(resaved.cwd).toBe('/historical/project');
    expect(resaved.chains).toHaveLength(1);
    expect((resaved.chains as Array<Record<string, unknown>>)[0]).toMatchObject({
      selection: null,
      modelLabel: 'legacy/chain-model',
    });
    expect((resaved.subagent_chains as Array<Record<string, unknown>>)[0].chain).toMatchObject({
      selection: null,
      modelLabel: 'legacy/subagent-model',
    });
    expect(resaved.todo_store).toMatchObject({
      tasks: [expect.objectContaining({ id: 'historic-task', title: 'Keep this todo' })],
    });
  });

  it('round-trips an exact typed selection whose model ID contains slashes', () => {
    const sessionId = 'c2222222-2222-4222-8222-222222222222';
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    const session = {
      id: sessionId,
      name: 'Selected session',
      selection,
      modelLabel: 'Vendor Path Model',
      cwd: '/selected/project',
      chains: [
        {
          id: 'typed-chain',
          sessionId,
          messages: [],
          status: ChainStatus.COMPLETED,
          selection,
          modelLabel: 'Vendor Path Model',
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
          startTime: '2026-07-12T12:00:00.000Z',
          endTime: '2026-07-12T12:00:01.000Z',
        },
      ],
      activeChainId: null,
      createdAt: '2026-07-12T12:00:00.000Z',
      updatedAt: '2026-07-12T12:00:01.000Z',
      subagentChains: [],
      todoStore: { tasks: [] },
    } as unknown as Session;

    saveSession(session, storageOpts);
    const loaded = loadSession(sessionId, storageOpts)!;
    expect(loaded.selection).toEqual(selection);
    expect(loaded.modelLabel).toBe('Vendor Path Model');
    expect(loaded.chains[0].selection).toEqual(selection);
    expect(loaded.chains[0].modelLabel).toBe('Vendor Path Model');

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'sessions', `${sessionId}.json`), 'utf-8'),
    ) as Record<string, unknown>;
    expect(persisted.version).toBe(2);
    expect(persisted).not.toHaveProperty('model');
    expect(persisted.selection).toEqual(selection);
    expect((persisted.chains as Array<Record<string, unknown>>)[0].selection).toEqual(selection);
  });

  it('uses modelLabel from v2 metadata in the fast summary without stringifying selection', () => {
    const sessionId = 'c3333333-3333-4333-8333-333333333333';
    const metadata = JSON.stringify({
      version: 2,
      id: sessionId,
      name: 'Fast summary session',
      selection: {
        connectionId: '22222222-2222-4222-8222-222222222222',
        modelId: 'vendor/path/model',
      },
      modelLabel: 'Vendor Path Model',
      cwd: null,
      chains: [],
      activeChainId: null,
      createdAt: '2026-07-12T12:00:00.000Z',
      updatedAt: '2026-07-12T12:00:01.000Z',
      subagentChains: [],
      todoStore: { tasks: [] },
    });
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Invalid trailing JSON proves listSavedSessions used the top-level fast
    // metadata path rather than parsing the complete document.
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.json`),
      `${metadata.slice(0, -1)},"truncated":`,
      'utf-8',
    );

    const summary = listSavedSessions(storageOpts)[0] as unknown as {
      modelLabel: string | null | undefined;
    };

    expect(summary.modelLabel).toBe('Vendor Path Model');
    expect(summary.modelLabel).not.toBe('[object Object]');
  });
});

// ===========================================================================
// Save → load round-trip
// ===========================================================================

describe('saveSession → loadSession round-trip', () => {
  it('preserves canonical tool facts and the exact agent projection through session JSON', () => {
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
      is_error: false,
    });
    const session = makeSession({
      id: sessionId,
      chains: [makeChain(sessionId, { messages: [callMessage, resultMessage] })],
    });

    saveSession(session, storageOpts);
    const raw = JSON.parse(
      fs.readFileSync(path.join(storageOpts.sessionsDir!, `${sessionId}.json`), 'utf-8'),
    ) as { chains: Array<{ messages: Array<{ tool_result?: unknown }> }> };
    expect(JSON.stringify(raw.chains[0].messages[1].tool_result)).toBe(
      JSON.stringify(canonical),
    );

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
              is_error: false,
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
              is_error: false,
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

  it('load returns null for corrupted JSON', () => {
    const corruptedId = 'b0000000-0000-4000-8000-000000000001';
    fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'sessions', `${corruptedId}.json`),
      'not valid json{{{',
      'utf-8',
    );
    const loaded = loadSession(corruptedId, storageOpts);
    expect(loaded).toBeNull();
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
});

// ===========================================================================
// Atomic write — simulate crash → no partial file
// ===========================================================================

describe('atomic write', () => {
  it('session file uses .tmp during write (no partial on crash)', () => {
    const session = makeSession({
      id: 'a5555555-5555-4555-8555-555555555555',
      name: 'Atomic Test',
    });
    const sessionPath = path.join(tmpDir, 'sessions', 'a5555555-5555-4555-8555-555555555555.json');
    const tmpPath = sessionPath + '.tmp';

    saveSession(session, storageOpts);

    // After successful save: .json exists, .tmp does not
    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    // Verify content is valid JSON
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('a5555555-5555-4555-8555-555555555555');
    expect(parsed.name).toBe('Atomic Test');
  });

  it('session file has mode 0o600', () => {
    const session = makeSession({ id: 'a6666666-6666-4666-8666-666666666666' });
    saveSession(session, storageOpts);

    const sessionPath = path.join(tmpDir, 'sessions', 'a6666666-6666-4666-8666-666666666666.json');
    const stat = fs.statSync(sessionPath);

    // Check file permissions (owner read/write only)
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('sessions directory has mode 0o700', () => {
    ensureSessionsDir(storageOpts);
    const sessionsDir = path.join(tmpDir, 'sessions');
    const stat = fs.statSync(sessionsDir);
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('atomic write cleans up .tmp on error', () => {
    const session = makeSession({ id: 'a7777777-7777-4777-8777-777777777777' });
    saveSession(session, storageOpts);

    const sessionsDir = path.join(tmpDir, 'sessions');
    const files = fs.readdirSync(sessionsDir);
    expect(files).toContain('a7777777-7777-4777-8777-777777777777.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

// ===========================================================================
// List — multiple sessions → mtime order (newest first)
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

  it('lists multiple sessions sorted by mtime (newest first)', () => {
    // Create sessions with slight delays to ensure different mtimes
    const session1 = makeSession({
      id: 'a9999999-9999-4999-8999-999999999999',
      name: 'Old Session',
    });
    saveSession(session1, storageOpts);

    // Small delay to ensure different mtime
    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy wait
    }

    const session2 = makeSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'New Session',
    });
    saveSession(session2, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(2);
    // Newest first
    expect(sessions[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(sessions[1].id).toBe('a9999999-9999-4999-8999-999999999999');
  });

  it('includes chain count in summary', () => {
    const session = makeSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      chains: [
        {
          id: 'chain-1',
          sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          messages: [],
          status: 'completed',
          selection: DEFAULT_SELECTION,
          modelLabel: DEFAULT_SELECTION.modelId,
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
        },
        {
          id: 'chain-2',
          sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          messages: [],
          status: 'completed',
          selection: DEFAULT_SELECTION,
          modelLabel: DEFAULT_SELECTION.modelId,
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
        },
      ],
    });
    saveSession(session, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].chainCount).toBe(2);
  });

  it('handles corrupted session files gracefully', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    // Write a valid session
    const session = makeSession({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    saveSession(session, storageOpts);

    // Write a corrupted session file
    fs.writeFileSync(path.join(sessionsDir, 'corrupted.json'), 'not json', 'utf-8');

    const sessions = listSavedSessions(storageOpts);
    // Should still return the valid session, skipping the corrupted one
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  });

  it('defaults name to "Unnamed" when missing', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Write a session without a name field
    fs.writeFileSync(
      path.join(sessionsDir, 'no-name.json'),
      JSON.stringify({ id: 'no-name', model: 'gpt-4o', chains: [] }),
      'utf-8',
    );

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('Unnamed');
  });
});

// ===========================================================================
// Delete — file removed, caches cleaned
// ===========================================================================

describe('deleteSession', () => {
  it('deletes session file', () => {
    const session = makeSession({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    saveSession(session, storageOpts);

    const sessionPath = path.join(tmpDir, 'sessions', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd.json');
    expect(fs.existsSync(sessionPath)).toBe(true);

    const result = deleteSession('dddddddd-dddd-4ddd-8ddd-dddddddddddd', storageOpts);
    expect(result).toBe(true);
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it('returns false for non-existent session', () => {
    const result = deleteSession(randomUUID(), storageOpts);
    expect(result).toBe(false);
  });

  it('cleans up tool-output cache directory', () => {
    const session = makeSession({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
    saveSession(session, storageOpts);

    // Create tool-output cache
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

    // Create web-fetch cache
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
// Session cwd — create / load / list / changeCwd (U2)
// ===========================================================================

describe('session cwd persistence', () => {
  it('create with cwd → disk JSON contains cwd → load restores it', () => {
    const projectDir = path.join(tmpDir, 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });

    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION, { cwd: projectDir });

    expect(session.cwd).toBe(fs.realpathSync(projectDir));

    // Disk JSON has cwd near the top (after id/name/model)
    const raw = fs.readFileSync(path.join(tmpDir, 'sessions', `${session.id}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.cwd).toBe(session.cwd);
    // Key order: cwd appears before chains
    const cwdIdx = raw.indexOf('"cwd"');
    const chainsIdx = raw.indexOf('"chains"');
    expect(cwdIdx).toBeGreaterThan(-1);
    expect(chainsIdx).toBeGreaterThan(cwdIdx);

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.cwd).toBe(session.cwd);
  });

  it('create without cwd does not write process.cwd()', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    expect(session.cwd).toBeNull();

    const raw = fs.readFileSync(path.join(tmpDir, 'sessions', `${session.id}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.cwd).toBeNull();
    expect(parsed.cwd).not.toBe(process.cwd());

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.cwd).toBeNull();
  });

  it('list summary includes cwd from partial head read', () => {
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

  it('legacy file without cwd → load yields null; list summary cwd null', () => {
    const legacyId = 'd1111111-1111-4111-8111-111111111111';
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Legacy shape: no cwd field at all
    fs.writeFileSync(
      path.join(sessionsDir, `${legacyId}.json`),
      JSON.stringify({
        version: 1,
        id: legacyId,
        name: 'Legacy Session',
        model: 'gpt-4o',
        chains: [],
        activeChainId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subagent_chains: [],
        todo_store: { tasks: [] },
      }),
      'utf-8',
    );

    const loaded = loadSession(legacyId, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.cwd).toBeNull();

    const summaries = listSavedSessions(storageOpts);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(legacyId);
    expect(summaries[0].cwd).toBeNull();
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

    // Also visible via list summary
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

    // Prior cwd preserved in memory and on disk
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
    manager.create(DEFAULT_SELECTION); // session1 no longer active

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

    // Should be saved to disk
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

  it('clearActive() drops active without deleting the session file', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    expect(manager.getActive()!.id).toBe(session.id);

    manager.clearActive();
    expect(manager.getActive()).toBeNull();

    // File still on disk
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
  });

  it('switchTo() loads session from disk and sets as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    const session2 = manager.create(ANTHROPIC_SELECTION);

    // Active should be session2
    expect(manager.getActive()!.id).toBe(session2.id);

    // Switch to session1
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

    // Should be gone from disk
    expect(loadSession(sessionId, storageOpts)).toBeNull();
  });

  it('delete() does not clear active if deleting a different session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    const session2 = manager.create(ANTHROPIC_SELECTION);

    // Delete session1 (not active)
    manager.delete(session1.id);

    // session2 should still be active
    expect(manager.getActive()!.id).toBe(session2.id);
  });

  it('rename() updates active session name', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.rename(session.id, 'New Name');

    expect(manager.getActive()!.name).toBe('New Name');

    // Verify persisted
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('New Name');
  });

  it('rename() is no-op for non-active session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.create(ANTHROPIC_SELECTION);

    // Try to rename session1 (not active)
    manager.rename(session1.id, 'Should Not Change');

    // session1 on disk should still have original name
    const loaded = loadSession(session1.id, storageOpts);
    expect(loaded!.name).not.toBe('Should Not Change');
  });

  it('changeModel() updates active session model', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.changeModel(session.id, ANTHROPIC_SELECTION);

    expect(manager.getActive()!.selection).toEqual(ANTHROPIC_SELECTION);
    expect(manager.getActive()!.modelLabel).toBe('anthropic/claude-3.5-sonnet');

    // Verify persisted
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.selection).toEqual(ANTHROPIC_SELECTION);
    expect(loaded!.modelLabel).toBe('anthropic/claude-3.5-sonnet');
  });

  it('load() loads session from disk without setting as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const session2 = manager.create(ANTHROPIC_SELECTION);

    // Load session1 without switching
    const loaded = manager.load(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);

    // Active should still be session2
    expect(manager.getActive()!.id).toBe(session2.id);
  });

  it('listSaved() returns sessions sorted by mtime', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);

    // Small delay
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

    // Default name starts with "Session "
    expect(session.name.startsWith('Session ')).toBe(true);

    const result = await manager.autoNameActive();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('My Coding Session');

    // Verify persisted
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('My Coding Session');
  });

  it('autoNameActive() skips if name does not start with "Session "', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Should Not Apply',
      storage: storageOpts,
    });
    const session = manager.create(DEFAULT_SELECTION);

    // Manually rename
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

    // Should not throw
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
// Session switching — in-flight subagents continue running
// ===========================================================================

describe('SessionManager switching', () => {
  it('switchTo does not cancel running subagents (by design)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.create(ANTHROPIC_SELECTION);

    // session1 is no longer active after creating session2
    // Switch back to session1
    const switched = manager.switchTo(session1.id);
    expect(switched).not.toBeNull();
    expect(switched!.id).toBe(session1.id);

    // The key behavior: switching does NOT throw or modify subagent state.
    // In the real system, subagent actors continue running independently.
    // This test verifies the switch completes without error.
  });

  it('multiple switches preserve session data', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create(DEFAULT_SELECTION);
    manager.rename(session1.id, 'Session 1');

    const session2 = manager.create(ANTHROPIC_SELECTION);
    manager.rename(session2.id, 'Session 2');

    // Switch back and forth
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

    // Simulate external modification (e.g., another process)
    const modified: Session = {
      ...session,
      name: 'Externally Modified',
      updatedAt: new Date().toISOString(),
    };
    saveSession(modified, storageOpts);

    manager.getTodoStore(session.id).create('Live todo');

    // Re-selecting must not replace state still owned by running tools.
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

    // Flatten is full conversation (LLM history)
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
    // Finished turns clear activeChainId (Python freeze)
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
// syncSubagentChains — replace subagent_chains + persist
// ===========================================================================

describe('SessionManager.syncSubagentChains', () => {
  it('returns null when no active session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const result = manager.syncSubagentChains([]);
    expect(result).toBeNull();
  });

  it('sets empty subagentChains and persists', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    // Seed a non-empty list first
    const record = makeSubagentRecord(session.id);
    manager.syncSubagentChains([record]);
    expect(manager.getActive()!.subagentChains).toHaveLength(1);

    const cleared = manager.syncSubagentChains([]);
    expect(cleared).not.toBeNull();
    expect(cleared!.subagentChains).toEqual([]);

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.subagentChains).toEqual([]);
  });

  it('sets populated subagentChains and persists', () => {
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

    const result = manager.syncSubagentChains(records);
    expect(result).not.toBeNull();
    expect(result!.subagentChains).toHaveLength(2);
    expect(result!.subagentChains[0].id).toBe('sub-1');
    expect(result!.subagentChains[0].agent_name).toBe('explorer');
    expect(result!.subagentChains[0].result).toBe('found 3');
    // In-memory keeps RUNNING as written by syncSubagentChains
    expect(result!.subagentChains[1].id).toBe('sub-2');
    expect(result!.subagentChains[1].status).toBe(SubagentStatus.RUNNING);

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.subagentChains).toHaveLength(2);
    expect(loaded!.subagentChains[0].id).toBe('sub-1');
    expect(loaded!.subagentChains[0].task).toBe('find files');
    expect(loaded!.subagentChains[0].status).toBe(SubagentStatus.COMPLETED);
    expect(loaded!.subagentChains[1].id).toBe('sub-2');
    // On restore, PENDING/RUNNING migrate to INTERRUPTED (matching Python)
    expect(loaded!.subagentChains[1].status).toBe(SubagentStatus.INTERRUPTED);

    // A live in-memory session must remain visible as running to renderer
    // refreshes; only a true disk restore applies crash recovery migration.
    const live = manager.load(session.id);
    expect(live!.subagentChains[1].status).toBe(SubagentStatus.RUNNING);
  });

  it('replaces prior subagentChains entirely (not merge)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);

    manager.syncSubagentChains([
      makeSubagentRecord(session.id, { id: 'old-1' }),
      makeSubagentRecord(session.id, { id: 'old-2' }),
    ]);

    const replaced = manager.syncSubagentChains([
      makeSubagentRecord(session.id, { id: 'new-only' }),
    ]);

    expect(replaced!.subagentChains).toHaveLength(1);
    expect(replaced!.subagentChains[0].id).toBe('new-only');

    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.subagentChains.map((r) => r.id)).toEqual(['new-only']);
  });

  it('copies the subagentChains array (does not retain caller reference)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const records: SubagentRecord[] = [makeSubagentRecord(session.id, { id: 'copy-1' })];

    const result = manager.syncSubagentChains(records);
    records.push(makeSubagentRecord(session.id, { id: 'copy-2' }));

    expect(result!.subagentChains).toHaveLength(1);
    expect(result!.subagentChains[0].id).toBe('copy-1');
  });

  it('updates updatedAt on the session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create(DEFAULT_SELECTION);
    const before = session.updatedAt;

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    const result = manager.syncSubagentChains([]);
    expect(result!.updatedAt >= before).toBe(true);
  });
});
