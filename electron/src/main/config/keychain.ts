/**
 * OS Keychain Integration — U25.
 *
 * Encrypts API keys using Electron's `safeStorage` and stores them as base64
 * in `~/.orchid/keychain.json`. Falls back to plaintext with a console warning
 * when encryption is unavailable (e.g. Linux without libsecret).
 *
 * **Threat model:** This module protects API keys at rest. Session files and
 * tool-output cache store sensitive data (conversation history, file contents,
 * command outputs) as plaintext, protected only by filesystem permissions
 * (chmod 600). On a shared or compromised machine, any process running as the
 * same user can read all session content. Encrypting session files at rest is
 * deferred to a future iteration.
 *
 * Storage format (`~/.orchid/keychain.json`):
 * ```json
 * {
 *   "encrypted": true,
 *   "entries": {
 *     "provider:openai:api_key": "base64-encoded-ciphertext"
 *   }
 * }
 * ```
 *
 * Fallback (plaintext) format:
 * ```json
 * {
 *   "encrypted": false,
 *   "entries": {
 *     "provider:openai:api_key": "sk-abc123..."
 *   }
 * }
 * ```
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeStorage } from 'electron';

// ---------------------------------------------------------------------------
// Paths — computed lazily so tests can override via options
// ---------------------------------------------------------------------------

export const KEYCHAIN_DIR = path.join(os.homedir(), '.orchid');
export const KEYCHAIN_PATH = path.join(KEYCHAIN_DIR, 'keychain.json');

// ---------------------------------------------------------------------------
// Options (testable without touching real home dir)
// ---------------------------------------------------------------------------

export interface KeychainOptions {
  /** Override path to keychain file. Defaults to `~/.orchid/keychain.json`. */
  keychainPath?: string;
}

function resolvePaths(options?: KeychainOptions) {
  const filePath = options?.keychainPath ?? KEYCHAIN_PATH;
  const dirPath = path.dirname(filePath);
  return { filePath, dirPath };
}

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

interface KeychainFile {
  /** Whether entries are encrypted (true) or stored as plaintext fallback (false). */
  encrypted: boolean;
  /** Map of key -> base64 ciphertext (encrypted) or plaintext (fallback). */
  entries: Record<string, string>;
}

// ---------------------------------------------------------------------------
// File I/O (sync — keychain reads are blocking, matching Electron startup)
// ---------------------------------------------------------------------------

/**
 * Per-path write chain so concurrent read-modify-write operations serialize.
 * Without this, overlapping encryptAndStore/deleteKey calls can each read the
 * same snapshot and the last writer drops the others' keys (P1-14).
 */
const keychainWriteChains = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusively for `filePath`, after any prior write on that path.
 * Errors from previous operations do not block subsequent ones.
 *
 * After the chain settles, the entry is cleaned up if no newer writes have
 * been queued for the same path (P3-12 — unbounded map growth).
 */
function withKeychainWriteLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = keychainWriteChains.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  keychainWriteChains.set(filePath, chain);
  // Clean up map entry once this chain settles, but only if no newer write
  // has replaced it. This prevents unbounded growth from temp paths (P3-12).
  chain.finally(() => {
    if (keychainWriteChains.get(filePath) === chain) {
      keychainWriteChains.delete(filePath);
    }
  });
  return run;
}

/**
 * Clear all pending write chains. For test cleanup only.
 * @internal
 */
export function _clearKeychainWriteChains(): void {
  keychainWriteChains.clear();
}

/**
 * Whether we are in a non-production environment where test barriers are safe.
 * Checked at call-time (not module-load) so the env var can be set dynamically
 * by test runners like Vitest.
 */
function isTestEnv(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Test-only barrier invoked between keychain read and write inside the lock.
 * Used to force a yield so concurrent RMW races are observable without a lock.
 */
let testReadWriteBarrier: (() => Promise<void>) | undefined;

/**
 * Install (or clear) a test-only async barrier between keychain read and write.
 * No-ops in production to prevent test infrastructure from leaking into
 * production bundles (P1-2).
 * @internal
 */
export function _setTestReadWriteBarrier(
  fn: (() => Promise<void>) | undefined,
): void {
  if (!isTestEnv()) return;
  testReadWriteBarrier = fn;
}

function readKeychainFile(filePath: string): KeychainFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as KeychainFile;
    if (typeof parsed !== 'object' || parsed === null) {
      return { encrypted: true, entries: {} };
    }
    return {
      encrypted: parsed.encrypted ?? true,
      entries: (typeof parsed.entries === 'object' && parsed.entries !== null)
        ? parsed.entries
        : {},
    };
  } catch {
    return { encrypted: true, entries: {} };
  }
}

function writeKeychainFile(filePath: string, dirPath: string, data: KeychainFile): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.chmodSync(dirPath, 0o700);

  const tmp = filePath + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      const json = JSON.stringify(data, null, 2);
      fs.writeSync(fd, json, undefined, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);

    // fsync parent dir to persist the rename
    const dirFd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

/**
 * Check whether `safeStorage` encryption is available on this platform.
 *
 * - macOS: always available (uses Keychain)
 * - Windows: always available (uses DPAPI)
 * - Linux: available only when a secrets service (libsecret / kwallet) is running
 */
export function isAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Whether we've already emitted the plaintext-fallback warning. */
let plaintextWarningEmitted = false;

function emitPlaintextWarning(): void {
  if (!plaintextWarningEmitted) {
    console.warn(
      '[keychain] safeStorage encryption is unavailable (Linux without libsecret?). ' +
        'API keys will be stored as plaintext in ~/.orchid/keychain.json. ' +
        'Install libsecret or gnome-keyring for OS-level encryption.',
    );
    plaintextWarningEmitted = true;
  }
}

/**
 * Reset the plaintext-warning flag. Used in tests to verify warning emission.
 */
export function _resetWarningFlag(): void {
  plaintextWarningEmitted = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a value and store it under the given key.
 *
 * Uses `safeStorage.encryptString()` when available; falls back to plaintext
 * storage with a console warning.
 *
 * @param key  Storage key (e.g. `"provider:openai:api_key"`).
 * @param value  The plaintext value to encrypt and store.
 * @param options  Optional path overrides for testing.
 */
export async function encryptAndStore(
  key: string,
  value: string,
  options?: KeychainOptions,
): Promise<void> {
  const { filePath, dirPath } = resolvePaths(options);

  await withKeychainWriteLock(filePath, async () => {
    const file = readKeychainFile(filePath);

    if (isAvailable()) {
      const encrypted = safeStorage.encryptString(value);
      file.entries[key] = encrypted.toString('base64');
      file.encrypted = true;
    } else {
      emitPlaintextWarning();
      file.entries[key] = value;
      file.encrypted = false;
    }

    // Optional test barrier (yields so concurrent RMW without a lock races)
    // Only active outside production to prevent test infrastructure from
    // affecting real keychain writes (P1-2).
    if (testReadWriteBarrier && isTestEnv()) {
      await testReadWriteBarrier();
    }

    writeKeychainFile(filePath, dirPath, file);
  });
}

/**
 * Retrieve and decrypt a stored value.
 *
 * Returns `null` if the key does not exist.
 *
 * @param key  Storage key (e.g. `"provider:openai:api_key"`).
 * @param options  Optional path overrides for testing.
 * @returns The decrypted plaintext value, or `null` if not found.
 */
export async function retrieveAndDecrypt(
  key: string,
  options?: KeychainOptions,
): Promise<string | null> {
  const { filePath } = resolvePaths(options);
  const file = readKeychainFile(filePath);
  const stored = file.entries[key];
  if (stored === undefined) return null;

  if (file.encrypted) {
    if (!isAvailable()) {
      console.error(
        `[keychain] Cannot decrypt key '${key}' — file was encrypted but safeStorage is unavailable.`,
      );
      return null;
    }
    try {
      const buffer = Buffer.from(stored, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      // If decryption fails (e.g. keychain locked), return null
      console.error(`[keychain] Failed to decrypt key '${key}' — keychain may be locked.`);
      return null;
    }
  }

  // Plaintext fallback — file.encrypted === false, so stored is the raw value.
  return stored;
}

/**
 * Delete a stored key from the keychain.
 *
 * @param key  Storage key to remove.
 * @param options  Optional path overrides for testing.
 */
export async function deleteKey(key: string, options?: KeychainOptions): Promise<void> {
  const { filePath, dirPath } = resolvePaths(options);

  await withKeychainWriteLock(filePath, async () => {
    const file = readKeychainFile(filePath);
    if (!(key in file.entries)) return;

    delete file.entries[key];

    if (testReadWriteBarrier && isTestEnv()) {
      await testReadWriteBarrier();
    }

    writeKeychainFile(filePath, dirPath, file);
  });
}

/**
 * Return all stored keys (without decrypting their values).
 *
 * Useful for listing which providers have stored API keys.
 *
 * @param options  Optional path overrides for testing.
 */
export async function listKeys(options?: KeychainOptions): Promise<string[]> {
  const { filePath } = resolvePaths(options);
  const file = readKeychainFile(filePath);
  return Object.keys(file.entries);
}

/**
 * Build the keychain storage key for a provider's API key.
 *
 * @param providerAlias  The provider alias from config (e.g. `"openai"`).
 * @returns The keychain key (e.g. `"provider:openai:api_key"`).
 */
export function providerKeychainKey(providerAlias: string): string {
  return `provider:${providerAlias}:api_key`;
}

/**
 * For each provider in a config object, check if there's a keychain entry
 * and inject the real API key. Used when loading config for LLM calls.
 *
 * Only injects from keychain if no literal `api_key` is already set on the
 * provider entry (literal keys take precedence).
 *
 * @param config  The config object (will not be mutated).
 * @param options  Optional path overrides for testing.
 * @returns A new config object with keychain keys injected.
 */
export async function injectKeychainKeys(
  config: Record<string, unknown>,
  options?: KeychainOptions,
): Promise<Record<string, unknown>> {
  const providers = config['providers'];
  if (typeof providers !== 'object' || providers === null) return config;

  const result = { ...config };
  const providersCopy: Record<string, unknown> = {};

  for (const [alias, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      providersCopy[alias] = entry;
      continue;
    }

    const entryCopy = { ...(entry as Record<string, unknown>) };

    // Only inject from keychain if no literal api_key is set.
    // Use explicit undefined check so empty string ("") is preserved (P2-6).
    if (entryCopy['api_key'] === undefined) {
      const stored = await retrieveAndDecrypt(providerKeychainKey(alias), options);
      if (stored) {
        entryCopy['api_key'] = stored;
      }
    }

    providersCopy[alias] = entryCopy;
  }

  result['providers'] = providersCopy;
  return result;
}

// ---------------------------------------------------------------------------
// Redaction utilities (shared across config, sessions, UI)
// ---------------------------------------------------------------------------

/**
 * Redact an API key for display — show only the last 4 characters.
 *
 * Example: `"sk-abc123def456"` → `"sk-...f456"`
 *
 * @param key  The API key to redact.
 * @returns The redacted string.
 */
export function redactApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  const prefix = key.slice(0, 3);
  const tail = key.slice(-4);
  return `${prefix}...${tail}`;
}

/**
 * Redact all API key occurrences in an arbitrary string.
 *
 * Scans for common API key patterns and masks them. This is a best-effort
 * heuristic — it won't catch every possible secret format, but covers the
 * most common patterns (OpenAI, Anthropic, bearer tokens, etc.).
 *
 * @param text  The text to scan.
 * @returns The text with API keys masked.
 */
export function redactSensitiveStrings(text: string): string {
  // Pattern 1: sk-... keys (OpenAI, Anthropic, etc.)
  let result = text.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, (match) => redactApiKey(match));

  // Pattern 2: Bearer tokens in headers
  result = result.replace(
    /Bearer\s+[a-zA-Z0-9_\-.]{20,}/gi,
    (match) => {
      const parts = match.split(/\s+/);
      return `${parts[0]} ${redactApiKey(parts[1] ?? '')}`;
    },
  );

  // Pattern 3: api_key=... in URLs or env vars
  result = result.replace(
    /api_key[=:]["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    (match, key: string) => match.replace(key, redactApiKey(key)),
  );

  return result;
}

/**
 * Deep-clone a config object and redact all `api_key` fields in `providers`.
 *
 * Only affects `providers.*.api_key` — leaves `api_key_env` untouched.
 *
 * @param config  The config object to redact.
 * @returns A new config object with API keys masked.
 */
export function redactConfig<T extends Record<string, unknown>>(config: T): T {
  const clone = JSON.parse(JSON.stringify(config)) as T;

  const providers = clone['providers'];
  if (typeof providers !== 'object' || providers === null) return clone;

  for (const [, entry] of Object.entries(providers as Record<string, Record<string, unknown>>)) {
    if (typeof entry === 'object' && entry !== null && typeof entry['api_key'] === 'string') {
      entry['api_key'] = redactApiKey(entry['api_key'] as string);
    }
  }

  return clone;
}
