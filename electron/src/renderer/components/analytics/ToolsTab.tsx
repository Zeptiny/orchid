import { useAnalytics } from '../../hooks/useAnalytics';
import type { ToolBreakdown, AnalyticsTimeRange } from '../../../shared/types/analytics';
import { StatCard, ChartCard, SortableTable, type Column, formatDuration, formatBytes, formatPercent, CHART_PALETTE, GRID_STROKE, axisTickProps, tooltipProps } from './shared';
import { Button } from '../ui/Button';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

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

export function ToolsTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.tools({ timeRange }),
    [timeRange],
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

  const topToolsByInvocations = [...data.tools]
    .sort((a, b) => b.invocations - a.invocations)
    .slice(0, 10)
    .map((t) => ({ label: t.toolName, invocations: t.invocations }));

  const topToolsByDuration = data.tools
    .filter((t) => t.avgDurationMs !== null)
    .sort((a, b) => b.invocations - a.invocations)
    .slice(0, 10)
    .map((t) => ({ label: t.toolName, durationMs: t.avgDurationMs ?? 0 }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Tools</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
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
          rowKey={(t) => `${t.toolSource}:${t.mcpServerName ?? ''}:${t.toolFamily}:${t.toolName}`}
          emptyMessage="No tool invocations recorded"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Tool Invocations Over Time" empty={invocationsData.length === 0} emptyMessage="No invocation data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={invocationsData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} />
              <Legend />
              {toolNames.map((tn, i) => (
                <Bar
                  key={tn}
                  dataKey={tn}
                  stackId="a"
                  fill={CHART_PALETTE[i % CHART_PALETTE.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Top Tools by Invocations" empty={topToolsByInvocations.length === 0} emptyMessage="No tool invocations recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={topToolsByInvocations} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={170} />
              <Tooltip {...tooltipProps} />
              <Legend />
              <Bar dataKey="invocations" name="Invocations" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Tool Duration (Top 10)" empty={topToolsByDuration.length === 0} emptyMessage="No duration data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={topToolsByDuration} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} tickFormatter={(value) => formatDuration(Number(value))} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={170} />
              <Tooltip {...tooltipProps} formatter={(value) => formatDuration(Number(value))} />
              <Legend />
              <Bar dataKey="durationMs" name="Avg Duration" fill={CHART_PALETTE[0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Outcome Distribution" empty={data.outcomeDistribution.length === 0} emptyMessage="No tool outcomes recorded">
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
                  <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...tooltipProps} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
