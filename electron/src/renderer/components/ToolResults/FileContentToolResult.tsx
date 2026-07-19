import { useState } from 'react';
import {
  fileContentDataSchema,
  type FileContentData,
} from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { ResultPager } from './ResultPager';
import { StatusBadge } from '../ui/StatusBadge';
import { Alert } from '../ui/Alert';

export interface FileContentToolResultProps {
  canonical: CanonicalToolResult;
}

const LINE_PAGE_SIZE = 100;

export function visibleFileContentLines(
  data: FileContentData,
  page: number,
  pageSize = LINE_PAGE_SIZE,
): readonly FileContentData['lines'][number][] {
  const start = Math.max(0, page) * pageSize;
  return data.lines.slice(start, start + pageSize);
}

function rangeText(range: FileContentData['requestedRange']): string {
  return range.end === undefined ? `${range.start}–…` : `${range.start}–${range.end}`;
}

export function fileContentRangeLabel(data: FileContentData): string {
  const returned = data.returnedRange ? `${data.returnedRange.start}–${data.returnedRange.end}` : 'none';
  return `requested ${rangeText(data.requestedRange)} · returned ${returned} of ${data.totalLineCount}`;
}

function statusNotice(canonical: CanonicalToolResult, data: FileContentData) {
  if (canonical.status === 'error') {
    return <Alert tone="error" variant="soft" className="mb-2 text-sm">{canonical.error.message}</Alert>;
  }
  if (canonical.status === 'cancelled') {
    return <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">Read was cancelled before completion.</Alert>;
  }
  if (canonical.status === 'empty' || data.returnedRange === null) {
    return <Alert tone="info" variant="soft" role="status" className="mb-2 text-sm">The requested range is empty.</Alert>;
  }
  if (canonical.status === 'partial') {
    return <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">Showing the returned range. More lines are available.</Alert>;
  }
  return null;
}

/** Numbered source-range presentation. Only the code body scrolls horizontally. */
export function FileContentToolResult({ canonical }: FileContentToolResultProps) {
  const parsed = fileContentDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const [page, setPage] = useState(0);
  const lines = visibleFileContentLines(data, page);
  return (
    <div className="min-w-0 space-y-2" data-result-family="file-content">
      {statusNotice(canonical, data)}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{data.path}</code>
        <span className="text-base-content/70">{fileContentRangeLabel(data)}</span>
        {data.language && <StatusBadge tone="neutral" outline size="xs">{data.language}</StatusBadge>}
      </div>
      <div className="max-w-full overflow-x-auto rounded-box border border-base-300/70">
        <div className="min-w-max font-mono text-xs leading-5" role="table" aria-label={`Source lines from ${data.path}`}>
          {lines.length > 0 ? lines.map((line) => (
            <div role="row" key={line.number} className="flex min-w-max text-base-content/85">
              <span role="cell" aria-hidden className="w-14 shrink-0 border-r border-base-300/60 px-2 text-right text-base-content/50">{line.number}</span>
              <code role="cell" className={`whitespace-pre px-3 language-${data.language ?? 'text'}`}>{line.content || ' '}</code>
            </div>
          )) : <div role="row" className="px-3 py-2 text-base-content/70">No lines in the requested range.</div>}
        </div>
      </div>
      <ResultPager total={data.lines.length} page={page} pageSize={LINE_PAGE_SIZE} onPageChange={setPage} label="source lines" />
    </div>
  );
}
