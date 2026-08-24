/**
 * Embedded local host — the machine the Electron app runs on, served in-process
 * through the same host protocol a remote `orchid-agent` daemon speaks
 * (plan 2026-08-23-001, U5 / R8).
 *
 * Startup composition mirrors `main/agent-entry.ts` (settings/providers →
 * agents/tools → interface) but *reuses* whatever the Electron shell already
 * initialized: in the app the local host starts after the settings/providers
 * and agents/tools stages, so only the HostServer itself is created here. When
 * called before startup (unit tests), the missing pieces are initialized
 * lazily — the minimal set the protocol surface needs, never the scheduler or
 * the tool/definition seeding a test provides for itself.
 *
 * This module is Electron-free on purpose (see scripts/check-host-boundary.mjs):
 * the renderer window fan-out lives client-side in `ipc/host-broadcast.ts` and
 * is attached through {@link setLocalClientListener}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CatalogKeyring } from '../providers/catalog/trust';
import { createHostServer, type HostServer } from './server';
import { createHostClient, type HostClient } from './client';
import { createInProcessTransport } from './transport-inprocess';

/** Embedded host version reported in the `host.hello` handshake. */
const EMBEDDED_HOST_VERSION = '0.0.0-embedded';

/**
 * Same policy as the daemon/agent entry: release engineering replaces this
 * empty keyring with public verification keys. Code-owned, never renderer data.
 */
const RELEASE_CATALOG_KEYRING: CatalogKeyring = Object.freeze({});

/**
 * Called once per window/client (and by tests) so a newly created local client
 * can be wired for delivery — the Electron shell installs the window broadcast.
 */
export type LocalClientListener = (client: HostClient, clientId: string) => void;

/**
 * Sweep hook the Electron shell installs so every live renderer window has a
 * connection (and therefore an event stream) before a request is served.
 */
export type LocalClientSweep = () => void;

let server: HostServer | null = null;
let localClientListener: LocalClientListener | null = null;
let localClientSweep: LocalClientSweep | null = null;
let sweeping = false;
const clientsByWindowId = new Map<string, HostClient>();

function resolveBundledCatalogPath(): string | null {
  // Matches agent-entry.ts (dist/agent, dist/main → package root/assets) and
  // adds the src/ layout used by the test runner.
  const candidates = [
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', '..', '..', 'assets'),
  ];
  for (const root of candidates) {
    const catalogPath = path.join(root, 'providers', 'catalog.json');
    try {
      if (fs.existsSync(catalogPath)) return catalogPath;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

/**
 * Best-effort lazy composition of the provider runtime, used only when the
 * shell has not already initialized it (unit tests, degraded startup).
 *
 * Every provider module is loaded dynamically: a caller that replaces the
 * config/provider layers with partial mocks must still get a working host, so
 * a module-level import that dereferences those mocks would be fatal here.
 */
let providerRuntimeEnsure: Promise<void> | null = null;

function ensureProviderRuntime(): Promise<void> {
  providerRuntimeEnsure ??= (async () => {
    const [
      { ensureHomeConfig },
      { ProviderCatalogStore },
      { CredentialVault },
      { ConnectionStore },
      { ProviderStatusService },
      { initializeProviderRuntime },
      { isProviderRuntimeContextInitialized, ...runtimeContext },
    ] = await Promise.all([
      import('../config/loader'),
      import('../providers/catalog/store'),
      import('../providers/credentials/vault'),
      import('../providers/connection-store'),
      import('../providers/status/service'),
      import('../providers'),
      import('../providers/runtime-context'),
    ]);
    try {
      ensureHomeConfig();
    } catch (error) {
      console.warn('[local-host] home config unavailable (non-fatal):', error);
    }
    if (isProviderRuntimeContextInitialized()) return;
    const catalogPath = resolveBundledCatalogPath();
    if (catalogPath == null) {
      console.warn('[local-host] bundled provider catalog not found; provider methods are unavailable');
      return;
    }
    const catalog = new ProviderCatalogStore({
      bundledCatalogPath: catalogPath,
      appVersion: EMBEDDED_HOST_VERSION,
      keyring: RELEASE_CATALOG_KEYRING,
    });
    catalog.load();
    runtimeContext.setProviderCatalogStore(catalog);
    // Electron vault adapter (safeStorage); the headless daemon swaps in the
    // plain-Node adapter instead.
    const vault = new CredentialVault();
    runtimeContext.setProviderCredentialVault(vault);
    const status = new ProviderStatusService();
    runtimeContext.setProviderStatusService(status);
    const connections = new ConnectionStore();
    runtimeContext.setProviderConnectionStore(connections);
    initializeProviderRuntime({ catalog, vault, connections, status });
  })().catch((error: unknown) => {
    // A catalog/trust failure must not take the embedded host down with it:
    // the shell (or the daemon entry) is the authoritative initializer; this
    // lazy path only exists for callers that never ran startup.
    console.warn('[local-host] provider runtime unavailable (non-fatal):', error);
  });
  return providerRuntimeEnsure;
}

/**
 * Idempotently start the embedded local host: one HostServer owning the daemon
 * event sink and the injected-delivery seams (todos, subagent deltas, working
 * set, activity, approvals, questions, index auto-refresh).
 *
 * The provider runtime is only composed lazily (see ensureProviderRuntime) and
 * the accounting/telemetry stores are never initialized here: both belong to
 * the shell (main/index) and daemon (agent-entry) startup.
 */
export function startEmbeddedLocalHost(): HostServer {
  if (server) return server;
  void ensureProviderRuntime();
  server = createHostServer({ serverVersion: EMBEDDED_HOST_VERSION });
  return server;
}

/** Whether the embedded host (and therefore the unified local path) is live. */
export function isEmbeddedLocalHostRunning(): boolean {
  return server != null;
}

/**
 * Install the Electron-side client decorator (window broadcast). Must be
 * registered before any client is created; passing null detaches it.
 */
export function setLocalClientListener(listener: LocalClientListener | null): void {
  localClientListener = listener;
}

/** Install (or clear) the "connect every window" sweep. */
export function setLocalClientSweep(sweep: LocalClientSweep | null): void {
  localClientSweep = sweep;
}

/**
 * The in-process client for one window. Locally the protocol clientId *is* the
 * renderer window id, so every server binding resolves the active session,
 * working set, and approval ownership exactly as the IPC handler it replaced.
 */
export function getLocalHostClient(windowId: string): HostClient {
  // A window that never sent a request still owns an event stream: sweep the
 // shell's window list so its connection exists before this request is served.
  if (!sweeping) {
    sweeping = true;
    try {
      localClientSweep?.();
    } catch (error) {
      console.warn('[local-host] client sweep failed (non-fatal):', error);
    } finally {
      sweeping = false;
    }
  }
  const existing = clientsByWindowId.get(windowId);
  if (existing) return existing;
  const host = startEmbeddedLocalHost();
  const transport = createInProcessTransport({ server: host, clientId: windowId });
  const client = createHostClient(transport, { clientId: windowId, label: `local:${windowId}` });
  clientsByWindowId.set(windowId, client);
  try {
    localClientListener?.(client, windowId);
  } catch (error) {
    console.warn(`[local-host] client listener failed for '${windowId}' (non-fatal):`, error);
  }
  return client;
}

/**
 * Drop one window's client connection (window closed / renderer destroyed).
 *
 * Closing the transport removes the server connection, which is what turns
 * that window from "connected client" into "disconnected owner": its pending
 * approvals/questions stay pending and settle fail-closed at their timeouts,
 * and its in-flight turns keep running on the host (R5) — a same-window-id
 * reconnect (renderer reload) re-delivers the pending prompts.
 */
export function closeLocalHostClient(windowId: string): void {
  const client = clientsByWindowId.get(windowId);
  if (!client) return;
  clientsByWindowId.delete(windowId);
  try {
    client.close();
  } catch {
    // non-fatal
  }
}

/** Teardown for tests / shutdown: drop clients and dispose the server. */
export function disposeEmbeddedLocalHost(): void {
  for (const client of clientsByWindowId.values()) {
    try {
      client.close();
    } catch {
      // non-fatal
    }
  }
  clientsByWindowId.clear();
  server?.dispose();
  server = null;
}
