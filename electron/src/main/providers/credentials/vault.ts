import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { HOME_CONFIG_DIR, atomicWriteJson } from '../../config/loader';
import { environmentVariableSchema } from '../../../shared/types/provider';

export const PROVIDER_CREDENTIALS_PATH = path.join(HOME_CONFIG_DIR, 'credentials.json');

const timestampSchema = z.string().datetime({ offset: true });
const storedAuthMethodSchema = z.enum(['api-key', 'oauth']);

const credentialBindingInputSchema = z.object({
  connectionId: z.string().uuid(),
  driverId: z.string().trim().min(1),
  authMethod: storedAuthMethodSchema,
  origin: z.string().nullable(),
}).strict();

const credentialBindingSchema = z.object({
  connectionId: z.string().uuid(),
  driverId: z.string().trim().min(1),
  authMethod: storedAuthMethodSchema,
  origin: z.string().url().nullable(),
}).strict();

const apiKeySecretSchema = z.object({
  kind: z.literal('api-key'),
  apiKey: z.string().min(1),
}).strict();

const oauthSecretSchema = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: timestampSchema,
  tokenType: z.string().min(1),
}).strict();

const credentialSecretSchema = z.discriminatedUnion('kind', [
  apiKeySecretSchema,
  oauthSecretSchema,
]);

const credentialRecordSchema = z.object({
  handle: z.string().uuid(),
  generation: z.number().int().positive(),
  binding: credentialBindingSchema,
  encryptedPayload: z.string().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const credentialDocumentSchema = z.object({
  version: z.literal(1),
  entries: z.array(credentialRecordSchema),
}).strict().superRefine((document, ctx) => {
  const handles = new Set<string>();
  document.entries.forEach((entry, index) => {
    if (handles.has(entry.handle)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate credential handle '${entry.handle}'`,
        path: ['entries', index, 'handle'],
      });
    }
    handles.add(entry.handle);
  });
});

type CredentialRecord = z.infer<typeof credentialRecordSchema>;
type CredentialDocument = z.infer<typeof credentialDocumentSchema>;

export type CredentialBinding = z.infer<typeof credentialBindingSchema>;
export type ApiKeySecret = z.infer<typeof apiKeySecretSchema>;
export type OAuthTokens = Omit<z.infer<typeof oauthSecretSchema>, 'kind'>;
export type CredentialSecret = z.infer<typeof credentialSecretSchema>;

export interface CredentialMetadata {
  readonly handle: string;
  readonly generation: number;
  readonly connectionId: string;
  readonly driverId: string;
  readonly authMethod: CredentialBinding['authMethod'];
  readonly origin: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?: () => string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type SecureStorageAvailability =
  | { readonly available: true; readonly backend: string | null }
  | { readonly available: false; readonly reason: 'unavailable' | 'basic_text' | 'error' };

export class SecureStorageUnavailableError extends Error {
  constructor(readonly availability: Exclude<SecureStorageAvailability, { available: true }>) {
    super(
      availability.reason === 'basic_text'
        ? 'Secure credential storage is unavailable because Electron selected Linux basic_text storage.'
        : 'Secure credential storage is unavailable on this device.',
    );
    this.name = 'SecureStorageUnavailableError';
  }
}

export class CredentialBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialBindingError';
  }
}

export class CredentialVaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialVaultError';
  }
}

export interface CredentialVaultOptions {
  readonly credentialsPath?: string;
  readonly safeStorage?: SecureStorageAdapter;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

const vaultWriteChains = new Map<string, Promise<void>>();

function withVaultWriteLock<T>(filePath: string, task: () => T | Promise<T>): Promise<T> {
  const previous = vaultWriteChains.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  vaultWriteChains.set(filePath, chain);
  chain.then(
    () => {
      if (vaultWriteChains.get(filePath) === chain) vaultWriteChains.delete(filePath);
    },
    () => {
      if (vaultWriteChains.get(filePath) === chain) vaultWriteChains.delete(filePath);
    },
  );
  return run;
}

/** @internal Test-only cleanup for temporary vault paths. */
export function _clearCredentialVaultWriteChains(): void {
  vaultWriteChains.clear();
}

export function getSecureStorageAvailability(
  storage: SecureStorageAdapter = safeStorage,
): SecureStorageAvailability {
  try {
    if (!storage.isEncryptionAvailable()) return { available: false, reason: 'unavailable' };
    const backend = storage.getSelectedStorageBackend?.() ?? null;
    if (backend === 'basic_text') return { available: false, reason: 'basic_text' };
    return { available: true, backend };
  } catch {
    return { available: false, reason: 'error' };
  }
}

/**
 * Normalize the destination that a stored secret is allowed to authenticate.
 * Path changes do not rebind a generic credential; origin changes do.
 */
export function normalizeCredentialBinding(input: {
  readonly connectionId: string;
  readonly driverId: string;
  readonly authMethod: 'api-key' | 'oauth';
  readonly origin: string | null;
}): CredentialBinding {
  const parsed = credentialBindingInputSchema.parse(input);
  if (parsed.origin === null) return credentialBindingSchema.parse(parsed);
  let url: URL;
  try {
    url = new URL(parsed.origin);
  } catch (error) {
    throw new CredentialBindingError(`Credential origin is invalid: ${String(error)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new CredentialBindingError('Credential origin must be a credential-free http(s) URL');
  }
  return credentialBindingSchema.parse({ ...parsed, origin: url.origin });
}

export function createEnvironmentCredentialReference(variable: string): {
  readonly kind: 'environment';
  readonly variable: string;
} {
  try {
    return { kind: 'environment', variable: environmentVariableSchema.parse(variable) };
  } catch (error) {
    throw new CredentialVaultError('Invalid environment credential reference', { cause: error });
  }
}

function emptyDocument(): CredentialDocument {
  return { version: 1, entries: [] };
}

function readDocument(filePath: string): CredentialDocument {
  if (!fs.existsSync(filePath)) return emptyDocument();
  try {
    return credentialDocumentSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    throw new CredentialVaultError('Credential vault is invalid and was not loaded', { cause: error });
  }
}

function metadata(record: CredentialRecord): CredentialMetadata {
  return {
    handle: record.handle,
    generation: record.generation,
    connectionId: record.binding.connectionId,
    driverId: record.binding.driverId,
    authMethod: record.binding.authMethod,
    origin: record.binding.origin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function sameBinding(left: CredentialBinding, right: CredentialBinding): boolean {
  return left.connectionId === right.connectionId
    && left.driverId === right.driverId
    && left.authMethod === right.authMethod
    && left.origin === right.origin;
}

/**
 * Main-process-only encrypted credential vault. Connection metadata contains
 * only the opaque handle returned by this class; no renderer DTO receives a
 * `CredentialSecret` or encrypted payload.
 */
export class CredentialVault {
  private readonly credentialsPath: string;
  private readonly storage: SecureStorageAdapter;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: CredentialVaultOptions = {}) {
    this.credentialsPath = options.credentialsPath ?? PROVIDER_CREDENTIALS_PATH;
    this.storage = options.safeStorage ?? safeStorage;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  getAvailability(): SecureStorageAvailability {
    return getSecureStorageAvailability(this.storage);
  }

  async storeApiKey(bindingInput: CredentialBinding, apiKey: string): Promise<string> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new CredentialVaultError('API key must not be empty');
    return this.storeSecret(bindingInput, { kind: 'api-key', apiKey: trimmed });
  }

  /**
   * Atomically replace every stored credential generation for one connection.
   *
   * This is used by the one-shot IPC API-key flow. It prevents a reconnect
   * from leaving a stale usable key on disk while retaining the all-or-nothing
   * write property: encryption happens before the credential document changes.
   */
  async replaceConnectionApiKey(bindingInput: CredentialBinding, apiKey: string): Promise<string> {
    const binding = normalizeCredentialBinding(bindingInput);
    const trimmed = apiKey.trim();
    if (!trimmed) throw new CredentialVaultError('API key must not be empty');
    if (binding.authMethod !== 'api-key') {
      throw new CredentialBindingError('Only API-key bindings can replace an API key');
    }
    this.assertSecureStorage();
    const encryptedPayload = this.encryptSecret({ kind: 'api-key', apiKey: trimmed });
    return withVaultWriteLock(this.credentialsPath, () => {
      const document = readDocument(this.credentialsPath);
      const now = this.now().toISOString();
      const record = credentialRecordSchema.parse({
        handle: this.idFactory(),
        generation: 1,
        binding,
        encryptedPayload,
        createdAt: now,
        updatedAt: now,
      });
      if (document.entries.some((entry) => entry.handle === record.handle)) {
        throw new CredentialVaultError(`Duplicate credential handle '${record.handle}'`);
      }
      const retained = document.entries.filter(
        (entry) => entry.binding.connectionId !== binding.connectionId,
      );
      atomicWriteJson(this.credentialsPath, {
        version: 1,
        entries: [...retained, record],
      });
      return record.handle;
    });
  }

  async storeOAuthTokens(bindingInput: CredentialBinding, tokens: OAuthTokens): Promise<string> {
    return this.storeSecret(bindingInput, {
      kind: 'oauth',
      ...oauthSecretSchema.omit({ kind: true }).parse(tokens),
    });
  }

  async readSecret(handle: string, bindingInput: CredentialBinding): Promise<CredentialSecret> {
    const binding = normalizeCredentialBinding(bindingInput);
    const record = readDocument(this.credentialsPath).entries.find((entry) => entry.handle === handle);
    if (!record) throw new CredentialVaultError(`Unknown credential handle '${handle}'`);
    this.assertBinding(record, binding);
    return this.decryptRecord(record);
  }

  async getMetadata(handle: string): Promise<CredentialMetadata> {
    const record = readDocument(this.credentialsPath).entries.find((entry) => entry.handle === handle);
    if (!record) throw new CredentialVaultError(`Unknown credential handle '${handle}'`);
    return metadata(record);
  }

  async listMetadata(connectionId?: string): Promise<readonly CredentialMetadata[]> {
    return readDocument(this.credentialsPath).entries
      .filter((entry) => connectionId === undefined || entry.binding.connectionId === connectionId)
      .map(metadata);
  }

  async rotateOAuthTokens(
    handle: string,
    bindingInput: CredentialBinding,
    tokens: OAuthTokens,
  ): Promise<CredentialMetadata> {
    const binding = normalizeCredentialBinding(bindingInput);
    const secret: CredentialSecret = {
      kind: 'oauth',
      ...oauthSecretSchema.omit({ kind: true }).parse(tokens),
    };
    this.assertSecureStorage();
    return withVaultWriteLock(this.credentialsPath, () => {
      const document = readDocument(this.credentialsPath);
      const index = document.entries.findIndex((entry) => entry.handle === handle);
      if (index === -1) throw new CredentialVaultError(`Unknown credential handle '${handle}'`);
      const existing = document.entries[index]!;
      this.assertBinding(existing, binding);
      if (existing.binding.authMethod !== 'oauth') {
        throw new CredentialBindingError('Only OAuth credentials can rotate OAuth tokens');
      }
      const updated: CredentialRecord = {
        ...existing,
        generation: existing.generation + 1,
        encryptedPayload: this.encryptSecret(secret),
        updatedAt: this.now().toISOString(),
      };
      const entries = [...document.entries];
      entries[index] = updated;
      atomicWriteJson(this.credentialsPath, { version: 1, entries });
      return metadata(updated);
    });
  }

  async deleteConnectionCredentials(connectionId: string): Promise<number> {
    return withVaultWriteLock(this.credentialsPath, () => {
      const document = readDocument(this.credentialsPath);
      const entries = document.entries.filter((entry) => entry.binding.connectionId !== connectionId);
      const deleted = document.entries.length - entries.length;
      if (deleted > 0) atomicWriteJson(this.credentialsPath, { version: 1, entries });
      return deleted;
    });
  }

  private async storeSecret(
    bindingInput: CredentialBinding,
    secret: CredentialSecret,
  ): Promise<string> {
    const binding = normalizeCredentialBinding(bindingInput);
    const parsedSecret = credentialSecretSchema.parse(secret);
    if (binding.authMethod !== parsedSecret.kind) {
      throw new CredentialBindingError(
        `Credential auth method '${binding.authMethod}' cannot store '${parsedSecret.kind}' secret`,
      );
    }
    this.assertSecureStorage();
    return withVaultWriteLock(this.credentialsPath, () => {
      const document = readDocument(this.credentialsPath);
      const now = this.now().toISOString();
      const record = credentialRecordSchema.parse({
        handle: this.idFactory(),
        generation: 1,
        binding,
        encryptedPayload: this.encryptSecret(parsedSecret),
        createdAt: now,
        updatedAt: now,
      });
      if (document.entries.some((entry) => entry.handle === record.handle)) {
        throw new CredentialVaultError(`Duplicate credential handle '${record.handle}'`);
      }
      atomicWriteJson(this.credentialsPath, {
        version: 1,
        entries: [...document.entries, record],
      });
      return record.handle;
    });
  }

  private assertSecureStorage(): void {
    const availability = this.getAvailability();
    if (!availability.available) throw new SecureStorageUnavailableError(availability);
  }

  private assertBinding(record: CredentialRecord, expected: CredentialBinding): void {
    if (!sameBinding(record.binding, expected)) {
      throw new CredentialBindingError('Credential handle binding does not match this connection or destination');
    }
  }

  private encryptSecret(secret: CredentialSecret): string {
    try {
      return this.storage.encryptString(JSON.stringify(secret)).toString('base64');
    } catch (error) {
      throw new CredentialVaultError('Failed to encrypt credential secret', { cause: error });
    }
  }

  private decryptRecord(record: CredentialRecord): CredentialSecret {
    this.assertSecureStorage();
    try {
      return credentialSecretSchema.parse(
        JSON.parse(this.storage.decryptString(Buffer.from(record.encryptedPayload, 'base64'))),
      );
    } catch (error) {
      throw new CredentialVaultError('Failed to decrypt credential secret', { cause: error });
    }
  }
}
