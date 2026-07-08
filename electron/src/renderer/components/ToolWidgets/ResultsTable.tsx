/**
 * ResultsTable — tabular display for grep results.
 *
 * Features:
 * - Columns: file, line number, matched text
 * - Clickable rows (navigate to file:line)
 * - Sortable by file
 *
 * Supported tools: grep.
 */
import { useState, useMemo, useCallback } from 'react';
import type { ToolCallEvent, GrepResultRow } from './types';

// ── Props ────────────────────────────────────────────────────────────────────

interface ResultsTableProps {
  /** The tool call event. */
  event: ToolCallEvent;
  /** Optional callback when a row is clicked (navigates to file:line). */
  onNavigate?: (file: string, line: number) => void;
}

// ── Parse grep results ───────────────────────────────────────────────────────

function parseGrepResults(event: ToolCallEvent): GrepResultRow[] {
  if (!event.result) return [];

  const rows: GrepResultRow[] = [];
  const lines = event.result.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    // Grep output format: file:line:matched_text
    const firstColon = line.indexOf(':');
    if (firstColon === -1) continue;

    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon === -1) continue;

    const file = line.slice(0, firstColon);
    const lineNumStr = line.slice(firstColon + 1, secondColon);
    const text = line.slice(secondColon + 1);
    const lineNum = parseInt(lineNumStr, 10);

    if (!isNaN(lineNum)) {
      rows.push({ file, line: lineNum, text });
    }
  }

  return rows;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ResultsTable({ event, onNavigate }: ResultsTableProps) {
  const [sortField, setSortField] = useState<'file' | 'line'>('file');
  const [sortAsc, setSortAsc] = useState(true);

  const rows = useMemo(() => parseGrepResults(event), [event]);

  const sortedRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      if (sortField === 'file') {
        const cmp = a.file.localeCompare(b.file);
        return sortAsc ? cmp : -cmp;
      }
      // Sort by line number
      return sortAsc ? a.line - b.line : b.line - a.line;
    });
    return sorted;
  }, [rows, sortField, sortAsc]);

  const handleSort = useCallback(
    (field: 'file' | 'line') => {
      if (sortField === field) {
        setSortAsc((prev) => !prev);
      } else {
        setSortField(field);
        setSortAsc(true);
      }
    },
    [sortField],
  );

  const handleRowClick = useCallback(
    (row: GrepResultRow) => {
      onNavigate?.(row.file, row.line);
    },
    [onNavigate],
  );

  // Empty state
  if (rows.length === 0) {
    return (
      <div className="tool-widget-results-table">
        <div className="tool-widget-results-header">
          <span className="tool-widget-results-label">Grep Results</span>
          <span className="tool-widget-results-count">0 matches</span>
        </div>
        <div className="tool-widget-results-empty">No results found.</div>
      </div>
    );
  }

  return (
    <div className="tool-widget-results-table">
      <div className="tool-widget-results-header">
        <span className="tool-widget-results-label">Grep Results</span>
        <span className="tool-widget-results-count">{rows.length} matches</span>
      </div>
      <div className="tool-widget-results-table-wrapper">
        <table className="tool-widget-results-table-el">
          <thead>
            <tr>
              <th
                className="tool-widget-results-th sortable"
                onClick={() => handleSort('file')}
              >
                File {sortField === 'file' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th
                className="tool-widget-results-th sortable"
                onClick={() => handleSort('line')}
              >
                Line {sortField === 'line' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th className="tool-widget-results-th">Match</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => (
              <tr
                key={i}
                className="tool-widget-results-row"
                onClick={() => handleRowClick(row)}
                role={onNavigate ? 'button' : undefined}
                tabIndex={onNavigate ? 0 : undefined}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && onNavigate) {
                    e.preventDefault();
                    handleRowClick(row);
                  }
                }}
              >
                <td className="tool-widget-results-td tool-widget-results-file">
                  {row.file}
                </td>
                <td className="tool-widget-results-td tool-widget-results-line-num">
                  {row.line}
                </td>
                <td className="tool-widget-results-td tool-widget-results-text">
                  {row.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
