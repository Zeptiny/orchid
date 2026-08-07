/**
 * Pure parser for the OpenAI/Codex `*** Begin Patch` envelope format.
 *
 * Ported from codex-rs/apply-patch/src/parser.rs and streaming_parser.rs.
 * No filesystem I/O — string in, structured hunks out.
 */

// ── Markers ────────────────────────────────────────────────────────────────

export const BEGIN_PATCH_MARKER = '*** Begin Patch';
export const END_PATCH_MARKER = '*** End Patch';
export const ADD_FILE_MARKER = '*** Add File: ';
export const DELETE_FILE_MARKER = '*** Delete File: ';
export const UPDATE_FILE_MARKER = '*** Update File: ';
export const MOVE_TO_MARKER = '*** Move to: ';
export const EOF_MARKER = '*** End of File';
export const CHANGE_CONTEXT_MARKER = '@@ ';
export const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Ordered hunk line operation. Context lines are matched fuzzily against the
 * file but the file's version is preserved in the output; add/remove lines
 * alter content.
 */
export type HunkLineOp =
  | { kind: 'context'; content: string }
  | { kind: 'add'; content: string }
  | { kind: 'remove'; content: string };

export interface UpdateFileChunk {
  changeContext: string | null;
  /** Ordered list of context/add/remove operations. Source of truth for output. */
  lineOps: HunkLineOp[];
  /** Derived: context + remove contents, in order. Used for matching. */
  oldLines: string[];
  /** Derived: context + add contents, in order. Used for tests/projection. */
  newLines: string[];
  isEndOfFile: boolean;
}

export type PatchHunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath: string | null; chunks: UpdateFileChunk[] };

export interface ParseResult {
  hunks: PatchHunk[];
  patch: string;
}

export class ParseError extends Error {
  constructor(message: string, public lineNumber?: number) {
    super(message);
    this.name = 'ParseError';
  }
}

// ── Heredoc stripping ──────────────────────────────────────────────────────

function stripHeredoc(lines: string[]): string[] {
  if (lines.length < 4) return lines;

  const first = lines[0];
  const last = lines[lines.length - 1];

  const isHeredocStart =
    first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"';

  if (isHeredocStart && last.endsWith('EOF')) {
    return lines.slice(1, lines.length - 1);
  }

  return lines;
}

function stripCodeFence(lines: string[]): string[] {
  if (lines.length < 2) return lines;

  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();

  if (first.startsWith('```') && last.startsWith('```')) {
    return lines.slice(1, lines.length - 1);
  }

  return lines;
}

const FILE_OPERATION_PREFIXES = [ADD_FILE_MARKER, DELETE_FILE_MARKER, UPDATE_FILE_MARKER];

function hasFileOperationHeader(lines: string[]): boolean {
  return lines.some((line) => {
    const trimmed = line.trimStart();
    return FILE_OPERATION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  });
}

/**
 * Models sometimes drop the envelope markers (most commonly the opening
 * `*** Begin Patch`). When the body clearly contains at least one file
 * operation header, synthesize any missing boundary marker instead of
 * rejecting the whole patch. Without a file operation header the input is
 * left untouched so genuinely malformed input still reports the boundary
 * error.
 */
function repairEnvelope(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  if (!hasFileOperationHeader(lines)) return lines;

  let repaired = lines;
  if (repaired[0].trim() !== BEGIN_PATCH_MARKER) {
    repaired = [BEGIN_PATCH_MARKER, ...repaired];
  }
  if (repaired[repaired.length - 1].trim() !== END_PATCH_MARKER) {
    repaired = [...repaired, END_PATCH_MARKER];
  }
  return repaired;
}

// ── Boundary validation ────────────────────────────────────────────────────

function validateBoundaries(lines: string[]): void {
  const first = lines.length > 0 ? lines[0].trim() : '';
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : '';

  if (first !== BEGIN_PATCH_MARKER) {
    throw new ParseError("The first line of the patch must be '*** Begin Patch'");
  }
  if (last !== END_PATCH_MARKER) {
    throw new ParseError("The last line of the patch must be '*** End Patch'");
  }
}

// ── Chunk helpers ──────────────────────────────────────────────────────────

function newChunk(changeContext: string | null): UpdateFileChunk {
  return { changeContext, lineOps: [], oldLines: [], newLines: [], isEndOfFile: false };
}

function ensureChunk(chunks: UpdateFileChunk[]): UpdateFileChunk {
  if (chunks.length === 0) {
    chunks.push(newChunk(null));
  }
  return chunks[chunks.length - 1];
}

interface ChangeContextMarker {
  /** null for a bare `@@`; otherwise the hint text after the marker. */
  hint: string | null;
}

/**
 * Lenient `@@` change-context detection. Hunk content lines must always start
 * with ' ', '+', or '-', so a line starting with `@@` at column 0 is a
 * context marker. This tolerates the common model slip of `@@name` (missing
 * space after the marker). Leading whitespace is NOT trimmed: a line with any
 * leading space is a content line, which keeps context lines whose content
 * starts with `@@` (e.g. ` @@keyframes`) unambiguous. Misreading a content
 * line as a chunk boundary would silently corrupt output, so we prefer that
 * an indented `@@` header fail loudly instead.
 */
function isGitUnifiedHeader(hint: string): boolean {
  return /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@/.test(hint);
}

function matchChangeContextMarker(
  line: string,
  lineNumber?: number,
): ChangeContextMarker | null {
  if (line === '' || line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
    return null;
  }
  if (!line.startsWith('@@')) return null;
  const hint = line.slice(2).trim();
  if (hint.length > 0 && isGitUnifiedHeader(hint)) {
    throw new ParseError(
      `Invalid hunk header '${line}': git-style "@@ -a,b +c,d @@" is not supported. Use "@@" or "@@ <symbol>" with 3 verbatim context lines.`,
      lineNumber,
    );
  }
  return { hint: hint.length > 0 ? hint : null };
}

// ── Parser ─────────────────────────────────────────────────────────────────

type ParserMode = 'started' | 'add' | 'delete' | 'update';

interface UpdateState {
  hunk: Extract<PatchHunk, { type: 'update' }>;
  hunkLineNumber: number;
}

export function parsePatch(input: string): ParseResult {
  let lines = input.trim().split('\n').map((l) => l.replace(/\r$/, ''));
  lines = stripHeredoc(lines);
  lines = stripCodeFence(lines);
  lines = repairEnvelope(lines);
  validateBoundaries(lines);

  const patch = lines.join('\n');
  const hunks: PatchHunk[] = [];
  let mode: ParserMode = 'started';
  let updateState: UpdateState | null = null;

  function finalizeUpdateHunk(lineNum: number): void {
    if (!updateState) return;
    const { hunk, hunkLineNumber } = updateState;
    if (hunk.chunks.length === 0) {
      throw new ParseError(
        `Update file hunk for path '${hunk.path}' is empty`,
        hunkLineNumber,
      );
    }
    const lastChunk = hunk.chunks[hunk.chunks.length - 1];
    if (lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
      throw new ParseError('Update hunk does not contain any lines', lineNum);
    }
    updateState = null;
  }

  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;
    const headerLine = mode === 'update' ? line.replace(/\s+$/, '') : trimmed;

    if (headerLine === END_PATCH_MARKER) {
      throw new ParseError(
        `'${END_PATCH_MARKER}' must only appear as the last line of the patch`,
        lineNum,
      );
    }

    if (headerLine.startsWith(ADD_FILE_MARKER)) {
      finalizeUpdateHunk(lineNum);
      const path = headerLine.slice(ADD_FILE_MARKER.length);
      hunks.push({ type: 'add', path, contents: '' });
      mode = 'add';
      continue;
    }

    if (headerLine.startsWith(DELETE_FILE_MARKER)) {
      finalizeUpdateHunk(lineNum);
      const path = headerLine.slice(DELETE_FILE_MARKER.length);
      hunks.push({ type: 'delete', path });
      mode = 'delete';
      continue;
    }

    if (headerLine.startsWith(UPDATE_FILE_MARKER)) {
      finalizeUpdateHunk(lineNum);
      const path = headerLine.slice(UPDATE_FILE_MARKER.length);
      const hunk: Extract<PatchHunk, { type: 'update' }> = {
        type: 'update',
        path,
        movePath: null,
        chunks: [],
      };
      hunks.push(hunk);
      updateState = { hunk, hunkLineNumber: lineNum };
      mode = 'update';
      continue;
    }

    if (mode === 'add') {
      const lastHunk = hunks[hunks.length - 1];
      if (lastHunk && lastHunk.type === 'add' && line.startsWith('+')) {
        lastHunk.contents += line.slice(1) + '\n';
        continue;
      }
      throw new ParseError(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        lineNum,
      );
    }

    if (mode === 'delete') {
      throw new ParseError(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        lineNum,
      );
    }

    if (mode === 'update' && updateState) {
      const { hunk } = updateState;
      const updateLine = line.replace(/\s+$/, '');

      if (
        hunk.chunks.length === 0 &&
        hunk.movePath === null &&
        updateLine.startsWith(MOVE_TO_MARKER)
      ) {
        hunk.movePath = updateLine.slice(MOVE_TO_MARKER.length);
        continue;
      }

      const lastChunk = hunk.chunks.length > 0 ? hunk.chunks[hunk.chunks.length - 1] : null;
      const contextMarker = matchChangeContextMarker(updateLine, lineNum);

      if (lastChunk && lastChunk.isEndOfFile) {
        if (updateLine === '') continue;
        if (!contextMarker) {
          throw new ParseError(
            `Expected update hunk to start with a @@ context marker, got: '${line}'`,
            lineNum,
          );
        }
      }

      if (contextMarker) {
        if (contextMarker.hint === null) {
          // Bare `@@`: start a new chunk unless the current one has no lines
          // yet. A hint-only chunk keeps its hint — a bare `@@` following a
          // stacked `@@ hint` must not wipe the disambiguation context.
          if (
            !lastChunk ||
            lastChunk.oldLines.length > 0 ||
            lastChunk.newLines.length > 0
          ) {
            hunk.chunks.push(newChunk(null));
          }
          continue;
        }

        const ctx = contextMarker.hint;
        if (lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
          if (lastChunk.changeContext !== null) {
            hunk.chunks.push(newChunk(ctx));
          } else {
            lastChunk.changeContext = ctx;
          }
        } else {
          hunk.chunks.push(newChunk(ctx));
        }
        continue;
      }

      if (updateLine === EOF_MARKER) {
        if (
          lastChunk &&
          lastChunk.oldLines.length === 0 &&
          lastChunk.newLines.length === 0
        ) {
          throw new ParseError('Update hunk does not contain any lines', lineNum);
        }
        if (lastChunk) {
          lastChunk.isEndOfFile = true;
        }
        continue;
      }

      if (line === '') {
        const chunk = ensureChunk(hunk.chunks);
        chunk.lineOps.push({ kind: 'context', content: '' });
        chunk.oldLines.push('');
        chunk.newLines.push('');
        continue;
      }

      if (line.startsWith(' ')) {
        const chunk = ensureChunk(hunk.chunks);
        const content = line.slice(1);
        chunk.lineOps.push({ kind: 'context', content });
        chunk.oldLines.push(content);
        chunk.newLines.push(content);
        continue;
      }

      if (line.startsWith('+')) {
        const chunk = ensureChunk(hunk.chunks);
        const content = line.slice(1);
        chunk.lineOps.push({ kind: 'add', content });
        chunk.newLines.push(content);
        continue;
      }

      if (line.startsWith('-')) {
        const chunk = ensureChunk(hunk.chunks);
        const content = line.slice(1);
        chunk.lineOps.push({ kind: 'remove', content });
        chunk.oldLines.push(content);
        continue;
      }

      if (
        lastChunk &&
        (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)
      ) {
        const prefix = line.length > 0 ? line[0] : '';
        throw new ParseError(
          `Invalid hunk line prefix '${prefix}' in '${line}'. Lines must start with ' ' (context), '+' (add), or '-' (remove). Use @@ to start a new hunk.`,
          lineNum,
        );
      }

      throw new ParseError(
        `Invalid hunk line prefix '${line.length > 0 ? line[0] : ''}' in '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNum,
      );
    }

    if (mode === 'started') {
      throw new ParseError(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        lineNum,
      );
    }
  }

  finalizeUpdateHunk(lines.length);

  return { hunks, patch };
}
