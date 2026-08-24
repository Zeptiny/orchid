/**
 * U10 — `host.pending_state`: the reconnect-resync accessor for pending
 * approvals/questions over a real socket-served HostServer (host-server test
 * harness seam).
 *
 * Covers: protocol registration, owner-stripped payloads byte-identical to the
 * live store events, session scoping, and the orphaned-owner adoption that
 * keeps a reconnected remote client able to ANSWER what it resumes (a remote
 * host assigns a fresh connection id per attach, so the pendings' old owner
 * can never return).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';

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
  genericTerminalExecution: vi.fn(() => ({ execution: { canonical: {} } })),
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
import { serveSocket } from '../../src/main/host/daemon';
import { encodeMessage } from '../../src/shared/host/framing';
import { lookupHostMethod } from '../../src/shared/host/protocol';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { questionStore } from '../../src/main/tools/ask-question/store';

interface Frame {
  ev?: string;
  params?: unknown;
  seq?: number;
  id?: number | string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** A framed test client over a real socket (host-daemon-transport harness). */
class TestClient {
  readonly socket: net.Socket;
  private buffer = '';
  private readonly waiters: Array<{ resolve: (frame: Frame) => void; test: (frame: Frame) => boolean }> = [];
  readonly frames: Frame[] = [];

  constructor(socketPath: string) {
    this.socket = net.connect(socketPath);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) {
          const frame = JSON.parse(line) as Frame;
          this.frames.push(frame);
          for (let i = 0; i < this.waiters.length; i += 1) {
            if (this.waiters[i].test(frame)) {
              const [waiter] = this.waiters.splice(i, 1);
              waiter.resolve(frame);
              break;
            }
          }
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  connected(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
  }

  send(value: unknown): void {
    this.socket.write(encodeMessage(value));
  }

  request(id: number, method: string, params?: unknown): Promise<Frame> {
    this.send({ id, method, ...(params === undefined ? {} : { params }) });
    return this.next((frame) => frame.id === id && frame.ok !== undefined);
  }

  next(test: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const existing = this.frames.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for frame'));
      }, timeoutMs);
      this.waiters.push({
        test: (frame) => {
          if (test(frame)) {
            clearTimeout(timer);
            return true;
          }
          return false;
        },
        resolve: (frame) => resolve(frame),
      });
      void reject;
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

let tmpRoot: string;
let socketPath: string;
let netServer: net.Server;
let server: HostServer;
let nextRequestId = 100;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-pending-'));
  _clearDbCache();
  mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
  mocks.workspace.cwd = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  mocks.workspace.status = 'valid';
  mocks.workspace.source = 'sticky';
  mocks.trustState.current = 'trusted';
  mocks.configState = defaults as unknown;
  approvalStore.cleanupAll();
  questionStore.cleanupAll();
  server = createHostServer({ serverVersion: 'test' });
  socketPath = path.join(tmpRoot, 'daemon.sock');
  netServer = await serveSocket(socketPath, { server });
});

afterEach(async () => {
  approvalStore.cleanupAll();
  questionStore.cleanupAll();
  server.dispose();
  await new Promise<void>((resolve) => netServer.close(() => resolve()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('host.pending_state (U10)', () => {
  it('is a registered protocol method', () => {
    expect(lookupHostMethod('host.pending_state')).toBeDefined();
  });

  it('returns pending approvals and questions as the live event payloads', async () => {
    const client = new TestClient(socketPath);
    await client.connected();
    try {
      await client.request(1, 'host.hello', { protocolVersion: 1 });
      const created = await client.request(2, 'session.create');
      const sessionId = ((created.result ?? {}) as { id: string }).id;
      (mocks.sessionManager as SessionManager).switchTo(sessionId, 'conn-1');
      await client.request(3, 'session.open', { id: sessionId });

      const APPROVAL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const QUESTION_ID = 'ffffffff-0123-4aaa-8bbb-cccccccccccc';
      void approvalStore.create(APPROVAL_ID, sessionId, 'write', 'destructive', { path: 'x' }, mocks.workspace.cwd as string);
      void questionStore.create(QUESTION_ID, sessionId, [
        { type: 'single', title: 'Continue?', options: [{ label: 'Yes' }] },
      ]);

      const state = await client.request(4, 'host.pending_state', {});
      expect(state.ok).toBe(true);
      const result = (state.result ?? {}) as {
        approvals: Array<{ toolCallId: string; sessionId: string; ownerClientId?: unknown }>;
        questions: Array<{ toolCallId: string; sessionId: string; ownerClientId?: unknown }>;
      };
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0]).toMatchObject({ toolCallId: APPROVAL_ID, sessionId });
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0]).toMatchObject({ toolCallId: QUESTION_ID, sessionId });
      // Owner fields are stripped: this is the live event payload.
      expect(result.approvals[0]).not.toHaveProperty('ownerClientId');
      expect(result.questions[0]).not.toHaveProperty('ownerClientId');
      // Payloads match the original live deliveries the connected client saw.
      const liveApproval = await client.next(
        (frame) => frame.ev === 'permission:approval_requested' && (frame.params as { toolCallId: string }).toolCallId === APPROVAL_ID,
      );
      expect(result.approvals[0]).toEqual(liveApproval.params);

      // Session scoping filters to the requested session.
      const scoped = await client.request(5, 'host.pending_state', {
        sessionId: '00000000-0000-4000-8000-000000000000',
      });
      expect(scoped.ok).toBe(true);
      expect((scoped.result as { approvals: unknown[]; questions: unknown[] }).approvals).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('adopts orphaned pendings for a reconnecting client so it can answer them', async () => {
    const APPROVAL_ID = '12345678-1234-4123-8123-123456789012';
    const first = new TestClient(socketPath);
    await first.connected();
    let sessionId = '';
    try {
      await first.request(1, 'host.hello', { protocolVersion: 1 });
      const created = await first.request(2, 'session.create');
      sessionId = ((created.result ?? {}) as { id: string }).id;
      const settled = approvalStore.create(APPROVAL_ID, sessionId, 'write', 'destructive', {}, mocks.workspace.cwd as string);
      await first.next((frame) => frame.ev === 'permission:approval_requested');
      void settled;
    } finally {
      // The owning connection goes away while the approval stays pending.
      first.close();
    }
    await vi.waitFor(() => expect(server.listConnections()).not.toContain('conn-1'));

    // A reconnecting client (fresh connection id) resumes the pending view…
    const reconnect = new TestClient(socketPath);
    await reconnect.connected();
    try {
      await reconnect.request(1, 'host.hello', { protocolVersion: 1 });
      await reconnect.request(2, 'session.open', { id: sessionId });
      const state = await reconnect.request(3, 'host.pending_state', {});
      const approvals = ((state.result ?? {}) as { approvals: Array<{ toolCallId: string }> }).approvals;
      expect(approvals.map((approval) => approval.toolCallId)).toContain(APPROVAL_ID);

      // …and can answer it: ownership was re-bound to the reconnecting client.
      const answered = await reconnect.request(4, 'permission.approval_answer', {
        toolCallId: APPROVAL_ID,
        decision: 'denied',
      });
      expect(answered).toMatchObject({ ok: true, result: { ok: true } });
      await vi.waitFor(() => expect(server.listPendingApprovals(sessionId)).toHaveLength(0));
    } finally {
      reconnect.close();
    }
  });
});
