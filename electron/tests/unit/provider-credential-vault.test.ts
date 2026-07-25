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
let tempDir: string;
let credentialsPath: string;

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

const binding = {
  connectionId: CONNECTION_ID,
  driverId: 'openai',
  authMethod: 'api-key' as const,
  origin: 'https://api.openai.com/v1',
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockSafeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  mockSafeStorage.encryptString.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`, 'utf8'));
  mockSafeStorage.decryptString.mockImplementation((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''));
  vi.doMock('electron', () => ({ safeStorage: mockSafeStorage }));
  vaultModule = await import('../../src/main/providers/credentials/vault');
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-provider-vault-'));
  credentialsPath = path.join(tempDir, 'credentials.json');
});

afterEach(() => {
  vaultModule._clearCredentialVaultWriteChains();
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createVault() {
  return new vaultModule.CredentialVault({ credentialsPath });
}

describe('CredentialVault', () => {
  it('encrypts an API key into a connection-scoped handle without persisting plaintext', async () => {
    const vault = createVault();
    const handle = await vault.storeApiKey(binding, 'sk-secret-api-key-123456');

    expect(handle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await vault.readSecret(handle, binding)).toEqual({
      kind: 'api-key',
      apiKey: 'sk-secret-api-key-123456',
    });
    const raw = fs.readFileSync(credentialsPath, 'utf8');
    expect(raw).not.toContain('sk-secret-api-key-123456');
    expect(raw).not.toContain('apiKey');
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(credentialsPath)).mode & 0o777).toBe(0o700);
  });

  it('fails closed when safeStorage is unavailable or uses Linux basic_text, while environment references stay usable', async () => {
    mockSafeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    const vault = createVault();

    expect(vault.getAvailability()).toMatchObject({ available: false, reason: 'basic_text' });
    await expect(vault.storeApiKey(binding, 'sk-secret-api-key-123456'))
      .rejects.toBeInstanceOf(vaultModule.SecureStorageUnavailableError);
    expect(vaultModule.createEnvironmentCredentialReference('OPENAI_API_KEY')).toEqual({
      kind: 'environment',
      variable: 'OPENAI_API_KEY',
    });
    expect(() => vaultModule.createEnvironmentCredentialReference('openai-key'))
      .toThrow(/environment/i);
    expect(fs.existsSync(credentialsPath)).toBe(false);
  });

  it('binds stored credentials to connection, driver, auth method, and normalized origin', async () => {
    const vault = createVault();
    const handle = await vault.storeApiKey(binding, 'sk-secret-api-key-123456');

    await expect(vault.readSecret(handle, {
      ...binding,
      connectionId: OTHER_CONNECTION_ID,
    })).rejects.toThrow(/binding/i);
    await expect(vault.readSecret(handle, {
      ...binding,
      driverId: 'generic-openai-compatible',
    })).rejects.toThrow(/binding/i);
    expect(await vault.readSecret(handle, {
      ...binding,
      origin: 'https://api.openai.com/another/path',
    })).toEqual({ kind: 'api-key', apiKey: 'sk-secret-api-key-123456' });
  });

  it('atomically replaces stale API-key generations for one connection', async () => {
    const vault = createVault();
    const first = await vault.storeApiKey(binding, 'sk-old-key-123456');
    const other = await vault.storeApiKey({ ...binding, connectionId: OTHER_CONNECTION_ID }, 'sk-other-key-123456');

    const replacement = await vault.replaceConnectionApiKey(binding, 'sk-new-key-123456');

    await expect(vault.readSecret(first, binding)).rejects.toThrow(/unknown/i);
    expect(await vault.readSecret(replacement, binding)).toEqual({
      kind: 'api-key',
      apiKey: 'sk-new-key-123456',
    });
    expect(await vault.readSecret(other, { ...binding, connectionId: OTHER_CONNECTION_ID })).toEqual({
      kind: 'api-key',
      apiKey: 'sk-other-key-123456',
    });
    const raw = fs.readFileSync(credentialsPath, 'utf8');
    expect(raw).not.toContain('sk-old-key-123456');
    expect(raw).not.toContain('sk-new-key-123456');
  });

  it('deletes every stored generation for a connection on disconnect', async () => {
    const vault = createVault();
    const handle = await vault.storeApiKey(binding, 'sk-disconnect-key-123456');
    expect(await vault.readSecret(handle, binding)).toEqual({
      kind: 'api-key',
      apiKey: 'sk-disconnect-key-123456',
    });
    await vault.deleteConnectionCredentials(CONNECTION_ID);
    await expect(vault.readSecret(handle, binding)).rejects.toThrow(/unknown/i);
  });
});
