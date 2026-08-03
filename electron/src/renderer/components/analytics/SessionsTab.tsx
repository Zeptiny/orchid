import { useState } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import {
  StatCard,
  ChartCard,
  SortableTable,
  formatTokenCount,
  formatCost,
  formatCostAmount,
  formatDuration,
  formatDate,
  formatBytes,
  truncateId,
  CHART_PALETTE,
  GRID_STROKE,
  axisTickProps,
  tokenTooltipProps,
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

interface SessionTokenUsageRow {
  label: string;
  netInput: number;
  cacheRead: number;
  output: number;
  cacheWrite: number;
  reasoning: number;
}

function SessionList({ timeRange, onRowClick }: { timeRange: AnalyticsTimeRange; onRowClick: (row: SessionSummary) => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.sessions({ timeRange }),
    [timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading sessions…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Sessions</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>
      <SortableTable
        columns={[
          { key: 'sessionName', label: 'Session Name', sortable: true, sortValue: (r) => r.sessionName ?? '', render: (r) => <span title={r.sessionId}>{r.sessionName ?? '—'}</span> },
          { key: 'totalCost', label: 'Total Cost', render: (r) => formatCost(r.totalCost) },
          { key: 'inputTokens', label: 'Input Tokens', render: (r) => formatTokenCount(r.inputTokens) },
          { key: 'outputTokens', label: 'Output Tokens', render: (r) => formatTokenCount(r.outputTokens) },
          { key: 'cache', label: 'Cache', render: (r) => formatTokenCount(r.cacheReadTokens) },
          { key: 'outcomes', label: 'Outcomes', render: (r) => <span title={`${r.succeeded} succeeded / ${r.failed} failed / ${r.interrupted} interrupted`}>{r.succeeded}/{r.failed}/{r.interrupted}</span> },
          { key: 'firstAttempt', label: 'First Attempt', render: (r) => formatDate(r.firstAttempt) },
          { key: 'lastAttempt', label: 'Last Attempt', render: (r) => formatDate(r.lastAttempt) },
          { key: 'models', label: 'Models', render: (r) => r.modelsUsed.join(', ') || '—' },
          { key: 'subagents', label: 'Subagents', render: (r) => r.subagentCount },
        ]}
        rows={data.sessions}
        rowKey={(r) => r.sessionId}
        onRowClick={onRowClick}
        emptyMessage="No sessions found"
      />
      {data.truncated && (
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
  const netInput = Math.max(0, inputTokens - cacheRead);
  const tokenUsageRow: SessionTokenUsageRow = {
    label: 'Total',
    netInput,
    cacheRead,
    output: outputTokens,
    cacheWrite,
    reasoning: reasoningTokens,
  };

  const costByModelMap = new Map<string, {
    providerId: string; modelId: string; connectionId: string; currency: string; cost: number;
  }>();
  const tokensByModelMap = new Map<string, {
    providerId: string; modelId: string; connectionId: string; input: number; output: number; reasoning: number;
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
      connectionId: a.connectionId,
      input: 0,
      output: 0,
      reasoning: 0,
    };
    entry.input += a.inputTokens ?? 0;
    entry.output += a.outputTokens ?? 0;
    entry.reasoning += a.reasoningTokens ?? 0;
    tokensByModelMap.set(identityKey, entry);
  }
  const costByModel = Array.from(costByModelMap.values()).map((entry) => ({
    ...entry,
    label: `${entry.providerId}/${entry.modelId}/${truncateId(entry.connectionId)} (${entry.currency})`,
  }));
  const tokensByModel = Array.from(tokensByModelMap.values(), (t) => ({
    label: `${t.providerId}/${t.modelId}/${truncateId(t.connectionId)}`,
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
                      { name: 'Input (net)', value: row.netInput },
                      { name: 'Cache Read', value: row.cacheRead },
                      { name: 'Output', value: row.output },
                      { name: 'Cache Write', value: row.cacheWrite },
                      { name: 'Reasoning', value: row.reasoning },
                    ]}
                  />
                );
              }} />
              <Legend />
              <Bar dataKey="netInput" name="Input (net)" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="cacheRead" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="output" name="Output" stackId="a" fill={CHART_PALETTE[1]} />
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
              <Tooltip {...tokenTooltipProps} />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="outputTokens" name="Output" stackId="a" fill={CHART_PALETTE[1]} />
              <Bar dataKey="reasoningTokens" name="Reasoning detail" fill={CHART_PALETTE[2]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Chain Breakdown">
        <SortableTable
          columns={[
            { key: 'chainId', label: 'Chain ID', render: (r) => r.chainId ? <span title={r.chainId}>{truncateId(r.chainId)}</span> : '—' },
            { key: 'agentName', label: 'Agent', render: (r) => r.agentName ?? '—' },
            { key: 'agentTier', label: 'Tier', render: (r) => r.agentTier ?? '—' },
            { key: 'totalCost', label: 'Cost', render: (r) => formatCost(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'attempts', label: 'Attempts', render: (r) => r.attempts },
            { key: 'outcomes', label: 'Outcomes', render: (r) => `${r.succeeded}/${r.failed}/${r.interrupted}` },
          ]}
          rows={data.chains}
          rowKey={(r) => r.chainId ?? `no-chain-${r.agentName ?? 'default'}`}
          emptyMessage="No chains"
        />
      </ChartCard>

      <ChartCard title="Attempt Timeline">
        <SortableTable
          columns={[
            { key: 'attemptId', label: 'Attempt ID', render: (r) => <span title={r.attemptId}>{truncateId(r.attemptId)}</span> },
            { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
            { key: 'modelId', label: 'Model', render: (r) => r.modelId },
            { key: 'providerId', label: 'Provider', render: (r) => r.providerId },
            { key: 'connectionId', label: 'Connection', render: (r) => <span title={r.connectionId}>{truncateId(r.connectionId)}</span> },
            { key: 'outcome', label: 'Outcome', render: (r) => r.outcome },
            { key: 'costState', label: 'Cost State', render: (r) => r.costState },
            { key: 'costAmount', label: 'Cost', render: (r) => formatCostAmount(r.costAmount, r.currency) },
            { key: 'inputTokens', label: 'Input', render: (r) => r.inputTokens !== null ? formatTokenCount(r.inputTokens) : '—' },
            { key: 'outputTokens', label: 'Output', render: (r) => r.outputTokens !== null ? formatTokenCount(r.outputTokens) : '—' },
            { key: 'cacheReadTokens', label: 'Cache Read', render: (r) => r.cacheReadTokens !== null ? formatTokenCount(r.cacheReadTokens) : '—' },
            { key: 'cacheWriteTokens', label: 'Cache Write', render: (r) => r.cacheWriteTokens !== null ? formatTokenCount(r.cacheWriteTokens) : '—' },
            { key: 'reasoningTokens', label: 'Reasoning', render: (r) => r.reasoningTokens !== null ? formatTokenCount(r.reasoningTokens) : '—' },
            { key: 'latencyMs', label: 'Latency', render: (r) => formatDuration(r.latencyMs) },
            { key: 'agent', label: 'Agent', render: (r) => r.agentName ?? r.agentScope ?? '—' },
            { key: 'error', label: 'Error', render: (r) => r.error ?? '—' },
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
            { key: 'toolName', label: 'Tool Name', render: (r) => r.toolName },
            { key: 'toolSource', label: 'Source', render: (r) => r.toolSource },
            { key: 'mcpServerName', label: 'MCP Server', render: (r) => r.mcpServerName ?? '—' },
            { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
            { key: 'durationMs', label: 'Duration', render: (r) => formatDuration(r.durationMs) },
            { key: 'outcome', label: 'Outcome', render: (r) => r.outcome },
            { key: 'resultSizeBytes', label: 'Result Size', render: (r) => formatBytes(r.resultSizeBytes) },
            { key: 'offloaded', label: 'Offloaded', render: (r) => r.offloaded ? 'Yes' : 'No' },
            { key: 'timedOut', label: 'Timed Out', render: (r) => r.timedOut ? 'Yes' : 'No' },
            { key: 'agentScope', label: 'Agent', render: (r) => r.agentScope ?? '—' },
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
            { key: 'subagentId', label: 'Subagent ID', render: (r) => <span title={r.subagentId}>{truncateId(r.subagentId)}</span> },
            { key: 'agentName', label: 'Agent Name', render: (r) => r.agentName },
            { key: 'agentType', label: 'Type', render: (r) => r.agentType },
            { key: 'agentTier', label: 'Tier', render: (r) => r.agentTier },
            { key: 'modelId', label: 'Model', render: (r) => r.modelId },
            { key: 'status', label: 'Status', render: (r) => r.status },
            { key: 'totalCost', label: 'Cost', render: (r) => formatCost(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'attempts', label: 'Attempts', render: (r) => r.attempts },
            { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
            { key: 'completedAt', label: 'Completed', render: (r) => formatDate(r.completedAt) },
          ]}
          rows={data.subagents}
          rowKey={(r) => r.subagentId}
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
