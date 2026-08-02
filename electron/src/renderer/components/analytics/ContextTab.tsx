import type { ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type { ContextSnapshotSummary } from '../../../shared/types/analytics';
import { StatCard, ChartCard, SortableTable } from './shared';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const LINE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444'];

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

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
  const sessionIds = Array.from(sessionGroups.keys());

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

  const columns: ReadonlyArray<{
    key: string;
    label: string;
    sortable?: boolean;
    render: (row: ContextSnapshotSummary) => ReactNode;
  }> = [
    { key: 'sessionId', label: 'Session ID', sortable: true, render: (s) => s.sessionId },
    { key: 'chainId', label: 'Chain ID', render: (s) => s.chainId ?? '—' },
    { key: 'turnId', label: 'Turn ID', render: (s) => s.turnId ?? '—' },
    { key: 'capturedAt', label: 'Captured At', sortable: true, render: (s) => formatTimestamp(s.capturedAt) },
    { key: 'usedTokens', label: 'Used Tokens', sortable: true, render: (s) => formatTokenCount(s.usedTokens) },
    { key: 'systemTokens', label: 'System', sortable: true, render: (s) => formatTokenCount(s.systemTokens) },
    { key: 'toolsTokens', label: 'Tools', sortable: true, render: (s) => formatTokenCount(s.toolsTokens) },
    { key: 'toolUseTokens', label: 'Tool Results', sortable: true, render: (s) => formatTokenCount(s.toolUseTokens) },
    { key: 'userTokens', label: 'User', sortable: true, render: (s) => formatTokenCount(s.userTokens) },
    { key: 'assistantTokens', label: 'Assistant', sortable: true, render: (s) => formatTokenCount(s.assistantTokens) },
    { key: 'inputTokens', label: 'Input', sortable: true, render: (s) => formatTokenCount(s.inputTokens) },
    { key: 'outputTokens', label: 'Output', sortable: true, render: (s) => formatTokenCount(s.outputTokens) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Context</h2>
        <button onClick={refresh} className="text-sm text-base-content/60 hover:text-base-content">↻ Refresh</button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Snapshots" value={data.snapshots.length} />
        <StatCard label="Avg Used Tokens" value={formatTokenCount(avgUsedTokens)} />
        <StatCard label="Avg System Tokens" value={formatTokenCount(data.avgBreakdown.systemTokens)} />
        <StatCard label="Avg Tools Tokens" value={formatTokenCount(data.avgBreakdown.toolsTokens + data.avgBreakdown.toolUseTokens)} />
      </div>

      <ChartCard title="Context Snapshots">
        <SortableTable
          columns={columns}
          rows={data.snapshots}
          rowKey={(s) => s.snapshotId}
          emptyMessage="No context snapshots"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Context Growth per Session">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={growthData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="capturedAt" tick={{ fontSize: 11 }} tickFormatter={(value) => formatTimestamp(String(value))} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip labelFormatter={(label) => formatTimestamp(String(label))} />
              <Legend />
              {sessionIds.map((sessionId, i) => (
                <Line
                  key={sessionId}
                  type="monotone"
                  dataKey={sessionId}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={2}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Context Breakdown (Average)">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={breakdownData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip />
              <Legend />
              <Bar dataKey="System" stackId="a" fill="#3b82f6" />
              <Bar dataKey="Tools" stackId="a" fill="#f59e0b" />
              <Bar dataKey="Tool Results" stackId="a" fill="#8b5cf6" />
              <Bar dataKey="User" stackId="a" fill="#10b981" />
              <Bar dataKey="Assistant" stackId="a" fill="#ec4899" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
