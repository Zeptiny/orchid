/**
 * Machine password store tests (password SSH auth).
 *
 * Mirrors provider-credential-vault.test.ts: electron safeStorage is mocked,
 * and every case runs against a throwaway file so nothing touches the real
 * ~/.orchid. Fail-closed posture: unavailable / basic_text storage refuses
 * writes and decrypts; presence checks never decrypt.
 */
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

let secretsModule: typeof import('../../src/main/machines/machine-secrets');
let tempDir: string;
let filePath: string;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockSafeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  mockSafeStorage.encryptString.mockImplementation((value: string) =>
    Buffer.from(`encrypted:${value}`, 'utf8'));
  mockSafeStorage.decryptString.mockImplementation((value: Buffer) =>
    value.toString('utf8').replace(/^encrypted:/, ''));
  vi.doMock('electron', () => ({ safeStorage: mockSafeStorage }));
  secretsModule = await import('../../src/main/machines/machine-secrets');
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-machine-secrets-'));
  filePath = path.join(tempDir, 'machine-passwords.json');
});

afterEach(() => {
  secretsModule._clearMachinePasswordWriteChains();
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createStore() {
  return new secretsModule.MachineSecretsStore({
    filePath,
    storage: mockSafeStorage,
    now: () => new Date('2026-08-23T00:00:00.000Z'),
  });
}

describe('MachineSecretsStore', () => {
  it('round-trips a password without ever persisting plaintext', async () => {
    const store = createStore();
    await store.setPassword('build-1', 'hunter2!');

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('hunter2!');
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      entries: [
        {
          machineId: 'build-1',
          encryptedPassword: Buffer.from('encrypted:hunter2!', 'utf8').toString('base64'),
        },
      ],
    });
    expect(store.hasPassword('build-1')).toBe(true);
    expect(store.getPassword('build-1')).toBe('hunter2!');
  });

  it('replaces a prior password and keeps one entry per machine', async () => {
    const store = createStore();
    await store.setPassword('build-1', 'first');
    await store.setPassword('build-1', 'second');

    expect(store.getPassword('build-1')).toBe('second');
    expect(store.storedMachineIds()).toEqual(['build-1']);
  });

  it('returns null for unknown machines without touching storage', () => {
    const store = createStore();
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

    expect(store.hasPassword('ghost')).toBe(false);
    expect(store.getPassword('ghost')).toBeNull();
    expect(mockSafeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it('clears a stored password and tolerates missing entries', async () => {
    const store = createStore();
    await store.setPassword('build-1', 'hunter2!');
    await store.clearPassword('build-1');
    expect(store.hasPassword('build-1')).toBe(false);

    await expect(store.clearPassword('build-1')).resolves.toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('refuses to write when secure storage is unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
    const store = createStore();
    await expect(store.setPassword('build-1', 'hunter2!')).rejects.toThrow(
      secretsModule.MachinePasswordUnavailableError,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('refuses to write when Linux selects basic_text storage', async () => {
    mockSafeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    const store = createStore();
    await expect(store.setPassword('build-1', 'hunter2!')).rejects.toThrow(/basic_text/);
  });

  it('fails closed when decrypting with unavailable storage', async () => {
    const store = createStore();
    await store.setPassword('build-1', 'hunter2!');
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

    expect(() => store.getPassword('build-1')).toThrow(secretsModule.MachinePasswordUnavailableError);
  });

  it('surfaces a typed error when the stored payload cannot be decrypted', async () => {
    const store = createStore();
    await store.setPassword('build-1', 'hunter2!');
    mockSafeStorage.decryptString.mockImplementation(() => {
      throw new Error('corrupt');
    });

    expect(() => store.getPassword('build-1')).toThrow(secretsModule.MachineSecretsError);
  });

  it('rejects invalid machine ids and empty passwords', async () => {
    const store = createStore();
    await expect(store.setPassword('local', 'pw')).rejects.toThrow(/reserved|invalid/i);
    await expect(store.setPassword('build-1', '')).rejects.toThrow(/must not be empty/);
  });
});
