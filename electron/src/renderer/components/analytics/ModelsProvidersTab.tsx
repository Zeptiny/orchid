import type { ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type {
  ModelBreakdown,
  ProviderBreakdown,
  TimeSeriesPoint,
} from '../../../shared/types/analytics';
import { StatCard, ChartCard, SortableTable } from './shared';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const CHART_COLORS = ['#3b82f6', '#10b981', '#ec4899', '#f59e0b', '#8b5cf6', '#ef4444'];

type Column<T> = { key: string; label: string; render: (row: T) => ReactNode };

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function aggregateCostByDate(points: readonly TimeSeriesPoint[]): { date: string; cost: number }[] {
  const map = new Map<string, number>();
  for (const p of points) {
    map.set(p.date, (map.get(p.date) ?? 0) + Number(p.cost));
  }
  return [...map.entries()]
    .map(([date, cost]) => ({ date, cost }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const modelColumns: ReadonlyArray<Column<ModelBreakdown>> = [
  { key: 'model', label: 'Model', render: (m) => m.modelId },
  { key: 'provider', label: 'Provider', render: (m) => m.providerId },
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

const providerColumns: ReadonlyArray<Column<ProviderBreakdown>> = [
  { key: 'provider', label: 'Provider', render: (p) => p.providerId },
  { key: 'displayName', label: 'Display Name', render: (p) => p.providerDisplayName ?? '—' },
  { key: 'cost', label: 'Total Cost', render: (p) => formatCost(p.totalCost) },
  { key: 'input', label: 'Input Tokens', render: (p) => formatTokenCount(p.totalInputTokens) },
  { key: 'output', label: 'Output Tokens', render: (p) => formatTokenCount(p.totalOutputTokens) },
  { key: 'attempts', label: 'Attempts', render: (p) => p.attempts },
  { key: 'models', label: 'Models', render: (p) => p.modelCount },
  { key: 'connections', label: 'Connections', render: (p) => p.connectionCount },
  { key: 'failed', label: 'Failed', render: (p) => p.failed },
  { key: 'interrupted', label: 'Interrupted', render: (p) => p.interrupted },
];

export function ModelsProvidersTab() {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.models(),
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading analytics…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const totalCost = data.models.reduce((sum, m) => sum + Number(m.totalCost), 0);
  const totalInput = data.models.reduce((sum, m) => sum + m.inputTokens, 0);
  const totalOutput = data.models.reduce((sum, m) => sum + m.outputTokens, 0);
  const totalAttempts = data.models.reduce((sum, m) => sum + m.attempts, 0);
  const totalSucceeded = data.models.reduce((sum, m) => sum + m.succeeded, 0);
  const totalFailed = data.models.reduce((sum, m) => sum + m.failed, 0);
  const totalInterrupted = data.models.reduce((sum, m) => sum + m.interrupted, 0);
  const errorRate = totalAttempts > 0
    ? formatPercent((totalFailed + totalInterrupted) / totalAttempts)
    : '—';

  const costOverTime = aggregateCostByDate(data.costPerModelOverTime);
  const tokenPerModel = data.models.map((m) => ({
    modelId: m.modelId,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    reasoningTokens: m.reasoningTokens,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Models &amp; Providers</h2>
        <button onClick={refresh} className="text-sm text-base-content/60 hover:text-base-content">↻ Refresh</button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Models" value={data.models.length} />
        <StatCard label="Providers" value={data.providers.length} />
        <StatCard label="Total Spend" value={formatCost(String(totalCost))} />
        <StatCard label="Total Tokens" value={formatTokenCount(totalInput + totalOutput)} subtext={`${formatTokenCount(totalInput)} in / ${formatTokenCount(totalOutput)} out`} />
        <StatCard label="API Calls" value={totalAttempts} subtext={`${totalSucceeded} succeeded`} />
        <StatCard label="Error Rate" value={errorRate} subtext={`${totalFailed} failed / ${totalInterrupted} interrupted`} />
      </div>

      <ChartCard title="Per-Model Breakdown">
        <SortableTable
          columns={modelColumns}
          rows={data.models}
          rowKey={(m) => `${m.providerId}:${m.modelId}`}
          emptyMessage="No model usage recorded"
        />
      </ChartCard>

      <ChartCard title="Per-Provider Breakdown">
        <SortableTable
          columns={providerColumns}
          rows={data.providers}
          rowKey={(p) => p.providerId}
          emptyMessage="No provider usage recorded"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Cost per Model Over Time">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={costOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(value) => formatCost(String(value))} />
              <Line type="monotone" dataKey="cost" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage per Model">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokenPerModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="modelId" tick={{ fontSize: 11 }} width={120} />
              <Tooltip />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" fill={CHART_COLORS[0]} />
              <Bar dataKey="outputTokens" name="Output" fill={CHART_COLORS[1]} />
              <Bar dataKey="reasoningTokens" name="Reasoning" fill={CHART_COLORS[2]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
