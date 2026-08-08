import Decimal from 'decimal.js';
import type {
  CostSource,
  CostState,
  FrozenPricingSnapshot,
  FrozenProviderRequestSnapshot,
  NormalizedProviderUsage,
  PricingRateProvenance,
  PricingRateSnapshot,
  PricingRateSnapshotSet,
  PricingRateSource,
} from '../../../shared/types/accounting';
import { comparePricingRateSources } from '../facets/pricing';

export interface AttemptCostEvidence {
  readonly reportedCostAmount?: string;
  readonly reportedCurrency?: string;
  readonly accountingMethod?: 'energy' | 'token';
  readonly energyRateUsdPerKwh?: string;
  readonly currency?: string;
}

export type AttemptCostResolution =
  | {
      readonly state: Extract<CostState, 'reported' | 'calculated'>;
      readonly source: Exclude<CostSource, 'unknown'>;
      readonly currency: string;
      readonly amount: string;
      /** Pricing ladder rung whose frozen rates produced this cost (R5). */
      readonly rateRung?: PricingRateSource;
      /** True when a contributing provider-API rate was served stale (R7). */
      readonly rateRungStale?: boolean;
    }
  | {
      readonly state: 'unknown';
      readonly source: 'unknown';
      readonly reason: string;
    };

function decimal(value: string | number | undefined): Decimal | null {
  if (value === undefined) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && !parsed.isNegative() ? parsed : null;
  } catch {
    return null;
  }
}

/** The snapshot's native billing label when it is not an ISO fiat code (R8). */
function nativeBillingUnit(pricing: FrozenPricingSnapshot | null): string | null {
  if (!pricing) return null;
  if (pricing.currencyUnit) {
    return pricing.currencyUnit.kind === 'non-fiat' ? pricing.currencyUnit.unit : null;
  }
  return /^[A-Z]{3}$/.test(pricing.currency) ? null : pricing.currency;
}

/** Accept ISO-4217 fiat codes and the snapshot's declared native unit label. */
function currency(value: string | undefined, nativeUnit: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (nativeUnit !== null && trimmed === nativeUnit) return trimmed;
  const normalized = trimmed.toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function canonical(value: Decimal): string {
  return value.toFixed();
}

function unknown(reason: string): AttemptCostResolution {
  return { state: 'unknown', source: 'unknown', reason };
}

function costForRate(rate: PricingRateSnapshot, units: Decimal): Decimal | null {
  if (rate.per <= 0 || !Number.isInteger(rate.per)) return null;
  const amount = decimal(rate.amount);
  return amount ? amount.mul(units).div(rate.per) : null;
}

function addRate(
  total: Decimal,
  rate: PricingRateSnapshot | undefined,
  units: Decimal,
  unit: PricingRateSnapshot['unit'],
): Decimal | null {
  if (units.isZero()) return total;
  if (!rate || rate.unit !== unit) return null;
  const cost = costForRate(rate, units);
  return cost ? total.add(cost) : null;
}

interface RungAccumulator {
  best: PricingRateSource | undefined;
  stale: boolean;
}

function trackRungProvenance(acc: RungAccumulator, provenance: PricingRateProvenance | undefined): void {
  if (!provenance) return;
  if (acc.best === undefined || comparePricingRateSources(provenance.source, acc.best) < 0) {
    acc.best = provenance.source;
  }
  if (provenance.stale) acc.stale = true;
}

function trackRung(acc: RungAccumulator, rate: PricingRateSnapshot | undefined): void {
  trackRungProvenance(acc, rate?.provenance);
}

function rungResult(acc: RungAccumulator): { rateRung?: PricingRateSource; rateRungStale?: boolean } {
  return acc.best === undefined
    ? {}
    : { rateRung: acc.best, ...(acc.stale ? { rateRungStale: true } : {}) };
}

/** Tier rates override base rates field by field for the serving scope. */
function mergeRateSets(
  base: PricingRateSnapshotSet,
  tier: PricingRateSnapshotSet,
): PricingRateSnapshotSet {
  const cacheWriteByTtl = base.cacheWriteByTtl || tier.cacheWriteByTtl
    ? { ...base.cacheWriteByTtl, ...tier.cacheWriteByTtl }
    : undefined;
  return {
    ...base,
    ...tier,
    ...(cacheWriteByTtl ? { cacheWriteByTtl } : {}),
  };
}

/**
 * Select the context-length tier whose threshold the attempt's input exceeds;
 * the highest applicable tier's rates override the base rates per field (R9).
 */
function ratesForUsage(
  pricing: FrozenPricingSnapshot,
  inputTokens: Decimal | null,
): PricingRateSnapshotSet {
  const tiers = pricing.contextTiers;
  if (!tiers || tiers.length === 0 || !inputTokens) return pricing.rates;
  const applicable = tiers
    .filter((tier) => inputTokens.gt(tier.overContextTokens))
    .sort((a, b) => a.overContextTokens - b.overContextTokens);
  const tier = applicable[applicable.length - 1];
  return tier ? mergeRateSets(pricing.rates, tier.rates) : pricing.rates;
}

/**
 * Apply only a frozen, authoritative price formula. If classification or any
 * billed unit is ambiguous, return unknown rather than guessing a monetary cost.
 * A provider-reported cost always wins over every computed ladder rung.
 */
export function calculateAttemptCost(input: {
  readonly snapshot: FrozenProviderRequestSnapshot;
  readonly usage: NormalizedProviderUsage | null | undefined;
  readonly evidence: AttemptCostEvidence;
}): AttemptCostResolution {
  const pricing = input.snapshot.pricing;
  const nativeUnit = nativeBillingUnit(pricing);
  const reported = decimal(input.evidence.reportedCostAmount);
  const reportedCurrency = currency(input.evidence.reportedCurrency ?? input.evidence.currency, nativeUnit);
  if (reported && reportedCurrency) {
    return {
      state: 'reported',
      source: 'provider-reported',
      currency: reportedCurrency,
      amount: canonical(reported),
    };
  }

  const usage = input.usage;
  if (!usage || !pricing) return unknown('No frozen pricing formula or authoritative usage is available');

  const formulaCurrency = currency(input.evidence.currency ?? pricing.currency, nativeUnit);
  if (!formulaCurrency) return unknown('A valid billing currency is unavailable');

  if (input.evidence.accountingMethod === 'energy') {
    const consumed = decimal(usage.energyKwhConsumed);
    const charged = decimal(usage.energyKwhCharged);
    const multiplier = decimal(usage.pricingMultiplier);
    const evidenceRate = decimal(input.evidence.energyRateUsdPerKwh);
    const rateAmount = evidenceRate ?? decimal(pricing.rates.energy?.amount);
    const ratePer = pricing.rates.energy?.per ?? 1;
    if (!consumed || !charged || !multiplier || !rateAmount || ratePer <= 0) {
      return unknown('Complete authoritative charged-energy billing evidence is unavailable');
    }
    const rung: RungAccumulator = { best: undefined, stale: false };
    // A rate carried by the response itself is the freshest provider-API rung.
    if (evidenceRate) trackRungProvenance(rung, { source: 'provider-api', observedAt: null });
    else trackRung(rung, pricing.rates.energy);
    // charged energy is already the provider-reported post-multiplier unit;
    // preserve multiplier as evidence but do not double-discount the cost.
    return {
      state: 'calculated',
      source: 'energy-formula',
      currency: formulaCurrency,
      amount: canonical(rateAmount.mul(charged).div(ratePer)),
      ...rungResult(rung),
    };
  }

  const inputTokens = decimal(usage.inputTokens);
  const outputTokens = decimal(usage.outputTokens);
  const cacheRead = decimal(usage.cacheReadTokens) ?? new Decimal(0);
  const cacheWrite = decimal(usage.cacheWriteTokens) ?? new Decimal(0);
  const reasoning = decimal(usage.reasoningTokens) ?? new Decimal(0);
  if (!inputTokens && !outputTokens && cacheRead.isZero() && cacheWrite.isZero() && reasoning.isZero()) {
    return unknown('No authoritative token usage is available');
  }

  const rates = ratesForUsage(pricing, inputTokens);

  let billableInput = inputTokens ?? new Decimal(0);
  let billableOutput = outputTokens ?? new Decimal(0);

  if (!cacheRead.isZero()) {
    if (pricing.inclusion.cacheRead === 'unknown') return unknown('Cache-read inclusion semantics are ambiguous');
    if (pricing.inclusion.cacheRead === 'subset-of-input') {
      if (!inputTokens || billableInput.lessThan(cacheRead)) return unknown('Input usage cannot classify cache-read tokens');
      billableInput = billableInput.sub(cacheRead);
    }
  }
  if (!cacheWrite.isZero()) {
    if (pricing.inclusion.cacheWrite === 'unknown') return unknown('Cache-write inclusion semantics are ambiguous');
    if (pricing.inclusion.cacheWrite === 'subset-of-input') {
      if (!inputTokens || billableInput.lessThan(cacheWrite)) return unknown('Input usage cannot classify cache-write tokens');
      billableInput = billableInput.sub(cacheWrite);
    }
  }
  if (!reasoning.isZero() && rates.reasoning) {
    if (pricing.inclusion.reasoning === 'unknown') return unknown('Reasoning inclusion semantics are ambiguous');
    if (pricing.inclusion.reasoning === 'subset-of-output') {
      if (!outputTokens || billableOutput.lessThan(reasoning)) return unknown('Output usage cannot classify reasoning tokens');
      billableOutput = billableOutput.sub(reasoning);
    }
  }

  const rung: RungAccumulator = { best: undefined, stale: false };
  let total = new Decimal(0);
  const inputCost = addRate(total, rates.input, billableInput, 'tokens');
  if (!inputCost) return unknown('Input token pricing is unavailable');
  total = inputCost;
  if (!billableInput.isZero()) trackRung(rung, rates.input);
  const outputCost = addRate(total, rates.output, billableOutput, 'tokens');
  if (!outputCost) return unknown('Output token pricing is unavailable');
  total = outputCost;
  if (!billableOutput.isZero()) trackRung(rung, rates.output);

  const cacheReadCost = addRate(total, rates.cacheRead, cacheRead, 'tokens');
  if (!cacheReadCost) return unknown('Cache-read pricing is unavailable');
  total = cacheReadCost;
  if (!cacheRead.isZero()) trackRung(rung, rates.cacheRead);
  const cacheWriteCost = addRate(total, rates.cacheWrite, cacheWrite, 'tokens');
  if (!cacheWriteCost) return unknown('Cache-write pricing is unavailable');
  total = cacheWriteCost;
  if (!cacheWrite.isZero()) trackRung(rung, rates.cacheWrite);
  const reasoningCost = addRate(total, rates.reasoning, reasoning, 'tokens');
  if (!reasoningCost) return unknown('Reasoning pricing is unavailable');
  total = reasoningCost;
  if (!reasoning.isZero()) trackRung(rung, rates.reasoning);

  if (rates.perRequest) {
    const withFee = addRate(total, rates.perRequest, new Decimal(1), 'requests');
    if (!withFee) return unknown('Per-request pricing is unavailable');
    total = withFee;
    trackRung(rung, rates.perRequest);
  }

  return {
    state: 'calculated',
    source: 'token-formula',
    currency: formulaCurrency,
    amount: canonical(total),
    ...rungResult(rung),
  };
}
