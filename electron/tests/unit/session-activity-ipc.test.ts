import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn();
  return {
    handlers,
    send,
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
      webContents: { isDestroyed: () => false, send: mocks.send },
    }],
  },
}));

vi.mock('../../src/main/tools/process/background-store', () => ({
  getBackgroundStore: () => ({ list: () => [] }),
}));

import {
  publishSessionActivity,
  registerSessionActivityIPC,
  removeSessionActivity,
  unregisterSessionActivityIPC,
} from '../../src/main/ipc/session-activity';

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('session activity IPC', () => {
  beforeEach(() => {
    unregisterSessionActivityIPC();
    mocks.handlers.clear();
    mocks.send.mockClear();
    registerSessionActivityIPC();
  });

  it('lists, marks seen, and broadcasts the addressed activity', async () => {
    publishSessionActivity(SESSION_ID, { state: 'idle', unread: true });
    const list = mocks.handlers.get(IPC_CHANNELS.SESSION_ACTIVITY_LIST)!;
    const markSeen = mocks.handlers.get(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN)!;

    expect(await list()).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, unread: true }),
    ]);
    expect(await markSeen({}, { id: SESSION_ID })).toMatchObject({
      sessionId: SESSION_ID,
      unread: false,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({ sessionId: SESSION_ID, unread: false }) },
    );
  });

  it('broadcasts a removable tombstone for deleted activity', () => {
    publishSessionActivity(SESSION_ID, { state: 'working', unread: true });
    removeSessionActivity(SESSION_ID);

    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({
        sessionId: SESSION_ID,
        state: 'idle',
        unread: false,
        backgroundProcessCount: 0,
      }) },
    );
  });
});
