import {
  fileWriteDataSchema,
  type FileWriteData,
} from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { StatusBadge } from '../ui/StatusBadge';

export interface FileWriteToolResultProps {
  canonical: CanonicalToolResult;
}

function statusNotice(canonical: CanonicalToolResult) {
  if (canonical.status === 'error') {
    return <div role="alert" className="alert alert-error alert-soft mb-2 text-sm">{canonical.error.message}</div>;
  }
  if (canonical.status === 'cancelled') {
    return <div role="status" className="alert alert-warning alert-soft mb-2 text-sm">Write was cancelled before completion.</div>;
  }
  if (canonical.status === 'empty') {
    return <div role="status" className="alert alert-info alert-soft mb-2 text-sm">No file content was written.</div>;
  }
  return null;
}

export function writeMetadata(data: FileWriteData): string {
  return `${data.operation} · ${data.byteCount} bytes · ${data.lineCount} lines`;
}

/** Content-first write presentation; it intentionally does not synthesize a full-file diff. */
export function FileWriteToolResult({ canonical }: FileWriteToolResultProps) {
  const parsed = fileWriteDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  return (
    <div className="min-w-0 space-y-2" data-result-family="file-write">
      {statusNotice(canonical)}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{data.path}</code>
        <StatusBadge tone="neutral" outline size="xs">{data.operation}</StatusBadge>
        <span className="text-base-content/70">{writeMetadata(data)}</span>
      </div>
      <div className="max-w-full overflow-x-auto rounded-box border border-base-300/70">
        <pre className="m-0 min-w-max whitespace-pre p-3 font-mono text-xs leading-5 text-base-content/85" aria-label={`Resulting content of ${data.path}`}>
          {data.content || <span className="text-base-content/60">(empty file)</span>}
        </pre>
      </div>
    </div>
  );
}
