import {
  applyPatchResultDataSchema,
  type ApplyPatchFileResult,
} from '../../../shared/types/tool-result-apply-patch';
import type {
  FileChangeHunk,
  FileChangeLine,
} from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/StatusBadge';

export interface ApplyPatchToolResultProps {
  canonical: CanonicalToolResult;
  toolName: string;
  isLive?: boolean;
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

function operationTone(operation: ApplyPatchFileResult['operation']): 'success' | 'info' | 'warning' {
  if (operation === 'create') return 'success';
  if (operation === 'delete') return 'warning';
  return 'info';
}

function FileSection({ file }: { file: ApplyPatchFileResult }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{file.path}</code>
        <StatusBadge tone={operationTone(file.operation)} outline size="xs">{file.operation}</StatusBadge>
        {file.movePath && (
          <span className="text-base-content/60">→ <code className="text-xs">{file.movePath}</code></span>
        )}
        {file.status === 'error' && <StatusBadge tone="error" size="xs">failed</StatusBadge>}
      </div>
      {file.status === 'error' && file.error && (
        <Alert tone="error" variant="soft" className="text-sm">{file.error.message}</Alert>
      )}
      {file.fileChange && file.fileChange.hunks.length > 0 && (
        <div role="table" aria-label={`File ${file.operation} diff for ${file.path}`} className="max-h-96 max-w-full overflow-auto rounded-box border border-base-300/70">
          <div className="min-w-max">
            {file.fileChange.hunks.map((hunk) => <Hunk key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Multi-file patch result presentation with per-file diffs and error reporting. */
export function ApplyPatchToolResult({ canonical }: ApplyPatchToolResultProps) {
  const parsed = applyPatchResultDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;

  const summaryParts: string[] = [];
  if (data.added > 0) summaryParts.push(`${data.added} added`);
  if (data.modified > 0) summaryParts.push(`${data.modified} modified`);
  if (data.deleted > 0) summaryParts.push(`${data.deleted} deleted`);
  if (data.failed > 0) summaryParts.push(`${data.failed} failed`);

  return (
    <div className="min-w-0 space-y-3" data-result-family="apply-patch">
      {canonical.status === 'error' && (
        <Alert tone="error" variant="soft" className="text-sm">{canonical.error.message}</Alert>
      )}
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-base-content/70">
        <span className="font-medium text-base-content">{data.files.length} file{data.files.length === 1 ? '' : 's'}</span>
        {summaryParts.length > 0 && <span>· {summaryParts.join(', ')}</span>}
      </div>
      <div className="space-y-3">
        {data.files.map((file) => <FileSection key={file.path} file={file} />)}
      </div>
    </div>
  );
}
