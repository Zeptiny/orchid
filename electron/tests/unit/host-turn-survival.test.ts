/**
 * U9 — turn survival on the daemon: a turn accepted by the host runs to
 * completion when its (only) client disconnects mid-stream (R5), and the
 * post-reconnect view reflects the finished work (R6).
 *
 * Real under test: the full chat turn pipeline (host/chat/send.ts through the
 * real agent machine and persistence) behind a real HostServer served over a
 * real UNIX socket — the daemon transport composition from U4.
 *
 * Mocked: the provider stream (a gated fake provider so the test can
 * disconnect mid-stream), the provider runtime + accounting store, and the
 * same core-service seam as host-daemon-transport.test.ts.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const QUESTION_TOOL_ID = '99999999-8888-4777-8666-555555555555';
const QUESTIONS = [{ type: 'single', title: 'Choose', options: [{ label: 'A' }] }];

const mocks = vi.hoisted(() => {
  return {
    sessionManager: null as unknown,
    workspace: { cwd: null as string | null, status: 'unbound', source: 'unbound' },
    trustState: { current: 'untrusted' as 'trusted' | 'untrusted' | 'changed' },
    draftCwdByClient: new Map<string, string | null>(),
    runtimeConfig: null as unknown,
    configState: null as unknown,
    streamGate: null as null | { release: () => void; released: Promise<void> },
  };
});

// ── Core service mocks (same seam as host-daemon-transport.test.ts) ──────────

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
  inspectProjectDirectory: (dir: string) => ({
    status: fs.existsSync(dir) ? 'valid' : 'missing',
    path: dir,
  }),
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
  acquireProjectMCPManager: vi.fn(() => ({ getTools: () => [] })),
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

// The provider seam: a gated fake provider so the client can disconnect
// mid-stream and the turn must still finish on the host.
vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: vi.fn(async function* () {
    yield { type: 'content', text: 'partial' };
    const gate = mocks.streamGate;
    if (gate) await gate.released;
    yield { type: 'content', text: ' finished-on-host' };
    yield { type: 'finish', finishReason: 'stop' };
  }),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => ({
    resolveTierContext: vi.fn(async () => ({ connection: { cacheTtl: null }, tierMechanism: undefined })),
    resolveExecution: vi.fn(async () => ({
      modelInstance: {},
      snapshot: { providerId: 'fake-provider', protocol: 'openai' },
      pricingFacet: undefined,
      thinkingPolicy: undefined,
      cacheFacet: undefined,
      tierMechanism: undefined,
      buildReasoningOptions: undefined,
      model: { limits: null, capabilities: {} },
      connection: { cacheTtl: null },
    })),
  }),
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: vi.fn(() => ({})),
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
import { activeAgents } from '../../src/main/host/chat/state';
import { questionStore } from '../../src/main/tools/ask-question/store';

const SELECTION = { connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'fake/model' };

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

  constructor(private readonly socketPath: string) {
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

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-turn-survival-'));
  _clearDbCache();
  mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  mocks.workspace.cwd = projectDir;
  mocks.workspace.status = 'valid';
  mocks.workspace.source = 'sticky';
  mocks.trustState.current = 'trusted';
  mocks.draftCwdByClient.clear();
  mocks.runtimeConfig = {
    ...defaults,
    default_model: SELECTION,
    session_title_max_wait_seconds: 0,
  } as unknown;
  mocks.configState = { ...defaults } as unknown;
  questionStore.cleanupAll();

  let releaseGate!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  mocks.streamGate = { release: releaseGate, released };

  server = createHostServer({ serverVersion: 'test' });
  socketPath = path.join(tmpRoot, 'daemon.sock');
  netServer = await serveSocket(socketPath, { server });
});

afterEach(async () => {
  questionStore.cleanupAll();
  server.dispose();
  await new Promise<void>((resolve) => netServer.close(() => resolve()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('turn survival across client disconnect (U9)', () => {
  it('completes an in-flight turn when the only client disconnects mid-stream', async () => {
    const client = new TestClient(socketPath);
    let sessionId = '';
    try {
      await client.request(1, 'host.hello', { protocolVersion: 1 });
      const created = await client.request(2, 'session.create');
      expect(created.ok).toBe(true);
      sessionId = ((created.result ?? {}) as { id: string }).id;

      const opened = await client.request(3, 'session.open', { id: sessionId });
      expect(opened.ok).toBe(true);

      const sent = await client.request(4, 'chat.send', { message: 'keep working', sessionId });
      expect(sent.ok).toBe(true);
      expect(sent.result).toMatchObject({ status: 'started' });

      // Streaming is live and its events reach the connected client…
      const chunk = await client.next((frame) => frame.ev === IPC_CHANNELS.CHAT_CHUNK);
      expect((chunk.params as { data?: string }).data).toBe('partial');
    } finally {
      // …then the only client goes away mid-stream.
      client.close();
    }

    // The connection is gone; the turn is still running host-side.
    await vi.waitFor(() => expect(server.listConnections()).toHaveLength(0));
    expect(activeAgents.get(sessionId)).toBeDefined();

    // A question asked while nobody is connected stays pending (accessor view).
    void questionStore.create(QUESTION_TOOL_ID, sessionId, QUESTIONS);
    await vi.waitFor(() => {
      const pending = server.listPendingQuestions(sessionId);
      expect(pending).toHaveLength(1);
      // The in-flight turn's (now disconnected) window owns the question.
      expect(pending[0]?.ownerClientId).toBe('conn-1');
      expect(typeof pending[0]?.createdAt).toBe('string');
    });

    // Release the provider: the turn must finish without any client attached.
    mocks.streamGate?.release();
    await vi.waitFor(() => expect(activeAgents.get(sessionId)).toBeUndefined());

    // A reconnecting client resumes the completed view.
    const reconnect = new TestClient(socketPath);
    await reconnect.connected();
    try {
      await reconnect.request(1, 'host.hello', { protocolVersion: 1 });
      const reopened = await reconnect.request(2, 'session.open', { id: sessionId });
      expect(reopened.ok).toBe(true);
      const result = (reopened.result ?? {}) as {
        messages: Array<{ role: string; content: string }>;
        session: { chains: Array<{ status: string }> };
      };
      const contents = result.messages.map((message) => message.content).join('');
      expect(contents).toContain('partial finished-on-host');
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      expect(result.session.chains.at(-1)?.status).toBe('completed');
      // The pending question outlived the disconnect and is still listed.
      expect(server.listPendingQuestions(sessionId)).toHaveLength(1);
    } finally {
      reconnect.close();
    }
  }, 20_000);
});
