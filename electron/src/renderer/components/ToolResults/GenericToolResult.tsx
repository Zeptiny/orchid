import type { CanonicalToolResult, JsonValue } from '../../../shared/types/tool-result';
import { genericToolResultDataSchema } from '../../../shared/types/tool-result';
import { StatusBadge } from '../ui/StatusBadge';

const MAX_DEPTH = 8;

export interface GenericToolResultProps {
  canonical: CanonicalToolResult;
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function JsonValueView({ value, depth = 0 }: { value: JsonValue; depth?: number }) {
  if (depth >= MAX_DEPTH) {
    return <span className="text-base-content/60">… nested data (expand in copy)</span>;
  }
  if (value === null || typeof value !== 'object') {
    return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
  }
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  return (
    <div className="pl-3 border-l border-base-300/60 space-y-0.5 min-w-0">
      {entries.map(([key, entry]) => (
        <div key={key} className="min-w-0 break-words">
          <span className="text-base-content/60">{Array.isArray(value) ? `[${key}]` : `${key}:`}</span>{' '}
          <JsonValueView value={entry as JsonValue} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

/** Safe generic fallback: strings are text and structured values are inert JSON. */
export function GenericToolResult({ canonical }: GenericToolResultProps) {
  const parsed = genericToolResultDataSchema.safeParse(canonical.data);
  const value = parsed.success ? parsed.data.value : canonical.data;
  const origin = parsed.success ? parsed.data.origin : undefined;
  const isText = typeof value === 'string';

  return (
    <div className="min-w-0 space-y-2" data-result-family="generic">
      {origin && (origin.kind === 'dynamic' || origin.kind === 'mcp') && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-base-content/70">
          <StatusBadge tone="neutral" outline size="xs">{origin.kind}</StatusBadge>
          <span className="break-all">{origin.name}</span>
          <span className="sr-only">Tool-provided data is displayed as inert text.</span>
        </div>
      )}
      {isText ? (
        <pre className="orchid-tool-result-selectable m-0 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-sm text-base-content/80">{pretty(value)}</pre>
      ) : (
        <div className="orchid-tool-result-selectable max-h-96 max-w-full overflow-auto whitespace-normal break-words font-mono text-sm text-base-content/80">
          <JsonValueView value={value as JsonValue} />
        </div>
      )}
    </div>
  );
}
