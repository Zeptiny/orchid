import { useState } from 'react';
import {
  fileChangeDataSchema,
  type FileChangeData,
  type FileChangeHunk,
  type FileChangeLine,
} from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { ResultPager } from './ResultPager';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/StatusBadge';

export interface FileChangeToolResultProps {
  canonical: CanonicalToolResult;
}

const HUNK_PAGE_SIZE = 4;

/** Return the hunk window without changing the canonical data or its ordering. */
export function visibleFileChangeHunks(
  data: FileChangeData,
  page: number,
  pageSize = HUNK_PAGE_SIZE,
): readonly FileChangeHunk[] {
  const start = Math.max(0, page) * pageSize;
  return data.hunks.slice(start, start + pageSize);
}

function statusNotice(canonical: CanonicalToolResult) {
  if (canonical.status === 'error') {
    return <Alert tone="error" variant="soft" className="mb-2 text-sm">{canonical.error.message}</Alert>;
  }
  if (canonical.status === 'cancelled') {
    return <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">Change was cancelled before completion.</Alert>;
  }
  if (canonical.status === 'empty') {
    return <Alert tone="info" variant="soft" role="status" className="mb-2 text-sm">No file changes were produced.</Alert>;
  }
  return null;
}

function rowLabel(line: FileChangeLine): string {
  if (line.kind === 'add') return `Added line ${line.newLineNumber}`;
  if (line.kind === 'remove') return `Removed line ${line.oldLineNumber}`;
  return `Unchanged line ${line.newLineNumber}`;
}

function lineClass(kind: FileChangeLine['kind']): string {
  if (kind === 'add') return 'bg-success/10 text-success-content';
  if (kind === 'remove') return 'bg-error/10 text-error-content';
  return 'text-base-content/80';
}

function DiffLine({ line }: { line: FileChangeLine }) {
  const oldNumber = line.kind === 'add' ? '' : String(line.oldLineNumber);
  const newNumber = line.kind === 'remove' ? '' : String(line.newLineNumber);
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
  return (
    <div role="row" aria-label={`${rowLabel(line)}: ${line.content}`} className={`flex min-w-max font-mono text-xs leading-5 ${lineClass(line.kind)}`}>
      <span role="cell" aria-hidden className="w-12 shrink-0 border-r border-base-300/60 px-2 text-right text-base-content/50">{oldNumber}</span>
      <span role="cell" aria-hidden className="w-12 shrink-0 border-r border-base-300/60 px-2 text-right text-base-content/50">{newNumber}</span>
      <span aria-hidden className="w-5 shrink-0 px-1 text-center font-semibold">{marker}</span>
      <span role="cell" className="whitespace-pre px-2">{line.content || ' '}</span>
    </div>
  );
}

function Hunk({ hunk }: { hunk: FileChangeHunk }) {
  return (
    <section role="rowgroup" className="border-b border-base-300/60 last:border-b-0">
      <div role="row" className="min-w-max bg-base-200/60 px-2 py-1 font-mono text-xs text-base-content/70">
        <span role="cell">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
      </div>
      {hunk.lines.map((line, index) => <DiffLine key={`${hunk.oldStart}:${hunk.newStart}:${index}`} line={line} />)}
    </section>
  );
}

/** Native structured diff presentation. The shell owns lifecycle and complete-copy. */
export function FileChangeToolResult({ canonical }: FileChangeToolResultProps) {
  const parsed = fileChangeDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const [page, setPage] = useState(0);
  const hunks = visibleFileChangeHunks(data, page);
  return (
    <div className="min-w-0 space-y-2" data-result-family="file-change">
      {statusNotice(canonical)}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{data.path}</code>
        <StatusBadge tone="neutral" outline size="xs">{data.operation}</StatusBadge>
        <span className="text-success">+{data.addedLines}</span>
        <span className="text-error">−{data.removedLines}</span>
      </div>
      <div role="table" aria-label={`File ${data.operation} diff for ${data.path}`} className="max-w-full overflow-x-auto rounded-box border border-base-300/70">
        <div className="min-w-max">
          {hunks.length > 0 ? hunks.map((hunk) => <Hunk key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />) : (
            <div role="row" className="px-3 py-2 text-sm text-base-content/70">No changed lines.</div>
          )}
        </div>
      </div>
      <ResultPager total={data.hunks.length} page={page} pageSize={HUNK_PAGE_SIZE} onPageChange={setPage} label="diff hunks" />
    </div>
  );
}
