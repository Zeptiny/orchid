/**
 * Keychain integration tests — U25.
 *
 * Covers:
 * - Encrypt/decrypt round-trip
 * - Config redaction (API keys masked in output)
 * - Session redaction (sensitive strings in text)
 * - Fallback with warning when encryption unavailable
 * - Key lifecycle (store, retrieve, delete, list)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock safeStorage before importing keychain
// ---------------------------------------------------------------------------

const mockSafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((plaintext: string) => {
    // Simple XOR "encryption" for testing (not real crypto)
    const key = 0x42;
    const buf = Buffer.from(plaintext, 'utf-8');
    for (let i = 0; i < buf.length; i++) {
      buf[i] = buf[i]! ^ key;
    }
    return buf;
  }),
  decryptString: vi.fn((encrypted: Buffer) => {
    const key = 0x42;
    const buf = Buffer.from(encrypted);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = buf[i]! ^ key;
    }
    return buf.toString('utf-8');
  }),
};

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
}));

// ---------------------------------------------------------------------------
// Import keychain after mock setup
// ---------------------------------------------------------------------------

let keychain: typeof import('../../src/main/config/keychain');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();

  // Re-apply base implementations — vi.clearAllMocks() clears call history
  // but not mockImplementation overrides from previous tests (vi.fn, not spyOn).
  mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
  mockSafeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  mockSafeStorage.encryptString.mockImplementation((plaintext: string) => {
    const key = 0x42;
    const buf = Buffer.from(plaintext, 'utf-8');
    for (let i = 0; i < buf.length; i++) {
      buf[i] = buf[i]! ^ key;
    }
    return buf;
  });
  mockSafeStorage.decryptString.mockImplementation((encrypted: Buffer) => {
    const key = 0x42;
    const buf = Buffer.from(encrypted);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = buf[i]! ^ key;
    }
    return buf.toString('utf-8');
  });

  vi.doMock('electron', () => ({
    safeStorage: mockSafeStorage,
  }));

  keychain = await import('../../src/main/config/keychain');
});

// ---------------------------------------------------------------------------
// Temp dir for keychain file
// ---------------------------------------------------------------------------

let tmpDir: string;
let keychainPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-keychain-test-'));
  keychainPath = path.join(tmpDir, '.orchid', 'keychain.json');
});

afterEach(() => {
  keychain._setTestReadWriteBarrier(undefined);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// isAvailable
// ===========================================================================

describe('isAvailable', () => {
  it('returns true when safeStorage reports encryption available', () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    expect(keychain.isAvailable()).toBe(true);
  });

  it('returns false when safeStorage reports encryption unavailable', () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
    expect(keychain.isAvailable()).toBe(false);
  });

  it('returns false when safeStorage.isEncryptionAvailable throws', () => {
    mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('not supported');
    });
    expect(keychain.isAvailable()).toBe(false);
  });
});

// ===========================================================================
// Encrypt / decrypt round-trip
// ===========================================================================

describe('encryptAndStore / retrieveAndDecrypt', () => {
  it('round-trips a value through encryption', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('test-key', 'sk-secret123456', { keychainPath });
    const result = await keychain.retrieveAndDecrypt('test-key', { keychainPath });

    expect(result).toBe('sk-secret123456');
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('sk-secret123456');
    expect(mockSafeStorage.decryptString).toHaveBeenCalled();
  });

  it('round-trips multiple keys independently', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('key-a', 'value-a', { keychainPath });
    await keychain.encryptAndStore('key-b', 'value-b', { keychainPath });

    expect(await keychain.retrieveAndDecrypt('key-a', { keychainPath })).toBe('value-a');
    expect(await keychain.retrieveAndDecrypt('key-b', { keychainPath })).toBe('value-b');
  });

  it('overwrites an existing key', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('key', 'old-value', { keychainPath });
    await keychain.encryptAndStore('key', 'new-value', { keychainPath });

    expect(await keychain.retrieveAndDecrypt('key', { keychainPath })).toBe('new-value');
  });

  it('returns null for a non-existent key', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    const result = await keychain.retrieveAndDecrypt('nonexistent', { keychainPath });
    expect(result).toBeNull();
  });

  it('handles empty string values', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('empty', '', { keychainPath });
    const result = await keychain.retrieveAndDecrypt('empty', { keychainPath });

    expect(result).toBe('');
  });

  it('handles unicode values', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    const unicodeValue = 'key-with-unicode-🔐-chars-日本語';

    await keychain.encryptAndStore('unicode', unicodeValue, { keychainPath });
    const result = await keychain.retrieveAndDecrypt('unicode', { keychainPath });

    expect(result).toBe(unicodeValue);
  });
});

// ===========================================================================
// Secure-storage failure (no plaintext fallback)
// ===========================================================================

describe('secure-storage failure', () => {
  it('rejects persistence when encryption is unavailable instead of writing plaintext', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

    await expect(keychain.encryptAndStore('fallback-key', 'plaintext-value', { keychainPath }))
      .rejects.toThrow(/plaintext credential persistence is disabled/i);
    expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
    expect(fs.existsSync(keychainPath)).toBe(false);
  });

  it('rejects Linux basic_text storage as insecure', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    await expect(keychain.encryptAndStore('key1', 'val1', { keychainPath })).rejects.toThrow();
    expect(fs.existsSync(keychainPath)).toBe(false);
  });

  it('ignores a legacy plaintext keychain file', async () => {
    fs.mkdirSync(path.dirname(keychainPath), { recursive: true });
    fs.writeFileSync(
      keychainPath,
      JSON.stringify({ encrypted: false, entries: { key: 'plain-value' } }),
      'utf-8',
    );

    const result = await keychain.retrieveAndDecrypt('key', { keychainPath });
    expect(result).toBeNull();
  });

  it('handles decryption failure gracefully', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    // Store a value
    await keychain.encryptAndStore('key', 'value', { keychainPath });

    // Now make decryptString throw
    mockSafeStorage.decryptString.mockImplementation(() => {
      throw new Error('keychain locked');
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await keychain.retrieveAndDecrypt('key', { keychainPath });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to decrypt'),
    );

    consoleSpy.mockRestore();
  });

  it('returns null when file is encrypted but safeStorage is unavailable (P0-2)', async () => {
    // Encrypt a value while safeStorage is available
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    await keychain.encryptAndStore('key', 'sk-secret-api-key', { keychainPath });

    // Verify the stored file is encrypted
    const content = JSON.parse(fs.readFileSync(keychainPath, 'utf-8'));
    expect(content.encrypted).toBe(true);

    // Now simulate safeStorage becoming unavailable (e.g. Linux libsecret crash)
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await keychain.retrieveAndDecrypt('key', { keychainPath });

    // Must NOT return the base64 ciphertext — that would leak it as a Bearer token
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cannot decrypt'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('safeStorage is unavailable'),
    );

    consoleSpy.mockRestore();
  });
});

// ===========================================================================
// deleteKey
// ===========================================================================

describe('deleteKey', () => {
  it('removes a stored key', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('to-delete', 'value', { keychainPath });
    expect(await keychain.retrieveAndDecrypt('to-delete', { keychainPath })).toBe('value');

    await keychain.deleteKey('to-delete', { keychainPath });
    expect(await keychain.retrieveAndDecrypt('to-delete', { keychainPath })).toBeNull();
  });

  it('is a no-op for non-existent keys', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    // Should not throw
    await keychain.deleteKey('nonexistent', { keychainPath });
  });
});

// ===========================================================================
// listKeys
// ===========================================================================

describe('listKeys', () => {
  it('returns all stored keys', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('key-a', 'val-a', { keychainPath });
    await keychain.encryptAndStore('key-b', 'val-b', { keychainPath });
    await keychain.encryptAndStore('key-c', 'val-c', { keychainPath });

    const keys = await keychain.listKeys({ keychainPath });
    expect(keys.sort()).toEqual(['key-a', 'key-b', 'key-c']);
  });

  it('returns empty array when no keys stored', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    const keys = await keychain.listKeys({ keychainPath });
    expect(keys).toEqual([]);
  });
});

// ===========================================================================
// providerKeychainKey
// ===========================================================================

describe('providerKeychainKey', () => {
  it('builds correct key format', () => {
    expect(keychain.providerKeychainKey('openai')).toBe('provider:openai:api_key');
    expect(keychain.providerKeychainKey('anthropic')).toBe('provider:anthropic:api_key');
    expect(keychain.providerKeychainKey('default')).toBe('provider:default:api_key');
  });
});

// ===========================================================================
// redactApiKey
// ===========================================================================

describe('redactApiKey', () => {
  it('masks a typical API key showing last 4 chars', () => {
    const result = keychain.redactApiKey('sk-abc123def456');
    expect(result).toBe('sk-...f456');
  });

  it('masks short keys entirely', () => {
    expect(keychain.redactApiKey('short')).toBe('****');
    expect(keychain.redactApiKey('1234')).toBe('****');
    expect(keychain.redactApiKey('')).toBe('');
  });

  it('preserves 3-char prefix and 4-char suffix', () => {
    const result = keychain.redactApiKey('abcdefghijklmnopqrstuvwxyz');
    expect(result).toBe('abc...wxyz');
  });

  it('handles keys exactly 8 chars', () => {
    expect(keychain.redactApiKey('12345678')).toBe('****');
  });

  it('handles keys 9 chars (minimum to show prefix+suffix)', () => {
    const result = keychain.redactApiKey('123456789');
    expect(result).toBe('123...6789');
  });
});

// ===========================================================================
// redactSensitiveStrings
// ===========================================================================

describe('redactSensitiveStrings', () => {
  it('masks sk-... API keys in text', () => {
    const text = 'Using key sk-abc123def456ghi789 for API call';
    const result = keychain.redactSensitiveStrings(text);
    expect(result).not.toContain('sk-abc123def456ghi789');
    expect(result).toContain('sk-...i789');
  });

  it('masks Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const result = keychain.redactSensitiveStrings(text);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature');
    expect(result).toContain('Bearer');
  });

  it('masks api_key= values', () => {
    const text = 'api_key=sk-longsecretkey123456789';
    const result = keychain.redactSensitiveStrings(text);
    expect(result).not.toContain('sk-longsecretkey123456789');
  });

  it('masks api_key: values', () => {
    const text = 'api_key: "sk-longsecretkey123456789"';
    const result = keychain.redactSensitiveStrings(text);
    expect(result).not.toContain('sk-longsecretkey123456789');
  });

  it('leaves non-sensitive text unchanged', () => {
    const text = 'Hello world, no secrets here.';
    expect(keychain.redactSensitiveStrings(text)).toBe(text);
  });

  it('handles multiple keys in one string', () => {
    const text = 'Key1: sk-aaaa1111bbbb2222 Key2: sk-cccc3333dddd4444';
    const result = keychain.redactSensitiveStrings(text);
    expect(result).not.toContain('sk-aaaa1111bbbb2222');
    expect(result).not.toContain('sk-cccc3333dddd4444');
  });
});

// ===========================================================================
// redactConfig
// ===========================================================================

describe('redactConfig', () => {
  it('redacts api_key fields in providers', () => {
    const config = {
      default_model: 'test/model',
      providers: {
        openai: {
          base_url: 'https://api.openai.com/v1',
          api_key: 'sk-abc123def456ghi789',
          models: { 'gpt-4o': {} },
        },
        anthropic: {
          base_url: 'https://api.anthropic.com',
          api_key: 'sk-ant-xyz987654321',
          models: { 'claude-3': {} },
        },
      },
    };

    const result = keychain.redactConfig(config) as Record<string, unknown>;

    // Non-provider fields unchanged
    expect(result['default_model']).toBe('test/model');

    // API keys are redacted
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['openai']!['api_key']).toBe('sk-...i789');
    expect(providers['anthropic']!['api_key']).toBe('sk-...4321');

    // Other provider fields untouched
    expect(providers['openai']!['base_url']).toBe('https://api.openai.com/v1');
    expect(providers['openai']!['models']).toEqual({ 'gpt-4o': {} });
  });

  it('leaves api_key_env untouched', () => {
    const config = {
      providers: {
        test: {
          api_key_env: 'MY_API_KEY',
        },
      },
    };

    const result = keychain.redactConfig(config) as Record<string, unknown>;
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['test']!['api_key_env']).toBe('MY_API_KEY');
  });

  it('handles missing providers gracefully', () => {
    const config = { default_model: 'test' };
    const result = keychain.redactConfig(config);
    expect(result).toEqual(config);
  });

  it('handles non-object providers gracefully', () => {
    const config = { providers: 'not-an-object' };
    const result = keychain.redactConfig(config);
    expect(result).toEqual(config);
  });

  it('returns a deep clone (does not mutate original)', () => {
    const config = {
      providers: {
        test: { api_key: 'sk-secret123456' },
      },
    };

    const result = keychain.redactConfig(config);
    const origProviders = config['providers'] as Record<string, Record<string, unknown>>;
    const resultProviders = (result as Record<string, unknown>)['providers'] as Record<
      string,
      Record<string, unknown>
    >;

    // Original unchanged
    expect(origProviders['test']!['api_key']).toBe('sk-secret123456');
    // Result redacted
    expect(resultProviders['test']!['api_key']).not.toBe('sk-secret123456');
  });
});

// ===========================================================================
// injectKeychainKeys
// ===========================================================================

describe('injectKeychainKeys', () => {
  it('injects stored API keys into provider entries', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    // Store a key
    await keychain.encryptAndStore(
      keychain.providerKeychainKey('openai'),
      'sk-real-key-123456789',
      { keychainPath },
    );

    // Config without api_key
    const config = {
      providers: {
        openai: { base_url: 'https://api.openai.com/v1' },
      },
    };

    const result = await keychain.injectKeychainKeys(config, { keychainPath });
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['openai']!['api_key']).toBe('sk-real-key-123456789');
    expect(providers['openai']!['base_url']).toBe('https://api.openai.com/v1');
  });

  it('does not overwrite literal api_key', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    // Store a key
    await keychain.encryptAndStore(
      keychain.providerKeychainKey('openai'),
      'sk-stored-key',
      { keychainPath },
    );

    // Config WITH a literal api_key
    const config = {
      providers: {
        openai: { api_key: 'sk-literal-key' },
      },
    };

    const result = await keychain.injectKeychainKeys(config, { keychainPath });
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    // Literal key takes precedence
    expect(providers['openai']!['api_key']).toBe('sk-literal-key');
  });

  it('leaves providers without keychain entries unchanged', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    const config = {
      providers: {
        ollama: { base_url: 'http://localhost:11434' },
      },
    };

    const result = await keychain.injectKeychainKeys(config, { keychainPath });
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['ollama']!['api_key']).toBeUndefined();
    expect(providers['ollama']!['base_url']).toBe('http://localhost:11434');
  });

  it('handles config without providers', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    const config = { default_model: 'test/model' };
    const result = await keychain.injectKeychainKeys(config, { keychainPath });
    expect(result).toEqual(config);
  });

  it('handles non-object providers gracefully', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    const config = { providers: 'not-an-object' };
    const result = await keychain.injectKeychainKeys(config, { keychainPath });
    expect(result).toEqual(config);
  });

  it('preserves explicit empty string api_key instead of injecting from keychain (P2-6)', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    // Store a key in the keychain
    await keychain.encryptAndStore(
      keychain.providerKeychainKey('openai'),
      'sk-stored-key',
      { keychainPath },
    );

    // Config with explicit empty string api_key
    const config = {
      providers: {
        openai: { api_key: '' },
      },
    };

    const result = await keychain.injectKeychainKeys(config, { keychainPath });
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    // Empty string should be preserved, not overwritten from keychain
    expect(providers['openai']!['api_key']).toBe('');
  });
});

// ===========================================================================
// Concurrent writes (P1-14 — RMW must not drop keys)
// ===========================================================================

describe('concurrent keychain writes', () => {
  it('preserves all keys when encryptAndStore runs concurrently', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    // Yield between read and write so overlapping RMW would race without a lock.
    keychain._setTestReadWriteBarrier(
      () => new Promise((resolve) => setImmediate(resolve)),
    );

    const count = 20;
    const keys = Array.from({ length: count }, (_, i) => `provider:p${i}:api_key`);

    await Promise.all(
      keys.map((key, i) =>
        keychain.encryptAndStore(key, `secret-value-${i}`, { keychainPath }),
      ),
    );

    const stored = await keychain.listKeys({ keychainPath });
    expect(stored.sort()).toEqual([...keys].sort());

    for (let i = 0; i < count; i++) {
      const value = await keychain.retrieveAndDecrypt(keys[i]!, { keychainPath });
      expect(value).toBe(`secret-value-${i}`);
    }
  });

  it('serializes concurrent encryptAndStore and deleteKey without losing siblings', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('keep-a', 'a', { keychainPath });
    await keychain.encryptAndStore('to-delete', 'x', { keychainPath });
    await keychain.encryptAndStore('keep-b', 'b', { keychainPath });

    keychain._setTestReadWriteBarrier(
      () => new Promise((resolve) => setImmediate(resolve)),
    );

    await Promise.all([
      keychain.encryptAndStore('keep-c', 'c', { keychainPath }),
      keychain.deleteKey('to-delete', { keychainPath }),
      keychain.encryptAndStore('keep-d', 'd', { keychainPath }),
    ]);

    const stored = (await keychain.listKeys({ keychainPath })).sort();
    expect(stored).toEqual(['keep-a', 'keep-b', 'keep-c', 'keep-d']);
    expect(await keychain.retrieveAndDecrypt('to-delete', { keychainPath })).toBeNull();
    expect(await keychain.retrieveAndDecrypt('keep-c', { keychainPath })).toBe('c');
    expect(await keychain.retrieveAndDecrypt('keep-d', { keychainPath })).toBe('d');
  });

  it('last concurrent write to the same key wins', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    keychain._setTestReadWriteBarrier(
      () => new Promise((resolve) => setImmediate(resolve)),
    );

    // Fire many overwrites of the same key; all must complete and final value
    // must be one of the written values (not corrupted / lost).
    const values = Array.from({ length: 10 }, (_, i) => `value-${i}`);
    await Promise.all(
      values.map((v) => keychain.encryptAndStore('same-key', v, { keychainPath })),
    );

    const result = await keychain.retrieveAndDecrypt('same-key', { keychainPath });
    expect(values).toContain(result);
    const keys = await keychain.listKeys({ keychainPath });
    expect(keys).toEqual(['same-key']);
  });
});

// ===========================================================================
// Keychain file persistence
// ===========================================================================

describe('keychain file persistence', () => {
  it('creates keychain.json with correct permissions', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('test', 'value', { keychainPath });

    expect(fs.existsSync(keychainPath)).toBe(true);

    const stat = fs.statSync(keychainPath);
    // File should be chmod 600 (owner read/write only)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates .orchid directory with correct permissions', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('test', 'value', { keychainPath });

    const orchidDir = path.dirname(keychainPath);
    expect(fs.existsSync(orchidDir)).toBe(true);

    const stat = fs.statSync(orchidDir);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('stores encrypted flag in file', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    await keychain.encryptAndStore('test', 'value', { keychainPath });

    const content = JSON.parse(fs.readFileSync(keychainPath, 'utf-8'));
    expect(content.encrypted).toBe(true);
  });

  it('does not create a plaintext fallback file', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(keychain.encryptAndStore('test', 'value', { keychainPath })).rejects.toThrow();
    expect(fs.existsSync(keychainPath)).toBe(false);
  });
});
