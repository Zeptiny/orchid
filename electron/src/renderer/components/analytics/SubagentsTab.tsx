import { useState, type ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type {
  AnalyticsTimeRange,
  SubagentSummary,
  SubagentInvocation,
  SubagentModelUsage,
} from '../../../shared/types/analytics';
import { SUBAGENT_DETAIL_MAX_INVOCATIONS } from '../../../shared/types/analytics';
import {
  StatCard, ChartCard, SortableTable, formatTokenCount, formatCost, formatCostAmount, formatDuration,
  formatTtft, formatTps, formatDate, truncateId,
  CHART_PALETTE, GRID_STROKE, axisTickProps, tooltipProps, tokenTooltipProps,
} from './shared';
import { Button } from '../ui/Button';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const EXPLORER_PAGE_SIZE = 10;

function SubagentOverview({ timeRange, onRowClick }: { timeRange: AnalyticsTimeRange; onRowClick: (row: SubagentSummary) => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.subagents({ timeRange }),
    [timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const totalInvocations = data.summaries.reduce((sum, s) => sum + s.invocations, 0);
  const totalInputTokens = data.summaries.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutputTokens = data.summaries.reduce((sum, s) => sum + s.outputTokens, 0);

  const tokenUsageData = data.summaries.map((s) => ({
    agentName: s.agentName,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
  }));

  const costByNameData = data.costByAgentName.map((c) => ({
    agentName: `${c.agentName} (${c.currency})`,
    cost: Number(c.cost),
    currency: c.currency,
  }));

  const costByTierData = data.costByAgentTier.map((c) => ({
    tier: `${c.tier} (${c.currency})`,
    cost: Number(c.cost),
    currency: c.currency,
  }));

  const columns: ReadonlyArray<{
    key: string;
    label: string;
    sortable?: boolean;
    initialDir?: 'asc' | 'desc';
    sortValue?: (row: SubagentSummary) => string | number;
    render: (row: SubagentSummary) => ReactNode;
  }> = [
    { key: 'agentName', label: 'Agent Name', sortable: true, initialDir: 'asc', sortValue: (s) => s.agentName, render: (s) => s.agentName },
    { key: 'agentType', label: 'Type', sortable: true, initialDir: 'asc', sortValue: (s) => s.agentType, render: (s) => s.agentType },
    { key: 'agentTier', label: 'Tier', sortable: true, initialDir: 'asc', sortValue: (s) => s.agentTier, render: (s) => s.agentTier },
    { key: 'modelsUsed', label: 'Models Used', sortable: true, initialDir: 'asc', sortValue: (s) => s.modelsUsed.join(','), render: (s) => s.modelsUsed.join(', ') || '—' },
    { key: 'invocations', label: 'Invocations', sortable: true, initialDir: 'desc', sortValue: (s) => s.invocations, render: (s) => s.invocations },
    { key: 'totalCost', label: 'Total Cost', sortable: true, initialDir: 'desc', sortValue: (s) => Math.max(...s.totalCost.map((c) => Number(c.amount)), 0), render: (s) => formatCost(s.totalCost) },
    { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (s) => s.inputTokens, render: (s) => formatTokenCount(s.inputTokens) },
    { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (s) => s.outputTokens, render: (s) => formatTokenCount(s.outputTokens) },
    { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (s) => s.attempts, render: (s) => s.attempts },
    { key: 'completed', label: 'Completed', sortable: true, initialDir: 'desc', sortValue: (s) => s.completed, render: (s) => s.completed },
    { key: 'failed', label: 'Failed', sortable: true, initialDir: 'desc', sortValue: (s) => s.failed, render: (s) => s.failed },
    { key: 'interrupted', label: 'Interrupted', sortable: true, initialDir: 'desc', sortValue: (s) => s.interrupted, render: (s) => s.interrupted },
    { key: 'avgDuration', label: 'Avg Duration', sortable: true, initialDir: 'desc', sortValue: (s) => s.avgDurationMs ?? -1, render: (s) => formatDuration(s.avgDurationMs) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Subagents</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Invocations" value={totalInvocations} />
        <StatCard label="Unique Agents" value={data.summaries.length} />
        <StatCard label="Total Input Tokens" value={formatTokenCount(totalInputTokens)} />
        <StatCard label="Total Output Tokens" value={formatTokenCount(totalOutputTokens)} />
      </div>

      <ChartCard title="Per-Agent Summary">
        <SortableTable
          columns={columns}
          rows={data.summaries}
          rowKey={(s) => `${s.agentName}:${s.agentType}:${s.agentTier}`}
          onRowClick={onRowClick}
          emptyMessage="No subagent data"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Subagent Invocations Over Time" empty={data.invocationsOverTime.length === 0} emptyMessage="No invocation data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.invocationsOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} allowDecimals={false} />
              <Tooltip {...tooltipProps} />
              <Line type="monotone" dataKey="count" stroke={CHART_PALETTE[0]} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost per Agent Name" empty={costByNameData.length === 0} emptyMessage="No subagent cost recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costByNameData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="agentName" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, _name, item) => formatCostAmount(String(value), item.payload.currency)} />
              <Bar dataKey="cost" fill={CHART_PALETTE[0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage per Agent Name" empty={tokenUsageData.length === 0} emptyMessage="No token usage recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokenUsageData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="agentName" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip {...tokenTooltipProps} />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" fill={CHART_PALETTE[0]} />
              <Bar dataKey="outputTokens" name="Output" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Subagent Outcome Distribution" empty={data.outcomeDistribution.length === 0} emptyMessage="No subagent outcomes recorded">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.outcomeDistribution} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={80} label>
                {data.outcomeDistribution.map((_, i) => (
                  <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...tooltipProps} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost by Agent Tier" empty={costByTierData.length === 0} emptyMessage="No cost by tier recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costByTierData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="tier" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, _name, item) => formatCostAmount(String(value), item.payload.currency)} />
              <Bar dataKey="cost" fill={CHART_PALETTE[3]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

function SubagentExplorer({ row, timeRange, onBack }: { row: SubagentSummary; timeRange: AnalyticsTimeRange; onBack: () => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.subagentDetail({
      agentName: row.agentName,
      agentType: row.agentType,
      agentTier: row.agentTier,
      timeRange,
    }),
    [row.agentName, row.agentType, row.agentTier, timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading subagent detail…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const { summary } = data;

  const invocationColumns: ReadonlyArray<{
    key: string;
    label: string;
    sortable?: boolean;
    initialDir?: 'asc' | 'desc';
    sortValue?: (row: SubagentInvocation) => string | number;
    render: (row: SubagentInvocation) => ReactNode;
  }> = [
    { key: 'subagentId', label: 'Subagent ID', sortable: true, initialDir: 'asc', sortValue: (r) => r.subagentId, render: (r) => <span title={r.subagentId}>{truncateId(r.subagentId)}</span> },
    { key: 'session', label: 'Session', sortable: true, initialDir: 'asc', sortValue: (r) => r.sessionName ?? r.sessionId, render: (r) => <span title={r.sessionId}>{r.sessionName ?? truncateId(r.sessionId)}</span> },
    { key: 'modelId', label: 'Model', sortable: true, initialDir: 'asc', sortValue: (r) => r.modelId, render: (r) => r.modelId },
    { key: 'status', label: 'Status', sortable: true, initialDir: 'asc', sortValue: (r) => r.status, render: (r) => r.status },
    { key: 'startedAt', label: 'Started', sortable: true, initialDir: 'desc', sortValue: (r) => r.startedAt, render: (r) => formatDate(r.startedAt) },
    { key: 'durationMs', label: 'Duration', sortable: true, initialDir: 'desc', sortValue: (r) => r.durationMs ?? -1, render: (r) => formatDuration(r.durationMs) },
    { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (r) => r.attempts, render: (r) => r.attempts },
    { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens, render: (r) => formatTokenCount(r.inputTokens) },
    { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens, render: (r) => formatTokenCount(r.outputTokens) },
    { key: 'totalCost', label: 'Cost', sortable: true, initialDir: 'desc', sortValue: (r) => Math.max(...r.totalCost.map((c) => Number(c.amount)), 0), render: (r) => formatCost(r.totalCost) },
  ];

  const modelColumns: ReadonlyArray<{
    key: string;
    label: string;
    sortable?: boolean;
    initialDir?: 'asc' | 'desc';
    sortValue?: (row: SubagentModelUsage) => string | number;
    render: (row: SubagentModelUsage) => ReactNode;
  }> = [
    { key: 'modelId', label: 'Model', sortable: true, initialDir: 'asc', sortValue: (m) => m.modelId, render: (m) => m.modelId },
    { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (m) => m.attempts, render: (m) => m.attempts },
    { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (m) => m.inputTokens, render: (m) => formatTokenCount(m.inputTokens) },
    { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (m) => m.outputTokens, render: (m) => formatTokenCount(m.outputTokens) },
    { key: 'totalCost', label: 'Cost', sortable: true, initialDir: 'desc', sortValue: (m) => Math.max(...m.totalCost.map((c) => Number(c.amount)), 0), render: (m) => formatCost(m.totalCost) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-base-content/60 hover:text-base-content">← Back to Subagents</button>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <h2 className="text-lg font-semibold text-base-content">
        {data.agentName}
        <span className="ml-2 text-sm font-normal text-base-content/40">{data.agentType} · {data.agentTier}</span>
      </h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Invocations" value={summary.invocations} />
        <StatCard label="Outcomes" value={`${summary.completed}/${summary.failed}/${summary.interrupted}`} subtext="completed / failed / interrupted" />
        <StatCard label="Attempts" value={summary.attempts} />
        <StatCard label="Total Cost" value={formatCost(summary.totalCost)} />
        <StatCard label="Total Tokens" value={formatTokenCount(summary.inputTokens + summary.outputTokens)} subtext={`${formatTokenCount(summary.inputTokens)} in / ${formatTokenCount(summary.outputTokens)} out`} />
        <StatCard label="Avg Duration" value={formatDuration(summary.avgDurationMs)} />
        <StatCard label="Avg TTFT" value={formatTtft(summary.avgTtftMs)} />
        <StatCard label="p95 TTFT" value={formatTtft(summary.p95TtftMs)} />
        <StatCard label="Avg Speed" value={formatTps(summary.avgTokensPerSecond)} />
      </div>

      <ChartCard title="Invocations">
        <SortableTable
          columns={invocationColumns}
          rows={data.invocations}
          rowKey={(r) => `${r.subagentId}:${r.chainId}:${r.startedAt}`}
          emptyMessage="No invocations"
          pageSize={EXPLORER_PAGE_SIZE}
        />
        {data.truncated && (
          <div className="mt-2 text-xs text-base-content/50">showing first {SUBAGENT_DETAIL_MAX_INVOCATIONS} invocations</div>
        )}
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Invocations Over Time" empty={data.invocationsOverTime.length === 0} emptyMessage="No invocation data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.invocationsOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} allowDecimals={false} />
              <Tooltip {...tooltipProps} />
              <Line type="monotone" dataKey="count" stroke={CHART_PALETTE[0]} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Models Used">
          <SortableTable
            columns={modelColumns}
            rows={data.modelsUsed}
            rowKey={(m) => m.modelId}
            emptyMessage="No models used"
          />
        </ChartCard>
      </div>
    </div>
  );
}

export function SubagentsTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const [selected, setSelected] = useState<SubagentSummary | null>(null);

  if (selected !== null) {
    return <SubagentExplorer row={selected} timeRange={timeRange} onBack={() => setSelected(null)} />;
  }
  return <SubagentOverview timeRange={timeRange} onRowClick={setSelected} />;
}
