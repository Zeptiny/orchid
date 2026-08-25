/**
 * Machine password store — encrypted SSH passwords for `password`-auth
 * machines.
 *
 * Secrets live in `~/.orchid/machine-passwords.json`, encrypted through
 * Electron `safeStorage` (same fail-closed posture as the provider credential
 * vault): unavailable/`basic_text` storage refuses every write and every
 * decrypt. The document maps machine id → encrypted password; only booleans
 * about presence (never the secret) cross the IPC boundary.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { HOME_CONFIG_DIR, atomicWriteJson } from '../config/loader';
import {
  withSerializedWrite,
  _clearSerializedWriteChains,
} from '../utils/write-lock';
import { machineIdSchema } from '../../shared/types/machine';

/**
 * Default password-store path. Resolved lazily (HOME_CONFIG_DIR is mockable
 * and can change between tests), so every store construction re-reads it.
 */
export function machinePasswordsPath(): string {
  return path.join(HOME_CONFIG_DIR, 'machine-passwords.json');
}

/** Paths that have used password-store serialization (for scoped test resets). */
const machinePasswordPaths = new Set<string>([machinePasswordsPath()]);

const timestampSchema = z.string().datetime({ offset: true });

const passwordEntrySchema = z
  .object({
    machineId: machineIdSchema,
    encryptedPassword: z.string().min(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const passwordDocumentSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(passwordEntrySchema),
  })
  .strict()
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    document.entries.forEach((entry, index) => {
      if (seen.has(entry.machineId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate machine password entry '${entry.machineId}'`,
          path: ['entries', index, 'machineId'],
        });
      }
      seen.add(entry.machineId);
    });
  });

type PasswordEntry = z.infer<typeof passwordEntrySchema>;
type PasswordDocument = z.infer<typeof passwordDocumentSchema>;

/** Mirrors the provider vault's adapter seam so tests can inject a fake. */
export interface PasswordStorageAdapter {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class MachineSecretsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MachineSecretsError';
  }
}

export class MachinePasswordUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachinePasswordUnavailableError';
  }
}

export interface MachineSecretsOptions {
  readonly filePath?: string;
  readonly storage?: PasswordStorageAdapter;
  readonly now?: () => Date;
}

/** @internal Test-only cleanup for machine-password paths. */
export function _clearMachinePasswordWriteChains(): void {
  _clearSerializedWriteChains([...machinePasswordPaths]);
}

function emptyDocument(): PasswordDocument {
  return { version: 1, entries: [] };
}

function readDocument(filePath: string): PasswordDocument {
  if (!fs.existsSync(filePath)) return emptyDocument();
  try {
    return passwordDocumentSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    throw new MachineSecretsError('Machine password store is invalid and was not loaded', {
      cause: error,
    });
  }
}

function assertStorageAvailable(storage: PasswordStorageAdapter): void {
  let available: boolean;
  let backend: string | null = null;
  try {
    available = storage.isEncryptionAvailable();
    backend = storage.getSelectedStorageBackend?.() ?? null;
  } catch {
    available = false;
  }
  if (!available || backend === 'basic_text') {
    throw new MachinePasswordUnavailableError(
      backend === 'basic_text'
        ? 'Secure password storage is unavailable because Electron selected Linux basic_text storage.'
        : 'Secure password storage is unavailable on this device.',
    );
  }
}

/**
 * Main-process machine password store. One encrypted entry per machine id;
 * callers see only setPassword/getPassword/clear/hasPassword.
 */
export class MachineSecretsStore {
  private readonly filePath: string;
  private readonly storage: PasswordStorageAdapter;
  private readonly now: () => Date;

  constructor(options: MachineSecretsOptions = {}) {
    this.filePath = options.filePath ?? machinePasswordsPath();
    this.storage = options.storage ?? safeStorage;
    this.now = options.now ?? (() => new Date());
    machinePasswordPaths.add(this.filePath);
  }

  /** True when the store holds a password for the machine (no decryption). */
  hasPassword(machineId: string): boolean {
    machineIdSchema.parse(machineId);
    return readDocument(this.filePath).entries.some((entry) => entry.machineId === machineId);
  }

  /** Machine ids that currently have a stored password. */
  storedMachineIds(): string[] {
    return readDocument(this.filePath).entries.map((entry) => entry.machineId);
  }

  /**
   * Decrypt and return the machine's password, or null when none is stored.
   * Throws `MachinePasswordUnavailableError` when storage is unavailable and
   * `MachineSecretsError` when the stored payload cannot be decrypted.
   */
  getPassword(machineId: string): string | null {
    machineIdSchema.parse(machineId);
    const entry = readDocument(this.filePath).entries.find(
      (candidate) => candidate.machineId === machineId,
    );
    if (entry === undefined) return null;
    assertStorageAvailable(this.storage);
    try {
      const decoded = this.storage.decryptString(Buffer.from(entry.encryptedPassword, 'base64'));
      if (decoded === '') throw new Error('empty password');
      return decoded;
    } catch (error) {
      throw new MachineSecretsError(
        `Failed to decrypt the stored password for machine '${machineId}'`,
        { cause: error },
      );
    }
  }

  /** Encrypt and persist the machine's password (replaces any prior one). */
  async setPassword(machineId: string, password: string): Promise<void> {
    machineIdSchema.parse(machineId);
    const trimmed = password;
    if (trimmed === '') throw new MachineSecretsError('Machine password must not be empty');
    assertStorageAvailable(this.storage);
    let encryptedPassword: string;
    try {
      encryptedPassword = this.storage.encryptString(trimmed).toString('base64');
    } catch (error) {
      throw new MachineSecretsError('Failed to encrypt the machine password', { cause: error });
    }
    await withSerializedWrite(this.filePath, () => {
      const document = readDocument(this.filePath);
      const now = this.now().toISOString();
      const existing = document.entries.find((entry) => entry.machineId === machineId);
      const next: PasswordEntry = passwordEntrySchema.parse({
        machineId,
        encryptedPassword,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const entries = document.entries.filter((entry) => entry.machineId !== machineId);
      atomicWriteJson(this.filePath, { version: 1, entries: [...entries, next] });
    });
  }

  /** Drop the machine's stored password; missing entries are a no-op. */
  async clearPassword(machineId: string): Promise<void> {
    machineIdSchema.parse(machineId);
    await withSerializedWrite(this.filePath, () => {
      const document = readDocument(this.filePath);
      const entries = document.entries.filter((entry) => entry.machineId !== machineId);
      if (entries.length !== document.entries.length) {
        atomicWriteJson(this.filePath, { version: 1, entries });
      }
    });
  }
}

let store: MachineSecretsStore | null = null;

/** Process-wide machine password store. */
export function getMachineSecretsStore(): MachineSecretsStore {
  if (store === null) {
    store = new MachineSecretsStore();
  }
  return store;
}

/** Drop the process-wide store so the next call rebuilds it. For tests. */
export function _resetMachineSecretsStoreForTests(): void {
  store = null;
}
