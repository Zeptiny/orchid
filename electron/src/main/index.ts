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
import * as path from 'path';
import { registerAllIPC, unregisterAllIPC } from './ipc';
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
import { wireSubagentRuntime } from './agents/wire-subagents';
import { getConfig } from './config/loader';
import { ProviderCatalogStore } from './providers/catalog/store';
import { ProviderCatalogUpdater, createHttpCatalogTransport } from './providers/catalog/updater';
import type { CatalogKeyring } from './providers/catalog/trust';
import { CredentialVault } from './providers/credentials/vault';
import { ConnectionStore } from './providers/connection-store';
import { initializeProviderRuntime, resetProviderRuntime } from './providers';
import { ProviderStatusScheduler, ProviderStatusService } from './providers/status/service';
import { createLilacStatusSource } from './providers/drivers/lilac';
import {
  initializeProviderAccountingStore,
  resetProviderAccountingStore,
} from './providers/accounting/store';

// ── Global state ─────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
/** Periodic reclaim of USER-owned bg command stdin after idle timeout. */
let bgIdleOwnershipTimer: ReturnType<typeof setInterval> | null = null;
let providerCatalogStore: ProviderCatalogStore | null = null;
let providerCredentialVault: CredentialVault | null = null;
let providerConnectionStore: ConnectionStore | null = null;
let providerStatusService: ProviderStatusService | null = null;
let providerStatusScheduler: ProviderStatusScheduler | null = null;

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
  providerCatalogStore = store;

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

/** Main-process access for future provider IPC and driver registry work. */
export function getProviderCatalogStore(): ProviderCatalogStore {
  if (!providerCatalogStore) {
    throw new Error('Provider catalog has not been initialized');
  }
  return providerCatalogStore;
}

function initializeProviderCredentialVault(): CredentialVault {
  const vault = new CredentialVault();
  providerCredentialVault = vault;
  return vault;
}

function initializeProviderRuntimeServices(
  catalog: ProviderCatalogStore,
  vault: CredentialVault,
  status?: ProviderStatusService,
): void {
  const connections = new ConnectionStore();
  providerConnectionStore = connections;
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
  providerStatusService = service;
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

/** Main-process credential access for trusted drivers only. */
export function getProviderCredentialVault(): CredentialVault {
  if (!providerCredentialVault) {
    throw new Error('Provider credential vault has not been initialized');
  }
  return providerCredentialVault;
}

/** Main-process connection metadata storage. Credentials remain in the vault. */
export function getProviderConnectionStore(): ConnectionStore {
  if (!providerConnectionStore) {
    throw new Error('Provider connections have not been initialized');
  }
  return providerConnectionStore;
}

/** Main-process access to informational, redacted provider status only. */
export function getProviderStatusService(): ProviderStatusService {
  if (!providerStatusService) {
    throw new Error('Provider status service has not been initialized');
  }
  return providerStatusService;
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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Orchid',
    icon: resolveAppIcon(),
    backgroundColor: '#1a1a2e', // Match default dark theme
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (!app.isPackaged) {
    // Dev mode: load from Vite dev server
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Production: load built renderer
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    // 0. Initialize persistent file logging (before anything else logs)
    initFileLogging();

    // 1. Ensure home config structure exists
    ensureHomeConfig();

    // 1b. Load the bundled provider catalog before any provider-dependent IPC.
    const catalog = initializeProviderCatalog();
    // Credential persistence remains unavailable until used when the OS secure
    // backend is unavailable; it must never abort local-only Orchid startup.
    const vault = initializeProviderCredentialVault();
    const status = initializeProviderStatusServices();
    initializeProviderRuntimeServices(catalog, vault, status);
    initializeProviderAccounting();

    // 2. Seed defaults into home dirs (before any load)
    seedAgentsDir(HOME_AGENTS_DIR);
    seedSkillsDir(HOME_SKILLS_DIR);
    seedPersonalitiesDir(HOME_PERSONALITIES_DIR);
    loadPersonalities();

    // 3. Initialize legacy global state from home only. A project runtime is
    // captured at turn start, so startup must not choose one project's layers
    // as the process-wide default for every concurrent session.
    ConfigManager.reset();
    ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
    const agents = loadAgents();
    const skills = loadSkills();

    // 4. Register the legacy tool surface. Each turn creates its own project
    // MCP manager from its frozen ProjectRuntime, rather than sharing this
    // startup workspace's connections with every other project.
    registerBuiltinTools({ agents, skills, mcpManager: null });
    // Start subagent stream runner + session persistence for token usage
    wireSubagentRuntime();

    // 5. Register all IPC handlers (before creating window)
    registerAllIPC();

    // 5b. Reclaim USER-owned background command stdin after idle timeout
    // (Python app main loop calls check_idle_ownership periodically).
    if (bgIdleOwnershipTimer) {
      clearInterval(bgIdleOwnershipTimer);
    }
    bgIdleOwnershipTimer = setInterval(() => {
      try {
        const cfg = getConfig();
        getBackgroundStore().checkIdleOwnership(
          cfg.background_command_idle_timeout * 1000,
        );
      } catch {
        // Config / store may be unavailable during teardown
      }
    }, 10_000);

    // 6. Remove default File/Edit/View/Window menu bar (Linux/Windows)
    Menu.setApplicationMenu(null);

    // 7. Create the main window
    createWindow();

    // 8. Initialize auto-updater (after window is created)
    if (mainWindow) {
      // Auto-update is gated to signed releases
      // For unsigned beta builds, auto-download is disabled but manual check is allowed
      const isSigned = app.isPackaged && process.platform === 'darwin'
        ? !!(process.env['CODESIGN_CERT'] || process.env['CSC_NAME'])
        : app.isPackaged;

      initUpdater({
        window: mainWindow,
        signed: isSigned,
      });

      // Check for updates on startup (non-blocking)
      // Only in packaged mode — dev mode has no update server
      if (app.isPackaged) {
        checkForUpdates().catch((err) => {
          console.warn('Startup update check failed (non-fatal):', err);
        });
      }
    }
  } catch (err) {
    console.error('Failed to initialize app:', err);
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
  // Prevent immediate quit to allow cleanup
  event.preventDefault();

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

    // 2. Close file logging stream
    await closeFileLogging();

    // 3. Unregister IPC handlers
    unregisterAllIPC();

    // 4. Shut down MCP transports
    await shutdownProjectMCPManagers();

    // 5. Destroy auto-updater
    destroyUpdater();

    // 6. Reset config manager
    ConfigManager.reset();
    providerCatalogStore = null;
    providerCredentialVault = null;
    providerConnectionStore = null;
    providerStatusScheduler?.stop();
    providerStatusScheduler = null;
    providerStatusService = null;
    resetProviderRuntime();
    resetProviderAccountingStore();

    // 7. Now actually quit
    app.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    app.exit(1);
  }
});
