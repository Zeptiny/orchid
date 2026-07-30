import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import type { PermissionMode } from '../../src/shared/types/permission';
import { hydrateSessionPermissionOverride } from '../../src/main/permissions/session-overrides';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const selectedByWebContents = new Map<number, string>();
  const activeTurnOwnerBySession = new Map<string, string>();
  const webContentsById = new Map<string, {
    id: number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  }>();
  const sessionPermissionModeById = new Map<string, string | null>();

  return {
    handlers,
    selectedByWebContents,
    projectDirByWebContents: new Map<number, string>(),
    activeTurnOwnerBySession,
    webContentsById,
    forceAbortMainTurn: vi.fn(),
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    sessionManager: {
      getActive: vi.fn((ownerId: string) => {
        const id = selectedByWebContents.get(Number(ownerId));
        return id ? { id } : null;
      }),
      getSession: vi.fn((id: string) => {
        const exists = [...selectedByWebContents.values()].includes(id);
        return exists ? { id, permissionMode: sessionPermissionModeById.get(id) ?? null } : null;
      }),
      setPermissionMode: vi.fn((id: string, mode: string | null) => {
        if (mode == null) sessionPermissionModeById.delete(id);
        else sessionPermissionModeById.set(id, mode);
        // Mirror the real SessionManager: persisting the mode also syncs the
        // in-memory gate map the permission gate actually reads.
        hydrateSessionPermissionOverride(id, mode as PermissionMode | null);
      }),
    },
    sessionPermissionModeById,
  };
});

const TEST_CONFIG_ROOT = '/tmp/orchid-permission-ipc-config';
const TEST_HOME_CONFIG = path.join(TEST_CONFIG_ROOT, 'home', 'config.json');

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    HOME_CONFIG_DIR: '/tmp/orchid-permission-ipc-config/home',
    HOME_CONFIG_PATH: '/tmp/orchid-permission-ipc-config/home/config.json',
    ConfigManager: {
      reset: vi.fn(),
      load: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain }));

vi.mock('../../src/main/ipc/chat', () => ({
  forceAbortMainTurn: mocks.forceAbortMainTurn,
  getActiveMainTurnWindowId: (sessionId: string) =>
    mocks.activeTurnOwnerBySession.get(sessionId) ?? null,
  webContentsForWindowId: (windowId: string) => {
    const webContents = mocks.webContentsById.get(windowId);
    return webContents && !webContents.isDestroyed() ? webContents : null;
  },
}));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => mocks.sessionManager,
  resolveWindowWorkspace: (ownerId: string) => {
    const cwd = mocks.projectDirByWebContents.get(Number(ownerId)) ?? null;
    return cwd == null
      ? { cwd: null, source: 'unbound', status: 'unbound' }
      : { cwd, source: 'session', status: 'valid' };
  },
}));

import * as permissionIpc from '../../src/main/ipc/permission';
import {
  _resetConfigSaveChainForTests,
  withConfigSaveLock,
} from '../../src/main/ipc/config';
import { approvalStore } from '../../src/main/permissions/approval-store';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const TOOL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOOL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function addWindow(id: number) {
  const webContents = {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
  };
  mocks.webContentsById.set(String(id), webContents);
  return { webContents };
}

function eventFrom(id: number) {
  return { sender: { id } };
}

function createApproval(
  toolCallId: string,
  sessionId: string,
  ownerWindowId: string,
): Promise<{ decision: 'approved' | 'denied'; reason?: string }> {
  return approvalStore.create(
    toolCallId,
    sessionId,
    'execute_command',
    'execution',
    { command: 'npm test' },
    '/tmp/project',
    undefined,
    undefined,
    ownerWindowId,
  );
}

describe('permission IPC ownership', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.selectedByWebContents.clear();
    mocks.activeTurnOwnerBySession.clear();
    mocks.webContentsById.clear();
    mocks.projectDirByWebContents.clear();
    mocks.forceAbortMainTurn.mockClear();
    approvalStore.cleanupAll();
    _resetConfigSaveChainForTests();
    permissionIpc.sessionPermissionOverrides.clear();
    mocks.sessionPermissionModeById.clear();
    mocks.sessionManager.setPermissionMode.mockClear();
    permissionIpc.registerPermissionIPC();
    fs.rmSync(TEST_CONFIG_ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(TEST_HOME_CONFIG), { recursive: true });
    fs.writeFileSync(TEST_HOME_CONFIG, JSON.stringify({ theme: 'default', permissions: { grep: 'ask' } }));
  });

  afterEach(() => {
    permissionIpc.unregisterPermissionIPC();
    permissionIpc.sessionPermissionOverrides.clear();
    fs.rmSync(TEST_CONFIG_ROOT, { recursive: true, force: true });
  });

  it('derives the session-mode target from the sender and rejects no-session writes', () => {
    mocks.selectedByWebContents.set(10, SESSION_A);
    const setMode = mocks.handlers.get(IPC_CHANNELS.PERMISSION_SET_SESSION_MODE)!;

    expect(() => setMode(eventFrom(10), { sessionId: SESSION_B, mode: 'allow' })).toThrow();
    expect(setMode(eventFrom(10), {
      expectedSessionId: SESSION_B,
      mode: 'allow',
    })).toEqual({ ok: false, sessionId: SESSION_A });
    expect(setMode(eventFrom(10), {
      expectedSessionId: SESSION_A,
      mode: 'allow',
    })).toEqual({ ok: true, sessionId: SESSION_A });
    expect(permissionIpc.sessionPermissionOverrides.get(SESSION_A)).toBe('allow');
    expect(permissionIpc.sessionPermissionOverrides.has(SESSION_B)).toBe(false);

    mocks.selectedByWebContents.delete(10);
    // Draft mode (no active session): the override is stashed per-window,
    // not in the session map. It returns ok: true so the coordinator commits.
    expect(setMode(eventFrom(10), {
      expectedSessionId: null,
      mode: 'ask',
    })).toEqual({ ok: true, sessionId: null });
    expect(permissionIpc.sessionPermissionOverrides.get(SESSION_A)).toBe('allow');
  });

  it('deletes the selected session override when mode is null', () => {
    mocks.selectedByWebContents.set(10, SESSION_A);
    permissionIpc.sessionPermissionOverrides.set(SESSION_A, 'allow');
    const setMode = mocks.handlers.get(IPC_CHANNELS.PERMISSION_SET_SESSION_MODE)!;

    expect(setMode(eventFrom(10), {
      expectedSessionId: SESSION_A,
      mode: null,
    })).toEqual({ ok: true, sessionId: SESSION_A });
    expect(permissionIpc.sessionPermissionOverrides.has(SESSION_A)).toBe(false);
  });

  it('reads distinct modes for the session selected by each sender', () => {
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.selectedByWebContents.set(20, SESSION_B);
    mocks.sessionPermissionModeById.set(SESSION_A, 'allow');
    mocks.sessionPermissionModeById.set(SESSION_B, 'ask');
    const getMode = mocks.handlers.get(IPC_CHANNELS.PERMISSION_GET_SESSION_MODE)!;

    expect(getMode(eventFrom(10), { expectedSessionId: SESSION_A })).toEqual({
      ok: true,
      sessionId: SESSION_A,
      mode: 'allow',
    });
    expect(getMode(eventFrom(20), { expectedSessionId: SESSION_B })).toEqual({
      ok: true,
      sessionId: SESSION_B,
      mode: 'ask',
    });
    expect(getMode(eventFrom(20), { expectedSessionId: SESSION_A })).toEqual({
      ok: false,
      sessionId: SESSION_B,
      mode: null,
    });
    mocks.selectedByWebContents.delete(20);
    expect(getMode(eventFrom(20), { expectedSessionId: null })).toEqual({
      ok: true,
      sessionId: null,
      mode: null,
    });
  });

  it('loads and patches project permissions through the sender workspace only', async () => {
    const projectDir = path.join(TEST_CONFIG_ROOT, 'project-a');
    const otherProjectDir = path.join(TEST_CONFIG_ROOT, 'project-b');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(otherProjectDir, { recursive: true });
    fs.chmodSync(projectDir, 0o755);
    fs.writeFileSync(
      path.join(projectDir, '.orchid.json'),
      JSON.stringify({ theme: 'bluey', permissions: { edit: 'ask' } }),
    );
    fs.writeFileSync(
      path.join(otherProjectDir, '.orchid.json'),
      JSON.stringify({ theme: 'green-terminal', permissions: { write: 'deny' } }),
    );
    mocks.projectDirByWebContents.set(10, projectDir);

    const snapshot = mocks.handlers.get(IPC_CHANNELS.CONFIG_PERMISSION_SCOPES)!;
    expect(snapshot(eventFrom(10))).toEqual({
      global: { grep: 'ask' },
      project: { edit: 'ask' },
      projectDir,
    });

    const save = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE)!;
    await expect(save(eventFrom(10), {
      scope: 'project',
      expectedProjectDir: projectDir,
      updates: { edit: null, execute_command: 'allow' },
    })).resolves.toEqual({ status: 'saved' });

    const saved = JSON.parse(fs.readFileSync(path.join(projectDir, '.orchid.json'), 'utf8'));
    expect(saved).toEqual({ theme: 'bluey', permissions: { execute_command: 'allow' } });
    expect(JSON.parse(fs.readFileSync(path.join(otherProjectDir, '.orchid.json'), 'utf8')))
      .toEqual({ theme: 'green-terminal', permissions: { write: 'deny' } });
    expect(JSON.parse(fs.readFileSync(TEST_HOME_CONFIG, 'utf8')))
      .toEqual({ theme: 'default', permissions: { grep: 'ask' } });
    expect(fs.statSync(projectDir).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(projectDir, '.orchid.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects a stale project token and captures the verified target before a queued save', async () => {
    const projectDirA = path.join(TEST_CONFIG_ROOT, 'queued-project-a');
    const projectDirB = path.join(TEST_CONFIG_ROOT, 'queued-project-b');
    fs.mkdirSync(projectDirA, { recursive: true });
    fs.mkdirSync(projectDirB, { recursive: true });
    fs.writeFileSync(path.join(projectDirA, '.orchid.json'), JSON.stringify({ permissions: {} }));
    fs.writeFileSync(path.join(projectDirB, '.orchid.json'), JSON.stringify({ permissions: {} }));
    mocks.projectDirByWebContents.set(10, projectDirA);
    const save = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE)!;

    expect(() => save(eventFrom(10), {
      scope: 'project',
      expectedProjectDir: projectDirB,
      updates: { edit: 'allow' },
    })).toThrow('no longer matches');

    let release!: () => void;
    const blocker = withConfigSaveLock(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const queued = save(eventFrom(10), {
      scope: 'project',
      expectedProjectDir: projectDirA,
      updates: { edit: 'allow' },
    });
    mocks.projectDirByWebContents.set(10, projectDirB);
    release();
    await blocker;
    await expect(queued).resolves.toEqual({ status: 'saved' });

    expect(JSON.parse(fs.readFileSync(path.join(projectDirA, '.orchid.json'), 'utf8')))
      .toEqual({ permissions: { edit: 'allow' } });
    expect(JSON.parse(fs.readFileSync(path.join(projectDirB, '.orchid.json'), 'utf8')))
      .toEqual({ permissions: {} });
  });

  it('does not follow an attacker-planted predictable temp symlink during project save', async () => {
    const projectDir = path.join(TEST_CONFIG_ROOT, 'symlink-project');
    const victim = path.join(TEST_CONFIG_ROOT, 'victim.txt');
    const configPath = path.join(projectDir, '.orchid.json');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ permissions: {} }));
    fs.writeFileSync(victim, 'do not overwrite');
    fs.symlinkSync(victim, `${configPath}.tmp`);
    mocks.projectDirByWebContents.set(10, projectDir);

    const save = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE)!;
    await expect(save(eventFrom(10), {
      scope: 'project',
      expectedProjectDir: projectDir,
      updates: { write: 'ask' },
    })).resolves.toEqual({ status: 'saved' });

    expect(fs.readFileSync(victim, 'utf8')).toBe('do not overwrite');
    expect(fs.lstatSync(`${configPath}.tmp`).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')))
      .toEqual({ permissions: { write: 'ask' } });
  });

  it('treats a missing project layer as empty but wraps malformed layer errors', () => {
    const projectDir = path.join(TEST_CONFIG_ROOT, 'project-without-config');
    fs.mkdirSync(projectDir, { recursive: true });
    mocks.projectDirByWebContents.set(10, projectDir);
    const snapshot = mocks.handlers.get(IPC_CHANNELS.CONFIG_PERMISSION_SCOPES)!;

    expect(snapshot(eventFrom(10))).toEqual({
      global: { grep: 'ask' },
      project: {},
      projectDir,
    });

    fs.writeFileSync(path.join(projectDir, '.orchid.json'), '{ malformed');
    expect(() => snapshot(eventFrom(10))).toThrow(
      `Cannot read configuration layer ${path.join(projectDir, '.orchid.json')}`,
    );
  });

  it('rejects renderer paths and project writes without a bound workspace', async () => {
    const save = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE)!;
    expect(() => save(eventFrom(10), {
      scope: 'project',
      projectDir: '/tmp/attacker-selected',
      updates: { edit: 'allow' },
    })).toThrow();
    expect(() => save(eventFrom(10), {
      scope: 'project',
      expectedProjectDir: '/tmp/attacker-selected',
      updates: { edit: 'allow' },
    })).toThrow('without a bound project');

    expect(() => save(eventFrom(10), {
      scope: 'global',
      expectedProjectDir: '/tmp/attacker-selected',
      updates: { edit: 'allow' },
    })).toThrow();
  });

  it('patches the user permission map without replacing unrelated home settings', async () => {
    const save = mocks.handlers.get(IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE)!;
    await expect(save(eventFrom(10), {
      scope: 'global',
      updates: { grep: null, read: 'allow' },
    })).resolves.toEqual({ status: 'saved' });

    expect(JSON.parse(fs.readFileSync(TEST_HOME_CONFIG, 'utf8'))).toEqual({
      theme: 'default',
      permissions: { read: 'allow' },
    });
    expect(fs.statSync(path.dirname(TEST_HOME_CONFIG)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(TEST_HOME_CONFIG).mode & 0o777).toBe(0o600);
  });

  it('cleans pending approvals and overrides when a session is deleted', async () => {
    addWindow(10);
    permissionIpc.sessionPermissionOverrides.set(SESSION_A, 'allow');
    const pending = createApproval(TOOL_A, SESSION_A, '10');

    permissionIpc.clearPermissionSessionState(SESSION_A);

    expect(permissionIpc.sessionPermissionOverrides.has(SESSION_A)).toBe(false);
    expect(approvalStore.get(TOOL_A)).toBeUndefined();
    await expect(pending).resolves.toEqual({ decision: 'denied', reason: 'cancelled' });
  });

  it('returns approvals only for the sender selected session and exact owner window', () => {
    addWindow(10);
    addWindow(20);
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.selectedByWebContents.set(20, SESSION_A);
    mocks.activeTurnOwnerBySession.set(SESSION_A, '10');
    void createApproval(TOOL_A, SESSION_A, '10');
    mocks.activeTurnOwnerBySession.set(SESSION_A, '20');
    void createApproval(TOOL_B, SESSION_A, '20');

    const snapshot = mocks.handlers.get(IPC_CHANNELS.PERMISSION_SNAPSHOT)!;
    expect(snapshot(eventFrom(10))).toEqual({
      approvals: [expect.objectContaining({ toolCallId: TOOL_A, sessionId: SESSION_A })],
    });
    expect(snapshot(eventFrom(20))).toEqual({
      approvals: [expect.objectContaining({ toolCallId: TOOL_B, sessionId: SESSION_A })],
    });
  });

  it('allows only the selected session owner window to answer an approval', async () => {
    addWindow(10);
    addWindow(20);
    mocks.selectedByWebContents.set(10, SESSION_A);
    mocks.selectedByWebContents.set(20, SESSION_A);
    const pending = createApproval(TOOL_A, SESSION_A, '10');
    const answer = mocks.handlers.get(IPC_CHANNELS.PERMISSION_APPROVAL_ANSWER)!;

    expect(answer(eventFrom(20), {
      toolCallId: TOOL_A,
      decision: 'approved',
    })).toEqual({ ok: false });
    expect(approvalStore.get(TOOL_A)).toBeDefined();

    mocks.selectedByWebContents.set(10, SESSION_B);
    expect(answer(eventFrom(10), {
      toolCallId: TOOL_A,
      decision: 'approved',
    })).toEqual({ ok: false });
    expect(approvalStore.get(TOOL_A)).toBeDefined();

    mocks.selectedByWebContents.set(10, SESSION_A);
    expect(answer(eventFrom(10), {
      toolCallId: TOOL_A,
      decision: 'approved',
    })).toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('settles owner-bound approvals and aborts only that owner main turn on close', async () => {
    addWindow(10);
    addWindow(20);
    mocks.activeTurnOwnerBySession.set(SESSION_A, '10');
    mocks.activeTurnOwnerBySession.set(SESSION_B, '20');
    const pendingA = createApproval(TOOL_A, SESSION_A, '10');
    const pendingB = createApproval(TOOL_B, SESSION_B, '20');

    const lifecycle = permissionIpc as typeof permissionIpc & {
      handlePermissionOwnerDestroyed: (ownerWindowId: string) => void;
    };
    lifecycle.handlePermissionOwnerDestroyed('10');

    await expect(pendingA).resolves.toEqual({ decision: 'denied', reason: 'cancelled' });
    expect(approvalStore.get(TOOL_A)).toBeUndefined();
    expect(approvalStore.get(TOOL_B)).toBeDefined();
    expect(mocks.forceAbortMainTurn).toHaveBeenCalledOnce();
    expect(mocks.forceAbortMainTurn).toHaveBeenCalledWith(SESSION_A);

    approvalStore.cancel(TOOL_B);
    await expect(pendingB).resolves.toEqual({ decision: 'denied', reason: 'cancelled' });
  });

  it('delivers a background-subagent approval using captured window affinity', async () => {
    const owner = addWindow(10);
    mocks.selectedByWebContents.set(10, SESSION_A);

    const pending = createApproval(TOOL_A, SESSION_A, '10');

    expect(owner.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED,
      expect.objectContaining({ toolCallId: TOOL_A, sessionId: SESSION_A }),
    );
    expect(approvalStore.get(TOOL_A)?.ownerWindowId).toBe('10');
    expect(mocks.forceAbortMainTurn).not.toHaveBeenCalled();

    approvalStore.answer(TOOL_A, 'approved');
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });
});
