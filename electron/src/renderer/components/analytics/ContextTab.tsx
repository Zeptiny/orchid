import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type {
  AnalyticsTimeRange,
  ContextCompactionEvent,
  ContextJumpEvent,
  ContextSessionDetailPoint,
  ContextSessionDetailResult,
  ContextSessionPickerEntry,
} from '../../../shared/types/analytics';
import {
  StatCard,
  ChartCard,
  SortableTable,
  formatTokenCount,
  truncateId,
  CHART_PALETTE,
  GRID_STROKE,
  axisTickProps,
  tokenTooltipProps,
} from './shared';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { StateMessage } from '../ui/StateMessage';
import {
  LineChart, Line, BarChart, Bar, ReferenceDot, ReferenceLine, Brush,
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

/** Display cap per series. The server strides to 500 points; a 300px-tall chart
 * needs far fewer, and Recharts cost scales with total points. */
const DISPLAY_MAX_POINTS_PER_SERIES = 200;

type ContextPoint = { capturedAt: string; usedTokens: number };

/**
 * Stride-sample a series for display, keeping the peak and the newest point so
 * the chart shape (and the context window ceiling) stays faithful.
 */
export function downsamplePoints(points: ReadonlyArray<ContextPoint>, max: number): ReadonlyArray<ContextPoint> {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const sampled = points.filter((_, i) => i % stride === 0);
  let peakIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].usedTokens > points[peakIdx].usedTokens) peakIdx = i;
  }
  if (peakIdx % stride !== 0) {
    const peak = points[peakIdx];
    const insertAt = sampled.findIndex((p) => p.capturedAt >= peak.capturedAt);
    if (insertAt === -1) sampled.push(peak);
    else sampled.splice(insertAt, 0, peak);
  }
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

const COMPACTION_STROKE = 'var(--color-warning)';

const SEGMENT_KEYS = ['system', 'tools', 'toolUse', 'user', 'assistant', 'summary'] as const;
type SegmentKey = (typeof SEGMENT_KEYS)[number];

const SEGMENT_LABELS: Record<SegmentKey, string> = {
  system: 'System',
  tools: 'Tools',
  toolUse: 'Tool Use',
  user: 'User',
  assistant: 'Assistant',
  summary: 'Summary',
};

function segmentTokens(point: ContextSessionDetailPoint, key: SegmentKey): number {
  return point[`${key}Tokens`];
}

function formatDelta(n: number): string {
  return n > 0 ? `+${formatTokenCount(n)}` : formatTokenCount(n);
}

function deltaTone(n: number): string {
  if (n > 0) return 'text-warning';
  if (n < 0) return 'text-success';
  return 'text-base-content/50';
}

function SegmentDelta({ value }: { value: number }) {
  return <span className={`ml-1 text-xs ${deltaTone(value)}`}>({formatDelta(value)})</span>;
}

type Column<T> = {
  key: string;
  label: string;
  sortable?: boolean;
  initialDir?: 'asc' | 'desc';
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
};

const jumpColumns: ReadonlyArray<Column<ContextJumpEvent>> = [
  {
    key: 'when',
    label: 'When',
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.at,
    render: (event) => formatTimestamp(event.at),
  },
  {
    key: 'delta',
    label: 'Δ Tokens',
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.deltaTokens,
    render: (event) => <span className={deltaTone(event.deltaTokens)}>{formatDelta(event.deltaTokens)}</span>,
  },
  {
    key: 'fromTo',
    label: 'From → To',
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.toTokens,
    render: (event) => `${formatTokenCount(event.fromTokens)} → ${formatTokenCount(event.toTokens)}`,
  },
  ...SEGMENT_KEYS.map((key): Column<ContextJumpEvent> => ({
    key,
    label: SEGMENT_LABELS[key],
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.segmentDeltas[key],
    render: (event) => formatDelta(event.segmentDeltas[key]),
  })),
];

const compactionColumns: ReadonlyArray<Column<ContextCompactionEvent>> = [
  {
    key: 'when',
    label: 'When',
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.at,
    render: (event) => formatTimestamp(event.at),
  },
  {
    key: 'agent',
    label: 'Agent',
    sortable: true,
    sortValue: (event) => event.agentName,
    render: (event) => event.agentName,
  },
  {
    key: 'input',
    label: 'Tokens In',
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.inputTokens ?? -1,
    render: (event) => (event.inputTokens === null ? '—' : formatTokenCount(event.inputTokens)),
  },
  {
    key: 'output',
    label: 'Tokens Out',
    sortable: true,
    initialDir: 'desc',
    sortValue: (event) => event.outputTokens ?? -1,
    render: (event) => (event.outputTokens === null ? '—' : formatTokenCount(event.outputTokens)),
  },
];

function ContextSessionDrilldown({ detail }: { detail: ContextSessionDetailResult }) {
  const [selectedAt, setSelectedAt] = useState<string | null>(null);

  const jumpEvents = useMemo(
    () => detail.events.filter((event): event is ContextJumpEvent => event.type === 'jump'),
    [detail],
  );
  const compactionEvents = useMemo(
    () => detail.events.filter((event): event is ContextCompactionEvent => event.type === 'compaction'),
    [detail],
  );

  const compactionMarkers = useMemo(() => {
    if (detail.series.length === 0) return [] as string[];
    const markers: string[] = [];
    for (const event of compactionEvents) {
      const at = detail.series.find((point) => point.capturedAt >= event.at)?.capturedAt
        ?? detail.series[detail.series.length - 1].capturedAt;
      if (!markers.includes(at)) markers.push(at);
    }
    return markers;
  }, [detail, compactionEvents]);

  const selectedSnapshot = useMemo(() => {
    if (selectedAt === null) return null;
    const index = detail.series.findIndex((point) => point.capturedAt === selectedAt);
    if (index === -1) return null;
    return { point: detail.series[index], prev: index > 0 ? detail.series[index - 1] : null };
  }, [detail, selectedAt]);

  const snapshotRows = useMemo(() => {
    if (selectedSnapshot === null) return [];
    const { point, prev } = selectedSnapshot;
    return [
      { label: 'Used', value: point.usedTokens, delta: prev ? point.usedTokens - prev.usedTokens : null },
      ...SEGMENT_KEYS.map((key) => ({
        label: SEGMENT_LABELS[key],
        value: segmentTokens(point, key),
        delta: prev ? segmentTokens(point, key) - segmentTokens(prev, key) : null,
      })),
    ];
  }, [selectedSnapshot]);

  const peakUsedTokens = detail.series.length > 0
    ? Math.max(...detail.series.map((point) => point.usedTokens))
    : null;
  const largestJump = jumpEvents.reduce<ContextJumpEvent | null>(
    (best, event) => (best === null || event.deltaTokens > best.deltaTokens ? event : best),
    null,
  );

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Snapshots"
          value={detail.series.length}
          subtext={detail.truncated ? 'capped at newest 2000' : undefined}
        />
        <StatCard label="Peak Used Tokens" value={peakUsedTokens === null ? '—' : formatTokenCount(peakUsedTokens)} />
        <StatCard
          label="Largest Jump"
          value={largestJump === null ? '—' : formatDelta(largestJump.deltaTokens)}
          subtext={largestJump === null ? undefined : formatTimestamp(largestJump.at)}
        />
        <StatCard label="Compactions" value={compactionEvents.length} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Context Growth"
          className="lg:col-span-2"
          empty={detail.series.length === 0}
          emptyMessage="No context snapshots recorded"
        >
          {detail.truncated && (
            <div className="mb-2 text-xs text-base-content/50">(showing newest {detail.series.length} snapshots)</div>
          )}
          {compactionMarkers.length > 0 && (
            <div className="mb-2 text-xs text-warning">⚠ compaction</div>
          )}
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={detail.series}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="capturedAt" tick={axisTickProps} tickFormatter={(value) => formatTimestamp(String(value))} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip {...tokenTooltipProps} labelFormatter={(label) => formatTimestamp(String(label))} />
              {compactionMarkers.map((at) => (
                <ReferenceLine key={at} x={at} stroke={COMPACTION_STROKE} strokeDasharray="4 4" />
              ))}
              {selectedSnapshot !== null && (
                <ReferenceDot
                  x={selectedSnapshot.point.capturedAt}
                  y={selectedSnapshot.point.usedTokens}
                  r={4}
                  fill={CHART_PALETTE[0]}
                  stroke={CHART_PALETTE[0]}
                />
              )}
              <Line
                type="monotone"
                dataKey="usedTokens"
                name="Used Tokens"
                stroke={CHART_PALETTE[0]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Brush
                dataKey="capturedAt"
                height={20}
                travellerWidth={8}
                stroke={GRID_STROKE}
                fill="transparent"
                tickFormatter={(value) => formatTimestamp(String(value))}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Context Jumps"
          className="lg:col-span-2"
          empty={detail.series.length === 0}
          emptyMessage="No context snapshots recorded"
        >
          <SortableTable
            columns={jumpColumns}
            rows={jumpEvents}
            rowKey={(event) => event.at}
            onRowClick={(event) => setSelectedAt((prev) => (prev === event.at ? null : event.at))}
            emptyMessage="No context jumps recorded"
          />
        </ChartCard>

        {selectedSnapshot !== null && (
          <ChartCard title="Snapshot Detail">
            <div className="mb-3 text-xs text-base-content/60">
              {formatTimestamp(selectedSnapshot.point.capturedAt)}
            </div>
            <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {snapshotRows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-base-content/60">{row.label}</dt>
                  <dd className="font-medium text-base-content">
                    {formatTokenCount(row.value)}
                    {row.delta !== null && <SegmentDelta value={row.delta} />}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 space-y-1 text-xs text-base-content/60">
              <div title={selectedSnapshot.point.turnId ?? undefined}>
                turn: {selectedSnapshot.point.turnId === null ? '—' : truncateId(selectedSnapshot.point.turnId)}
              </div>
              <div title={selectedSnapshot.point.providerAttemptId ?? undefined}>
                attempt: {selectedSnapshot.point.providerAttemptId === null
                  ? '—'
                  : truncateId(selectedSnapshot.point.providerAttemptId)}
              </div>
            </div>
          </ChartCard>
        )}

        <ChartCard title="Compactions" empty={compactionEvents.length === 0} emptyMessage="No compactions recorded">
          <SortableTable
            columns={compactionColumns}
            rows={compactionEvents}
            rowKey={(event) => `${event.at}:${event.agentName}`}
            emptyMessage="No compactions recorded"
          />
        </ChartCard>
      </div>
    </>
  );
}

export function ContextTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionOptions, setSessionOptions] = useState<readonly ContextSessionPickerEntry[] | null>(null);

  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.context({ timeRange }),
    [timeRange],
  );

  const detailQuery = useAnalytics(
    () => (selectedSessionId === null
      ? Promise.resolve(null)
      : window.orchid.analytics.contextSessionDetail({ sessionId: selectedSessionId, timeRange })),
    [selectedSessionId, timeRange],
  );

  const detail = detailQuery.data !== null && detailQuery.data.sessionId === selectedSessionId
    ? detailQuery.data
    : null;

  useEffect(() => {
    setSessionOptions(null);
  }, [timeRange]);

  useEffect(() => {
    if (detailQuery.data !== null) setSessionOptions(detailQuery.data.sessions);
  }, [detailQuery.data]);

  const aggregateOptions = useMemo<readonly ContextSessionPickerEntry[]>(
    () => (data?.topSessions ?? []).map((series) => ({
      sessionId: series.sessionId,
      sessionName: series.sessionName,
      snapshotCount: 0,
      maxUsedTokens: series.maxUsedTokens,
    })),
    [data],
  );

  const pickerOptions = useMemo(() => {
    const base = sessionOptions ?? aggregateOptions;
    if (selectedSessionId !== null && !base.some((entry) => entry.sessionId === selectedSessionId)) {
      return [{ sessionId: selectedSessionId, sessionName: null, snapshotCount: 0, maxUsedTokens: 0 }, ...base];
    }
    return base;
  }, [sessionOptions, aggregateOptions, selectedSessionId]);

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId === '' ? null : sessionId);
  };

  const growthData = useMemo(() => {
    if (!data) return [];
    const timestampMap = new Map<string, Record<string, number | string>>();
    for (const series of data.topSessions) {
      for (const point of downsamplePoints(series.points, DISPLAY_MAX_POINTS_PER_SERIES)) {
        const row = timestampMap.get(point.capturedAt) ?? { capturedAt: point.capturedAt };
        row[series.sessionId] = point.usedTokens;
        timestampMap.set(point.capturedAt, row);
      }
    }
    for (const series of data.topSubagents) {
      const key = `${SUBAGENT_SERIES_KEY_PREFIX}${series.subagentId}`;
      for (const point of downsamplePoints(series.points, DISPLAY_MAX_POINTS_PER_SERIES)) {
        const row = timestampMap.get(point.capturedAt) ?? { capturedAt: point.capturedAt };
        row[key] = point.usedTokens;
        timestampMap.set(point.capturedAt, row);
      }
    }
    return Array.from(timestampMap.values()).sort((a, b) =>
      String(a.capturedAt).localeCompare(String(b.capturedAt)),
    );
  }, [data]);

  const breakdownData = useMemo(() => data ? [{
    name: 'Average',
    System: data.avgBreakdown.systemTokens,
    Tools: data.avgBreakdown.toolsTokens,
    'Tool Results': data.avgBreakdown.toolUseTokens,
    User: data.avgBreakdown.userTokens,
    Assistant: data.avgBreakdown.assistantTokens,
  }] : [], [data]);

  if (loading) return <StateMessage kind="loading" title="Loading Context…" />;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-base-content">Context</h2>
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            className="max-w-72"
            aria-label="Session"
            value={selectedSessionId ?? ''}
            onChange={(event) => handleSelectSession(event.target.value)}
          >
            <option value="">All sessions (aggregate)</option>
            {pickerOptions.map((entry) => (
              <option key={entry.sessionId} value={entry.sessionId}>
                {sessionLabel(entry.sessionName, entry.sessionId)} ({formatTokenCount(entry.maxUsedTokens)})
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              refresh();
              detailQuery.refresh();
            }}
          >
            ↻ Refresh
          </Button>
        </div>
      </div>

      {selectedSessionId !== null ? (
        detailQuery.error !== null ? (
          <div className="p-8 text-error">Error: {detailQuery.error}</div>
        ) : detail === null ? (
          <StateMessage kind="loading" title="Loading Session Context…" />
        ) : (
          <ContextSessionDrilldown key={detail.sessionId} detail={detail} />
        )
      ) : (
        <>
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
                      isAnimationActive={false}
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
                      isAnimationActive={false}
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
                    <tr
                      key={series.sessionId}
                      title="Drill into session"
                      className="cursor-pointer border-b border-base-300/50 hover:bg-base-200"
                      onClick={() => handleSelectSession(series.sessionId)}
                    >
                      <td className="px-3 py-2 text-base-content/90">{sessionLabel(series.sessionName, series.sessionId)}</td>
                      <td className="px-3 py-2 text-right text-base-content/90">{formatTokenCount(series.maxUsedTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
