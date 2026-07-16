/**
 * Immutable provider-attempt accounting contract. Values here are persisted in
 * the main-process ledger only; no credential-bearing fields are permitted.
 */

export type AttemptOutcome = 'pending' | 'succeeded' | 'failed' | 'interrupted';
export type CostState = 'reported' | 'calculated' | 'unknown';
export type CostSource = 'provider-reported' | 'token-formula' | 'energy-formula' | 'unknown';

/** Decimal strings avoid floating-point drift in immutable money records. */
export type DecimalText = string;

export interface PricingRateSnapshot {
  readonly amount: DecimalText;
  readonly per: number;
  readonly unit: 'tokens' | 'requests' | 'characters' | 'energy';
}

export interface PricingInclusionSemantics {
  readonly cacheRead: 'subset-of-input' | 'additional' | 'unknown';
  readonly cacheWrite: 'subset-of-input' | 'additional' | 'unknown';
  readonly reasoning: 'subset-of-output' | 'additional' | 'unknown';
}

export interface FrozenPricingSnapshot {
  readonly currency: string;
  readonly effectiveAt: string;
  readonly rates: Readonly<{
    input?: PricingRateSnapshot;
    output?: PricingRateSnapshot;
    cacheRead?: PricingRateSnapshot;
    cacheWrite?: PricingRateSnapshot;
    reasoning?: PricingRateSnapshot;
    energy?: PricingRateSnapshot;
  }>;
  readonly inclusion: PricingInclusionSemantics;
  readonly provenance: Readonly<Record<string, unknown>>;
}

/** Only non-overlapping normalized dimensions are summed by formulae. */
export interface NormalizedProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly energyKwhConsumed?: DecimalText;
  readonly energyKwhCharged?: DecimalText;
  readonly pricingMultiplier?: DecimalText;
}

export interface FrozenProviderRequestSnapshot {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly modelId: string;
  readonly protocol: string;
  readonly modelSource: 'catalog' | 'connection';
  readonly catalogVersion: number | null;
  readonly catalogSource: 'bundled' | 'cache' | 'none';
  readonly catalogObservedAt: string | null;
  readonly pricing: FrozenPricingSnapshot | null;
  readonly fieldProvenance: Readonly<Record<string, unknown>>;
  readonly statusObservation: Readonly<Record<string, unknown>> | null;
}

export interface ProviderAttemptRecord {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly sdkCallId: string | null;
  readonly snapshot: FrozenProviderRequestSnapshot;
  readonly outcome: AttemptOutcome;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly usage: NormalizedProviderUsage | null;
  readonly providerEvidence: Readonly<Record<string, unknown>>;
  readonly costState: CostState;
  readonly costSource: CostSource;
  readonly currency: string | null;
  readonly costAmount: DecimalText | null;
  readonly error: string | null;
}

/** Per-currency known cost sum (unknown costs are not included here). */
export interface KnownCostTotals {
  readonly currency: string;
  readonly amount: DecimalText;
  readonly recordCount: number;
}

/**
 * Aggregate cost view for a session or chain.
 * `unknownCount` is attached once at this level — not duplicated per currency row.
 */
export interface CostTotalsSummary {
  readonly currencies: readonly KnownCostTotals[];
  readonly unknownCount: number;
}
