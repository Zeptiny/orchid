/**
 * Trusted-projects execution gates (U4).
 *
 * Real under test: the project trust store (path injected via
 * resetProjectTrustStore), ProjectMCPManagerRegistry + MCPManager (startAll
 * spied so no server process launches), a SessionManager on temp SQLite
 * storage, and the gate functions themselves.
 *
 * Mocked (the Electron app shell and process singletons it owns): electron,
 * session/singleton (mutable manager + workspace resolution), project/runtime
 * registry, ipc/chat (forceStopSession — the revoke flow's dynamic import),
 * and ipc/session-working-set (would otherwise persist ui-state.json against
 * the real home directory).
 *
 * Not covered here: the `mcp:status` handler wiring (dormant-manager emptiness
 * is asserted directly; handler behavior lives in tests/unit/mcp-ipc.test.ts).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    sessionManager: null as unknown,
    workspaceFor: (_windowId: string): {
      cwd: string | null;
      source: string;
      status: string;
    } => ({ cwd: null, source: 'unbound', status: 'unbound' }),
    runtimeGet: vi.fn(),
    runtimeInvalidate: vi.fn(() => true),
    forceStopSession: vi.fn((_sessionId: string) => true),
    workingSetOpenOrFocus: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
  webContents: {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (windowId: string) => mocks.workspaceFor(windowId),
  resolveBoundProjectPath: (windowId?: string) => mocks.workspaceFor(windowId ?? '').cwd,
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    get: mocks.runtimeGet,
    invalidate: mocks.runtimeInvalidate,
  }),
  clearProjectRuntimeRegistry: vi.fn(),
}));

vi.mock('../../src/main/ipc/chat', () => ({
  forceStopSession: (sessionId: string) => mocks.forceStopSession(sessionId),
}));

vi.mock('../../src/main/ipc/session-working-set', () => ({
  workingSetOpenOrFocus: (...args: unknown[]) => mocks.workingSetOpenOrFocus(...args),
}));

// ── Imports after mocks ─────────────────────────────────────────────────────

import { ensureActiveSession } from '../../src/main/ipc/chat/session';
import {
  registerSessionIPC,
  revokeProjectTrustForDir,
  unregisterSessionIPC,
} from '../../src/main/ipc/session';
import { MCPManager } from '../../src/main/mcp/manager';
import {
  getProjectMCPManager,
  invalidateProjectMCPManagers,
  shutdownProjectMCPManagers,
} from '../../src/main/mcp/project-registry';
import type { ProjectRuntime } from '../../src/main/project/runtime';
import {
  getProjectTrustState,
  grantProjectTrust,
  resetProjectTrustStore,
} from '../../src/main/project/trust';
import { SessionManager } from '../../src/main/session/manager';
import { _clearDbCache, type StorageOptions } from '../../src/main/session/storage';

// ── Fixtures ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let surfaceProject: string;
let bareProject: string;
let surfaceCanonical: string;
let bareCanonical: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-trust-gates-'));
  surfaceProject = path.join(tmpRoot, 'surface-project');
  bareProject = path.join(tmpRoot, 'bare-project');
  fs.mkdirSync(surfaceProject);
  fs.mkdirSync(bareProject);
  // A project surface: any project-supplied content requires a decision.
  fs.writeFileSync(
    path.join(surfaceProject, '.orchid.json'),
    JSON.stringify({ command_timeout: 99 }),
    'utf-8',
  );
  surfaceCanonical = fs.realpathSync(surfaceProject);
  bareCanonical = fs.realpathSync(bareProject);

  const homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(homeDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'personalities'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({}), 'utf-8');

  resetProjectTrustStore({
    storePath: path.join(tmpRoot, 'trusted_projects.json'),
    homeConfigPath: path.join(homeDir, 'config.json'),
    homeAgentsDir: path.join(homeDir, 'agents'),
    homeSkillsDir: path.join(homeDir, 'skills'),
    homePersonalitiesDir: path.join(homeDir, 'personalities'),
  });

  mocks.handlers.clear();
  mocks.sessionManager = null;
  mocks.runtimeGet.mockReset();
  mocks.runtimeGet.mockImplementation((cwd: string) => ({
    projectDir: cwd,
    config: { default_model: null },
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  }));
  mocks.runtimeInvalidate.mockClear();
  mocks.forceStopSession.mockClear();
  mocks.workingSetOpenOrFocus.mockClear();
  mocks.workspaceFor = () => ({ cwd: null, source: 'unbound', status: 'unbound' });
});

afterEach(async () => {
  await shutdownProjectMCPManagers();
  resetProjectTrustStore();
  _clearDbCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_SELECTION = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/path/model',
};

function tempStorage(): StorageOptions {
  return {
    dbPath: path.join(tmpRoot, 'sessions.db'),
    toolOutputCacheDir: path.join(tmpRoot, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(tmpRoot, 'cache', 'web-fetch'),
  };
}

function fakeWebContents(id: number) {
  return { id, send: vi.fn() } as never;
}

interface FakeSession {
  id: string;
  name: string;
  selection: unknown;
  modelLabel: string | null;
  cwd: string | null;
  chains: unknown[];
  activeChainId: string | null;
  createdAt: string;
  updatedAt: string;
  subagentChains: unknown[];
  todoStore: { tasks: unknown[] };
}

/** Minimal SessionManager surface for ensureActiveSession's draft path. */
function makeFakeSessionManager() {
  const sessions = new Map<string, FakeSession>();
  return {
    getActive: vi.fn(() => null),
    getSession: vi.fn((id: string) => sessions.get(id) ?? null),
    create: vi.fn((selection: unknown, options?: { cwd?: string | null }) => {
      const now = new Date().toISOString();
      const session: FakeSession = {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Session test',
        selection,
        modelLabel: null,
        cwd: options?.cwd ?? null,
        chains: [],
        activeChainId: null,
        createdAt: now,
        updatedAt: now,
        subagentChains: [],
        todoStore: { tasks: [] },
      };
      sessions.set(session.id, session);
      return session;
    }),
  };
}

function mcpRuntime(projectDir: string): ProjectRuntime {
  return {
    projectDir,
    config: {
      mcp_servers: {
        echo: { command: 'node', args: ['server.js'] },
      },
      mcp_per_server_timeout: 2,
      mcp_startup_timeout: 7,
    },
    agents: new Map(),
    skills: new Map(),
    personalities: new Map(),
  } as unknown as ProjectRuntime;
}

// ── chat:send gate ──────────────────────────────────────────────────────────

describe('chat:send gate (ensureActiveSession)', () => {
  it('rejects an untrusted bound project with untrusted_project before runtime load', () => {
    mocks.sessionManager = makeFakeSessionManager();
    mocks.workspaceFor = () => ({ cwd: surfaceProject, source: 'default', status: 'valid' });

    const result = ensureActiveSession(fakeWebContents(701), TEST_SELECTION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.result).toMatchObject({
        status: 'error',
        kind: 'untrusted_project',
      });
    }
    expect(mocks.runtimeGet).not.toHaveBeenCalled();
  });

  it('proceeds past the gate after a grant', () => {
    mocks.sessionManager = makeFakeSessionManager();
    mocks.workspaceFor = () => ({ cwd: surfaceProject, source: 'default', status: 'valid' });
    grantProjectTrust(surfaceProject);

    const result = ensureActiveSession(fakeWebContents(702), TEST_SELECTION);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cwd).toBe(surfaceProject);
      expect(result.session.selection).toEqual(TEST_SELECTION);
    }
  });

  it('auto-trusts a bare project without a grant', () => {
    mocks.sessionManager = makeFakeSessionManager();
    mocks.workspaceFor = () => ({ cwd: bareProject, source: 'default', status: 'valid' });

    const result = ensureActiveSession(fakeWebContents(703), TEST_SELECTION);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cwd).toBe(bareProject);
    }
  });
});

// ── MCP dormant manager ─────────────────────────────────────────────────────

describe('MCP dormant manager (ProjectMCPManagerRegistry)', () => {
  it('never starts servers while untrusted; starts after grant + invalidation', async () => {
    const startAll = vi
      .spyOn(MCPManager.prototype, 'startAll')
      .mockResolvedValue(undefined);
    const runtime = mcpRuntime(surfaceCanonical);

    // Untrusted: cached dormant manager, no server startup.
    const dormant = getProjectMCPManager(runtime);
    expect(startAll).not.toHaveBeenCalled();
    expect(dormant.getStatus()).toEqual([]);
    expect(dormant.getTools()).toEqual([]);
    // Same entry is reused while the trust posture is unchanged.
    expect(getProjectMCPManager(runtime)).toBe(dormant);
    expect(startAll).not.toHaveBeenCalled();

    // Grant (as the trust:set handler does) invalidates, so the next get()
    // recreates the manager and starts the configured servers.
    grantProjectTrust(surfaceProject);
    invalidateProjectMCPManagers(surfaceCanonical);

    getProjectMCPManager(runtime);
    expect(startAll).toHaveBeenCalledTimes(1);
    expect(startAll).toHaveBeenCalledWith(
      { echo: { command: 'node', args: ['server.js'], cwd: surfaceCanonical } },
      { perServerTimeout: 2_000, startupTimeout: 7_000 },
    );

    startAll.mockRestore();
  });

  it('starts servers on first get for an already-trusted project', () => {
    grantProjectTrust(surfaceProject);
    const startAll = vi
      .spyOn(MCPManager.prototype, 'startAll')
      .mockResolvedValue(undefined);

    getProjectMCPManager(mcpRuntime(surfaceCanonical));

    expect(startAll).toHaveBeenCalledTimes(1);
    startAll.mockRestore();
  });
});

// ── Revocation orchestration ────────────────────────────────────────────────

describe('revokeProjectTrustForDir', () => {
  it('revokes trust, invalidates caches, and force-stops bound sessions only', async () => {
    const manager = new SessionManager({ storage: tempStorage() });
    mocks.sessionManager = manager;
    grantProjectTrust(surfaceProject);
    expect(getProjectTrustState(surfaceProject)).toBe('trusted');

    const bound = manager.create(TEST_SELECTION, { cwd: surfaceProject }, 'w1');
    const elsewhere = manager.create(TEST_SELECTION, { cwd: bareProject }, 'w2');

    await revokeProjectTrustForDir(surfaceProject);

    expect(getProjectTrustState(surfaceProject)).toBe('untrusted');
    expect(mocks.runtimeInvalidate).toHaveBeenCalledWith(surfaceCanonical);
    expect(mocks.forceStopSession).toHaveBeenCalledTimes(1);
    expect(mocks.forceStopSession).toHaveBeenCalledWith(bound.id);
    expect(mocks.forceStopSession).not.toHaveBeenCalledWith(elsewhere.id);
  });

  it('is a no-op for an invalid project directory', async () => {
    const manager = new SessionManager({ storage: tempStorage() });
    mocks.sessionManager = manager;

    await revokeProjectTrustForDir(path.join(tmpRoot, 'does-not-exist'));

    expect(mocks.runtimeInvalidate).not.toHaveBeenCalled();
    expect(mocks.forceStopSession).not.toHaveBeenCalled();
  });
});

// ── session:create gate ─────────────────────────────────────────────────────

describe('session:create gate', () => {
  it('rejects while untrusted and creates the session after a grant', async () => {
    const manager = new SessionManager({ storage: tempStorage() });
    mocks.sessionManager = manager;
    mocks.workspaceFor = () => ({ cwd: surfaceProject, source: 'default', status: 'valid' });
    registerSessionIPC();

    try {
      const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_CREATE);
      expect(handler).toBeDefined();
      const event = { sender: { id: 5, send: vi.fn(), isDestroyed: () => false } };

      await expect(handler!(event)).rejects.toThrow(
        'Cannot create session: project folder is not trusted. Trust the project first.',
      );
      expect(manager.listSaved()).toHaveLength(0);

      grantProjectTrust(surfaceProject);
      const session = (await handler!(event)) as { cwd: string | null };

      expect(session.cwd).toBe(surfaceCanonical);
      expect(manager.listSaved()).toHaveLength(1);
    } finally {
      unregisterSessionIPC();
    }
  });

  it('allows bare projects without a grant', async () => {
    const manager = new SessionManager({ storage: tempStorage() });
    mocks.sessionManager = manager;
    mocks.workspaceFor = () => ({ cwd: bareProject, source: 'default', status: 'valid' });
    registerSessionIPC();

    try {
      const handler = mocks.handlers.get(IPC_CHANNELS.SESSION_CREATE);
      const event = { sender: { id: 6, send: vi.fn(), isDestroyed: () => false } };

      const session = (await handler!(event)) as { cwd: string | null };

      expect(session.cwd).toBe(bareCanonical);
    } finally {
      unregisterSessionIPC();
    }
  });
});
