import { fileChangeDataSchema } from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/StatusBadge';
import { Hunk } from './diff-view';

export interface FileChangeToolResultProps {
  canonical: CanonicalToolResult;
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

/** Native structured diff presentation. The shell owns lifecycle and complete-copy. */
export function FileChangeToolResult({ canonical }: FileChangeToolResultProps) {
  const parsed = fileChangeDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const hunks = data.hunks;
  return (
    <div className="min-w-0 space-y-2" data-result-family="file-change">
      {statusNotice(canonical)}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{data.path}</code>
        <StatusBadge tone="neutral" outline size="xs">{data.operation}</StatusBadge>
        <span className="text-success">+{data.addedLines}</span>
        <span className="text-error">−{data.removedLines}</span>
      </div>
      <div role="table" aria-label={`File ${data.operation} diff for ${data.path}`} className="max-h-96 max-w-full overflow-auto rounded-box border border-base-300/70">
        <div className="min-w-max">
          {hunks.length > 0 ? hunks.map((hunk) => <Hunk key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />) : (
            <div role="row" className="px-3 py-2 text-sm text-base-content/70">No changed lines.</div>
          )}
        </div>
      </div>
    </div>
  );
}
