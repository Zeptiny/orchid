import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { activeAgents, type ActiveAgent } from '../../src/main/host/chat/state';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn();
  return {
    handlers,
    send,
    subagentRecords: [] as Array<{ sessionId: string | null; state: string }>,
    subagentListeners: new Set<(records: ReadonlyArray<{ sessionId: string | null; state: string }>) => void>(),
    backgroundEntries: [] as Array<{ sessionId: string | null; exitCode: number | null }>,
    backgroundListeners: new Set<(sessionId: string | null) => void>(),
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
  getBackgroundStore: () => ({ list: () => mocks.backgroundEntries }),
  subscribeBackgroundProcessChanges: (listener: (sessionId: string | null) => void) => {
    mocks.backgroundListeners.add(listener);
    return () => mocks.backgroundListeners.delete(listener);
  },
}));

vi.mock('../../src/main/tools', () => ({
  // U5: the embedded local host's HostServer installs its own notifier.
  setTodosChangedNotifier: vi.fn(),
  getSubagentManager: () => ({
    allRecords: () => mocks.subagentRecords,
    getStates: (sessionId: string) => mocks.subagentRecords.filter(
      (record) => record.sessionId === sessionId,
    ),
    addOnChangeListener: (listener: (records: ReadonlyArray<{ sessionId: string | null; state: string }>) => void) => {
      mocks.subagentListeners.add(listener);
      return () => mocks.subagentListeners.delete(listener);
    },
  }),
}));

import {
  publishSessionActivity,
  completeSessionActivity,
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
    mocks.subagentRecords.length = 0;
    mocks.subagentListeners.clear();
    mocks.backgroundEntries.length = 0;
    mocks.backgroundListeners.clear();
    activeAgents.clear();
    registerSessionActivityIPC();
  });

  it('lists, marks seen, and broadcasts the addressed activity', async () => {
    publishSessionActivity(SESSION_ID, { state: 'idle', unread: true });
    const list = mocks.handlers.get(IPC_CHANNELS.SESSION_ACTIVITY_LIST)!;
    const markSeen = mocks.handlers.get(IPC_CHANNELS.SESSION_ACTIVITY_MARK_SEEN)!;

    expect(await list({ sender: { id: 1 } })).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, unread: true }),
    ]);
    expect(await markSeen({ sender: { id: 1 } }, { id: SESSION_ID })).toMatchObject({
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

  it('keeps the session active until its final subagent completes', () => {
    mocks.subagentRecords.push({ sessionId: SESSION_ID, state: 'running' });
    for (const listener of mocks.subagentListeners) listener(mocks.subagentRecords);

    completeSessionActivity(SESSION_ID, true);

    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({
        sessionId: SESSION_ID,
        state: 'working',
        phase: 'subagent',
        unread: false,
        canCancel: true,
      }) },
    );

    mocks.subagentRecords[0].state = 'completed';
    for (const listener of mocks.subagentListeners) listener(mocks.subagentRecords);

    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({
        sessionId: SESSION_ID,
        state: 'idle',
        unread: true,
        canCancel: false,
      }) },
    );
  });

  it('restores a live parent turn after its final subagent completes', () => {
    activeAgents.set(SESSION_ID, {
      agentCancelled: false,
      finalized: false,
    } as ActiveAgent);
    publishSessionActivity(SESSION_ID, {
      state: 'working',
      phase: 'agent',
      detail: 'Generating response',
      canCancel: true,
    });

    mocks.subagentRecords.push({ sessionId: SESSION_ID, state: 'running' });
    for (const listener of mocks.subagentListeners) listener(mocks.subagentRecords);

    mocks.subagentRecords[0].state = 'completed';
    for (const listener of mocks.subagentListeners) listener(mocks.subagentRecords);

    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({
        sessionId: SESSION_ID,
        state: 'working',
        phase: 'agent',
        detail: 'Generating response',
        unread: false,
        canCancel: true,
        completedAt: null,
      }) },
    );
  });

  it('publishes background process starts and exits without waiting for an activity list refresh', () => {
    mocks.backgroundEntries.push({ sessionId: SESSION_ID, exitCode: null });
    for (const listener of mocks.backgroundListeners) listener(SESSION_ID);

    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({
        sessionId: SESSION_ID,
        state: 'idle',
        phase: 'command',
        backgroundProcessCount: 1,
        unread: false,
        canCancel: true,
      }) },
    );

    mocks.backgroundEntries[0].exitCode = 0;
    for (const listener of mocks.backgroundListeners) listener(SESSION_ID);

    expect(mocks.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.SESSION_ACTIVITY_CHANGED,
      { activity: expect.objectContaining({
        sessionId: SESSION_ID,
        state: 'idle',
        backgroundProcessCount: 0,
        unread: true,
        canCancel: false,
      }) },
    );
  });
});
