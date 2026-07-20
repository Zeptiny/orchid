import type {
  FileChangeHunk,
  FileChangeLine,
} from '../../../shared/types/tool-result-filesystem';

/** Accessible label describing a diff line's kind and position. */
export function rowLabel(line: FileChangeLine): string {
  if (line.kind === 'add') return `Added line ${line.newLineNumber}`;
  if (line.kind === 'remove') return `Removed line ${line.oldLineNumber}`;
  return `Unchanged line ${line.newLineNumber}`;
}

/** Semantic color classes for a diff line kind. */
export function lineClass(kind: FileChangeLine['kind']): string {
  if (kind === 'add') return 'bg-success/10 text-success-content';
  if (kind === 'remove') return 'bg-error/10 text-error-content';
  return 'text-base-content/80';
}

/** Single diff line row with old/new line numbers, marker, and content. */
export function DiffLine({ line }: { line: FileChangeLine }) {
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

/** Hunk header and its diff lines grouped as a rowgroup. */
export function Hunk({ hunk }: { hunk: FileChangeHunk }) {
  return (
    <section role="rowgroup" className="border-b border-base-300/60 last:border-b-0">
      <div role="row" className="min-w-max bg-base-200/60 px-2 py-1 font-mono text-xs text-base-content/70">
        <span role="cell">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>
      </div>
      {hunk.lines.map((line, index) => <DiffLine key={`${hunk.oldStart}:${hunk.newStart}:${index}`} line={line} />)}
    </section>
  );
}
