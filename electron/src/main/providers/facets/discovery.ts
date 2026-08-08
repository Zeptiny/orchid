/**
 * Live model discovery (R26–R29). A driver's discovery hook runs once when a
 * connection is created with a working credential and again only on explicit
 * manual fetch — never on a timer. Fetched metadata merges into the
 * connection's `discoveredModels` snapshot with provider provenance; the
 * unified listing then resolves effective metadata per field as user-set,
 * then live, then catalog, so an ids-only endpoint never degrades known
 * catalog metadata and explicit user configuration always wins.
 */
import {
  discoveredProviderModelSchema,
  type CustomConnectionModel,
  type DiscoveredConnectionModel,
  type DiscoveredProviderModel,
  type ProviderConnection,
  type ProviderDefinition,
  type ProviderModelDefinition,
  type ProviderProtocol,
  type ReasoningModelConfig,
} from '../../../shared/types/provider';
import { redactStatusDiagnostic } from '../status/cache';
import type { DriverCredential, ProviderDriver } from '../drivers/types';

export type ConnectionDiscoveryStatus = 'ok' | 'unsupported' | 'no-credential' | 'failed';

export interface ConnectionDiscoveryOutcome {
  readonly status: ConnectionDiscoveryStatus;
  /** Fresh snapshot on success; the connection's prior entries otherwise. */
  readonly discoveredModels: readonly DiscoveredConnectionModel[];
  /** Live ids unknown to both the catalog and user-defined models. */
  readonly addedModelIds: readonly string[];
  /** Fill-absent reasoning seeds from live metadata; undefined when nothing seeded. */
  readonly reasoningConfig: Record<string, ReasoningModelConfig> | undefined;
  /** Redacted failure detail for non-blocking surfacing; null on success. */
  readonly message: string | null;
}

export interface DiscoverConnectionModelsInput {
  readonly driver: ProviderDriver;
  readonly connection: ProviderConnection;
  readonly provider: ProviderDefinition;
  /** Undefined when the connection has no usable credential right now. */
  readonly credential: DriverCredential | undefined;
  readonly now?: () => Date;
}

/**
 * Merge one fetch into a fresh discovered-models snapshot. Entries whose
 * declared protocol conflicts with the connection are dropped; entries the
 * endpoint no longer reports disappear from the snapshot. User configuration
 * (customModels, reasoningConfig, modelIds) is never read into or overwritten
 * by the snapshot — it layers above it at listing time.
 */
export function mergeDiscoveredModels(
  connection: Pick<ProviderConnection, 'protocol'>,
  fetched: readonly DiscoveredProviderModel[],
  now = new Date(),
): DiscoveredConnectionModel[] {
  const discoveredAt = now.toISOString();
  const seen = new Set<string>();
  const merged: DiscoveredConnectionModel[] = [];
  for (const candidate of fetched) {
    const parsed = discoveredProviderModelSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const model = parsed.data;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    if (model.protocol !== undefined && model.protocol !== connection.protocol) continue;
    merged.push({ ...model, provenance: 'provider', discoveredAt });
  }
  return merged;
}

/** Fill-absent reasoning seeds from live entries, mirroring seedReasoningConfig. */
function seedDiscoveredReasoningConfig(
  connection: Pick<ProviderConnection, 'reasoningConfig'>,
  discoveredModels: readonly DiscoveredConnectionModel[],
): Record<string, ReasoningModelConfig> | undefined {
  const result: Record<string, ReasoningModelConfig> = { ...connection.reasoningConfig };
  let seeded = false;
  for (const model of discoveredModels) {
    if (result[model.id]) continue;
    if (model.capabilities?.reasoning !== true) continue;
    if (!model.reasoningLevels || model.reasoningLevels.length === 0) continue;
    result[model.id] = { levels: [...model.reasoningLevels], default: model.reasoningDefault ?? null };
    seeded = true;
  }
  return seeded ? result : undefined;
}

/** Run one on-demand discovery fetch and compute the merge. Never schedules work. */
export async function discoverConnectionModels(
  input: DiscoverConnectionModelsInput,
): Promise<ConnectionDiscoveryOutcome> {
  const prior = input.connection.discoveredModels ?? [];
  const idle: Omit<ConnectionDiscoveryOutcome, 'status' | 'message'> = {
    discoveredModels: prior,
    addedModelIds: [],
    reasoningConfig: undefined,
  };
  const facet = input.driver.discoveryFacet;
  if (!facet) return { ...idle, status: 'unsupported', message: null };
  if (!input.credential) return { ...idle, status: 'no-credential', message: null };
  let fetched: readonly DiscoveredProviderModel[];
  try {
    fetched = await facet.fetchModels({
      connection: input.connection,
      provider: input.provider,
      credential: input.credential,
      ...(input.driver.allowsCustomEndpoint && input.connection.endpoint
        ? { endpoint: input.connection.endpoint }
        : {}),
    });
  } catch (error) {
    return {
      ...idle,
      status: 'failed',
      message: redactStatusDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
  const discoveredModels = mergeDiscoveredModels(
    input.connection,
    fetched,
    input.now?.() ?? new Date(),
  );
  const knownIds = new Set([
    ...input.provider.models.map((model) => model.id),
    ...(input.connection.customModels ?? []).map((model) => model.id),
  ]);
  return {
    status: 'ok',
    discoveredModels,
    addedModelIds: discoveredModels.map((model) => model.id).filter((id) => !knownIds.has(id)),
    reasoningConfig: seedDiscoveredReasoningConfig(input.connection, discoveredModels),
    message: null,
  };
}

// ── Unified listing ─────────────────────────────────────────────────────────

export type ConnectionModelSource = 'catalog' | 'provider' | 'user';

export interface EffectiveModelLayers {
  readonly catalog?: ProviderModelDefinition;
  readonly discovered?: DiscoveredConnectionModel;
  readonly custom?: CustomConnectionModel;
  readonly fallbackId: string;
  readonly fallbackProtocol: ProviderProtocol;
}

/**
 * Resolve one model's effective metadata. Precedence is user-set, then live
 * provider data, then catalog; an absent (null) limit falls through to the
 * next layer so partial live data never erases a known value (R27).
 */
export function resolveEffectiveModel(layers: EffectiveModelLayers): ProviderModelDefinition {
  const { catalog, discovered, custom } = layers;
  const contextTokens = custom?.limits?.contextTokens
    ?? discovered?.limits?.contextTokens
    ?? catalog?.limits?.contextTokens
    ?? null;
  const outputTokens = custom?.limits?.outputTokens
    ?? discovered?.limits?.outputTokens
    ?? catalog?.limits?.outputTokens
    ?? null;
  const capabilities = custom?.capabilities ?? discovered?.capabilities ?? catalog?.capabilities;
  return {
    id: layers.fallbackId,
    displayName: custom?.displayName
      ?? discovered?.displayName
      ?? catalog?.displayName
      ?? layers.fallbackId,
    protocol: custom?.protocol ?? discovered?.protocol ?? catalog?.protocol ?? layers.fallbackProtocol,
    ...(catalog?.lifecycle ? { lifecycle: catalog.lifecycle } : {}),
    ...(capabilities ? { capabilities: structuredClone(capabilities) } : {}),
    ...(custom?.limits ?? discovered?.limits ?? catalog?.limits
      ? { limits: { contextTokens, outputTokens } }
      : {}),
  };
}

export interface ConnectionModelRow {
  /** Effective metadata for display and request-time resolution. */
  readonly model: ProviderModelDefinition;
  /** Provenance badge: catalog, live-discovered, or user-defined (R28). */
  readonly source: ConnectionModelSource;
  /** Enabled models are the connection's usable set (its modelIds). */
  readonly enabled: boolean;
  /** A user metadata override exists over a catalog or discovered entry. */
  readonly customized: boolean;
  readonly discoveredAt: string | null;
}

function lifecycleListable(model: ProviderModelDefinition): boolean {
  return model.lifecycle !== 'disabled' && model.lifecycle !== 'retired';
}

function hasLiveMetadata(model: DiscoveredConnectionModel): boolean {
  return model.displayName !== undefined
    || model.capabilities !== undefined
    || model.limits !== undefined
    || model.reasoningLevels !== undefined
    || model.pricing !== undefined;
}

/**
 * One unified row set per connection: catalog, live-discovered, and
 * user-defined models with identical affordances, differing only by the
 * provenance badge (R28, R29).
 */
export function listConnectionModelRows(
  connection: ProviderConnection,
  definition: ProviderDefinition,
): readonly ConnectionModelRow[] {
  const catalogById = new Map(
    definition.models
      .filter((model) => model.protocol === connection.protocol && lifecycleListable(model))
      .map((model) => [model.id, model]),
  );
  const customById = new Map(
    (connection.customModels ?? [])
      .filter((model) => model.protocol === connection.protocol)
      .map((model) => [model.id, model]),
  );
  const discoveredById = new Map(
    (connection.discoveredModels ?? []).map((model) => [model.id, model]),
  );
  const ids = new Set<string>([
    ...catalogById.keys(),
    ...customById.keys(),
    ...discoveredById.keys(),
    ...connection.modelIds,
  ]);
  const rows: ConnectionModelRow[] = [];
  for (const id of ids) {
    const catalog = catalogById.get(id);
    const custom = customById.get(id);
    const discovered = discoveredById.get(id);
    const source: ConnectionModelSource = custom && !catalog
      ? 'user'
      : catalog && discovered && hasLiveMetadata(discovered)
        ? 'provider'
        : catalog
          ? 'catalog'
          : discovered
            ? 'provider'
            : 'user';
    rows.push({
      model: resolveEffectiveModel({
        catalog,
        discovered,
        custom,
        fallbackId: id,
        fallbackProtocol: connection.protocol,
      }),
      source,
      enabled: connection.modelIds.includes(id),
      customized: custom !== undefined && (catalog !== undefined || discovered !== undefined),
      discoveredAt: discovered?.discoveredAt ?? null,
    });
  }
  return rows.sort(
    (left, right) => left.model.displayName.localeCompare(right.model.displayName)
      || left.model.id.localeCompare(right.model.id),
  );
}
