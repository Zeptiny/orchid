/**
 * `orchid-agent` — plain-Node CLI entry for the headless Orchid agent host.
 *
 * No Electron import anywhere in this graph: the daemon owns its own
 * `~/.orchid` (sessions, indexes, trust, provider config) and serves the host
 * protocol over stdio or a 0600 UNIX socket. Turns keep running when no
 * client is connected (issue #112, plan 2026-08-23-001).
 *
 * Usage:
 *   orchid-agent --version
 *   orchid-agent serve --stdio
 *   orchid-agent serve --socket <path>
 *   orchid-agent bridge <socketPath>
 */
import * as path from 'node:path';
import { initFileLogging, closeFileLogging } from './logging';
import {
  ensureHomeConfig,
  ConfigManager,
  HOME_AGENTS_DIR,
  HOME_CONFIG_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_PROMPTS_DIR,
  HOME_SKILLS_DIR,
  getConfig,
} from './config/loader';
import { loadAgents, seedAgentsDir } from './agents/registry';
import { loadSkills, seedSkillsDir } from './skills/registry';
import { loadPersonalities, seedPersonalitiesDir } from './personality/registry';
import { seedSharedPromptsDir } from './prompts/registry';
import { registerBuiltinTools } from './tools';
import { wireSubagentRuntime, flushSubagentPersistence, disposeSubagentPersistence } from './agents/wire-subagents';
import { initToolWorkerPool, disposeToolWorkerPool } from './llm/tool-pool';
import { ProviderCatalogStore } from './providers/catalog/store';
import type { CatalogKeyring } from './providers/catalog/trust';
import { CredentialVault } from './providers/credentials/vault';
import { nodeSecureStorageAdapter } from './providers/credentials/node-storage-adapter';
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
import {
  initializeToolAttemptStore,
  resetToolAttemptStore,
} from './providers/accounting/tool-attempt-store';
import {
  initializeContextSnapshotStore,
  resetContextSnapshotStore,
} from './providers/accounting/context-snapshot-store';
import {
  initializeProviderAttemptCaptureStore,
  resetProviderAttemptCaptureStore,
} from './providers/accounting/capture-store';
import {
  initializeSubagentAttributionStore,
  resetSubagentAttributionStore,
} from './providers/accounting/subagent-attribution-store';
import { closeSessionDb } from './session/storage';
import { shutdownProjectMCPManagers } from './mcp/project-registry';
import { getBackgroundStore } from './tools/process/background-store';
import { disposeAllWorkspaceWatchers } from './indexing/watcher';
import { disposeIndexRefreshCoordinatorAsync } from './indexing/refresh-coordinator';
import { createHostServer, type HostServer } from './host/server';
import {
  DEFAULT_DAEMON_SOCKET_PATH,
  bridgeStdioToSocket,
  serveSocket,
  serveSocketDetached,
  serveStdio,
} from './host/daemon';

/** Replaced at bundle time from package.json (scripts/build-agent.js). */
declare const __AGENT_VERSION__: string;

/** Hard ceiling for graceful shutdown before forcing process exit. */
const SHUTDOWN_DEADLINE_MS = 10_000;

const USAGE = `orchid-agent — headless Orchid agent host

Usage:
  orchid-agent --version              Print the agent version
  orchid-agent serve --stdio          Serve the host protocol over stdin/stdout
  orchid-agent serve --socket <path>  Serve over a 0600 UNIX socket
  orchid-agent serve --socket <path> --detached
                                      Daemonize: start serving in a detached
                                      child and exit immediately
  orchid-agent bridge [socketPath]    Pipe stdio to a running socket daemon
                                       (default ~/.orchid/daemon.sock)
`;

/**
 * Release engineering replaces this empty development keyring with public
 * Ed25519 verification keys (same policy as the Electron shell).
 */
const RELEASE_CATALOG_KEYRING: CatalogKeyring = Object.freeze({});

function resolveBundledCatalogPath(): string {
  // The bundle lives at dist/agent (or dist/main under tsc) — both two levels
  // below the package root, where assets/ sits.
  return path.join(__dirname, '..', '..', 'assets', 'providers', 'catalog.json');
}

let providerStatusScheduler: ProviderStatusScheduler | null = null;
let bgIdleOwnershipTimer: ReturnType<typeof setInterval> | null = null;
let hostServer: HostServer | null = null;
let shuttingDown = false;

/** Periodic reclaim of USER-owned bg command stdin after idle timeout. */
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

/**
 * Startup composition mirroring the Electron lifecycle (startup-lifecycle.ts
 * order: settings/providers → agents/tools → workers → interface) minus every
 * window/Electron concern.
 */
async function initializeDaemonRuntime(): Promise<HostServer> {
  initFileLogging();
  ensureHomeConfig();

  // settings_providers stage
  const catalog = new ProviderCatalogStore({
    bundledCatalogPath: resolveBundledCatalogPath(),
    appVersion: __AGENT_VERSION__,
    keyring: RELEASE_CATALOG_KEYRING,
  });
  catalog.load();
  setProviderCatalogStore(catalog);

  // Plain-Node vault: stored API keys are unavailable (clean typed error);
  // environment credential references keep resolving (they bypass the vault).
  const vault = new CredentialVault({ safeStorage: nodeSecureStorageAdapter });
  setProviderCredentialVault(vault);

  const status = new ProviderStatusService();
  const scheduler = new ProviderStatusScheduler(status);
  scheduler.start([createLilacStatusSource()]);
  setProviderStatusService(status);
  providerStatusScheduler = scheduler;

  const connections = new ConnectionStore();
  setProviderConnectionStore(connections);
  initializeProviderRuntime({ catalog, vault, connections, status });

  initializeProviderAccountingStore();
  initializeToolAttemptStore();
  initializeContextSnapshotStore();
  initializeSubagentAttributionStore();
  initializeProviderAttemptCaptureStore();

  // agents_tools stage
  seedAgentsDir(HOME_AGENTS_DIR);
  seedSkillsDir(HOME_SKILLS_DIR);
  seedPersonalitiesDir(HOME_PERSONALITIES_DIR);
  seedSharedPromptsDir(HOME_PROMPTS_DIR);
  loadPersonalities();
  ConfigManager.reset();
  ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
  const agents = loadAgents();
  const skills = loadSkills();
  registerBuiltinTools({ agents, skills, mcpManager: null });
  wireSubagentRuntime();

  // preparing_interface stage: install the daemon sink + delivery hooks and
  // begin serving. Tool workers are best-effort (inline fallback otherwise).
  try {
    await initToolWorkerPool(getConfig());
  } catch (error) {
    console.warn('[orchid-agent] tool worker pool unavailable; tools run inline:', error);
  }
  hostServer = createHostServer({ serverVersion: __AGENT_VERSION__ });
  startBackgroundOwnershipReclaim();
  return hostServer;
}

/**
 * Foreground serve on one socket: initialize the runtime and serve. When
 * another daemon already owns the socket, `serveSocket` resolves WITHOUT
 * listening (it logs why) — this process has nothing to do and exits cleanly.
 */
async function serveForeground(socketPath: string): Promise<void> {
  const server = await initializeDaemonRuntime();
  const netServer = await serveSocket(socketPath, { server });
  if (!netServer.listening) {
    await shutdown();
    return;
  }
  process.stderr.write(`orchid-agent listening on ${socketPath}\n`);
}

/** Graceful shutdown mirroring the Electron before-quit sequence. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown deadline exceeded; forcing exit');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  forceExitTimer.unref?.();

  try {
    if (bgIdleOwnershipTimer) {
      clearInterval(bgIdleOwnershipTimer);
      bgIdleOwnershipTimer = null;
    }

    const bgStore = getBackgroundStore();
    bgStore.terminateAll();
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2100);
      t.unref?.();
    });
    bgStore.clear();

    flushSubagentPersistence();
    disposeAllWorkspaceWatchers();
    await disposeIndexRefreshCoordinatorAsync();

    hostServer?.dispose();
    hostServer = null;

    await shutdownProjectMCPManagers();
    await disposeToolWorkerPool();

    await closeFileLogging();
    ConfigManager.reset();
    providerStatusScheduler?.stop();
    providerStatusScheduler = null;
    resetProviderRuntimeContext();
    resetProviderRuntime();
    resetProviderAccountingStore();
    resetToolAttemptStore();
    resetContextSnapshotStore();
    resetSubagentAttributionStore();
    resetProviderAttemptCaptureStore();

    flushSubagentPersistence();
    disposeSubagentPersistence();
    closeSessionDb();
  } catch (error) {
    console.error('Error during shutdown:', error);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${__AGENT_VERSION__}\n`);
    return;
  }
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    process.stdout.write(USAGE);
    return;
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  if (args[0] === 'serve') {
    if (args[1] === '--stdio') {
      const server = await initializeDaemonRuntime();
      await serveStdio({ server });
      await shutdown();
      return;
    }
    if (args[1] === '--socket') {
      const socketPath = args[2];
      if (!socketPath) {
        process.stderr.write('serve --socket requires a socket path\n');
        process.exitCode = 1;
        return;
      }
      if (args.includes('--detached')) {
        // Parent: spawn the detached child and exit without initializing the
        // runtime, so a one-shot `ssh … serve --socket … --detached` returns
        // immediately (U10 daemon ensure). The child re-enters with the env
        // marker and takes the foreground branch below.
        await serveSocketDetached(socketPath, {
          entryPath: __filename,
          serve: async (detachedSocketPath) => {
            await serveForeground(detachedSocketPath);
          },
        });
        return;
      }
      await serveForeground(socketPath);
      return;
    }
    process.stderr.write("serve requires a transport: '--stdio' or '--socket <path>'\n");
    process.exitCode = 1;
    return;
  }

  if (args[0] === 'bridge') {
    let socketPath = args[1];
    if (!socketPath) {
      // Defense in depth: the app always passes the socket path explicitly,
      // but defaulting keeps a hand-run `orchid-agent bridge` working.
      socketPath = DEFAULT_DAEMON_SOCKET_PATH;
      process.stderr.write(`bridge: no socket path given; defaulting to ${DEFAULT_DAEMON_SOCKET_PATH}\n`);
    }
    await bridgeStdioToSocket(socketPath);
    return;
  }

  process.stderr.write(`Unknown command '${args[0]}'\n`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('[orchid-agent] fatal:', error);
  process.exit(1);
});
