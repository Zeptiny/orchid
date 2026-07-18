/**
 * Structured file changes backed by the maintained `diff` implementation.
 *
 * The result of this module is persisted as canonical filesystem data.  The
 * unified-diff text used by agent projections and copy actions is derived from
 * the same hunks, so coordinates and statistics cannot drift between views.
 */
import { structuredPatch } from 'diff';
import type {
  FileChangeData,
  FileChangeHunk,
  FileChangeLine,
} from '../../../shared/types/tool-result-filesystem';
import { fileChangeDataSchema } from '../../../shared/types/tool-result-filesystem';

type StructuredPatch = ReturnType<typeof structuredPatch>;
type StructuredPatchFactory = typeof structuredPatch;

let patchFactory: StructuredPatchFactory = structuredPatch;

/** Test seam for proving that pre-mutation diff failures leave files intact. */
export function _setStructuredPatchForTests(factory: StructuredPatchFactory | null): void {
  patchFactory = factory ?? structuredPatch;
}

function stripPatchCarriageReturn(content: string): string {
  // diff's line-oriented algorithm retains the CR from CRLF input.  CR is a
  // line terminator, not part of the canonical line content.
  return content.endsWith('\r') ? content.slice(0, -1) : content;
}

function sourceLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(stripPatchCarriageReturn);
}

function parseHunk(
  patchHunk: NonNullable<StructuredPatch>['hunks'][number],
): FileChangeHunk {
  let oldLine = patchHunk.oldStart;
  let newLine = patchHunk.newStart;
  const lines: FileChangeLine[] = [];

  for (const patchLine of patchHunk.lines) {
    // jsdiff emits this marker for a side without a final newline.  It is
    // metadata, not a source line, and is represented by resultingContent.
    if (patchLine === '\\ No newline at end of file') continue;
    if (patchLine.length === 0) {
      throw new Error('Structured diff returned an empty hunk line');
    }

    const kind = patchLine[0];
    const content = stripPatchCarriageReturn(patchLine.slice(1));
    if (kind === ' ') {
      lines.push({
        kind: 'context',
        content,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    } else if (kind === '-') {
      lines.push({ kind: 'remove', content, oldLineNumber: oldLine });
      oldLine += 1;
    } else if (kind === '+') {
      lines.push({ kind: 'add', content, newLineNumber: newLine });
      newLine += 1;
    } else {
      throw new Error(`Structured diff returned an unknown hunk line prefix: ${kind}`);
    }
  }

  const oldLines = lines.filter((line) => line.kind !== 'add').length;
  const newLines = lines.filter((line) => line.kind !== 'remove').length;
  if (
    oldLines !== patchHunk.oldLines
    || newLines !== patchHunk.newLines
    || oldLine !== patchHunk.oldStart + patchHunk.oldLines
    || newLine !== patchHunk.newStart + patchHunk.newLines
  ) {
    throw new Error('Structured diff hunk coordinates/counts are inconsistent');
  }

  return {
    oldStart: patchHunk.oldStart,
    oldLines: patchHunk.oldLines,
    newStart: patchHunk.newStart,
    newLines: patchHunk.newLines,
    lines,
  };
}

/** Build canonical structured change facts before any file mutation. */
export function buildStructuredFileChange(opts: {
  path: string;
  operation: FileChangeData['operation'];
  oldContent: string;
  newContent: string;
}): FileChangeData {
  const patch = patchFactory(
    opts.path,
    opts.path,
    opts.oldContent,
    opts.newContent,
    undefined,
    undefined,
    { context: 3 },
  );
  if (!patch) throw new Error('Structured diff did not produce a patch');

  const hunks = patch.hunks.map(parseHunk);
  const oldLines = sourceLines(opts.oldContent);
  const newLines = sourceLines(opts.newContent);
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  for (const hunk of hunks) {
    if (hunk.oldStart - 1 < previousOldEnd || hunk.newStart - 1 < previousNewEnd) {
      throw new Error('Structured diff hunks overlap or are out of order');
    }
    let oldIndex = hunk.oldStart - 1;
    let newIndex = hunk.newStart - 1;
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        if (oldLines[oldIndex] !== line.content || newLines[newIndex] !== line.content) {
          throw new Error('Structured diff context does not match source content');
        }
        oldIndex += 1;
        newIndex += 1;
      } else if (line.kind === 'remove') {
        if (oldLines[oldIndex] !== line.content) {
          throw new Error('Structured diff removal does not match source content');
        }
        oldIndex += 1;
      } else {
        if (newLines[newIndex] !== line.content) {
          throw new Error('Structured diff addition does not match resulting content');
        }
        newIndex += 1;
      }
    }
    if (
      oldIndex !== hunk.oldStart - 1 + hunk.oldLines
      || newIndex !== hunk.newStart - 1 + hunk.newLines
    ) {
      throw new Error('Structured diff hunk range does not match its lines');
    }
    previousOldEnd = oldIndex;
    previousNewEnd = newIndex;
  }
  const addedLines = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'add').length,
    0,
  );
  const removedLines = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'remove').length,
    0,
  );

  const data: FileChangeData = {
    path: opts.path,
    operation: opts.operation,
    hunks,
    addedLines,
    removedLines,
    resultingContent: opts.newContent,
  };

  // Validate the complete candidate facts before returning them to a caller
  // that may mutate the source file.  This also catches malformed test seams.
  return fileChangeDataSchema.parse(data);
}

/** Serialize canonical hunks as complete unified-diff text. */
export function serializeStructuredDiff(
  data: Pick<FileChangeData, 'path' | 'operation' | 'hunks'>,
  labels?: { oldPath?: string; newPath?: string },
): string {
  const oldPath = labels?.oldPath ?? (data.operation === 'create' ? '/dev/null' : data.path);
  const newPath = labels?.newPath ?? (data.operation === 'delete' ? '/dev/null' : data.path);
  const lines = [`--- ${oldPath}`, `+++ ${newPath}`];
  for (const hunk of data.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      lines.push(`${prefix}${line.content}`);
    }
  }
  return lines.join('\n');
}

export function countStructuredDiffChanges(
  data: Pick<FileChangeData, 'addedLines' | 'removedLines'>,
): { added: number; removed: number } {
  return { added: data.addedLines, removed: data.removedLines };
}
