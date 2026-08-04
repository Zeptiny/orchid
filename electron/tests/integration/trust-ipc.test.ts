/**
 * Project trust IPC handlers (U5) — project:trust_get, project:trust_set,
 * project:trust_list.
 *
 * Uses the real trust store against temp fixtures (store path injected via
 * resetProjectTrustStore) and captures ipcMain handlers + BrowserWindow
 * broadcasts the way the other IPC handler tests do. `revokeProjectTrustForDir`
 * lives in ipc/session (concurrent unit U4) and is mocked here with its store
 * behavior so the revoke handler path stays exercisable.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  type ProjectTrustInfo,
  type TrustedProjectEntry,
} from '../../src/shared/types/ipc';

// ── Mocks ───────────────────────────────────────────────────────────────────

interface FakeWindow {
  destroyed: boolean;
  contentsDestroyed: boolean;
  isDestroyed: () => boolean;
  webContents: {
    id: number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  };
}

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const windows: {
    destroyed: boolean;
    contentsDestroyed: boolean;
    isDestroyed: () => boolean;
    webContents: { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  }[] = [];

  return {
    handlers,
    windows,
    workspaceByWebContents: new Map<number, string>(),
    trustStateFor: (_cwd: string) => 'untrusted' as string,
    runtimeInvalidate: vi.fn(),
    invalidateProjectMCPManagers: vi.fn(),
    revokeProjectTrustForDir: vi.fn(),
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

vi.mock('../../src/main/ipc/session', () => ({
  revokeProjectTrustForDir: (cwd: string) => mocks.revokeProjectTrustForDir(cwd),
}));

vi.mock('../../src/main/session/singleton', () => ({
  resolveWindowWorkspace: (windowId: string) => {
    const cwd = mocks.workspaceByWebContents.get(Number(windowId)) ?? null;
    if (cwd == null) {
      return { cwd: null, source: 'unbound', status: 'unbound' };
    }
    return { cwd, source: 'session', status: 'valid', trust: mocks.trustStateFor(cwd) };
  },
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ invalidate: mocks.runtimeInvalidate }),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  invalidateProjectMCPManagers: mocks.invalidateProjectMCPManagers,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  registerTrustIPC,
  unregisterTrustIPC,
} from '../../src/main/ipc/trust';
import {
  getProjectTrustState,
  grantProjectTrust,
  listTrustedProjects,
  ProjectTrustStore,
  resetProjectTrustStore,
  revokeProjectTrust,
} from '../../src/main/project/trust';

mocks.trustStateFor = getProjectTrustState;

// ── Fixtures ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let storePath: string;
let surfaceProject: string;
let bareProject: string;
let surfaceCanonical: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-trust-ipc-'));
  storePath = path.join(tmpRoot, 'trusted_projects.json');
  surfaceProject = path.join(tmpRoot, 'surface-project');
  bareProject = path.join(tmpRoot, 'bare-project');
  fs.mkdirSync(surfaceProject);
  fs.mkdirSync(bareProject);
  fs.writeFileSync(
    path.join(surfaceProject, '.orchid.json'),
    JSON.stringify({ command_timeout: 99 }),
    'utf-8',
  );
  surfaceCanonical = fs.realpathSync(surfaceProject);

  const homeDir = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(homeDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'personalities'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({}), 'utf-8');

  resetProjectTrustStore({
    storePath,
    homeConfigPath: path.join(homeDir, 'config.json'),
    homeAgentsDir: path.join(homeDir, 'agents'),
    homeSkillsDir: path.join(homeDir, 'skills'),
    homePersonalitiesDir: path.join(homeDir, 'personalities'),
  });

  mocks.handlers.clear();
  mocks.windows.length = 0;
  mocks.workspaceByWebContents.clear();
  mocks.runtimeInvalidate.mockClear();
  mocks.invalidateProjectMCPManagers.mockClear();
  // Mirror U4's helper store behavior: revoke removes the trust entry.
  mocks.revokeProjectTrustForDir.mockClear();
  mocks.revokeProjectTrustForDir.mockImplementation(async (cwd: string) => {
    revokeProjectTrust(cwd);
  });

  registerTrustIPC();
});

afterEach(() => {
  unregisterTrustIPC();
  resetProjectTrustStore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler;
}

async function callTrustGet(payload: unknown): Promise<ProjectTrustInfo> {
  const result = handlerFor(IPC_CHANNELS.PROJECT_TRUST_GET)({ sender: { id: 1 } }, payload);
  return (await result) as ProjectTrustInfo;
}

async function callTrustSet(payload: unknown): Promise<ProjectTrustInfo> {
  const result = handlerFor(IPC_CHANNELS.PROJECT_TRUST_SET)({ sender: { id: 1 } }, payload);
  return (await result) as ProjectTrustInfo;
}

async function callTrustList(): Promise<TrustedProjectEntry[]> {
  const result = handlerFor(IPC_CHANNELS.PROJECT_TRUST_LIST)({ sender: { id: 1 } });
  return (await result) as TrustedProjectEntry[];
}

function addWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    contentsDestroyed: false,
    isDestroyed() {
      return win.destroyed;
    },
    webContents: {
      id,
      isDestroyed: () => win.contentsDestroyed,
      send: vi.fn(),
    },
  };
  mocks.windows.push(win);
  return win;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('project:trust_get', () => {
  it('returns untrusted with a surface report for an untrusted project', async () => {
    const info = await callTrustGet({ cwd: surfaceProject });

    expect(info.projectDir).toBe(surfaceCanonical);
    expect(info.state).toBe('untrusted');
    expect(info.report).not.toBeNull();
    expect(info.report!.projectDir).toBe(surfaceCanonical);
    expect(info.report!.hasSurface).toBe(true);
    expect(info.report!.otherConfigOverrides).toContainEqual({
      key: 'command_timeout',
      projectValue: '99',
      homeValue: '30',
    });
  });

  it('returns trusted with a surface report after a grant', async () => {
    grantProjectTrust(surfaceProject);

    const info = await callTrustGet({ cwd: surfaceProject });

    expect(info.projectDir).toBe(surfaceCanonical);
    expect(info.state).toBe('trusted');
    // The settings Review button renders this report read-only for trusted
    // projects, so it must be populated regardless of state.
    expect(info.report).not.toBeNull();
    expect(info.report!.projectDir).toBe(surfaceCanonical);
    expect(info.report!.hasSurface).toBe(true);
  });

  it('auto-trusts a bare project without a surface', async () => {
    const info = await callTrustGet({ cwd: bareProject });

    expect(info.projectDir).toBe(fs.realpathSync(bareProject));
    expect(info.state).toBe('trusted');
    expect(info.report).not.toBeNull();
    expect(info.report!.hasSurface).toBe(false);
    expect(info.report!.mcpServers).toEqual([]);
    expect(info.report!.definitions).toEqual([]);
  });

  it('never throws for a nonexistent directory', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');

    const info = await callTrustGet({ cwd: missing });

    expect(info).toEqual({ projectDir: missing, state: 'untrusted', report: null });
  });

  it('keeps the real state but drops the report when the report build throws', async () => {
    // A hostile/broken FS entry must never reject trust_get — the grant path
    // has to stay reachable.
    const spy = vi
      .spyOn(ProjectTrustStore.prototype, 'buildReport')
      .mockImplementation(() => {
        throw new Error('hostile surface');
      });

    try {
      const info = await callTrustGet({ cwd: surfaceProject });

      expect(info.projectDir).toBe(surfaceCanonical);
      expect(info.state).toBe('untrusted');
      expect(info.report).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports the updated surface after a granted project drifts', async () => {
    grantProjectTrust(surfaceProject);
    expect(getProjectTrustState(surfaceProject)).toBe('trusted');

    // Drift the granted surface: keep the original override, add an MCP server.
    fs.writeFileSync(
      path.join(surfaceProject, '.orchid.json'),
      JSON.stringify({
        command_timeout: 99,
        mcp_servers: {
          context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        },
      }),
      'utf-8',
    );

    const info = await callTrustGet({ cwd: surfaceProject });

    expect(info.projectDir).toBe(surfaceCanonical);
    expect(info.state).toBe('changed');
    expect(info.report).not.toBeNull();
    expect(info.report!.hasSurface).toBe(true);
    expect(info.report!.mcpServers).toContainEqual({
      name: 'context7',
      kind: 'added',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    });
    expect(info.report!.otherConfigOverrides).toContainEqual({
      key: 'command_timeout',
      projectValue: '99',
      homeValue: '30',
    });
  });
});

describe('project:trust_set', () => {
  it('grants trust, invalidates caches, and broadcasts the change', async () => {
    const win = addWindow(10);
    const dead = addWindow(11);
    dead.destroyed = true;
    const staleContents = addWindow(12);
    staleContents.contentsDestroyed = true;
    mocks.workspaceByWebContents.set(10, surfaceCanonical);

    const info = await callTrustSet({ cwd: surfaceProject, trusted: true });

    expect(info.projectDir).toBe(surfaceCanonical);
    expect(info.state).toBe('trusted');
    expect(info.report).not.toBeNull();
    expect(info.report!.projectDir).toBe(surfaceCanonical);
    expect(getProjectTrustState(surfaceProject)).toBe('trusted');

    const stored = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Record<
      string,
      { trustedAt: string; fingerprint: string }
    >;
    expect(Object.keys(stored)).toEqual([surfaceCanonical]);
    expect(stored[surfaceCanonical].fingerprint).toBeTypeOf('string');
    expect(stored[surfaceCanonical].trustedAt).toBeTypeOf('string');

    expect(mocks.runtimeInvalidate).toHaveBeenCalledWith(surfaceCanonical);
    expect(mocks.invalidateProjectMCPManagers).toHaveBeenCalledWith(surfaceCanonical);

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.PROJECT_TRUST_CHANGED,
      { projectDir: surfaceCanonical, state: 'trusted' },
    );
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
      {
        workspace: {
          cwd: surfaceCanonical,
          source: 'session',
          status: 'valid',
          trust: 'trusted',
        },
      },
    );
    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(staleContents.webContents.send).not.toHaveBeenCalled();
  });

  it('does not re-emit workspace events to windows bound elsewhere', async () => {
    const win = addWindow(10);
    mocks.workspaceByWebContents.set(10, fs.realpathSync(bareProject));

    await callTrustSet({ cwd: surfaceProject, trusted: true });

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.PROJECT_TRUST_CHANGED,
      { projectDir: surfaceCanonical, state: 'trusted' },
    );
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
      expect.anything(),
    );
  });

  it('revokes trust through the session flow and broadcasts the change', async () => {
    grantProjectTrust(surfaceProject);
    const win = addWindow(10);
    mocks.workspaceByWebContents.set(10, surfaceCanonical);

    const info = await callTrustSet({ cwd: surfaceProject, trusted: false });

    expect(mocks.revokeProjectTrustForDir).toHaveBeenCalledWith(surfaceProject);
    expect(info.state).toBe('untrusted');
    expect(info.projectDir).toBe(surfaceCanonical);
    expect(info.report).not.toBeNull();
    expect(listTrustedProjects()).toEqual([]);

    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.PROJECT_TRUST_CHANGED,
      { projectDir: surfaceCanonical, state: 'untrusted' },
    );
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
      {
        workspace: {
          cwd: surfaceCanonical,
          source: 'session',
          status: 'valid',
          trust: 'untrusted',
        },
      },
    );
  });

  it('rejects granting trust for an invalid directory', async () => {
    await expect(
      callTrustSet({ cwd: path.join(tmpRoot, 'missing'), trusted: true }),
    ).rejects.toThrow('Cannot trust an invalid project directory.');
    expect(fs.existsSync(storePath)).toBe(false);
  });
});

describe('payload validation', () => {
  it('rejects invalid trust_get payloads', async () => {
    await expect(callTrustGet({})).rejects.toThrow(/Invalid project:trust_get payload/);
    await expect(callTrustGet({ cwd: '' })).rejects.toThrow(/Invalid project:trust_get payload/);
    await expect(callTrustGet({ cwd: 123 })).rejects.toThrow(/Invalid project:trust_get payload/);
  });

  it('rejects invalid trust_set payloads', async () => {
    await expect(callTrustSet({ cwd: surfaceProject })).rejects.toThrow(
      /Invalid project:trust_set payload/,
    );
    await expect(callTrustSet({ cwd: surfaceProject, trusted: 'yes' })).rejects.toThrow(
      /Invalid project:trust_set payload/,
    );
    await expect(callTrustSet({ trusted: true })).rejects.toThrow(
      /Invalid project:trust_set payload/,
    );
  });
});

describe('project:trust_list', () => {
  it('returns store entries with live trust state', async () => {
    expect(await callTrustList()).toEqual([]);

    grantProjectTrust(surfaceProject);

    const entries = await callTrustList();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      projectDir: surfaceCanonical,
      trustedAt: expect.any(String),
      state: 'trusted',
    });

    // Surface drift flips the live state to `changed` without a new decision.
    fs.writeFileSync(
      path.join(surfaceProject, '.orchid.json'),
      JSON.stringify({ command_timeout: 100 }),
      'utf-8',
    );
    const drifted = await callTrustList();
    expect(drifted[0].state).toBe('changed');
  });

  it('omits bare projects that never wrote a store entry', async () => {
    expect(await callTrustGet({ cwd: bareProject })).toMatchObject({ state: 'trusted' });
    expect(await callTrustList()).toEqual([]);
  });
});
