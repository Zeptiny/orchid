import { useAnalytics } from '../../hooks/useAnalytics';
import type { OverviewResult } from '../../../shared/types/analytics';
import { StatCard, ChartCard } from './shared';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const PIE_COLORS = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(currencies: ReadonlyArray<{ currency: string; amount: string }>): string {
  if (currencies.length === 0) return '$0.00';
  return currencies.map((c) => `$${Number(c.amount).toFixed(4)} ${c.currency}`).join(', ');
}

export function OverviewTab() {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.overview(),
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading analytics…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const { stats } = data;
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const cacheHitRate = stats.totalInputTokens > 0
    ? ((stats.totalCacheReadTokens / stats.totalInputTokens) * 100).toFixed(1) + '%'
    : '—';
  const errorRate = stats.totalAttempts > 0
    ? (((stats.failedAttempts + stats.interruptedAttempts) / stats.totalAttempts) * 100).toFixed(1) + '%'
    : '—';
  const avgCostPerSession = stats.totalSessions > 0
    ? formatCost(stats.totalCost.map((c) => ({ currency: c.currency, amount: (Number(c.amount) / stats.totalSessions).toString() })))
    : '—';
  const avgTokensPerSession = stats.totalSessions > 0
    ? formatTokenCount(Math.round(totalTokens / stats.totalSessions))
    : '—';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Overview</h2>
        <button onClick={refresh} className="text-sm text-base-content/60 hover:text-base-content">↻ Refresh</button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Spend" value={formatCost(stats.totalCost)} subtext={`${stats.unknownCostCount} unknown`} />
        <StatCard label="Total Tokens" value={formatTokenCount(totalTokens)} subtext={`${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out`} />
        <StatCard label="API Calls" value={stats.totalAttempts} subtext={`${stats.succeededAttempts} succeeded / ${stats.failedAttempts} failed`} />
        <StatCard label="Sessions" value={stats.totalSessions} />
        <StatCard label="Avg Cost/Session" value={avgCostPerSession} />
        <StatCard label="Avg Tokens/Session" value={avgTokensPerSession} />
        <StatCard label="Cache Hit Rate" value={cacheHitRate} subtext={`${formatTokenCount(stats.totalCacheReadTokens)} cached`} />
        <StatCard label="Error Rate" value={errorRate} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Spend Over Time">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.spendOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="cost" stroke="#3b82f6" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage Over Time">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.tokenUsageOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" stackId="a" fill="#3b82f6" />
              <Bar dataKey="outputTokens" name="Output" stackId="a" fill="#10b981" />
              <Bar dataKey="cacheReadTokens" name="Cache Read" stackId="a" fill="#f59e0b" />
              <Bar dataKey="cacheWriteTokens" name="Cache Write" stackId="a" fill="#8b5cf6" />
              <Bar dataKey="reasoningTokens" name="Reasoning" stackId="a" fill="#ec4899" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Spend by Model">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.spendByModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="modelId" tick={{ fontSize: 11 }} width={120} />
              <Tooltip />
              <Bar dataKey="cost" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Spend by Provider">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.spendByProvider} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="providerId" tick={{ fontSize: 11 }} width={100} />
              <Tooltip />
              <Bar dataKey="cost" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Outcome Distribution">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.outcomeDistribution} dataKey="count" nameKey="outcome" cx="50%" cy="50%" outerRadius={80} label>
                {data.outcomeDistribution.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Agent Tier Distribution">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.agentTierDistribution}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="tier" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost Source Distribution">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.costSourceDistribution} dataKey="count" nameKey="source" cx="50%" cy="50%" outerRadius={80} label>
                {data.costSourceDistribution.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
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
