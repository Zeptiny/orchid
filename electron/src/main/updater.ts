/**
 * Auto-updater — electron-updater integration, gated to signed releases.
 *
 * Headless main-process lifecycle only. No renderer IPC until a consumer UI
 * exists (`getUpdaterState()` is the in-process status surface).
 *
 * Responsibilities:
 * - Check for updates via GitHub releases (electron-builder publish config)
 * - Track in-process updater state (available, progress, downloaded, error)
 * - Gate auto-update to signed releases (macOS Gatekeeper blocks unsigned)
 * - For unsigned beta builds: disable auto-download, allow manual check only
 */
import { autoUpdater, UpdateInfo } from 'electron-updater';
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UpdaterState } from '../shared/types/ipc-boundary';
import { getBackgroundStore } from './tools/process/background-store';

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

let flushBeforeInstall: (() => void) | null = null;

function hasPackagedUpdateConfiguration(): boolean {
  return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
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
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    state.status = 'available';
    state.version = info.version;
    state.releaseNotes = (typeof info.releaseNotes === 'string' ? info.releaseNotes : null) ?? null;
    state.error = null;

    // Auto-download only for signed releases
    if (isSigned) {
      autoUpdater.downloadUpdate().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        state.status = 'error';
        state.error = `Download failed: ${message}`;
      });
    }
  });

  autoUpdater.on('update-not-available', (_info: UpdateInfo) => {
    state.status = 'not-available';
    state.version = null;
    state.releaseNotes = null;
    state.progress = null;
    state.error = null;
  });

  autoUpdater.on(
    'download-progress',
    (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
      state.status = 'downloading';
      state.progress = Math.round(progress.percent);
    },
  );

  autoUpdater.on('update-downloaded', (_info: UpdateInfo) => {
    state.status = 'downloaded';
    state.progress = 100;
    state.error = null;
  });

  autoUpdater.on('error', (error: Error) => {
    state.status = 'error';
    state.error = error.message || 'Unknown update error';
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the auto-updater.
 * Call once during app startup after the app is ready.
 *
 * @param options.signed — Whether the build is code-signed.
 * @param options.flushBeforeInstall — Optional flush before quit-and-install.
 */
export function initUpdater(options: {
  signed?: boolean;
  flushBeforeInstall?: () => void;
} = {}): void {
  isSigned = options.signed ?? false;
  flushBeforeInstall = options.flushBeforeInstall ?? null;

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
    return;
  }

  if (!hasPackagedUpdateConfiguration()) {
    state.status = 'not-available';
    state.error = null;
    return;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = 'error';
    state.error = `Check failed: ${message}`;
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
  }
}

/**
 * Quit the app and install the downloaded update.
 * This will restart the app with the new version.
 */
export function quitAndInstall(): void {
  // Persist live subagent tails while the normal before-quit guard still
  // exists; the updater removes that guard immediately afterward.
  try {
    flushBeforeInstall?.();
  } catch (err) {
    console.warn('Failed to flush subagents before update install:', err);
  }
  // before-quit is stripped below — kill bg process groups so they are not orphaned
  try {
    getBackgroundStore().terminateAll();
  } catch (err) {
    console.warn('Failed to terminate background processes before update install:', err);
  }
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
  flushBeforeInstall = null;
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
  flushBeforeInstall = null;
}
