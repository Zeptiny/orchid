import { useMemo, useState, type ReactNode } from 'react';
import type { QuotaOverviewEntry } from '../../../shared/types/analytics';

export function formatTokenCount(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Stacked-token netting: provider-reported inputTokens includes cache-read and
 * outputTokens includes reasoning, so stacked charts display the net values.
 */
export function netInputTokens(inputTokens: number, cacheReadTokens: number): number {
  return Math.max(0, inputTokens - cacheReadTokens);
}

export function netOutputTokens(outputTokens: number, reasoningTokens: number): number {
  return Math.max(0, outputTokens - reasoningTokens);
}

export function tokenStackTooltipRows(
  inputTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
  reasoningTokens: number,
): ReadonlyArray<{ name: string; value: number }> {
  return [
    { name: 'Input (net of cache)', value: netInputTokens(inputTokens, cacheReadTokens) },
    { name: 'Cache Read', value: cacheReadTokens },
    { name: 'Output (net of reasoning)', value: netOutputTokens(outputTokens, reasoningTokens) },
    { name: 'Reasoning', value: reasoningTokens },
    { name: 'Input (raw)', value: inputTokens },
    { name: 'Output (raw)', value: outputTokens },
  ];
}

export function formatCost(currencies: ReadonlyArray<{ currency: string; amount: string }>): string {
  if (currencies.length === 0) return '—';
  return currencies.map((c) => formatCostAmount(c.amount, c.currency)).join(', ');
}

export function formatCostAmount(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const formatted = n.toFixed(4);
  return currency ? `${currency} ${formatted}` : formatted;
}

/** Sort key for multi-currency cost columns: the largest amount across
 *  currencies, floored at zero so empty/negative inputs never lead.
 *  Non-finite amounts are excluded (mirrors formatCostAmount) so malformed
 *  rows can never make the key NaN. */
export function maxCostAmount(totalCost: ReadonlyArray<{ currency: string; amount: string }>): number {
  return Math.max(...totalCost.map((c) => Number(c.amount)).filter(Number.isFinite), 0);
}

/**
 * Format a native-unit amount (e.g. kWh) with its own unit label. Non-fiat
 * units are never converted or merged into a fiat bucket (R8/AE7).
 */
export function formatNativeAmount(amount: string | null, unit: string): string {
  if (amount === null) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(4)} ${unit}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a tokens-per-second rate; null (no latency samples) renders as an em dash. */
export function formatTps(tps: number | null): string {
  if (tps === null) return '—';
  return `${tps.toFixed(1)} tok/s`;
}

/** Format a time-to-first-token duration (same scale rules as {@link formatDuration}). */
export function formatTtft(ms: number | null): string {
  return formatDuration(ms);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

/** Sort key for ISO date columns: null/unparseable → 0. For equal-format
 *  ISO-8601 strings, epoch-ms ordering matches lexicographic ordering. */
export function dateSortValue(iso: string | null): number {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? 0 : ms;
}

export function truncateId(id: string, len = 8): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

export const CHART_PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const;

export const GRID_STROKE = 'var(--chart-grid)' as const;

export const axisTickProps = { fontSize: 11, fill: 'var(--chart-axis-text)' } as const;

export const tooltipProps = {
  contentStyle: {
    background: 'var(--chart-tooltip-bg)',
    border: '1px solid var(--chart-tooltip-border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 12,
  },
  labelStyle: { color: 'var(--chart-tooltip-label)', fontWeight: 600 },
  itemStyle: { color: 'var(--chart-tooltip-text)' },
} as const;

export const tokenTooltipProps = {
  ...tooltipProps,
  formatter: (value: unknown) => formatTokenCount(Number(value)),
};

export const costTooltipProps = {
  ...tooltipProps,
  formatter: (value: unknown) => formatCostAmount(String(value), null),
};

interface TokenUsageTooltipProps {
  label?: string;
  rows: ReadonlyArray<{ name: string; value: number }>;
  // Recharts tooltip content compatibility — content receives these on render.
  active?: boolean;
  payload?: ReadonlyArray<unknown>;
}

export function TokenUsageTooltip({ active = true, label, rows }: TokenUsageTooltipProps) {
  if (!active || rows.length === 0) return null;
  return (
    <div style={tooltipProps.contentStyle}>
      {label !== undefined && (
        <div className="mb-1" style={tooltipProps.labelStyle}>{label}</div>
      )}
      {rows.map((row) => (
        <div key={row.name} style={tooltipProps.itemStyle}>{row.name}: {formatTokenCount(row.value)}</div>
      ))}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  subtext?: string;
}

export function StatCard({ label, value, subtext }: StatCardProps) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-200/50 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-base-content/60">{label}</div>
      <div className="mt-1 text-2xl font-bold text-base-content">{value}</div>
      {subtext && <div className="mt-0.5 text-xs text-base-content/50">{subtext}</div>}
    </div>
  );
}

interface ChartCardProps {
  title: string;
  children: ReactNode;
  className?: string;
  empty?: boolean;
  emptyMessage?: string;
}

export function ChartCard({ title, children, className = '', empty = false, emptyMessage = 'No data to display' }: ChartCardProps) {
  return (
    <div className={`rounded-lg border border-base-300 bg-base-200/50 p-4 ${className}`}>
      <div className="mb-3 text-sm font-semibold text-base-content">{title}</div>
      {empty ? (
        <div className="flex h-48 items-center justify-center text-sm text-base-content/40">
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface SortableTableColumn<T> {
  key: string;
  label: string;
  sortable?: boolean;
  initialDir?: 'asc' | 'desc';
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
}

export type Column<T> = SortableTableColumn<T>;

interface SortableTableProps<T> {
  columns: ReadonlyArray<SortableTableColumn<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  pageSize?: number;
}

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'No data',
  pageSize,
}: SortableTableProps<T>) {
  const firstSortableKey = useMemo(
    () => columns.find((c) => c.sortable)?.key ?? null,
    [columns],
  );
  const [sortKey, setSortKey] = useState<string | null>(firstSortableKey);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(
    () => columns.find((c) => c.key === firstSortableKey)?.initialDir ?? 'asc',
  );
  const [page, setPage] = useState(0);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(columns.find((c) => c.key === key)?.initialDir ?? 'asc');
    }
    setPage(0);
  };

  const sortedRows = useMemo(() => {
    if (sortKey === null) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue ? col.sortValue(a) : String(col.render(a));
      const bv = col.sortValue ? col.sortValue(b) : String(col.render(b));
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, columns, sortKey, sortDir]);

  const totalPages = pageSize ? Math.max(1, Math.ceil(sortedRows.length / pageSize)) : 1;
  const clampedPage = Math.min(page, totalPages - 1);
  const pagedRows = pageSize
    ? sortedRows.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize)
    : sortedRows;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-base-300 text-left">
              {columns.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium text-base-content/70">
                  {col.sortable ? (
                    <button
                      className="inline-flex items-center gap-1 hover:text-base-content"
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}
                      {sortKey === col.key && (sortDir === 'asc' ? ' \u2191' : ' \u2193')}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-base-content/40">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pagedRows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={`border-b border-base-300/50 ${onRowClick ? 'cursor-pointer hover:bg-base-200' : ''}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-2 text-base-content/90">
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pageSize && sortedRows.length > pageSize && (
        <TablePager
          page={clampedPage}
          totalPages={totalPages}
          totalItems={sortedRows.length}
          pageSize={pageSize}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}

interface TablePagerProps {
  /** Zero-based current page. */
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

/** Shared pager for paged analytics tables: range label + Prev/Next controls. */
export function TablePager({ page, totalPages, totalItems, pageSize, onPageChange }: TablePagerProps) {
  return (
    <div className="flex items-center justify-between px-1 py-2 text-xs text-base-content/50">
      <span>
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, totalItems)} of {totalItems}
      </span>
      <div className="flex gap-1">
        <button
          className="rounded px-2 py-1 hover:bg-base-200 disabled:opacity-30"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
        >
          ← Prev
        </button>
        <span className="px-2 py-1">Page {page + 1}/{totalPages}</span>
        <button
          className="rounded px-2 py-1 hover:bg-base-200 disabled:opacity-30"
          onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function allowanceTone(state: string): 'success' | 'warning' | 'error' | 'neutral' {
  switch (state) {
    case 'available': return 'success';
    case 'limited': return 'warning';
    case 'blocked': return 'error';
    default: return 'neutral';
  }
}

function subscriptionTone(state: string): 'success' | 'warning' | 'error' | 'neutral' {
  switch (state) {
    case 'active': return 'success';
    case 'trialing': return 'success';
    case 'past-due': return 'warning';
    case 'cancelled': return 'error';
    case 'expired': return 'error';
    default: return 'neutral';
  }
}

/**
 * Quota state panel (R24). Balances, subscription, and allowances render in
 * provider-native units and are informational only — a blocked allowance is
 * shown as data, never as a reason a send is prevented (R25/AE6).
 */
export function QuotaPanel({ entries }: { readonly entries: readonly QuotaOverviewEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ChartCard title="Provider Quota &amp; Subscription">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {entries.map((entry) => (
          <div
            key={`${entry.providerId}${entry.connectionId ?? ''}`}
            className="rounded-lg border border-base-300 bg-base-100/50 p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-base-content">{entry.providerId}</span>
              {entry.stale && (
                <span className="rounded bg-base-300 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-base-content/60">
                  stale
                </span>
              )}
            </div>
            {entry.balances.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                {entry.balances.map((balance) => (
                  <div key={balance.label}>
                    <dt className="text-xs text-base-content/60">{balance.label}</dt>
                    <dd className="font-medium text-base-content">
                      {formatNativeAmount(balance.amount, balance.unit)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {entry.subscription && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    subscriptionTone(entry.subscription.state) === 'success'
                      ? 'bg-success'
                      : subscriptionTone(entry.subscription.state) === 'warning'
                        ? 'bg-warning'
                        : subscriptionTone(entry.subscription.state) === 'error'
                          ? 'bg-error'
                          : 'bg-base-300'
                  }`}
                />
                <span className="text-base-content/80">
                  {entry.subscription.displayName ?? 'Subscription'} · {entry.subscription.state}
                </span>
              </div>
            )}
            {entry.allowances.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {entry.allowances.map((allowance) => (
                  <span
                    key={allowance.label}
                    title={allowance.detail ?? undefined}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
                      allowanceTone(allowance.state) === 'success'
                        ? 'bg-success/15 text-success'
                        : allowanceTone(allowance.state) === 'warning'
                          ? 'bg-warning/15 text-warning'
                          : allowanceTone(allowance.state) === 'error'
                            ? 'bg-error/15 text-error'
                            : 'bg-base-300 text-base-content/70'
                    }`}
                  >
                    {allowance.label}: {allowance.state}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </ChartCard>
  );
}
