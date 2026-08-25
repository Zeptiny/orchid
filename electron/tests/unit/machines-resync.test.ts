/**
 * U10 — reconnect resync for remote machines (requirement R6).
 *
 * Real under test: a real HostServer served over a real UNIX socket, driven
 * through the REAL machine-client attach path (`remote-clients.ts`) with a
 * socket transport that can be killed and revived — the composition
 * `ipc/machines.ts` installs on every (re)connect. After the drop + re-attach:
 *
 * - the resync broadcast reaches the window whose active machine is the
 *   remote (pending approvals + questions as the same event payloads);
 * - the snapshot matches what a FRESH connection sees (fresh-open parity);
 * - NO pre-disconnect event object is re-delivered across the gap: the fresh
 *   client's per-connection seq starts over (never replayed from the gap).
 *
 * Mocked: the core-service seam (host-server harness) and electron's
 * BrowserWindow (one fake window per test).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import type { HostTransport } from '../../src/main/host/transport';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { RemoteMachineRecord } from '../../src/shared/types/machine';

const WINDOW_ID = 7;
const T0 = '2026-08-23T00:00:00.000Z';
const MACHINE: RemoteMachineRecord = {
  id: 'build-1',
  label: 'Build server',
  kind: 'ssh',
  host: 'build.example.com',
  port: 22,
  user: '',
  agentCommand: 'orchid-agent',
  created_at: T0,
  updated_at: T0,
};

const mocks = vi.hoisted(() => {
  type FakeWindow = {
    isDestroyed: () => boolean;
    webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  };
  return {
    sessionManager: null as unknown,
    workspace: { cwd: null as string | null, status: 'unbound', source: 'unbound' },
    trustState: { current: 'untrusted' as 'trusted' | 'untrusted' | 'changed' },
    draftCwdByClient: new Map<string, string | null>(),
    runtimeConfig: { default_model: null as unknown },
    configState: null as unknown,
    windows: [] as FakeWindow[],
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

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
    source: opts.sessionCwd ? 'session' : 'default',
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
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';
import { approvalStore } from '../../src/main/permissions/approval-store';
import { questionStore } from '../../src/main/tools/ask-question/store';
import {
  attachRemoteMachineClient,
  detachAllRemoteMachineClients,
} from '../../src/main/machines/remote-clients';
import { resyncRemoteMachine, fetchRemoteResyncSnapshot } from '../../src/main/machines/resync';
import { clearActiveMachine, setActiveMachine } from '../../src/main/host/routing';
import type { HostClient } from '../../src/main/host/client';

/** Line-protocol HostTransport over a real socket; killable and re-creatable. */
class SocketTransport implements HostTransport {
  private buffer = '';
  private dataCb: ((line: string) => void) | null = null;
  private readonly closeCallbacks: Array<() => void> = [];
  readonly socket: net.Socket;

  constructor(socketPath: string) {
    this.socket = net.connect(socketPath);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) this.dataCb?.(line);
        index = this.buffer.indexOf('\n');
      }
    });
    this.socket.on('error', () => {
      // close follows; never crash the test runner on destroy races
    });
    this.socket.on('close', () => {
      for (const callback of this.closeCallbacks.splice(0)) callback();
    });
  }

  write(line: string): void {
    this.socket.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  onData(cb: (line: string) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCallbacks.push(cb);
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Minimal framed probe client for fresh-open parity checks. */
class ProbeClient {
  private transport: SocketTransport;
  private nextId = 0;

  constructor(socketPath: string) {
    this.transport = new SocketTransport(socketPath);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.nextId += 1;
    const id = this.nextId;
    const response = await new Promise<{ ok?: boolean; result?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe request '${method}' timed out`)), 10_000);
      this.transport.onData((line) => {
        const frame = JSON.parse(line) as { id?: number; ok?: boolean; result?: unknown };
        if (frame.id !== id || frame.ok === undefined) return;
        clearTimeout(timer);
        resolve(frame);
      });
      this.transport.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    });
    if (response.ok !== true) throw new Error(`probe request '${method}' failed`);
    return response.result as T;
  }

  close(): void {
    this.transport.close();
  }
}

let tmpRoot: string;
let socketPath: string;
let netServer: net.Server;
let server: HostServer;
let sentToWindow: Array<{ channel: string; payload: unknown }>;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machines-resync-'));
  _clearDbCache();
  mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
  mocks.workspace.cwd = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  mocks.workspace.status = 'valid';
  mocks.workspace.source = 'default';
  mocks.trustState.current = 'trusted';
  mocks.configState = defaults as unknown;
  approvalStore.cleanupAll();
  questionStore.cleanupAll();

  const send = vi.fn();
  sentToWindow = [];
  send.mockImplementation((channel: string, payload: unknown) => {
    sentToWindow.push({ channel, payload });
  });
  mocks.windows.length = 0;
  mocks.windows.push({
    isDestroyed: () => false,
    webContents: { id: WINDOW_ID, isDestroyed: () => false, send },
  });
  setActiveMachine(String(WINDOW_ID), MACHINE.id);

  server = createHostServer({ serverVersion: 'test' });
  socketPath = path.join(tmpRoot, 'daemon.sock');
  netServer = await serveSocket(socketPath, { server });
});

afterEach(async () => {
  detachAllRemoteMachineClients();
  clearActiveMachine(String(WINDOW_ID));
  approvalStore.cleanupAll();
  questionStore.cleanupAll();
  server.dispose();
  await new Promise<void>((resolve) => netServer.close(() => resolve()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function connectionIds(): Promise<string[]> {
  return vi.waitFor(
    () => {
      const ids = server.listConnections();
      if (ids.length === 0) throw new Error('no connections yet');
      return ids;
    },
    { timeout: 5000 },
  );
}

describe('remote reconnect resync (U10)', () => {
  it(
    're-attaching resyncs the active window with fresh-open parity and no stale replay across the gap',
    async () => {
      const APPROVAL_ID = 'abcdefab-cdef-4cde-8cde-abcdefabcdef';
      const QUESTION_ID = '01234567-89ab-4cde-8cde-0123456789ab';

      // ── Attach #1: the machine client over a live socket. ──────────────────
      const transport1 = new SocketTransport(socketPath);
      const client1 = attachRemoteMachineClient(MACHINE, transport1);
      const [conn1] = await connectionIds();

      // Create + open the session through the machine client (what the window did).
      const created = await client1.request<{ id: string }>('session.create');
      const sessionId = created.id;
      await client1.request('session.open', { id: sessionId });

      // Pending approval + question raised while the window is connected: the
      // owner is the machine client's connection (conn-1).
      // riskClass must be a wire RiskClass: the machine client validates
      // inbound event payloads against the protocol registries (#16).
      void approvalStore.create(APPROVAL_ID, sessionId, 'write', 'mutation', {}, mocks.workspace.cwd as string);
      void questionStore.create(QUESTION_ID, sessionId, [
        { type: 'single', title: 'Continue?', options: [{ label: 'Yes' }] },
      ]);
      await vi.waitFor(() =>
        expect(sentToWindow.filter((entry) => entry.channel === IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED)).toHaveLength(1),
      );

      // A distinctive pre-disconnect event, delivered with the gap's seq range.
      const preDisconnectEvents: Array<{ params: unknown; seq: number }> = [];
      client1.subscribe('session:renamed', (params, seq) => preDisconnectEvents.push({ params, seq }));
      const stalePayload = { id: sessionId, name: 'renamed-before-drop' };
      server.emitTo(conn1, 'session:renamed', stalePayload);
      await vi.waitFor(() => expect(preDisconnectEvents).toHaveLength(1));
      const preDisconnectSeq = preDisconnectEvents[0]?.seq ?? 0;
      expect(preDisconnectSeq).toBeGreaterThanOrEqual(1);

      // ── Drop: the transport dies; the client detaches. ─────────────────────
      const sendsBeforeDrop = sentToWindow.length;
      transport1.close();
      await vi.waitFor(() => expect(client1.isAlive()).toBe(false));
      expect(server.listConnections()).not.toContain(conn1);

      // ── Reconnect: fresh transport, fresh client (ipc/machines wiring). ────
      const transport2 = new SocketTransport(socketPath);
      const client2 = attachRemoteMachineClient(MACHINE, transport2);
      const postReconnectEvents: Array<{ params: unknown; seq: number }> = [];
      const allConn2Seqs: number[] = [];
      client2.subscribe('session:renamed', (params, seq) => {
        postReconnectEvents.push({ params, seq });
        allConn2Seqs.push(seq);
      });
      client2.subscribe('session:workspace_changed', (_params, seq) => allConn2Seqs.push(seq));
      const [conn2] = await connectionIds();
      expect(conn2).not.toBe(conn1);

      // The renderer's forced re-open lands FIRST (ChatView resync path), so
      // the host's active session for the machine client is restored before
      // the session-scoped catch-up runs.
      await client2.request('session.open', { id: sessionId });

      const snapshot = await resyncRemoteMachine(MACHINE.id, client2);

      // ── The resync broadcast reached the active window. ─────────────────────
      const approvalBroadcasts = sentToWindow
        .slice(sendsBeforeDrop)
        .filter((entry) => entry.channel === IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED);
      const questionBroadcasts = sentToWindow
        .slice(sendsBeforeDrop)
        .filter((entry) => entry.channel === IPC_CHANNELS.ASK_QUESTION_ASKED);
      expect(approvalBroadcasts).toHaveLength(1);
      expect(questionBroadcasts).toHaveLength(1);
      expect((approvalBroadcasts[0]?.payload as { toolCallId: string }).toolCallId).toBe(APPROVAL_ID);
      expect((questionBroadcasts[0]?.payload as { toolCallId: string }).toolCallId).toBe(QUESTION_ID);

      // ── Fresh-open parity: a brand-new connection sees the same pending
      // payloads the resync broadcast delivered (deep compare).
      const fresh = new ProbeClient(socketPath);
      try {
        await fresh.request('host.hello', { protocolVersion: 1 });
        const pending = await fresh.request<{ approvals: unknown[]; questions: unknown[] }>(
          'host.pending_state',
          {},
        );
        expect(pending.approvals).toEqual([approvalBroadcasts[0]?.payload]);
        expect(pending.questions).toEqual([questionBroadcasts[0]?.payload]);
      } finally {
        fresh.close();
      }

      // ── Snapshot content: the host reports the machine's session + pending.
      expect(snapshot.sessionIds).toContain(sessionId);
      expect(snapshot.activeSessionId).toBe(sessionId);
      expect(snapshot.approvals.map((approval) => approval.toolCallId)).toEqual([APPROVAL_ID]);
      expect(snapshot.questions.map((question) => question.toolCallId)).toEqual([QUESTION_ID]);

      // ── Seq discipline: events never replay across the gap. ────────────────
      // The fresh client's per-connection counter starts over: everything it
      // observes is a dense 1..N sequence, not a continuation of the
      // pre-disconnect connection's numbering (which was strictly higher).
      server.emitTo(conn2, 'session:renamed', { id: sessionId, name: 'after-reconnect' });
      server.emitTo(conn2, 'session:renamed', { id: sessionId, name: 'after-reconnect-2' });
      await vi.waitFor(() => expect(postReconnectEvents).toHaveLength(2));
      const expectedSeqs = Array.from(
        { length: client2.lastSeq() },
        (_value, index) => index + 1,
      );
      expect([...allConn2Seqs].sort((a, b) => a - b)).toEqual(expectedSeqs);
      // The pre-disconnect connection was further along than the fresh one —
      // a continuation would have produced strictly higher sequence numbers.
      expect(client2.lastSeq()).toBeLessThan(preDisconnectSeq);

      // No pre-disconnect event OBJECT is delivered post-reconnect: neither
      // the window nor the fresh client saw the stale payload again.
      const windowSendsAfterReconnect = sentToWindow.slice(sendsBeforeDrop);
      expect(windowSendsAfterReconnect.some((entry) => entry.payload === stalePayload)).toBe(false);
      expect(
        postReconnectEvents.some((event) => event.params === preDisconnectEvents[0]?.params),
      ).toBe(false);
      expect(
        windowSendsAfterReconnect.some((entry) =>
          entry.channel === 'session:renamed'
          && (entry.payload as { name?: string }).name === 'renamed-before-drop',
        ),
      ).toBe(false);
    },
    20_000,
  );

  it('scopes nothing to windows on other machines', async () => {
    const transport = new SocketTransport(socketPath);
    const client = attachRemoteMachineClient(MACHINE, transport);
    await connectionIds();

    // A different machine's window must never see this machine's catch-up.
    setActiveMachine(String(WINDOW_ID), 'other-machine');
    const snapshot = await resyncRemoteMachine(MACHINE.id, client);
    expect(snapshot.approvals).toEqual([]);
    expect(sentToWindow).toEqual([]);
    clearActiveMachine(String(WINDOW_ID));
    setActiveMachine(String(WINDOW_ID), MACHINE.id);
  });
});

// ── Stubbed-host catch-up: fetch shape + per-piece degradation (#19/#22) ─────

describe('remote resync fetch (stubbed host client)', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';

  interface StubPiece {
    readonly result?: unknown;
    readonly reject?: Error;
  }

  /** HostClient stub answering a scripted method table; records every call. */
  function stubClient(pieces: Record<string, StubPiece>) {
    const request = vi.fn(async (method: string) => {
      const piece = pieces[method];
      if (piece?.reject) throw piece.reject;
      if (piece && 'result' in piece) return piece.result;
      throw new Error(`stub has no answer for '${method}'`);
    });
    return { request } as unknown as HostClient;
  }

  const approval = {
    toolCallId: 'abcdefab-cdef-4cde-8cde-abcdefabcdef',
    sessionId: S1,
    toolName: 'write',
    riskClass: 'mutation',
    args: {},
    cwd: '/tmp/project',
  };
  const question = {
    sessionId: S1,
    toolCallId: '01234567-89ab-4cde-8cde-0123456789ab',
    questions: [{ type: 'single', title: 'Continue?', options: [{ label: 'Yes' }] }],
  };

  beforeEach(() => {
    sentToWindow = [];
    setActiveMachine(String(WINDOW_ID), MACHINE.id);
  });

  afterEach(() => {
    clearActiveMachine(String(WINDOW_ID));
  });

  it('builds the catch-up from session.list + host.pending_state without any chat.snapshot (#19)', async () => {
    const client = stubClient({
      'session.list': { result: [{ id: S1 }, { id: S2 }] },
      'host.pending_state': {
        result: {
          approvals: [approval],
          questions: [question],
          activeSession: { sessionId: S1, live: { state: 'streaming', startedAt: 1234 } },
        },
      },
      'subagents.snapshot': { result: { records: [{ status: 'running' }, { status: 'completed' }] } },
      'bgcmd.list': { result: [{ running: true }] },
    });

    const snapshot = await resyncRemoteMachine(MACHINE.id, client);

    // The catch-up answers from the lightweight pieces only — no whole-history
    // serialization over SSH.
    const methods = (client.request as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m as string);
    expect(methods).toEqual(
      expect.arrayContaining(['session.list', 'host.pending_state', 'subagents.snapshot', 'bgcmd.list']),
    );
    expect(methods).not.toContain('chat.snapshot');

    expect(snapshot.sessionIds).toEqual([S1, S2]);
    expect(snapshot.activeSessionId).toBe(S1);
    expect(snapshot.liveTurn).toEqual({ state: 'streaming', startedAt: 1234 });
    expect(snapshot.liveSubagentCount).toBe(1);
    expect(snapshot.hasBackgroundCommands).toBe(true);
    expect(snapshot.approvals).toEqual([approval]);
    expect(snapshot.questions).toEqual([question]);

    // The broadcast still reaches the machine's window with the same payloads.
    expect(sentToWindow).toEqual(
      expect.arrayContaining([
        { channel: IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED, payload: approval },
        { channel: IPC_CHANNELS.ASK_QUESTION_ASKED, payload: question },
        { channel: IPC_CHANNELS.BG_CMD_CHANGED, payload: { sessionId: S1 } },
        { channel: IPC_CHANNELS.SESSION_SUBAGENTS_CHANGED, payload: undefined },
      ]),
    );
  });

  it('degrades to "no active session" when the host omits the pending-state activeSession slice (#19)', async () => {
    const client = stubClient({
      'session.list': { result: [{ id: S1 }] },
      'host.pending_state': { result: { approvals: [], questions: [] } },
    });

    const snapshot = await fetchRemoteResyncSnapshot(client);
    expect(snapshot.sessionIds).toEqual([S1]);
    expect(snapshot.activeSessionId).toBeNull();
    expect(snapshot.liveTurn).toBeNull();
    expect(snapshot.liveSubagentCount).toBe(0);
    expect(snapshot.hasBackgroundCommands).toBe(false);
    // The session-scoped pieces are never requested without an active session.
    const methods = (client.request as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m as string);
    expect(methods).not.toContain('subagents.snapshot');
    expect(methods).not.toContain('bgcmd.list');
  });

  it('one failing piece never kills the catch-up or the approvals re-broadcast (#22)', async () => {
    const client = stubClient({
      'session.list': { result: [{ id: S1 }] },
      'host.pending_state': {
        result: {
          approvals: [approval],
          questions: [],
          activeSession: { sessionId: S1, live: null },
        },
      },
      'subagents.snapshot': { reject: new Error('subagent store wedged') },
      'bgcmd.list': { result: [{ running: true }] },
    });

    const snapshot = await resyncRemoteMachine(MACHINE.id, client);

    // The failing piece degraded to its empty value…
    expect(snapshot.liveSubagentCount).toBe(0);
    // …while every other piece still populated…
    expect(snapshot.sessionIds).toEqual([S1]);
    expect(snapshot.activeSessionId).toBe(S1);
    expect(snapshot.hasBackgroundCommands).toBe(true);
    // …and the approvals re-broadcast still fired.
    expect(sentToWindow).toContainEqual({
      channel: IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED,
      payload: approval,
    });
  });

  it('a failing host.pending_state still resolves the catch-up with the session list (#22)', async () => {
    const client = stubClient({
      'session.list': { result: [{ id: S1 }, { id: S2 }] },
      'host.pending_state': { reject: new Error('older agent without pending_state') },
    });

    const snapshot = await resyncRemoteMachine(MACHINE.id, client);
    expect(snapshot.sessionIds).toEqual([S1, S2]);
    expect(snapshot.activeSessionId).toBeNull();
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.questions).toEqual([]);
    // No approval/question was broadcast — none could be fetched — and the
    // resync still resolved instead of rejecting.
    expect(sentToWindow.filter((entry) =>
      entry.channel === IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED
      || entry.channel === IPC_CHANNELS.ASK_QUESTION_ASKED,
    )).toEqual([]);
  });
});
