import type { ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type { ToolBreakdown } from '../../../shared/types/analytics';
import { StatCard, ChartCard, SortableTable } from './shared';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444', '#06b6d4', '#84cc16'];

type Column<T> = { key: string; label: string; render: (row: T) => ReactNode };

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pivotInvocations(rows: readonly { date: string; toolName: string; count: number }[]) {
  const toolNames = [...new Set(rows.map((r) => r.toolName))];
  const byDate = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const entry = byDate.get(r.date) ?? { date: r.date };
    entry[r.toolName] = r.count;
    byDate.set(r.date, entry);
  }
  const data: Record<string, number | string>[] = [];
  for (const [date, entry] of byDate) {
    const filled: Record<string, number | string> = { date };
    for (const tn of toolNames) filled[tn] = entry[tn] ?? 0;
    data.push(filled);
  }
  data.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { data, toolNames };
}

const toolColumns: ReadonlyArray<Column<ToolBreakdown>> = [
  { key: 'toolName', label: 'Tool Name', render: (t) => t.toolName },
  { key: 'source', label: 'Source', render: (t) => t.toolSource },
  { key: 'mcpServer', label: 'MCP Server', render: (t) => t.mcpServerName ?? '—' },
  { key: 'family', label: 'Family', render: (t) => t.toolFamily },
  { key: 'invocations', label: 'Invocations', render: (t) => t.invocations },
  { key: 'complete', label: 'Complete', render: (t) => t.complete },
  { key: 'error', label: 'Error', render: (t) => t.error },
  { key: 'cancelled', label: 'Cancelled', render: (t) => t.cancelled },
  { key: 'timedOut', label: 'Timed Out', render: (t) => t.timedOut },
  {
    key: 'successRate',
    label: 'Success Rate',
    render: (t) => (t.invocations > 0 ? formatPercent(t.complete / t.invocations) : '—'),
  },
  { key: 'avgDuration', label: 'Avg Duration', render: (t) => formatDuration(t.avgDurationMs) },
  { key: 'avgResultSize', label: 'Avg Result Size', render: (t) => formatBytes(t.avgResultSizeBytes) },
  { key: 'offloadRate', label: 'Offload Rate', render: (t) => formatPercent(t.offloadRate) },
];

export function ToolsTab() {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.tools(),
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading analytics…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const totalInvocations = data.tools.reduce((sum, t) => sum + t.invocations, 0);
  const totalComplete = data.tools.reduce((sum, t) => sum + t.complete, 0);
  const totalError = data.tools.reduce((sum, t) => sum + t.error, 0);
  const overallSuccessRate = totalInvocations > 0
    ? formatPercent(totalComplete / totalInvocations)
    : '—';
  const totalOffloaded = data.tools.reduce(
    (sum, t) => sum + (t.invocations > 0 ? t.offloadRate * t.invocations : 0),
    0,
  );
  const overallOffloadRate = totalInvocations > 0
    ? formatPercent(totalOffloaded / totalInvocations)
    : '—';

  const { data: invocationsData, toolNames } = pivotInvocations(data.invocationsOverTime);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Tools</h2>
        <button onClick={refresh} className="text-sm text-base-content/60 hover:text-base-content">↻ Refresh</button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Tools" value={data.tools.length} />
        <StatCard label="Total Invocations" value={totalInvocations} subtext={`${totalComplete} complete`} />
        <StatCard label="Success Rate" value={overallSuccessRate} subtext={`${totalError} errors`} />
        <StatCard label="Offload Rate" value={overallOffloadRate} />
      </div>

      <ChartCard title="Tool Usage Summary">
        <SortableTable
          columns={toolColumns}
          rows={data.tools}
          rowKey={(t) => t.toolName}
          emptyMessage="No tool invocations recorded"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Tool Invocations Over Time">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={invocationsData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              {toolNames.map((tn, i) => (
                <Bar
                  key={tn}
                  dataKey={tn}
                  stackId="a"
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Outcome Distribution">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={[...data.outcomeDistribution]}
                dataKey="count"
                nameKey="outcome"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label
              >
                {data.outcomeDistribution.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
