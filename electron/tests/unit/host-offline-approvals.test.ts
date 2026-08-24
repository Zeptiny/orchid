/**
 * U9 — offline approvals/questions + pending semantics on a host with zero
 * connected clients (R5/R6/R7), in-process (no transport, no Electron import).
 *
 * Real under test: HostServer's approval/question forwarding (pending with no
 * abort, timeout-bounded fail-closed settle, reconnect re-delivery, owner-only
 * answers, pending accessors) against the real approval/question stores and a
 * real SessionManager on temp SQLite storage.
 *
 * Mocked (the same seam as host-server.test.ts): session/singleton, project
 * workspace + trust + runtime registry, mcp/rag/ast services, tool registries,
 * and the chat pipeline entry points.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';

const OWNER = 'conn-owner';
const OTHER = 'conn-other';

const mocks = vi.hoisted(() => {
  return {
    sessionManager: null as unknown,
    workspace: { cwd: null as string | null, status: 'unbound', source: 'unbound' },
    trustState: { current: 'untrusted' as 'trusted' | 'untrusted' | 'changed' },
    draftCwdByClient: new Map<string, string | null>(),
    runtimeConfig: { default_model: null as unknown },
    configState: null as unknown,
  };
});

// ── Core service mocks (same seam as host-server.test.ts) ────────────────────

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (clientId: string) => ({
    cwd: mocks.draftCwdByClient.get(clientId) ?? mocks.workspace.cwd,
    source: mocks.workspace.source,
    status: mocks.workspace.status,
  }),
  resolveBoundProjectPath: (clientId?: string) =>
    mocks.draftCwdByClient.get(clientId ?? '') ?? mocks.workspace.cwd,
}));

vi.mock('../../src/main/project/workspace', () => ({
  isWorkspaceBound: (info: { status?: string }) => info?.status === 'valid',
  getDraftCwd: (owner: string) => mocks.draftCwdByClient.get(owner) ?? null,
  setDraftCwd: (owner: string, cwd: string) => void mocks.draftCwdByClient.set(owner, cwd),
  clearDraftCwd: (owner: string) => void mocks.draftCwdByClient.delete(owner),
  requireValidProjectDirectory: (dir: string) => fs.realpathSync(dir),
  updateStickyDefaultProjectDir: vi.fn(async () => {}),
  resolveWorkspace: (owner: string, opts: { sessionCwd: string | null; stickyDefault: string | null }) => ({
    cwd: opts.sessionCwd ?? opts.stickyDefault,
    source: opts.sessionCwd ? 'session' : 'sticky',
    status: opts.sessionCwd ?? opts.stickyDefault ? 'valid' : 'unbound',
  }),
}));

vi.mock('../../src/main/project/path', () => ({
  canonicalizeProjectDirectory: (dir: string) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return null;
    }
  },
}));

vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: () => mocks.trustState.current,
  grantProjectTrust: vi.fn(),
  revokeProjectTrust: vi.fn(),
  revokeProjectTrustRaw: vi.fn(),
  buildProjectTrustReport: vi.fn(() => null),
  listTrustedProjects: vi.fn(() => []),
  resetProjectTrustStore: vi.fn(),
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    get: (cwd: string) => ({
      projectDir: cwd,
      config: mocks.runtimeConfig,
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
      sharedPrompts: { 'all-agents': null, subagents: null },
    }),
    invalidate: vi.fn(() => true),
  }),
  clearProjectRuntimeRegistry: vi.fn(),
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => mocks.configState,
  };
});

vi.mock('../../src/main/mcp/project-registry', () => ({
  getProjectMCPManager: () => ({ getTools: () => [], getStatus: () => [] }),
  acquireProjectMCPManager: vi.fn(),
  releaseProjectMCPManager: vi.fn(),
  invalidateProjectMCPManagers: vi.fn(),
  invalidateAllProjectMCPManagers: vi.fn(),
  shutdownProjectMCPManagers: vi.fn(async () => {}),
}));

vi.mock('../../src/main/rag/indexer', () => ({
  indexProject: vi.fn(async () => ({
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0, filesDeleted: 0,
    chunksCreated: 0, errors: [], durationSeconds: 0,
  })),
  getStatus: vi.fn(() => ({
    totalChunks: 0, totalFiles: 0, lastIndexed: null, lastIndexDuration: null, lastAutoRefresh: null,
  })),
  clearIndex: vi.fn(),
  cancelIndex: vi.fn(async () => false),
  isIndexing: vi.fn(() => false),
}));

vi.mock('../../src/main/ast/indexer', () => ({
  indexProject: vi.fn(async () => ({
    filesScanned: 0, filesIndexed: 0, filesSkipped: 0, filesDeleted: 0,
    symbolsExtracted: 0, errors: [], durationSeconds: 0,
  })),
  isIndexing: vi.fn(() => false),
}));

vi.mock('../../src/main/ast/store', () => ({
  ASTStore: class {
    status() {
      return { totalFiles: 0, totalSymbols: 0, lastIndexed: null, lastIndexDuration: null, lastAutoRefresh: null };
    }
    dispose() {}
  },
}));

vi.mock('../../src/main/indexing/watcher', () => ({
  attachWorkspaceWatcher: vi.fn(),
  detachWorkspaceWatcher: vi.fn(),
  ensureWorkspaceWatcherStarted: vi.fn(),
  reconfigureWorkspaceWatchers: vi.fn(),
  getWorkspaceWatcherState: vi.fn(() => ({ watching: false })),
  disposeAllWorkspaceWatchers: vi.fn(),
}));

vi.mock('../../src/main/indexing/refresh-coordinator', () => ({
  setIndexAutoRefreshNotifier: vi.fn(),
  cancelProjectRefresh: vi.fn(),
  cancelProjectRefreshAsync: vi.fn(async () => {}),
  disposeIndexRefreshCoordinatorAsync: vi.fn(async () => {}),
  markDirty: vi.fn(),
}));

vi.mock('../../src/main/tools', () => ({
  toolRegistry: {
    get: vi.fn(() => undefined),
    listAll: vi.fn(() => []),
  },
  getSubagentManager: () => ({
    getStates: () => [],
    recordsForSession: () => [],
    allRecords: () => [],
    isSummary: () => true,
    toDomainRecord: () => null,
    getSessionRevision: () => 0,
    getLiveProjections: () => ({}),
    getRecord: () => null,
    addOnChangeListener: vi.fn(() => () => {}),
    setOnDelta: vi.fn(),
    setOnChange: vi.fn(),
    setRunner: vi.fn(),
    discardSession: vi.fn(),
    trackedPersistenceSessions: () => [],
    cancelRunning: () => [],
  }),
  setTodosChangedNotifier: vi.fn(),
  getSkillsRegistry: () => new Map(),
  getBuiltinToolRegistryForRuntime: vi.fn(() => null),
  createBuiltinToolRegistry: vi.fn(() => null),
  registerBuiltinTools: vi.fn(),
}));

vi.mock('../../src/main/session/working-set-live', () => ({
  setWorkingSetBroadcast: vi.fn(),
  bootstrapWorkingSet: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
  filterIfCatalogOk: vi.fn(() => ({
    snapshot: { openSessionIds: [], focusedSessionId: null },
    membershipChanged: false,
  })),
  tryListSessionCatalog: vi.fn(() => ({ status: 'ok', ids: new Set() })),
  mutateAndPersist: vi.fn((_owner: string, run: () => unknown) => run()),
  workingSetOpenOrFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
  workingSetRemove: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
  workingSetClearFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
}));

vi.mock('../../src/main/session/working-set', () => ({
  sessionWorkingSet: {
    getSnapshot: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    setFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    close: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    openOrFocus: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    remove: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    filterExisting: vi.fn(() => ({ openSessionIds: [], focusedSessionId: null })),
    loadFromDisk: vi.fn(),
    saveToDisk: vi.fn(),
  },
}));

vi.mock('../../src/main/agents/wire-subagents', () => ({
  setSubagentsChangedBroadcast: vi.fn(),
  flushSubagentPersistence: vi.fn(),
  disposeSubagentPersistence: vi.fn(),
  wireSubagentRuntime: vi.fn(),
}));

vi.mock('../../src/main/agents/subagent-events', () => ({
  setSubagentDeltaDelivery: vi.fn(),
  queueSubagentDelta: vi.fn(),
  flushSubagentDeltas: vi.fn(),
}));

vi.mock('../../src/main/llm/tool-dispatch', () => ({
  executeToolCall: vi.fn(async () => ({ ok: true })),
  genericTerminalExecution: vi.fn((_id: string, name: string, status: string, content: string, reason: string) => ({
    execution: { canonical: { status, data: { reason }, origin: { kind: 'built-in', name } } },
  })),
}));

vi.mock('../../src/main/host/chat/send', () => ({
  startChatTurn: vi.fn(async () => ({ status: 'error', error: 'not exercised', kind: 'provider_required' })),
}));
vi.mock('../../src/main/host/chat/cancel', () => ({
  requestChatCancel: vi.fn(async () => ({ status: 'no_active_stream' })),
}));
vi.mock('../../src/main/host/chat/compaction', () => ({
  compactSessionNow: vi.fn(async () => ({ status: 'nothing_to_compact', sessionId: '' })),
}));
vi.mock('../../src/main/host/chat/abort', () => ({
  forceStopSession: vi.fn(() => false),
  forceAbortMainTurn: vi.fn(),
  discardDeletedSessionRuntime: vi.fn(),
  activeSessionsForProviderConnection: vi.fn(() => []),
  stopActiveProviderConnectionTurns: vi.fn(() => []),
  forceAbortSession: vi.fn(),
  forceAbortChat: vi.fn(),
}));
vi.mock('../../src/main/providers/views', () => ({
  overview: vi.fn(async () => ({ definitions: [], connections: [], statuses: [], secureStorage: { available: false, backend: null, reason: 'unavailable' } })),
  validateConnection: vi.fn(async () => ({})),
  disableConnection: vi.fn(async () => ({})),
  enableConnection: vi.fn(async () => ({})),
  disconnectConnection: vi.fn(async () => ({})),
  deleteConnection: vi.fn(async () => ({})),
  discoverModels: vi.fn(async () => ({})),
  listModelOptions: vi.fn(async () => []),
  refreshQuota: vi.fn(async () => null),
  refreshStatus: vi.fn(async () => null),
  statusView: vi.fn(() => null),
  withConnectionMutationLock: vi.fn((_id: string, task: () => unknown) => Promise.resolve().then(task)),
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { createHostServer, type HostServer } from '../../src/main/host/server';
import type { HostResponse } from '../../src/shared/host/protocol';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { questionStore } from '../../src/main/tools/ask-question/store';
import { forceAbortMainTurn } from '../../src/main/host/chat/abort';

const TOOL_A = '11111111-2222-4333-8444-555555555555';
const TOOL_Q = '99999999-8888-4777-8666-555555555555';
const QUESTIONS = [{ type: 'single', title: 'Choose', options: [{ label: 'A' }] }];
const SELECTION = { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'fake/model' };

interface RecordedEvent {
  ev: string;
  params: Record<string, unknown>;
  seq: number;
}

let tmpRoot: string;
let projectDir: string;
const servers: HostServer[] = [];

function freshServer(): HostServer {
  const created = createHostServer({ serverVersion: 'test' });
  servers.push(created);
  return created;
}

function connect(server: HostServer, clientId: string): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  server.addConnection(clientId, (event) => events.push(event as RecordedEvent));
  return events;
}

async function hello(server: HostServer, clientId: string): Promise<void> {
  const response: HostResponse = await server.handleRequest(
    { id: 0, method: 'host.hello', params: { protocolVersion: 1 } },
    clientId,
  );
  expect(response.ok).toBe(true);
}

function makeSession(ownerId: string): string {
  const manager = mocks.sessionManager as SessionManager;
  const created = manager.create(SELECTION, { cwd: projectDir }, ownerId);
  manager.switchTo(created.id, ownerId);
  return created.id;
}

function createApproval(sessionId: string, ownerClientId: string): Promise<{ decision: string; reason?: string }> {
  return approvalStore.create(
    TOOL_A,
    sessionId,
    'write',
    'destructive',
    { path: 'x' },
    projectDir,
    undefined,
    undefined,
    ownerClientId,
  ) as Promise<{ decision: string; reason?: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-offline-'));
  _clearDbCache();
  mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
  mocks.workspace.cwd = null;
  mocks.workspace.status = 'unbound';
  mocks.workspace.source = 'unbound';
  mocks.draftCwdByClient.clear();
  mocks.trustState.current = 'untrusted';
  mocks.runtimeConfig = {
    default_model: SELECTION,
    session_title_max_wait_seconds: 0,
  } as unknown;
  mocks.configState = { ...defaults, approval_timeout: 600 } as unknown;
  approvalStore.cleanupAll();
  questionStore.cleanupAll();

  projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  mocks.workspace.cwd = projectDir;
  mocks.workspace.status = 'valid';
  mocks.workspace.source = 'sticky';
  mocks.trustState.current = 'trusted';
});

afterEach(() => {
  approvalStore.cleanupAll();
  questionStore.cleanupAll();
  for (const server of servers.splice(0)) server.dispose();
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('HostServer offline approvals (U9)', () => {
  it('keeps an approval pending with zero connected clients — no abort, no settle', async () => {
    freshServer();
    const sessionId = makeSession(OWNER);

    let outcome: { decision: string; reason?: string } | undefined;
    const pending = createApproval(sessionId, OWNER).then((result) => {
      outcome = result;
      return result;
    });

    expect(approvalStore.get(TOOL_A)).toBeDefined();
    expect(approvalStore.get(TOOL_A)?.ownerWindowId).toBe(OWNER);
    expect(outcome).toBeUndefined();
    expect(forceAbortMainTurn).not.toHaveBeenCalled();
    await expect(Promise.race([pending, new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]))
      .resolves.toBe('pending');
  });

  it('settles an undeliverable approval fail-closed at the timeout and a client connected later observes the outcome', async () => {
    vi.useFakeTimers();
    mocks.configState = { ...defaults, approval_timeout: 30 } as unknown;
    const server = freshServer();
    const sessionId = makeSession(OWNER);

    const pending = createApproval(sessionId, OWNER);
    // A client connects while the approval is already pending (not the owner).
    const lateEvents = connect(server, 'conn-late');

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toEqual({ decision: 'denied', reason: 'approval-timeout' });
    expect(approvalStore.get(TOOL_A)).toBeUndefined();
    expect(server.listPendingApprovals(sessionId)).toEqual([]);
    const settled = lateEvents.find((event) => event.ev === 'permission:approval_settled');
    expect(settled).toBeDefined();
    expect(settled?.params).toEqual({
      sessionId,
      toolCallId: TOOL_A,
      result: { decision: 'denied', reason: 'approval-timeout' },
    });
  });

  it('re-delivers a pending approval to a reconnecting owner and its answer completes the flow', async () => {
    const server = freshServer();
    const sessionId = makeSession(OWNER);

    const pending = createApproval(sessionId, OWNER);
    expect(server.listPendingApprovals(sessionId)).toEqual([
      expect.objectContaining({
        toolCallId: TOOL_A,
        sessionId,
        toolName: 'write',
        ownerClientId: OWNER,
        createdAt: expect.any(String) as unknown,
      }),
    ]);

    // Owner reconnects: the pending request is re-delivered immediately.
    const ownerEvents = connect(server, OWNER);
    const redelivered = ownerEvents.find((event) => event.ev === 'permission:approval_requested');
    expect(redelivered).toBeDefined();
    expect(redelivered?.params.toolCallId).toBe(TOOL_A);

    // A different connected client cannot answer (single-owner semantics).
    (mocks.sessionManager as SessionManager).switchTo(sessionId, OTHER);
    connect(server, OTHER);
    await hello(server, OTHER);
    const stranger = await server.handleRequest(
      { id: 1, method: 'permission.approval_answer', params: { toolCallId: TOOL_A, decision: 'approved' } },
      OTHER,
    );
    expect(stranger).toEqual({ id: 1, ok: true, result: { ok: false } });
    expect(approvalStore.get(TOOL_A)).toBeDefined();

    // The owner answers and the flow completes.
    await hello(server, OWNER);
    const answered = await server.handleRequest(
      { id: 2, method: 'permission.approval_answer', params: { toolCallId: TOOL_A, decision: 'approved' } },
      OWNER,
    );
    expect(answered).toEqual({ id: 2, ok: true, result: { ok: true } });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(ownerEvents.find((event) => event.ev === 'permission:approval_settled')).toBeDefined();
  });

  it('keeps an approval pending forever when the timeout is 0 (infinite)', async () => {
    vi.useFakeTimers();
    mocks.configState = { ...defaults, approval_timeout: 0 } as unknown;
    freshServer();
    const sessionId = makeSession(OWNER);

    let outcome: { decision: string; reason?: string } | undefined;
    void createApproval(sessionId, OWNER).then((result) => {
      outcome = result;
      return result;
    });

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(approvalStore.get(TOOL_A)).toBeDefined();
    expect(outcome).toBeUndefined();
  });
});

describe('HostServer offline questions (U9)', () => {
  it('keeps a question pending with zero clients and settles it cancelled at the timeout (fail-closed)', async () => {
    vi.useFakeTimers();
    mocks.configState = { ...defaults, approval_timeout: 5 } as unknown;
    const server = freshServer();
    const sessionId = makeSession(OWNER);

    let outcome: { type: string } | undefined;
    const pending = questionStore.create(TOOL_Q, sessionId, QUESTIONS).then((result) => {
      outcome = result;
      return result;
    });
    expect(questionStore.get(TOOL_Q)).toBeDefined();
    expect(outcome).toBeUndefined();
    expect(forceAbortMainTurn).not.toHaveBeenCalled();

    const laterClient = connect(server, 'conn-late');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({ type: 'cancelled' });
    expect(questionStore.get(TOOL_Q)).toBeUndefined();
    expect(server.listPendingQuestions(sessionId)).toEqual([]);
    const settled = laterClient.find((event) => event.ev === 'ask_question:settled');
    expect(settled).toBeDefined();
    expect(settled?.params).toEqual({ sessionId, toolCallId: TOOL_Q, result: 'cancelled' });
  });

  it('re-delivers a pending question to a reconnecting owner and its answer completes the flow', async () => {
    const server = freshServer();
    const sessionId = makeSession(OWNER);

    const pending = questionStore.create(TOOL_Q, sessionId, QUESTIONS);
    // The owner binding the turn would have established (server forwards by
    // binding the active main-turn window); drive the same store seam.
    expect(questionStore.bindOwnerWindow(TOOL_Q, OWNER)).toBe(true);
    expect(server.listPendingQuestions(sessionId)).toEqual([
      expect.objectContaining({
        toolCallId: TOOL_Q,
        sessionId,
        questions: QUESTIONS,
        ownerClientId: OWNER,
        createdAt: expect.any(String) as unknown,
      }),
    ]);

    const ownerEvents = connect(server, OWNER);
    const redelivered = ownerEvents.find((event) => event.ev === 'ask_question:asked');
    expect(redelivered).toBeDefined();
    expect(redelivered?.params.toolCallId).toBe(TOOL_Q);

    await hello(server, OWNER);
    const answered = await server.handleRequest(
      {
        id: 1,
        method: 'ask_question.answer',
        params: { toolCallId: TOOL_Q, answers: [{ selected: ['A'], text: null, skipped: false }] },
      },
      OWNER,
    );
    expect(answered).toEqual({ id: 1, ok: true, result: { ok: true } });
    await expect(pending).resolves.toMatchObject({ type: 'answered' });
    expect(ownerEvents.find((event) => event.ev === 'ask_question:settled')).toBeDefined();
  });
});
