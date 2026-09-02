/**
 * U4 — HostServer dispatch + representative real bindings, in-process (no
 * transport, no Electron import).
 *
 * Real under test: HostServer (dispatch, handshake gating, capability gates,
 * event plumbing) plus a real SessionManager on temp SQLite storage for the
 * session/config/permission bindings.
 *
 * Mocked (the Electron app shell and process singletons it owns, following
 * the trusted-project-gates seam): session/singleton, project workspace +
 * trust + runtime registry, mcp/rag/ast services, tool registries, and the
 * chat pipeline entry points whose IPC-level behavior has its own suites.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '../../src/main/config/schema';

const CLIENT_ID = 'conn-1';

const mocks = vi.hoisted(() => {
  return {
    sessionManager: null as unknown,
    workspace: { cwd: null as string | null, status: 'unbound', source: 'unbound' },
    trustState: { current: 'untrusted' as 'trusted' | 'untrusted' | 'changed' },
    draftCwdByClient: new Map<string, string | null>(),
    runtimeConfig: { default_model: null as unknown },
    configState: null as unknown,
    todoNotifier: null as null | ((sessionId: string | null) => void),
    subagentDeltaDelivery: null as unknown,
    subagentsChangedBroadcast: null as null | ((sessionId: string) => void),
    workingSetBroadcast: null as null | ((snapshot: unknown, sourceOwnerId: string) => void),
    activityBroadcast: null as null | ((activity: unknown) => void),
    indexAutoRefreshNotifier: null as null | ((projectPath: string, event: unknown) => void),
  };
});

// ── Core service mocks ───────────────────────────────────────────────────────

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
  setIndexAutoRefreshNotifier: vi.fn((notifier: unknown) => {
    mocks.indexAutoRefreshNotifier = notifier as null;
  }),
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
  setTodosChangedNotifier: vi.fn((notifier: (sessionId: string | null) => void) => {
    mocks.todoNotifier = notifier;
  }),
  getSkillsRegistry: () => new Map(),
  getBuiltinToolRegistryForRuntime: vi.fn(() => null),
  createBuiltinToolRegistry: vi.fn(() => null),
  registerBuiltinTools: vi.fn(),
}));

vi.mock('../../src/main/session/working-set-live', () => ({
  setWorkingSetBroadcast: vi.fn((broadcast: unknown) => {
    mocks.workingSetBroadcast = broadcast as null;
  }),
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
  setSubagentsChangedBroadcast: vi.fn((broadcast: unknown) => {
    mocks.subagentsChangedBroadcast = broadcast as null;
  }),
  flushSubagentPersistence: vi.fn(),
  disposeSubagentPersistence: vi.fn(),
  wireSubagentRuntime: vi.fn(),
}));

vi.mock('../../src/main/agents/subagent-events', () => ({
  setSubagentDeltaDelivery: vi.fn((delivery: unknown) => {
    mocks.subagentDeltaDelivery = delivery;
  }),
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
}));
vi.mock('../../src/main/providers/views', () => ({
  overview: vi.fn(async () => ({ definitions: [], connections: [], statuses: [], secureStorage: { available: false, backend: null, reason: 'unavailable' } })),
  createConnectionIntent: vi.fn(async () => ({ connection: { id: '00000000-0000-4000-8000-000000000061' }, message: null })),
  updateConnectionIntent: vi.fn(async () => ({ connection: { id: '00000000-0000-4000-8000-000000000062' }, message: null })),
  submitConnectionApiKey: vi.fn(async () => ({ connection: { id: '00000000-0000-4000-8000-000000000063' }, message: null })),
  requireConnection: vi.fn(async (id: string) => ({ id, authMethod: 'environment' })),
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

import { createHostServer, LOCAL_HOST_CAPABILITIES, type HostServer } from '../../src/main/host/server';
import type { HostResponse } from '../../src/shared/host/protocol';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache } from '../../src/main/session/storage';

let tmpRoot: string;
let server: HostServer;
const events: Array<{ ev: string; params: unknown; seq: number }> = [];

function freshServer(): HostServer {
  events.length = 0;
  const created = createHostServer({ serverVersion: 'test' });
  created.addConnection(CLIENT_ID, (event) => events.push(event));
  return created;
}

async function call(
  host: HostServer,
  method: string,
  params?: unknown,
  clientId = CLIENT_ID,
): Promise<HostResponse> {
  return host.handleRequest({ id: 1, method, params }, clientId);
}

async function hello(host: HostServer, protocolVersion = 1): Promise<HostResponse> {
  return host.handleRequest(
    { id: 0, method: 'host.hello', params: { protocolVersion } },
    CLIENT_ID,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-host-server-'));
  _clearDbCache();
  mocks.sessionManager = new SessionManager({ storage: { dbPath: path.join(tmpRoot, 'sessions.db') } });
  mocks.workspace.cwd = null;
  mocks.workspace.status = 'unbound';
  mocks.workspace.source = 'unbound';
  mocks.draftCwdByClient.clear();
  mocks.trustState.current = 'untrusted';
  mocks.runtimeConfig = { default_model: null };
  mocks.configState = { ...defaults, ...{} } as unknown;
  server = freshServer();
});

afterEach(() => {
  server.dispose();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('HostServer handshake', () => {
  it('answers host.hello with the protocol version and daemon capabilities', async () => {
    const response = await hello(server);
    expect(response).toEqual({
      id: 0,
      ok: true,
      result: {
        protocolVersion: 1,
        serverVersion: 'test',
        capabilities: ['config.write', 'providers.read'],
      },
    });
  });

  it('rejects a protocol version mismatch with PROTOCOL_MISMATCH', async () => {
    const response = await hello(server, 99);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('PROTOCOL_MISMATCH');
    }
  });

  it('refuses every other method before the handshake (typed error)', async () => {
    const response = await call(server, 'session.list');
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('HANDSHAKE_REQUIRED');
    }
  });

  it('accepts methods once hello succeeded — including requests pipelined behind it', async () => {
    // Pipelined on one tick: hello + follow-up must both pass (the handshake
    // flag flips synchronously during dispatch).
    const [helloResponse, listResponse] = await Promise.all([
      hello(server),
      call(server, 'session.list'),
    ]);
    expect(helloResponse.ok).toBe(true);
    expect(listResponse).toEqual({ id: 1, ok: true, result: [] });
  });
});

describe('HostServer dispatch', () => {
  beforeEach(async () => {
    await hello(server);
  });

  it('answers unknown methods with METHOD_NOT_FOUND', async () => {
    const response = await call(server, 'machines.list');
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('METHOD_NOT_FOUND');
    }
  });

  it('answers the credential-carrying draft discovery with METHOD_NOT_FOUND (absent from the registry)', async () => {
    const response = await call(server, 'providers.discover_draft_models', {});
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('METHOD_NOT_FOUND');
    }
  });

  it('answers invalid params with INVALID_PARAMS', async () => {
    const response = await call(server, 'session.rename', { id: 'not-a-uuid', name: 5 });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_PARAMS');
    }
  });

  it('maps thrown errors to INTERNAL', async () => {
    const response = await call(server, 'session.create');
    // No workspace bound → the binding throws a plain Error.
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INTERNAL');
      expect(response.error.message).toMatch(/no project folder selected/i);
    }
  });

  it('gates session.pick_project_dir behind the session capability (daemon declares neither)', async () => {
    for (const method of ['session.pick_project_dir', 'definition.reveal']) {
      const response = await call(server, method, method === 'definition.reveal' ? { path: '/x' } : undefined);
      expect(response.ok, method).toBe(false);
      if (!response.ok) {
        expect(response.error.code, method).toBe('UNSUPPORTED_ON_HOST');
      }
    }
  });

  it('answers host.hello with the daemon capabilities by default and the local set when asked', async () => {
    await expect(hello(server)).resolves.toMatchObject({
      ok: true,
      result: { capabilities: ['config.write', 'providers.read'] },
    });
    const localHost = createHostServer({ serverVersion: 'test', capabilities: LOCAL_HOST_CAPABILITIES });
    try {
      await expect(hello(localHost)).resolves.toMatchObject({
        ok: true,
        result: { capabilities: ['config.write', 'providers.read', 'providers.vault-writes'] },
      });
    } finally {
      localHost.dispose();
    }
  });
});

describe('HostServer provider credential-write gates', () => {
  const CONNECTION = '00000000-0000-4000-8000-000000000051';

  beforeEach(async () => {
    await hello(server);
  });

  it('a daemon-default server rejects submit_api_key and api-key intents with UNSUPPORTED_ON_HOST', async () => {
    const { createConnectionIntent, updateConnectionIntent, submitConnectionApiKey }
      = await import('../../src/main/providers/views');
    for (const [method, params] of [
      ['providers.submit_api_key', { connectionId: CONNECTION, apiKey: 'sk-x' }],
      ['providers.create', {
        providerId: 'openai', name: 'X', protocol: 'openai-compatible',
        authMethod: 'api-key', modelIds: ['gpt-5/test'],
      }],
      ['providers.update', { connectionId: CONNECTION, authMethod: 'api-key' }],
    ] as const) {
      const response = await call(server, method, params);
      expect(response.ok, method).toBe(false);
      if (!response.ok) {
        expect(response.error.code, method).toBe('UNSUPPORTED_ON_HOST');
        expect(response.error.message, method).toMatch(/environment-variable/i);
      }
    }
    // The gate fires BEFORE any mutation core runs — nothing is persisted or
    // validated on a host that cannot store credentials.
    expect(submitConnectionApiKey).not.toHaveBeenCalled();
    expect(createConnectionIntent).not.toHaveBeenCalled();
    expect(updateConnectionIntent).not.toHaveBeenCalled();
  });

  it('a daemon-default server lets an already-api-key connection take metadata-only updates', async () => {
    const { requireConnection } = await import('../../src/main/providers/views');
    vi.mocked(requireConnection).mockResolvedValueOnce({
      id: CONNECTION,
      authMethod: 'api-key',
    } as never);
    // No transition to api-key auth (the connection already is one): the
    // rename passes the daemon gate and reaches the update core.
    const updated = await call(server, 'providers.update', {
      connectionId: CONNECTION,
      authMethod: 'api-key',
      name: 'Renamed remote draft',
    });
    expect(updated).toMatchObject({ ok: true, result: { connection: { id: '00000000-0000-4000-8000-000000000062' } } });
  });

  it('a daemon-default server serves environment-auth create and plain updates', async () => {
    const created = await call(server, 'providers.create', {
      providerId: 'openai',
      name: 'Env on daemon',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      modelIds: ['gpt-5/test'],
      environmentVariable: 'OPENAI_API_KEY',
    });
    expect(created).toMatchObject({ ok: true, result: { connection: { id: '00000000-0000-4000-8000-000000000061' } } });

    const updated = await call(server, 'providers.update', { connectionId: CONNECTION, name: 'Renamed' });
    expect(updated).toMatchObject({ ok: true, result: { connection: { id: '00000000-0000-4000-8000-000000000062' } } });
  });

  it('a vault-writes host dispatches submit_api_key and api-key create to the cores', async () => {
    const localHost = createHostServer({ serverVersion: 'test', capabilities: LOCAL_HOST_CAPABILITIES });
    try {
      await hello(localHost);
      const submitted = await localHost.handleRequest(
        { id: 1, method: 'providers.submit_api_key', params: { connectionId: CONNECTION, apiKey: 'sk-x' } },
        CLIENT_ID,
      );
      expect(submitted).toMatchObject({
        ok: true,
        result: { connection: { id: '00000000-0000-4000-8000-000000000063' } },
      });
      const created = await localHost.handleRequest(
        { id: 2, method: 'providers.create', params: {
          providerId: 'openai', name: 'Keyed', protocol: 'openai-compatible',
          authMethod: 'api-key', modelIds: ['gpt-5/test'],
        } },
        CLIENT_ID,
      );
      expect(created).toMatchObject({
        ok: true,
        result: { connection: { id: '00000000-0000-4000-8000-000000000061' } },
      });
    } finally {
      localHost.dispose();
    }
  });
});

describe('HostServer representative bindings', () => {
  beforeEach(async () => {
    await hello(server);
  });

  it('session.list returns the (empty) saved list', async () => {
    const response = await call(server, 'session.list');
    expect(response).toEqual({ id: 1, ok: true, result: [] });
  });

  it('session.create creates a real session and session.list sees it', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.workspace.source = 'sticky';
    mocks.trustState.current = 'trusted';

    const created = await call(server, 'session.create');
    expect(created.ok).toBe(true);
    const session = (created.ok ? created.result : {}) as { id: string; name: string };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await call(server, 'session.list');
    expect(listed.ok).toBe(true);
    const summaries = (listed.ok ? listed.result : []) as Array<{ id: string }>;
    expect(summaries.some((summary) => summary.id === session.id)).toBe(true);
  });

  it('emits session:created to the requesting client with a monotonic seq', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.workspace.source = 'sticky';
    mocks.trustState.current = 'trusted';

    await call(server, 'session.create');
    const created = events.find((event) => event.ev === 'session:created');
    expect(created).toBeDefined();
    expect(created?.seq).toBeGreaterThan(0);
  });

  it('chat.snapshot returns null without an active session', async () => {
    const response = await call(server, 'chat.snapshot', {});
    expect(response).toEqual({ id: 1, ok: true, result: null });
  });

  it('config.get returns the process config', async () => {
    const response = await call(server, 'config.get');
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toBe(mocks.configState);
    }
  });

  it('permission.get_session_mode reads the draft override when no session is active', async () => {
    const response = await call(server, 'permission.get_session_mode', { expectedSessionId: null });
    expect(response).toEqual({
      id: 1,
      ok: true,
      result: { ok: true, sessionId: null, mode: null },
    });
  });

  it('providers.list routes through the shared provider views', async () => {
    const response = await call(server, 'providers.list');
    expect(response.ok).toBe(true);
  });

  it('dispose removes the installed runtime hooks', () => {
    server.dispose();
    expect(mocks.todoNotifier).toBeTypeOf('function');
    expect(mocks.workingSetBroadcast).toBe(null);
    expect(mocks.subagentsChangedBroadcast).toBe(null);
    expect(mocks.indexAutoRefreshNotifier).toBe(null);
  });
});

describe('HostServer event routing', () => {
  beforeEach(async () => {
    await hello(server);
  });

  it('delivers turn events to the requesting client and session-matched clients only', async () => {
    const otherEvents: unknown[] = [];
    server.addConnection('conn-2', (event) => otherEvents.push(event));
    // conn-1 views the session; conn-2 does not.
    const sessionManager = mocks.sessionManager as SessionManager;
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.trustState.current = 'trusted';
    const created = await call(server, 'session.create');
    const sessionId = ((created.ok ? created.result : {}) as { id: string }).id;

    // Route a session event through the installed sink (as the pipeline does).
    const { sendSessionEvent } = await import('../../src/main/host/chat/events');
    sendSessionEvent(CLIENT_ID, sessionId, 'session:updated', { sessionId });
    const own = events.filter((event) => event.ev === 'session:updated');
    expect(own.length).toBeGreaterThan(0);
    expect(otherEvents.filter((event) => (event as { ev: string }).ev === 'session:updated')).toHaveLength(0);
    void sessionManager;
  });

  it('forwards approval requests to connected clients and answers them through the protocol', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.trustState.current = 'trusted';
    const created = await call(server, 'session.create');
    const sessionId = ((created.ok ? created.result : {}) as { id: string }).id;
    (mocks.sessionManager as SessionManager).switchTo(sessionId, CLIENT_ID);

    const { approvalStore } = await import('../../src/main/permissions/approval-store');
    const toolCallId = '11111111-2222-4333-8444-555555555555';
    const settled = approvalStore.create(toolCallId, sessionId, 'write', 'destructive', {}, projectDir);

    const requested = events.find((event) => event.ev === 'permission:approval_requested');
    expect(requested).toBeDefined();
    expect((requested?.params as { toolCallId: string }).toolCallId).toBe(toolCallId);

    const answered = await call(server, 'permission.approval_answer', {
      toolCallId,
      decision: 'approved',
    });
    expect(answered).toEqual({ id: 1, ok: true, result: { ok: true } });

    expect(await settled).toEqual({ decision: 'approved' });
    const settledEvent = events.find((event) => event.ev === 'permission:approval_settled');
    expect(settledEvent).toBeDefined();
  });

  it('session.delete drops permission state and settles pending approvals cancelled', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
    mocks.workspace.cwd = projectDir;
    mocks.workspace.status = 'valid';
    mocks.workspace.source = 'sticky';
    mocks.trustState.current = 'trusted';
    const created = await call(server, 'session.create');
    const sessionId = ((created.ok ? created.result : {}) as { id: string }).id;

    const { approvalStore } = await import('../../src/main/permissions/approval-store');
    const { sessionPermissionOverrides } = await import('../../src/main/permissions/session-overrides');
    sessionPermissionOverrides.set(sessionId, 'allow');
    const toolCallId = '22222222-3333-4444-8555-666666666666';
    const pending = approvalStore.create(
      toolCallId, sessionId, 'write', 'destructive', {}, projectDir,
    );

    const deleted = await call(server, 'session.delete', { id: sessionId });
    expect(deleted).toMatchObject({ id: 1, ok: true, result: { status: 'deleted' } });

    // The deleted session's permission override and pending approvals are gone.
    expect(sessionPermissionOverrides.has(sessionId)).toBe(false);
    expect(approvalStore.get(toolCallId)).toBeUndefined();
    await expect(pending).resolves.toEqual({ decision: 'denied', reason: 'cancelled' });
    expect(events.find((event) => event.ev === 'session:deleted')).toBeDefined();
  });
});
