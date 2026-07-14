import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createProviderConnectionSchema,
  providerConnectionDocumentSchema,
  providerConnectionSchema,
  updateProviderConnectionSchema,
  type CreateProviderConnectionInput,
  type ProviderConnection,
  type ProviderConnectionDocument,
  type UpdateProviderConnectionInput,
} from '../../shared/types/provider';
import { HOME_CONFIG_DIR, atomicWriteJson } from '../config/loader';

export const PROVIDER_CONNECTIONS_PATH = path.join(HOME_CONFIG_DIR, 'providers.json');

export interface ConnectionStoreOptions {
  readonly providersPath?: string;
  readonly idFactory?: () => string;
  /** Test seam for forcing an asynchronous read-modify-write race. */
  readonly beforePersist?: () => Promise<void>;
}

const writeChains = new Map<string, Promise<void>>();

function withWriteLock<T>(filePath: string, task: () => T | Promise<T>): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(filePath, chain);
  chain.then(() => {
    if (writeChains.get(filePath) === chain) writeChains.delete(filePath);
  });
  return run;
}

/** @internal Test-only reset for isolated temporary stores. */
export function _clearConnectionStoreWriteChains(): void {
  writeChains.clear();
}

function emptyDocument(): ProviderConnectionDocument {
  return { version: 1, connections: [] };
}

function readDocument(filePath: string): ProviderConnectionDocument {
  if (!fs.existsSync(filePath)) return emptyDocument();
  try {
    return providerConnectionDocumentSchema.parse(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
    );
  } catch (error) {
    throw new Error(`Provider connection store is invalid: ${String(error)}`, {
      cause: error,
    });
  }
}

/**
 * Atomic, serialized storage for user-owned provider connection metadata.
 * Credentials are referenced only by opaque handles or environment variable names.
 */
export class ConnectionStore {
  private readonly filePath: string;
  private readonly idFactory: () => string;
  private readonly beforePersist: (() => Promise<void>) | undefined;

  constructor(options: ConnectionStoreOptions = {}) {
    this.filePath = options.providersPath ?? PROVIDER_CONNECTIONS_PATH;
    this.idFactory = options.idFactory ?? randomUUID;
    this.beforePersist = options.beforePersist;
  }

  async list(): Promise<readonly ProviderConnection[]> {
    return readDocument(this.filePath).connections.map((connection) => ({ ...connection }));
  }

  async get(id: string): Promise<ProviderConnection | null> {
    const connection = readDocument(this.filePath).connections.find((item) => item.id === id);
    return connection ? { ...connection } : null;
  }

  async create(input: CreateProviderConnectionInput): Promise<ProviderConnection> {
    const parsed = createProviderConnectionSchema.parse(input);
    return withWriteLock(this.filePath, async () => {
      const document = readDocument(this.filePath);
      const connection = providerConnectionSchema.parse({ ...parsed, id: this.idFactory() });
      if (document.connections.some((item) => item.id === connection.id)) {
        throw new Error(`Duplicate provider connection id '${connection.id}'`);
      }
      await this.beforePersist?.();
      atomicWriteJson(this.filePath, {
        version: 1,
        connections: [...document.connections, connection],
      });
      return connection;
    });
  }

  async update(id: string, patch: UpdateProviderConnectionInput): Promise<ProviderConnection> {
    const parsedPatch = updateProviderConnectionSchema.parse(patch);
    return withWriteLock(this.filePath, async () => {
      const document = readDocument(this.filePath);
      const index = document.connections.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`Unknown provider connection '${id}'`);
      const updated = providerConnectionSchema.parse({
        ...document.connections[index],
        ...parsedPatch,
        id,
      });
      const connections = [...document.connections];
      connections[index] = updated;
      await this.beforePersist?.();
      atomicWriteJson(this.filePath, { version: 1, connections });
      return updated;
    });
  }

}
