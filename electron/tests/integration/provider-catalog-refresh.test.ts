import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderCatalogStore } from '../../src/main/providers/catalog/store';
import { ProviderCatalogUpdater } from '../../src/main/providers/catalog/updater';
import { type CatalogKeyring } from '../../src/main/providers/catalog/trust';
import { CATALOG_NOW as NOW, createCatalogFixture as createCatalog } from '../fixtures/provider-catalog/catalog-fixture';

let tempDir: string;
let bundledCatalogPath: string;
let cachePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-catalog-'));
  bundledCatalogPath = path.join(tempDir, 'bundled-catalog.json');
  cachePath = path.join(tempDir, 'cache', 'catalog.json');
  fs.writeFileSync(bundledCatalogPath, JSON.stringify(createCatalog(1)), 'utf8');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function signedCatalog(version: number, changes?: (catalog: ReturnType<typeof createCatalog>) => void) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const catalog = createCatalog(version);
  changes?.(catalog);
  const bytes = Buffer.from(JSON.stringify(catalog), 'utf8');
  return {
    bytes,
    signature: sign(null, bytes, privateKey),
    privateKey,
    keyId: 'test-key',
    keyring: {
      'test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    } satisfies CatalogKeyring,
  };
}

function createStore(keyring: CatalogKeyring): ProviderCatalogStore {
  return new ProviderCatalogStore({
    bundledCatalogPath,
    cachePath,
    appVersion: '0.1.0',
    keyring,
    now: () => new Date(NOW),
  });
}

describe('ProviderCatalogStore refresh lifecycle', () => {
  it('atomically promotes a valid higher-version signed catalog and exposes it only after validation', async () => {
    const remote = signedCatalog(2);
    const store = createStore(remote.keyring);
    const updater = new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => remote,
    });

    expect(store.load()).toMatchObject({ source: 'bundled', stale: false });
    await expect(updater.refresh()).resolves.toMatchObject({ kind: 'updated' });
    expect(store.load()).toMatchObject({
      source: 'cache',
      stale: false,
      catalog: { catalogVersion: 2 },
    });
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(fs.existsSync(`${cachePath}.tmp`)).toBe(false);
  });

  it('retains last-known-good data when the remote signature, version, or schema is rejected', async () => {
    const remote = signedCatalog(2);
    const store = createStore(remote.keyring);
    store.promote(remote);
    const baseline = store.load();

    const badSignature = new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => ({ ...remote, signature: Buffer.from('not-a-signature') }),
    });
    await expect(badSignature.refresh()).rejects.toThrow();
    expect(store.load()).toEqual(baseline);

    const rollback = remote;
    const rejectedRollback = new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => rollback,
    });
    await expect(rejectedRollback.refresh()).rejects.toThrow(/newer/i);
    expect(store.load()).toEqual(baseline);

    const expiredCatalog = createCatalog(3);
    expiredCatalog.issuedAt = '2026-07-10T00:00:00.000Z';
    expiredCatalog.expiresAt = '2026-07-11T00:00:00.000Z';
    const expiredBytes = Buffer.from(JSON.stringify(expiredCatalog), 'utf8');
    const expired = new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => ({
        bytes: expiredBytes,
        signature: sign(null, expiredBytes, remote.privateKey),
        keyId: remote.keyId,
      }),
    });
    await expect(expired.refresh()).rejects.toThrow(/expired/i);
    expect(store.load()).toEqual(baseline);

    const remoteDriverCatalog = createCatalog(3);
    remoteDriverCatalog.providers[0].id = 'remote-driver';
    const remoteDriverBytes = Buffer.from(JSON.stringify(remoteDriverCatalog), 'utf8');
    const remoteDriver = {
      bytes: remoteDriverBytes,
      signature: sign(null, remoteDriverBytes, remote.privateKey),
      keyId: remote.keyId,
    };
    const rejectedDriver = new ProviderCatalogUpdater(store, {
      fetchCatalog: async () => remoteDriver,
    });
    await expect(rejectedDriver.refresh()).rejects.toThrow(/trusted driver/i);
    expect(store.load()).toEqual(baseline);
  });

  it('uses an expired but verified cache as stale last-known-good data and ignores an interrupted temporary write', () => {
    const remote = signedCatalog(2, (catalog) => {
      catalog.issuedAt = '2026-07-10T00:00:00.000Z';
      catalog.expiresAt = '2026-07-11T00:00:00.000Z';
    });
    const writer = createStore(remote.keyring);
    writer.promote({ ...remote, allowExpired: true });
    fs.writeFileSync(`${cachePath}.tmp`, '{"truncated"', 'utf8');

    const restarted = createStore(remote.keyring);
    expect(restarted.load()).toMatchObject({
      source: 'cache',
      stale: true,
      catalog: { catalogVersion: 2 },
    });
  });

  it('keeps a frozen resolved snapshot unchanged after a newer pricing catalog is promoted', () => {
    const first = signedCatalog(2);
    const store = createStore(first.keyring);
    store.promote(first);
    const frozen = structuredClone(store.load().catalog.providers[0].models[0].pricing);

    const nextCatalog = createCatalog(3);
    nextCatalog.providers[0].models[0].pricing.rates.input.amount = '99.000000';
    const nextBytes = Buffer.from(JSON.stringify(nextCatalog), 'utf8');
    store.promote({
      bytes: nextBytes,
      signature: sign(null, nextBytes, first.privateKey),
      keyId: first.keyId,
    });

    expect(store.load().catalog.providers[0].models[0].pricing.rates.input?.amount).toBe('99.000000');

    expect(frozen).toEqual({
      currency: 'USD',
      effectiveAt: NOW,
      rates: {
        input: { amount: '1.250000', per: 1000000, unit: 'tokens' },
        output: { amount: '5.000000', per: 1000000, unit: 'tokens' },
      },
      provenance: { source: 'catalog', observedAt: NOW },
    });
  });
});
