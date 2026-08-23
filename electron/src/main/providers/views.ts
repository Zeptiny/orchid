/**
 * Provider renderer views and connection mutations — the electron-free core
 * behind both the Electron IPC boundary (ipc/providers.ts, ipc/provider-models.ts)
 * and the headless host protocol (host/server.ts).
 *
 * Everything here is redacted-by-construction: the renderer/protocol boundary
 * never receives a credential handle, API key, driver origin, or executable
 * driver configuration. Connection CRUD intent (create/update/submit_api_key)
 * stays in the IPC layer because it is Electron-only by policy (vault writes
 * are not host-routed in v1).
 */
import * as fs from 'node:fs';
import { z } from 'zod';
import type {
  ProviderDeleteConnectionResult,
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderModelPricingView,
  ProviderModelView,
  ProviderMutationResult,
  ProviderOverview,
  ProviderStatusView,
} from '../../shared/types/ipc';
import { pricingRateFieldsSchema, providerQuotaSchema } from '../../shared/types/provider-facets';
import type { CatalogPricing } from './catalog/schema';
import {
  customConnectionModelSchema,
  environmentVariableSchema,
  providerAuthMethodSchema,
  providerEndpointSchema,
  providerProtocolSchema,
  reasoningModelConfigSchema,
  type ProviderConnection,
  type ProviderDefinition,
  type ProviderModelDefinition,
} from '../../shared/types/provider';
import {
  getProviderCatalogStore,
  getProviderConnectionStore,
  getProviderCredentialVault,
  getProviderStatusService,
} from './runtime-context';
import { getProviderPricingRefresher } from './index';
import type { PricingRefresher } from './facets/pricing-refresh';
import {
  discoverConnectionModels,
  listConnectionModelRows,
  type ConnectionDiscoveryOutcome,
} from './facets/discovery';
import type { DriverCredential } from './drivers/types';
import type { ProviderStatusObservation } from './status/cache';
import type { ProviderStatusService } from './status/service';
import { getProviderAccountingStore } from './accounting/store';
import type { ConnectionStore } from './connection-store';
import type { ProviderCatalogStore } from './catalog/store';
import {
  CredentialVault,
  normalizeCredentialBinding,
  type CredentialSecret,
  type SecureStorageAvailability,
} from './credentials/vault';
import {
  ProviderDriverRegistry,
  createDefaultProviderDriverRegistry,
} from './drivers/registry';
import { validateGenericEndpoint } from './drivers/compatible';
import { createLilacStatusSource } from './drivers/lilac';
import {
  createNeuralwattQuotaStatusSource,
} from './drivers/neuralwatt-quota';
import {
  atomicWriteJson,
  ConfigManager,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  loadConfig,
} from '../config/loader';
import { isPlainObject } from '../config/merge';
import { withConfigSaveLock } from '../config/write-lock';
import { clearProjectRuntimeRegistry } from '../project/runtime';
import {
  activeSessionsForProviderConnection,
  stopActiveProviderConnectionTurns,
} from '../host/chat/abort';
import { groupTierVariantRows } from './facets/tiers';
import { resolveModelSelection } from './resolver';
import type { ProviderModelOption } from '../../shared/types/ipc';

// ── Boundary schemas ─────────────────────────────────────────────────────────

const idSchema = z.string().uuid();

export const connectionIdSchema = z.object({ connectionId: idSchema }).strict();
export const disconnectSchema = connectionIdSchema.extend({ confirm: z.literal(true) }).strict();
export const statusRefreshSchema = z.object({
  providerId: z.string().trim().min(1),
  connectionId: idSchema.optional(),
}).strict();

// ── Main-process dependency boundary ────────────────────────────────────────

export interface ProviderIPCServices {
  readonly catalog: Pick<ProviderCatalogStore, 'getProviderDefinitions' | 'load'>;
  readonly connections: Pick<ConnectionStore,
    'list' | 'get' | 'create' | 'update' | 'remove' | 'persistDiscoveredModels'>;
  readonly vault: Pick<CredentialVault,
    'getAvailability' | 'replaceConnectionApiKey' | 'readSecret' | 'deleteConnectionCredentials'>;
  readonly status: Pick<ProviderStatusService, 'get' | 'list' | 'refresh' | 'invalidate'>;
  readonly registry: ProviderDriverRegistry;
  /** Latest-known dynamic pricing cache; absent until the provider runtime initializes. */
  readonly pricing?: Pick<PricingRefresher, 'invalidate'>;
  readonly clearConfigReferences?: typeof clearConnectionConfigReferences;
}

let testServices: ProviderIPCServices | null = null;
/** Process-lifetime driver registry — rebuilt only when tests clear services. */
let cachedDriverRegistry: ProviderDriverRegistry | null = null;

function getCachedDriverRegistry(): ProviderDriverRegistry {
  if (!cachedDriverRegistry) {
    cachedDriverRegistry = createDefaultProviderDriverRegistry();
  }
  return cachedDriverRegistry;
}

export function services(): ProviderIPCServices {
  if (testServices) return testServices;
  return {
    catalog: getProviderCatalogStore(),
    connections: getProviderConnectionStore(),
    vault: getProviderCredentialVault(),
    status: getProviderStatusService(),
    registry: getCachedDriverRegistry(),
    pricing: getProviderPricingRefresher() ?? undefined,
    clearConfigReferences: clearConnectionConfigReferences,
  };
}

/** @internal Injection seam for isolated IPC tests. */
export function _setProviderIPCServicesForTests(value: ProviderIPCServices | null): void {
  testServices = value;
  // Drop the production registry cache so a later non-test services() call
  // cannot retain a registry from a prior process lifetime across test isolation.
  if (value === null) {
    cachedDriverRegistry = null;
  }
}

// ── Per-connection mutation lock ────────────────────────────────────────────
// Serializes vault + connection-store mutations for the same connection so
// concurrent submit_api_key / disconnect / delete / disable / enable / update / validate
// cannot leave a live vault secret after disconnect or clobber terminal health.

const connectionMutationChains = new Map<string, Promise<void>>();

export function withConnectionMutationLock<T>(
  connectionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = connectionMutationChains.get(connectionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const chain = run.then(
    () => undefined,
    () => undefined,
  );
  connectionMutationChains.set(connectionId, chain);
  chain.then(() => {
    if (connectionMutationChains.get(connectionId) === chain) {
      connectionMutationChains.delete(connectionId);
    }
  });
  return run;
}

/** @internal Test-only reset for isolated IPC tests. */
export function _clearConnectionMutationLocksForTests(): void {
  connectionMutationChains.clear();
}

function isMutableHealth(
  health: ProviderConnection['health'],
): health is 'draft' | 'needs_attention' | 'ready' {
  return health === 'draft' || health === 'needs_attention' || health === 'ready';
}

// ── Redacted DTO mapping ────────────────────────────────────────────────────

function lifecycleAvailable(lifecycle: ProviderDefinition['lifecycle']): boolean {
  return lifecycle !== 'disabled' && lifecycle !== 'retired';
}

function unavailableProviderReason(
  definition: ProviderDefinition,
  registry: ProviderDriverRegistry,
): string | null {
  if (!lifecycleAvailable(definition.lifecycle)) {
    return 'This provider is disabled by the current catalog.';
  }
  if (!registry.get(definition.id)) return 'This build does not include a trusted driver for this provider.';
  return null;
}

/** Renderer-safe view of one signed-catalog rate card; provenance never leaves main. */
export function pricingView(pricing: CatalogPricing): ProviderModelPricingView {
  return {
    currency: pricing.currency,
    ...(pricing.currencyUnit ? { currencyUnit: pricing.currencyUnit } : {}),
    effectiveAt: pricing.effectiveAt,
    rates: pricing.rates,
    ...(pricing.contextTiers && pricing.contextTiers.length > 0
      ? { contextTiers: pricing.contextTiers }
      : {}),
  };
}

export function modelView(
  model: ProviderModelDefinition,
  source: 'catalog' | 'provider' | 'user',
  pricing?: ProviderModelPricingView,
): ProviderModelView {
  return {
    id: model.id,
    displayName: model.displayName,
    protocol: model.protocol,
    lifecycle: model.lifecycle ?? null,
    source,
    capabilities: model.capabilities
      ? {
          inputModalities: [...model.capabilities.inputModalities],
          outputModalities: [...model.capabilities.outputModalities],
          tools: model.capabilities.tools,
          reasoning: model.capabilities.reasoning,
        }
      : null,
    limits: model.limits
      ? {
          contextTokens: model.limits.contextTokens,
          outputTokens: model.limits.outputTokens,
        }
      : null,
    ...(pricing ? { pricing } : {}),
  };
}

function definitionView(
  definition: ProviderDefinition,
  registry: ProviderDriverRegistry,
  pricingByModelId?: ReadonlyMap<string, CatalogPricing>,
): ProviderDefinitionView {
  const unavailableReason = unavailableProviderReason(definition, registry);
  return {
    id: definition.id,
    displayName: definition.displayName,
    supportedAuthMethods: [...definition.supportedAuthMethods],
    supportedProtocols: [...definition.supportedProtocols],
    allowsCustomModels: definition.allowsCustomModels,
    lifecycle: definition.lifecycle ?? null,
    available: unavailableReason === null,
    unavailableReason,
    supportsDiscovery: Boolean(registry.get(definition.id)?.discoveryFacet),
    supportsQuota: Boolean(registry.get(definition.id)?.quotaFacet),
    models: definition.models.map((model) => {
      const pricing = pricingByModelId?.get(model.id);
      return modelView(model, 'catalog', pricing ? pricingView(pricing) : undefined);
    }),
  };
}

export function connectionView(
  connection: ProviderConnection,
  definitions: readonly ProviderDefinition[],
  activeTurnCount = 0,
  current?: ProviderIPCServices,
): ProviderConnectionView {
  const definition = definitions.find((item) => item.id === connection.providerId);
  const allowsCustomEndpoint = definition?.allowsCustomModels === true
    && (connection.providerId === 'generic-openai-compatible'
      || connection.providerId === 'generic-anthropic-compatible');
  const cacheFacet = (current ?? services()).registry.get(connection.providerId)?.cacheFacet;
  return {
    id: connection.id,
    providerId: connection.providerId,
    providerDisplayName: definition?.displayName ?? null,
    name: connection.name,
    protocol: connection.protocol,
    authMethod: connection.authMethod,
    credentialKind: connection.credential.kind,
    environmentVariable: connection.credential.kind === 'environment'
      ? connection.credential.variable
      : null,
    modelIds: [...connection.modelIds],
    customModels: (connection.customModels ?? []).map((model) => modelView(model, 'user')),
    health: connection.health,
    activeTurnCount,
    // Generic endpoints are user-owned metadata. Code-owned driver origins are
    // intentionally never rendered or accepted as a renderer-editable field.
    endpoint: allowsCustomEndpoint ? connection.endpoint ?? null : null,
    allowInsecureHttp: connection.allowInsecureHttp === true,
    reasoningConfig: connection.reasoningConfig,
    pricingOverrides: connection.pricingOverrides,
    tierSelections: connection.tierSelections,
    ...(cacheFacet?.ttlOptions ? { cacheTtlOptions: cacheFacet.ttlOptions } : {}),
    ...(cacheFacet?.ttlOptions ? { cacheTtl: connection.cacheTtl ?? null } : {}),
  };
}

export function statusView(observation: ProviderStatusObservation): ProviderStatusView {
  const quota = providerQuotaSchema.safeParse(observation.data['quota']);
  return {
    providerId: observation.providerId,
    ...(observation.connectionId ? { connectionId: observation.connectionId } : {}),
    observedAt: observation.observedAt,
    providerUpdatedAt: observation.providerUpdatedAt,
    availability: observation.availability,
    stale: observation.stale,
    data: structuredClone(observation.data),
    quota: quota.success ? quota.data : null,
    error: observation.error ? { ...observation.error } : null,
  };
}

function secureStorageView(availability: SecureStorageAvailability): ProviderOverview['secureStorage'] {
  return availability.available
    ? { available: true, backend: availability.backend, reason: null }
    : { available: false, backend: null, reason: availability.reason };
}

export async function overview(): Promise<ProviderOverview> {
  const current = services();
  const definitions = current.catalog.getProviderDefinitions();
  const connections = await current.connections.list();
  // Keep destructive-disconnect confirmation honest without making provider
  // status or credential state part of renderer state. The active turn map is
  // process-local and only reports a count for each stable connection ID.
  const activeTurnCounts = new Map(
    connections.map((connection) => [
      connection.id,
      activeSessionsForProviderConnection(connection.id).length,
    ]),
  );
  const connectionProviderIds = new Map(connections.map((connection) => [connection.id, connection.providerId]));
  const statuses = current.status.list()
    .filter((observation) => observation.connectionId === undefined
      || connectionProviderIds.get(observation.connectionId) === observation.providerId)
    .map(statusView);
  const catalogSnapshot = current.catalog.load();
  const pricingByProviderId = new Map<string, ReadonlyMap<string, CatalogPricing>>();
  for (const provider of catalogSnapshot.catalog.providers) {
    pricingByProviderId.set(
      provider.id,
      new Map(provider.models.map((model) => [model.id, model.pricing])),
    );
  }
  return {
    definitions: definitions.map((definition) => definitionView(
      definition,
      current.registry,
      pricingByProviderId.get(definition.id),
    )),
    connections: connections.map((connection) =>
      connectionView(connection, definitions, activeTurnCounts.get(connection.id) ?? 0),
    ),
    statuses,
    secureStorage: secureStorageView(current.vault.getAvailability()),
  };
}

interface ConfigReferenceCleanupOptions {
  readonly homeConfigPath?: string;
  readonly projectDir?: string;
  readonly refreshRuntime?: boolean;
}

export async function clearConnectionConfigReferences(
  connectionId: string,
  options: ConfigReferenceCleanupOptions = {},
) {
  return withConfigSaveLock(async () => {
    const homeConfigPath = options.homeConfigPath ?? HOME_CONFIG_PATH;
    let homeConfig: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(homeConfigPath, 'utf8'));
      if (isPlainObject(parsed)) homeConfig = parsed;
    } catch {
      // Match loadConfig's missing or malformed home-layer behavior.
    }
    const defaultSelection = homeConfig['default_model'];
    const tierSelections = isPlainObject(homeConfig['tier_models'])
      ? homeConfig['tier_models']
      : {};
    const ragConfig = isPlainObject(homeConfig['rag']) ? homeConfig['rag'] : {};
    const embeddingSelection = ragConfig['embedding_api_model'];
    const defaultModel = isPlainObject(defaultSelection)
      && defaultSelection['connectionId'] === connectionId;
    const tierModels = Object.entries(tierSelections)
      .filter(([, selection]) => isPlainObject(selection) && selection['connectionId'] === connectionId)
      .map(([tier]) => tier);
    const ragEmbeddingModel = isPlainObject(embeddingSelection)
      && embeddingSelection['connectionId'] === connectionId;
    if (defaultModel) homeConfig['default_model'] = null;
    for (const tier of tierModels) tierSelections[tier] = null;
    if (ragEmbeddingModel) ragConfig['embedding_api_model'] = null;
    if (defaultModel || tierModels.length > 0 || ragEmbeddingModel) {
      atomicWriteJson(homeConfigPath, homeConfig);
      if (options.refreshRuntime !== false) {
        ConfigManager.reset();
        clearProjectRuntimeRegistry();
        ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
      }
    }
    const config = loadConfig({ projectDir: HOME_CONFIG_DIR, homeConfigPath });
    return {
      config,
      clearedConfigReferences: { defaultModel, tierModels, ragEmbeddingModel },
    };
  });
}

// ── Static connection gate ──────────────────────────────────────────────────

interface StaticConnectionCheck {
  readonly definition: ProviderDefinition;
  readonly genericEndpointOrigin: string | null;
  /** Enabled modelIds with no catalog, custom, or discovered backing; reported, not fatal. */
  readonly orphanedModelIds: readonly string[];
}

/** Shared static gate for persisted and draft connections alike. */
export function requireStaticConnectionSupport(
  connection: ProviderConnection,
  current = services(),
): StaticConnectionCheck {
  const definition = current.catalog.getProviderDefinitions().find(
    (item) => item.id === connection.providerId,
  );
  if (!definition) throw new Error(`Unknown provider '${connection.providerId}'`);
  if (!lifecycleAvailable(definition.lifecycle)) {
    throw new Error(`Provider '${definition.displayName}' is not enabled in this release`);
  }
  const driver = current.registry.require(definition.id);
  if (!definition.supportedAuthMethods.includes(connection.authMethod)
    || !driver.supportedAuthMethods.includes(connection.authMethod)) {
    throw new Error(`Authentication method '${connection.authMethod}' is not supported by '${definition.displayName}'`);
  }
  if (!definition.supportedProtocols.includes(connection.protocol)
    || !driver.supportedProtocols.includes(connection.protocol)) {
    throw new Error(`Protocol '${connection.protocol}' is not supported by '${definition.displayName}'`);
  }

  let genericEndpointOrigin: string | null = null;
  if (driver.allowsCustomEndpoint) {
    if (!connection.endpoint) throw new Error(`'${definition.displayName}' requires a custom endpoint`);
    const endpoint = validateGenericEndpoint(connection.endpoint, {
      allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true,
    });
    genericEndpointOrigin = endpoint.origin;
  } else if (connection.endpoint) {
    throw new Error(`'${definition.displayName}' uses a code-owned endpoint and cannot be redirected`);
  }

  for (const model of connection.customModels ?? []) {
    const overridesCatalogModel = definition.models.some(
      (catalogModel) => catalogModel.id === model.id,
    );
    if (!definition.allowsCustomModels && !overridesCatalogModel) {
      throw new Error(`'${definition.displayName}' does not allow user-defined models`);
    }
    if (model.protocol !== connection.protocol) {
      throw new Error(`Custom model '${model.id}' does not match connection protocol '${connection.protocol}'`);
    }
  }
  const orphanedModelIds: string[] = [];
  for (const modelId of connection.modelIds) {
    const catalogModel = definition.models.find((model) => model.id === modelId);
    const customModel = connection.customModels?.find((model) => model.id === modelId);
    const discoveredModel = connection.discoveredModels?.find((model) => model.id === modelId);
    if (!catalogModel && !customModel && !discoveredModel) {
      // A delisted model must not block every validate/update; the caller
      // reports it as a removable warning instead (finding #11).
      orphanedModelIds.push(modelId);
      continue;
    }
    if (catalogModel && catalogModel.protocol !== connection.protocol) {
      throw new Error(`Model '${modelId}' does not match connection protocol '${connection.protocol}'`);
    }
  }
  return { definition, genericEndpointOrigin, orphanedModelIds };
}

function credentialOrigin(connection: ProviderConnection, current = services()): string | null {
  const driver = current.registry.require(connection.providerId);
  if (driver.allowsCustomEndpoint) {
    return validateGenericEndpoint(connection.endpoint ?? '', {
      allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true,
    }).origin;
  }
  return driver.origin;
}

export function credentialBinding(connection: ProviderConnection, current = services()) {
  if (connection.authMethod !== 'api-key') {
    throw new Error(`Connection '${connection.name}' does not use a stored credential`);
  }
  return normalizeCredentialBinding({
    connectionId: connection.id,
    driverId: connection.providerId,
    authMethod: connection.authMethod,
    origin: credentialOrigin(connection, current),
  });
}

/** Compare only the reference that selects an account, never its secret value. */
export function sameCredentialIdentity(left: ProviderConnection, right: ProviderConnection): boolean {
  if (left.authMethod !== right.authMethod || left.credential.kind !== right.credential.kind) return false;
  if (left.credential.kind === 'stored' && right.credential.kind === 'stored') {
    return left.credential.handle === right.credential.handle;
  }
  if (left.credential.kind === 'environment' && right.credential.kind === 'environment') {
    return left.credential.variable === right.credential.variable;
  }
  return true;
}

function orphanedModelWarning(
  orphanedModelIds: readonly string[],
  definition: ProviderDefinition,
): string {
  const plural = orphanedModelIds.length !== 1;
  const list = orphanedModelIds.map((id) => `'${id}'`).join(', ');
  return `Model${plural ? 's' : ''} ${list} ${plural ? 'are' : 'is'} no longer available from '${definition.displayName}' and should be removed from the connection's enabled models.`;
}

/** Return a safe readiness explanation without rendering any secret material. */
async function readiness(
  connection: ProviderConnection,
  current = services(),
): Promise<{ readonly ready: boolean; readonly message: string | null }> {
  let check: StaticConnectionCheck;
  try {
    check = requireStaticConnectionSupport(connection, current);
  } catch (error) {
    return { ready: false, message: error instanceof Error ? error.message : 'Connection configuration is invalid' };
  }
  const orphanWarning = check.orphanedModelIds.length > 0
    ? orphanedModelWarning(check.orphanedModelIds, check.definition)
    : null;
  if (connection.authMethod === 'none') {
    return connection.credential.kind === 'none'
      ? { ready: true, message: orphanWarning }
      : { ready: false, message: 'No-credential authentication must not retain a credential reference' };
  }
  if (connection.authMethod === 'environment') {
    if (connection.credential.kind !== 'environment') {
      return { ready: false, message: 'Choose an environment variable for this connection' };
    }
    return process.env[connection.credential.variable]
      ? { ready: true, message: orphanWarning }
      : { ready: false, message: `Environment credential '${connection.credential.variable}' is not available` };
  }
  if (connection.credential.kind !== 'stored') {
    return { ready: false, message: 'Authentication is required before this connection can be used' };
  }
  try {
    await current.vault.readSecret(connection.credential.handle, credentialBinding(connection, current));
    return { ready: true, message: orphanWarning };
  } catch {
    return { ready: false, message: 'Stored credentials need to be reconnected' };
  }
}

export function terminalHealthMessage(health: 'disabled' | 'disconnected'): string {
  return health === 'disabled'
    ? 'This connection is disabled. Reconnect or create another connection to use it.'
    : 'This connection is disconnected. Authenticate it again to use it.';
}

/**
 * Refresh readiness and health. Caller must hold `withConnectionMutationLock`
 * for this connection so concurrent disable/disconnect cannot race the write.
 * Only draft|needs_attention|ready may transition to ready/needs_attention.
 */
export async function validateConnection(connectionId: string): Promise<ProviderMutationResult> {
  const current = services();
  const connection = await requireConnection(connectionId);
  if (connection.health === 'disabled' || connection.health === 'disconnected') {
    return {
      connection: connectionView(connection, current.catalog.getProviderDefinitions()),
      message: terminalHealthMessage(connection.health),
    };
  }
  const result = await readiness(connection, current);
  const desiredHealth = result.ready ? 'ready' as const : 'needs_attention' as const;

  // Re-read under the connection mutation lock before writing health so a
  // concurrent disable/disconnect that queued after readiness started cannot
  // be overwritten (only mutable health may become ready/needs_attention).
  const latest = await requireConnection(connectionId);
  if (!isMutableHealth(latest.health)) {
    return {
      connection: connectionView(latest, current.catalog.getProviderDefinitions()),
      message: latest.health === 'disabled' || latest.health === 'disconnected'
        ? terminalHealthMessage(latest.health)
        : result.message,
    };
  }
  const updated = await current.connections.update(connectionId, {
    health: desiredHealth,
  });
  return {
    connection: connectionView(updated, current.catalog.getProviderDefinitions()),
    message: result.message,
  };
}

export async function requireConnection(connectionId: string): Promise<ProviderConnection> {
  const connection = await services().connections.get(connectionId);
  if (!connection) throw new Error(`Unknown provider connection '${connectionId}'`);
  return connection;
}

async function stopProviderConnectionTurns(
  connectionId: string,
  accountingFailureOutcome: string,
  restoreHealth?: () => Promise<unknown>,
): Promise<readonly string[]> {
  try {
    const stoppedSessionIds = stopActiveProviderConnectionTurns(connectionId);
    if (stoppedSessionIds.length > 0) {
      getProviderAccountingStore().interruptPendingForConnection(connectionId);
    }
    return stoppedSessionIds;
  } catch (error) {
    await restoreHealth?.();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not finalize active provider accounting; ${accountingFailureOutcome}: ${detail}`,
      { cause: error },
    );
  }
}

/** providers.disable — freeze a connection against new requests (read-side host op). */
export async function disableConnection(connectionId: string): Promise<ProviderMutationResult> {
  const current = services();
  const connection = await requireConnection(connectionId);
  const updated = await current.connections.update(connection.id, { health: 'disabled' });
  return {
    connection: connectionView(
      updated,
      current.catalog.getProviderDefinitions(),
      activeSessionsForProviderConnection(connection.id).length,
    ),
    message: 'The connection is disabled for new requests. Any active turn can finish safely.',
  } satisfies ProviderMutationResult;
}

/** providers.enable — restore a disabled connection and re-validate it. */
export async function enableConnection(connectionId: string): Promise<ProviderMutationResult> {
  const current = services();
  const connection = await requireConnection(connectionId);
  if (connection.health === 'disconnected') {
    return {
      connection: connectionView(connection, current.catalog.getProviderDefinitions()),
      message: 'Authenticate this disconnected connection before enabling it.',
    } satisfies ProviderMutationResult;
  }
  await current.connections.update(connection.id, { health: 'draft' });
  return validateConnection(connection.id);
}

/** providers.disconnect — erase stored credentials and mark the connection disconnected. */
export async function disconnectConnection(connectionId: string): Promise<ProviderMutationResult> {
  const current = services();
  const connection = await requireConnection(connectionId);
  // KTD15: stop only turns already frozen to this connection. Their ledger
  // rows are then finalized as interrupted before the credential is erased.
  const stoppedSessionIds = await stopProviderConnectionTurns(
    connection.id,
    'credentials were not removed',
  );
  await current.vault.deleteConnectionCredentials(connection.id);
  const updated = await current.connections.update(connection.id, {
    credential: { kind: 'none' },
    health: 'disconnected',
  });
  if (!sameCredentialIdentity(connection, updated)) {
    current.status.invalidate(connection.providerId, connection.id);
    current.pricing?.invalidate(connection.providerId, connection.id);
  }
  return {
    connection: connectionView(updated, current.catalog.getProviderDefinitions()),
    message: stoppedSessionIds.length > 0
      ? `Cancelled ${stoppedSessionIds.length} active turn${stoppedSessionIds.length === 1 ? '' : 's'} and finalized its accounting before removing stored credentials. Revoke any upstream authorization or generated key from the provider account if needed.`
      : 'Stored credentials were removed. Revoke any upstream authorization or generated key from the provider account if needed.',
  } satisfies ProviderMutationResult;
}

/** providers.delete — remove a connection plus its config references. */
export async function deleteConnection(connectionId: string): Promise<ProviderDeleteConnectionResult> {
  const current = services();
  const connection = await requireConnection(connectionId);
  const previousHealth = connection.health;
  let disabledForDeletion = false;
  if (previousHealth !== 'disabled' && previousHealth !== 'disconnected') {
    await current.connections.update(connection.id, { health: 'disabled' });
    disabledForDeletion = true;
  }
  const stoppedSessionIds = await stopProviderConnectionTurns(
    connection.id,
    'the connection was not deleted',
    disabledForDeletion
      ? () => current.connections.update(connection.id, { health: previousHealth })
      : undefined,
  );
  await current.vault.deleteConnectionCredentials(connection.id);
  await current.connections.update(connection.id, {
    credential: { kind: 'none' },
    health: 'disconnected',
  });
  const configResult = await (current.clearConfigReferences ?? clearConnectionConfigReferences)(connection.id);
  current.status.invalidate(connection.providerId, connection.id);
  current.pricing?.invalidate(connection.providerId, connection.id);
  const removed = await current.connections.remove(connection.id);
  if (!removed) throw new Error(`Unknown provider connection '${connection.id}'`);
  return {
    connectionId: connection.id,
    message: stoppedSessionIds.length > 0
      ? `Cancelled ${stoppedSessionIds.length} active turn${stoppedSessionIds.length === 1 ? '' : 's'} and deleted the connection.`
      : 'The connection was deleted. Historical sessions and accounting were preserved.',
    config: configResult.config,
    clearedConfigReferences: configResult.clearedConfigReferences,
  } satisfies ProviderDeleteConnectionResult;
}

// ── Live model discovery ────────────────────────────────────────────────────

/**
 * Resolve the request credential for one discovery fetch. `none`-auth
 * connections fetch unauthenticated (local compatible endpoints commonly serve
 * /models without auth); undefined means no usable credential right now.
 */
export async function discoveryCredential(
  connection: ProviderConnection,
  current: ProviderIPCServices,
): Promise<DriverCredential | undefined> {
  if (connection.authMethod === 'none') return { kind: 'none' };
  if (connection.credential.kind === 'environment') {
    const apiKey = process.env[connection.credential.variable];
    return apiKey ? { kind: 'api-key', apiKey } : undefined;
  }
  if (connection.credential.kind !== 'stored') return undefined;
  try {
    const secret = await current.vault.readSecret(
      connection.credential.handle,
      credentialBinding(connection, current),
    );
    return secret.kind === 'api-key' ? { kind: 'api-key', apiKey: secret.apiKey } : undefined;
  } catch {
    return undefined;
  }
}

/** Copy a selection record without the ids a fresh snapshot no longer backs. */
export function dropRecordKeys<T extends Record<string, unknown>>(
  record: T | undefined,
  dropIds: readonly string[],
): T | undefined {
  if (record === undefined || dropIds.length === 0) return record;
  const drop = new Set(dropIds);
  const entries = Object.entries(record).filter(([id]) => !drop.has(id));
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T);
}

/**
 * Run one on-demand discovery fetch and persist the fresh snapshot. Returns
 * null when the driver publishes no models endpoint. Endpoint failures keep
 * catalog/custom models intact and surface only a redacted message.
 */
export async function runConnectionDiscovery(
  connectionId: string,
  current: ProviderIPCServices,
): Promise<ConnectionDiscoveryOutcome | null> {
  const connection = await current.connections.get(connectionId);
  if (!connection) return null;
  const definition = current.catalog.getProviderDefinitions().find(
    (item) => item.id === connection.providerId,
  );
  const driver = definition ? current.registry.get(definition.id) : undefined;
  if (!definition || !driver?.discoveryFacet) return null;
  const outcome = await discoverConnectionModels({
    driver,
    connection,
    provider: definition,
    credential: await discoveryCredential(connection, current),
  });
  if (outcome.status === 'ok') {
    const prunedModelIds = outcome.prune.modelIds.length > 0
      ? connection.modelIds.filter((id) => !outcome.prune.modelIds.includes(id))
      : undefined;
    const prunedTierSelections = outcome.prune.tierSelections.length > 0
      ? dropRecordKeys(connection.tierSelections, outcome.prune.tierSelections) ?? {}
      : undefined;
    const prunedReasoningConfig = outcome.prune.reasoningConfig.length > 0
      ? dropRecordKeys(
          outcome.reasoningConfig ?? connection.reasoningConfig,
          outcome.prune.reasoningConfig,
        ) ?? {}
      : outcome.reasoningConfig;
    await current.connections.update(connectionId, {
      discoveredModels: [...outcome.discoveredModels],
      ...(prunedReasoningConfig ? { reasoningConfig: prunedReasoningConfig } : {}),
      ...(prunedModelIds ? { modelIds: prunedModelIds } : {}),
      ...(prunedTierSelections ? { tierSelections: prunedTierSelections } : {}),
    });
  }
  return outcome;
}

/** Non-blocking discovery detail attached to an automatic (create/auth) flow. */
export function automaticDiscoveryMessage(outcome: ConnectionDiscoveryOutcome): string | null {
  switch (outcome.status) {
    case 'ok':
      return outcome.addedModelIds.length > 0
        ? `Discovered ${outcome.addedModelIds.length} new model${outcome.addedModelIds.length === 1 ? '' : 's'} from the live provider endpoint.`
        : null;
    case 'failed':
      return `Live model discovery failed (${outcome.message}); catalog and custom models are unchanged.`;
    default:
      return null;
  }
}

/** Attach a non-blocking discovery note to an otherwise-finished mutation. */
export async function withDiscoveryOutcome(
  connectionId: string,
  result: ProviderMutationResult,
  current: ProviderIPCServices,
): Promise<ProviderMutationResult> {
  const outcome = await runConnectionDiscovery(connectionId, current);
  const message = outcome ? automaticDiscoveryMessage(outcome) : null;
  if (!message) return result;
  return {
    connection: connectionView(
      await requireConnection(connectionId),
      current.catalog.getProviderDefinitions(),
      result.connection.activeTurnCount,
    ),
    message: result.message ? `${result.message} ${message}` : message,
  };
}

export function genericOrigin(connection: ProviderConnection, current: ProviderIPCServices): string | null {
  const driver = current.registry.require(connection.providerId);
  if (!driver.allowsCustomEndpoint) return null;
  if (!connection.endpoint) return null;
  return validateGenericEndpoint(connection.endpoint, {
    allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true,
  }).origin;
}

export async function refreshStatus(
  providerId: string,
  connectionId: string | undefined,
): Promise<ProviderStatusObservation | null> {
  const current = services();
  if (providerId === 'lilac') {
    return (await current.status.refresh(createLilacStatusSource(), { manual: true })).observation;
  }
  if (providerId !== 'neuralwatt') return current.status.get(providerId) ?? null;
  if (!connectionId) {
    throw new Error('Neuralwatt status refresh requires a connection');
  }
  const connection = await requireConnection(connectionId);
  if (connection.providerId !== 'neuralwatt') {
    throw new Error('The requested connection does not belong to Neuralwatt');
  }
  const apiKey = await readApiKeyForTrustedStatus(connection, current);
  return (await current.status.refresh(createNeuralwattQuotaStatusSource(connection.id, apiKey), { manual: true })).observation;
}

export async function readApiKeyForTrustedStatus(
  connection: ProviderConnection,
  current: ProviderIPCServices,
): Promise<string> {
  if (connection.credential.kind === 'environment') {
    const value = process.env[connection.credential.variable];
    if (!value) throw new Error(`Environment credential '${connection.credential.variable}' is not available`);
    return value;
  }
  if (connection.credential.kind !== 'stored') {
    throw new Error(`Connection '${connection.name}' has no credential for status refresh`);
  }
  const secret: CredentialSecret = await current.vault.readSecret(
    connection.credential.handle,
    credentialBinding(connection, current),
  );
  if (secret.kind !== 'api-key') throw new Error(`Connection '${connection.name}' does not have an API key credential`);
  return secret.apiKey;
}

// ── Model options (providers.model_list) ─────────────────────────────────────

async function modelOptions(
  connectionId?: string,
  includeDisabled = false,
): Promise<readonly ProviderModelOption[]> {
  const current = services();
  const definitions = current.catalog.getProviderDefinitions();
  const connections = await current.connections.list();
  const selectedConnections = connectionId
    ? connections.filter((connection) => connection.id === connectionId)
    : connections;
  if (connectionId && selectedConnections.length === 0) {
    throw new Error(`Unknown provider connection '${connectionId}'`);
  }
  const options: ProviderModelOption[] = [];
  const catalogSnapshot = current.catalog.load();
  const catalogPricingByProviderId = new Map<string, ReadonlyMap<string, CatalogPricing>>();
  for (const provider of catalogSnapshot.catalog.providers) {
    catalogPricingByProviderId.set(
      provider.id,
      new Map(provider.models.map((model) => [model.id, model.pricing])),
    );
  }
  for (const connection of selectedConnections) {
    const definition = definitions.find((item) => item.id === connection.providerId);
    if (!definition) continue;
    const driver = current.registry.get(definition.id);
    const tierMechanism = driver?.tierMechanism;
    const providerCatalogPricing = catalogPricingByProviderId.get(connection.providerId);
    const { rows, variantTiersByBase } = groupTierVariantRows(
      listConnectionModelRows(connection, definition),
      tierMechanism?.kind === 'model-name-variants' ? tierMechanism : undefined,
    );
    for (const row of rows) {
      if (!includeDisabled && !row.enabled) continue;
      const selection = { connectionId: connection.id, modelId: row.model.id };
      const resolution = row.enabled
        ? resolveModelSelection(selection, connections, definitions)
        : null;
      const available = resolution !== null && resolution.kind === 'resolved';
      const unavailableReason = resolution === null
        ? 'Enable this model on the connection to use it.'
        : available
          ? null
          : resolution.kind === 'unavailable'
            ? humanizeUnavailableReason(resolution.reason)
            : resolution.kind === 'provider-required'
              ? 'A ready provider connection is required.'
              : 'Choose a model before sending.';
      // Variant rows fold under the base; the selector offers only the tiers
      // whose variants were actually present for this base model (R20).
      const variantTierIds = variantTiersByBase.get(row.model.id);
      const tierOptions = tierMechanism && (tierMechanism.kind !== 'model-name-variants' || variantTierIds)
        ? {
            mechanism: tierMechanism.kind,
            tiers: (tierMechanism.kind === 'model-name-variants' && variantTierIds
              ? tierMechanism.tiers.filter((tier) => variantTierIds.includes(tier.id))
              : tierMechanism.tiers
            ).map((tier) => ({
              id: tier.id,
              displayName: tier.displayName ?? null,
              description: tier.description ?? null,
              ...(tierMechanism.kind === 'model-name-variants'
                && (tier as { requiresStreaming?: boolean }).requiresStreaming === true
                ? { requiresStreaming: true }
                : {}),
            })),
            selected: connection.tierSelections?.[row.model.id] ?? null,
          }
        : undefined;
      const pricingOverride = connection.pricingOverrides?.[row.model.id];
      const catalogPricing = row.source === 'catalog'
        ? providerCatalogPricing?.get(row.model.id)
        : undefined;
      options.push({
        selection,
        connectionName: connection.name,
        providerId: connection.providerId,
        providerDisplayName: definition.displayName,
        model: modelView(
          row.model,
          row.source,
          catalogPricing ? pricingView(catalogPricing) : undefined,
        ),
        enabled: row.enabled,
        customized: row.customized,
        discoveredAt: row.discoveredAt,
        available,
        unavailableReason,
        embeddingSupported: Boolean(driver?.createEmbeddingTarget),
        ...(pricingOverride ? { pricingOverrides: pricingOverride } : {}),
        ...(tierOptions ? { tierOptions } : {}),
      });
    }
  }
  return options.sort((left, right) => {
    const provider = (left.providerDisplayName ?? left.providerId).localeCompare(
      right.providerDisplayName ?? right.providerId,
    );
    if (provider !== 0) return provider;
    const connection = left.connectionName.localeCompare(right.connectionName);
    return connection !== 0 ? connection : left.model.displayName.localeCompare(right.model.displayName);
  });
}

/** providers.model_list — unified per-connection model listing. */
export function listModelOptions(
  connectionId?: string,
  includeDisabled?: boolean,
): Promise<readonly ProviderModelOption[]> {
  return modelOptions(connectionId, includeDisabled === true);
}

function humanizeUnavailableReason(reason: string): string {
  switch (reason) {
    case 'connection-not-ready': return 'Reconnect or validate this connection before using it.';
    case 'provider-disabled': return 'This provider is disabled in the current catalog.';
    case 'model-disabled': return 'This model is disabled in the current catalog.';
    case 'unsupported-connection': return 'This connection no longer matches the trusted driver contract.';
    case 'provider-mismatch': return 'This model requires a different protocol.';
    case 'missing-model': return 'This model is no longer available on the connection.';
    default: return 'This model selection is unavailable.';
  }
}

function manualDiscoveryMessage(outcome: ConnectionDiscoveryOutcome): string {
  switch (outcome.status) {
    case 'ok':
      return outcome.addedModelIds.length > 0
        ? `Discovered ${outcome.addedModelIds.length} new model${outcome.addedModelIds.length === 1 ? '' : 's'}; ${outcome.discoveredModels.length} provider model${outcome.discoveredModels.length === 1 ? '' : 's'} are tracked on this connection.`
        : `Refreshed ${outcome.discoveredModels.length} provider model${outcome.discoveredModels.length === 1 ? '' : 's'} from the live endpoint.`;
    case 'failed':
      return `Live model discovery failed (${outcome.message}); catalog and custom models are unchanged.`;
    case 'no-credential':
      return 'Connect a working credential before discovering models.';
    case 'unsupported':
      return 'This provider does not publish a models endpoint Orchid can read.';
  }
}

/** providers.discover_models — manual live discovery against one connection. */
export async function discoverModels(
  connectionId: string,
): Promise<import('../../shared/types/ipc').ProviderDiscoverModelsResult> {
  return withConnectionMutationLock(connectionId, async () => {
    const current = services();
    const connection = await requireConnection(connectionId);
    const outcome = await runConnectionDiscovery(connection.id, current)
      ?? {
        status: 'unsupported' as const,
        discoveredModels: connection.discoveredModels ?? [],
        addedModelIds: [],
        reasoningConfig: undefined,
        prune: { modelIds: [], tierSelections: [], reasoningConfig: [] },
        message: null,
      };
    return {
      connection: connectionView(
        await requireConnection(connection.id),
        current.catalog.getProviderDefinitions(),
      ),
      status: outcome.status,
      discoveredModelCount: outcome.discoveredModels.length,
      addedModelIds: outcome.addedModelIds,
      message: manualDiscoveryMessage(outcome),
    } satisfies import('../../shared/types/ipc').ProviderDiscoverModelsResult;
  });
}

// ── Quota refresh (providers.quota_refresh) ──────────────────────────────────

const QUOTA_REFRESH_TTL_MS = 5 * 60_000;
const QUOTA_REFRESH_MINIMUM_MANUAL_MS = 30_000;

/**
 * Explicit typed-quota refresh (R24). It resolves the connection's driver quota
 * hook through the status service's TTL/manual-minimum path; a quota failure
 * degrades to a stale/unavailable observation and never gates the connection.
 */
export async function refreshQuota(connectionId: string): Promise<ProviderStatusObservation | null> {
  const current = services();
  const connection = await requireConnection(connectionId);
  const driver = current.registry.require(connection.providerId);
  if (!driver.quotaFacet) return current.status.get(connection.providerId) ?? null;
  return (await current.status.refresh({
    providerId: connection.providerId,
    ttlMs: QUOTA_REFRESH_TTL_MS,
    minimumManualRefreshMs: QUOTA_REFRESH_MINIMUM_MANUAL_MS,
    fetchStatus: async () => {
      const quota = await driver.quotaFacet!.fetchQuota({
        connection,
        provider: requireProviderDefinition(current, connection.providerId),
        credential: await credentialForQuota(connection, current),
      });
      return {
        providerId: connection.providerId,
        observedAt: quota.observedAt,
        providerUpdatedAt: quota.observedAt,
        availability: 'available',
        stale: false,
        data: { quota },
      };
    },
  }, { manual: true })).observation;
}

function requireProviderDefinition(
  current: ProviderIPCServices,
  providerId: string,
): ProviderDefinition {
  const definition = current.catalog.getProviderDefinitions().find((item) => item.id === providerId);
  if (!definition) throw new Error(`Provider definition '${providerId}' is unavailable`);
  return definition;
}

async function credentialForQuota(
  connection: ProviderConnection,
  current: ProviderIPCServices,
): Promise<DriverCredential> {
  const apiKey = await readApiKeyForTrustedStatus(connection, current);
  return { kind: 'api-key', apiKey };
}

// Re-export schemas the IPC layer composes its create/update intents from so
// both boundaries share one definition site.
export {
  customConnectionModelSchema,
  environmentVariableSchema,
  providerAuthMethodSchema,
  providerEndpointSchema,
  providerProtocolSchema,
  reasoningModelConfigSchema,
  pricingRateFieldsSchema,
  idSchema,
};
