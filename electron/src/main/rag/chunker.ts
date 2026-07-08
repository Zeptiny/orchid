/**
 * Chunker — splits source code into overlapping chunks respecting blank-line break points.
 *
 * Ported from Python `src/orchid/rag/chunker.py`.
 *
 * - Binary detection (null bytes → skip)
 * - Empty / whitespace-only → skip
 * - Single chunk if content ≤ chunk_size
 * - Overlapping windows with natural break point adjustment
 * - Min chunk guard (chunk_size // 4)
 */
import { getConfig } from '../config/loader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Chunk {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

function isBinary(content: string): boolean {
  return content.includes('\0');
}

// ---------------------------------------------------------------------------
// Line offset helpers
// ---------------------------------------------------------------------------

/**
 * Cumulative char offset at the start of each line.
 * lineOffsets[i] = char position of line i.
 */
function lineBreakOffsets(lines: string[]): number[] {
  const offsets: number[] = [];
  let cumulative = 0;
  for (const line of lines) {
    offsets.push(cumulative);
    cumulative += line.length;
  }
  return offsets;
}

/**
 * Find natural break points (blank lines) for smarter chunking.
 */
function findBreakPoints(lines: string[]): number[] {
  const breaks: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      breaks.push(i);
    }
  }
  return breaks;
}

/**
 * Pick the closest break point to targetLine that is strictly after afterLine.
 */
function pickBreakAfter(
  breaks: number[],
  afterLine: number,
  targetLine: number,
): number | null {
  const candidates = breaks.filter((b) => b > afterLine);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, b) =>
    Math.abs(b - targetLine) < Math.abs(best - targetLine) ? b : best,
  );
}

/**
 * Return the 0-indexed line number for a character position (O(log N) via binary search).
 */
function lineAtChar(lineOffsets: number[], charPos: number): number {
  // bisect_right: find first index where lineOffsets[idx] > charPos
  let lo = 0;
  let hi = lineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineOffsets[mid] <= charPos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return Math.max(lo - 1, 0);
}

/**
 * Return the character position at the start of a line index (O(1)).
 */
function charAtLine(lineOffsets: number[], lineIdx: number): number {
  if (lineIdx < 0) return 0;
  if (lineIdx >= lineOffsets.length) {
    return lineOffsets.length > 0 ? lineOffsets[lineOffsets.length - 1]! : 0;
  }
  return lineOffsets[lineIdx]!;
}

// ---------------------------------------------------------------------------
// Main chunking function
// ---------------------------------------------------------------------------

/**
 * Split source code into overlapping chunks.
 *
 * Chunks respect natural break points (blank lines) when possible.
 * Binary files and empty files return empty lists.
 *
 * @param filePath - Relative path of the file (used in Chunk metadata)
 * @param content  - Full file content
 * @param chunkSize    - Maximum chunk size in characters (default from config)
 * @param chunkOverlap - Overlap between consecutive chunks (default from config)
 */
export function chunkFile(
  filePath: string,
  content: string,
  chunkSize?: number,
  chunkOverlap?: number,
): Chunk[] {
  const cfg = getConfig();
  const size = chunkSize ?? cfg.rag.chunk_size;
  const overlap = chunkOverlap ?? cfg.rag.chunk_overlap;

  if (isBinary(content) || content.trim() === '') {
    return [];
  }

  const lines = content.split(/(?<=\n)/); // keepends=True equivalent
  const totalChars = content.length;

  // Single chunk if content fits
  if (totalChars <= size) {
    return [
      {
        filePath,
        content,
        startLine: 1,
        endLine: lines.length,
      },
    ];
  }

  if (overlap >= size) {
    throw new Error(
      `chunk_overlap (${overlap}) must be less than chunk_size (${size})`,
    );
  }

  const breakPoints = findBreakPoints(lines);
  const lineOffsets = lineBreakOffsets(lines);
  const chunks: Chunk[] = [];
  let charPos = 0;
  const minChunk = Math.floor(size / 4);

  while (charPos < totalChars) {
    let endChar = Math.min(charPos + size, totalChars);

    // Natural-break adjustment only when the window is not the final tail
    if (endChar < totalChars && breakPoints.length > 0) {
      const currentLine = lineAtChar(lineOffsets, charPos);
      const targetLine = lineAtChar(lineOffsets, endChar);
      const bp = pickBreakAfter(breakPoints, currentLine, targetLine);
      if (bp !== null) {
        const bpChar = charAtLine(lineOffsets, bp);
        if (bpChar > charPos + minChunk && bpChar < endChar) {
          endChar = bpChar;
        }
      }
    }

    if (endChar <= charPos) {
      endChar = Math.min(charPos + size, totalChars);
    }

    const chunkText = content.slice(charPos, endChar);
    const startLine = lineAtChar(lineOffsets, charPos) + 1;
    const endCharForLine =
      endChar > 0 && content[endChar - 1] === '\n' ? endChar - 1 : endChar;
    const endLine = lineAtChar(lineOffsets, endCharForLine) + 1;

    chunks.push({
      filePath,
      content: chunkText,
      startLine,
      endLine,
    });

    if (endChar >= totalChars) break;

    charPos += Math.max(1, endChar - charPos - overlap);
  }

  return chunks;
}
