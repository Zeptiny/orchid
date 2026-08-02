/**
 * Analytics query result types — returned by the accounting store aggregate
 * methods and serialized over IPC to the renderer Analytics page.
 */

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
  readonly totalSessions: number;
}

export interface CurrencyTotal {
  readonly currency: string;
  readonly amount: string;
  readonly recordCount: number;
}

export interface TimeSeriesPoint {
  readonly date: string;
  readonly cost: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export interface SessionSummary {
  readonly sessionId: string;
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

export interface AttemptDetail {
  readonly attemptId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly outcome: string;
  readonly costAmount: string | null;
  readonly currency: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly latencyMs: number | null;
  readonly agentScope: string | null;
  readonly agentName: string | null;
  readonly agentTier: string | null;
  readonly error: string | null;
}

export interface ChainBreakdown {
  readonly chainId: string | null;
  readonly agentName: string | null;
  readonly agentTier: string | null;
  readonly totalCost: string;
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
  readonly totalCost: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attempts: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface SessionDetailResult {
  readonly sessionId: string;
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
  readonly providerId: string;
  readonly connectionName: string | null;
  readonly totalCost: string;
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
}

export interface ProviderBreakdown {
  readonly providerId: string;
  readonly providerDisplayName: string | null;
  readonly totalCost: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly attempts: number;
  readonly modelCount: number;
  readonly connectionCount: number;
  readonly failed: number;
  readonly interrupted: number;
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
  readonly totalCost: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly attempts: number;
  readonly completed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly avgDurationMs: number | null;
}

export interface ContextSnapshotSummary {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly capturedAt: string;
  readonly usedTokens: number;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly toolUseTokens: number;
  readonly userTokens: number;
  readonly assistantTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface OverviewResult {
  readonly stats: OverviewStats;
  readonly spendOverTime: readonly TimeSeriesPoint[];
  readonly tokenUsageOverTime: readonly TimeSeriesPoint[];
  readonly spendByModel: readonly { readonly modelId: string; readonly cost: string; readonly currency: string }[];
  readonly spendByProvider: readonly { readonly providerId: string; readonly cost: string; readonly currency: string }[];
  readonly outcomeDistribution: readonly { readonly outcome: string; readonly count: number }[];
  readonly costSourceDistribution: readonly { readonly source: string; readonly count: number }[];
  readonly agentTierDistribution: readonly { readonly tier: string; readonly count: number }[];
}

export interface ModelsResult {
  readonly models: readonly ModelBreakdown[];
  readonly providers: readonly ProviderBreakdown[];
  readonly costPerModelOverTime: readonly TimeSeriesPoint[];
  readonly costPerProviderOverTime: readonly TimeSeriesPoint[];
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
}

export interface ContextResult {
  readonly snapshots: readonly ContextSnapshotSummary[];
  readonly avgBreakdown: {
    readonly systemTokens: number;
    readonly toolsTokens: number;
    readonly toolUseTokens: number;
    readonly userTokens: number;
    readonly assistantTokens: number;
  };
}
