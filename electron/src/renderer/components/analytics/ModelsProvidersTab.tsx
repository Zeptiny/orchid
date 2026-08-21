import { useState, type ReactNode } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import type {
  ModelBreakdown,
  ConnectionBreakdown,
  CostTimeSeriesPoint,
  ModelTokensOverTimePoint,
  AnalyticsTimeRange,
} from '../../../shared/types/analytics';
import { TTFT_BUCKET_MS } from '../../../shared/types/analytics';
import {
  StatCard,
  ChartCard,
  SortableTable,
  formatTokenCount,
  formatCost,
  formatCostAmount,
  formatPercent,
  formatDuration,
  formatTtft,
  formatTps,
  formatDate,
  netInputTokens,
  netOutputTokens,
  tokenStackTooltipRows,
  truncateId,
  TokenUsageTooltip,
  CHART_PALETTE,
  GRID_STROKE,
  axisTickProps,
  tooltipProps,
} from './shared';
import { Button } from '../ui/Button';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const DETAIL_PAGE_SIZE = 10;

type Column<T> = {
  key: string;
  label: string;
  sortable?: boolean;
  initialDir?: 'asc' | 'desc';
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
};

function pivotCostByDate<T extends CostTimeSeriesPoint>(
  points: readonly T[],
  seriesKey: (point: T) => string,
): {
  rows: Record<string, string | number>[];
  series: { key: string; currency: string }[];
} {
  const byDate = new Map<string, Record<string, string | number>>();
  const series = new Map<string, string>();
  for (const p of points) {
    const key = seriesKey(p);
    const row = byDate.get(p.date) ?? { date: p.date };
    row[key] = Number(p.cost);
    byDate.set(p.date, row);
    series.set(key, p.currency);
  }
  return {
    rows: [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    series: [...series].map(([key, currency]) => ({ key, currency })),
  };
}

const modelColumns: ReadonlyArray<Column<ModelBreakdown>> = [
  { key: 'model', label: 'Model', sortable: true, initialDir: 'asc', sortValue: (m) => m.modelId, render: (m) => m.modelId },
  { key: 'connection', label: 'Connection', sortable: true, initialDir: 'asc', sortValue: (m) => m.connectionName ?? m.connectionId, render: (m) => m.connectionName ?? '—' },
  { key: 'cost', label: 'Total Cost', sortable: true, initialDir: 'desc', sortValue: (m) => Math.max(...m.totalCost.map((c) => Number(c.amount)), 0), render: (m) => formatCost(m.totalCost) },
  { key: 'input', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (m) => m.inputTokens, render: (m) => formatTokenCount(m.inputTokens) },
  { key: 'output', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (m) => m.outputTokens, render: (m) => formatTokenCount(m.outputTokens) },
  { key: 'cacheRead', label: 'Cache Read', sortable: true, initialDir: 'desc', sortValue: (m) => m.cacheReadTokens, render: (m) => formatTokenCount(m.cacheReadTokens) },
  { key: 'cacheWrite', label: 'Cache Write', sortable: true, initialDir: 'desc', sortValue: (m) => m.cacheWriteTokens, render: (m) => formatTokenCount(m.cacheWriteTokens) },
  { key: 'cacheHit', label: 'Cache Hit', sortable: true, initialDir: 'desc', sortValue: (m) => m.inputTokens > 0 ? m.cacheReadTokens / m.inputTokens : -1, render: (m) => m.inputTokens > 0 ? formatPercent(m.cacheReadTokens / m.inputTokens) : '—' },
  { key: 'reasoning', label: 'Reasoning', sortable: true, initialDir: 'desc', sortValue: (m) => m.reasoningTokens, render: (m) => formatTokenCount(m.reasoningTokens) },
  { key: 'ttftAvg', label: 'TTFT (avg)', sortable: true, initialDir: 'desc', sortValue: (m) => m.avgTtftMs ?? -1, render: (m) => formatTtft(m.avgTtftMs) },
  { key: 'ttftP95', label: 'TTFT (p95)', sortable: true, initialDir: 'desc', sortValue: (m) => m.p95TtftMs ?? -1, render: (m) => formatTtft(m.p95TtftMs) },
  { key: 'speed', label: 'Speed', sortable: true, initialDir: 'desc', sortValue: (m) => m.avgTokensPerSecond ?? -1, render: (m) => formatTps(m.avgTokensPerSecond) },
  { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (m) => m.attempts, render: (m) => m.attempts },
  { key: 'succeeded', label: 'Succeeded', sortable: true, initialDir: 'desc', sortValue: (m) => m.succeeded, render: (m) => m.succeeded },
  { key: 'failed', label: 'Failed', sortable: true, initialDir: 'desc', sortValue: (m) => m.failed, render: (m) => m.failed },
  { key: 'interrupted', label: 'Interrupted', sortable: true, initialDir: 'desc', sortValue: (m) => m.interrupted, render: (m) => m.interrupted },
  { key: 'firstUsed', label: 'First Used', sortable: true, initialDir: 'desc', sortValue: (m) => m.firstUsed !== null ? Date.parse(m.firstUsed) : -1, render: (m) => formatDate(m.firstUsed) },
  { key: 'lastUsed', label: 'Last Used', sortable: true, initialDir: 'desc', sortValue: (m) => m.lastUsed !== null ? Date.parse(m.lastUsed) : -1, render: (m) => formatDate(m.lastUsed) },
];

const connectionColumns: ReadonlyArray<Column<ConnectionBreakdown>> = [
  { key: 'connectionName', label: 'Connection', sortable: true, initialDir: 'asc', sortValue: (c) => c.connectionName ?? c.connectionId, render: (c) => c.connectionName ?? '—' },
  { key: 'cost', label: 'Total Cost', sortable: true, initialDir: 'desc', sortValue: (c) => Math.max(...c.totalCost.map((x) => Number(x.amount)), 0), render: (c) => formatCost(c.totalCost) },
  { key: 'input', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (c) => c.totalInputTokens, render: (c) => formatTokenCount(c.totalInputTokens) },
  { key: 'output', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (c) => c.totalOutputTokens, render: (c) => formatTokenCount(c.totalOutputTokens) },
  { key: 'ttftAvg', label: 'TTFT (avg)', sortable: true, initialDir: 'desc', sortValue: (c) => c.avgTtftMs ?? -1, render: (c) => formatTtft(c.avgTtftMs) },
  { key: 'ttftP95', label: 'TTFT (p95)', sortable: true, initialDir: 'desc', sortValue: (c) => c.p95TtftMs ?? -1, render: (c) => formatTtft(c.p95TtftMs) },
  { key: 'speed', label: 'Speed', sortable: true, initialDir: 'desc', sortValue: (c) => c.avgTokensPerSecond ?? -1, render: (c) => formatTps(c.avgTokensPerSecond) },
  { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (c) => c.attempts, render: (c) => c.attempts },
  { key: 'succeeded', label: 'Succeeded', sortable: true, initialDir: 'desc', sortValue: (c) => c.succeeded, render: (c) => c.succeeded },
  { key: 'failed', label: 'Failed', sortable: true, initialDir: 'desc', sortValue: (c) => c.failed, render: (c) => c.failed },
  { key: 'interrupted', label: 'Interrupted', sortable: true, initialDir: 'desc', sortValue: (c) => c.interrupted, render: (c) => c.interrupted },
  { key: 'models', label: 'Models', sortable: true, initialDir: 'desc', sortValue: (c) => c.modelCount, render: (c) => c.modelCount },
  { key: 'firstUsed', label: 'First Used', sortable: true, initialDir: 'desc', sortValue: (c) => c.firstUsed !== null ? Date.parse(c.firstUsed) : -1, render: (c) => formatDate(c.firstUsed) },
  { key: 'lastUsed', label: 'Last Used', sortable: true, initialDir: 'desc', sortValue: (c) => c.lastUsed !== null ? Date.parse(c.lastUsed) : -1, render: (c) => formatDate(c.lastUsed) },
];

interface ModelTokenUsageRow {
  label: string;
  netInput: number;
  cacheRead: number;
  netOutput: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function ModelsList({ timeRange, onRowClick }: { timeRange: AnalyticsTimeRange; onRowClick: (row: ModelBreakdown) => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.models({ timeRange }),
    [timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading analytics…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const totalInput = data.models.reduce((sum, m) => sum + m.inputTokens, 0);
  const totalOutput = data.models.reduce((sum, m) => sum + m.outputTokens, 0);
  const totalAttempts = data.models.reduce((sum, m) => sum + m.attempts, 0);
  const totalSucceeded = data.models.reduce((sum, m) => sum + m.succeeded, 0);
  const totalFailed = data.models.reduce((sum, m) => sum + m.failed, 0);
  const totalInterrupted = data.models.reduce((sum, m) => sum + m.interrupted, 0);
  const errorRate = totalAttempts > 0
    ? formatPercent((totalFailed + totalInterrupted) / totalAttempts)
    : '—';
  const ttftSamples = data.models.map((m) => m.avgTtftMs).filter((v): v is number => v !== null);
  const speedSamples = data.models.map((m) => m.avgTokensPerSecond).filter((v): v is number => v !== null);
  const avgTtft = ttftSamples.length > 0 ? ttftSamples.reduce((sum, v) => sum + v, 0) / ttftSamples.length : null;
  const avgSpeed = speedSamples.length > 0 ? speedSamples.reduce((sum, v) => sum + v, 0) / speedSamples.length : null;

  const costOverTime = pivotCostByDate(
    data.costPerModelOverTime,
    (p) => `${p.providerId}/${p.modelId} · ${p.connectionId.slice(0, 8)} (${p.currency})`,
  );
  const connectionCostOverTime = pivotCostByDate(
    data.costPerConnectionOverTime,
    (p) => `${p.providerId} · ${p.connectionId.slice(0, 8)} (${p.currency})`,
  );
  const tokenPerModel: ModelTokenUsageRow[] = data.models.map((m) => ({
    label: `${m.connectionName ?? m.connectionId.slice(0, 8)} - ${m.modelDisplayName ?? m.modelId}`,
    netInput: netInputTokens(m.inputTokens, m.cacheReadTokens),
    cacheRead: m.cacheReadTokens,
    netOutput: netOutputTokens(m.outputTokens, m.reasoningTokens),
    inputTokens: m.inputTokens,
    cacheReadTokens: m.cacheReadTokens,
    outputTokens: m.outputTokens,
    reasoningTokens: m.reasoningTokens,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Models &amp; Providers</h2>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Models" value={data.models.length} />
        <StatCard label="Connections" value={data.connections.length} />
        <StatCard label="Total Spend" value={formatCost(data.totalCost)} />
        <StatCard label="Total Tokens" value={formatTokenCount(totalInput + totalOutput)} subtext={`${formatTokenCount(totalInput)} in / ${formatTokenCount(totalOutput)} out`} />
        <StatCard label="API Calls" value={totalAttempts} subtext={`${totalSucceeded} succeeded`} />
        <StatCard label="Error Rate" value={errorRate} subtext={`${totalFailed} failed / ${totalInterrupted} interrupted`} />
        <StatCard label="Avg TTFT" value={formatTtft(avgTtft)} subtext={`${ttftSamples.length} models sampled`} />
        <StatCard label="Avg Speed" value={formatTps(avgSpeed)} subtext={`${speedSamples.length} models sampled`} />
      </div>

      <ChartCard title="Per-Model Breakdown">
        <SortableTable
          columns={modelColumns}
          rows={data.models}
          rowKey={(m) => `${m.connectionId}:${m.providerId}:${m.modelId}`}
          onRowClick={onRowClick}
          emptyMessage="No model usage recorded"
        />
      </ChartCard>

      <ChartCard title="Per-Connection Breakdown">
        <SortableTable
          columns={connectionColumns}
          rows={data.connections}
          rowKey={(c) => c.connectionId}
          emptyMessage="No connection usage recorded"
        />
      </ChartCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Cost per Model Over Time" empty={costOverTime.rows.length === 0} emptyMessage="No cost data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={costOverTime.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, name) => {
                const currency = costOverTime.series.find((item) => item.key === name)?.currency ?? null;
                return formatCostAmount(String(value), currency);
              }} />
              <Legend />
              {costOverTime.series.map((item, index) => (
                <Line key={item.key} type="monotone" dataKey={item.key} stroke={CHART_PALETTE[index % CHART_PALETTE.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost per Connection Over Time" empty={connectionCostOverTime.rows.length === 0} emptyMessage="No cost data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={connectionCostOverTime.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, name) => {
                const currency = connectionCostOverTime.series.find((item) => item.key === name)?.currency ?? null;
                return formatCostAmount(String(value), currency);
              }} />
              <Legend />
              {connectionCostOverTime.series.map((item, index) => (
                <Line key={item.key} type="monotone" dataKey={item.key} stroke={CHART_PALETTE[index % CHART_PALETTE.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Token Usage per Model" className="lg:col-span-2" empty={tokenPerModel.length === 0} emptyMessage="No token usage recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={tokenPerModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis type="number" tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <YAxis type="category" dataKey="label" tick={axisTickProps} width={170} />
              <Tooltip content={(props) => {
                const row = props.payload?.[0]?.payload as ModelTokenUsageRow | undefined;
                if (!row) return null;
                return (
                  <TokenUsageTooltip
                    active={props.active}
                    label={row.label}
                    rows={tokenStackTooltipRows(row.inputTokens, row.cacheReadTokens, row.outputTokens, row.reasoningTokens)}
                  />
                );
              }} />
              <Legend />
              <Bar dataKey="netInput" name="Input (net of cache)" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="cacheRead" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="netOutput" name="Output (net of reasoning)" stackId="a" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

function ModelExplorer({ model, timeRange, onBack }: { model: ModelBreakdown; timeRange: AnalyticsTimeRange; onBack: () => void }) {
  const selectionKey = `${model.providerId}\0${model.modelId}\0${model.connectionId}`;
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.modelDetail({
      modelId: model.modelId,
      providerId: model.providerId,
      connectionId: model.connectionId,
      timeRange,
    }),
    [selectionKey, timeRange],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading model detail…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const { stats } = data;

  const ttftBuckets = (() => {
    if (data.ttftHistogram.length === 0) return [];
    const counts = new Map(data.ttftHistogram.map((b) => [b.bucketMs, b.count]));
    const minBucket = Math.min(...data.ttftHistogram.map((b) => b.bucketMs));
    const maxBucket = Math.max(...data.ttftHistogram.map((b) => b.bucketMs));
    const rows: { bucket: string; count: number }[] = [];
    for (let ms = minBucket; ms <= maxBucket; ms += TTFT_BUCKET_MS) {
      rows.push({ bucket: `${ms}ms`, count: counts.get(ms) ?? 0 });
    }
    return rows;
  })();

  const costOverTime = pivotCostByDate(data.costOverTime, (p) => p.currency);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-base-content/60 hover:text-base-content">← Back to Models &amp; Providers</button>
        <Button variant="ghost" size="xs" onClick={refresh}>↻ Refresh</Button>
      </div>

      <h2 className="text-lg font-semibold text-base-content">
        {model.modelDisplayName ?? model.modelId}
        {model.modelDisplayName !== null && model.modelDisplayName !== model.modelId && (
          <span className="ml-2 text-sm font-normal text-base-content/40">{model.modelId}</span>
        )}
        <span className="ml-2 text-sm font-normal text-base-content/40" title={model.connectionId}>
          {model.providerId} · {model.connectionName ?? truncateId(model.connectionId)}
        </span>
      </h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Attempts" value={stats.attempts} subtext={`${stats.succeeded} succeeded / ${stats.failed} failed / ${stats.interrupted} interrupted`} />
        <StatCard label="Total Cost" value={formatCost(stats.totalCost)} />
        <StatCard label="Tokens" value={formatTokenCount(stats.inputTokens + stats.outputTokens)} subtext={`${formatTokenCount(stats.inputTokens)} in / ${formatTokenCount(stats.outputTokens)} out`} />
        <StatCard label="Avg TTFT" value={formatTtft(stats.avgTtftMs)} />
        <StatCard label="p95 TTFT" value={formatTtft(stats.p95TtftMs)} />
        <StatCard label="Avg Speed" value={formatTps(stats.avgTokensPerSecond)} />
        <StatCard label="Cache Hit" value={stats.inputTokens > 0 ? formatPercent(stats.cacheReadTokens / stats.inputTokens) : '—'} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="TTFT Histogram" empty={ttftBuckets.length === 0} emptyMessage="No TTFT samples recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={ttftBuckets}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="bucket" tick={axisTickProps} />
              <YAxis tick={axisTickProps} allowDecimals={false} />
              <Tooltip {...tooltipProps} />
              <Bar dataKey="count" name="Attempts" fill={CHART_PALETTE[0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="TTFT Over Time" empty={data.ttftOverTime.length === 0} emptyMessage="No TTFT samples recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data.ttftOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} labelFormatter={(label) => formatDate(String(label))} formatter={(value) => formatTtft(Number(value))} />
              <Legend />
              <Line type="monotone" dataKey="medianTtftMs" name="Median TTFT" stroke={CHART_PALETTE[0]} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p95TtftMs" name="p95 TTFT" stroke={CHART_PALETTE[2]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Tokens Over Time" empty={data.tokensOverTime.length === 0} emptyMessage="No token usage recorded">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.tokensOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} tickFormatter={(value) => formatTokenCount(Number(value))} />
              <Tooltip content={(props) => {
                const row = props.payload?.[0]?.payload as ModelTokensOverTimePoint | undefined;
                if (!row) return null;
                return (
                  <TokenUsageTooltip
                    active={props.active}
                    label={row.date}
                    rows={tokenStackTooltipRows(
                      row.netInputTokens + row.cacheReadTokens,
                      row.cacheReadTokens,
                      row.netOutputTokens + row.reasoningTokens,
                      row.reasoningTokens,
                    )}
                  />
                );
              }} />
              <Legend />
              <Bar dataKey="netInputTokens" name="Input (net of cache)" stackId="a" fill={CHART_PALETTE[0]} />
              <Bar dataKey="cacheReadTokens" name="Cache Read" stackId="a" fill={CHART_PALETTE[2]} />
              <Bar dataKey="netOutputTokens" name="Output (net of reasoning)" stackId="a" fill={CHART_PALETTE[1]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost Over Time" empty={costOverTime.rows.length === 0} emptyMessage="No cost data recorded">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={costOverTime.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="date" tick={axisTickProps} />
              <YAxis tick={axisTickProps} />
              <Tooltip {...tooltipProps} formatter={(value, name) => {
                const currency = costOverTime.series.find((item) => item.key === name)?.currency ?? null;
                return formatCostAmount(String(value), currency);
              }} />
              <Legend />
              {costOverTime.series.map((item, index) => (
                <Line key={item.key} type="monotone" dataKey={item.key} stroke={CHART_PALETTE[index % CHART_PALETTE.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Top Sessions">
        <SortableTable
          columns={[
            { key: 'sessionName', label: 'Session', sortable: true, initialDir: 'asc', sortValue: (r) => r.sessionName ?? '', render: (r) => <span title={r.sessionId}>{r.sessionName ?? '—'}</span> },
            { key: 'attempts', label: 'Attempts', sortable: true, initialDir: 'desc', sortValue: (r) => r.attempts, render: (r) => r.attempts },
            { key: 'inputTokens', label: 'Input Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens, render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens, render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'totalCost', label: 'Total Cost', sortable: true, initialDir: 'desc', sortValue: (r) => Math.max(...r.totalCost.map((c) => Number(c.amount)), 0), render: (r) => formatCost(r.totalCost) },
          ]}
          rows={data.topSessions}
          rowKey={(r) => r.sessionId}
          emptyMessage="No sessions used this model"
        />
      </ChartCard>

      <ChartCard title="Recent Attempts">
        <SortableTable
          columns={[
            { key: 'startedAt', label: 'Started', sortable: true, initialDir: 'desc', sortValue: (r) => Date.parse(r.startedAt), render: (r) => formatDate(r.startedAt) },
            { key: 'outcome', label: 'Outcome', sortable: true, initialDir: 'asc', sortValue: (r) => r.outcome, render: (r) => r.outcome },
            { key: 'costAmount', label: 'Cost', sortable: true, initialDir: 'desc', sortValue: (r) => r.costAmount !== null ? Number(r.costAmount) : -1, render: (r) => formatCostAmount(r.costAmount, r.currency) },
            { key: 'inputTokens', label: 'Input', sortable: true, initialDir: 'desc', sortValue: (r) => r.inputTokens ?? -1, render: (r) => r.inputTokens !== null ? formatTokenCount(r.inputTokens) : '—' },
            { key: 'outputTokens', label: 'Output', sortable: true, initialDir: 'desc', sortValue: (r) => r.outputTokens ?? -1, render: (r) => r.outputTokens !== null ? formatTokenCount(r.outputTokens) : '—' },
            { key: 'ttftMs', label: 'TTFT', sortable: true, initialDir: 'desc', sortValue: (r) => r.ttftMs ?? -1, render: (r) => formatTtft(r.ttftMs) },
            { key: 'tokensPerSecond', label: 'Speed', sortable: true, initialDir: 'desc', sortValue: (r) => r.tokensPerSecond ?? -1, render: (r) => formatTps(r.tokensPerSecond) },
            { key: 'latencyMs', label: 'Latency', sortable: true, initialDir: 'desc', sortValue: (r) => r.latencyMs ?? -1, render: (r) => formatDuration(r.latencyMs) },
            { key: 'turnId', label: 'Turn', sortable: true, initialDir: 'asc', sortValue: (r) => r.turnId ?? '', render: (r) => r.turnId !== null ? <span title={r.turnId}>{truncateId(r.turnId)}</span> : '—' },
          ]}
          rows={data.recentAttempts}
          rowKey={(r) => r.attemptId}
          emptyMessage="No attempts recorded"
          pageSize={DETAIL_PAGE_SIZE}
        />
      </ChartCard>
    </div>
  );
}

export function ModelsProvidersTab({ timeRange }: { timeRange: AnalyticsTimeRange }) {
  const [selectedModel, setSelectedModel] = useState<ModelBreakdown | null>(null);

  if (selectedModel !== null) {
    return <ModelExplorer model={selectedModel} timeRange={timeRange} onBack={() => setSelectedModel(null)} />;
  }
  return <ModelsList timeRange={timeRange} onRowClick={setSelectedModel} />;
}
