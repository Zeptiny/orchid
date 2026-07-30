/**
 * U3 — Workspace binding IPC, draft state, folder gate, sticky updates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();

  type SessionShape = {
    id: string;
    name: string;
    model: string;
    cwd: string | null;
    chains: unknown[];
    activeChainId: string | null;
    createdAt: string;
    updatedAt: string;
    subagentChains: unknown[];
    todoStore: { tasks: unknown[] };
    selection?: { connectionId: string; modelId: string } | null;
    modelLabel?: string | null;
  };

  let activeSession: SessionShape | null = null;
  const activeSessionsByWindow = new Map<string, SessionShape | null>();
  const electronWebContents = {
    getAllWebContents: vi.fn(() => []),
  };

  /** Stable config object so sticky mutations stick across getConfig calls. */
  const configState = {
    default_model: 'test/model',
    default_project_dir: null as string | null,
  };

  let homeConfigPath = '';
  const dialogResult: { canceled: boolean; filePaths: string[] } = {
    canceled: true,
    filePaths: [],
  };

  const sessionManager = {
    getActive: vi.fn((windowId?: string) => (
      windowId === undefined
        ? activeSession
        : activeSessionsByWindow.has(windowId)
          ? activeSessionsByWindow.get(windowId) ?? null
          : activeSession
    )),
    clearActive: vi.fn(() => {
      activeSession = null;
    }),
    create: vi.fn((model: string, options?: { cwd?: string | null }) => {
      activeSession = {
        id: SESSION_UUID,
        name: 'Session test',
        model,
        cwd: options?.cwd ?? null,
        chains: [],
        activeChainId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subagentChains: [],
        todoStore: { tasks: [] },
      };
      return activeSession;
    }),
    switchTo: vi.fn((id: string) => {
      activeSession = {
        id,
        name: 'Loaded session',
        model: 'test/model',
        cwd: '/other/project',
        chains: [],
        activeChainId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subagentChains: [],
        todoStore: { tasks: [] },
      };
      return activeSession;
    }),
    load: vi.fn((id: string) => sessionManager.switchTo(id)),
    changeCwd: vi.fn((id: string, cwd: string) => {
      if (!activeSession || activeSession.id !== id) {
        throw new Error(`Cannot change cwd: session ${id} is not active`);
      }
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Cannot change cwd: invalid project directory`);
      }
      const real = fs.realpathSync(cwd);
      activeSession = { ...activeSession, cwd: real };
      return activeSession;
    }),
    getSession: vi.fn((id: string) => (activeSession?.id === id ? activeSession : null)),
    rename: vi.fn((id: string, name: string) => {
      if (!activeSession || activeSession.id !== id) return;
      activeSession = { ...activeSession, name };
    }),
    delete: vi.fn(() => true),
    changeModel: vi.fn((
      id: string,
      selection: { connectionId: string; modelId: string } | null,
      modelLabel: string | null = selection?.modelId ?? null,
    ) => {
      if (!activeSession || activeSession.id !== id) return;
      activeSession = {
        ...activeSession,
        selection,
        modelLabel,
        model: modelLabel ?? activeSession.model,
      };
    }),
    listSaved: vi.fn(() => []),
    _reset: () => {
      activeSession = null;
      activeSessionsByWindow.clear();
      configState.default_project_dir = null;
      sessionManager.getActive.mockClear();
      sessionManager.create.mockClear();
      sessionManager.switchTo.mockClear();
      sessionManager.changeCwd.mockClear();
      sessionManager.clearActive.mockClear();
      sessionManager.getSession.mockClear();
      sessionManager.rename.mockClear();
      sessionManager.changeModel.mockClear();
    },
    _setActiveForWindow: (windowId: string, session: SessionShape | null) => {
      activeSessionsByWindow.set(windowId, session);
    },
  };

  return {
    handlers,
    sessionManager,
    configState,
    dialogResult,
    get homeConfigPath() {
      return homeConfigPath;
    },
    set homeConfigPath(v: string) {
      homeConfigPath = v;
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
    },
    dialog: {
      showOpenDialog: vi.fn(async () => ({ ...dialogResult })),
    },
    BrowserWindow: {
      fromWebContents: vi.fn(() => ({ id: 1 })),
    },
    electronWebContents,
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  dialog: mocks.dialog,
  BrowserWindow: mocks.BrowserWindow,
  webContents: mocks.electronWebContents,
}));

vi.mock('../../src/main/config/loader', () => ({
  getConfig: vi.fn(() => mocks.configState),
  atomicWriteJson: vi.fn((filePath: string, data: unknown) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }),
  get HOME_CONFIG_PATH() {
    return mocks.homeConfigPath || path.join(os.tmpdir(), 'orchid-ws-test-home-config.json');
  },
  get HOME_CONFIG_DIR() {
    return path.dirname(
      mocks.homeConfigPath || path.join(os.tmpdir(), 'orchid-ws-test-home-config.json'),
    );
  },
  ConfigManager: {
    load: vi.fn(),
    save: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: vi.fn(() => ({
    get: vi.fn(() => ({
      config: { default_model: 'test/model' },
    })),
  })),
  clearProjectRuntimeRegistry: vi.fn(),
}));

vi.mock('../../src/main/ipc/chat-history', () => ({
  clearChatHistory: vi.fn(),
  seedChatHistory: vi.fn(),
}));

let sessionIpc: typeof import('../../src/main/ipc/session');
let workspace: typeof import('../../src/main/project/workspace');
let tmpProject: string;
let otherProject: string;
let homeDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
  mocks.electronWebContents.getAllWebContents.mockReset();
  mocks.electronWebContents.getAllWebContents.mockReturnValue([]);
  mocks.dialogResult.canceled = true;
  mocks.dialogResult.filePaths = [];

  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-ws-home-'));
  mocks.homeConfigPath = path.join(homeDir, 'config.json');
  fs.writeFileSync(mocks.homeConfigPath, JSON.stringify({}), 'utf-8');

  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-ws-proj-'));
  otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-ws-other-'));

  // Avoid resetModules so electron/chat mocks stay applied for require('./chat')
  sessionIpc = await import('../../src/main/ipc/session');
  workspace = await import('../../src/main/project/workspace');

  // Ensure singleton methods are our mocks (first import constructs real manager)
  const mgr = sessionIpc.getSessionManager();
  Object.assign(mgr, {
    getActive: mocks.sessionManager.getActive,
    clearActive: mocks.sessionManager.clearActive,
    create: mocks.sessionManager.create,
    switchTo: mocks.sessionManager.switchTo,
    load: mocks.sessionManager.load,
    changeCwd: mocks.sessionManager.changeCwd,
    getSession: mocks.sessionManager.getSession,
    rename: mocks.sessionManager.rename,
    delete: mocks.sessionManager.delete,
    changeModel: mocks.sessionManager.changeModel,
    listSaved: mocks.sessionManager.listSaved,
  });

  workspace.clearAllDraftCwds();

  // Re-register handlers cleanly
  sessionIpc.unregisterSessionIPC();
  sessionIpc.registerSessionIPC();
});

afterEach(() => {
  sessionIpc.unregisterSessionIPC();
  workspace.clearAllDraftCwds();
  mocks.handlers.clear();
  mocks.sessionManager._reset();
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(otherProject, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function sender(id = 1) {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
  };
}

describe('session workspace IPC', () => {
  it('resolveWorkspace uses sticky default when valid and no draft/session', async () => {
    mocks.configState.default_project_dir = tmpProject;
    const getWs = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_WORKSPACE);
    expect(getWs).toBeDefined();

    const result = await getWs!({ sender: sender(7) });
    expect(result).toMatchObject({
      source: 'default',
      status: 'valid',
    });
    expect(result.cwd).toBe(fs.realpathSync(tmpProject));
  });

  it('resolveWorkspace is unbound when sticky is null', async () => {
    mocks.configState.default_project_dir = null;
    const getWs = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_WORKSPACE);
    const result = await getWs!({ sender: sender(7) });
    expect(result).toEqual({
      cwd: null,
      source: 'unbound',
      status: 'unbound',
    });
  });

  it('releases draft-workspace get_function hashes when binding a different project', async () => {
    const {
      clearFunctionHashes,
      getFunctionHashCountForTests,
      getFunctionHandler,
    } = await import('../../src/main/tools/ast/get-function');
    const { setGetFunctionWorkerRunnerForTests } = await import(
      '../../src/main/tools/ast/get-function-worker-runner'
    );
    const filePath = path.join(tmpProject, 'example.py');
    fs.writeFileSync(filePath, 'pass\n');
    clearFunctionHashes();
    setGetFunctionWorkerRunnerForTests(async (request) => ({
      importsText: '',
      functions: [{
        name: request.functionName,
        startLine: 1,
        endLine: 1,
        body: 'pass',
        classContext: '',
      }],
    }));
    await getFunctionHandler(
      { file_path: filePath, function_name: 'example' },
      { cwd: tmpProject },
    );
    expect(getFunctionHashCountForTests()).toBe(1);

    workspace.setDraftCwd('42', tmpProject);
    await sessionIpc.bindProjectDirectory('42', otherProject);

    expect(getFunctionHashCountForTests()).toBe(0);
    setGetFunctionWorkerRunnerForTests(null);
  });

  it('set_workspace binds draft and updates sticky default', async () => {
    mocks.configState.default_project_dir = null;
    const setWs = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_WORKSPACE);
    expect(setWs).toBeDefined();
    const s = sender(3);

    const result = await setWs!({ sender: s }, { cwd: tmpProject });
    expect(result.status).toBe('valid');
    expect(result.source).toBe('draft');
    expect(result.cwd).toBe(fs.realpathSync(tmpProject));

    expect(mocks.configState.default_project_dir).toBe(fs.realpathSync(tmpProject));
    const homeRaw = JSON.parse(fs.readFileSync(mocks.homeConfigPath, 'utf-8'));
    expect(homeRaw.default_project_dir).toBe(fs.realpathSync(tmpProject));

    const events = s.send.mock.calls.filter(
      ([ch]: [string]) => ch === IPC_CHANNELS.SESSION_WORKSPACE_CHANGED,
    );
    expect(events).toHaveLength(1);
  });

  it('set_workspace updates active session cwd when a session is active', async () => {
    mocks.sessionManager.create('test/model', { cwd: otherProject });
    expect(mocks.sessionManager.getActive()).not.toBeNull();

    const setWs = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_WORKSPACE);
    const s = sender(4);
    const result = await setWs!({ sender: s }, { cwd: tmpProject });

    expect(mocks.sessionManager.changeCwd).toHaveBeenCalled();
    expect(result.source).toBe('session');
    expect(result.status).toBe('valid');
    expect(result.cwd).toBe(fs.realpathSync(tmpProject));
  });

  it('set_workspace starts a target-project draft from a non-empty session', async () => {
    mocks.sessionManager.create('test/model', { cwd: otherProject });
    mocks.sessionManager.getActive()!.chains.push({});

    const setWs = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_WORKSPACE);
    const result = await setWs!({ sender: sender(4) }, { cwd: tmpProject });

    expect(mocks.sessionManager.clearActive).toHaveBeenCalled();
    expect(mocks.sessionManager.changeCwd).not.toHaveBeenCalled();
    expect(mocks.sessionManager.getActive()).toBeNull();
    expect(result).toMatchObject({
      cwd: fs.realpathSync(tmpProject),
      source: 'draft',
      status: 'valid',
    });
  });

  it('clear_active keeps the selected project for the next New Chat draft', async () => {
    mocks.sessionManager.create('test/model', { cwd: tmpProject });
    const clear = mocks.handlers.get(IPC_CHANNELS.SESSION_CLEAR_ACTIVE);
    expect(clear).toBeDefined();

    await clear!({ sender: sender(4) });

    const getWorkspace = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_WORKSPACE)!;
    await expect(getWorkspace({ sender: sender(4) })).resolves.toMatchObject({
      cwd: fs.realpathSync(tmpProject),
      source: 'draft',
      status: 'valid',
    });
  });

  it('pick_project_dir uses dialog and binds when user selects a folder', async () => {
    mocks.dialogResult.canceled = false;
    mocks.dialogResult.filePaths = [tmpProject];

    const pick = mocks.handlers.get(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR);
    expect(pick).toBeDefined();
    const s = sender(5);
    const result = await pick!({ sender: s });

    expect(mocks.dialog.showOpenDialog).toHaveBeenCalled();
    expect(result.status).toBe('valid');
    expect(result.source).toBe('draft');
    expect(result.cwd).toBe(fs.realpathSync(tmpProject));
  });

  it('pick_project_dir turns a non-empty session into a draft instead of moving it', async () => {
    mocks.sessionManager.create('test/model', { cwd: otherProject });
    mocks.sessionManager.getActive()!.chains.push({});
    mocks.dialogResult.canceled = false;
    mocks.dialogResult.filePaths = [tmpProject];
    const pick = mocks.handlers.get(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR);

    const result = await pick!({ sender: sender(5) });

    expect(mocks.sessionManager.clearActive).toHaveBeenCalled();
    expect(mocks.sessionManager.changeCwd).not.toHaveBeenCalled();
    expect(mocks.sessionManager.getActive()).toBeNull();
    expect(result).toMatchObject({
      cwd: fs.realpathSync(tmpProject),
      source: 'draft',
      status: 'valid',
    });
  });

  it('pick_project_dir cancelled returns current workspace without sticky update', async () => {
    mocks.dialogResult.canceled = true;
    mocks.configState.default_project_dir = null;

    const pick = mocks.handlers.get(IPC_CHANNELS.SESSION_PICK_PROJECT_DIR);
    const before = fs.readFileSync(mocks.homeConfigPath, 'utf-8');
    const result = await pick!({ sender: sender(5) });

    expect(result).toEqual({
      cwd: null,
      source: 'unbound',
      status: 'unbound',
    });
    expect(fs.readFileSync(mocks.homeConfigPath, 'utf-8')).toBe(before);
  });

  it('session:load does not rewrite sticky default_project_dir', async () => {
    const stickyPath = fs.realpathSync(tmpProject);
    mocks.configState.default_project_dir = stickyPath;
    fs.writeFileSync(
      mocks.homeConfigPath,
      JSON.stringify({ default_project_dir: stickyPath }, null, 2),
    );

    const load = mocks.handlers.get(IPC_CHANNELS.SESSION_LOAD);
    expect(load).toBeDefined();
    const s = sender(8);

    await load!({ sender: s }, { id: SESSION_UUID });

    expect(mocks.sessionManager.switchTo).toHaveBeenCalled();
    expect(mocks.configState.default_project_dir).toBe(stickyPath);
    const homeRaw = JSON.parse(fs.readFileSync(mocks.homeConfigPath, 'utf-8'));
    expect(homeRaw.default_project_dir).toBe(stickyPath);

    const getWs = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_WORKSPACE)!;
    const ws = await getWs({ sender: s });
    expect(ws.source).toBe('session');
  });

  it('session:create uses resolved workspace cwd and fails when unbound', async () => {
    mocks.configState.default_project_dir = null;
    const create = mocks.handlers.get(IPC_CHANNELS.SESSION_CREATE);
    expect(create).toBeDefined();

    await expect(create!({ sender: sender(9) })).rejects.toThrow(/project folder/i);
    expect(mocks.sessionManager.create).not.toHaveBeenCalled();

    const setWs = mocks.handlers.get(IPC_CHANNELS.SESSION_SET_WORKSPACE)!;
    await setWs({ sender: sender(9) }, { cwd: tmpProject });

    const session = await create!({ sender: sender(9) });
    expect(mocks.sessionManager.create).toHaveBeenCalledWith(
      'test/model',
      { cwd: fs.realpathSync(tmpProject) },
      '9',
    );
    expect(session.cwd).toBe(fs.realpathSync(tmpProject));
  });

  it('session:change_cwd updates session and sticky default', async () => {
    mocks.sessionManager.create('test/model', { cwd: fs.realpathSync(otherProject) });
    const active = mocks.sessionManager.getActive()!;
    const changeCwd = mocks.handlers.get(IPC_CHANNELS.SESSION_CHANGE_CWD);
    expect(changeCwd).toBeDefined();

    const s = sender(10);
    const updated = await changeCwd!(
      { sender: s },
      { id: active.id, cwd: tmpProject },
    );

    expect(updated.cwd).toBe(fs.realpathSync(tmpProject));
    expect(mocks.configState.default_project_dir).toBe(fs.realpathSync(tmpProject));
    const homeRaw = JSON.parse(fs.readFileSync(mocks.homeConfigPath, 'utf-8'));
    expect(homeRaw.default_project_dir).toBe(fs.realpathSync(tmpProject));
  });

  it('session:change_cwd turns a non-empty conversation into a draft', async () => {
    mocks.sessionManager.create('test/model', { cwd: fs.realpathSync(otherProject) });
    const active = mocks.sessionManager.getActive()!;
    active.chains.push({});
    const changeCwd = mocks.handlers.get(IPC_CHANNELS.SESSION_CHANGE_CWD);

    const result = await changeCwd!(
      { sender: sender(10) },
      { id: active.id, cwd: tmpProject },
    );

    expect(result).toBeNull();
    expect(mocks.sessionManager.changeCwd).not.toHaveBeenCalled();
    expect(mocks.sessionManager.clearActive).toHaveBeenCalled();
    expect(mocks.sessionManager.getActive()).toBeNull();
  });

  it('draft takes priority over sticky default', async () => {
    mocks.configState.default_project_dir = otherProject;
    workspace.setDraftCwd('11', fs.realpathSync(tmpProject));

    const getWs = mocks.handlers.get(IPC_CHANNELS.SESSION_GET_WORKSPACE)!;
    const result = await getWs({ sender: sender(11) });
    expect(result.source).toBe('draft');
    expect(result.cwd).toBe(fs.realpathSync(tmpProject));
  });

  it('session:rename returns unchanged and skips emit when name is already set', async () => {
    mocks.sessionManager.create('test/model', { cwd: tmpProject });
    const active = mocks.sessionManager.getActive()!;
    active.name = 'Same Name';
    const rename = mocks.handlers.get(IPC_CHANNELS.SESSION_RENAME);
    expect(rename).toBeDefined();
    const s = sender(12);

    const result = await rename!({ sender: s }, { id: active.id, name: 'Same Name' });

    expect(result).toEqual({ status: 'unchanged', name: 'Same Name' });
    expect(mocks.sessionManager.rename).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it('session:rename notifies every window still selecting the renamed session', async () => {
    mocks.sessionManager.create('test/model', { cwd: tmpProject });
    const active = mocks.sessionManager.getActive()!;
    active.name = 'Old Name';
    const rename = mocks.handlers.get(IPC_CHANNELS.SESSION_RENAME)!;
    const source = sender(13);
    const sameSession = sender(14);
    const differentSession = sender(15);
    mocks.sessionManager._setActiveForWindow('13', active);
    mocks.sessionManager._setActiveForWindow('14', active);
    mocks.sessionManager._setActiveForWindow('15', {
      ...active,
      id: 'different-session',
    });
    mocks.electronWebContents.getAllWebContents.mockReturnValue([
      source,
      sameSession,
      differentSession,
    ]);

    const result = await rename({ sender: source }, { id: active.id, name: 'New Name' });

    expect(result).toEqual({ status: 'renamed' });
    expect(mocks.sessionManager.rename).toHaveBeenCalledWith(active.id, 'New Name');
    expect(source.send).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_RENAMED, {
      id: active.id,
      name: 'New Name',
    });
    expect(sameSession.send).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_RENAMED, {
      id: active.id,
      name: 'New Name',
    });
    expect(differentSession.send).not.toHaveBeenCalled();
  });

  it('session:change_model returns unchanged when selection is already the same', async () => {
    const selection = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    mocks.sessionManager.create('test/model', { cwd: tmpProject });
    const active = mocks.sessionManager.getActive()!;
    active.selection = selection;
    active.modelLabel = selection.modelId;
    const changeModel = mocks.handlers.get(IPC_CHANNELS.SESSION_CHANGE_MODEL);
    expect(changeModel).toBeDefined();

    const result = await changeModel!(
      { sender: sender(14) },
      { id: active.id, selection, modelLabel: selection.modelId },
    );

    expect(result).toEqual({
      status: 'unchanged',
      selection,
      modelLabel: selection.modelId,
    });
    expect(mocks.sessionManager.changeModel).not.toHaveBeenCalled();
  });

  it('session:change_model returns changed when selection differs', async () => {
    const prev = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      modelId: 'vendor/path/model',
    };
    const next = {
      connectionId: '22222222-2222-4222-8222-222222222222',
      modelId: 'other/model',
    };
    mocks.sessionManager.create('test/model', { cwd: tmpProject });
    const active = mocks.sessionManager.getActive()!;
    active.selection = prev;
    active.modelLabel = prev.modelId;
    const changeModel = mocks.handlers.get(IPC_CHANNELS.SESSION_CHANGE_MODEL)!;

    const result = await changeModel(
      { sender: sender(15) },
      { id: active.id, selection: next },
    );

    expect(result).toEqual({
      status: 'changed',
      selection: next,
      modelLabel: next.modelId,
    });
    expect(mocks.sessionManager.changeModel).toHaveBeenCalledWith(
      active.id,
      next,
      next.modelId,
    );
  });
});
