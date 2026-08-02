import { useMemo, useState, type ReactNode } from 'react';

export function formatTokenCount(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return String(n);
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

export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
}

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
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
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
        <div className="flex items-center justify-between px-1 py-2 text-xs text-base-content/50">
          <span>
            {clampedPage * pageSize + 1}–{Math.min((clampedPage + 1) * pageSize, sortedRows.length)} of {sortedRows.length}
          </span>
          <div className="flex gap-1">
            <button
              className="rounded px-2 py-1 hover:bg-base-200 disabled:opacity-30"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
            >
              ← Prev
            </button>
            <span className="px-2 py-1">Page {clampedPage + 1}/{totalPages}</span>
            <button
              className="rounded px-2 py-1 hover:bg-base-200 disabled:opacity-30"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
