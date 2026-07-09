/**
 * Auto-updater — electron-updater integration, gated to signed releases.
 *
 * Responsibilities:
 * - Check for updates via GitHub releases (electron-builder publish config)
 * - Notify UI of update lifecycle events (available, progress, downloaded, error)
 * - Gate auto-update to signed releases (macOS Gatekeeper blocks unsigned)
 * - For unsigned beta builds: disable auto-download, allow manual check only
 *
 * Events emitted to renderer via IPC:
 * - updater:status — current update status object
 * - updater:progress — download progress percentage
 * - updater:error — error message
 */
import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/types/ipc';
import type { UpdaterState } from '../shared/types/ipc-boundary';

export type { UpdaterState, UpdateStatus } from '../shared/types/ipc-boundary';

// ── State ────────────────────────────────────────────────────────────────────

const state: UpdaterState = {
  status: 'idle',
  version: null,
  releaseNotes: null,
  progress: null,
  error: null,
};

/** Whether the current build is signed (determines auto-update behavior). */
let isSigned = false;

/** Cached reference to the main window for sending IPC events. */
let mainWindowRef: BrowserWindow | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

function emitStatus(): void {
  sendToRenderer(IPC_CHANNELS.UPDATER_STATUS_UPDATE, { ...state });
}

function isAppSigned(): boolean {
  // macOS Gatekeeper validates code signature. Unsigned builds will fail
  // Gatekeeper assessment. We detect this via the app's build metadata.
  // electron-builder sets app.isPackaged = true for packaged builds.
  // For signed builds, we rely on the explicit flag set during initialization.
  return isSigned;
}

// ── Updater configuration ────────────────────────────────────────────────────

function configureUpdater(): void {
  // Never auto-download — user must confirm
  autoUpdater.autoDownload = false;

  // Don't auto-install on quit
  autoUpdater.autoInstallOnAppQuit = false;

  // Allow downgrading (useful for beta channels)
  autoUpdater.allowDowngrade = false;

  // Disable delta updates for reliability
  autoUpdater.disableDifferentialDownload = false;

  // Suppress the default logger (we handle logging ourselves)
  autoUpdater.logger = {
    info: (message: string) => console.log('[updater]', message),
    warn: (message: string) => console.warn('[updater]', message),
    error: (message: string) => console.error('[updater]', message),
    debug: (message: string) => console.debug('[updater]', message),
  };
}

// ── Event handlers ───────────────────────────────────────────────────────────

function attachEventHandlers(): void {
  autoUpdater.on('checking-for-update', () => {
    state.status = 'checking';
    state.error = null;
    emitStatus();
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    state.status = 'available';
    state.version = info.version;
    state.releaseNotes = (typeof info.releaseNotes === 'string' ? info.releaseNotes : null) ?? null;
    state.error = null;
    emitStatus();

    // Auto-download only for signed releases
    if (isAppSigned()) {
      autoUpdater.downloadUpdate().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        state.status = 'error';
        state.error = `Download failed: ${message}`;
        emitStatus();
      });
    }
  });

  autoUpdater.on('update-not-available', (_info: UpdateInfo) => {
    state.status = 'not-available';
    state.version = null;
    state.releaseNotes = null;
    state.progress = null;
    state.error = null;
    emitStatus();
  });

  autoUpdater.on(
    'download-progress',
    (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
      state.status = 'downloading';
      state.progress = Math.round(progress.percent);
      emitStatus();
      // Also send detailed progress for UI progress bar
      sendToRenderer(IPC_CHANNELS.UPDATER_PROGRESS, {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    },
  );

  autoUpdater.on('update-downloaded', (_info: UpdateInfo) => {
    state.status = 'downloaded';
    state.progress = 100;
    state.error = null;
    emitStatus();
  });

  autoUpdater.on('error', (error: Error) => {
    state.status = 'error';
    state.error = error.message || 'Unknown update error';
    emitStatus();
    sendToRenderer(IPC_CHANNELS.UPDATER_ERROR, { error: state.error });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the auto-updater.
 * Call once during app startup, after BrowserWindow is created.
 *
 * @param options.window — The main BrowserWindow for sending IPC events.
 * @param options.signed — Whether the build is code-signed.
 */
export function initUpdater(options: { window: BrowserWindow; signed?: boolean }): void {
  mainWindowRef = options.window;
  isSigned = options.signed ?? false;

  configureUpdater();
  attachEventHandlers();
}

/**
 * Manually check for updates.
 * For unsigned builds, this still checks but does not auto-download.
 * User must explicitly call `downloadUpdate()` after seeing the available notification.
 */
export async function checkForUpdates(): Promise<void> {
  // Only check in packaged mode (dev mode has no update server)
  if (!app.isPackaged) {
    state.status = 'not-available';
    state.error = 'Updates not available in development mode';
    emitStatus();
    return;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = 'error';
    state.error = `Check failed: ${message}`;
    emitStatus();
  }
}

/**
 * Download the available update.
 * For unsigned builds, this is the manual trigger after user confirms.
 */
export async function downloadUpdate(): Promise<void> {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = 'error';
    state.error = `Download failed: ${message}`;
    emitStatus();
  }
}

/**
 * Quit the app and install the downloaded update.
 * This will restart the app with the new version.
 */
export function quitAndInstall(): void {
  // Allow the quit to proceed (remove before-quit prevention)
  app.removeAllListeners('before-quit');
  autoUpdater.quitAndInstall(false, true);
}

/**
 * Get the current updater state.
 */
export function getUpdaterState(): UpdaterState {
  return { ...state };
}

/**
 * Clean up the updater (remove listeners, clear references).
 * Call during graceful shutdown.
 */
export function destroyUpdater(): void {
  autoUpdater.removeAllListeners();
  mainWindowRef = null;
  state.status = 'idle';
  state.version = null;
  state.releaseNotes = null;
  state.progress = null;
  state.error = null;
}

/** Reset internal state (for testing). */
export function _resetState(): void {
  state.status = 'idle';
  state.version = null;
  state.releaseNotes = null;
  state.progress = null;
  state.error = null;
  isSigned = false;
  mainWindowRef = null;
}
