/**
 * Electron main process entry — full app shell.
 *
 * Responsibilities:
 * - Create BrowserWindow with security settings
 * - Register all IPC handlers before creating window
 * - Load config, agents, skills on startup
 * - Initialize MCP servers
 * - Graceful shutdown: close MCP, save sessions, cleanup
 */
import { app, BrowserWindow, Menu } from 'electron';
import { spawnSync } from 'node:child_process';
import * as path from 'path';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { registerAllIPC, unregisterAllIPC } from './ipc';
import { handlePermissionOwnerDestroyed } from './ipc/permission';
import { registerStartupIPC, unregisterStartupIPC } from './ipc/startup';
import {
  ensureHomeConfig,
  ConfigManager,
  HOME_CONFIG_DIR,
  HOME_AGENTS_DIR,
  HOME_SKILLS_DIR,
  HOME_PERSONALITIES_DIR,
} from './config/loader';
import { loadAgents, seedAgentsDir } from './agents/registry';
import { loadSkills, seedSkillsDir } from './skills/registry';
import { loadPersonalities, seedPersonalitiesDir } from './personality/registry';
import { shutdownProjectMCPManagers } from './mcp/project-registry';
import { initUpdater, destroyUpdater, checkForUpdates } from './updater';
import { initFileLogging, closeFileLogging } from './logging';
import { registerBuiltinTools } from './tools';
import { getBackgroundStore } from './tools/process/background-store';
import {
  wireSubagentRuntime,
  flushSubagentPersistence,
  disposeSubagentPersistence,
} from './agents/wire-subagents';
import { initToolWorkerPool, disposeToolWorkerPool } from './llm/tool-pool';
import { runStartupLifecycle, type StartupLifecycleResult } from './startup-lifecycle';
import { startupState } from './startup';
import { getConfig } from './config/loader';
import { ProviderCatalogStore } from './providers/catalog/store';
import { ProviderCatalogUpdater, createHttpCatalogTransport } from './providers/catalog/updater';
import type { CatalogKeyring } from './providers/catalog/trust';
import { CredentialVault } from './providers/credentials/vault';
import { ConnectionStore } from './providers/connection-store';
import { initializeProviderRuntime, resetProviderRuntime } from './providers';
import {
  resetProviderRuntimeContext,
  setProviderCatalogStore,
  setProviderConnectionStore,
  setProviderCredentialVault,
  setProviderStatusService,
} from './providers/runtime-context';
import { ProviderStatusScheduler, ProviderStatusService } from './providers/status/service';
import { createLilacStatusSource } from './providers/drivers/lilac';
import {
  initializeProviderAccountingStore,
  resetProviderAccountingStore,
} from './providers/accounting/store';
import { closeSessionDb } from './session/storage';

// ── Global state ─────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
/** True once before-quit has begun cleanup; blocks re-entrant preventDefault. */
let isQuitting = false;
/** Cancels startup before teardown can dispose resources it may still initialize. */
let startupAbortController: AbortController | null = null;
/** Joined by before-quit so startup cannot resume after resource disposal. */
let startupLifecycle: Promise<StartupLifecycleResult> | null = null;
/** Periodic reclaim of USER-owned bg command stdin after idle timeout. */
let bgIdleOwnershipTimer: ReturnType<typeof setInterval> | null = null;
let providerStatusScheduler: ProviderStatusScheduler | null = null;

/** Hard ceiling for graceful shutdown before forcing process exit. */
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Runtime macOS code-signing check (not build-time CSC_NAME / CODESIGN_CERT).
 * Ad-hoc signatures do not count as distribution-signed for auto-update gating.
 */
function isMacOSAppSigned(): boolean {
  try {
    const result = spawnSync('codesign', ['-dv', '--verbose=2', process.execPath], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.error || result.status !== 0) return false;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (/Signature=adhoc/i.test(output)) return false;
    return /Authority=/.test(output);
  } catch {
    return false;
  }
}

/** Whether this packaged build should treat auto-update as signed-release gated. */
function detectReleaseSigned(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin') return isMacOSAppSigned();
  return true;
}

/**
 * Release engineering replaces this empty development keyring with public
 * Ed25519 verification keys before enabling the Orchid-controlled catalog
 * origin. It is intentionally code-owned: renderer input and remote data may
 * never add a trusted signing key.
 */
const RELEASE_CATALOG_KEYRING: CatalogKeyring = Object.freeze({});

function resolveBundledCatalogPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'providers', 'catalog.json');
  }
  // At runtime __dirname is electron/dist/main, not electron/src/main.
  return path.join(__dirname, '../../assets/providers/catalog.json');
}

function initializeProviderCatalog(): ProviderCatalogStore {
  const store = new ProviderCatalogStore({
    bundledCatalogPath: resolveBundledCatalogPath(),
    appVersion: app.getVersion(),
    keyring: RELEASE_CATALOG_KEYRING,
  });
  const snapshot = store.load();
  setProviderCatalogStore(store);

  // Refresh is best-effort and entirely independent from provider execution.
  // Until a release embeds a public key, staying offline is the secure default.
  if (app.isPackaged && Object.keys(RELEASE_CATALOG_KEYRING).length > 0) {
    const updater = new ProviderCatalogUpdater(store, createHttpCatalogTransport());
    void updater.refresh().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Provider catalog refresh failed; using ${snapshot.source} catalog: ${message}`);
    });
  }
  return store;
}

function initializeProviderCredentialVault(): CredentialVault {
  const vault = new CredentialVault();
  setProviderCredentialVault(vault);
  return vault;
}

function initializeProviderRuntimeServices(
  catalog: ProviderCatalogStore,
  vault: CredentialVault,
  status?: ProviderStatusService,
): void {
  const connections = new ConnectionStore();
  setProviderConnectionStore(connections);
  initializeProviderRuntime({
    catalog,
    vault,
    connections,
    status,
  });
}

function initializeProviderStatusServices(): ProviderStatusService {
  const service = new ProviderStatusService();
  const scheduler = new ProviderStatusScheduler(service);
  scheduler.start([createLilacStatusSource()]);
  setProviderStatusService(service);
  providerStatusScheduler = scheduler;
  return service;
}

function initializeProviderAccounting(): void {
  try {
    initializeProviderAccountingStore();
  } catch (error) {
    // Ledger failure must disable provider attempts, not local-only Orchid.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Provider accounting is unavailable; provider requests are disabled: ${message}`);
  }
}

// ── Window creation ──────────────────────────────────────────────────────────

function resolveAppIcon(): string | undefined {
  // Packaged builds: electron-builder places icon under resources via extraResources.
  // Dev: use build/icon.png next to the electron package root.
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'icon.png');
    return packaged;
  }
  return path.join(__dirname, '../../build/icon.png');
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Orchid',
    icon: resolveAppIcon(),
    backgroundColor: '#09090b', // Match the dependency-free startup shell
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  const ownerWindowId = String(window.webContents.id);
  window.webContents.once('destroyed', () => {
    handlePermissionOwnerDestroyed(ownerWindowId);
  });

  if (!app.isPackaged) {
    // Dev mode: load from Vite dev server
    window.loadURL('http://localhost:5173');
    window.webContents.openDevTools();
  } else {
    // Production: load built renderer
    window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  window.on('closed', () => {
    handlePermissionOwnerDestroyed(ownerWindowId);
    if (mainWindow === window) mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

function yieldForStartupPresentation(): Promise<void> {
  return setImmediatePromise();
}

function startBackgroundOwnershipReclaim(): void {
  if (bgIdleOwnershipTimer) clearInterval(bgIdleOwnershipTimer);
  bgIdleOwnershipTimer = setInterval(() => {
    try {
      const cfg = getConfig();
      getBackgroundStore().checkIdleOwnership(cfg.background_command_idle_timeout * 1000);
    } catch {
      // Config / store may be unavailable during teardown.
    }
  }, 10_000);
}

app.whenReady().then(async () => {
  try {
    if (isQuitting) return;

    // Logging and the narrow startup IPC surface must exist before the window.
    initFileLogging();
    registerStartupIPC(startupState);

    startupAbortController = new AbortController();
    startupLifecycle = runStartupLifecycle({
      state: startupState,
      abortSignal: startupAbortController.signal,
      openWindow: createWindow,
      yieldForPresentation: yieldForStartupPresentation,
      loadSettingsAndProviders: () => {
        ensureHomeConfig();
        const catalog = initializeProviderCatalog();
        // Credential persistence must never prevent local-only startup.
        const vault = initializeProviderCredentialVault();
        const status = initializeProviderStatusServices();
        initializeProviderRuntimeServices(catalog, vault, status);
        initializeProviderAccounting();
      },
      loadAgentsAndTools: () => {
        seedAgentsDir(HOME_AGENTS_DIR);
        seedSkillsDir(HOME_SKILLS_DIR);
        seedPersonalitiesDir(HOME_PERSONALITIES_DIR);
        loadPersonalities();

        // Do not select a project layer as a process-wide default.
        ConfigManager.reset();
        ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
        const agents = loadAgents();
        const skills = loadSkills();
        registerBuiltinTools({ agents, skills, mcpManager: null });
        wireSubagentRuntime();
      },
      startToolWorkers: () => initToolWorkerPool(getConfig()),
      prepareInterface: () => {
        // Normal renderer consumers remain unavailable until this final stage.
        registerAllIPC();
        startBackgroundOwnershipReclaim();
        Menu.setApplicationMenu(null);
      },
      logFailure: (step, error) => {
        // Keep detailed diagnostics in local logs; StartupState exposes only fixed UI copy.
        console.error(`[startup] mandatory stage failed step=${step ?? 'unknown'}`, error);
      },
    });
    const result = await startupLifecycle;

    // A mandatory startup failure is visible in the existing window. Do not
    // quit and erase the restart guidance the renderer just received.
    if (result === 'failed' || result === 'aborted') return;

    try {
      // Auto-update is non-mandatory and starts only after the app interface is prepared.
      initUpdater({
        signed: detectReleaseSigned(),
        flushBeforeInstall: flushSubagentPersistence,
      });
      if (app.isPackaged) {
        checkForUpdates().catch((err) => {
          console.warn('Startup update check failed (non-fatal):', err);
        });
      }
    } catch (error) {
      console.warn('Startup update initialization failed (non-fatal):', error);
    }
  } catch (error) {
    // This only covers failures before the startup surface can be established.
    console.error('Failed to establish startup shell:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

app.on('before-quit', async (event) => {
  // Re-entrant quit: only the first entry may preventDefault / run cleanup.
  if (isQuitting) {
    return;
  }
  isQuitting = true;
  startupAbortController?.abort();
  event.preventDefault();

  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown deadline exceeded; forcing exit');
    app.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  if (typeof forceExitTimer === 'object' && forceExitTimer && 'unref' in forceExitTimer) {
    (forceExitTimer as NodeJS.Timeout).unref();
  }

  try {
    if (bgIdleOwnershipTimer) {
      clearInterval(bgIdleOwnershipTimer);
      bgIdleOwnershipTimer = null;
    }

    // 1. Kill background process groups before tearing down MCP/IPC
    const bgStore = getBackgroundStore();
    bgStore.terminateAll();
    // Drain for SIGTERM→SIGKILL escalation in BackgroundProcessStore (2s)
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2100);
      if (typeof t === 'object' && t && 'unref' in t) {
        (t as NodeJS.Timeout).unref();
      }
    });
    bgStore.clear();

    // 2. Close file logging stream (bounded; see FileLogger.close timeout)
    await closeFileLogging();

    // Flush live subagent checkpoints before IPC/runtime teardown.
    flushSubagentPersistence();

    // 3. Unregister IPC handlers
    unregisterAllIPC();
    unregisterStartupIPC();

    // 4. Shut down MCP transports
    await shutdownProjectMCPManagers();

    // Startup may be paused between stages. Let it observe the abort signal
    // before disposing the pool it could otherwise initialize afterwards.
    await startupLifecycle;
    await disposeToolWorkerPool();

    // 5. Destroy auto-updater
    destroyUpdater();

    // 6. Reset config manager
    ConfigManager.reset();
    providerStatusScheduler?.stop();
    providerStatusScheduler = null;
    resetProviderRuntimeContext();
    resetProviderRuntime();
    resetProviderAccountingStore();

    // 7. Now actually quit
    // Final safety flush after teardown, immediately before process exit.
    flushSubagentPersistence();
    disposeSubagentPersistence();
    closeSessionDb();
    clearTimeout(forceExitTimer);
    app.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    clearTimeout(forceExitTimer);
    app.exit(1);
  }
});
