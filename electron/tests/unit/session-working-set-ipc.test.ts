import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn();
  const listSaved = vi.fn(() => [] as { id: string }[]);
  const statePath = nodePath.join(
    nodeOs.tmpdir(),
    `ws-ipc-${Date.now()}-${Math.random()}.json`,
  );
  const sessionsDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'orchid-sessions-'));
  return {
    handlers,
    send,
    listSaved,
    statePath,
    sessionsDir,
    nodeFs,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send: mocks.send },
    }],
  },
}));

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => ({
    listSaved: mocks.listSaved,
  }),
}));

vi.mock('../../src/main/session/storage', () => ({
  SESSIONS_DIR: mocks.sessionsDir,
}));

vi.mock('../../src/main/session/working-set', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/session/working-set')>(
    '../../src/main/session/working-set',
  );
  const store = new actual.WorkingSetStore({ statePath: mocks.statePath });
  return {
    WorkingSetStore: actual.WorkingSetStore,
    sessionWorkingSet: store,
  };
});

import {
  registerSessionWorkingSetIPC,
  tryListSessionCatalog,
  unregisterSessionWorkingSetIPC,
  workingSetOpenOrFocus,
  workingSetRemove,
} from '../../src/main/ipc/session-working-set';
import { sessionWorkingSet } from '../../src/main/session/working-set';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function event(owner = 1) {
  return { sender: { id: owner } };
}

describe('session working-set IPC', () => {
  beforeEach(() => {
    unregisterSessionWorkingSetIPC();
    mocks.handlers.clear();
    mocks.send.mockClear();
    mocks.listSaved.mockReset();
    mocks.listSaved.mockReturnValue([{ id: A }, { id: B }]);
    try {
      mocks.nodeFs.unlinkSync(mocks.statePath);
    } catch {
      // ok
    }
    sessionWorkingSet.filterExisting([]);
    sessionWorkingSet.setFocus(null);
    registerSessionWorkingSetIPC();
  });

  it('open-or-focus rejects ids not in the session catalog', async () => {
    const open = mocks.handlers.get(IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS)!;
    const snap = await open(event(), { id: MISSING });
    expect(snap.openSessionIds).toEqual([]);
  });

  it('open-or-focus appends existing sessions and broadcasts', async () => {
    const open = mocks.handlers.get(IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS)!;
    const snap = await open(event(), { id: A });
    expect(snap.openSessionIds).toEqual([A]);
    expect(snap.focusedSessionId).toBe(A);
    expect(mocks.send).toHaveBeenCalledWith(
      IPC_CHANNELS.SESSION_WORKING_SET_CHANGED,
      expect.objectContaining({
        snapshot: expect.objectContaining({ focusedSessionId: A }),
      }),
    );
  });

  it('close returns MRU focus for that owner', async () => {
    workingSetOpenOrFocus(A, '1');
    workingSetOpenOrFocus(B, '1');
    const close = mocks.handlers.get(IPC_CHANNELS.SESSION_WORKING_SET_CLOSE)!;
    const snap = await close(event(), { id: B });
    expect(snap.openSessionIds).toEqual([A]);
    expect(snap.focusedSessionId).toBe(A);
  });

  it('remove drops membership used by delete path', () => {
    workingSetOpenOrFocus(A, '1');
    workingSetOpenOrFocus(B, '1');
    workingSetRemove(A, '1');
    expect(sessionWorkingSet.getSnapshot('1').openSessionIds).toEqual([B]);
  });

  it('get filters missing sessions when catalog is ok', async () => {
    workingSetOpenOrFocus(A, '1');
    workingSetOpenOrFocus(B, '1');
    mocks.listSaved.mockReturnValue([{ id: A }]);
    const get = mocks.handlers.get(IPC_CHANNELS.SESSION_WORKING_SET_GET)!;
    const snap = await get(event());
    expect(snap.openSessionIds).toEqual([A]);
  });

  it('tryListSessionCatalog returns ok for readable sessions dir', () => {
    const catalog = tryListSessionCatalog();
    expect(catalog.status).toBe('ok');
    if (catalog.status === 'ok') {
      expect(catalog.ids.has(A)).toBe(true);
    }
  });

  it('invalid payload is rejected by Zod', async () => {
    const open = mocks.handlers.get(IPC_CHANNELS.SESSION_WORKING_SET_OPEN_OR_FOCUS)!;
    await expect(open(event(), { id: 'not-a-uuid' })).rejects.toThrow(/Invalid/);
  });
});
