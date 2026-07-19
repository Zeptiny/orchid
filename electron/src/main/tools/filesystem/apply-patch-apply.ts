/**
 * Pure content transformation engine that applies parsed patch chunks to file
 * content in memory. No filesystem I/O.
 *
 * Ported from codex-rs/apply-patch/src/lib.rs (derive_new_contents_from_chunks,
 * compute_replacements, apply_replacements).
 */

import type { UpdateFileChunk } from './apply-patch-parser';
import { seekSequence, findContextHint } from './apply-patch-match';

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

    if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
      continue;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx = lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length;
      replacements.push({ startIndex: insertionIdx, oldLen: 0, newLines: chunk.newLines });
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, pattern.length - 1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, newSlice.length - 1);
      }
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found !== null) {
      replacements.push({ startIndex: found, oldLen: pattern.length, newLines: newSlice });
      lineIndex = found + pattern.length;
    } else {
      throw new ApplyPatchApplyError(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`,
        filePath,
        chunk.oldLines,
      );
    }
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
 * Throws ApplyPatchApplyError on match failure.
 */
export function applyChunksToContent(
  originalContent: string,
  chunks: UpdateFileChunk[],
  filePath: string,
): string {
  const lines = originalContent.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const replacements = computeReplacements(lines, chunks, filePath);
  const newLines = applyReplacements(lines, replacements);

  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines.push('');
  }

  return newLines.join('\n');
}
