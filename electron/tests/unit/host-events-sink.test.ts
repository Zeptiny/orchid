/**
 * HostEventSink — the injectable delivery seam behind the host chat pipeline.
 *
 * Pins the no-op default (plain-Node hosts must never throw or deliver), the
 * wrapper delegation the pipeline calls through, chat-state dedup (every sink
 * inherits it), the shared turn-identity sequencing, and that the Electron
 * chat IPC registration installs its window-broadcast sink.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionUpdatedEvent,
  getHostEventSink,
  nextEventIdentity,
  setHostEventSink,
  type HostEventSink,
} from '../../src/main/host/events';
import {
  canDeliverTo,
  emitSessionUpdated,
  sendChatState,
  sendSessionEvent,
  sendTurnEvent,
} from '../../src/main/host/chat/events';
import type { ActiveAgent, ChatStatePayload } from '../../src/main/host/chat/state';
import type { Chain } from '../../src/shared/types/chain';
import { ChainStatus } from '../../src/shared/types/chain';
import type { Session } from '../../src/shared/types/session';

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
  };
});

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: {
    fromId: vi.fn(() => null),
    getAllWebContents: vi.fn(() => []),
  },
}));

vi.mock('../../src/main/tools', () => ({
  getSubagentManager: vi.fn(() => ({
    getStates: vi.fn(() => []),
    cancelRunning: vi.fn(() => []),
    discardSession: vi.fn(),
  })),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: vi.fn(async function* () {}),
}));

vi.mock('../../src/main/tools/process/background-store', () => ({
  getBackgroundStore: vi.fn(() => ({ list: vi.fn(() => []) })),
  subscribeBackgroundProcessChanges: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: vi.fn(() => ({ getActive: vi.fn(() => null), getSession: vi.fn(() => null) })),
  resolveWindowWorkspace: vi.fn(() => ({ cwd: null, source: 'unbound', status: 'unbound' })),
}));

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '4242';

function makeActive(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    sessionId: SESSION_ID,
    windowId: CLIENT_ID,
    turnId: 'turn-1',
    eventSequence: 0,
    lastChatState: null,
    finalized: false,
    ...overrides,
  } as unknown as ActiveAgent;
}

beforeEach(() => {
  setHostEventSink(null);
});

afterEach(() => {
  setHostEventSink(null);
});

describe('default sink', () => {
  it('is a safe no-op: no delivery call throws', () => {
    const active = makeActive();
    expect(() => {
      sendTurnEvent(CLIENT_ID, active, 'chat:chunk', { type: 'chunk', data: 'x' });
      sendSessionEvent(null, SESSION_ID, 'session:updated', { sessionId: SESSION_ID });
      sendChatState(CLIENT_ID, active, {
        state: 'streaming', error: null, interruptState: 'idle', cwd: '/tmp',
      });
      emitSessionUpdated(CLIENT_ID, SESSION_ID);
    }).not.toThrow();
  });

  it('reports every client as undeliverable', () => {
    expect(canDeliverTo(CLIENT_ID)).toBe(false);
    expect(getHostEventSink().canDeliverTo(CLIENT_ID)).toBe(false);
  });

  it('still advances chat-state dedup so a later sink sees the next state', () => {
    const active = makeActive();
    const payload: ChatStatePayload = {
      state: 'streaming', error: null, interruptState: 'idle', cwd: null,
    };
    sendChatState(CLIENT_ID, active, payload);
    sendChatState(CLIENT_ID, active, payload);
    expect(active.lastChatState).toEqual(payload);

    const sink: HostEventSink = {
      sendTurnEvent: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendChatState: vi.fn(),
      emitSessionUpdated: vi.fn(),
      canDeliverTo: vi.fn(() => true),
    };
    setHostEventSink(sink);
    // Identical to lastChatState → suppressed even for the new sink.
    sendChatState(CLIENT_ID, active, payload);
    expect(sink.sendChatState).not.toHaveBeenCalled();
    sendChatState(CLIENT_ID, active, { ...payload, state: 'toolExec' });
    expect(sink.sendChatState).toHaveBeenCalledTimes(1);
  });
});

describe('installed sink', () => {
  it('receives turn and session deliveries with the pipeline arguments', () => {
    const sink: HostEventSink = {
      sendTurnEvent: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendChatState: vi.fn(),
      emitSessionUpdated: vi.fn(),
      canDeliverTo: vi.fn(() => true),
    };
    setHostEventSink(sink);
    const active = makeActive();
    const payload = { type: 'chunk', data: 'x' };

    sendTurnEvent(CLIENT_ID, active, 'chat:chunk', payload);
    sendSessionEvent(CLIENT_ID, SESSION_ID, 'session:renamed', { id: SESSION_ID });
    sendSessionEvent(null, SESSION_ID, 'session:compaction', { sessionId: SESSION_ID });
    emitSessionUpdated(null, SESSION_ID);
    expect(canDeliverTo(CLIENT_ID)).toBe(true);

    expect(sink.sendTurnEvent).toHaveBeenCalledWith(CLIENT_ID, active, 'chat:chunk', payload);
    expect(sink.sendSessionEvent).toHaveBeenCalledTimes(2);
    expect(sink.sendSessionEvent).toHaveBeenNthCalledWith(
      1, CLIENT_ID, SESSION_ID, 'session:renamed', { id: SESSION_ID },
    );
    expect(sink.sendSessionEvent).toHaveBeenNthCalledWith(
      2, null, SESSION_ID, 'session:compaction', { sessionId: SESSION_ID },
    );
    expect(sink.emitSessionUpdated).toHaveBeenCalledWith(null, SESSION_ID);
    expect(sink.canDeliverTo).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('suppresses repeat identical chat states and forwards changes once', () => {
    const sink: HostEventSink = {
      sendTurnEvent: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendChatState: vi.fn(),
      emitSessionUpdated: vi.fn(),
      canDeliverTo: vi.fn(() => true),
    };
    setHostEventSink(sink);
    const active = makeActive();

    sendChatState(CLIENT_ID, active, {
      state: 'streaming', error: null, interruptState: 'idle', cwd: '/tmp',
    });
    sendChatState(CLIENT_ID, active, {
      state: 'streaming', error: null, interruptState: 'idle', cwd: '/tmp',
    });
    expect(sink.sendChatState).toHaveBeenCalledTimes(1);

    sendChatState(CLIENT_ID, active, {
      state: 'streaming', error: 'boom', interruptState: 'idle', cwd: '/tmp',
    });
    sendChatState(CLIENT_ID, active, {
      state: 'streaming', error: 'boom', interruptState: 'confirmAgent', cwd: '/tmp',
    });
    expect(sink.sendChatState).toHaveBeenCalledTimes(3);
    expect(active.lastChatState).toMatchObject({ interruptState: 'confirmAgent' });
  });

  it('restores the no-op default when uninstalled', () => {
    const sink: HostEventSink = {
      sendTurnEvent: vi.fn(),
      sendSessionEvent: vi.fn(),
      sendChatState: vi.fn(),
      emitSessionUpdated: vi.fn(),
      canDeliverTo: vi.fn(() => true),
    };
    setHostEventSink(sink);
    expect(getHostEventSink()).toBe(sink);
    setHostEventSink(null);
    expect(getHostEventSink()).not.toBe(sink);
    expect(canDeliverTo(CLIENT_ID)).toBe(false);
  });
});

describe('turn identity sequencing', () => {
  it('mints a monotonic sequence bound to the session and turn', () => {
    const active = makeActive({ turnId: 'turn-9' });
    const first = nextEventIdentity(active);
    const second = nextEventIdentity(active);
    const third = nextEventIdentity(active);
    expect(first).toEqual({ sessionId: SESSION_ID, turnId: 'turn-9', sequence: 1 });
    expect(second.sequence).toBe(2);
    expect(third.sequence).toBe(3);
    expect(active.eventSequence).toBe(3);
  });
});

describe('buildSessionUpdatedEvent', () => {
  const chain = (id: string): Chain => ({
    id,
    sessionId: SESSION_ID,
    messages: [],
    status: ChainStatus.COMPLETED,
    selection: null,
    modelLabel: null,
    agentName: 'general',
    agentType: 'internal',
    agentTier: 'bloom',
    subagentRecord: null,
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    errorDetail: null,
    errorTitle: null,
  });

  it('patches the active chain by default and nulls when no chain exists', () => {
    const session = {
      id: SESSION_ID,
      activeChainId: 'c2',
      updatedAt: '2026-01-01T00:00:02.000Z',
      chains: [chain('c1'), chain('c2')],
    } as unknown as Session;

    expect(buildSessionUpdatedEvent(session)).toMatchObject({
      sessionId: SESSION_ID,
      activeChainId: 'c2',
      updatedAt: '2026-01-01T00:00:02.000Z',
      chain: expect.objectContaining({ id: 'c2' }),
    });
    expect(buildSessionUpdatedEvent(session, 'c1')).toMatchObject({
      chain: expect.objectContaining({ id: 'c1' }),
    });
    expect(buildSessionUpdatedEvent({ ...session, chains: [] } as unknown as Session)).toBeNull();
  });
});

describe('Electron chat IPC no longer installs the sink (U5)', () => {
  it('registerChatIPC leaves the sink alone; the embedded local host owns it', async () => {
    const chatIpc = await import('../../src/main/ipc/chat');
    const before = getHostEventSink();

    chatIpc.registerChatIPC();
    expect(getHostEventSink()).toBe(before);

    chatIpc.unregisterChatIPC();
    expect(getHostEventSink()).toBe(before);
    expect(canDeliverTo(CLIENT_ID)).toBe(false);
  });
});
