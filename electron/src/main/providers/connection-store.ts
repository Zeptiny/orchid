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
import {
  withSerializedWrite,
  _clearSerializedWriteChains,
} from '../utils/write-lock';

export const PROVIDER_CONNECTIONS_PATH = path.join(HOME_CONFIG_DIR, 'providers.json');

/** Paths that have used connection-store serialization (for scoped test resets). */
const connectionStorePaths = new Set<string>([PROVIDER_CONNECTIONS_PATH]);

export interface ConnectionStoreOptions {
  readonly providersPath?: string;
  readonly idFactory?: () => string;
  /** Test seam for forcing an asynchronous read-modify-write race. */
  readonly beforePersist?: () => Promise<void>;
}

/** @internal Test-only reset for connection-store paths only. */
export function _clearConnectionStoreWriteChains(): void {
  _clearSerializedWriteChains([...connectionStorePaths]);
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
    connectionStorePaths.add(this.filePath);
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
    return withSerializedWrite(this.filePath, async () => {
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
    return withSerializedWrite(this.filePath, async () => {
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
