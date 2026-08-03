import { useAnalytics } from '../../hooks/useAnalytics';
import type { AnalyticsTimeRange } from '../../../shared/types/analytics';
import { StatCard, ChartCard, formatTokenCount, truncateId } from './shared';
import { CHART_PALETTE, GRID_STROKE, axisTickProps, tokenTooltipProps } from './shared';
import { Button } from '../ui/Button';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

function sessionLabel(sessionName: string | null, sessionId: string): string {
  return sessionName ?? truncateId(sessionId);
}

function subagentLabel(series: { agentName: string | null; subagentId: string }): string {
  return `${series.agentName ?? 'subagent'} · ${truncateId(series.subagentId)}`;
}

const SUBAGENT_SERIES_KEY_PREFIX = 'subagent:';

export function ContextTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.context({ timeRange }),
    [timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const timestampMap = new Map<string, Record<string, number | string>>();
  for (const series of data.topSessions) {
    for (const point of series.points) {
      const row = timestampMap.get(point.capturedAt) ?? { capturedAt: point.capturedAt };
      row[series.sessionId] = point.usedTokens;
      timestampMap.set(point.capturedAt, row);
    }
  }
  for (const series of data.topSubagents) {
    const key = `${SUBAGENT_SERIES_KEY_PREFIX}${series.subagentId}`;
    for (const point of series.points) {
      const row = timestampMap.get(point.capturedAt) ?? { capturedAt: point.capturedAt };
      row[key] = point.usedTokens;
      timestampMap.set(point.capturedAt, row);
    }
  }
  const growthData = Array.from(timestampMap.values()).sort((a, b) =>
    String(a.capturedAt).localeCompare(String(b.capturedAt)),
  );

  const breakdownData = [{
    name: 'Average',
    System: data.avgBreakdown.systemTokens,
    Tools: data.avgBreakdown.toolsTokens,
    'Tool Results': data.avgBreakdown.toolUseTokens,
    User: data.avgBreakdown.userTokens,
    Assistant: data.avgBreakdown.assistantTokens,
  }];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Context</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Snapshots" value={data.totalSnapshots} />
        <StatCard label="Avg Used Tokens" value={formatTokenCount(data.avgBreakdown.usedTokens)} />
        <StatCard label="Avg System Tokens" value={formatTokenCount(data.avgBreakdown.systemTokens)} />
        <StatCard label="Avg Tools Tokens" value={formatTokenCount(data.avgBreakdown.toolsTokens + data.avgBreakdown.toolUseTokens)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Context Growth"
          className="lg:col-span-2"
          empty={growthData.length === 0}
          emptyMessage="No context snapshots recorded"
        >
          {(data.totalSessionCount > data.topSessions.length
            || data.totalSubagentCount > data.topSubagents.length) && (
            <div className="mb-2 space-y-0.5 text-xs text-base-content/50">
              {data.totalSessionCount > data.topSessions.length && (
                <div>(showing top {data.topSessions.length} of {data.totalSessionCount} sessions)</div>
              )}
              {data.totalSubagentCount > data.topSubagents.length && (
                <div>(showing top {data.topSubagents.length} of {data.totalSubagentCount} subagents)</div>
              )}
            </div>
          )}
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={growthData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="capturedAt" tick={axisTickProps} tickFormatter={(value) => formatTimestamp(String(value))} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip {...tokenTooltipProps} labelFormatter={(label) => formatTimestamp(String(label))} />
              <Legend />
              {data.topSessions.map((series, i) => (
                <Line
                  key={series.sessionId}
                  type="monotone"
                  dataKey={series.sessionId}
                  name={sessionLabel(series.sessionName, series.sessionId)}
                  stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
                  strokeWidth={2}
                  connectNulls
                />
              ))}
              {data.topSubagents.map((series, i) => (
                <Line
                  key={`${SUBAGENT_SERIES_KEY_PREFIX}${series.subagentId}`}
                  type="monotone"
                  dataKey={`${SUBAGENT_SERIES_KEY_PREFIX}${series.subagentId}`}
                  name={subagentLabel(series)}
                  stroke={CHART_PALETTE[(data.topSessions.length + i) % CHART_PALETTE.length]}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Context Breakdown (Average)" empty={data.totalSnapshots === 0} emptyMessage="No context snapshots recorded">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={breakdownData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <YAxis type="category" dataKey="name" tick={axisTickProps} />
              <Tooltip {...tokenTooltipProps} />
              <Legend />
              <Bar dataKey="System" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="Tools" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="Tool Results" stackId="a" fill={CHART_PALETTE[3]} />
              <Bar dataKey="User" stackId="a" fill={CHART_PALETTE[1]} />
              <Bar dataKey="Assistant" stackId="a" fill={CHART_PALETTE[4]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Largest Contexts" empty={data.topSessions.length === 0} emptyMessage="No context snapshots recorded">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-base-300 text-left">
                <th className="px-3 py-2 font-medium text-base-content/70">Session</th>
                <th className="px-3 py-2 text-right font-medium text-base-content/70">Max Used Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.topSessions.map((series) => (
                <tr key={series.sessionId} className="border-b border-base-300/50">
                  <td className="px-3 py-2 text-base-content/90">{sessionLabel(series.sessionName, series.sessionId)}</td>
                  <td className="px-3 py-2 text-right text-base-content/90">{formatTokenCount(series.maxUsedTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>
      </div>
    </div>
  );
}
