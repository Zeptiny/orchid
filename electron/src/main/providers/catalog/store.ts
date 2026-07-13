import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { HOME_CONFIG_DIR, atomicWriteJson } from '../../config/loader';
import {
  catalogToProviderDefinitions,
  type ProviderCatalog,
} from './schema';
import {
  isCatalogExpired,
  validateCatalogBytes,
  validateSignedCatalog,
  type CatalogKeyring,
  type TrustedCatalogProviderPolicy,
} from './trust';
import type { ProviderDefinition } from '../../../shared/types/provider';

export const PROVIDER_CATALOG_CACHE_PATH = path.join(HOME_CONFIG_DIR, 'provider-catalog.json');

const cachedCatalogSchema = z.object({
  version: z.literal(1),
  keyId: z.string().trim().min(1),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  catalogBytes: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export interface ProviderCatalogSnapshot {
  readonly source: 'bundled' | 'cache';
  readonly stale: boolean;
  readonly catalog: ProviderCatalog;
}

export interface ProviderCatalogStoreOptions {
  readonly bundledCatalogPath: string;
  readonly cachePath?: string;
  readonly appVersion: string;
  readonly keyring: CatalogKeyring;
  readonly now?: () => Date;
  readonly policies?: readonly TrustedCatalogProviderPolicy[];
}

export interface CatalogPromotionInput {
  readonly bytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyId: string;
  /** Restricted to cache-recovery fixtures; network updater never sets this. */
  readonly allowExpired?: boolean;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshot(
  source: ProviderCatalogSnapshot['source'],
  catalog: ProviderCatalog,
  stale: boolean,
): ProviderCatalogSnapshot {
  return deepFreeze({
    source,
    stale,
    catalog: structuredClone(catalog),
  });
}

/**
 * Keeps a verified bundle or last-known-good remote catalog in one atomic file.
 * The cache preserves raw signed bytes so a restart verifies the original data,
 * rather than a lossy re-serialization.
 */
export class ProviderCatalogStore {
  private readonly bundledCatalogPath: string;
  private readonly cachePath: string;
  private readonly appVersion: string;
  private readonly keyring: CatalogKeyring;
  private readonly now: () => Date;
  private readonly policies: readonly TrustedCatalogProviderPolicy[] | undefined;
  private current: ProviderCatalogSnapshot | null = null;

  constructor(options: ProviderCatalogStoreOptions) {
    this.bundledCatalogPath = options.bundledCatalogPath;
    this.cachePath = options.cachePath ?? PROVIDER_CATALOG_CACHE_PATH;
    this.appVersion = options.appVersion;
    this.keyring = options.keyring;
    this.now = options.now ?? (() => new Date());
    this.policies = options.policies;
  }

  load(): ProviderCatalogSnapshot {
    if (this.current) return this.current;

    const bundled = this.readBundled();
    const cached = this.readCached();
    this.current = cached && cached.catalog.catalogVersion > bundled.catalog.catalogVersion
      ? cached
      : bundled;
    return this.current;
  }

  getProviderDefinitions(): readonly ProviderDefinition[] {
    return catalogToProviderDefinitions(this.load().catalog);
  }

  promote(input: CatalogPromotionInput): ProviderCatalogSnapshot {
    const validated = validateSignedCatalog({
      bytes: input.bytes,
      signature: input.signature,
      keyId: input.keyId,
      keyring: this.keyring,
      appVersion: this.appVersion,
      now: this.now(),
      allowExpired: input.allowExpired ?? false,
      policies: this.policies,
    });
    const existing = this.load();
    if (validated.catalog.catalogVersion <= existing.catalog.catalogVersion) {
      throw new Error(
        `Catalog version ${validated.catalog.catalogVersion} must be newer than ${existing.catalog.catalogVersion}`,
      );
    }

    // Do not mutate in-memory state until the fsync + rename write succeeds.
    atomicWriteJson(this.cachePath, {
      version: 1,
      keyId: input.keyId,
      signature: Buffer.from(input.signature).toString('base64'),
      catalogBytes: validated.bytes.toString('base64'),
    });

    this.current = snapshot('cache', validated.catalog, validated.stale);
    return this.current;
  }

  private readBundled(): ProviderCatalogSnapshot {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.bundledCatalogPath);
    } catch (error) {
      throw new Error(`Bundled provider catalog is unavailable at '${this.bundledCatalogPath}'`, {
        cause: error,
      });
    }
    const validated = validateCatalogBytes(bytes, {
      appVersion: this.appVersion,
      now: this.now(),
      allowExpired: true,
      policies: this.policies,
    });
    return snapshot('bundled', validated.catalog, validated.stale);
  }

  private readCached(): ProviderCatalogSnapshot | null {
    if (!fs.existsSync(this.cachePath)) return null;
    try {
      const cached = cachedCatalogSchema.parse(
        JSON.parse(fs.readFileSync(this.cachePath, 'utf8')),
      );
      const validated = validateSignedCatalog({
        bytes: Buffer.from(cached.catalogBytes, 'base64'),
        signature: Buffer.from(cached.signature, 'base64'),
        keyId: cached.keyId,
        keyring: this.keyring,
        appVersion: this.appVersion,
        now: this.now(),
        allowExpired: true,
        policies: this.policies,
      });
      return snapshot('cache', validated.catalog, isCatalogExpired(validated.catalog, this.now()));
    } catch {
      // An interrupted write, stale removed key, or tampered cache must never
      // displace the bundled catalog. The next valid refresh can replace it.
      return null;
    }
  }
}
