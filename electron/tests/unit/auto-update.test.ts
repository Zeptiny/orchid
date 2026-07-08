/**
 * Auto-update tests — U27.
 *
 * Covers:
 * - Mock server returns new version → notification
 * - Download → progress
 * - Restart → new version
 * - Unsigned → disabled → manual download
 * - Same version → no notification
 * - Error handling
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

const mockBrowserWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: {
    send: vi.fn(),
  },
};

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: vi.fn(() => mockBrowserWindow),
}));

// ---------------------------------------------------------------------------
// Import updater after mock setup
// ---------------------------------------------------------------------------

let updater: typeof import('../../src/main/updater');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  // Reset mock state
  mockAutoUpdater.autoDownload = true;
  mockAutoUpdater.autoInstallOnAppQuit = true;
  mockAutoUpdater.allowDowngrade = false;
  mockAutoUpdater.disableDifferentialDownload = false;
  mockApp.isPackaged = true;

  // Set up default mock behavior for downloadUpdate
  mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);
  mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

  // Re-setup mocks
  vi.doMock('electron-updater', () => ({
    autoUpdater: mockAutoUpdater,
  }));

  vi.doMock('electron', () => ({
    app: mockApp,
    BrowserWindow: vi.fn(() => mockBrowserWindow),
  }));

  updater = await import('../../src/main/updater');
});

afterEach(() => {
  updater.destroyUpdater();
  vi.restoreAllMocks();
});

// ===========================================================================
// Initialization
// ===========================================================================

describe('initUpdater', () => {
  it('configures autoDownload to false', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    expect(mockAutoUpdater.autoDownload).toBe(false);
  });

  it('configures autoInstallOnAppQuit to false', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('attaches event handlers', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Should register handlers for all lifecycle events
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
  it('emits status with version when update is available', async () => {
    updater.initUpdater({
      window: mockBrowserWindow as unknown as Electron.BrowserWindow,
      signed: true,
    });

    // Simulate update-available event
    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    expect(updateAvailableHandler).toBeDefined();

    // Trigger the handler
    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: 'New features',
    });

    // Should have sent status to renderer
    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'available',
        version: '2.0.0',
        releaseNotes: 'New features',
      }),
    );
  });

  it('auto-downloads for signed releases', async () => {
    updater.initUpdater({
      window: mockBrowserWindow as unknown as Electron.BrowserWindow,
      signed: true,
    });

    mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

    // Simulate update-available event
    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    // Should have called downloadUpdate for signed releases
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it('does not auto-download for unsigned releases', async () => {
    updater.initUpdater({
      window: mockBrowserWindow as unknown as Electron.BrowserWindow,
      signed: false,
    });

    // Simulate update-available event
    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    // Should NOT have called downloadUpdate for unsigned releases
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Update check — same version
// ===========================================================================

describe('checkForUpdates — same version', () => {
  it('emits not-available status when no update', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate update-not-available event
    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-not-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    expect(handler).toBeDefined();

    handler!({
      version: '1.0.0',
    });

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'not-available',
        version: null,
      }),
    );
  });
});

// ===========================================================================
// Download progress
// ===========================================================================

describe('download progress', () => {
  it('emits progress events during download', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate download-progress event
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

    // Should emit status update
    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'downloading',
        progress: 50,
      }),
    );

    // Should emit detailed progress
    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:progress',
      expect.objectContaining({
        percent: 50,
        bytesPerSecond: 1000000,
        transferred: 5000000,
        total: 10000000,
      }),
    );
  });

  it('rounds progress percentage', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'download-progress',
    )?.[1] as ((progress: unknown) => void) | undefined;

    handler!({
      percent: 33.333,
      bytesPerSecond: 1000000,
      transferred: 3333333,
      total: 10000000,
    });

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        progress: 33,
      }),
    );
  });
});

// ===========================================================================
// Update downloaded — restart prompt
// ===========================================================================

describe('update downloaded', () => {
  it('emits downloaded status when update is ready', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate update-downloaded event
    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-downloaded',
    )?.[1] as ((info: unknown) => void) | undefined;

    expect(handler).toBeDefined();

    handler!({
      version: '2.0.0',
    });

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'downloaded',
        progress: 100,
      }),
    );
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
});

// ===========================================================================
// Error handling
// ===========================================================================

describe('error handling', () => {
  it('emits error status when update check fails', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate error event
    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'error',
    )?.[1] as ((error: Error) => void) | undefined;

    expect(handler).toBeDefined();

    handler!(new Error('Network error'));

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'error',
        error: 'Network error',
      }),
    );

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:error',
      expect.objectContaining({
        error: 'Network error',
      }),
    );
  });

  it('handles download failure for signed releases', async () => {
    updater.initUpdater({
      window: mockBrowserWindow as unknown as Electron.BrowserWindow,
      signed: true,
    });

    mockAutoUpdater.downloadUpdate.mockRejectedValue(new Error('Download failed'));

    // Simulate update-available event
    const updateAvailableHandler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    updateAvailableHandler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    // Wait for the async download to fail
    await vi.waitFor(() => {
      expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
        'updater:status_update',
        expect.objectContaining({
          status: 'error',
          error: expect.stringContaining('Download failed'),
        }),
      );
    });
  });
});

// ===========================================================================
// Manual check for updates
// ===========================================================================

describe('checkForUpdates', () => {
  it('skips update check in development mode', async () => {
    mockApp.isPackaged = false;

    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    await updater.checkForUpdates();

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'not-available',
        error: 'Updates not available in development mode',
      }),
    );
  });

  it('calls autoUpdater.checkForUpdates in packaged mode', async () => {
    mockApp.isPackaged = true;
    mockAutoUpdater.checkForUpdates.mockResolvedValue(undefined);

    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    await updater.checkForUpdates();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it('handles checkForUpdates failure', async () => {
    mockApp.isPackaged = true;
    mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('Check failed'));

    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    await updater.checkForUpdates();

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('Check failed'),
      }),
    );
  });
});

// ===========================================================================
// Manual download (for unsigned builds)
// ===========================================================================

describe('downloadUpdate', () => {
  it('calls autoUpdater.downloadUpdate', async () => {
    mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);

    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    await updater.downloadUpdate();

    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it('handles download failure', async () => {
    mockAutoUpdater.downloadUpdate.mockRejectedValue(new Error('Download failed'));

    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    await updater.downloadUpdate();

    expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
      'updater:status_update',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('Download failed'),
      }),
    );
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
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate update-available event
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
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    updater.destroyUpdater();

    expect(mockAutoUpdater.removeAllListeners).toHaveBeenCalled();
  });

  it('resets state to idle', () => {
    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate update-available event to change state
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

// ===========================================================================
// Renderer window destroyed
// ===========================================================================

describe('renderer window destroyed', () => {
  it('does not send events to destroyed window', () => {
    mockBrowserWindow.isDestroyed.mockReturnValue(true);

    updater.initUpdater({ window: mockBrowserWindow as unknown as Electron.BrowserWindow });

    // Simulate update-available event
    const handler = mockAutoUpdater.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'update-available',
    )?.[1] as ((info: unknown) => void) | undefined;

    handler!({
      version: '2.0.0',
      releaseNotes: null,
    });

    // Should not have tried to send to destroyed window
    expect(mockBrowserWindow.webContents.send).not.toHaveBeenCalled();
  });
});
