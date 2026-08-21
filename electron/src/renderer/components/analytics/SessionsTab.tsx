import { useEffect, useState } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import {
  StatCard,
  ChartCard,
  SortableTable,
  formatTokenCount,
  formatCost,
  formatCostAmount,
  formatNativeAmount,
  formatDuration,
  formatDate,
  formatTps,
  formatTtft,
  formatBytes,
  truncateId,
  netInputTokens,
  netOutputTokens,
  tokenStackTooltipRows,
  CHART_PALETTE,
  GRID_STROKE,
  axisTickProps,
  costTooltipProps,
  TokenUsageTooltip,
} from './shared';
import { Button } from '../ui/Button';
import {
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { SessionSummary, AnalyticsTimeRange } from '../../../shared/types/analytics';

const DETAIL_PAGE_SIZE = 10;
const SESSIONS_PAGE_SIZE = 100;

function dateSortValue(iso: string | null): number {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? 0 : ms;
}

interface SessionTokenUsageRow {
  label: string;
  netInput: number;
  cacheRead: number;
  netOutput: number;
  cacheWrite: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

interface TokensByModelRow {
  label: string;
  netInput: number;
  cacheRead: number;
  netOutput: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function SessionList({ timeRange, onRowClick }: { timeRange: AnalyticsTimeRange; onRowClick: (row: SessionSummary) => void }) {
  const [page, setPage] = useState(0);
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.sessions({
      timeRange,
      limit: SESSIONS_PAGE_SIZE,
      offset: page * SESSIONS_PAGE_SIZE,
    }),
    [timeRange, page],
  );

  useEffect(() => {
    setPage(0);
  }, [timeRange]);

  const totalPages = Math.max(1, Math.ceil((data?.totalSessions ?? 0) / SESSIONS_PAGE_SIZE));

  // Clamp when the ledger shrinks (e.g. a filter change) so the pager can
  // never sit past the last page.
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  if (loading) return <div className="p-8 text-base-content/50">Loading sessions…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Sessions</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>
      <div title="Sorting applies within the current page">
        <SortableTable
          columns={[
            { key: 'sessionName', label: 'Session Name', sortable: true, sortValue: (r) => r.sessionName ?? '', render: (r) => <span title={r.sessionId}>{r.sessionName ?? '—'}</span> },
            { key: 'totalCost', label: 'Total Cost', sortable: true, initialDir: 'desc', sortValue: (r) => Math.max(...r.totalCost.map((c) => Number(c.amount)), 0), render: (r) => formatCost(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens, render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens, render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'cache', label: 'Cache', sortable: true, initialDir: 'desc', sortValue: (r) => r.cacheReadTokens, render: (r) => formatTokenCount(r.cacheReadTokens) },
            { key: 'outcomes', label: 'Outcomes', sortable: true, initialDir: 'desc', sortValue: (r) => r.attempts, render: (r) => <span title={`${r.succeeded} succeeded / ${r.failed} failed / ${r.interrupted} interrupted`}>{r.succeeded}/{r.failed}/{r.interrupted}</span> },
            { key: 'firstAttempt', label: 'First Attempt', sortable: true, initialDir: 'desc', sortValue: (r) => dateSortValue(r.firstAttempt), render: (r) => formatDate(r.firstAttempt) },
            { key: 'lastAttempt', label: 'Last Attempt', sortable: true, initialDir: 'desc', sortValue: (r) => dateSortValue(r.lastAttempt), render: (r) => formatDate(r.lastAttempt) },
            { key: 'models', label: 'Models', sortable: true, initialDir: 'desc', sortValue: (r) => r.modelsUsed.join(','), render: (r) => r.modelsUsed.join(', ') || '—' },
            { key: 'subagents', label: 'Subagents', sortable: true, initialDir: 'desc', sortValue: (r) => r.subagentCount, render: (r) => r.subagentCount },
          ]}
          rows={data.sessions}
          rowKey={(r) => r.sessionId}
          onRowClick={onRowClick}
          emptyMessage="No sessions found"
        />
      </div>
      {data.totalSessions > SESSIONS_PAGE_SIZE && (
        <div className="flex items-center justify-between px-1 py-2 text-xs text-base-content/50">
          <span>
            {page * SESSIONS_PAGE_SIZE + 1}–{Math.min((page + 1) * SESSIONS_PAGE_SIZE, data.totalSessions)} of {data.totalSessions}
          </span>
          <div className="flex gap-1">
            <button
              className="rounded px-2 py-1 hover:bg-base-200 disabled:opacity-30"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              ← Prev
            </button>
            <span className="px-2 py-1">Page {page + 1}/{totalPages}</span>
            <button
              className="rounded px-2 py-1 hover:bg-base-200 disabled:opacity-30"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next →
            </button>
          </div>
        </div>
      )}
      {data.truncated && (page + 1) * SESSIONS_PAGE_SIZE < data.totalSessions && (
        <div className="text-xs text-base-content/50">Showing {data.sessions.length} of {data.totalSessions} sessions in this range.</div>
      )}
    </div>
  );
}

function SessionDetail({ sessionId, timeRange, onBack }: { sessionId: string; timeRange: AnalyticsTimeRange; onBack: () => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.sessionDetail({ sessionId, timeRange }),
    [sessionId, timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading session detail…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const { summary } = data;

  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0, reasoningTokens = 0;
  for (const a of data.attempts) {
    inputTokens += a.inputTokens ?? 0;
    outputTokens += a.outputTokens ?? 0;
    cacheRead += a.cacheReadTokens ?? 0;
    cacheWrite += a.cacheWriteTokens ?? 0;
    reasoningTokens += a.reasoningTokens ?? 0;
  }
  const netInput = netInputTokens(inputTokens, cacheRead);
  const netOutput = netOutputTokens(outputTokens, reasoningTokens);
  const tokenUsageRow: SessionTokenUsageRow = {
    label: 'Total',
    netInput,
    cacheRead,
    netOutput,
    cacheWrite,
    inputTokens,
    outputTokens,
    reasoningTokens,
  };

  const costByModelMap = new Map<string, {
    providerId: string; modelId: string; connectionId: string; currency: string; cost: number;
  }>();
  const tokensByModelMap = new Map<string, {
    providerId: string; modelId: string; modelDisplayName: string | null;
    connectionId: string; connectionName: string | null;
    input: number; output: number; cacheRead: number; reasoning: number;
  }>();
  for (const a of data.attempts) {
    const identityKey = `${a.providerId}\0${a.modelId}\0${a.connectionId}`;
    if ((a.costState === 'reported' || a.costState === 'calculated') && a.costAmount !== null && a.currency !== null) {
      const key = `${identityKey}\0${a.currency}`;
      const entry = costByModelMap.get(key) ?? {
        providerId: a.providerId,
        modelId: a.modelId,
        connectionId: a.connectionId,
        currency: a.currency,
        cost: 0,
      };
      entry.cost += Number(a.costAmount);
      costByModelMap.set(key, entry);
    }
    const entry = tokensByModelMap.get(identityKey) ?? {
      providerId: a.providerId,
      modelId: a.modelId,
      modelDisplayName: a.modelDisplayName,
      connectionId: a.connectionId,
      connectionName: a.connectionName,
      input: 0,
      output: 0,
      cacheRead: 0,
      reasoning: 0,
    };
    entry.input += a.inputTokens ?? 0;
    entry.output += a.outputTokens ?? 0;
    entry.cacheRead += a.cacheReadTokens ?? 0;
    entry.reasoning += a.reasoningTokens ?? 0;
    tokensByModelMap.set(identityKey, entry);
  }
  const costByModel = Array.from(costByModelMap.values()).map((entry) => ({
    ...entry,
    label: `${entry.providerId}/${entry.modelId}/${truncateId(entry.connectionId)} (${entry.currency})`,
  }));
  const tokensByModel: TokensByModelRow[] = Array.from(tokensByModelMap.values(), (t) => ({
    label: `${t.connectionName ?? t.connectionId.slice(0, 8)} - ${t.modelDisplayName ?? t.modelId}`,
    netInput: netInputTokens(t.input, t.cacheRead),
    cacheRead: t.cacheRead,
    netOutput: netOutputTokens(t.output, t.reasoning),
    inputTokens: t.input,
    outputTokens: t.output,
    reasoningTokens: t.reasoning,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-base-content/60 hover:text-base-content">← Back to Sessions</button>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <h2 className="text-lg font-semibold text-base-content">
        {data.sessionName ?? truncateId(sessionId, 12)}
        <span className="ml-2 text-sm font-normal text-base-content/40" title={sessionId}>{truncateId(sessionId, 8)}</span>
      </h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Cost" value={formatCost(summary.totalCost)} />
        <StatCard label="Total Tokens" value={formatTokenCount(summary.totalInputTokens + summary.totalOutputTokens)} subtext={`${formatTokenCount(summary.totalInputTokens)} in / ${formatTokenCount(summary.totalOutputTokens)} out`} />
        <StatCard label="Cache Read" value={formatTokenCount(summary.totalCacheReadTokens)} />
        <StatCard label="Attempts" value={summary.attemptCount} subtext={`${summary.succeeded} succeeded / ${summary.failed} failed / ${summary.interrupted} interrupted`} />
        <StatCard label="Subagents" value={summary.subagentCount} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Token Usage" empty={netInput + cacheRead + outputTokens === 0} emptyMessage="No token usage recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={[tokenUsageRow]}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip content={(props) => {
                const row = props.payload?.[0]?.payload as SessionTokenUsageRow | undefined;
                if (!row) return null;
                return (
                  <TokenUsageTooltip
                    active={props.active}
                    label={row.label}
                    rows={[
                      ...tokenStackTooltipRows(row.inputTokens, row.cacheRead, row.outputTokens, row.reasoningTokens),
                      { name: 'Cache Write', value: row.cacheWrite },
                    ]}
                  />
                );
              }} />
              <Legend />
              <Bar dataKey="netInput" name="Input (net of cache)" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="cacheRead" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="netOutput" name="Output (net of reasoning)" stackId="a" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost by Model" empty={costByModel.length === 0} emptyMessage="No cost data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costByModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={150} />
              <Tooltip {...costTooltipProps} formatter={(value, _name, item) => formatCostAmount(String(value), item.payload.currency)} />
              <Bar dataKey="cost" fill={CHART_PALETTE[0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Tokens by Model" className="lg:col-span-2" empty={tokensByModel.length === 0} emptyMessage="No token usage recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokensByModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={180} />
              <Tooltip content={(props) => {
                const row = props.payload?.[0]?.payload as TokensByModelRow | undefined;
                if (!row) return null;
                return (
                  <TokenUsageTooltip
                    active={props.active}
                    label={row.label}
                    rows={tokenStackTooltipRows(row.inputTokens, row.cacheRead, row.outputTokens, row.reasoningTokens)}
                  />
                );
              }} />
              <Legend />
              <Bar dataKey="netInput" name="Input (net of cache)" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="cacheRead" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="netOutput" name="Output (net of reasoning)" stackId="a" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Chain Breakdown">
        <SortableTable
          columns={[
            { key: 'chainId', label: 'Chain ID', sortable: true, sortValue: (r) => r.chainId ?? '', render: (r) => r.chainId ? <span title={r.chainId}>{truncateId(r.chainId)}</span> : '—' },
            { key: 'agentName', label: 'Agent', sortable: true, sortValue: (r) => r.agentName ?? '', render: (r) => r.agentName ?? '—' },
            { key: 'agentTier', label: 'Tier', sortable: true, sortValue: (r) => r.agentTier ?? '', render: (r) => r.agentTier ?? '—' },
            { key: 'totalCost', label: 'Cost', sortable: true, initialDir: 'desc', sortValue: (r) => Math.max(...r.totalCost.map((c) => Number(c.amount)), 0), render: (r) => formatCost(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens, render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens, render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (r) => r.attempts, render: (r) => r.attempts },
            { key: 'outcomes', label: 'Outcomes', sortable: true, initialDir: 'desc', sortValue: (r) => r.attempts, render: (r) => `${r.succeeded}/${r.failed}/${r.interrupted}` },
          ]}
          rows={data.chains}
          rowKey={(r) => r.chainId ?? `no-chain-${r.agentName ?? 'default'}`}
          emptyMessage="No chains"
        />
      </ChartCard>

      <ChartCard title="Attempt Timeline">
        <SortableTable
          columns={[
            { key: 'attemptId', label: 'Attempt ID', sortable: true, sortValue: (r) => r.attemptId, render: (r) => <span title={r.attemptId}>{truncateId(r.attemptId)}</span> },
            { key: 'startedAt', label: 'Started', sortable: true, initialDir: 'desc', sortValue: (r) => dateSortValue(r.startedAt), render: (r) => formatDate(r.startedAt) },
            { key: 'modelId', label: 'Model', sortable: true, sortValue: (r) => r.modelId, render: (r) => r.modelId },
            { key: 'connectionId', label: 'Connection', sortable: true, sortValue: (r) => r.connectionName ?? r.connectionId, render: (r) => <span title={r.connectionId}>{r.connectionName ?? truncateId(r.connectionId)}</span> },
            { key: 'outcome', label: 'Outcome', sortable: true, sortValue: (r) => r.outcome, render: (r) => r.outcome },
            { key: 'costState', label: 'Cost State', sortable: true, sortValue: (r) => r.costState, render: (r) => r.costState },
            { key: 'costAmount', label: 'Cost', sortable: true, initialDir: 'desc', sortValue: (r) => r.costAmount !== null ? Number(r.costAmount) : -1, render: (r) => formatCostAmount(r.costAmount, r.currency) },
            { key: 'inputTokens', label: 'Input', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens ?? -1, render: (r) => r.inputTokens !== null ? formatTokenCount(r.inputTokens) : '—' },
            { key: 'outputTokens', label: 'Output', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens ?? -1, render: (r) => r.outputTokens !== null ? formatTokenCount(r.outputTokens) : '—' },
            { key: 'cacheReadTokens', label: 'Cache Read', sortable: true, initialDir: 'desc', sortValue: (r) => r.cacheReadTokens ?? -1, render: (r) => r.cacheReadTokens !== null ? formatTokenCount(r.cacheReadTokens) : '—' },
            { key: 'cacheWriteTokens', label: 'Cache Write', sortable: true, initialDir: 'desc', sortValue: (r) => r.cacheWriteTokens ?? -1, render: (r) => r.cacheWriteTokens !== null ? formatTokenCount(r.cacheWriteTokens) : '—' },
            { key: 'reasoningTokens', label: 'Reasoning', sortable: true, initialDir: 'desc', sortValue: (r) => r.reasoningTokens ?? -1, render: (r) => r.reasoningTokens !== null ? formatTokenCount(r.reasoningTokens) : '—' },
            { key: 'energy', label: 'Energy (kWh)', sortable: true, initialDir: 'desc', sortValue: (r) => Number(r.energyKwhCharged ?? r.energyKwhConsumed ?? -1), render: (r) => r.energyKwhCharged !== null || r.energyKwhConsumed !== null
              ? (
                <span title={r.pricingMultiplier !== null ? `×${r.pricingMultiplier} multiplier` : undefined}>
                  {formatNativeAmount(r.energyKwhCharged ?? r.energyKwhConsumed, 'kWh')}
                  {r.energyKwhCharged !== null && r.energyKwhConsumed !== null && r.energyKwhCharged !== r.energyKwhConsumed && (
                    <span className="ml-1 text-base-content/40">(of {formatNativeAmount(r.energyKwhConsumed, 'kWh')})</span>
                  )}
                </span>
              )
              : '—' },
            { key: 'latencyMs', label: 'Latency', sortable: true, initialDir: 'desc', sortValue: (r) => r.latencyMs ?? -1, render: (r) => formatDuration(r.latencyMs) },
            { key: 'ttftMs', label: 'TTFT', sortable: true, initialDir: 'desc', sortValue: (r) => r.ttftMs ?? -1, render: (r) => formatTtft(r.ttftMs) },
            { key: 'tokensPerSecond', label: 'TPS', sortable: true, initialDir: 'desc', sortValue: (r) => r.tokensPerSecond ?? -1, render: (r) => formatTps(r.tokensPerSecond) },
            { key: 'agent', label: 'Agent', sortable: true, sortValue: (r) => r.agentName ?? r.agentScope ?? '', render: (r) => r.agentName ?? r.agentScope ?? '—' },
            { key: 'error', label: 'Error', sortable: true, sortValue: (r) => r.error ?? '', render: (r) => r.error ?? '—' },
          ]}
          rows={data.attempts}
          rowKey={(r) => r.attemptId}
          emptyMessage="No attempts"
          pageSize={DETAIL_PAGE_SIZE}
        />
      </ChartCard>

      <ChartCard title="Tool Calls">
        <SortableTable
          columns={[
            { key: 'toolName', label: 'Tool Name', sortable: true, sortValue: (r) => r.toolName, render: (r) => r.toolName },
            { key: 'toolSource', label: 'Source', sortable: true, sortValue: (r) => r.toolSource, render: (r) => r.toolSource },
            { key: 'mcpServerName', label: 'MCP Server', sortable: true, sortValue: (r) => r.mcpServerName ?? '', render: (r) => r.mcpServerName ?? '—' },
            { key: 'startedAt', label: 'Started', sortable: true, initialDir: 'desc', sortValue: (r) => dateSortValue(r.startedAt), render: (r) => formatDate(r.startedAt) },
            { key: 'durationMs', label: 'Duration', sortable: true, initialDir: 'desc', sortValue: (r) => r.durationMs ?? -1, render: (r) => formatDuration(r.durationMs) },
            { key: 'outcome', label: 'Outcome', sortable: true, sortValue: (r) => r.outcome, render: (r) => r.outcome },
            { key: 'resultSizeBytes', label: 'Result Size', sortable: true, initialDir: 'desc', sortValue: (r) => r.resultSizeBytes ?? -1, render: (r) => formatBytes(r.resultSizeBytes) },
            { key: 'offloaded', label: 'Offloaded', sortable: true, initialDir: 'desc', sortValue: (r) => r.offloaded ? 1 : 0, render: (r) => r.offloaded ? 'Yes' : 'No' },
            { key: 'timedOut', label: 'Timed Out', sortable: true, initialDir: 'desc', sortValue: (r) => r.timedOut ? 1 : 0, render: (r) => r.timedOut ? 'Yes' : 'No' },
            { key: 'agentScope', label: 'Agent', sortable: true, sortValue: (r) => r.agentScope ?? '', render: (r) => r.agentScope ?? '—' },
          ]}
          rows={data.toolCalls}
          rowKey={(r) => r.toolAttemptId}
          emptyMessage="No tool calls"
          pageSize={DETAIL_PAGE_SIZE}
        />
      </ChartCard>

      <ChartCard title="Subagents">
        <SortableTable
          columns={[
            { key: 'subagentId', label: 'Subagent ID', sortable: true, sortValue: (r) => r.subagentId, render: (r) => <span title={r.subagentId}>{truncateId(r.subagentId)}</span> },
            { key: 'agentName', label: 'Agent Name', sortable: true, sortValue: (r) => r.agentName, render: (r) => r.agentName },
            { key: 'agentType', label: 'Type', sortable: true, sortValue: (r) => r.agentType, render: (r) => r.agentType },
            { key: 'agentTier', label: 'Tier', sortable: true, sortValue: (r) => r.agentTier, render: (r) => r.agentTier },
            { key: 'modelId', label: 'Model', sortable: true, sortValue: (r) => r.modelId, render: (r) => r.modelId },
            { key: 'status', label: 'Status', sortable: true, sortValue: (r) => r.status, render: (r) => r.status },
            { key: 'totalCost', label: 'Cost', sortable: true, initialDir: 'desc', sortValue: (r) => Math.max(...r.totalCost.map((c) => Number(c.amount)), 0), render: (r) => formatCost(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens, render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens, render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (r) => r.attempts, render: (r) => r.attempts },
            { key: 'startedAt', label: 'Started', sortable: true, initialDir: 'desc', sortValue: (r) => dateSortValue(r.startedAt), render: (r) => formatDate(r.startedAt) },
            { key: 'completedAt', label: 'Completed', sortable: true, initialDir: 'desc', sortValue: (r) => dateSortValue(r.completedAt), render: (r) => formatDate(r.completedAt) },
          ]}
          rows={data.subagents}
          rowKey={(r) => `${r.subagentId}:${r.startedAt}`}
          emptyMessage="No subagents"
          pageSize={DETAIL_PAGE_SIZE}
        />
      </ChartCard>
    </div>
  );
}

export function SessionsTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  if (selectedSessionId !== null) {
    return <SessionDetail sessionId={selectedSessionId} timeRange={timeRange} onBack={() => setSelectedSessionId(null)} />;
  }
  return <SessionList timeRange={timeRange} onRowClick={(row) => setSelectedSessionId(row.sessionId)} />;
}
