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
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { registerAllIPC, unregisterAllIPC, setMCPManagerRef } from './ipc';
import { loadConfig, ensureHomeConfig, ConfigManager } from './config/loader';
import { loadAgents, seedAgentsDir } from './agents/registry';
import { HOME_AGENTS_DIR } from './config/loader';
import { MCPManager } from './mcp';

// ── Global state ─────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let mcpManager: MCPManager | null = null;

// ── Window creation ──────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Orchid',
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
    // 1. Ensure home config structure exists
    ensureHomeConfig();

    // 2. Load config
    const config = ConfigManager.load();

    // 3. Seed and load agents
    seedAgentsDir(HOME_AGENTS_DIR);
    loadAgents();

    // 4. Register all IPC handlers (before creating window)
    registerAllIPC();

    // 5. Initialize MCP servers (async, non-blocking for window)
    mcpManager = new MCPManager();
    setMCPManagerRef(mcpManager);

    // Start MCP in background — don't block window creation
    mcpManager
      .startAll(config.mcp_servers as Record<string, import('./mcp/schema').MCPServerConfig>, {
        perServerTimeout: config.mcp_per_server_timeout * 1000,
        startupTimeout: config.mcp_startup_timeout * 1000,
      })
      .catch((err) => {
        console.warn('MCP initialization failed (non-fatal):', err);
      });

    // 6. Create the main window
    createWindow();
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
    // 1. Unregister IPC handlers
    unregisterAllIPC();

    // 2. Shut down MCP transports
    if (mcpManager) {
      await mcpManager.shutdown();
      mcpManager = null;
      setMCPManagerRef(null);
    }

    // 3. Reset config manager
    ConfigManager.reset();

    // 4. Now actually quit
    app.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    app.exit(1);
  }
});
