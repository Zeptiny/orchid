/**
 * Service tier facet — per-model selection with a session override (R19–R23).
 *
 * The driver declares how a tier reaches the provider; the facet only resolves
 * which declared tier id applies and validates it against the declaration.
 * Catalog and user data select among declared options but never construct
 * requests (R2):
 *
 * - request-parameter drivers (OpenAI/OpenRouter service_tier) emit a
 *   providerOption value under the driver's namespace.
 * - model-name-variants drivers (Neuralwatt -flex/-fast/-short) rewrite the
 *   executable model id at model construction time; the variant id is the
 *   billing identity, and preconditions declared per tier (streaming) are
 *   asserted loudly when violated (R23).
 *
 * Tiers are opt-in: no selection produces no request change (R23).
 */
import type { TierMechanism } from '../../../shared/types/provider-facets';
import {
  tierBaseModelId,
  type EffectiveModel,
  type ProviderConnection,
} from '../../../shared/types/provider';
import type { ProviderDriver, ReasoningProviderOptions } from '../drivers/types';
import { ProviderResolutionError } from '../../llm/middleware/error-classification';

type TierConnection = Pick<ProviderConnection, 'tierSelections'>;

/** Declared tier metadata for one resolved selection, when the id is known. */
export function declaredTier(
  mechanism: TierMechanism,
  tierId: string,
): { readonly id: string; readonly requiresStreaming: boolean } | undefined {
  const tier = mechanism.tiers.find((candidate) => candidate.id === tierId);
  if (!tier) return undefined;
  const requiresStreaming = mechanism.kind === 'model-name-variants'
    && (tier as { requiresStreaming?: boolean }).requiresStreaming === true;
  return { id: tier.id, requiresStreaming };
}

/**
 * Effective tier for a main-agent turn: session override, then the
 * connection's per-model selection, then nothing (R21, R23). An override is
 * honored only when the driver declares the id for this connection's model.
 */
export function resolveMainAgentTier(
  session: { tierOverride: string | null },
  connection: TierConnection,
  modelId: string,
  mechanism: TierMechanism | undefined,
): string | undefined {
  if (!mechanism) return undefined;
  const override = session.tierOverride;
  if (override && declaredTier(mechanism, override)) return override;
  const selected = connection.tierSelections?.[modelId];
  return selected && declaredTier(mechanism, selected) ? selected : undefined;
}

/**
 * Effective tier for a subagent turn. Subagents have no session scoping, so
 * the connection's per-model selection is the only source (R21).
 */
export function resolveSubagentTier(
  connection: TierConnection,
  modelId: string,
  mechanism: TierMechanism | undefined,
): string | undefined {
  if (!mechanism) return undefined;
  const selected = connection.tierSelections?.[modelId];
  return selected && declaredTier(mechanism, selected) ? selected : undefined;
}

/** Variant id for one tier under a model-name-variants mechanism. */
export function tierVariantModelId(
  mechanism: Extract<TierMechanism, { kind: 'model-name-variants' }>,
  baseModelId: string,
  tierId: string,
): string | undefined {
  const tier = mechanism.tiers.find((candidate) => candidate.id === tierId);
  return tier ? `${baseModelId}${tier.modelIdSuffix}` : undefined;
}

/**
 * Provider options carrying a request-parameter tier. Emitted only for the
 * declared mechanism; the driver namespace owns the parameter name (R2).
 */
export function buildTierProviderOptions(
  mechanism: TierMechanism | undefined,
  tierId: string | undefined,
): ReasoningProviderOptions | undefined {
  if (!mechanism || mechanism.kind !== 'request-parameter' || !tierId) return undefined;
  if (!declaredTier(mechanism, tierId)) return undefined;
  if (mechanism.parameter !== 'serviceTier') return undefined;
  return { openai: { serviceTier: tierId } };
}

/**
 * Apply a variant tier at model construction time: rewrite the model id the
 * driver instantiates and remember the base id for evidence and grouping.
 * Declared preconditions fail loudly here rather than at the provider (R23).
 */
export function applyVariantTier(
  driver: Pick<ProviderDriver, 'tierMechanism'> | undefined,
  model: EffectiveModel,
  tierId: string | undefined,
  options: { readonly streaming: boolean },
): EffectiveModel {
  const mechanism = driver?.tierMechanism;
  if (!mechanism || mechanism.kind !== 'model-name-variants' || !tierId) return model;
  const declared = declaredTier(mechanism, tierId);
  if (!declared) return model;
  if (declared.requiresStreaming && !options.streaming) {
    throw new ProviderResolutionError(
      `Service tier '${tierId}' for '${model.id}' requires a streaming request`,
    );
  }
  const variantId = tierVariantModelId(mechanism, model.id, tierId);
  if (!variantId || variantId === model.id) return model;
  return { ...model, id: variantId, baseModelId: model.baseModelId ?? model.id };
}

/** Served-tier evidence persisted on the attempt (R22). */
export interface ServedTierEvidence {
  /** Tier the provider reported serving, when the mechanism can know it. */
  readonly tier?: string;
  /** Variant model id actually sent (model-name-variants mechanism). */
  readonly servedModelId?: string;
  /** Base model id the served variant was derived from. */
  readonly baseModelId?: string;
  /** Selected tier id requested for the attempt. */
  readonly requestedTier?: string;
}

/**
 * Capture the actually-served tier from one provider response (R22).
 * Request-parameter mechanisms read the provider-reported service tier from
 * the finish metadata; variant mechanisms derive the served tier from the
 * model id that was actually sent. Returns undefined when no tier facet is
 * active or the provider reported nothing beyond the default.
 */
export function extractServedTier(input: {
  readonly mechanism: TierMechanism | undefined;
  readonly servedModelId: string;
  readonly baseModelId?: string;
  readonly requestedTier?: string;
  readonly finishMetadata?: Readonly<Record<string, unknown>>;
}): ServedTierEvidence | undefined {
  const mechanism = input.mechanism;
  if (!mechanism) return undefined;

  if (mechanism.kind === 'request-parameter') {
    const served = readReportedServiceTier(input.finishMetadata);
    if (!served && !input.requestedTier) return undefined;
    return {
      ...(served ? { tier: served } : {}),
      ...(input.requestedTier ? { requestedTier: input.requestedTier } : {}),
    };
  }

  // model-name-variants: the served id itself is the evidence. A bare base id
  // means standard service; a variant suffix identifies the served tier.
  const baseId = input.baseModelId
    ?? tierBaseModelId(input.servedModelId, mechanism.tiers.map((tier) => tier.modelIdSuffix));
  const servedTier = baseId && baseId !== input.servedModelId
    ? mechanism.tiers.find((tier) => input.servedModelId === `${baseId}${tier.modelIdSuffix}`)?.id
    : undefined;
  if (!servedTier && !input.requestedTier && !baseId) return undefined;
  return {
    ...(servedTier ? { tier: servedTier } : {}),
    servedModelId: input.servedModelId,
    ...(baseId && baseId !== input.servedModelId ? { baseModelId: baseId } : {}),
    ...(input.requestedTier ? { requestedTier: input.requestedTier } : {}),
  };
}

function readReportedServiceTier(
  finishMetadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const openai = finishMetadata?.openai;
  if (openai === null || typeof openai !== 'object' || Array.isArray(openai)) return undefined;
  const value = (openai as Record<string, unknown>).serviceTier;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// ── Variant grouping (R20) ──────────────────────────────────────────────────

/** Minimal row shape the grouper reads; structurally compatible with listing rows. */
export interface TierGroupableRow {
  readonly model: { readonly id: string };
}

/**
 * Group model-name-variant rows under their base model (R20). A variant row
 * (`glm-5.2-flex`) is folded into the base row (`glm-5.2`) when the base is
 * present; the returned map keys the base model id to the tier ids whose
 * variants were folded in. Rows without a matching base stay untouched, as do
 * all rows for drivers without a variant mechanism.
 */
export function groupTierVariantRows<Row extends TierGroupableRow>(
  rows: readonly Row[],
  mechanism: Extract<TierMechanism, { kind: 'model-name-variants' }> | undefined,
): { rows: readonly Row[]; variantTiersByBase: ReadonlyMap<string, readonly string[]> } {
  const variantTiersByBase = new Map<string, readonly string[]>();
  if (!mechanism) return { rows, variantTiersByBase };

  const suffixToTier = new Map(mechanism.tiers.map((tier) => [tier.modelIdSuffix, tier.id]));
  const presentIds = new Set(rows.map((row) => row.model.id));
  // Longest suffix first so compound variants (…-short-flex) resolve before
  // their prefixes (…-flex) and fold under the correct base.
  const suffixes = [...suffixToTier.keys()].sort((a, b) => b.length - a.length);

  const folded = new Set<string>();
  const tiersByBase = new Map<string, string[]>();
  const isVariantId = (id: string) =>
    suffixes.some((candidate) => id.endsWith(candidate) && id.length > candidate.length);
  for (const row of rows) {
    // Walk suffixes inward so a compound variant (…-short-flex) folds through
    // its present intermediate (…-short) up to the true base row, collecting
    // each tier along the way.
    let current = row.model.id;
    const chain: string[] = [];
    for (;;) {
      const suffix = suffixes.find(
        (candidate) => current.endsWith(candidate) && current.length > candidate.length
          && presentIds.has(current.slice(0, current.length - candidate.length)),
      );
      if (!suffix) break;
      current = current.slice(0, current.length - suffix.length);
      chain.push(suffixToTier.get(suffix)!);
    }
    const base = current;
    if (chain.length === 0 || base === row.model.id || isVariantId(base)) continue;
    folded.add(row.model.id);
    const existing = tiersByBase.get(base) ?? [];
    const merged = [...existing];
    for (const tierId of chain.reverse()) {
      if (!merged.includes(tierId)) merged.push(tierId);
    }
    tiersByBase.set(base, merged);
  }
  if (folded.size === 0) return { rows, variantTiersByBase };
  for (const [base, tierIds] of tiersByBase) variantTiersByBase.set(base, tierIds);
  return { rows: rows.filter((row) => !folded.has(row.model.id)), variantTiersByBase };
}
