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
import { MCPManager } from './mcp';
import { initUpdater, destroyUpdater, checkForUpdates } from './updater';
import { initFileLogging, closeFileLogging } from './logging';
import { registerBuiltinTools } from './tools';
import { wireSubagentRuntime } from './agents/wire-subagents';
import { applyWorkspaceProjectLayers } from './project/layers';
import { canonicalizeProjectDirectory } from './project/path';

// ── Global state ─────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let mcpManager: MCPManager | null = null;

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

    // 2. Seed defaults into home dirs (before any load)
    seedAgentsDir(HOME_AGENTS_DIR);
    seedSkillsDir(HOME_SKILLS_DIR);
    seedPersonalitiesDir(HOME_PERSONALITIES_DIR);
    loadPersonalities();

    // 3. Load config + project layers.
    // Do NOT merge process.cwd() as a product project root (R2/R7).
    // When sticky default_project_dir is valid, apply project .orchid.json
    // and project agents/skills immediately (R5).
    ConfigManager.reset();
    // Home-only pass to discover sticky default (HOME_CONFIG_DIR has no .orchid.json).
    const homeConfig = ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
    const stickyCanonical =
      homeConfig.default_project_dir != null && homeConfig.default_project_dir !== ''
        ? canonicalizeProjectDirectory(homeConfig.default_project_dir)
        : null;

    let config = homeConfig;
    let agents;
    let skills;
    if (stickyCanonical != null) {
      const applied = applyWorkspaceProjectLayers(stickyCanonical);
      config = applied.config;
      // apply always reloads agents/skills when applied; fall back only if skipped.
      agents =
        applied.agents ??
        loadAgents({
          projectDir: path.join(stickyCanonical, '.orchid', 'agents'),
        });
      skills =
        applied.skills ??
        loadSkills({
          projectDir: path.join(stickyCanonical, '.orchid', 'skills'),
        });
    } else {
      // Unbound workspace: home agents/skills only (empty project overlay).
      // Avoid process.cwd() project dirs as product default (R2).
      const emptyProjectAgents = path.join(
        HOME_CONFIG_DIR,
        '.orchid-no-project',
        'agents',
      );
      const emptyProjectSkills = path.join(
        HOME_CONFIG_DIR,
        '.orchid-no-project',
        'skills',
      );
      agents = loadAgents({ projectDir: emptyProjectAgents });
      skills = loadSkills({ projectDir: emptyProjectSkills });
    }

    // 4. Initialize MCP servers (async, non-blocking for window)
    mcpManager = new MCPManager();
    setMCPManagerRef(mcpManager);
    registerBuiltinTools({ agents, skills, mcpManager });
    // Start subagent stream runner + session persistence for token usage
    wireSubagentRuntime();

    // 5. Register all IPC handlers (before creating window)
    registerAllIPC();

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

    // 7. Initialize auto-updater (after window is created)
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
    // 1. Close file logging stream
    await closeFileLogging();

    // 2. Unregister IPC handlers
    unregisterAllIPC();

    // 2. Shut down MCP transports
    if (mcpManager) {
      await mcpManager.shutdown();
      mcpManager = null;
      setMCPManagerRef(null);
    }

    // 3. Destroy auto-updater
    destroyUpdater();

    // 4. Reset config manager
    ConfigManager.reset();

    // 4. Now actually quit
    app.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    app.exit(1);
  }
});
