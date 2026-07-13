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
let refreshModule: typeof import('../../src/main/providers/credentials/refresh');
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
  refreshModule = await import('../../src/main/providers/credentials/refresh');
  connectionStoreModule = await import('../../src/main/providers/connection-store');
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-auth-lifecycle-'));
});

afterEach(() => {
  vaultModule._clearCredentialVaultWriteChains();
  connectionStoreModule._clearConnectionStoreWriteChains();
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function createOAuthConnection(name: string) {
  const connections = new connectionStoreModule.ConnectionStore({
    providersPath: path.join(tempDir, 'providers.json'),
  });
  const connection = await connections.create({
    providerId: 'chatgpt-codex',
    name,
    protocol: 'openai-compatible',
    authMethod: 'oauth',
    credential: { kind: 'none' },
    modelIds: ['gpt-5.2-codex'],
    health: 'ready',
    endpoint: 'https://api.openai.com/v1',
  });
  return { connections, connection };
}

describe('connection-scoped credential refresh lifecycle', () => {
  it('uses the trusted driver origin instead of editable connection metadata for refresh binding', async () => {
    const { connections, connection } = await createOAuthConnection('Trusted origin');
    const vault = new vaultModule.CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    const trustedOrigin = 'https://chatgpt.com/backend-api';
    const trustedBinding = {
      connectionId: connection.id,
      driverId: connection.providerId,
      authMethod: 'oauth' as const,
      origin: trustedOrigin,
    };
    const handle = await vault.storeOAuthTokens(trustedBinding, {
      accessToken: 'old-access-token-123456',
      refreshToken: 'old-refresh-token-123456',
      expiresAt: '2026-07-12T00:00:00.000Z',
      tokenType: 'Bearer',
    });
    await connections.update(connection.id, { credential: { kind: 'stored', handle } });
    const refresh = new refreshModule.CredentialRefreshCoordinator({ vault, connections });

    await refresh.refreshConnection(connection.id, async () => ({
      accessToken: 'new-access-token-123456',
      refreshToken: 'new-refresh-token-123456',
      expiresAt: '2026-07-12T02:00:00.000Z',
      tokenType: 'Bearer',
    }), { origin: trustedOrigin });

    await expect(vault.readSecret(handle, trustedBinding)).resolves.toMatchObject({
      accessToken: 'new-access-token-123456',
    });
  });

  it('single-flights concurrent refreshes, rotates tokens, and never writes them into connection metadata', async () => {
    const { connections, connection } = await createOAuthConnection('Work');
    const vault = new vaultModule.CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    const binding = {
      connectionId: connection.id,
      driverId: connection.providerId,
      authMethod: 'oauth' as const,
      origin: connection.endpoint ?? null,
    };
    const handle = await vault.storeOAuthTokens(binding, {
      accessToken: 'old-access-token-123456',
      refreshToken: 'old-refresh-token-123456',
      expiresAt: '2026-07-12T00:00:00.000Z',
      tokenType: 'Bearer',
    });
    await connections.update(connection.id, { credential: { kind: 'stored', handle } });
    const refresh = new refreshModule.CredentialRefreshCoordinator({ vault, connections });
    const refreshTokens = vi.fn(async () => ({
      accessToken: 'new-access-token-123456',
      refreshToken: 'new-refresh-token-123456',
      expiresAt: '2026-07-12T02:00:00.000Z',
      tokenType: 'Bearer',
    }));

    const [first, second] = await Promise.all([
      refresh.refreshConnection(connection.id, refreshTokens),
      refresh.refreshConnection(connection.id, refreshTokens),
    ]);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(await vault.readSecret(handle, binding)).toMatchObject({
      accessToken: 'new-access-token-123456',
      refreshToken: 'new-refresh-token-123456',
    });
    const persistedConnections = fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8');
    const persistedCredentials = fs.readFileSync(path.join(tempDir, 'credentials.json'), 'utf8');
    expect(persistedConnections).not.toMatch(/access-token|refresh-token/);
    expect(persistedCredentials).not.toMatch(/new-access-token|new-refresh-token/);
  });

  it('marks only the failed connection needs_attention and disconnect deletes all local secrets', async () => {
    const { connections, connection: work } = await createOAuthConnection('Work');
    const personal = await connections.create({
      providerId: 'chatgpt-codex',
      name: 'Personal',
      protocol: 'openai-compatible',
      authMethod: 'oauth',
      credential: { kind: 'none' },
      modelIds: ['gpt-5.2-codex'],
      health: 'ready',
      endpoint: 'https://api.openai.com/v1',
    });
    const vault = new vaultModule.CredentialVault({ credentialsPath: path.join(tempDir, 'credentials.json') });
    const workBinding = { connectionId: work.id, driverId: work.providerId, authMethod: 'oauth' as const, origin: work.endpoint ?? null };
    const personalBinding = { connectionId: personal.id, driverId: personal.providerId, authMethod: 'oauth' as const, origin: personal.endpoint ?? null };
    const workHandle = await vault.storeOAuthTokens(workBinding, {
      accessToken: 'work-access-token-123456', refreshToken: 'work-refresh-token-123456', expiresAt: '2026-07-12T00:00:00.000Z', tokenType: 'Bearer',
    });
    const personalHandle = await vault.storeOAuthTokens(personalBinding, {
      accessToken: 'personal-access-token-123456', refreshToken: 'personal-refresh-token-123456', expiresAt: '2026-07-12T00:00:00.000Z', tokenType: 'Bearer',
    });
    await connections.update(work.id, { credential: { kind: 'stored', handle: workHandle } });
    await connections.update(personal.id, { credential: { kind: 'stored', handle: personalHandle } });
    const refresh = new refreshModule.CredentialRefreshCoordinator({ vault, connections });

    await expect(refresh.refreshConnection(work.id, async () => {
      throw new Error('upstream revoked');
    })).rejects.toThrow(/revoked/i);
    expect((await connections.get(work.id))?.health).toBe('needs_attention');
    expect((await connections.get(personal.id))?.health).toBe('ready');

    await refresh.disconnectConnection(personal.id);
    await expect(vault.readSecret(personalHandle, personalBinding)).rejects.toThrow(/unknown/i);
    expect(await connections.get(personal.id)).toMatchObject({
      health: 'disconnected',
      credential: { kind: 'none' },
    });
  });
});
