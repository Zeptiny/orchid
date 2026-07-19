import { useMemo, useState } from 'react';
import {
  searchResultsDataSchema,
  type GlobResultsData,
  type GrepMatch,
  type GrepResultsData,
  type SearchResultsData,
} from '../../../shared/types/tool-result-filesystem';
import type { CanonicalToolResult } from '../../../shared/types/tool-result';
import { ResultPager } from './ResultPager';
import { Alert } from '../ui/Alert';
import { StatusBadge } from '../ui/StatusBadge';

export interface SearchToolResultProps {
  canonical: CanonicalToolResult;
}

export interface GrepMatchGroup {
  path: string;
  matches: GrepMatch[];
}

/** Group grep rows by path while retaining first-seen file and match order. */
export function groupGrepMatches(data: GrepResultsData): GrepMatchGroup[] {
  const groups = new Map<string, GrepMatchGroup>();
  for (const match of data.matches) {
    const current = groups.get(match.path);
    if (current) current.matches.push(match);
    else groups.set(match.path, { path: match.path, matches: [match] });
  }
  return [...groups.values()];
}

function statusNotice(canonical: CanonicalToolResult, data: SearchResultsData) {
  if (canonical.status === 'error') {
    return <Alert tone="error" variant="soft" className="mb-2 text-sm">{canonical.error.message}</Alert>;
  }
  if (canonical.status === 'cancelled') {
    return <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">Search was cancelled before completion.</Alert>;
  }
  if (canonical.status === 'empty' || data.matches.length === 0) {
    return <Alert tone="info" variant="soft" role="status" className="mb-2 text-sm">No matches found for <code>{data.pattern}</code>.</Alert>;
  }
  if (canonical.status === 'partial' || data.limitReached) {
    return (
      <Alert tone="warning" variant="soft" role="status" className="mb-2 text-sm">
        Search limit reached; showing {data.matches.length}{data.totalMatches !== data.matches.length ? ` of ${data.totalMatches}` : ''} returned match{data.matches.length === 1 ? '' : 'es'}.
        {canonical.status === 'partial' && canonical.retrieval && (
          <span className="ml-1" data-retrieval-kind={canonical.retrieval.kind}>
            Retrieve more with {canonical.retrieval.kind === 'rerun' ? 'the search tool' : 'the stored result'}.
          </span>
        )}
      </Alert>
    );
  }
  return null;
}

function globBody(data: GlobResultsData, page: number) {
  const matches = data.matches.slice(page * 50, (page + 1) * 50);
  return (
    <div role="list" aria-label="Glob matches" className="min-w-0 divide-y divide-base-300/60">
      {matches.map((match, index) => (
        <div role="listitem" key={`${match.path}:${index}`} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-3 py-1.5">
          <code className="min-w-0 flex-1 break-all font-mono text-sm">{match.path}</code>
          <span className="flex shrink-0 flex-wrap gap-x-2 text-xs text-base-content/65">
            {match.size !== undefined && <span>{match.size} bytes</span>}
            {match.modifiedAt && <time dateTime={match.modifiedAt}>{match.modifiedAt}</time>}
          </span>
        </div>
      ))}
    </div>
  );
}

function grepBody(data: GrepResultsData, page: number) {
  const groups = groupGrepMatches(data).slice(page * 20, (page + 1) * 20);
  return (
    <div role="list" aria-label="Grep matches" className="min-w-0 divide-y divide-base-300/60">
      {groups.map((group) => (
        <section key={group.path} role="listitem" className="min-w-0 px-3 py-2">
          <code className="block min-w-0 break-all font-mono text-sm font-semibold">{group.path}</code>
          <ul className="mt-1 min-w-0 space-y-1 border-l border-base-300/70 pl-3">
            {group.matches.map((match, index) => (
              <li key={`${match.path}:${match.line}:${match.column ?? 0}:${index}`} className="min-w-0 font-mono text-xs">
                <span className="mr-2 text-base-content/60" aria-label={`line ${match.line}${match.column === undefined ? '' : `, column ${match.column}`}`}>
                  {match.line}{match.column === undefined ? '' : `:${match.column}`}
                </span>
                <span className="whitespace-pre-wrap break-words text-base-content/85">{match.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Grouped, paged search facts; the shell retains complete-copy semantics. */
export function SearchToolResult({ canonical }: SearchToolResultProps) {
  const parsed = searchResultsDataSchema.safeParse(canonical.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  const [page, setPage] = useState(0);
  const totalItems = data.kind === 'glob' ? data.matches.length : groupGrepMatches(data).length;
  const pageSize = data.kind === 'glob' ? 50 : 20;
  const body = useMemo(() => data.kind === 'glob' ? globBody(data, page) : grepBody(data, page), [data, page]);
  const countLabel = data.kind === 'glob'
    ? `${data.matches.length}${data.totalMatches !== data.matches.length ? ` of ${data.totalMatches}` : ''} matches`
    : `${data.matches.length}${data.totalMatches !== data.matches.length ? ` of ${data.totalMatches}` : ''} matches in ${totalItems} files`;

  return (
    <div className="min-w-0 space-y-2" data-result-family="search-results" data-search-kind={data.kind}>
      {statusNotice(canonical, data)}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <code className="min-w-0 max-w-full break-all text-sm">{data.pattern}</code>
        <StatusBadge tone="neutral" outline size="xs">{data.kind}</StatusBadge>
        <span className="text-base-content/70">{countLabel}</span>
        <span className="min-w-0 max-w-full break-all text-base-content/60">in {data.root}</span>
      </div>
      <div className="min-w-0 max-w-full overflow-x-auto rounded-box border border-base-300/70">{body}</div>
      <ResultPager
        total={totalItems}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        label={data.kind === 'glob' ? 'glob matches' : 'grep result files'}
      />
    </div>
  );
}
