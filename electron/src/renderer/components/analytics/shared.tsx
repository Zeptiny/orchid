import type { ReactNode } from 'react';

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
}

export function ChartCard({ title, children, className = '' }: ChartCardProps) {
  return (
    <div className={`rounded-lg border border-base-300 bg-base-200/50 p-4 ${className}`}>
      <div className="mb-3 text-sm font-semibold text-base-content">{title}</div>
      {children}
    </div>
  );
}

interface SortableTableProps<T> {
  columns: ReadonlyArray<{ key: string; label: string; sortable?: boolean; render: (row: T) => ReactNode }>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
}

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'No data',
}: SortableTableProps<T>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-base-300 text-left">
            {columns.map((col) => (
              <th key={col.key} className="px-3 py-2 font-medium text-base-content/70">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-base-content/40">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
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
  );
}
