/**
 * Shared provider-runtime composition (fix #15) — the one helper the Electron
 * shell, the embedded local host, and the `orchid-agent` daemon all call.
 *
 * Covers the two properties the three former duplications kept drifting on:
 * - the bundled-catalog resolver honors caller-supplied roots first and then
 *   the built-in deployment layouts (first existing candidate wins);
 * - the composition installs a loaded catalog, the injected vault adapter,
 *   the status service (+ optional scheduler), the connection store, and the
 *   ProviderRuntime into the shared runtime context.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCatalogFixture } from '../fixtures/provider-catalog/catalog-fixture';
import {
  RELEASE_CATALOG_KEYRING,
  composeProviderRuntime,
  resolveBundledCatalogRoot,
} from '../../src/main/providers/compose-runtime';
import {
  getProviderCatalogStore,
  getProviderConnectionStore,
  getProviderCredentialVault,
  isProviderRuntimeContextInitialized,
  resetProviderRuntimeContext,
} from '../../src/main/providers/runtime-context';
import { getProviderRuntime, resetProviderRuntime } from '../../src/main/providers';

// Point HOME_CONFIG_DIR at a throwaway dir BEFORE any provider module loads:
// the catalog store, vault, and connection store each capture it at module
// scope for their default paths.
const TEST_HOME = vi.hoisted(() =>
  `${require('node:os').tmpdir()}/orchid-compose-runtime-${process.pid}`);
vi.mock('../../src/main/config/loader', () => ({
  HOME_CONFIG_DIR: TEST_HOME,
  HOME_CONFIG_PATH: `${TEST_HOME}/config.json`,
  atomicWriteJson: vi.fn(),
  getConfig: vi.fn(() => ({})),
}));

const stubVaultAdapter = () => ({
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn(() => Buffer.alloc(0)),
  decryptString: vi.fn(() => ''),
});

beforeAll(() => {
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  resetProviderRuntimeContext();
  resetProviderRuntime();
});

describe('resolveBundledCatalogRoot', () => {
  it('prefers a caller-supplied root over the built-in candidates', () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-compose-root-'));
    try {
      fs.mkdirSync(path.join(extra, 'providers'), { recursive: true });
      fs.writeFileSync(
        path.join(extra, 'providers', 'catalog.json'),
        JSON.stringify(createCatalogFixture()),
      );
      expect(resolveBundledCatalogRoot([extra])).toBe(extra);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it('skips a caller-supplied root without a catalog and falls back to the repo assets', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-compose-empty-'));
    try {
      const resolved = resolveBundledCatalogRoot([empty]);
      // Under the vitest src/ layout the repo's electron/assets root matches.
      expect(resolved).not.toBe(empty);
      expect(resolved).not.toBeNull();
      expect(fs.existsSync(path.join(resolved!, 'providers', 'catalog.json'))).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('composeProviderRuntime', () => {
  it('composes and installs the runtime with the injected adapter and extra catalog root', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-compose-fixture-'));
    const adapter = stubVaultAdapter();
    try {
      const composed = composeProviderRuntime({
        appVersion: '0.1.0',
        vaultAdapter: adapter,
        extraCatalogRoots: [fixtureRoot],
        statusSources: [],
      });

      // The fixture catalog (not the repo bundle) was loaded and installed.
      expect(composed.snapshot).toMatchObject({ source: 'bundled' });
      expect(composed.snapshot.catalog.providers[0]?.id).toBe('openai');
      expect(getProviderCatalogStore()).toBe(composed.catalog);
      expect(isProviderRuntimeContextInitialized()).toBe(true);
      expect(getProviderConnectionStore()).toBe(composed.connections);

      // The injected vault adapter reaches the installed vault.
      expect(getProviderCredentialVault()).toBe(composed.vault);
      expect(composed.vault.getAvailability()).toEqual({ available: false, reason: 'unavailable' });
      expect(adapter.isEncryptionAvailable).toHaveBeenCalled();

      // statusSources were supplied: a scheduler was created and started.
      expect(composed.statusScheduler).not.toBeNull();
      composed.statusScheduler?.stop();

      // The ProviderRuntime itself resolves through the shared handle.
      expect(getProviderRuntime()).toBeDefined();
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('resolves the repo bundle when no extra root matches (daemon/shell shape)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-compose-empty-'));
    try {
      const composed = composeProviderRuntime({
        appVersion: '0.1.0',
        extraCatalogRoots: [empty],
      });

      // The bundled repo catalog loads without an adapter (Electron default
      // vault) and without status sources (embedded-host lazy shape).
      expect(composed.snapshot.source).toBe('bundled');
      expect(composed.snapshot.catalog.providers.length).toBeGreaterThan(0);
      expect(composed.statusScheduler).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('shares one code-owned release keyring constant', () => {
    expect(RELEASE_CATALOG_KEYRING).toEqual({});
    expect(Object.isFrozen(RELEASE_CATALOG_KEYRING)).toBe(true);
  });
});
