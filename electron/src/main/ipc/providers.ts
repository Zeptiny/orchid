/**
 * Provider IPC — connection-centered, intent-only renderer boundary.
 *
 * The renderer may select a catalog preset, name a connection, and submit a
 * one-shot credential. It never receives a credential handle, API key,
 * driver origin, or executable driver configuration.
 */
import * as fs from 'node:fs';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  ProviderDeleteConnectionResult,
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderModelOption,
  ProviderModelView,
  ProviderMutationResult,
  ProviderOverview,
  ProviderStatusView,
} from '../../shared/types/ipc';
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
} from '../providers/runtime-context';
import type { ConnectionStore } from '../providers/connection-store';
import type { ProviderCatalogStore } from '../providers/catalog/store';
import {
  CredentialVault,
  createEnvironmentCredentialReference,
  normalizeCredentialBinding,
  type CredentialSecret,
  type SecureStorageAvailability,
} from '../providers/credentials/vault';
import { resolveModelSelection } from '../providers/resolver';
import {
  ProviderDriverRegistry,
  createDefaultProviderDriverRegistry,
} from '../providers/drivers/registry';
import { validateGenericEndpoint } from '../providers/drivers/compatible';
import { createLilacStatusSource } from '../providers/drivers/lilac';
import {
  createNeuralwattStatusSource,
} from '../providers/drivers/neuralwatt';
import type { ProviderStatusObservation } from '../providers/status/cache';
import type { ProviderStatusService } from '../providers/status/service';
import { getProviderAccountingStore } from '../providers/accounting/store';
import {
  atomicWriteJson,
  ConfigManager,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  loadConfig,
} from '../config/loader';
import { isPlainObject } from '../config/merge';
import { clearProjectRuntimeRegistry } from '../project/runtime';
import { withConfigSaveLock } from './config';

// ── Renderer input schemas ──────────────────────────────────────────────────

const idSchema = z.string().uuid();
const modelIdsSchema = z.array(z.string().trim().min(1)).max(500).default([]);

const createConnectionSchema = z.object({
  providerId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  protocol: providerProtocolSchema,
  authMethod: providerAuthMethodSchema,
  modelIds: modelIdsSchema,
  customModels: z.array(customConnectionModelSchema).max(500).optional(),
  endpoint: providerEndpointSchema.nullable().optional(),
  allowInsecureHttp: z.boolean().optional(),
  environmentVariable: environmentVariableSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMethod === 'environment' && !value.environmentVariable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'Environment authentication requires an environment variable name',
    });
  }
  if (value.authMethod !== 'environment' && value.environmentVariable !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'An environment variable is valid only for environment authentication',
    });
  }
});

const updateConnectionSchema = z.object({
  connectionId: idSchema,
  name: z.string().trim().min(1).max(120).optional(),
  authMethod: providerAuthMethodSchema.optional(),
  modelIds: modelIdsSchema.optional(),
  customModels: z.array(customConnectionModelSchema).max(500).optional(),
  reasoningConfig: z.record(z.string(), reasoningModelConfigSchema).optional(),
  endpoint: providerEndpointSchema.nullable().optional(),
  allowInsecureHttp: z.boolean().optional(),
  environmentVariable: environmentVariableSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authMethod === 'environment' && !value.environmentVariable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'Environment authentication requires an environment variable name',
    });
  }
  if (value.authMethod !== undefined
    && value.authMethod !== 'environment'
    && value.environmentVariable !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['environmentVariable'],
      message: 'An environment variable is valid only for environment authentication',
    });
  }
}).refine((value) => Object.keys(value).some((key) => key !== 'connectionId'), {
  message: 'Provide at least one connection field to update',
});

const submitApiKeySchema = z.object({
  connectionId: idSchema,
  // The value exists only for this validated IPC request. Do not log this schema
  // error or payload because it may include a usable credential.
  apiKey: z.string().trim().min(1).max(32_768),
}).strict();

const connectionIdSchema = z.object({ connectionId: idSchema }).strict();
const disconnectSchema = connectionIdSchema.extend({ confirm: z.literal(true) }).strict();
const deleteConnectionSchema = connectionIdSchema.extend({ confirm: z.literal(true) }).strict();
const statusRefreshSchema = z.object({
  providerId: z.string().trim().min(1),
  connectionId: idSchema.optional(),
}).strict();
// ── Main-process dependency boundary ────────────────────────────────────────

interface ProviderIPCServices {
  readonly catalog: Pick<ProviderCatalogStore, 'getProviderDefinitions' | 'load'>;
  readonly connections: Pick<ConnectionStore, 'list' | 'get' | 'create' | 'update' | 'remove'>;
  readonly vault: Pick<CredentialVault,
    'getAvailability' | 'replaceConnectionApiKey' | 'readSecret' | 'deleteConnectionCredentials'>;
  readonly status: Pick<ProviderStatusService, 'get' | 'list' | 'refresh' | 'invalidate'>;
  readonly registry: ProviderDriverRegistry;
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

function services(): ProviderIPCServices {
  if (testServices) return testServices;
  return {
    catalog: getProviderCatalogStore(),
    connections: getProviderConnectionStore(),
    vault: getProviderCredentialVault(),
    status: getProviderStatusService(),
    registry: getCachedDriverRegistry(),
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

function withConnectionMutationLock<T>(
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

function modelView(
  model: ProviderModelDefinition,
  source: 'catalog' | 'connection',
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
  };
}

function definitionView(
  definition: ProviderDefinition,
  registry: ProviderDriverRegistry,
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
    models: definition.models.map((model) => modelView(model, 'catalog')),
  };
}

function connectionView(
  connection: ProviderConnection,
  definitions: readonly ProviderDefinition[],
  activeTurnCount = 0,
): ProviderConnectionView {
  const definition = definitions.find((item) => item.id === connection.providerId);
  const allowsCustomEndpoint = definition?.allowsCustomModels === true
    && (connection.providerId === 'generic-openai-compatible'
      || connection.providerId === 'generic-anthropic-compatible');
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
    customModels: (connection.customModels ?? []).map((model) => modelView(model, 'connection')),
    health: connection.health,
    activeTurnCount,
    // Generic endpoints are user-owned metadata. Code-owned driver origins are
    // intentionally never rendered or accepted as a renderer-editable field.
    endpoint: allowsCustomEndpoint ? connection.endpoint ?? null : null,
    allowInsecureHttp: connection.allowInsecureHttp === true,
    reasoningConfig: connection.reasoningConfig,
  };
}

function statusView(observation: ProviderStatusObservation): ProviderStatusView {
  return {
    providerId: observation.providerId,
    ...(observation.connectionId ? { connectionId: observation.connectionId } : {}),
    observedAt: observation.observedAt,
    providerUpdatedAt: observation.providerUpdatedAt,
    availability: observation.availability,
    stale: observation.stale,
    data: structuredClone(observation.data),
    error: observation.error ? { ...observation.error } : null,
  };
}

function secureStorageView(availability: SecureStorageAvailability): ProviderOverview['secureStorage'] {
  return availability.available
    ? { available: true, backend: availability.backend, reason: null }
    : { available: false, backend: null, reason: availability.reason };
}

async function overview(): Promise<ProviderOverview> {
  const current = services();
  const definitions = current.catalog.getProviderDefinitions();
  const connections = await current.connections.list();
  // Keep destructive-disconnect confirmation honest without making provider
  // status or credential state part of renderer state. The active turn map is
  // process-local and only reports a count for each stable connection ID.
  const { activeSessionsForProviderConnection } = await import('./chat');
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
  return {
    definitions: definitions.map((definition) => definitionView(definition, current.registry)),
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
}

function requireStaticConnectionSupport(
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
  for (const modelId of connection.modelIds) {
    const catalogModel = definition.models.find((model) => model.id === modelId);
    const customModel = connection.customModels?.find((model) => model.id === modelId);
    if (!catalogModel && !customModel) {
      throw new Error(definition.allowsCustomModels
        ? `User-defined model '${modelId}' requires explicit capabilities and limits`
        : `Model '${modelId}' is not available for '${definition.displayName}'`);
    }
    if (catalogModel && catalogModel.protocol !== connection.protocol) {
      throw new Error(`Model '${modelId}' does not match connection protocol '${connection.protocol}'`);
    }
  }
  return { definition, genericEndpointOrigin };
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

function credentialBinding(connection: ProviderConnection, current = services()) {
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
function sameCredentialIdentity(left: ProviderConnection, right: ProviderConnection): boolean {
  if (left.authMethod !== right.authMethod || left.credential.kind !== right.credential.kind) return false;
  if (left.credential.kind === 'stored' && right.credential.kind === 'stored') {
    return left.credential.handle === right.credential.handle;
  }
  if (left.credential.kind === 'environment' && right.credential.kind === 'environment') {
    return left.credential.variable === right.credential.variable;
  }
  return true;
}

/** Return a safe readiness explanation without rendering any secret material. */
async function readiness(
  connection: ProviderConnection,
  current = services(),
): Promise<{ readonly ready: boolean; readonly message: string | null }> {
  try {
    requireStaticConnectionSupport(connection, current);
  } catch (error) {
    return { ready: false, message: error instanceof Error ? error.message : 'Connection configuration is invalid' };
  }
  if (connection.authMethod === 'none') {
    return connection.credential.kind === 'none'
      ? { ready: true, message: null }
      : { ready: false, message: 'No-credential authentication must not retain a credential reference' };
  }
  if (connection.authMethod === 'environment') {
    if (connection.credential.kind !== 'environment') {
      return { ready: false, message: 'Choose an environment variable for this connection' };
    }
    return process.env[connection.credential.variable]
      ? { ready: true, message: null }
      : { ready: false, message: `Environment credential '${connection.credential.variable}' is not available` };
  }
  if (connection.credential.kind !== 'stored') {
    return { ready: false, message: 'Authentication is required before this connection can be used' };
  }
  try {
    await current.vault.readSecret(connection.credential.handle, credentialBinding(connection, current));
    return { ready: true, message: null };
  } catch {
    return { ready: false, message: 'Stored credentials need to be reconnected' };
  }
}

function terminalHealthMessage(health: 'disabled' | 'disconnected'): string {
  return health === 'disabled'
    ? 'This connection is disabled. Reconnect or create another connection to use it.'
    : 'This connection is disconnected. Authenticate it again to use it.';
}

/**
 * Refresh readiness and health. Caller must hold `withConnectionMutationLock`
 * for this connection so concurrent disable/disconnect cannot race the write.
 * Only draft|needs_attention|ready may transition to ready/needs_attention.
 */
async function validateConnection(connectionId: string): Promise<ProviderMutationResult> {
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

async function requireConnection(connectionId: string): Promise<ProviderConnection> {
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
    const { stopActiveProviderConnectionTurns } = await import('./chat');
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

// ── Model options ───────────────────────────────────────────────────────────

function candidateModels(
  connection: ProviderConnection,
  definition: ProviderDefinition,
): Array<{ readonly model: ProviderModelDefinition; readonly source: 'catalog' | 'connection' }> {
  const candidates: Array<{ model: ProviderModelDefinition; source: 'catalog' | 'connection' }> = [];
  for (const id of connection.modelIds) {
    const customModel = connection.customModels?.find(
      (model) => model.id === id && model.protocol === connection.protocol,
    );
    if (customModel) {
      candidates.push({ model: customModel, source: 'connection' });
      continue;
    }
    const catalogModel = definition.models.find(
      (model) => model.id === id && model.protocol === connection.protocol,
    );
    if (catalogModel) {
      candidates.push({ model: catalogModel, source: 'catalog' });
      continue;
    }
    candidates.push({
      source: 'connection',
      model: { id, displayName: id, protocol: connection.protocol },
    });
  }
  return candidates;
}

async function modelOptions(connectionId?: string): Promise<readonly ProviderModelOption[]> {
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
  for (const connection of selectedConnections) {
    const definition = definitions.find((item) => item.id === connection.providerId);
    if (!definition) continue;
    for (const candidate of candidateModels(connection, definition)) {
      const selection = { connectionId: connection.id, modelId: candidate.model.id };
      const resolution = resolveModelSelection(selection, connections, definitions);
      const available = resolution.kind === 'resolved';
      const unavailableReason = available
        ? null
        : resolution.kind === 'unavailable'
          ? humanizeUnavailableReason(resolution.reason)
          : resolution.kind === 'provider-required'
            ? 'A ready provider connection is required.'
            : 'Choose a model before sending.';
      options.push({
        selection,
        connectionName: connection.name,
        providerId: connection.providerId,
        providerDisplayName: definition.displayName,
        model: modelView(candidate.model, candidate.source),
        available,
        unavailableReason,
        embeddingSupported: Boolean(current.registry.get(definition.id)?.createEmbeddingTarget),
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

// ── Registration ────────────────────────────────────────────────────────────

export function registerProviderIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, async () => overview());

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_CREATE, async (_event, payload: unknown) => {
    const parsed = createConnectionSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:create payload');
    const current = services();
    const credential = parsed.data.authMethod === 'environment'
      ? createEnvironmentCredentialReference(parsed.data.environmentVariable!)
      : { kind: 'none' as const };
    const draftConnection = {
      id: '00000000-0000-4000-8000-000000000001',
      providerId: parsed.data.providerId,
      name: parsed.data.name,
      protocol: parsed.data.protocol,
      authMethod: parsed.data.authMethod,
      credential,
      modelIds: parsed.data.modelIds,
      ...(parsed.data.customModels ? { customModels: parsed.data.customModels } : {}),
      ...(parsed.data.endpoint !== undefined ? { endpoint: parsed.data.endpoint } : {}),
      ...(parsed.data.allowInsecureHttp !== undefined
        ? { allowInsecureHttp: parsed.data.allowInsecureHttp }
        : {}),
      health: parsed.data.authMethod === 'none' ? 'ready' : 'draft',
    } satisfies ProviderConnection;
    // Reject malformed, disabled, or unsupported connections before anything
    // is persisted. This is also the boundary that prevents renderer data from
    // selecting a driver/origin outside trusted code.
    requireStaticConnectionSupport(draftConnection, current);
    const { id: _draftId, ...createInput } = draftConnection;
    const catalogModels = current.catalog.load().catalog.providers
      .find((provider) => provider.id === parsed.data.providerId)
      ?.models;
    const connection = await current.connections.create(createInput, catalogModels);
    return withConnectionMutationLock(connection.id, () => validateConnection(connection.id));
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_UPDATE, async (_event, payload: unknown) => {
    const parsed = updateConnectionSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:update payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const existing = await requireConnection(parsed.data.connectionId);
      const nextAuthMethod = parsed.data.authMethod ?? existing.authMethod;
      const authMethodChanged = nextAuthMethod !== existing.authMethod;
      const patch = {
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.authMethod === undefined ? {} : { authMethod: parsed.data.authMethod }),
        ...(parsed.data.modelIds === undefined ? {} : { modelIds: parsed.data.modelIds }),
        ...(parsed.data.customModels === undefined ? {} : { customModels: parsed.data.customModels }),
        ...(parsed.data.reasoningConfig === undefined ? {} : { reasoningConfig: parsed.data.reasoningConfig }),
        ...(parsed.data.endpoint === undefined ? {} : { endpoint: parsed.data.endpoint }),
        ...(parsed.data.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: parsed.data.allowInsecureHttp }),
      };
      if (parsed.data.environmentVariable !== undefined) {
        if (nextAuthMethod !== 'environment') {
          throw new Error('Only environment-authenticated connections can change an environment reference');
        }
        Object.assign(patch, {
          credential: createEnvironmentCredentialReference(parsed.data.environmentVariable),
          health: 'draft' as const,
        });
      } else if (authMethodChanged) {
        Object.assign(patch, {
          credential: { kind: 'none' as const },
          health: nextAuthMethod === 'none' ? 'ready' as const : 'draft' as const,
        });
      }
      const candidate = { ...existing, ...patch } as ProviderConnection;
      requireStaticConnectionSupport(candidate, current);

      // Generic credentials are destination-bound. An origin change must erase
      // a stored secret or require the renderer to explicitly reconfirm the
      // environment reference in the same intent before the endpoint is usable.
      const endpointChanged = parsed.data.endpoint !== undefined
        && genericOrigin(existing, current) !== genericOrigin(candidate, current);
      if (existing.credential.kind === 'stored' && (authMethodChanged || endpointChanged)) {
        await current.vault.deleteConnectionCredentials(existing.id);
      }
      if (endpointChanged && nextAuthMethod === 'api-key') {
        Object.assign(patch, { credential: { kind: 'none' as const }, health: 'draft' });
      } else if (
        endpointChanged
        && nextAuthMethod === 'environment'
        && parsed.data.environmentVariable === undefined
      ) {
        Object.assign(patch, { credential: { kind: 'none' as const }, health: 'draft' });
      }
      const updated = await current.connections.update(existing.id, patch);
      if (!sameCredentialIdentity(existing, updated)) {
        current.status.invalidate(existing.providerId, existing.id);
      }
      return validateConnection(existing.id);
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY, async (_event, payload: unknown) => {
    const parsed = submitApiKeySchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:submit_api_key payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
      if (connection.health === 'disabled') {
        throw new Error(
          `Connection '${connection.name}' is disabled. Enable it before submitting a credential.`,
        );
      }
      // disconnected is allowed: submit is the re-auth path after disconnect.
      if (connection.authMethod !== 'api-key') {
        throw new Error(`Connection '${connection.name}' does not accept an API key`);
      }
      requireStaticConnectionSupport(connection, current);
      const handle = await current.vault.replaceConnectionApiKey(
        credentialBinding(connection, current),
        parsed.data.apiKey,
      );
      const updated = await current.connections.update(connection.id, {
        credential: { kind: 'stored', handle },
        health: 'draft',
      });
      if (!sameCredentialIdentity(connection, updated)) {
        current.status.invalidate(connection.providerId, connection.id);
      }
      // CAS cleanup: if health became disconnected after the connection write
      // (should not happen under this lock, but re-check and erase the key).
      const afterWrite = await requireConnection(connection.id);
      if (afterWrite.health === 'disconnected') {
        await current.vault.deleteConnectionCredentials(connection.id);
        return {
          connection: connectionView(afterWrite, current.catalog.getProviderDefinitions()),
          message: terminalHealthMessage('disconnected'),
        } satisfies ProviderMutationResult;
      }
      return validateConnection(connection.id);
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_VALIDATE, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:validate payload');
    return withConnectionMutationLock(parsed.data.connectionId, () =>
      validateConnection(parsed.data.connectionId),
    );
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISABLE, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:disable payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
      const updated = await current.connections.update(connection.id, { health: 'disabled' });
      const { activeSessionsForProviderConnection } = await import('./chat');
      return {
        connection: connectionView(
          updated,
          current.catalog.getProviderDefinitions(),
          activeSessionsForProviderConnection(connection.id).length,
        ),
        message: 'The connection is disabled for new requests. Any active turn can finish safely.',
      } satisfies ProviderMutationResult;
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_ENABLE, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:enable payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
      if (connection.health === 'disconnected') {
        return {
          connection: connectionView(connection, current.catalog.getProviderDefinitions()),
          message: 'Authenticate this disconnected connection before enabling it.',
        } satisfies ProviderMutationResult;
      }
      await current.connections.update(connection.id, { health: 'draft' });
      return validateConnection(connection.id);
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISCONNECT, async (_event, payload: unknown) => {
    const parsed = disconnectSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:disconnect payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
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
      }
      return {
        connection: connectionView(updated, current.catalog.getProviderDefinitions()),
        message: stoppedSessionIds.length > 0
          ? `Cancelled ${stoppedSessionIds.length} active turn${stoppedSessionIds.length === 1 ? '' : 's'} and finalized its accounting before removing stored credentials. Revoke any upstream authorization or generated key from the provider account if needed.`
          : 'Stored credentials were removed. Revoke any upstream authorization or generated key from the provider account if needed.',
      } satisfies ProviderMutationResult;
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DELETE, async (_event, payload: unknown) => {
    const parsed = deleteConnectionSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:delete payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
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
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_MODEL_LIST, async (_event, payload: unknown) => {
    if (payload === undefined) return modelOptions();
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:model_list payload');
    return modelOptions(parsed.data.connectionId);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_STATUS_REFRESH, async (_event, payload: unknown) => {
    const parsed = statusRefreshSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:status_refresh payload');
    const observation = await refreshStatus(parsed.data.providerId, parsed.data.connectionId);
    return observation ? statusView(observation) : null;
  });
}

export function unregisterProviderIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_CREATE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_UPDATE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_VALIDATE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISABLE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_ENABLE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISCONNECT);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_MODEL_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_STATUS_REFRESH);
}

function genericOrigin(connection: ProviderConnection, current: ProviderIPCServices): string | null {
  const driver = current.registry.require(connection.providerId);
  if (!driver.allowsCustomEndpoint) return null;
  if (!connection.endpoint) return null;
  return validateGenericEndpoint(connection.endpoint, {
    allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true,
  }).origin;
}

async function refreshStatus(
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
  return (await current.status.refresh(createNeuralwattStatusSource(connection.id, apiKey), { manual: true })).observation;
}

async function readApiKeyForTrustedStatus(
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
