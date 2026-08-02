import { useAnalytics } from '../../hooks/useAnalytics';
import type { AnalyticsTimeRange } from '../../../shared/types/analytics';
import { StatCard, ChartCard, formatTokenCount, formatCost, formatCostAmount, CHART_PALETTE, GRID_STROKE, axisTickProps, tooltipProps, tokenTooltipProps } from './shared';
import { Button } from '../ui/Button';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

export function OverviewTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.overview({ timeRange }),
    [timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading analytics…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const { stats } = data;
  const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
  const errorRate = stats.totalAttempts > 0
    ? (((stats.failedAttempts + stats.interruptedAttempts) / stats.totalAttempts) * 100).toFixed(1) + '%'
    : '—';
  const avgTokensPerSession = stats.totalSessions > 0
    ? formatTokenCount(Math.round(totalTokens / stats.totalSessions))
    : '—';
  const spendCurrencies = [...new Set(data.spendOverTime.map((point) => point.currency))];
  const spendByDate = [...new Set(data.spendOverTime.map((point) => point.date))].sort().map((date) => {
    const row: Record<string, string | number> = { date };
    for (const point of data.spendOverTime) {
      if (point.date === date) row[point.currency] = Number(point.cost);
    }
    return row;
  });
  const spendByModel = data.spendByModel.map((point) => ({ ...point, label: `${point.providerId}/${point.modelId} (${point.currency})` }));
  const spendByProvider = data.spendByProvider.map((point) => ({ ...point, label: `${point.providerId} (${point.currency})` }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Overview</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Spend" value={formatCost(stats.totalCost)} subtext={`${stats.unknownCostCount} unknown`} />
        <StatCard label="Total Tokens" value={formatTokenCount(totalTokens)} subtext={`${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out · ${stats.unknownUsageCount} unknown`} />
        <StatCard label="API Calls" value={stats.totalAttempts} subtext={`${stats.succeededAttempts} succeeded / ${stats.failedAttempts} failed`} />
        <StatCard label="Sessions" value={stats.totalSessions} />
        <StatCard label="Known Cost Records" value={stats.totalCost.reduce((sum, cost) => sum + cost.recordCount, 0)} />
        <StatCard label="Avg Tokens/Session" value={avgTokensPerSession} />
        <StatCard label="Cache Read Tokens" value={formatTokenCount(stats.totalCacheReadTokens)} />
        <StatCard label="Error Rate" value={errorRate} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Spend Over Time" empty={data.spendOverTime.length === 0} emptyMessage="No spend data yet">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={spendByDate}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, currency) => formatCostAmount(String(value), String(currency))} />
              <Legend />
              {spendCurrencies.map((currency, index) => (
                <Line key={currency} type="monotone" dataKey={currency} stroke={CHART_PALETTE[index % CHART_PALETTE.length]} strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Totals & Reported Details (details are not additive)" empty={data.tokenUsageOverTime.length === 0} emptyMessage="No token usage yet">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.tokenUsageOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip {...tokenTooltipProps} />
              <Legend />
              <Bar dataKey="inputTokens" name="Input total" stackId="totals" fill={CHART_PALETTE[0]} />
              <Bar dataKey="outputTokens" name="Output total" stackId="totals" fill={CHART_PALETTE[1]} />
              <Bar dataKey="cacheReadTokens" name="Cache read detail" fill={CHART_PALETTE[2]} />
              <Bar dataKey="cacheWriteTokens" name="Cache write detail" fill={CHART_PALETTE[3]} />
              <Bar dataKey="reasoningTokens" name="Reasoning detail" fill={CHART_PALETTE[4]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Spend by Model" empty={data.spendByModel.length === 0} emptyMessage="No model spend recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={spendByModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={150} />
              <Tooltip {...tooltipProps} formatter={(value, _name, item) => formatCostAmount(String(value), item.payload.currency)} />
              <Bar dataKey="cost" fill={CHART_PALETTE[0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Spend by Provider" empty={data.spendByProvider.length === 0} emptyMessage="No provider spend recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={spendByProvider} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={130} />
              <Tooltip {...tooltipProps} formatter={(value, _name, item) => formatCostAmount(String(value), item.payload.currency)} />
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
