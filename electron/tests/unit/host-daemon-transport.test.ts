/**
 * U4 — daemon transports over a real UNIX socket, in-process (no Electron
 * import; the HostServer under the transports uses the same core-service
 * mocks as host-server.test.ts).
 *
 * Covers: 0600 socket mode, handshake + request/response round trip, event
 * delivery with per-connection seq, two concurrent clients, and
 * bridgeStdioToSocket via a spawned child node process bridging stdio to the
 * temp server.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';

interface Frame {
  ev?: string;
  params?: unknown;
  seq?: number;
  id?: number | string;
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** A framed test client over a real socket. */
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
      // rejection path: timeout already rejects; waiters resolve handles success
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-daemon-'));
  _clearDbCache();
  mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
  mocks.configState = defaults as unknown;
  server = createHostServer({ serverVersion: 'test' });
  socketPath = path.join(tmpRoot, 'daemon.sock');
  netServer = await serveSocket(socketPath, { server });
});

afterEach(async () => {
  server.dispose();
  await new Promise<void>((resolve) => netServer.close(() => resolve()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  _clearDbCache();
});

describe('serveSocket transport', () => {
  it('creates the socket with mode 0600', () => {
    const mode = fs.statSync(socketPath).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('round-trips handshake and requests over a real socket client', async () => {
    const client = new TestClient(socketPath);
    await client.connected();
    try {
      const hello = await client.request(1, 'host.hello', { protocolVersion: 1 });
      expect(hello.ok).toBe(true);
      expect(hello.result).toMatchObject({ protocolVersion: 1, serverVersion: 'test' });

      const list = await client.request(2, 'session.list');
      expect(list.ok).toBe(true);
      expect(list.result).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('delivers events with a per-connection monotonic seq', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.workspace.source = 'sticky';
    mocks.trustState.current = 'trusted';

    const client = new TestClient(socketPath);
    await client.connected();
    try {
      await client.request(1, 'host.hello', { protocolVersion: 1 });
      await client.request(2, 'session.create');
      const created = await client.next(
        (frame) => frame.ev === 'session:created',
      );
      expect(created.seq).toBeGreaterThanOrEqual(1);
      const workspace = await client.next(
        (frame) => frame.ev === 'session:workspace_changed',
      );
      expect(workspace.seq).toBeGreaterThan(created.seq!);
    } finally {
      client.close();
    }
  });

  it('serves two concurrent clients with independent client ids', async () => {
    const clientA = new TestClient(socketPath);
    const clientB = new TestClient(socketPath);
    await Promise.all([clientA.connected(), clientB.connected()]);
    try {
      const [helloA, helloB] = await Promise.all([
        clientA.request(1, 'host.hello', { protocolVersion: 1 }),
        clientB.request(1, 'host.hello', { protocolVersion: 1 }),
      ]);
      expect(helloA.ok).toBe(true);
      expect(helloB.ok).toBe(true);
      const [listA, listB] = await Promise.all([
        clientA.request(2, 'session.list'),
        clientB.request(2, 'session.list'),
      ]);
      expect(listA.ok).toBe(true);
      expect(listB.ok).toBe(true);
      expect(server.listConnections().length).toBeGreaterThanOrEqual(2);
    } finally {
      clientA.close();
      clientB.close();
    }
  });
});

describe('bridgeStdioToSocket', () => {
  it('pipes stdio to the socket from a spawned node child process', async () => {
    // Bundle a minimal bridge entry (the daemon module's imports are
    // extensionless TS, so the child needs a compiled artifact). The bundle
    // is emitted under dist/ so externalized natives resolve from
    // electron/node_modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild') as typeof import('esbuild');
    const distDir = path.resolve(__dirname, '..', '..', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const bridgeEntry = path.join(distDir, `bridge-entry-${process.pid}.js`);
    const bridgeOut = path.join(distDir, `bridge-bundle-${process.pid}.js`);
    const daemonSource = path.resolve(__dirname, '../../src/main/host/daemon.ts');
    fs.writeFileSync(
      bridgeEntry,
      `const { bridgeStdioToSocket } = require(${JSON.stringify(daemonSource)});\n` +
        `bridgeStdioToSocket(process.argv[2]).catch((error) => { console.error(error); process.exit(1); });\n`,
    );
    esbuild.buildSync({
      entryPoints: [bridgeEntry],
      bundle: true,
      outfile: bridgeOut,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron', 'better-sqlite3', 'node-pty', 'onnxruntime-node', '@huggingface/tokenizers'],
    });

    const child = spawn(process.execPath, [bridgeOut, socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const response = await new Promise<Frame>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`bridge timed out; stderr: ${stderr}`)), 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(buffer.slice(0, index)) as Frame);
        }
      });
      child.stdin.write(encodeMessage({ id: 42, method: 'host.hello', params: { protocolVersion: 1 } }));
    });

    expect(response).toMatchObject({ id: 42, ok: true });
    expect(response.result).toMatchObject({ protocolVersion: 1 });

    child.stdin.end();
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    fs.rmSync(bridgeEntry, { force: true });
    fs.rmSync(bridgeOut, { force: true });
  }, 30_000);

  it('exits non-zero with an actionable message when the daemon is absent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild') as typeof import('esbuild');
    const distDir = path.resolve(__dirname, '..', '..', 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    const bridgeEntry = path.join(distDir, `bridge-entry-missing-${process.pid}.js`);
    const bridgeOut = path.join(distDir, `bridge-bundle-missing-${process.pid}.js`);
    const daemonSource = path.resolve(__dirname, '../../src/main/host/daemon.ts');
    fs.writeFileSync(
      bridgeEntry,
      `const { bridgeStdioToSocket } = require(${JSON.stringify(daemonSource)});\n` +
        `bridgeStdioToSocket(process.argv[2]).catch(() => {});\n`,
    );
    esbuild.buildSync({
      entryPoints: [bridgeEntry],
      bundle: true,
      outfile: bridgeOut,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron', 'better-sqlite3', 'node-pty', 'onnxruntime-node', '@huggingface/tokenizers'],
    });

    const missingPath = path.join(tmpRoot, 'not-listening.sock');
    const child = spawn(process.execPath, [bridgeOut, missingPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('orchid-agent serve --socket');
    fs.rmSync(bridgeEntry, { force: true });
    fs.rmSync(bridgeOut, { force: true });
  }, 30_000);
});
