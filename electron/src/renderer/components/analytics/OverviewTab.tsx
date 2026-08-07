import { useState } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type { AnalyticsTimeRange, TimeSeriesPoint } from '../../../shared/types/analytics';
import { StatCard, ChartCard, formatTokenCount, formatCost, formatCostAmount, formatPercent, CHART_PALETTE, GRID_STROKE, axisTickProps, tooltipProps, TokenUsageTooltip } from './shared';
import { Button } from '../ui/Button';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

type SpendGranularity = 'day' | 'week' | 'month';

const SPEND_GRANULARITIES: ReadonlyArray<{ id: SpendGranularity; label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

const SPEND_TOP_N = 10;

function bucketSpendDate(date: string, granularity: SpendGranularity): string {
  if (granularity === 'month') return date.slice(0, 7);
  if (granularity === 'week') {
    const monday = new Date(`${date}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  return date;
}

function collapseSpendTopN<T extends { cost: string; currency: string }, R>(
  rows: readonly T[],
  labelRow: (row: T) => R,
  makeOther: (currency: string, cost: string, mixedCurrencies: boolean) => R,
): R[] {
  const sorted = [...rows].sort((a, b) => Number(b.cost) - Number(a.cost));
  const top = sorted.slice(0, SPEND_TOP_N).map(labelRow);
  const rest = sorted.slice(SPEND_TOP_N);
  if (rest.length === 0) return top;
  const sums = new Map<string, number>();
  for (const row of rest) {
    sums.set(row.currency, (sums.get(row.currency) ?? 0) + Number(row.cost));
  }
  const mixedCurrencies = sums.size > 1;
  const others = [...sums.entries()].map(([currency, sum]) => makeOther(currency, String(sum), mixedCurrencies));
  return [...top, ...others];
}

type TokenUsagePoint = TimeSeriesPoint & { netInput: number; cacheRead: number; output: number };

export function OverviewTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.overview({ timeRange }),
    [timeRange],
  );
  const [spendGranularity, setSpendGranularity] = useState<SpendGranularity>('day');

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
  const paidCostRecords = stats.totalCost.reduce((sum, cost) => sum + cost.recordCount, 0);
  const cacheHitRate = stats.totalInputTokens > 0
    ? formatPercent(stats.totalCacheReadTokens / stats.totalInputTokens)
    : '—';
  const spendCurrencies = [...new Set(data.spendOverTime.map((point) => point.currency))];
  const spendBuckets = new Map<string, Record<string, number>>();
  for (const point of data.spendOverTime) {
    const bucket = bucketSpendDate(point.date, spendGranularity);
    const costs = spendBuckets.get(bucket) ?? {};
    costs[point.currency] = (costs[point.currency] ?? 0) + Number(point.cost);
    spendBuckets.set(bucket, costs);
  }
  const spendByDate = [...spendBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, costs]) => ({ date, ...costs }));
  const tokenUsage = data.tokenUsageOverTime.map((point) => ({
    ...point,
    netInput: Math.max(0, point.inputTokens - point.cacheReadTokens),
    cacheRead: point.cacheReadTokens,
    output: point.outputTokens,
  }));
  const spendByModel = collapseSpendTopN(
    data.spendByModel,
    (point) => ({ ...point, label: `${point.providerId}/${point.modelId} (${point.currency})` }),
    (currency, cost, mixedCurrencies) => ({
      modelId: 'Other',
      providerId: 'Other',
      cost,
      currency,
      label: mixedCurrencies ? `Other (${currency})` : 'Other',
    }),
  );
  const spendByProvider = collapseSpendTopN(
    data.spendByProvider,
    (point) => ({ ...point, label: `${point.providerId} (${point.currency})` }),
    (currency, cost, mixedCurrencies) => ({
      providerId: 'Other',
      cost,
      currency,
      label: mixedCurrencies ? `Other (${currency})` : 'Other',
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Overview</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Spend" value={formatCost(stats.totalCost)} subtext={`${paidCostRecords} paid · ${stats.unknownCostCount} unknown`} />
        <StatCard label="Total Tokens" value={formatTokenCount(totalTokens)} subtext={`${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out · ${stats.unknownUsageCount} unknown`} />
        <StatCard label="API Calls" value={stats.totalAttempts} subtext={`${stats.succeededAttempts} succeeded / ${stats.failedAttempts} failed`} />
        <StatCard label="Sessions" value={stats.totalSessions} />
        <StatCard label="Avg Tokens/Session" value={avgTokensPerSession} />
        <StatCard label="Cache Hit Rate" value={cacheHitRate} subtext={`${formatTokenCount(stats.totalCacheReadTokens)} cache-read`} />
        <StatCard label="Error Rate" value={errorRate} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Spend Over Time" empty={data.spendOverTime.length === 0} emptyMessage="No spend data yet">
          <div className="mb-2 flex items-center gap-1">
            {SPEND_GRANULARITIES.map((option) => (
              <Button
                key={option.id}
                size="xs"
                variant={spendGranularity === option.id ? 'primary' : 'ghost'}
                onClick={() => setSpendGranularity(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
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

        <ChartCard title="Token Usage Over Time" empty={data.tokenUsageOverTime.length === 0} emptyMessage="No token usage yet">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokenUsage}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip content={(props) => {
                const point = props.payload?.[0]?.payload as TokenUsagePoint | undefined;
                if (!point) return null;
                return (
                  <TokenUsageTooltip
                    active={props.active}
                    label={String(props.label ?? point.date)}
                    rows={[
                      { name: 'Input', value: point.inputTokens },
                      { name: 'Output', value: point.outputTokens },
                      { name: 'Cache Read', value: point.cacheReadTokens },
                      { name: 'Cache Write', value: point.cacheWriteTokens },
                      { name: 'Reasoning', value: point.reasoningTokens },
                    ]}
                  />
                );
              }}
              />
              <Legend />
              <Bar dataKey="netInput" name="Input (net)" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="cacheRead" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="output" name="Output" stackId="a" fill={CHART_PALETTE[1]} />
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
