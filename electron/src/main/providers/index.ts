import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { EffectiveModel, ModelSelection, ProviderConnection } from '../../shared/types/provider';
import type {
  FrozenProviderRequestSnapshot,
} from '../../shared/types/accounting';
import type { CacheFacet, PricingRateFields, ThinkingPolicy } from '../../shared/types/provider-facets';
import { resolveModelSelection } from './resolver';
import type { ConnectionStore } from './connection-store';
import type { ProviderCatalogSnapshot, ProviderCatalogStore } from './catalog/store';
import { catalogToProviderDefinitions } from './catalog/schema';
import {
  CredentialVault,
  normalizeCredentialBinding,
} from './credentials/vault';
import { ProviderDriverRegistry, createDefaultProviderDriverRegistry } from './drivers/registry';
import { validateGenericEndpoint } from './drivers/compatible';
import type {
  DriverPricingFacet,
  DriverPricingFetchContext,
  DriverModelRequest,
  ProviderDriver,
  ProviderEmbeddingTarget,
  ReasoningProviderOptions,
} from './drivers/types';
import { resolveFrozenPricing } from './facets/pricing';
import { PricingRefresher } from './facets/pricing-refresh';
import { tierVariantModelId } from './facets/tiers';
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
  readonly pricing?: PricingRefresher;
}

export interface ResolvedProviderExecution {
  readonly modelInstance: LanguageModelV4;
  readonly snapshot: FrozenProviderRequestSnapshot;
  /** Non-secret connection metadata resolved for this turn. */
  readonly connection: ProviderConnection;
  /** Effective model resolved for this turn. */
  readonly model: EffectiveModel;
  /** Map a reasoning effort to provider-native options, when the driver supports it. */
  readonly buildReasoningOptions?: (
    effort: string | number,
  ) => ReasoningProviderOptions | undefined;
  /** Driver pricing facet for evidence extraction during attempt accounting. */
  readonly pricingFacet?: DriverPricingFacet;
  /** Thinking exposure/replay policy resolved for the frozen model (R15). */
  readonly thinkingPolicy?: ThinkingPolicy;
  /** Driver cache facet; generic compatible connections declare none (R12). */
  readonly cacheFacet?: CacheFacet;
  /** Driver tier mechanism; absent when the provider has no tier facet. */
  readonly tierMechanism?: ProviderDriver['tierMechanism'];
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
  private readonly pricing: PricingRefresher;

  constructor(options: ProviderRuntimeOptions) {
    this.catalog = options.catalog;
    this.connections = options.connections;
    this.vault = options.vault;
    this.status = options.status;
    this.registry = options.registry ?? createDefaultProviderDriverRegistry();
    this.pricing = options.pricing ?? new PricingRefresher();
  }

  async resolveLanguageModel(selection: ModelSelection): Promise<LanguageModelV4> {
    return (await this.resolveExecution(selection)).modelInstance;
  }

  /**
   * Resolve one immutable turn context and its trusted model together.
   * `options.tier` is the effective service tier id (session override →
   * connection selection) resolved by the caller through the tier facet;
   * variant-mechanism drivers map it to the executable model id (R19, R21).
   */
  async resolveExecution(
    selection: ModelSelection,
    options: { readonly tier?: string } = {},
  ): Promise<ResolvedProviderExecution> {
    const resolved = await this.resolveDriverRequest(selection, options.tier);
    const { request, driver } = resolved;
    const buildReasoning = driver.buildReasoningOptions;
    return {
      modelInstance: await this.registry.createLanguageModel(request),
      snapshot: resolved.snapshot,
      connection: request.connection,
      model: request.model,
      buildReasoningOptions: buildReasoning
        ? (effort: string | number) => buildReasoning(effort, request.model)
        : undefined,
      pricingFacet: driver.pricingFacet,
      thinkingPolicy: driver.thinkingPolicy?.(request.model),
      cacheFacet: driver.cacheFacet,
      tierMechanism: driver.tierMechanism,
    };
  }

  /**
   * Resolve the connection, driver tier mechanism, and declared tiers for one
   * selection without constructing a model — the caller resolves the effective
   * tier and passes it back into `resolveExecution(selection, { tier })`.
   */
  async resolveTierContext(selection: ModelSelection): Promise<{
    readonly connection: ProviderConnection;
    readonly tierMechanism?: ProviderDriver['tierMechanism'];
  }> {
    const connections = await this.connections.list();
    const definitions = this.catalog.getProviderDefinitions();
    const resolution = resolveModelSelection(selection, connections, definitions);
    if (resolution.kind !== 'resolved') {
      throw new ProviderResolutionError(this.describeResolutionFailure(resolution.kind, resolution.reason));
    }
    const driver = this.registry.require(resolution.provider.id);
    return { connection: resolution.connection, tierMechanism: driver.tierMechanism };
  }

  /** Latest-known dynamic pricing cache (invalidated on connection identity changes). */
  get pricingRefresher(): PricingRefresher {
    return this.pricing;
  }

  /** Halt background pricing refreshes; the ledger of attempts is unaffected. */
  dispose(): void {
    this.pricing.stop();
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

  private async resolveDriverRequest(selection: ModelSelection, tier?: string): Promise<{
    readonly request: DriverModelRequest;
    readonly snapshot: FrozenProviderRequestSnapshot;
    readonly driver: ProviderDriver;
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
    const request: DriverModelRequest = {
      connection: resolution.connection,
      provider: resolution.provider,
      model: resolution.model,
      credential,
      ...(tier !== undefined ? { tier } : {}),
    };
    if (driver.pricingFacet?.dynamic) {
      // The snapshot below freezes latest-known rates synchronously; the
      // refresh itself runs in the background and never blocks a request (R7).
      this.pricing.ensureFresh({
        driver,
        request,
        fetchContext: () => this.catalogPricingContext(resolution.provider.id),
      });
    }
    return {
      request,
      snapshot: this.freezeSnapshot(resolution, catalogSnapshot, driver, tier),
      driver,
    };
  }

  private freezeSnapshot(
    resolution: Extract<ReturnType<typeof resolveModelSelection>, { kind: 'resolved' }>,
    catalogSnapshot: ProviderCatalogSnapshot | undefined,
    driver: ProviderDriver,
    tier?: string,
  ): FrozenProviderRequestSnapshot {
    const catalogProvider = catalogSnapshot?.catalog.providers.find(
      (provider) => provider.id === resolution.provider.id,
    );
    const catalogModel = catalogProvider?.models.find((model) => model.id === resolution.model.id);
    const observation = this.status?.get(resolution.provider.id);
    const tierMechanism = driver.tierMechanism;
    // Variant-mechanism billing: the served variant id is the billed identity,
    // so the snapshot freezes that variant's catalog rates (R22).
    const variantModelId = tierMechanism?.kind === 'model-name-variants' && tier
      ? tierVariantModelId(tierMechanism, resolution.model.id, tier)
      : undefined;
    const servedModelId = variantModelId ?? resolution.model.id;
    const billedCatalogModel = variantModelId
      ? catalogProvider?.models.find((model) => model.id === variantModelId) ?? catalogModel
      : catalogModel;
    const dynamic = driver.pricingFacet?.dynamic
      ? this.pricing.stateFor(
        resolution.provider.id,
        resolution.connection.id,
        resolution.model.id,
        driver.pricingFacet.dynamic.refreshIntervalSeconds,
      )
      : undefined;
    return structuredClone({
      providerId: resolution.provider.id,
      providerDisplayName: resolution.provider.displayName,
      connectionId: resolution.connection.id,
      connectionName: resolution.connection.name,
      modelId: resolution.model.id,
      modelDisplayName: resolution.model.displayName,
      protocol: resolution.model.protocol,
      modelSource: resolution.model.source,
      catalogVersion: catalogSnapshot?.catalog.catalogVersion ?? null,
      catalogSource: catalogSnapshot?.source ?? 'none',
      catalogObservedAt: catalogSnapshot?.catalog.issuedAt ?? null,
      pricing: resolveFrozenPricing({
        pricingFacet: driver.pricingFacet,
        connection: resolution.connection,
        // Variant billing freezes the served variant's rates (R22); the
        // user-override ladder layer still keys off the base model id.
        modelId: variantModelId ?? resolution.model.id,
        catalogPricing: billedCatalogModel?.pricing,
        dynamic,
        now: new Date(),
      }),
      ...(tierMechanism
        ? {
            tier: {
              mechanism: tierMechanism.kind,
              ...(tier ? { requestedTier: tier } : {}),
              ...(tierMechanism.kind === 'model-name-variants'
                ? {
                    servedModelId,
                    ...(variantModelId ? { baseModelId: resolution.model.id } : {}),
                  }
                : {}),
            },
          }
        : {}),
      fieldProvenance: catalogModel
        ? { provider: catalogProvider?.provenance ?? {}, model: catalogModel.provenance }
        : { source: 'user' },
      statusObservation: observation
        ? { observedAt: observation.observedAt, providerUpdatedAt: observation.providerUpdatedAt, data: observation.data }
        : null,
    });
  }

  /** Catalog base rates for drivers whose live pricing is relative to list rates. */
  private catalogPricingContext(providerId: string): DriverPricingFetchContext {
    const snapshot = this.catalog.load?.();
    const provider = snapshot?.catalog.providers.find((candidate) => candidate.id === providerId);
    if (!provider) return {};
    const catalogRates: Record<string, PricingRateFields> = {};
    for (const model of provider.models) catalogRates[model.id] = model.pricing.rates;
    return { catalogRates };
  }

  private async resolveCredential(
    connection: ProviderConnection,
    driver: ProviderDriver,
  ): Promise<
    | { readonly kind: 'api-key'; readonly apiKey: string }
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

    if (connection.authMethod !== 'api-key') {
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
    const secret = await this.vault.readSecret(connection.credential.handle, binding);
    if (secret.kind !== 'api-key') {
      throw new ProviderResolutionError(
        `Connection '${connection.name}' does not have a stored API key credential`,
      );
    }
    return { kind: 'api-key', apiKey: secret.apiKey };
  }

  private describeResolutionFailure(kind: string, reason: string): string {
    if (kind === 'provider-required') return 'A usable provider connection is required before sending a request.';
    if (kind === 'selection-required') return 'Choose a connection and model before sending a request.';
    return `Provider selection is unavailable: ${reason}`;
  }
}

let providerRuntime: ProviderRuntime | null = null;

export function initializeProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  providerRuntime?.dispose();
  providerRuntime = new ProviderRuntime(options);
  return providerRuntime;
}

export function getProviderRuntime(): ProviderRuntime {
  if (!providerRuntime) throw new Error('Provider runtime has not been initialized');
  return providerRuntime;
}

/** Null before runtime initialization so IPC services can degrade gracefully. */
export function getProviderPricingRefresher(): PricingRefresher | null {
  return providerRuntime?.pricingRefresher ?? null;
}

export function resetProviderRuntime(): void {
  providerRuntime?.dispose();
  providerRuntime = null;
}
