import Decimal from 'decimal.js';
import type {
  CostSource,
  CostState,
  FrozenProviderRequestSnapshot,
  NormalizedProviderUsage,
  PricingRateSnapshot,
} from '../../../shared/types/accounting';

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

function currency(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : null;
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

/**
 * Apply only a frozen, authoritative price formula. If classification or any
 * billed unit is ambiguous, return unknown rather than guessing a monetary cost.
 */
export function calculateAttemptCost(input: {
  readonly snapshot: FrozenProviderRequestSnapshot;
  readonly usage: NormalizedProviderUsage | null | undefined;
  readonly evidence: AttemptCostEvidence;
}): AttemptCostResolution {
  const reported = decimal(input.evidence.reportedCostAmount);
  const reportedCurrency = currency(input.evidence.reportedCurrency ?? input.evidence.currency);
  if (reported && reportedCurrency) {
    return {
      state: 'reported',
      source: 'provider-reported',
      currency: reportedCurrency,
      amount: canonical(reported),
    };
  }

  const usage = input.usage;
  const pricing = input.snapshot.pricing;
  if (!usage || !pricing) return unknown('No frozen pricing formula or authoritative usage is available');

  const formulaCurrency = currency(input.evidence.currency ?? pricing.currency);
  if (!formulaCurrency) return unknown('A valid billing currency is unavailable');

  if (input.evidence.accountingMethod === 'energy') {
    const consumed = decimal(usage.energyKwhConsumed);
    const charged = decimal(usage.energyKwhCharged);
    const multiplier = decimal(usage.pricingMultiplier);
    const rateAmount = decimal(input.evidence.energyRateUsdPerKwh ?? pricing.rates.energy?.amount);
    const ratePer = pricing.rates.energy?.per ?? 1;
    if (!consumed || !charged || !multiplier || !rateAmount || ratePer <= 0) {
      return unknown('Complete authoritative charged-energy billing evidence is unavailable');
    }
    // charged energy is already the provider-reported post-multiplier unit;
    // preserve multiplier as evidence but do not double-discount the cost.
    return {
      state: 'calculated',
      source: 'energy-formula',
      currency: formulaCurrency,
      amount: canonical(rateAmount.mul(charged).div(ratePer)),
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
  if (!reasoning.isZero() && pricing.rates.reasoning) {
    if (pricing.inclusion.reasoning === 'unknown') return unknown('Reasoning inclusion semantics are ambiguous');
    if (pricing.inclusion.reasoning === 'subset-of-output') {
      if (!outputTokens || billableOutput.lessThan(reasoning)) return unknown('Output usage cannot classify reasoning tokens');
      billableOutput = billableOutput.sub(reasoning);
    }
  }

  let total = new Decimal(0);
  const inputCost = addRate(total, pricing.rates.input, billableInput, 'tokens');
  if (!inputCost) return unknown('Input token pricing is unavailable');
  total = inputCost;
  const outputCost = addRate(total, pricing.rates.output, billableOutput, 'tokens');
  if (!outputCost) return unknown('Output token pricing is unavailable');
  total = outputCost;

  const cacheReadCost = addRate(total, pricing.rates.cacheRead, cacheRead, 'tokens');
  if (!cacheReadCost) return unknown('Cache-read pricing is unavailable');
  total = cacheReadCost;
  const cacheWriteCost = addRate(total, pricing.rates.cacheWrite, cacheWrite, 'tokens');
  if (!cacheWriteCost) return unknown('Cache-write pricing is unavailable');
  total = cacheWriteCost;
  const reasoningCost = addRate(total, pricing.rates.reasoning, reasoning, 'tokens');
  if (!reasoningCost) return unknown('Reasoning pricing is unavailable');

  return {
    state: 'calculated',
    source: 'token-formula',
    currency: formulaCurrency,
    amount: canonical(reasoningCost),
  };
}
