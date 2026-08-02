import { useAnalytics } from '../../hooks/useAnalytics';
import { StatCard, ChartCard, formatTokenCount, formatCost, CHART_PALETTE, GRID_STROKE, axisTickProps, tooltipProps, tokenTooltipProps, costTooltipProps } from './shared';
import { Button } from '../ui/Button';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

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
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
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
        <ChartCard title="Spend Over Time" empty={data.spendOverTime.length === 0} emptyMessage="No spend data yet">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.spendOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...costTooltipProps} />
              <Line type="monotone" dataKey="cost" stroke={CHART_PALETTE[0]} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage Over Time" empty={data.tokenUsageOverTime.length === 0} emptyMessage="No token usage yet">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.tokenUsageOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip {...tokenTooltipProps} />
              <Legend />
              <Bar dataKey="inputTokens" name="Input" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="outputTokens" name="Output" stackId="a" fill={CHART_PALETTE[1]} />
              <Bar dataKey="cacheReadTokens" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="cacheWriteTokens" name="Cache Write" stackId="a" fill={CHART_PALETTE[3]} />
              <Bar dataKey="reasoningTokens" name="Reasoning" stackId="a" fill={CHART_PALETTE[4]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Spend by Model" empty={data.spendByModel.length === 0} emptyMessage="No model spend recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.spendByModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} />
              <YAxis type="category" dataKey="modelId" tick={axisTickProps} width={120} />
              <Tooltip {...costTooltipProps} />
              <Bar dataKey="cost" fill={CHART_PALETTE[0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Spend by Provider" empty={data.spendByProvider.length === 0} emptyMessage="No provider spend recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.spendByProvider} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} />
              <YAxis type="category" dataKey="providerId" tick={axisTickProps} width={100} />
              <Tooltip {...costTooltipProps} />
              <Bar dataKey="cost" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Outcome Distribution" empty={data.outcomeDistribution.length === 0} emptyMessage="No attempts recorded">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.outcomeDistribution} dataKey="count" nameKey="outcome" cx="50%" cy="50%" outerRadius={80} label>
                {data.outcomeDistribution.map((_, i) => (
                  <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...tooltipProps} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Agent Tier Distribution" empty={data.agentTierDistribution.length === 0} emptyMessage="No agent tier data">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.agentTierDistribution}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="tier" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} />
              <Bar dataKey="count" fill={CHART_PALETTE[3]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost Source Distribution" empty={data.costSourceDistribution.length === 0} emptyMessage="No cost source data">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={data.costSourceDistribution} dataKey="count" nameKey="source" cx="50%" cy="50%" outerRadius={80} label>
                {data.costSourceDistribution.map((_, i) => (
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
