/**
 * Immutable provider-attempt accounting contract. Values here are persisted in
 * the main-process ledger only; no credential-bearing fields are permitted.
 */
import type { CurrencyUnit } from './provider-facets';

export type AttemptOutcome = 'pending' | 'succeeded' | 'failed' | 'interrupted';
export type CostState = 'reported' | 'calculated' | 'unknown';
export type CostSource = 'provider-reported' | 'token-formula' | 'energy-formula' | 'unknown';

/** Decimal strings avoid floating-point drift in immutable money records. */
export type DecimalText = string;

/** Pricing ladder rung that produced a frozen rate (R5). */
export type PricingRateSource = 'provider-api' | 'user' | 'catalog';

export interface PricingRateProvenance {
  readonly source: PricingRateSource;
  /** Source observation time; null for sources without one (user overrides). */
  readonly observedAt: string | null;
  /** True when a dynamic provider source served latest-known data past its cadence. */
  readonly stale?: boolean;
}

export interface PricingRateSnapshot {
  readonly amount: DecimalText;
  readonly per: number;
  readonly unit: 'tokens' | 'requests' | 'characters' | 'energy';
  readonly provenance?: PricingRateProvenance;
}

export interface PricingInclusionSemantics {
  readonly cacheRead: 'subset-of-input' | 'additional' | 'unknown';
  readonly cacheWrite: 'subset-of-input' | 'additional' | 'unknown';
  readonly reasoning: 'subset-of-output' | 'additional' | 'unknown';
}

/** Full rate dimension set frozen for one pricing scope (R9). */
export interface PricingRateSnapshotSet {
  readonly input?: PricingRateSnapshot;
  readonly output?: PricingRateSnapshot;
  readonly cacheRead?: PricingRateSnapshot;
  readonly cacheWrite?: PricingRateSnapshot;
  /** Cache-write rates for non-default TTLs, keyed by TTL label. */
  readonly cacheWriteByTtl?: Readonly<Record<string, PricingRateSnapshot>>;
  readonly reasoning?: PricingRateSnapshot;
  /** Flat fee charged per request, independent of token usage. */
  readonly perRequest?: PricingRateSnapshot;
  readonly energy?: PricingRateSnapshot;
}

/** Rates that apply once the context exceeds a threshold of input tokens. */
export interface FrozenPricingContextTier {
  readonly overContextTokens: number;
  readonly rates: PricingRateSnapshotSet;
}

export interface FrozenPricingSnapshot {
  /** Cost-bucketing label: the ISO-4217 code for fiat, the native unit otherwise. */
  readonly currency: string;
  /** Typed unit declaration; required context whenever currency is non-fiat (R8). */
  readonly currencyUnit?: CurrencyUnit;
  readonly effectiveAt: string;
  readonly rates: PricingRateSnapshotSet;
  readonly contextTiers?: readonly FrozenPricingContextTier[];
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
  /** Absent on ledger rows written before display-name capture existed. */
  readonly modelDisplayName?: string | null;
  readonly protocol: string;
  readonly modelSource: 'catalog' | 'connection';
  readonly catalogVersion: number | null;
  readonly catalogSource: 'bundled' | 'cache' | 'none';
  readonly catalogObservedAt: string | null;
  readonly pricing: FrozenPricingSnapshot | null;
  readonly fieldProvenance: Readonly<Record<string, unknown>>;
  readonly statusObservation: Readonly<Record<string, unknown>> | null;
  /**
   * Tier-facet context frozen at request start (R22). `mechanism` is the
   * driver-declared kind; `requestedTier` is the opt-in selection; for
   * variant mechanisms `servedModelId`/`baseModelId` identify the billed
   * variant so cost resolution can select served rates.
   */
  readonly tier?: {
    readonly mechanism: 'request-parameter' | 'model-name-variants';
    readonly requestedTier?: string;
    readonly servedModelId?: string;
    readonly baseModelId?: string;
  };
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
  /** Pricing ladder rung that produced a calculated cost; null when reported/unknown. */
  readonly costRung: PricingRateSource | null;
  readonly currency: string | null;
  readonly costAmount: DecimalText | null;
  readonly error: string | null;
  readonly agentScope: string | null;
  readonly agentName: string | null;
  readonly agentTier: string | null;
  readonly agentType: string | null;
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

// ── Tool attempt telemetry ──────────────────────────────────────────────────

export type ToolAttemptOutcome = 'pending' | 'complete' | 'partial' | 'empty' | 'error' | 'cancelled';
export type ToolSource = 'builtin' | 'mcp';

export interface ToolAttemptRecord {
  readonly toolAttemptId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerAttemptId: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolSource: ToolSource;
  readonly mcpServerName: string | null;
  readonly toolFamily: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: ToolAttemptOutcome;
  readonly resultSizeBytes: number | null;
  readonly offloaded: boolean;
  readonly timeoutSeconds: number | null;
  readonly timedOut: boolean;
  readonly agentScope: string | null;
  readonly error: string | null;
}

// ── Context snapshot telemetry ───────────────────────────────────────────────

export interface ContextSnapshotRecord {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerAttemptId: string | null;
  /** Subagent scope id; null for the main agent. */
  readonly agentScope: string | null;
  readonly capturedAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usedTokens: number;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly toolUseTokens: number;
  readonly userTokens: number;
  readonly assistantTokens: number;
  readonly summaryTokens: number;
}

// ── Subagent attribution telemetry ──────────────────────────────────────────

export type SubagentAttributionStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface SubagentAttributionRecord {
  readonly attributionId: string;
  readonly subagentId: string;
  readonly sessionId: string;
  readonly chainId: string;
  readonly parentChainId: string | null;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: SubagentAttributionStatus;
}
