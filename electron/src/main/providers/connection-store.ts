import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createProviderConnectionSchema,
  parseProviderConnectionDocument,
  providerConnectionSchema,
  updateProviderConnectionSchema,
  PROVIDER_CONNECTION_DOCUMENT_VERSION,
  type CreateProviderConnectionInput,
  type ProviderConnection,
  type ProviderConnectionDocument,
  type ReasoningModelConfig,
  type UpdateProviderConnectionInput,
} from '../../shared/types/provider';
import type { CatalogModel } from './catalog/schema';
import { HOME_CONFIG_DIR, atomicWriteJson } from '../config/loader';
import {
  withSerializedWrite,
  _clearSerializedWriteChains,
} from '../utils/write-lock';

export const PROVIDER_CONNECTIONS_PATH = path.join(HOME_CONFIG_DIR, 'providers.json');

/**
 * Populate `reasoningConfig` on a connection from catalog model metadata.
 * Only fills absent entries — never overwrites existing user configuration.
 */
export function seedReasoningConfig(
  connection: Pick<ProviderConnection, 'modelIds' | 'reasoningConfig'>,
  catalogModels: readonly CatalogModel[],
): Record<string, ReasoningModelConfig> | undefined {
  const catalogById = new Map(catalogModels.map((m) => [m.id, m]));
  const existing = connection.reasoningConfig ?? {};
  let seeded = false;
  const result: Record<string, ReasoningModelConfig> = { ...existing };

  for (const modelId of connection.modelIds) {
    if (result[modelId]) continue;
    const catalogModel = catalogById.get(modelId);
    if (!catalogModel) continue;
    if (!catalogModel.capabilities.reasoning) continue;
    if (!catalogModel.reasoningLevels || catalogModel.reasoningLevels.length === 0) continue;

    result[modelId] = {
      levels: [...catalogModel.reasoningLevels],
      default: catalogModel.reasoningDefault ?? null,
    };
    seeded = true;
  }

  if (!seeded && !connection.reasoningConfig) return undefined;
  return result;
}

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
  return { version: PROVIDER_CONNECTION_DOCUMENT_VERSION, connections: [] };
}

function readDocument(filePath: string): ProviderConnectionDocument {
  if (!fs.existsSync(filePath)) return emptyDocument();
  try {
    return parseProviderConnectionDocument(
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

  async create(
    input: CreateProviderConnectionInput,
    catalogModels?: readonly CatalogModel[],
  ): Promise<ProviderConnection> {
    const parsed = createProviderConnectionSchema.parse(input);
    return withSerializedWrite(this.filePath, async () => {
      const document = readDocument(this.filePath);
      let connection = providerConnectionSchema.parse({ ...parsed, id: this.idFactory() });
      if (document.connections.some((item) => item.id === connection.id)) {
        throw new Error(`Duplicate provider connection id '${connection.id}'`);
      }
      if (catalogModels && catalogModels.length > 0) {
        const seededConfig = seedReasoningConfig(connection, catalogModels);
        if (seededConfig) {
          connection = providerConnectionSchema.parse({ ...connection, reasoningConfig: seededConfig });
        }
      }
      await this.beforePersist?.();
      atomicWriteJson(this.filePath, {
        version: PROVIDER_CONNECTION_DOCUMENT_VERSION,
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
      atomicWriteJson(this.filePath, { version: PROVIDER_CONNECTION_DOCUMENT_VERSION, connections });
      return updated;
    });
  }

  async remove(id: string): Promise<ProviderConnection | null> {
    return withSerializedWrite(this.filePath, async () => {
      const document = readDocument(this.filePath);
      const removed = document.connections.find((connection) => connection.id === id);
      if (!removed) return null;
      const connections = document.connections.filter((connection) => connection.id !== id);
      await this.beforePersist?.();
      atomicWriteJson(this.filePath, { version: PROVIDER_CONNECTION_DOCUMENT_VERSION, connections });
      return { ...removed };
    });
  }

}
