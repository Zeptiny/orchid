/**
 * Provider model-list IPC — unified listing, live discovery, and quota views.
 *
 * Connection CRUD and status refresh live in providers.ts; this module owns
 * the unified per-connection model listing (catalog + discovered + custom
 * rows with tier/cache TTL view data), the manual live-discovery handler, and
 * typed quota refresh. It reuses the providers module's service seam and
 * redacted view builders; the automatic discovery flow wired into connection
 * creation stays in providers.ts.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  ProviderDiscoverModelsResult,
  ProviderModelOption,
} from '../../shared/types/ipc';
import type { ProviderConnection, ProviderDefinition } from '../../shared/types/provider';
import {
  listConnectionModelRows,
  type ConnectionDiscoveryOutcome,
} from '../providers/facets/discovery';
import { groupTierVariantRows } from '../providers/facets/tiers';
import type { DriverCredential } from '../providers/drivers/types';
import { resolveModelSelection } from '../providers/resolver';
import type { ProviderStatusObservation } from '../providers/status/cache';
import {
  connectionIdSchema,
  connectionView,
  modelView,
  readApiKeyForTrustedStatus,
  requireConnection,
  runConnectionDiscovery,
  services,
  statusView,
  withConnectionMutationLock,
  type ProviderIPCServices,
} from './providers';

const modelListSchema = connectionIdSchema.extend({
  includeDisabled: z.boolean().optional(),
}).strict();

// ── Model options ───────────────────────────────────────────────────────────

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
  for (const connection of selectedConnections) {
    const definition = definitions.find((item) => item.id === connection.providerId);
    if (!definition) continue;
    const driver = current.registry.get(definition.id);
    const tierMechanism = driver?.tierMechanism;
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
      options.push({
        selection,
        connectionName: connection.name,
        providerId: connection.providerId,
        providerDisplayName: definition.displayName,
        model: modelView(row.model, row.source),
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

// ── Manual live discovery ───────────────────────────────────────────────────

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

// ── Quota refresh ───────────────────────────────────────────────────────────

const QUOTA_REFRESH_TTL_MS = 5 * 60_000;
const QUOTA_REFRESH_MINIMUM_MANUAL_MS = 30_000;

/**
 * Explicit typed-quota refresh (R24). It resolves the connection's driver quota
 * hook through the status service's TTL/manual-minimum path; a quota failure
 * degrades to a stale/unavailable observation and never gates the connection.
 */
async function refreshQuota(connectionId: string): Promise<ProviderStatusObservation | null> {
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

// ── Registration ────────────────────────────────────────────────────────────

export function registerProviderModelsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.PROVIDERS_MODEL_LIST, async (_event, payload: unknown) => {
    if (payload === undefined) return modelOptions();
    const parsed = modelListSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:model_list payload');
    return modelOptions(parsed.data.connectionId, parsed.data.includeDisabled === true);
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:discover_models payload');
    return withConnectionMutationLock(parsed.data.connectionId, async () => {
      const current = services();
      const connection = await requireConnection(parsed.data.connectionId);
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
      } satisfies ProviderDiscoverModelsResult;
    });
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH, async (_event, payload: unknown) => {
    const parsed = connectionIdSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Invalid providers:quota_refresh payload');
    const observation = await refreshQuota(parsed.data.connectionId);
    return observation ? statusView(observation) : null;
  });
}

export function unregisterProviderModelsIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_MODEL_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_DISCOVER_MODELS);
  ipcMain.removeHandler(IPC_CHANNELS.PROVIDERS_QUOTA_REFRESH);
}
