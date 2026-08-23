/**
 * U4 — plain-Node SecureStorageAdapter for the headless daemon.
 *
 * Confirms the plan's "env-referenced credentials on headless hosts" contract:
 * stored API-key secrets fail closed with the vault's typed unavailable
 * error, while environment credential references resolve WITHOUT touching the
 * vault adapter (the resolution reads process.env first).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vault.ts imports `safeStorage` from electron; the daemon never dereferences
// it (the adapter is injected), so a stub keeps the import side-effect-free.
const electron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

vi.mock('electron', () => electron);

import { CredentialVault, SecureStorageUnavailableError } from '../../src/main/providers/credentials/vault';
import { nodeSecureStorageAdapter } from '../../src/main/providers/credentials/node-storage-adapter';
import { readApiKeyForTrustedStatus } from '../../src/main/providers/views';
import type { ProviderConnection } from '../../src/shared/types/provider';

let tmpRoot: string;
let credentialsPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-node-vault-'));
  credentialsPath = path.join(tmpRoot, 'credentials.json');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('nodeSecureStorageAdapter', () => {
  it('reports encryption unavailable', () => {
    expect(nodeSecureStorageAdapter.isEncryptionAvailable()).toBe(false);
  });

  it('makes the vault report secure storage unavailable', () => {
    const vault = new CredentialVault({
      credentialsPath,
      safeStorage: nodeSecureStorageAdapter,
    });
    expect(vault.getAvailability()).toEqual({ available: false, reason: 'unavailable' });
  });

  it('rejects API-key storage with the typed unavailable error', async () => {
    const vault = new CredentialVault({
      credentialsPath,
      safeStorage: nodeSecureStorageAdapter,
    });
    const binding = {
      connectionId: '00000000-0000-4000-8000-000000000001',
      driverId: 'lilac',
      authMethod: 'api-key' as const,
      origin: 'https://api.example.com',
    };
    await expect(vault.replaceConnectionApiKey(binding, 'sk-test')).rejects.toBeInstanceOf(
      SecureStorageUnavailableError,
    );
    await expect(vault.storeApiKey(binding, 'sk-test')).rejects.toBeInstanceOf(
      SecureStorageUnavailableError,
    );
    // Nothing may have been written.
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it('fails closed decrypting a pre-existing stored record', async () => {
    // A record written by an Electron host (some other machine/user session).
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            handle: '00000000-0000-4000-8000-000000000002',
            generation: 1,
            binding: {
              connectionId: '00000000-0000-4000-8000-000000000001',
              driverId: 'lilac',
              authMethod: 'api-key',
              origin: 'https://api.example.com',
            },
            encryptedPayload: Buffer.from('opaque').toString('base64'),
            createdAt: '2026-08-23T00:00:00.000Z',
            updatedAt: '2026-08-23T00:00:00.000Z',
          },
        ],
      }),
    );
    const vault = new CredentialVault({
      credentialsPath,
      safeStorage: nodeSecureStorageAdapter,
    });
    await expect(
      vault.readSecret('00000000-0000-4000-8000-000000000002', {
        connectionId: '00000000-0000-4000-8000-000000000001',
        driverId: 'lilac',
        authMethod: 'api-key',
        origin: 'https://api.example.com',
      }),
    ).rejects.toBeInstanceOf(SecureStorageUnavailableError);
  });
});

describe('environment credential references on a headless host', () => {
  it('resolves from process.env without touching the vault adapter', async () => {
    const readSecret = vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'never' }));
    const deleteConnectionCredentials = vi.fn(async () => 0);
    const services = {
      catalog: { getProviderDefinitions: () => [], load: () => null },
      connections: { list: async () => [], get: async () => null },
      vault: { getAvailability: () => ({ available: false as const, reason: 'unavailable' as const }), readSecret, deleteConnectionCredentials },
      status: { get: () => null, list: () => [], refresh: vi.fn(), invalidate: vi.fn() },
      registry: { get: () => undefined, require: () => { throw new Error('unused'); } },
    };

    const connection = {
      id: '00000000-0000-4000-8000-000000000003',
      providerId: 'lilac',
      name: 'env-connection',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      credential: { kind: 'environment', variable: 'ORCHID_TEST_ENV_KEY' },
      modelIds: [],
      health: 'ready',
    } as unknown as ProviderConnection;

    process.env.ORCHID_TEST_ENV_KEY = 'env-resolved-secret';
    try {
      const apiKey = await readApiKeyForTrustedStatus(connection, services as never);
      expect(apiKey).toBe('env-resolved-secret');
      // The adapter/vault must never be consulted for environment references.
      expect(readSecret).not.toHaveBeenCalled();
      expect(deleteConnectionCredentials).not.toHaveBeenCalled();
    } finally {
      delete process.env.ORCHID_TEST_ENV_KEY;
    }
  });

  it('reports a missing environment variable without touching the vault', async () => {
    const readSecret = vi.fn(async () => ({ kind: 'api-key' as const, apiKey: 'never' }));
    const services = {
      catalog: { getProviderDefinitions: () => [], load: () => null },
      connections: { list: async () => [], get: async () => null },
      vault: { getAvailability: () => ({ available: false as const, reason: 'unavailable' as const }), readSecret },
      status: { get: () => null, list: () => [], refresh: vi.fn(), invalidate: vi.fn() },
      registry: { get: () => undefined, require: () => { throw new Error('unused'); } },
    };
    const connection = {
      id: '00000000-0000-4000-8000-000000000004',
      providerId: 'lilac',
      name: 'env-connection-missing',
      protocol: 'openai-compatible',
      authMethod: 'environment',
      credential: { kind: 'environment', variable: 'ORCHID_TEST_ENV_MISSING_KEY' },
      modelIds: [],
      health: 'ready',
    } as unknown as ProviderConnection;

    delete process.env.ORCHID_TEST_ENV_MISSING_KEY;
    await expect(
      readApiKeyForTrustedStatus(connection, services as never),
    ).rejects.toThrow(/ORCHID_TEST_ENV_MISSING_KEY/);
    expect(readSecret).not.toHaveBeenCalled();
  });
});
