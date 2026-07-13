import type { LanguageModelV4 } from '@ai-sdk/provider';
import Decimal from 'decimal.js';
import type { ModelSelection, ProviderConnection } from '../../shared/types/provider';
import type {
  FrozenPricingSnapshot,
  FrozenProviderRequestSnapshot,
  PricingRateSnapshot,
} from '../../shared/types/accounting';
import { resolveModelSelection } from './resolver';
import type { ConnectionStore } from './connection-store';
import type { ProviderCatalogSnapshot, ProviderCatalogStore } from './catalog/store';
import type { CatalogPricing } from './catalog/schema';
import { catalogToProviderDefinitions } from './catalog/schema';
import {
  CredentialVault,
  normalizeCredentialBinding,
  type CredentialSecret,
} from './credentials/vault';
import type { CredentialRefreshCoordinator } from './credentials/refresh';
import { ProviderDriverRegistry, createDefaultProviderDriverRegistry } from './drivers/registry';
import { validateGenericEndpoint } from './drivers/compatible';
import type {
  DriverModelRequest,
  ProviderDriver,
  ProviderEmbeddingTarget,
} from './drivers/types';
import { ProviderResolutionError } from '../llm/middleware/error-classification';
import type { ProviderStatusService } from './status/service';

export interface ProviderRuntimeOptions {
  readonly catalog: Pick<ProviderCatalogStore, 'getProviderDefinitions'> & {
    readonly load?: () => ProviderCatalogSnapshot;
  };
  readonly connections: Pick<ConnectionStore, 'list'>;
  readonly vault: Pick<CredentialVault, 'readSecret'>;
  readonly status?: Pick<ProviderStatusService, 'get'>;
  readonly registry?: ProviderDriverRegistry;
  readonly credentialRefresh?: Pick<CredentialRefreshCoordinator, 'refreshConnection'>;
  readonly now?: () => Date;
}

export interface ResolvedProviderExecution {
  readonly modelInstance: LanguageModelV4;
  readonly snapshot: FrozenProviderRequestSnapshot;
}

/**
 * Resolves a typed selection through catalog, connection, vault, and trusted
 * driver code. No renderer-owned value can choose an adapter or API origin.
 */
export class ProviderRuntime {
  private readonly catalog: ProviderRuntimeOptions['catalog'];
  private readonly connections: Pick<ConnectionStore, 'list'>;
  private readonly vault: Pick<CredentialVault, 'readSecret'>;
  private readonly status: Pick<ProviderStatusService, 'get'> | undefined;
  private readonly registry: ProviderDriverRegistry;
  private readonly credentialRefresh: ProviderRuntimeOptions['credentialRefresh'];
  private readonly now: () => Date;

  constructor(options: ProviderRuntimeOptions) {
    this.catalog = options.catalog;
    this.connections = options.connections;
    this.vault = options.vault;
    this.status = options.status;
    this.registry = options.registry ?? createDefaultProviderDriverRegistry();
    this.credentialRefresh = options.credentialRefresh;
    this.now = options.now ?? (() => new Date());
  }

  async resolveLanguageModel(selection: ModelSelection): Promise<LanguageModelV4> {
    return (await this.resolveExecution(selection)).modelInstance;
  }

  /** Resolve one immutable turn context and its trusted model together. */
  async resolveExecution(selection: ModelSelection): Promise<ResolvedProviderExecution> {
    const resolved = await this.resolveDriverRequest(selection);
    return {
      modelInstance: await this.registry.createLanguageModel(resolved.request),
      snapshot: resolved.snapshot,
    };
  }

  /**
   * Resolve a typed API embedding selection through the same connection, vault,
   * endpoint, and trusted-driver gates used for chat. Local ONNX remains the
   * caller's explicit null-selection path.
   */
  async resolveApiEmbeddingTarget(selection: ModelSelection): Promise<ProviderEmbeddingTarget> {
    const resolved = await this.resolveDriverRequest(selection);
    return this.registry.createEmbeddingTarget(resolved.request);
  }

  private async resolveDriverRequest(selection: ModelSelection): Promise<{
    readonly request: DriverModelRequest;
    readonly snapshot: FrozenProviderRequestSnapshot;
  }> {
    const connections = await this.connections.list();
    const catalogSnapshot = this.catalog.load?.();
    const definitions = catalogSnapshot
      ? catalogToProviderDefinitions(catalogSnapshot.catalog)
      : this.catalog.getProviderDefinitions();
    const resolution = resolveModelSelection(selection, connections, definitions);
    if (resolution.kind !== 'resolved') {
      throw new ProviderResolutionError(this.describeResolutionFailure(resolution.kind, resolution.reason));
    }
    const driver = this.registry.require(resolution.provider.id);
    const credential = await this.resolveCredential(resolution.connection, driver);
    return {
      request: {
        connection: resolution.connection,
        provider: resolution.provider,
        model: resolution.model,
        credential,
      },
      snapshot: this.freezeSnapshot(resolution, catalogSnapshot),
    };
  }

  private freezeSnapshot(
    resolution: Extract<ReturnType<typeof resolveModelSelection>, { kind: 'resolved' }>,
    catalogSnapshot: ProviderCatalogSnapshot | undefined,
  ): FrozenProviderRequestSnapshot {
    const catalogProvider = catalogSnapshot?.catalog.providers.find(
      (provider) => provider.id === resolution.provider.id,
    );
    const catalogModel = catalogProvider?.models.find((model) => model.id === resolution.model.id);
    const observation = this.status?.get(resolution.provider.id);
    return structuredClone({
      providerId: resolution.provider.id,
      providerDisplayName: resolution.provider.displayName,
      connectionId: resolution.connection.id,
      connectionName: resolution.connection.name,
      modelId: resolution.model.id,
      protocol: resolution.model.protocol,
      modelSource: resolution.model.source,
      catalogVersion: catalogSnapshot?.catalog.catalogVersion ?? null,
      catalogSource: catalogSnapshot?.source ?? 'none',
      catalogObservedAt: catalogSnapshot?.catalog.issuedAt ?? null,
      pricing: catalogModel?.pricing
        ? freezePricing(catalogModel.pricing, liveLilacPricing(
          resolution.provider.id,
          resolution.model.id,
          observation,
        ))
        : null,
      fieldProvenance: catalogModel
        ? { provider: catalogProvider?.provenance ?? {}, model: catalogModel.provenance }
        : { source: 'user' },
      statusObservation: observation
        ? { observedAt: observation.observedAt, providerUpdatedAt: observation.providerUpdatedAt, data: observation.data }
        : null,
    });
  }

  private async resolveCredential(
    connection: ProviderConnection,
    driver: ProviderDriver,
  ): Promise<
    | { readonly kind: 'api-key'; readonly apiKey: string }
    | { readonly kind: 'oauth'; readonly accessToken: string }
    | { readonly kind: 'none' }
  > {
    if (connection.credential.kind === 'none') {
      if (connection.authMethod !== 'none') {
        throw new ProviderResolutionError(`Connection '${connection.name}' is missing a credential`);
      }
      return { kind: 'none' };
    }
    if (connection.credential.kind === 'environment') {
      if (connection.authMethod !== 'environment') {
        throw new ProviderResolutionError('Environment credential references require environment authentication');
      }
      const apiKey = process.env[connection.credential.variable];
      if (!apiKey) {
        throw new ProviderResolutionError(
          `Environment credential '${connection.credential.variable}' is not available for '${connection.name}'`,
        );
      }
      return { kind: 'api-key', apiKey };
    }

    if (connection.authMethod !== 'api-key' && connection.authMethod !== 'oauth') {
      throw new ProviderResolutionError(`Stored credentials are not valid for '${connection.authMethod}' authentication`);
    }
    const origin = driver.allowsCustomEndpoint
      ? validateGenericEndpoint(connection.endpoint ?? '').origin
      : driver.origin;
    const binding = normalizeCredentialBinding({
      connectionId: connection.id,
      driverId: connection.providerId,
      authMethod: connection.authMethod,
      origin,
    });
    let secret = await this.vault.readSecret(connection.credential.handle, binding);
    if (secret.kind === 'oauth' && this.oauthNeedsRefresh(secret.expiresAt)) {
      if (!driver.refreshOAuthTokens || !this.credentialRefresh) {
        throw new ProviderResolutionError(
          `Connection '${connection.name}' has expired OAuth credentials and cannot refresh in this release`,
        );
      }
      await this.credentialRefresh.refreshConnection(
        connection.id,
        ({ connection: refreshConnection, tokens }) => driver.refreshOAuthTokens!({
          connection: refreshConnection,
          tokens,
        }),
        { origin },
      );
      secret = await this.vault.readSecret(connection.credential.handle, binding);
      if (secret.kind !== 'oauth') {
        throw new ProviderResolutionError(
          `Connection '${connection.name}' did not retain OAuth credentials after refresh`,
        );
      }
    }
    return this.driverCredentialFromSecret(secret);
  }

  private oauthNeedsRefresh(expiresAt: string): boolean {
    const expiry = Date.parse(expiresAt);
    return !Number.isFinite(expiry) || expiry <= this.now().getTime() + 60_000;
  }

  private driverCredentialFromSecret(secret: CredentialSecret):
    | { readonly kind: 'api-key'; readonly apiKey: string }
    | { readonly kind: 'oauth'; readonly accessToken: string } {
    return secret.kind === 'api-key'
      ? { kind: 'api-key', apiKey: secret.apiKey }
      : { kind: 'oauth', accessToken: secret.accessToken };
  }

  private describeResolutionFailure(kind: string, reason: string): string {
    if (kind === 'provider-required') return 'A usable provider connection is required before sending a request.';
    if (kind === 'selection-required') return 'Choose a connection and model before sending a request.';
    return `Provider selection is unavailable: ${reason}`;
  }
}

interface LiveLilacPricing {
  readonly multiplier: Decimal;
  readonly discountPercent: number;
  readonly observedAt: string;
  readonly providerUpdatedAt: string | null;
  readonly supplyUpdatedAt: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max
    ? value
    : null;
}

/**
 * Lilac publishes a live subscription multiplier alongside its discount. Both
 * values must be present, fresh, and tied to the selected model before they
 * can adjust a frozen monetary formula. We never derive either value from the
 * other, supply state, or performance data.
 */
function liveLilacPricing(
  providerId: string,
  modelId: string,
  observation: ReturnType<NonNullable<ProviderRuntimeOptions['status']>['get']>,
): LiveLilacPricing | null {
  if (providerId !== 'lilac' || !observation || observation.stale || observation.availability !== 'available') {
    return null;
  }
  const data = record(observation.data);
  const models = data?.['models'];
  if (!Array.isArray(models)) return null;
  const model = models
    .map(record)
    .find((item) => item?.['modelId'] === modelId);
  const subscription = model ? record(model['subscription']) : null;
  if (!subscription || subscription['availability'] !== 'available') return null;
  const discountPercent = finiteNumber(subscription['discountPercent'], 0, 100);
  const multiplier = finiteNumber(subscription['creditMultiplier'], 0, Number.POSITIVE_INFINITY);
  if (discountPercent === null || multiplier === null) return null;
  try {
    const decimalMultiplier = new Decimal(String(multiplier));
    if (!decimalMultiplier.isFinite() || decimalMultiplier.isNegative()) return null;
    return {
      multiplier: decimalMultiplier,
      discountPercent,
      observedAt: observation.observedAt,
      providerUpdatedAt: observation.providerUpdatedAt,
      supplyUpdatedAt: typeof data?.['subscriptionSupplyUpdatedAt'] === 'string'
        ? data['subscriptionSupplyUpdatedAt']
        : null,
    };
  } catch {
    return null;
  }
}

function freezeRate(
  rate: CatalogPricing['rates']['input'] | undefined,
  live: LiveLilacPricing | null,
): PricingRateSnapshot | undefined {
  if (!rate) return undefined;
  if (!live) return { ...rate };
  return {
    ...rate,
    amount: new Decimal(rate.amount).mul(live.multiplier).toFixed(),
  };
}

function freezePricing(
  pricing: CatalogPricing,
  live: LiveLilacPricing | null,
): FrozenPricingSnapshot {
  return {
    currency: pricing.currency,
    effectiveAt: live?.supplyUpdatedAt ?? live?.providerUpdatedAt ?? pricing.effectiveAt,
    rates: {
      input: freezeRate(pricing.rates.input, live),
      output: freezeRate(pricing.rates.output, live),
      cacheRead: freezeRate(pricing.rates.cacheRead, live),
      cacheWrite: freezeRate(pricing.rates.cacheWrite, live),
      reasoning: freezeRate(pricing.rates.reasoning, live),
    },
    inclusion: {
      cacheRead: 'subset-of-input',
      cacheWrite: pricing.rates.cacheWrite ? 'additional' : 'unknown',
      reasoning: pricing.rates.reasoning ? 'subset-of-output' : 'unknown',
    },
    provenance: live
      ? {
          source: 'lilac-public-status',
          signedCatalog: structuredClone(pricing.provenance),
          statusObservedAt: live.observedAt,
          providerUpdatedAt: live.providerUpdatedAt,
          supplyUpdatedAt: live.supplyUpdatedAt,
          discountPercent: live.discountPercent,
          creditMultiplier: live.multiplier.toFixed(),
        }
      : {
          source: 'signed-catalog',
          signedCatalog: structuredClone(pricing.provenance),
        },
  };
}

let providerRuntime: ProviderRuntime | null = null;

export function initializeProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  providerRuntime = new ProviderRuntime(options);
  return providerRuntime;
}

export function getProviderRuntime(): ProviderRuntime {
  if (!providerRuntime) throw new Error('Provider runtime has not been initialized');
  return providerRuntime;
}

export function resetProviderRuntime(): void {
  providerRuntime = null;
}

/** @internal Test-only singleton cleanup alias. */
export const _resetProviderRuntimeForTests = resetProviderRuntime;
