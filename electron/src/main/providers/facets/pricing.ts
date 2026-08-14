import Decimal from 'decimal.js';
import type {
  CurrencyUnit,
  PriceRate,
  PricingContextTier,
  PricingRateFields,
  ProviderModelRateCard,
  ProviderRateCard,
} from '../../../shared/types/provider-facets';
import type {
  FrozenPricingSnapshot,
  PricingRateProvenance,
  PricingRateSnapshot,
  PricingRateSnapshotSet,
  PricingRateSource,
} from '../../../shared/types/accounting';
import type { ProviderConnection } from '../../../shared/types/provider';
import type { CatalogPricing } from '../catalog/schema';
import type { DriverPricingFacet } from '../drivers/types';

const SCALAR_RATE_FIELDS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
  'perRequest',
  'energy',
] as const;

type ScalarRateField = (typeof SCALAR_RATE_FIELDS)[number];

const RUNG_PRIORITY: Readonly<Record<PricingRateSource, number>> = {
  'provider-api': 0,
  user: 1,
  catalog: 2,
};

/** Ordering helper shared with cost resolution: lower rung index wins. */
export function comparePricingRateSources(a: PricingRateSource, b: PricingRateSource): number {
  return RUNG_PRIORITY[a] - RUNG_PRIORITY[b];
}

/** Latest-known dynamic pricing state for one model at request-freeze time. */
export interface DynamicPricingState {
  readonly card: ProviderModelRateCard | undefined;
  /** True when the card is served past its cadence or after a failed refresh. */
  readonly stale: boolean;
  /** Redacted detail of the last failed refresh, when one occurred. */
  readonly error?: string;
}

/** Live inline rates parsed from the provider's models endpoint (R27). */
export interface DiscoveredPricingRung {
  readonly pricing: ProviderRateCard;
  readonly discoveredAt: string;
}

export interface PricingResolverInput {
  readonly pricingFacet: DriverPricingFacet | undefined;
  readonly connection: ProviderConnection;
  /** Billed model identity: variant tiers freeze the served variant id (R22). */
  readonly modelId: string;
  /**
   * Base model id the user-override rung keys off; variant requests bill the
   * variant id but users key overrides by the base id (R6, R22).
   */
  readonly userOverrideModelId?: string;
  readonly catalogPricing: CatalogPricing | undefined;
  readonly dynamic: DynamicPricingState | undefined;
  /** Live inline rates parsed from the provider's models endpoint (R27). */
  readonly discovered?: DiscoveredPricingRung;
  readonly now: Date;
}

interface RungView {
  readonly source: PricingRateSource;
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly rates: PricingRateFields | undefined;
  readonly contextTiers: readonly PricingContextTier[] | undefined;
}

function rungProvenance(rung: RungView): PricingRateProvenance {
  return {
    source: rung.source,
    observedAt: rung.observedAt,
    ...(rung.stale ? { stale: true } : {}),
  };
}

function snapshotRate(rate: PriceRate, provenance: PricingRateProvenance): PricingRateSnapshot {
  return { amount: rate.amount, per: rate.per, unit: rate.unit, provenance };
}

/** Freeze one rung's complete rate set (used for context-tier scopes). */
function snapshotRateSet(rates: PricingRateFields, provenance: PricingRateProvenance): PricingRateSnapshotSet {
  const scalars: Partial<Record<ScalarRateField, PricingRateSnapshot>> = {};
  for (const field of SCALAR_RATE_FIELDS) {
    const rate = rates[field];
    if (rate) scalars[field] = snapshotRate(rate, provenance);
  }
  const ttlEntries = Object.entries(rates.cacheWriteByTtl ?? {});
  const cacheWriteByTtl = ttlEntries.length > 0
    ? Object.fromEntries(ttlEntries.map(([ttl, rate]) => [ttl, snapshotRate(rate, provenance)]))
    : undefined;
  return { ...scalars, ...(cacheWriteByTtl ? { cacheWriteByTtl } : {}) };
}

/** Freeze the base rate set by walking the ladder field by field (R5, R6). */
function resolveBaseRates(
  rungs: readonly RungView[],
  contributing: Set<PricingRateSource>,
): PricingRateSnapshotSet {
  const scalars: Partial<Record<ScalarRateField, PricingRateSnapshot>> = {};
  for (const field of SCALAR_RATE_FIELDS) {
    for (const rung of rungs) {
      const rate = rung.rates?.[field];
      if (rate) {
        scalars[field] = snapshotRate(rate, rungProvenance(rung));
        contributing.add(rung.source);
        break;
      }
    }
  }
  const ttlKeys = new Set<string>();
  for (const rung of rungs) {
    for (const ttl of Object.keys(rung.rates?.cacheWriteByTtl ?? {})) ttlKeys.add(ttl);
  }
  const byTtl: Record<string, PricingRateSnapshot> = {};
  for (const ttl of ttlKeys) {
    for (const rung of rungs) {
      const rate = rung.rates?.cacheWriteByTtl?.[ttl];
      if (rate) {
        byTtl[ttl] = snapshotRate(rate, rungProvenance(rung));
        contributing.add(rung.source);
        break;
      }
    }
  }
  return {
    ...scalars,
    ...(Object.keys(byTtl).length > 0 ? { cacheWriteByTtl: byTtl } : {}),
  };
}

function cardHasRates(card: ProviderModelRateCard): boolean {
  return SCALAR_RATE_FIELDS.some((field) => card.rates[field] !== undefined)
    || Object.keys(card.rates.cacheWriteByTtl ?? {}).length > 0
    || (card.contextTiers?.length ?? 0) > 0;
}

function currencyUnitLabel(unit: CurrencyUnit): string {
  return unit.kind === 'fiat' ? unit.code : unit.unit;
}

/** Multiply every rate dimension by a driver-owned factor (decimal-exact). */
export function scalePricingRateFields(rates: PricingRateFields, multiplier: Decimal): PricingRateFields {
  const scale = (rate: PriceRate): PriceRate => ({
    ...rate,
    amount: new Decimal(rate.amount).mul(multiplier).toFixed(),
  });
  const result: PricingRateFields = {};
  for (const field of SCALAR_RATE_FIELDS) {
    const rate = rates[field];
    if (rate) result[field] = scale(rate);
  }
  if (rates.cacheWriteByTtl) {
    result.cacheWriteByTtl = Object.fromEntries(
      Object.entries(rates.cacheWriteByTtl).map(([ttl, rate]) => [ttl, scale(rate)]),
    );
  }
  return result;
}

/**
 * Compose the pricing ladder live-discovered → provider API → user override →
 * catalog into one immutable frozen snapshot. Every frozen rate carries its
 * rung provenance so attempt accounting can report which rung produced a cost
 * (R5–R9). Returns null when no rung can price the model in a known billing
 * unit.
 */
export function resolveFrozenPricing(input: PricingResolverInput): FrozenPricingSnapshot | null {
  const card = input.dynamic?.card && cardHasRates(input.dynamic.card)
    ? input.dynamic.card
    : undefined;
  const discoveredRung: RungView | undefined = input.discovered
    ? {
        source: 'provider-api',
        observedAt: input.discovered.discoveredAt,
        stale: false,
        rates: input.discovered.pricing.rates,
        contextTiers: input.discovered.pricing.contextTiers,
      }
    : undefined;
  const rungs: RungView[] = [
    ...(discoveredRung ? [discoveredRung] : []),
    {
      source: 'provider-api',
      observedAt: card?.observedAt ?? null,
      stale: input.dynamic?.stale === true,
      rates: card?.rates,
      contextTiers: card?.contextTiers,
    },
    {
      source: 'user',
      observedAt: null,
      stale: false,
      rates: input.connection.pricingOverrides?.[input.userOverrideModelId ?? input.modelId],
      contextTiers: undefined,
    },
    {
      source: 'catalog',
      observedAt: input.catalogPricing?.effectiveAt ?? null,
      stale: false,
      rates: input.catalogPricing?.rates,
      contextTiers: input.catalogPricing?.contextTiers,
    },
  ];

  const contributing = new Set<PricingRateSource>();
  const rates = resolveBaseRates(rungs, contributing);
  const tierRung = rungs.find((rung) => (rung.contextTiers?.length ?? 0) > 0);
  const contextTiers = tierRung?.contextTiers?.map((tier) => ({
    overContextTokens: tier.overContextTokens,
    rates: snapshotRateSet(tier.rates, rungProvenance(tierRung)),
  }));
  if (tierRung) contributing.add(tierRung.source);
  if (contributing.size === 0) return null;

  const currencyUnit = card?.currencyUnit
    ?? input.discovered?.pricing.currencyUnit
    ?? input.pricingFacet?.currencyUnit
    ?? input.catalogPricing?.currencyUnit;
  const currency = currencyUnit ? currencyUnitLabel(currencyUnit) : input.catalogPricing?.currency;
  if (!currency) return null;

  const source = rungs.find((rung) => contributing.has(rung.source))!.source;
  const provenance: Record<string, unknown> = { source };
  if (input.catalogPricing) {
    provenance.signedCatalog = structuredClone(input.catalogPricing.provenance);
  }
  if (input.pricingFacet?.dynamic) {
    provenance.dynamic = {
      state: card ? (input.dynamic?.stale ? 'stale' : 'fresh') : 'unavailable',
      ...(card ? { observedAt: card.observedAt } : {}),
      ...(input.dynamic?.error ? { error: input.dynamic.error } : {}),
      ...(card?.adjustment ? { adjustment: card.adjustment } : {}),
    };
  }
  if (input.discovered) {
    provenance.discovered = { observedAt: input.discovered.discoveredAt };
  }
  if (contributing.has('user')) provenance.user = true;

  return {
    currency,
    ...(currencyUnit ? { currencyUnit } : {}),
    effectiveAt: input.discovered?.pricing.observedAt
      ?? card?.observedAt
      ?? input.catalogPricing?.effectiveAt
      ?? input.now.toISOString(),
    rates,
    ...(contextTiers && contextTiers.length > 0 ? { contextTiers } : {}),
    inclusion: {
      cacheRead: 'subset-of-input',
      cacheWrite: rates.cacheWrite ? 'additional' : 'unknown',
      reasoning: rates.reasoning ? 'subset-of-output' : 'unknown',
    },
    provenance,
  };
}
