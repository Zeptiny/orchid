/**
 * Pure content transformation engine that applies parsed patch chunks to file
 * content in memory. No filesystem I/O.
 *
 * Ported from codex-rs/apply-patch/src/lib.rs (derive_new_contents_from_chunks,
 * compute_replacements, apply_replacements).
 */

import type { UpdateFileChunk, HunkLineOp } from './apply-patch-parser';
import { seekSequenceWithMeta, findContextHint } from './apply-patch-match';

// ── Error ──────────────────────────────────────────────────────────────────

export class ApplyPatchApplyError extends Error {
  constructor(
    message: string,
    public filePath: string,
    public unmatchedLines?: string[],
  ) {
    super(message);
    this.name = 'ApplyPatchApplyError';
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface Replacement {
  startIndex: number;
  oldLen: number;
  newLines: string[];
}

// ── Line ending detection ──────────────────────────────────────────────────

/**
 * Detect the dominant line ending of a file. Files with mixed endings pick
 * the majority variant; ties default to LF (the patch envelope's native form).
 */
function detectLineEnding(content: string): '\r\n' | '\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

// ── Core algorithm ─────────────────────────────────────────────────────────

function computeReplacements(
  lines: string[],
  chunks: UpdateFileChunk[],
  filePath: string,
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const found = findContextHint(lines, chunk.changeContext, lineIndex);
      if (found === null) {
        throw new ApplyPatchApplyError(
          `Failed to find context '${chunk.changeContext}' in ${filePath}`,
          filePath,
        );
      }
      lineIndex = found;
    }

    if (chunk.lineOps.length === 0) {
      continue;
    }

    const oldLines = chunk.oldLines;

    if (oldLines.length === 0) {
      // Pure addition (no context, no removes) — append at EOF.
      // If the file ends with an empty line, insert before it so the new
      // content lands at the true end of file.
      const insertionIdx = lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length;
      const newSlice = chunk.lineOps
        .filter((op): op is Extract<HunkLineOp, { kind: 'add' }> => op.kind === 'add')
        .map((op) => op.content);
      replacements.push({ startIndex: insertionIdx, oldLen: 0, newLines: newSlice });
      continue;
    }

    // Search for the old lines in the file.
    let pattern = oldLines;
    let lineOpsForBuild = chunk.lineOps;
    let result = seekSequenceWithMeta(lines, pattern, lineIndex, chunk.isEndOfFile);

    // Retry without a trailing empty line in the pattern if the first seek
    // failed — the patch may have included a trailing-newline placeholder
    // that the file (which we already stripped) does not have.
    if (result === null && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, pattern.length - 1);
      // Also drop the trailing context '' from lineOps so the newSlice
      // builder doesn't try to read a non-existent file line. Remove ops
      // don't contribute to newSlice so trimming them is harmless either way.
      if (lineOpsForBuild.length > 0) {
        const lastOp = lineOpsForBuild[lineOpsForBuild.length - 1];
        if (lastOp.kind === 'context' && lastOp.content === '') {
          lineOpsForBuild = lineOpsForBuild.slice(0, lineOpsForBuild.length - 1);
        }
      }
      result = seekSequenceWithMeta(lines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (result === null) {
      // F2: when the EOF anchor is set and the pattern isn't found at the
      // end-of-file position, surface a specific EOF error rather than a
      // generic match failure.
      if (chunk.isEndOfFile) {
        throw new ApplyPatchApplyError(
          `*** End of File anchor failed in ${filePath}: pattern not found at end of file.\nUnmatched lines:\n${oldLines.join('\n')}`,
          filePath,
          oldLines,
        );
      }
      throw new ApplyPatchApplyError(
        `Failed to find expected lines in ${filePath}:\n${oldLines.join('\n')}`,
        filePath,
        oldLines,
      );
    }

    // F2: enforce *** End of File anchor — the matched region must end at
    // the file's last line. If not, fail rather than silently applying to
    // a non-EOF location.
    if (chunk.isEndOfFile && result.index + pattern.length < lines.length) {
      throw new ApplyPatchApplyError(
        `*** End of File anchor failed in ${filePath}: match ends at line ${result.index + pattern.length} but file has ${lines.length} lines.`,
        filePath,
        oldLines,
      );
    }

    // F6: if the match is ambiguous AND the chunk has no @@ context header,
    // error with disambiguation guidance. When a @@ header is present the
    // user has already attempted to disambiguate, so we honor the first
    // match.
    if (result.ambiguous && chunk.changeContext === null) {
      throw new ApplyPatchApplyError(
        `Hunk matches multiple locations in ${filePath}. Add a @@ header with the enclosing class or function name to disambiguate.\nUnmatched lines:\n${oldLines.join('\n')}`,
        filePath,
        oldLines,
      );
    }

    const found = result.index;

    // F1: build the replacement slice from lineOps. For context lines, use
    // the file's original content (preserving whitespace) instead of the
    // patch's version. Add lines use the patch's content. Remove lines are
    // dropped from the output.
    const newSlice: string[] = [];
    let fileIdx = found;
    for (const op of lineOpsForBuild) {
      if (op.kind === 'context') {
        // Use the file's version of this line — preserves trailing/leading
        // whitespace that fuzzy matching would otherwise overwrite.
        newSlice.push(lines[fileIdx]);
        fileIdx++;
      } else if (op.kind === 'remove') {
        fileIdx++;
      } else {
        newSlice.push(op.content);
      }
    }

    replacements.push({ startIndex: found, oldLen: pattern.length, newLines: newSlice });
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a.startIndex - b.startIndex);
  return replacements;
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines];

  for (let i = replacements.length - 1; i >= 0; i--) {
    const { startIndex, oldLen, newLines } = replacements[i];

    result.splice(startIndex, oldLen, ...newLines);
  }

  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Apply update chunks to file content, computing the new content.
 * Pure content transformation — no filesystem I/O.
 *
 * Throws ApplyPatchApplyError on match failure, EOF anchor failure, or
 * ambiguous match without a @@ disambiguation header.
 */
export function applyChunksToContent(
  originalContent: string,
  chunks: UpdateFileChunk[],
  filePath: string,
): string {
  // F4: detect dominant line ending and preserve it on output. The patch
  // envelope uses LF internally; we normalize to LF for processing, then
  // restore the original ending on join.
  const lineEnding = detectLineEnding(originalContent);
  const normalizedContent = lineEnding === '\r\n'
    ? originalContent.replace(/\r\n/g, '\n')
    : originalContent;

  const lines = normalizedContent.split('\n');
  // F7: track whether the original had a trailing newline before stripping it.
  // An empty file is treated as having a trailing newline so that pure
  // additions produce conventional text-file output.
  const hadTrailingNewline =
    normalizedContent.length === 0 ||
    normalizedContent[normalizedContent.length - 1] === '\n';
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const replacements = computeReplacements(lines, chunks, filePath);
  const newLines = applyReplacements(lines, replacements);

  // F7: only re-add a trailing newline if the original had one. Do NOT
  // synthesize a trailing newline for files that lacked one.
  if (hadTrailingNewline && (newLines.length === 0 || newLines[newLines.length - 1] !== '')) {
    newLines.push('');
  }

  return newLines.join(lineEnding);
}
