import {
  applyPatchResultDataSchema,
  type ApplyPatchFileResult,
} from '../../../shared/types/tool-result-apply-patch';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/StatusBadge';
import { Hunk } from './diff-view';

export interface ApplyPatchToolResultProps {
  canonical: CanonicalToolResult;
  toolName: string;
  isLive?: boolean;
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
