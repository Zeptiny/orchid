/**
 * Auto-update tests — headless main-process lifecycle.
 *
 * Covers:
 * - Mock server returns new version → in-process state
 * - Download → progress state
 * - Restart → quitAndInstall
 * - Unsigned → disabled auto-download
 * - Same version → not-available
 * - Error handling
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock electron and electron-updater before importing updater
// ---------------------------------------------------------------------------

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowDowngrade: false,
  disableDifferentialDownload: false,
  logger: null as unknown,
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
};

const mockApp = {
  isPackaged: true,
  removeAllListeners: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
};

const mockUpdateConfigExists = vi.fn(() => true);
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('node:fs', () => ({
  existsSync: mockUpdateConfigExists,
}));

const mockTerminateAll = vi.fn();
vi.mock('../../src/main/tools/process/background-store', () => ({
  getBackgroundStore: () => ({
    terminateAll: mockTerminateAll,
    clear: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import updater after mock setup
// ---------------------------------------------------------------------------

let updater: typeof import('../../src/main/updater');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  mockAutoUpdater.autoDownload = true;
  mockAutoUpdater.autoInstallOnAppQuit = true;
  mockAutoUpdater.allowDowngrade = false;
  mockAutoUpdater.disableDifferentialDownload = false;
  mockApp.isPackaged = true;
  mockTerminateAll.mockClear();
  mockUpdateConfigExists.mockReset();
  mockUpdateConfigExists.mockReturnValue(true);
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: '/test/orchid/resources',
  });

  mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);
  mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

  vi.doMock('electron-updater', () => ({
    autoUpdater: mockAutoUpdater,
  }));

  vi.doMock('electron', () => ({
    app: mockApp,
  }));

  updater = await import('../../src/main/updater');
});

afterEach(() => {
  updater.destroyUpdater();
  vi.restoreAllMocks();
  if (originalResourcesPath) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  } else {
    Reflect.deleteProperty(process, 'resourcesPath');
  }
});

// ===========================================================================
// Initialization
// ===========================================================================

describe('initUpdater', () => {
  it('configures autoDownload to false', () => {
    updater.initUpdater();

    expect(mockAutoUpdater.autoDownload).toBe(false);
  });

  it('configures autoInstallOnAppQuit to false', () => {
    updater.initUpdater();

    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('attaches event handlers', () => {
    updater.initUpdater();

    const registeredEvents = mockAutoUpdater.on.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(registeredEvents).toContain('checking-for-update');
    expect(registeredEvents).toContain('update-available');
    expect(registeredEvents).toContain('update-not-available');
    expect(registeredEvents).toContain('download-progress');
    expect(registeredEvents).toContain('update-downloaded');
    expect(registeredEvents).toContain('error');
  });
});

// ===========================================================================
// Update check — new version available
// ===========================================================================

describe('checkForUpdates — new version available', () => {
  it('records status with version when update is available', async () => {
    updater.initUpdater({ signed: true });

    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    expect(updateAvailableHandler).toBeDefined();

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: 'New features',
    });

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'available',
      version: '2.0.0',
      releaseNotes: 'New features',
    });
  });

  it('auto-downloads for signed releases', async () => {
    updater.initUpdater({ signed: true });

    mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it('does not auto-download for unsigned releases', async () => {
    updater.initUpdater({ signed: false });

    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Update check — same version
// ===========================================================================

describe('checkForUpdates — same version', () => {
  it('records not-available status when no update', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-not-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    expect(handler).toBeDefined();

    handler!({
      version: '1.0.0',
    });

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'not-available',
      version: null,
    });
  });
});

// ===========================================================================
// Download progress
// ===========================================================================

describe('download progress', () => {
  it('records progress during download', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'download-progress',
    )?.[1] as ((progress: unknown) => void) | undefined;

    expect(handler).toBeDefined();

    handler!({
      percent: 50,
      bytesPerSecond: 1000000,
      transferred: 5000000,
      total: 10000000,
    });

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'downloading',
      progress: 50,
    });
  });

  it('rounds progress percentage', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'download-progress',
    )?.[1] as ((progress: unknown) => void) | undefined;

    handler!({
      percent: 33.333,
      bytesPerSecond: 1000000,
      transferred: 3333333,
      total: 10000000,
    });

    expect(updater.getUpdaterState().progress).toBe(33);
  });
});

// ===========================================================================
// Update downloaded — restart prompt
// ===========================================================================

describe('update downloaded', () => {
  it('records downloaded status when update is ready', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-downloaded',
    )?.[1] as ((info: unknown) => void) | undefined;

    expect(handler).toBeDefined();

    handler!({
      version: '2.0.0',
    });

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'downloaded',
      progress: 100,
    });
  });
});

// ===========================================================================
// Quit and install
// ===========================================================================

describe('quitAndInstall', () => {
  it('calls autoUpdater.quitAndInstall', () => {
    updater.quitAndInstall();

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('removes before-quit listeners before installing', () => {
    updater.quitAndInstall();

    expect(mockApp.removeAllListeners).toHaveBeenCalledWith('before-quit');
  });

  it('terminates background process groups before stripping before-quit', () => {
    mockTerminateAll.mockClear();
    updater.quitAndInstall();

    expect(mockTerminateAll).toHaveBeenCalled();
    expect(mockApp.removeAllListeners).toHaveBeenCalledWith('before-quit');
  });

  it('flushes subagents before removing the quit guard', () => {
    const order: string[] = [];
    mockApp.removeAllListeners.mockImplementationOnce(() => order.push('remove'));
    updater.initUpdater({
      flushBeforeInstall: () => order.push('flush'),
    });
    updater.quitAndInstall();
    expect(order).toEqual(['flush', 'remove']);
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe('error handling', () => {
  it('records error status when update check fails', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'error',
    )?.[1] as ((error: Error) => void) | undefined;

    expect(handler).toBeDefined();

    handler!(new Error('Network error'));

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'error',
      error: 'Network error',
    });
  });

  it('handles download failure for signed releases', async () => {
    updater.initUpdater({ signed: true });

    mockAutoUpdater.downloadUpdate.mockRejectedValue(new Error('Download failed'));

    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    await vi.waitFor(() => {
      expect(updater.getUpdaterState()).toMatchObject({
        status: 'error',
        error: expect.stringContaining('Download failed'),
      });
    });
  });
});

// ===========================================================================
// Manual check for updates
// ===========================================================================

describe('checkForUpdates', () => {
  it('skips update check in development mode', async () => {
    mockApp.isPackaged = false;

    updater.initUpdater();

    await updater.checkForUpdates();

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.getUpdaterState()).toMatchObject({
      status: 'not-available',
      error: 'Updates not available in development mode',
    });
  });

  it('calls autoUpdater.checkForUpdates in packaged mode', async () => {
    mockApp.isPackaged = true;
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    updater.initUpdater();

    await updater.checkForUpdates();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it('skips update checks when the packaged app has no update channel metadata', async () => {
    mockApp.isPackaged = true;
    mockUpdateConfigExists.mockReturnValue(false);

    updater.initUpdater();

    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;
    const downloadProgressHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'download-progress',
    )?.[1] as ((progress: unknown) => void) | undefined;

    updateAvailableHandler!({ version: '2.0.0', releaseNotes: 'New features' });
    downloadProgressHandler!({ percent: 50 });

    await updater.checkForUpdates();

    expect(mockUpdateConfigExists).toHaveBeenCalledWith(
      path.join('/test/orchid/resources', 'app-update.yml'),
    );
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.getUpdaterState()).toEqual({
      status: 'not-available',
      version: null,
      releaseNotes: null,
      progress: null,
      error: null,
    });
  });

  it('handles checkForUpdates failure', async () => {
    mockApp.isPackaged = true;
    mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('Check failed'));

    updater.initUpdater();

    await updater.checkForUpdates();

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Check failed'),
    });
  });
});

// ===========================================================================
// Manual download (for unsigned builds)
// ===========================================================================

describe('downloadUpdate', () => {
  it('calls autoUpdater.downloadUpdate', async () => {
    mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

    updater.initUpdater();

    await updater.downloadUpdate();

    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it('handles download failure', async () => {
    mockAutoUpdater.downloadUpdate.mockRejectedValue(new Error('Download failed'));

    updater.initUpdater();

    await updater.downloadUpdate();

    expect(updater.getUpdaterState()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Download failed'),
    });
  });
});

// ===========================================================================
// getUpdaterState
// ===========================================================================

describe('getUpdaterState', () => {
  it('returns initial idle state', () => {
    const state = updater.getUpdaterState();

    expect(state).toEqual({
      status: 'idle',
      version: null,
      releaseNotes: null,
      progress: null,
      error: null,
    });
  });

  it('returns current state after update available', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    handler!({
      version: '2.0.0',
      releaseNotes: 'New features',
    });

    const state = updater.getUpdaterState();
    expect(state.status).toBe('available');
    expect(state.version).toBe('2.0.0');
    expect(state.releaseNotes).toBe('New features');
  });
});

// ===========================================================================
// destroyUpdater
// ===========================================================================

describe('destroyUpdater', () => {
  it('removes all listeners from autoUpdater', () => {
    updater.initUpdater();

    updater.destroyUpdater();

    expect(mockAutoUpdater.removeAllListeners).toHaveBeenCalled();
  });

  it('resets state to idle', () => {
    updater.initUpdater();

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    handler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    updater.destroyUpdater();

    const state = updater.getUpdaterState();
    expect(state.status).toBe('idle');
    expect(state.version).toBeNull();
  });
});
