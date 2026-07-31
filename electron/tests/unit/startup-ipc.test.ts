import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { StartupState, type StartupClock } from '../../src/main/startup';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
  };
});

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain, BrowserWindow: mocks.BrowserWindow }));

let startupIpc: typeof import('../../src/main/ipc/startup');
let state: StartupState;

function clockAt(initial = 0): { clock: StartupClock; advance: (ms: number) => void } {
  let now = initial;
  return { clock: () => now, advance: (ms) => { now += ms; } };
}

function handler(channel: string) {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

beforeEach(async () => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.ipcMain.handle.mockClear();
  mocks.ipcMain.removeHandler.mockClear();
  mocks.BrowserWindow.getAllWindows.mockReturnValue([]);
  startupIpc = await import('../../src/main/ipc/startup');
  state = new StartupState(clockAt().clock);
  startupIpc.registerStartupIPC(state);
});

afterEach(() => startupIpc.unregisterStartupIPC());

describe('startup IPC', () => {
  it('accepts no renderer payload and returns the current snapshot', async () => {
    const snapshot = handler(IPC_CHANNELS.STARTUP_SNAPSHOT);
    await expect(snapshot({ sender: {} })).resolves.toEqual(state.snapshot());
  });

  it('rejects payloads for both no-payload startup handlers', async () => {
    const snapshot = handler(IPC_CHANNELS.STARTUP_SNAPSHOT);
    const continueDegraded = handler(IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED);

    await expect(snapshot({ sender: {} }, { ignored: true })).rejects.toThrow(/does not accept payload/i);
    await expect(continueDegraded({ sender: {} }, { ignored: true })).rejects.toThrow(/does not accept payload/i);
  });

  it('broadcasts each immutable state change to live windows', () => {
    const healthy = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } };
    const destroyed = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } };
    mocks.BrowserWindow.getAllWindows.mockReturnValue([healthy, destroyed]);

    state.activate('opening_window');

    expect(healthy.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.STARTUP_CHANGED, state.snapshot());
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it('keeps publishing when a window is destroyed during delivery', () => {
    const raced = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(() => { throw new Error('window closed'); }),
      },
    };
    const healthy = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: vi.fn() },
    };
    mocks.BrowserWindow.getAllWindows.mockReturnValue([raced, healthy]);

    expect(() => state.activate('opening_window')).not.toThrow();
    expect(healthy.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.STARTUP_CHANGED,
      state.snapshot(),
    );
  });

  it('only acknowledges degraded once and only from degraded', async () => {
    const continueDegraded = handler(IPC_CHANNELS.STARTUP_CONTINUE_DEGRADED);
    await expect(continueDegraded({ sender: {} })).resolves.toEqual({ ok: false, snapshot: state.snapshot() });

    for (const id of ['opening_window', 'settings_providers', 'agents_tools'] as const) {
      state.activate(id);
      state.complete(id);
    }
    state.activate('tool_workers');
    state.recordWorkerOutcome('failure');
    state.activate('preparing_interface');
    state.complete('preparing_interface');
    state.degraded();

    await expect(continueDegraded({ sender: {} })).resolves.toMatchObject({ ok: true, snapshot: { phase: 'ready' } });
    await expect(continueDegraded({ sender: {} })).resolves.toMatchObject({ ok: false, snapshot: { phase: 'ready' } });
  });
});
