import type { ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type { SubagentSummary, AnalyticsTimeRange } from '../../../shared/types/analytics';
import { StatCard, ChartCard, SortableTable, formatTokenCount, formatCost, formatCostAmount, formatDuration, CHART_PALETTE, GRID_STROKE, axisTickProps, tooltipProps, tokenTooltipProps } from './shared';
import { Button } from '../ui/Button';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

export function SubagentsTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
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
    sortValue?: (row: SubagentSummary) => string | number;
    render: (row: SubagentSummary) => ReactNode;
  }> = [
    { key: 'agentName', label: 'Agent Name', sortable: true, sortValue: (s) => s.agentName, render: (s) => s.agentName },
    { key: 'agentType', label: 'Type', sortable: true, sortValue: (s) => s.agentType, render: (s) => s.agentType },
    { key: 'agentTier', label: 'Tier', sortable: true, sortValue: (s) => s.agentTier, render: (s) => s.agentTier },
    { key: 'modelsUsed', label: 'Models Used', render: (s) => s.modelsUsed.join(', ') || '—' },
    { key: 'invocations', label: 'Invocations', sortable: true, sortValue: (s) => s.invocations, render: (s) => s.invocations },
    { key: 'totalCost', label: 'Total Cost', sortable: true, sortValue: (s) => Math.max(...s.totalCost.map((c) => Number(c.amount)), 0), render: (s) => formatCost(s.totalCost) },
    { key: 'inputTokens', label: 'Input Tokens', sortable: true, sortValue: (s) => s.inputTokens, render: (s) => formatTokenCount(s.inputTokens) },
    { key: 'outputTokens', label: 'Output Tokens', sortable: true, sortValue: (s) => s.outputTokens, render: (s) => formatTokenCount(s.outputTokens) },
    { key: 'attempts', label: 'Attempts', sortable: true, sortValue: (s) => s.attempts, render: (s) => s.attempts },
    { key: 'completed', label: 'Completed', sortable: true, sortValue: (s) => s.completed, render: (s) => s.completed },
    { key: 'failed', label: 'Failed', sortable: true, sortValue: (s) => s.failed, render: (s) => s.failed },
    { key: 'interrupted', label: 'Interrupted', sortable: true, sortValue: (s) => s.interrupted, render: (s) => s.interrupted },
    { key: 'avgDuration', label: 'Avg Duration', sortable: true, sortValue: (s) => s.avgDurationMs ?? -1, render: (s) => formatDuration(s.avgDurationMs) },
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
