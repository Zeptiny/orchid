import type { ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type { SubagentSummary } from '../../../shared/types/analytics';
import { StatCard, ChartCard, SortableTable, formatTokenCount, formatCostAmount, formatDuration } from './shared';
import { Button } from '../ui/Button';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const PIE_COLORS = ['#10b981', '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899'];

export function SubagentsTab() {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.subagents(),
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
    agentName: c.agentName,
    cost: Number(c.cost),
  }));

  const costByTierData = data.costByAgentTier.map((c) => ({
    tier: c.tier,
    cost: Number(c.cost),
  }));

  const columns: ReadonlyArray<{
    key: string;
    label: string;
    sortable?: boolean;
    render: (row: SubagentSummary) => ReactNode;
  }> = [
    { key: 'agentName', label: 'Agent Name', sortable: true, render: (s) => s.agentName },
    { key: 'agentType', label: 'Type', sortable: true, render: (s) => s.agentType },
    { key: 'agentTier', label: 'Tier', sortable: true, render: (s) => s.agentTier },
    { key: 'modelsUsed', label: 'Models Used', render: (s) => s.modelsUsed.join(', ') || '—' },
    { key: 'invocations', label: 'Invocations', sortable: true, render: (s) => s.invocations },
    { key: 'totalCost', label: 'Total Cost', sortable: true, render: (s) => formatCostAmount(s.totalCost, null) },
    { key: 'inputTokens', label: 'Input Tokens', sortable: true, render: (s) => formatTokenCount(s.inputTokens) },
    { key: 'outputTokens', label: 'Output Tokens', sortable: true, render: (s) => formatTokenCount(s.outputTokens) },
    { key: 'attempts', label: 'Attempts', sortable: true, render: (s) => s.attempts },
    { key: 'completed', label: 'Completed', sortable: true, render: (s) => s.completed },
    { key: 'failed', label: 'Failed', sortable: true, render: (s) => s.failed },
    { key: 'interrupted', label: 'Interrupted', sortable: true, render: (s) => s.interrupted },
    { key: 'avgDuration', label: 'Avg Duration', sortable: true, render: (s) => formatDuration(s.avgDurationMs) },
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
          rowKey={(s) => s.agentName}
          emptyMessage="No subagent data"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Cost per Agent Name">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costByNameData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="agentName" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="cost" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage per Agent Name">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokenUsageData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="agentName" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" fill="#3b82f6" />
              <Bar dataKey="outputTokens" name="Output" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Subagent Outcome Distribution">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.outcomeDistribution} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={80} label>
                {data.outcomeDistribution.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost by Agent Tier">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costByTierData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="tier" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="cost" fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
