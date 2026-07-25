import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
};

vi.mock('electron', () => ({ safeStorage: mockSafeStorage }));

let vaultModule: typeof import('../../src/main/providers/credentials/vault');
let connectionStoreModule: typeof import('../../src/main/providers/connection-store');
let tempDir: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockSafeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  mockSafeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`, 'utf8'));
  mockSafeStorage.decryptString.mockImplementation((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''));
  vi.doMock('electron', () => ({ safeStorage: mockSafeStorage }));
  vaultModule = await import('../../src/main/providers/credentials/vault');
  connectionStoreModule = await import('../../src/main/providers/connection-store');
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-auth-lifecycle-'));
});

afterEach(() => {
  vaultModule._clearCredentialVaultWriteChains();
  connectionStoreModule._clearConnectionStoreWriteChains();
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function createApiKeyConnection(name: string) {
  const connections = new connectionStoreModule.ConnectionStore({
    providersPath: path.join(tempDir, 'providers.json'),
  });
  const connection = await connections.create({
    providerId: 'openai',
    name,
    protocol: 'openai-compatible',
    authMethod: 'api-key',
    credential: { kind: 'none' },
    modelIds: ['gpt-5.2-pro'],
    health: 'ready',
  });
  return { connections, connection };
}

describe('connection-scoped API-key credential lifecycle', () => {
  it('binds stored API keys to the trusted driver origin rather than editable connection metadata', async () => {
    const { connections, connection } = await createApiKeyConnection('Trusted origin');
    const vault = new vaultModule.CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    const trustedOrigin = 'https://api.openai.com';
    const trustedBinding = {
      connectionId: connection.id,
      driverId: connection.providerId,
      authMethod: 'api-key' as const,
      origin: trustedOrigin,
    };
    const handle = await vault.storeApiKey(trustedBinding, 'sk-trusted-origin-123456');
    await connections.update(connection.id, { credential: { kind: 'stored', handle } });

    await expect(vault.readSecret(handle, trustedBinding)).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'sk-trusted-origin-123456',
    });
    await expect(vault.readSecret(handle, {
      ...trustedBinding,
      origin: 'https://attacker.example.test',
    })).rejects.toThrow(/binding/i);
  });

  it('replaces a connection API key atomically and never writes secrets into connection metadata', async () => {
    const { connections, connection } = await createApiKeyConnection('Work');
    const vault = new vaultModule.CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    const binding = {
      connectionId: connection.id,
      driverId: connection.providerId,
      authMethod: 'api-key' as const,
      origin: 'https://api.openai.com',
    };
    const first = await vault.replaceConnectionApiKey(binding, 'sk-old-key-123456');
    await connections.update(connection.id, { credential: { kind: 'stored', handle: first } });
    const second = await vault.replaceConnectionApiKey(binding, 'sk-new-key-123456');
    await connections.update(connection.id, { credential: { kind: 'stored', handle: second } });

    await expect(vault.readSecret(first, binding)).rejects.toThrow(/unknown/i);
    await expect(vault.readSecret(second, binding)).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'sk-new-key-123456',
    });
    const persistedConnections = fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8');
    const persistedCredentials = fs.readFileSync(path.join(tempDir, 'credentials.json'), 'utf8');
    expect(persistedConnections).not.toMatch(/sk-old-key|sk-new-key/);
    expect(persistedCredentials).not.toMatch(/sk-old-key|sk-new-key/);
  });

  it('disconnect deletes only the targeted connection secrets', async () => {
    const { connections, connection: work } = await createApiKeyConnection('Work');
    const personal = await connections.create({
      providerId: 'openai',
      name: 'Personal',
      protocol: 'openai-compatible',
      authMethod: 'api-key',
      credential: { kind: 'none' },
      modelIds: ['gpt-5.2-pro'],
      health: 'ready',
    });
    const vault = new vaultModule.CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    const workBinding = {
      connectionId: work.id,
      driverId: work.providerId,
      authMethod: 'api-key' as const,
      origin: 'https://api.openai.com',
    };
    const personalBinding = {
      connectionId: personal.id,
      driverId: personal.providerId,
      authMethod: 'api-key' as const,
      origin: 'https://api.openai.com',
    };
    const workHandle = await vault.storeApiKey(workBinding, 'sk-work-key-123456');
    const personalHandle = await vault.storeApiKey(personalBinding, 'sk-personal-key-123456');
    await connections.update(work.id, { credential: { kind: 'stored', handle: workHandle } });
    await connections.update(personal.id, { credential: { kind: 'stored', handle: personalHandle } });

    await vault.deleteConnectionCredentials(personal.id);
    await connections.update(personal.id, {
      health: 'disconnected',
      credential: { kind: 'none' },
    });

    await expect(vault.readSecret(personalHandle, personalBinding)).rejects.toThrow(/unknown/i);
    await expect(vault.readSecret(workHandle, workBinding)).resolves.toEqual({
      kind: 'api-key',
      apiKey: 'sk-work-key-123456',
    });
    expect(await connections.get(personal.id)).toMatchObject({
      health: 'disconnected',
      credential: { kind: 'none' },
    });
    expect((await connections.get(work.id))?.health).toBe('ready');
  });
});
