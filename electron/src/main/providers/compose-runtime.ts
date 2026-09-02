/**
 * Shared provider-runtime composition (fix #15).
 *
 * The one implementation of the catalog + keyring + vault + status +
 * connection-store + ProviderRuntime assembly that three processes each used
 * to duplicate with their own RELEASE_CATALOG_KEYRING and a drifting bundled-
 * catalog candidate list:
 *
 * - the Electron shell (main/index.ts, startup's settings/providers stage);
 * - the embedded local host (host/local-host.ts, lazy best-effort ensure);
 * - the headless `orchid-agent` daemon (agent-entry.ts).
 *
 * Genuine per-process differences are parameterized, never unified away:
 * - `appVersion` — shell `app.getVersion()` / daemon bundle version / embedded;
 * - `vaultAdapter` — the daemon injects the plain-Node adapter; the shell and
 *   the embedded host use the Electron safeStorage default;
 * - `extraCatalogRoots` — tried before the built-in candidates (the packaged
 *   shell's resources dir);
 * - `statusSources` — start a ProviderStatusScheduler (shell + daemon); the
 *   embedded host's lazy path starts none.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProviderCatalogStore, type ProviderCatalogSnapshot } from './catalog/store';
import type { CatalogKeyring } from './catalog/trust';
import { CredentialVault, type SecureStorageAdapter } from './credentials/vault';
import { ConnectionStore } from './connection-store';
import { initializeProviderRuntime } from './index';
import {
  setProviderCatalogStore,
  setProviderConnectionStore,
  setProviderCredentialVault,
  setProviderStatusService,
} from './runtime-context';
import {
  ProviderStatusScheduler,
  ProviderStatusService,
  type ProviderStatusSource,
} from './status/service';

/**
 * Release engineering replaces this empty development keyring with public
 * Ed25519 verification keys before enabling the Orchid-controlled catalog
 * origin. It is intentionally code-owned: renderer input and remote data may
 * never add a trusted signing key (same policy in the shell, the embedded
 * host, and the daemon).
 */
export const RELEASE_CATALOG_KEYRING: CatalogKeyring = Object.freeze({});

/**
 * Resolve the assets root that bundles `providers/catalog.json`.
 *
 * `extraCatalogRoots` are tried first (the packaged shell's resources dir),
 * then the union of the layouts this code is deployed into — relative to THIS
 * module, which lives one level below main/:
 * - `dist/main/assets` (tsc output with copied assets),
 * - `dist/assets` / `<package>/assets` (tsc main, esbuild agent bundle, src tree).
 *
 * First existing candidate wins; null when nothing matches.
 */
export function resolveBundledCatalogRoot(
  extraCatalogRoots: readonly string[] = [],
): string | null {
  const candidates = [
    ...extraCatalogRoots,
    path.join(__dirname, '..', 'assets'),
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', '..', '..', 'assets'),
  ];
  for (const root of candidates) {
    try {
      if (fs.existsSync(path.join(root, 'providers', 'catalog.json'))) return root;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

export interface ComposeProviderRuntimeOptions {
  /** Version the catalog store validates compatibility against. */
  readonly appVersion: string;
  /**
   * Vault storage adapter; omitted ⇒ the Electron safeStorage default. The
   * daemon passes its plain-Node adapter so stored API keys degrade to a
   * clean typed error while environment references keep resolving.
   */
  readonly vaultAdapter?: SecureStorageAdapter;
  /** Catalog roots tried before the built-in candidates (packaged resources). */
  readonly extraCatalogRoots?: readonly string[];
  /**
   * When provided, a ProviderStatusScheduler is created and started with
   * these sources (the caller owns stopping it via the returned handle).
   */
  readonly statusSources?: readonly ProviderStatusSource[];
}

/** What composeProviderRuntime assembled and installed into the runtime context. */
export interface ComposedProviderRuntime {
  readonly catalog: ProviderCatalogStore;
  /** The catalog snapshot `load()` returned (index.ts branches on its source). */
  readonly snapshot: ProviderCatalogSnapshot;
  readonly vault: CredentialVault;
  readonly status: ProviderStatusService;
  readonly connections: ConnectionStore;
  /** Null unless statusSources were supplied. */
  readonly statusScheduler: ProviderStatusScheduler | null;
}

/**
 * Compose and install the provider runtime: catalog (loaded + published),
 * credential vault, status service (+ optional scheduler), connection store,
 * and the ProviderRuntime itself — in the same order every caller used.
 *
 * Throws when no bundled catalog can be resolved; callers that must tolerate
 * a missing catalog (the embedded host's lazy path) check
 * {@link resolveBundledCatalogRoot} first.
 */
export function composeProviderRuntime(
  options: ComposeProviderRuntimeOptions,
): ComposedProviderRuntime {
  const catalogRoot = resolveBundledCatalogRoot(options.extraCatalogRoots);
  if (catalogRoot == null) {
    throw new Error(
      'Bundled provider catalog not found under any known assets root; provider methods are unavailable',
    );
  }
  const catalog = new ProviderCatalogStore({
    bundledCatalogPath: path.join(catalogRoot, 'providers', 'catalog.json'),
    appVersion: options.appVersion,
    keyring: RELEASE_CATALOG_KEYRING,
  });
  const snapshot = catalog.load();
  setProviderCatalogStore(catalog);

  const vault = new CredentialVault(
    options.vaultAdapter ? { safeStorage: options.vaultAdapter } : undefined,
  );
  setProviderCredentialVault(vault);

  const status = new ProviderStatusService();
  let statusScheduler: ProviderStatusScheduler | null = null;
  if (options.statusSources) {
    statusScheduler = new ProviderStatusScheduler(status);
    statusScheduler.start(options.statusSources);
  }
  setProviderStatusService(status);

  const connections = new ConnectionStore();
  setProviderConnectionStore(connections);

  initializeProviderRuntime({ catalog, vault, connections, status });

  return { catalog, snapshot, vault, status, connections, statusScheduler };
}
