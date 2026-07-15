/**
 * Shared utilities for AST tools.
 *
 * Ported from Python `src/orchid/tools/_xml_utils.py` and `ast.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

export function xmlAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function cdataText(value: string): string {
  return value.replace(/]]>/g, ']]]]><![CDATA[>');
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

export function countDiffChanges(diffText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const result: string[] = [];
  result.push(`--- old/${filePath}`);
  result.push(`+++ new/${filePath}`);

  // LCS-based diff
  const lcs = computeLCS(oldLines, newLines);
  let oi = 0;
  let ni = 0;
  let li = 0;
  const hunkLines: string[] = [];
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  let hunkOldCount = 0;
  let hunkNewCount = 0;

  function flushHunk(): void {
    if (hunkLines.length === 0) return;
    result.push(
      `@@ -${hunkOldStart + 1},${hunkOldCount} +${hunkNewStart + 1},${hunkNewCount} @@`,
    );
    result.push(...hunkLines);
    hunkLines.length = 0;
  }

  while (oi < oldLines.length || ni < newLines.length) {
    if (
      li < lcs.length &&
      oi < oldLines.length &&
      ni < newLines.length &&
      oldLines[oi] === lcs[li] &&
      newLines[ni] === lcs[li]
    ) {
      if (hunkLines.length > 0) flushHunk();
      oi++;
      ni++;
      li++;
    } else {
      if (hunkLines.length === 0) {
        hunkOldStart = oi;
        hunkNewStart = ni;
        hunkOldCount = 0;
        hunkNewCount = 0;
      }
      if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        hunkLines.push(`-${oldLines[oi]}`);
        hunkOldCount++;
        oi++;
      }
      if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        hunkLines.push(`+${newLines[ni]}`);
        hunkNewCount++;
        ni++;
      }
    }
  }

  flushHunk();
  return result.map((l) => l.replace(/\r?\n$/, '')).join('\n');
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// FNV-1a hash (64-bit, hex string)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const FNV_MASK = 0xFFFFFFFFFFFFFFFFn;

export function fnv1a(text: string): string {
  let h = FNV_OFFSET;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    h = (h ^ BigInt(byte)) * FNV_PRIME & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write content atomically: tmp + fsync + os.replace.
 * Preserves original file permissions.
 */
export function atomicWrite(filePath: string, content: string): void {
  let origMode: number | null = null;
  try {
    origMode = fs.statSync(filePath).mode;
  } catch {
    // file may not exist yet
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.atomic_${Date.now()}_${process.pid}.tmp`);

  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content, undefined, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, filePath);

    if (origMode !== null) {
      fs.chmodSync(filePath, origMode);
    }

    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

const BINARY_CHECK_BYTES = 8192;

/** True if the first 8KB of the file contains a NUL byte. */
export function isBinaryFileSync(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(BINARY_CHECK_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Async binary check. When `unreadableAsBinary` is true (grep), unreadable
 * files are treated as binary so they are skipped.
 */
export async function isBinaryFile(
  filePath: string,
  opts: { unreadableAsBinary?: boolean } = {},
): Promise<boolean> {
  try {
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(BINARY_CHECK_BYTES);
      const { bytesRead } = await fd.read(buf, 0, BINARY_CHECK_BYTES, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fd.close();
    }
  } catch {
    return opts.unreadableAsBinary === true;
  }
}

// ---------------------------------------------------------------------------
// Edit result formatter
// ---------------------------------------------------------------------------

export function formatEditResult(opts: {
  filePath: string;
  success: boolean;
  replacements: number;
  added: number;
  removed: number;
  diffText?: string;
  error?: string;
  message?: string;
  replaceAll?: boolean;
}): string {
  const attrs = [
    `path="${xmlAttr(opts.filePath)}"`,
    `success="${opts.success}"`,
    `replacements="${opts.replacements}"`,
    `replace_all="${opts.replaceAll ?? false}"`,
    `added="${opts.added}"`,
    `removed="${opts.removed}"`,
  ];
  if (opts.error) {
    attrs.push(`error="${xmlAttr(opts.error)}"`);
  }

  const lines = [`<edit_result ${attrs.join(' ')}>`];
  if (opts.message) {
    lines.push('<message><![CDATA[');
    lines.push(cdataText(opts.message));
    lines.push(']]></message>');
  }
  if (opts.diffText) {
    lines.push('<diff format="unified"><!['  + 'CDATA[');
    lines.push(cdataText(opts.diffText));
    lines.push(']]' + '></diff>');
  } else {
    lines.push('<diff format="unified" />');
  }
  lines.push('</edit_result>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Call extraction (for get_file_skeleton)
// ---------------------------------------------------------------------------

interface TreeNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  children: TreeNode[];
  childForFieldName(name: string): TreeNode | null;
}

/**
 * Walk a tree-sitter node's subtree and collect short names of call expressions.
 */
export function extractCallNames(node: TreeNode, source: string): string[] {
  const calls: string[] = [];
  walkForCalls(node, calls, source);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of calls) {
    if (!seen.has(c)) {
      seen.add(c);
      result.push(c);
    }
  }
  return result;
}

function walkForCalls(node: TreeNode, out: string[], source: string): void {
  if (node.type === 'call' || node.type === 'call_expression') {
    let callee = node.childForFieldName('function');
    if (!callee && node.children.length > 0) {
      callee = node.children[0];
    }
    if (callee) {
      let name = source.slice(callee.startIndex, callee.endIndex);
      // Use short name: last part after '.'
      if (name.includes('.')) {
        name = name.split('.').pop()!;
      }
      if (name) out.push(name);
    }
  }
  for (const child of node.children) {
    walkForCalls(child, out, source);
  }
}

// ---------------------------------------------------------------------------
// Extended range (for replace_symbol — includes decorators/comments)
// ---------------------------------------------------------------------------

export function findExtendedRange(
  source: string,
  node: TreeNode,
): { startByte: number; endByte: number } {
  const start = node.startIndex;
  const textBefore = source.slice(0, start);
  const linesBefore = textBefore.split('\n');

  // Compute indentation of the node's first line
  const nodeLineIdx = node.startPosition.row;
  const allLines = source.split('\n');
  const nodeLineText = allLines[nodeLineIdx] ?? '';
  const nodeIndent = nodeLineText.length - nodeLineText.replace(/^\s+/, '').length;

  let checkLines = 0;
  let inBlockComment = false;

  const checkSlice = linesBefore.length > 1 ? linesBefore.slice(0, -1) : [];

  for (let i = checkSlice.length - 1; i >= 0; i--) {
    const line = checkSlice[i];
    const stripped = line.trim();
    if (!stripped) break;

    if (inBlockComment) {
      if (stripped.startsWith('/*') || stripped.startsWith('/**')) {
        checkLines++;
        inBlockComment = false;
        continue;
      }
      if (stripped.startsWith('*') || stripped.startsWith('*/')) {
        checkLines++;
        continue;
      }
      break;
    }

    const isDecorator = stripped.startsWith('@');
    const isComment = stripped.startsWith('#') || stripped.startsWith('//');
    const isDocstring = stripped.startsWith('"""') || stripped.startsWith("'''");
    const isExport = stripped.startsWith('export ');
    const isMultilineEnd = stripped.endsWith('*/');

    if (isDecorator || isComment || isDocstring || isExport || isMultilineEnd) {
      checkLines++;
      if (isMultilineEnd) inBlockComment = true;
    } else {
      const lineIndent = line.length - line.replace(/^\s+/, '').length;
      if (lineIndent < nodeIndent) break;
      break;
    }
  }

  let adjustedStart = start;
  if (checkLines > 0) {
    const preceding = linesBefore.slice(-checkLines - 1, -1).join('\n');
    adjustedStart = start - Buffer.byteLength(preceding, 'utf-8') - 1;
  }

  return { startByte: adjustedStart, endByte: node.endIndex };
}
