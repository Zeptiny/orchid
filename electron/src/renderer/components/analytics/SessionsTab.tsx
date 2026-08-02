import { useState } from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import { StatCard, ChartCard, SortableTable } from './shared';
import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import type { SessionSummary } from '../../../shared/types/analytics';

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(currencies: ReadonlyArray<{ currency: string; amount: string }>): string {
  if (currencies.length === 0) return '$0.00';
  return currencies.map((c) => `$${Number(c.amount).toFixed(4)} ${c.currency}`).join(', ');
}

function formatCostAmount(amount: string | null): string {
  if (amount === null) return '—';
  return `$${Number(amount).toFixed(4)}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString();
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateId(id: string, len = 8): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

function SessionList({ onRowClick }: { onRowClick: (row: SessionSummary) => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.sessions(),
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading sessions…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-base-content">Sessions</h2>
        <button onClick={refresh} className="text-sm text-base-content/60 hover:text-base-content">↻ Refresh</button>
      </div>
      <SortableTable
        columns={[
          { key: 'sessionId', label: 'Session ID', render: (r) => <span title={r.sessionId}>{truncateId(r.sessionId)}</span> },
          { key: 'totalCost', label: 'Total Cost', render: (r) => formatCost(r.totalCost) },
          { key: 'inputTokens', label: 'Input Tokens', render: (r) => formatTokenCount(r.inputTokens) },
          { key: 'outputTokens', label: 'Output Tokens', render: (r) => formatTokenCount(r.outputTokens) },
          { key: 'totalTokens', label: 'Total Tokens', render: (r) => formatTokenCount(r.totalTokens) },
          { key: 'cache', label: 'Cache', render: (r) => formatTokenCount(r.cacheReadTokens) },
          { key: 'attempts', label: 'Attempts', render: (r) => r.attempts },
          { key: 'succeeded', label: 'Succeeded', render: (r) => r.succeeded },
          { key: 'failed', label: 'Failed', render: (r) => r.failed },
          { key: 'interrupted', label: 'Interrupted', render: (r) => r.interrupted },
          { key: 'firstAttempt', label: 'First Attempt', render: (r) => formatDate(r.firstAttempt) },
          { key: 'lastAttempt', label: 'Last Attempt', render: (r) => formatDate(r.lastAttempt) },
          { key: 'models', label: 'Models', render: (r) => r.modelsUsed.join(', ') || '—' },
          { key: 'subagents', label: 'Subagents', render: (r) => r.subagentCount },
        ]}
        rows={data}
        rowKey={(r) => r.sessionId}
        onRowClick={onRowClick}
        emptyMessage="No sessions found"
      />
    </div>
  );
}

function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { data, loading, error, refresh } = useAnalytics(
    () => window.orchid.analytics.sessionDetail({ sessionId }),
    [sessionId],
  );

  if (loading) return <div className="p-8 text-base-content/50">Loading session detail…</div>;
  if (error) return <div className="p-8 text-error">Error: {error}</div>;
  if (!data) return null;

  const { summary } = data;

  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0, reasoningTokens = 0;
  for (const a of data.attempts) {
    inputTokens += a.inputTokens ?? 0;
    outputTokens += a.outputTokens ?? 0;
    cacheRead += a.cacheReadTokens ?? 0;
    cacheWrite += a.cacheWriteTokens ?? 0;
    reasoningTokens += a.reasoningTokens ?? 0;
  }
  const tokenBreakdown = [
    { name: 'Input', value: inputTokens },
    { name: 'Output', value: outputTokens },
    { name: 'Cache Read', value: cacheRead },
    { name: 'Cache Write', value: cacheWrite },
    { name: 'Reasoning', value: reasoningTokens },
  ].filter((d) => d.value > 0);

  const costByModelMap = new Map<string, number>();
  for (const a of data.attempts) {
    if (a.costAmount !== null) {
      costByModelMap.set(a.modelId, (costByModelMap.get(a.modelId) ?? 0) + Number(a.costAmount));
    }
  }
  const costByModel = Array.from(costByModelMap, ([modelId, cost]) => ({ modelId, cost }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-base-content/60 hover:text-base-content">← Back to Sessions</button>
        <button onClick={refresh} className="text-sm text-base-content/60 hover:text-base-content">↻ Refresh</button>
      </div>

      <h2 className="text-lg font-semibold text-base-content">Session {truncateId(sessionId, 12)}</h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total Cost" value={formatCost(summary.totalCost)} />
        <StatCard label="Total Tokens" value={formatTokenCount(summary.totalInputTokens + summary.totalOutputTokens)} subtext={`${formatTokenCount(summary.totalInputTokens)} in / ${formatTokenCount(summary.totalOutputTokens)} out`} />
        <StatCard label="Cache Read" value={formatTokenCount(summary.totalCacheReadTokens)} />
        <StatCard label="Attempts" value={summary.attemptCount} subtext={`${summary.succeeded} succeeded / ${summary.failed} failed`} />
        <StatCard label="Succeeded" value={summary.succeeded} />
        <StatCard label="Failed" value={summary.failed} />
        <StatCard label="Interrupted" value={summary.interrupted} />
        <StatCard label="Subagents" value={summary.subagentCount} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Token Breakdown">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={tokenBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                {tokenBreakdown.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cost by Model">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costByModel} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--base-300, #333)" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="modelId" tick={{ fontSize: 11 }} width={120} />
              <Tooltip />
              <Bar dataKey="cost" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Chain Breakdown">
        <SortableTable
          columns={[
            { key: 'chainId', label: 'Chain ID', render: (r) => r.chainId ? <span title={r.chainId}>{truncateId(r.chainId)}</span> : '—' },
            { key: 'agentName', label: 'Agent', render: (r) => r.agentName ?? '—' },
            { key: 'agentTier', label: 'Tier', render: (r) => r.agentTier ?? '—' },
            { key: 'totalCost', label: 'Cost', render: (r) => formatCostAmount(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'attempts', label: 'Attempts', render: (r) => r.attempts },
            { key: 'outcomes', label: 'Outcomes', render: (r) => `${r.succeeded}/${r.failed}/${r.interrupted}` },
          ]}
          rows={data.chains}
          rowKey={(r) => r.chainId ?? `no-chain-${r.agentName ?? 'default'}`}
          emptyMessage="No chains"
        />
      </ChartCard>

      <ChartCard title="Attempt Timeline">
        <SortableTable
          columns={[
            { key: 'attemptId', label: 'Attempt ID', render: (r) => <span title={r.attemptId}>{truncateId(r.attemptId)}</span> },
            { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
            { key: 'modelId', label: 'Model', render: (r) => r.modelId },
            { key: 'providerId', label: 'Provider', render: (r) => r.providerId },
            { key: 'outcome', label: 'Outcome', render: (r) => r.outcome },
            { key: 'costAmount', label: 'Cost', render: (r) => formatCostAmount(r.costAmount) },
            { key: 'inputTokens', label: 'Input', render: (r) => r.inputTokens !== null ? formatTokenCount(r.inputTokens) : '—' },
            { key: 'outputTokens', label: 'Output', render: (r) => r.outputTokens !== null ? formatTokenCount(r.outputTokens) : '—' },
            { key: 'cacheReadTokens', label: 'Cache Read', render: (r) => r.cacheReadTokens !== null ? formatTokenCount(r.cacheReadTokens) : '—' },
            { key: 'cacheWriteTokens', label: 'Cache Write', render: (r) => r.cacheWriteTokens !== null ? formatTokenCount(r.cacheWriteTokens) : '—' },
            { key: 'reasoningTokens', label: 'Reasoning', render: (r) => r.reasoningTokens !== null ? formatTokenCount(r.reasoningTokens) : '—' },
            { key: 'latencyMs', label: 'Latency', render: (r) => formatDuration(r.latencyMs) },
            { key: 'agent', label: 'Agent', render: (r) => r.agentName ?? r.agentScope ?? '—' },
            { key: 'error', label: 'Error', render: (r) => r.error ?? '—' },
          ]}
          rows={data.attempts}
          rowKey={(r) => r.attemptId}
          emptyMessage="No attempts"
        />
      </ChartCard>

      <ChartCard title="Tool Calls">
        <SortableTable
          columns={[
            { key: 'toolName', label: 'Tool Name', render: (r) => r.toolName },
            { key: 'toolSource', label: 'Source', render: (r) => r.toolSource },
            { key: 'mcpServerName', label: 'MCP Server', render: (r) => r.mcpServerName ?? '—' },
            { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
            { key: 'durationMs', label: 'Duration', render: (r) => formatDuration(r.durationMs) },
            { key: 'outcome', label: 'Outcome', render: (r) => r.outcome },
            { key: 'resultSizeBytes', label: 'Result Size', render: (r) => formatBytes(r.resultSizeBytes) },
            { key: 'offloaded', label: 'Offloaded', render: (r) => r.offloaded ? 'Yes' : 'No' },
            { key: 'timedOut', label: 'Timed Out', render: (r) => r.timedOut ? 'Yes' : 'No' },
            { key: 'agentScope', label: 'Agent', render: (r) => r.agentScope ?? '—' },
          ]}
          rows={data.toolCalls}
          rowKey={(r) => r.toolAttemptId}
          emptyMessage="No tool calls"
        />
      </ChartCard>

      <ChartCard title="Subagents">
        <SortableTable
          columns={[
            { key: 'subagentId', label: 'Subagent ID', render: (r) => <span title={r.subagentId}>{truncateId(r.subagentId)}</span> },
            { key: 'agentName', label: 'Agent Name', render: (r) => r.agentName },
            { key: 'agentType', label: 'Type', render: (r) => r.agentType },
            { key: 'agentTier', label: 'Tier', render: (r) => r.agentTier },
            { key: 'modelId', label: 'Model', render: (r) => r.modelId },
            { key: 'status', label: 'Status', render: (r) => r.status },
            { key: 'totalCost', label: 'Cost', render: (r) => formatCostAmount(r.totalCost) },
            { key: 'inputTokens', label: 'Input Tokens', render: (r) => formatTokenCount(r.inputTokens) },
            { key: 'outputTokens', label: 'Output Tokens', render: (r) => formatTokenCount(r.outputTokens) },
            { key: 'attempts', label: 'Attempts', render: (r) => r.attempts },
            { key: 'startedAt', label: 'Started', render: (r) => formatDate(r.startedAt) },
            { key: 'completedAt', label: 'Completed', render: (r) => formatDate(r.completedAt) },
          ]}
          rows={data.subagents}
          rowKey={(r) => r.subagentId}
          emptyMessage="No subagents"
        />
      </ChartCard>
    </div>
  );
}

export function SessionsTab() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  if (selectedSessionId !== null) {
    return <SessionDetail sessionId={selectedSessionId} onBack={() => setSelectedSessionId(null)} />;
  }
  return <SessionList onRowClick={(row) => setSelectedSessionId(row.sessionId)} />;
}
