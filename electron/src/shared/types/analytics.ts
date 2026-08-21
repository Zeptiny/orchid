/**
 * Analytics query result types — returned by the accounting store aggregate
 * methods and serialized over IPC to the renderer Analytics page.
 */

export interface AnalyticsTimeRange {
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface OverviewStats {
  readonly totalCost: readonly CurrencyTotal[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly totalReasoningTokens: number;
  readonly totalAttempts: number;
  readonly succeededAttempts: number;
  readonly failedAttempts: number;
  readonly interruptedAttempts: number;
  readonly unknownCostCount: number;
  readonly knownUsageCount: number;
  readonly unknownUsageCount: number;
  readonly totalSessions: number;
  /** Mean first-token latency across attempts that stamped one; null when none. */
  readonly avgTtftMs: number | null;
  /** Total output tokens over total generation seconds; null when no samples. */
  readonly avgTokensPerSecond: number | null;
}

export interface CurrencyTotal {
  readonly currency: string;
  readonly amount: string;
  readonly recordCount: number;
}

export interface TimeSeriesPoint {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export interface CostTimeSeriesPoint {
  readonly date: string;
  readonly currency: string;
  readonly cost: string;
}

export interface ModelCostTimeSeriesPoint extends CostTimeSeriesPoint {
  readonly modelId: string;
  readonly providerId: string;
  readonly connectionId: string;
}

export interface ConnectionCostTimeSeriesPoint extends CostTimeSeriesPoint {
  readonly connectionId: string;
  readonly providerId: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly totalCost: readonly CurrencyTotal[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly firstAttempt: string | null;
  readonly lastAttempt: string | null;
  readonly modelsUsed: readonly string[];
  readonly subagentCount: number;
}

export interface SessionsResult {
  readonly sessions: readonly SessionSummary[];
  readonly totalSessions: number;
  readonly truncated: boolean;
}

export interface AttemptDetail {
  readonly attemptId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelDisplayName: string | null;
  readonly connectionId: string;
  readonly connectionName: string | null;
  readonly outcome: string;
  readonly costState: string;
  readonly costAmount: string | null;
  readonly currency: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  /**
   * Native-unit billing evidence retained from the attempt (R8). Present only
   * when the driver reported energy accounting (e.g. Neuralwatt kWh); never
   * force-converted into a fiat bucket.
   */
  readonly energyKwhConsumed: string | null;
  readonly energyKwhCharged: string | null;
  readonly pricingMultiplier: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly latencyMs: number | null;
  /** First streamed content delta timestamp; null for non-streamed attempts. */
  readonly firstTokenAt: string | null;
  /** first_token_at − started_at. */
  readonly ttftMs: number | null;
  /** Total output tokens over the generation window (completed − first token). */
  readonly tokensPerSecond: number | null;
  readonly agentScope: string | null;
  readonly agentName: string | null;
  readonly agentTier: string | null;
  readonly error: string | null;
}

export interface ChainBreakdown {
  readonly chainId: string | null;
  readonly agentName: string | null;
  readonly agentTier: string | null;
  readonly totalCost: readonly CurrencyTotal[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: number;
}

export interface ToolCallDetail {
  readonly toolAttemptId: string;
  readonly toolName: string;
  readonly toolSource: string;
  readonly mcpServerName: string | null;
  readonly toolFamily: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: string;
  readonly resultSizeBytes: number | null;
  readonly offloaded: boolean;
  readonly timedOut: boolean;
  readonly agentScope: string | null;
}

export interface SubagentBreakdownRow {
  readonly subagentId: string;
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly modelId: string;
  readonly status: string;
  readonly totalCost: readonly CurrencyTotal[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attempts: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface SessionDetailResult {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly summary: {
    readonly totalCost: readonly CurrencyTotal[];
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalCacheReadTokens: number;
    readonly attemptCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly interrupted: number;
    readonly firstAttempt: string | null;
    readonly lastAttempt: string | null;
    readonly modelsUsed: readonly string[];
    readonly providersUsed: readonly string[];
    readonly subagentCount: number;
  };
  readonly chains: readonly ChainBreakdown[];
  readonly attempts: readonly AttemptDetail[];
  readonly toolCalls: readonly ToolCallDetail[];
  readonly subagents: readonly SubagentBreakdownRow[];
}

export interface ModelBreakdown {
  readonly modelId: string;
  readonly modelDisplayName: string | null;
  readonly providerId: string;
  readonly connectionId: string;
  readonly connectionName: string | null;
  readonly totalCost: readonly CurrencyTotal[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly firstUsed: string | null;
  readonly lastUsed: string | null;
  /** TTFT distribution (avg / nearest-rank p50 / p95) in ms; null without samples. */
  readonly avgTtftMs: number | null;
  readonly p50TtftMs: number | null;
  readonly p95TtftMs: number | null;
  /** Total output tokens over total generation seconds; null without samples. */
  readonly avgTokensPerSecond: number | null;
}

export interface ProviderBreakdown {
  readonly providerId: string;
  readonly providerDisplayName: string | null;
  readonly totalCost: readonly CurrencyTotal[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly attempts: number;
  readonly modelCount: number;
  readonly connectionCount: number;
  readonly failed: number;
  readonly interrupted: number;
}

export interface ConnectionBreakdown {
  readonly connectionId: string;
  readonly connectionName: string | null;
  readonly providerId: string;
  readonly providerDisplayName: string | null;
  readonly totalCost: readonly CurrencyTotal[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly modelCount: number;
  readonly firstUsed: string | null;
  readonly lastUsed: string | null;
  /** TTFT distribution (avg / nearest-rank p50 / p95) in ms; null without samples. */
  readonly avgTtftMs: number | null;
  readonly p50TtftMs: number | null;
  readonly p95TtftMs: number | null;
  /** Total output tokens over total generation seconds; null without samples. */
  readonly avgTokensPerSecond: number | null;
}

export interface ToolBreakdown {
  readonly toolName: string;
  readonly toolSource: string;
  readonly mcpServerName: string | null;
  readonly toolFamily: string;
  readonly invocations: number;
  readonly complete: number;
  readonly error: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly avgDurationMs: number | null;
  readonly avgResultSizeBytes: number | null;
  readonly offloadRate: number;
}

export interface SubagentSummary {
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly modelsUsed: readonly string[];
  readonly invocations: number;
  readonly totalCost: readonly CurrencyTotal[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attempts: number;
  readonly completed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly avgDurationMs: number | null;
}

export interface ContextSessionSeries {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly maxUsedTokens: number;
  readonly points: ReadonlyArray<{ readonly capturedAt: string; readonly usedTokens: number }>;
}

export interface ContextSubagentSeries {
  readonly subagentId: string;
  readonly agentName: string | null;
  readonly agentTier: string | null;
  readonly maxUsedTokens: number;
  readonly points: ReadonlyArray<{ readonly capturedAt: string; readonly usedTokens: number }>;
}

export interface OverviewResult {
  readonly stats: OverviewStats;
  readonly spendOverTime: readonly CostTimeSeriesPoint[];
  readonly tokenUsageOverTime: readonly TimeSeriesPoint[];
  readonly spendByModel: readonly { readonly modelId: string; readonly providerId: string; readonly cost: string; readonly currency: string }[];
  readonly spendByProvider: readonly { readonly providerId: string; readonly cost: string; readonly currency: string }[];
  readonly outcomeDistribution: readonly { readonly outcome: string; readonly count: number }[];
  readonly costSourceDistribution: readonly { readonly source: string; readonly count: number }[];
  readonly agentTierDistribution: readonly { readonly tier: string; readonly count: number }[];
  /**
   * Typed quota snapshots by provider for facet-capable connections (R24).
   * Rendered in native units; informational only, never merged with spend (AE7).
   */
  readonly quotaByProvider: readonly QuotaOverviewEntry[];
}

/** One provider's latest typed quota snapshot for analytics (R24). */
export interface QuotaOverviewEntry {
  readonly providerId: string;
  readonly connectionId: string | null;
  readonly observedAt: string;
  readonly stale: boolean;
  readonly balances: readonly {
    readonly label: string;
    readonly amount: string;
    readonly unit: string;
  }[];
  readonly subscription: {
    readonly state: string;
    readonly displayName: string | null;
    readonly renewsAt: string | null;
  } | null;
  readonly allowances: readonly {
    readonly label: string;
    readonly state: string;
    readonly detail: string | null;
  }[];
}

export interface ModelsResult {
  readonly totalCost: readonly CurrencyTotal[];
  readonly models: readonly ModelBreakdown[];
  readonly connections: readonly ConnectionBreakdown[];
  readonly costPerModelOverTime: readonly ModelCostTimeSeriesPoint[];
  readonly costPerConnectionOverTime: readonly ConnectionCostTimeSeriesPoint[];
}

export interface ToolsResult {
  readonly tools: readonly ToolBreakdown[];
  readonly invocationsOverTime: readonly { readonly date: string; readonly toolName: string; readonly count: number }[];
  readonly outcomeDistribution: readonly { readonly outcome: string; readonly count: number }[];
}

export interface SubagentsResult {
  readonly summaries: readonly SubagentSummary[];
  readonly costByAgentName: readonly { readonly agentName: string; readonly cost: string; readonly currency: string }[];
  readonly costByAgentTier: readonly { readonly tier: string; readonly cost: string; readonly currency: string }[];
  readonly outcomeDistribution: readonly { readonly status: string; readonly count: number }[];
  readonly invocationsOverTime: ReadonlyArray<{ readonly date: string; readonly count: number }>;
}

export interface ContextResult {
  readonly totalSnapshots: number;
  readonly totalSessionCount: number;
  /** Main-agent series only (agent_scope IS NULL). */
  readonly topSessions: ReadonlyArray<ContextSessionSeries>;
  /** One series per subagent scope (agent_scope IS NOT NULL). */
  readonly topSubagents: ReadonlyArray<ContextSubagentSeries>;
  readonly totalSubagentCount: number;
  readonly avgBreakdown: {
    readonly usedTokens: number;
    readonly systemTokens: number;
    readonly toolsTokens: number;
    readonly toolUseTokens: number;
    readonly userTokens: number;
    readonly assistantTokens: number;
    readonly summaryTokens: number;
  };
}

// ── Model detail (Models & Providers drill-down) ─────────────────────────────

/** Aggregates for one (model_id, provider_id, connection_id) triple. */
export interface ModelDetailStats {
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalCost: readonly CurrencyTotal[];
  readonly firstUsed: string | null;
  readonly lastUsed: string | null;
  /** TTFT distribution (avg / nearest-rank p50 / p95) in ms; null without samples. */
  readonly avgTtftMs: number | null;
  readonly p50TtftMs: number | null;
  readonly p95TtftMs: number | null;
  /** Total output tokens over total generation seconds; null without samples. */
  readonly avgTokensPerSecond: number | null;
}

/**
 * TTFT histogram bucket: floor(ttft / 50) * 50, capped at 5000 (overflow is
 * lumped into the 5000 bucket). Only non-empty buckets are returned, ordered
 * by bucketMs ascending.
 */
export interface TtftHistogramBucket {
  readonly bucketMs: number;
  readonly count: number;
}

/** Daily nearest-rank TTFT percentiles; only days with latency samples. */
export interface TtftOverTimePoint {
  readonly date: string;
  readonly medianTtftMs: number;
  readonly p95TtftMs: number;
  /** Attempts that stamped a first token on this day. */
  readonly attempts: number;
}

/**
 * Daily stacked token series. netInput strips cache reads, netOutput strips
 * reasoning tokens, so the four values stack to the day's gross usage.
 */
export interface ModelTokensOverTimePoint {
  readonly date: string;
  readonly netInputTokens: number;
  readonly cacheReadTokens: number;
  readonly netOutputTokens: number;
  readonly reasoningTokens: number;
}

export interface ModelTopSession {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalCost: readonly CurrencyTotal[];
}

export interface ModelDetailResult {
  readonly modelId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly stats: ModelDetailStats;
  readonly ttftHistogram: readonly TtftHistogramBucket[];
  readonly ttftOverTime: readonly TtftOverTimePoint[];
  readonly tokensOverTime: readonly ModelTokensOverTimePoint[];
  readonly costOverTime: readonly CostTimeSeriesPoint[];
  readonly topSessions: readonly ModelTopSession[];
  readonly recentAttempts: readonly AttemptDetail[];
}

// ── Subagent detail (Subagents drill-down) ───────────────────────────────────

/** One attribution row with its chain's attempts joined in. */
export interface SubagentInvocation {
  readonly subagentId: string;
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly chainId: string;
  readonly modelId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalCost: readonly CurrencyTotal[];
}

export interface SubagentDetailSummary {
  readonly invocations: number;
  readonly completed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalCost: readonly CurrencyTotal[];
  readonly avgDurationMs: number | null;
  /** Latency over the joined chain attempts; null without first-token samples. */
  readonly avgTtftMs: number | null;
  readonly p50TtftMs: number | null;
  readonly p95TtftMs: number | null;
  readonly avgTokensPerSecond: number | null;
}

export interface SubagentModelUsage {
  readonly modelId: string;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalCost: readonly CurrencyTotal[];
}

/**
 * Subagent explorer drill-down result. Named `SubagentAnalyticsDetailResult`
 * to avoid colliding with the live-subagent `SubagentDetailResult` in ipc.ts.
 */
export interface SubagentAnalyticsDetailResult {
  readonly agentName: string;
  readonly agentType: string;
  readonly agentTier: string;
  readonly invocations: readonly SubagentInvocation[];
  /** True when the invocation list was capped (newest 500 kept). */
  readonly truncated: boolean;
  readonly summary: SubagentDetailSummary;
  readonly modelsUsed: readonly SubagentModelUsage[];
  readonly invocationsOverTime: ReadonlyArray<{ readonly date: string; readonly count: number }>;
}

// ── Context session detail (Context drill-down) ──────────────────────────────

/** Picker entry: every distinct main-agent session with snapshots in range. */
export interface ContextSessionPickerEntry {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly snapshotCount: number;
  readonly maxUsedTokens: number;
}

/** Full-fidelity main-agent snapshot point (no stride sampling). */
export interface ContextSessionDetailPoint {
  readonly capturedAt: string;
  readonly usedTokens: number;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly toolUseTokens: number;
  readonly userTokens: number;
  readonly assistantTokens: number;
  readonly summaryTokens: number;
  readonly turnId: string | null;
  readonly providerAttemptId: string | null;
}

/** Compaction run (compactor / compactor-selective attempt) for the session. */
export interface ContextCompactionEvent {
  readonly type: 'compaction';
  readonly at: string;
  readonly agentName: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** One of the largest positive used_tokens deltas between consecutive snapshots. */
export interface ContextJumpEvent {
  readonly type: 'jump';
  /** capturedAt of the later of the two consecutive points. */
  readonly at: string;
  readonly deltaTokens: number;
  readonly fromTokens: number;
  readonly toTokens: number;
  readonly segmentDeltas: {
    readonly system: number;
    readonly tools: number;
    readonly toolUse: number;
    readonly user: number;
    readonly assistant: number;
    readonly summary: number;
  };
}

/** Timeline events interleaved by time for the drill-down view. */
export type ContextEvent = ContextCompactionEvent | ContextJumpEvent;

export interface ContextSessionDetailResult {
  readonly sessionId: string;
  readonly sessionName: string | null;
  readonly sessions: readonly ContextSessionPickerEntry[];
  readonly series: readonly ContextSessionDetailPoint[];
  /** True when the series was capped at the 2000 most recent snapshots. */
  readonly truncated: boolean;
  readonly events: readonly ContextEvent[];
}
