import { useAnalytics } from '../../hooks/useAnalytics';
import type { ContextSnapshotSummary } from '../../../shared/types/analytics';
import { StatCard, ChartCard, formatTokenCount } from './shared';
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
  });
}

export function ContextTab() {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.context(),
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const sessionGroups = new Map<string, ContextSnapshotSummary[]>();
  for (const snap of data.snapshots) {
    const arr = sessionGroups.get(snap.sessionId) ?? [];
    arr.push(snap);
    sessionGroups.set(snap.sessionId, arr);
  }
  for (const arr of sessionGroups.values()) {
    arr.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  const timestampMap = new Map<string, Record<string, number | string>>();
  for (const [sessionId, snaps] of sessionGroups) {
    for (const snap of snaps) {
      const row = timestampMap.get(snap.capturedAt) ?? { capturedAt: snap.capturedAt };
      row[sessionId] = snap.usedTokens;
      timestampMap.set(snap.capturedAt, row);
    }
  }
  const growthData = Array.from(timestampMap.values()).sort((a, b) =>
    String(a.capturedAt).localeCompare(String(b.capturedAt)),
  );

  const sessionMaxTokens = Array.from(sessionGroups.entries()).map(([id, snaps]) => ({
    id,
    maxTokens: snaps.reduce((max, s) => Math.max(max, s.usedTokens), 0),
  }));
  sessionMaxTokens.sort((a, b) => b.maxTokens - a.maxTokens);
  const topSessionIds = sessionMaxTokens.slice(0, 5).map((s) => s.id);
  const totalSessionCount = sessionMaxTokens.length;

  const breakdownData = [{
    name: 'Average',
    System: data.avgBreakdown.systemTokens,
    Tools: data.avgBreakdown.toolsTokens,
    'Tool Results': data.avgBreakdown.toolUseTokens,
    User: data.avgBreakdown.userTokens,
    Assistant: data.avgBreakdown.assistantTokens,
  }];

  const avgUsedTokens = data.snapshots.length > 0
    ? Math.round(data.snapshots.reduce((sum, s) => sum + s.usedTokens, 0) / data.snapshots.length)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Context</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Snapshots" value={data.snapshots.length} />
        <StatCard label="Avg Used Tokens" value={formatTokenCount(avgUsedTokens)} />
        <StatCard label="Avg System Tokens" value={formatTokenCount(data.avgBreakdown.systemTokens)} />
        <StatCard label="Avg Tools Tokens" value={formatTokenCount(data.avgBreakdown.toolsTokens + data.avgBreakdown.toolUseTokens)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Context Growth per Session" empty={growthData.length === 0} emptyMessage="No context snapshots recorded">
          {totalSessionCount > 5 && (
            <div className="mb-2 text-xs text-base-content/50">(showing top 5 of {totalSessionCount} sessions)</div>
          )}
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={growthData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="capturedAt" tick={axisTickProps} tickFormatter={(value) => formatTimestamp(String(value))} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip {...tokenTooltipProps} labelFormatter={(label) => formatTimestamp(String(label))} />
              <Legend />
              {topSessionIds.map((sessionId, i) => (
                <Line
                  key={sessionId}
                  type="monotone"
                  dataKey={sessionId}
                  stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
                  strokeWidth={2}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Context Breakdown (Average)" empty={data.snapshots.length === 0} emptyMessage="No context snapshots recorded">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={breakdownData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="name" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
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
      </div>
    </div>
  );
}
