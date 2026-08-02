import type { ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type {
  ModelBreakdown,
  ConnectionBreakdown,
  ModelCostTimeSeriesPoint,
  AnalyticsTimeRange,
} from '../../../shared/types/analytics';
import {
  StatCard,
  ChartCard,
  SortableTable,
  formatTokenCount,
  formatCost,
  formatCostAmount,
  formatPercent,
  formatDate,
  CHART_PALETTE,
  GRID_STROKE,
  axisTickProps,
  tokenTooltipProps,
  tooltipProps,
} from './shared';
import { Button } from '../ui/Button';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

type Column<T> = { key: string; label: string; render: (row: T) => ReactNode };

function pivotCostByDate(points: readonly ModelCostTimeSeriesPoint[]): {
  rows: Record<string, string | number>[];
  series: { key: string; currency: string }[];
} {
  const byDate = new Map<string, Record<string, string | number>>();
  const series = new Map<string, string>();
  for (const p of points) {
    const key = `${p.providerId}/${p.modelId} · ${p.connectionId.slice(0, 8)} (${p.currency})`;
    const row = byDate.get(p.date) ?? { date: p.date };
    row[key] = Number(p.cost);
    byDate.set(p.date, row);
    series.set(key, p.currency);
  }
  return {
    rows: [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    series: [...series].map(([key, currency]) => ({ key, currency })),
  };
}

const modelColumns: ReadonlyArray<Column<ModelBreakdown>> = [
  { key: 'model', label: 'Model', render: (m) => m.modelId },
  { key: 'connection', label: 'Connection', render: (m) => m.connectionName ?? '—' },
  { key: 'cost', label: 'Total Cost', render: (m) => formatCost(m.totalCost) },
  { key: 'input', label: 'Input Tokens', render: (m) => formatTokenCount(m.inputTokens) },
  { key: 'output', label: 'Output Tokens', render: (m) => formatTokenCount(m.outputTokens) },
  { key: 'cacheRead', label: 'Cache Read', render: (m) => formatTokenCount(m.cacheReadTokens) },
  { key: 'cacheWrite', label: 'Cache Write', render: (m) => formatTokenCount(m.cacheWriteTokens) },
  { key: 'reasoning', label: 'Reasoning', render: (m) => formatTokenCount(m.reasoningTokens) },
  { key: 'attempts', label: 'Attempts', render: (m) => m.attempts },
  { key: 'succeeded', label: 'Succeeded', render: (m) => m.succeeded },
  { key: 'failed', label: 'Failed', render: (m) => m.failed },
  { key: 'interrupted', label: 'Interrupted', render: (m) => m.interrupted },
  { key: 'firstUsed', label: 'First Used', render: (m) => formatDate(m.firstUsed) },
  { key: 'lastUsed', label: 'Last Used', render: (m) => formatDate(m.lastUsed) },
];

const connectionColumns: ReadonlyArray<Column<ConnectionBreakdown>> = [
  { key: 'connectionName', label: 'Connection', render: (c) => c.connectionName ?? '—' },
  { key: 'cost', label: 'Total Cost', render: (c) => formatCost(c.totalCost) },
  { key: 'input', label: 'Input Tokens', render: (c) => formatTokenCount(c.totalInputTokens) },
  { key: 'output', label: 'Output Tokens', render: (c) => formatTokenCount(c.totalOutputTokens) },
  { key: 'attempts', label: 'Attempts', render: (c) => c.attempts },
  { key: 'succeeded', label: 'Succeeded', render: (c) => c.succeeded },
  { key: 'failed', label: 'Failed', render: (c) => c.failed },
  { key: 'interrupted', label: 'Interrupted', render: (c) => c.interrupted },
  { key: 'models', label: 'Models', render: (c) => c.modelCount },
  { key: 'firstUsed', label: 'First Used', render: (c) => formatDate(c.firstUsed) },
  { key: 'lastUsed', label: 'Last Used', render: (c) => formatDate(c.lastUsed) },
];

export function ModelsProvidersTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.models({ timeRange }),
    [timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading analytics…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const totalInput = data.models.reduce((sum, m) => sum + m.inputTokens, 0);
  const totalOutput = data.models.reduce((sum, m) => sum + m.outputTokens, 0);
  const totalAttempts = data.models.reduce((sum, m) => sum + m.attempts, 0);
  const totalSucceeded = data.models.reduce((sum, m) => sum + m.succeeded, 0);
  const totalFailed = data.models.reduce((sum, m) => sum + m.failed, 0);
  const totalInterrupted = data.models.reduce((sum, m) => sum + m.interrupted, 0);
  const errorRate = totalAttempts > 0
    ? formatPercent((totalFailed + totalInterrupted) / totalAttempts)
    : '—';

  const costOverTime = pivotCostByDate(data.costPerModelOverTime);
  const tokenPerModel = data.models.map((m) => ({
    label: `${m.providerId}/${m.modelId} · ${m.connectionId.slice(0, 8)}`,
    modelId: m.modelId,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    reasoningTokens: m.reasoningTokens,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Models &amp; Providers</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Models" value={data.models.length} />
        <StatCard label="Connections" value={data.connections.length} />
        <StatCard label="Total Spend" value={formatCost(data.totalCost)} />
        <StatCard label="Total Tokens" value={formatTokenCount(totalInput + totalOutput)} subtext={`${formatTokenCount(totalInput)} in / ${formatTokenCount(totalOutput)} out`} />
        <StatCard label="API Calls" value={totalAttempts} subtext={`${totalSucceeded} succeeded`} />
        <StatCard label="Error Rate" value={errorRate} subtext={`${totalFailed} failed / ${totalInterrupted} interrupted`} />
      </div>

      <ChartCard title="Per-Model Breakdown">
        <SortableTable
          columns={modelColumns}
          rows={data.models}
          rowKey={(m) => `${m.connectionId}:${m.providerId}:${m.modelId}`}
          emptyMessage="No model usage recorded"
        />
      </ChartCard>

      <ChartCard title="Per-Connection Breakdown">
        <SortableTable
          columns={connectionColumns}
          rows={data.connections}
          rowKey={(c) => c.connectionId}
          emptyMessage="No connection usage recorded"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Cost per Model Over Time" empty={costOverTime.rows.length === 0} emptyMessage="No cost data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={costOverTime.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, name) => {
                const currency = costOverTime.series.find((item) => item.key === name)?.currency ?? null;
                return formatCostAmount(String(value), currency);
              }} />
              <Legend />
              {costOverTime.series.map((item, index) => (
                <Line key={item.key} type="monotone" dataKey={item.key} stroke={CHART_PALETTE[index % CHART_PALETTE.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage per Model" empty={tokenPerModel.length === 0} emptyMessage="No token usage recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokenPerModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={170} />
              <Tooltip {...tokenTooltipProps} />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" fill={CHART_PALETTE[0]} />
              <Bar dataKey="outputTokens" name="Output" fill={CHART_PALETTE[1]} />
              <Bar dataKey="reasoningTokens" name="Reasoning detail" fill={CHART_PALETTE[2]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
