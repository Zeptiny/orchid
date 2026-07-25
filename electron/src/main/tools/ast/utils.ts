/**
 * Shared utilities for AST tools.
 *
 * Ported from Python `src/orchid/tools/_xml_utils.py` and `ast.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapeXmlAttribute, escapeXmlText } from '../result';
import { safeFsync } from '../../utils/safe-fsync';

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
      safeFsync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, filePath);

    if (origMode !== null) {
      fs.chmodSync(filePath, origMode);
    }

    const dirFd = fs.openSync(dir, 'r');
    try {
      safeFsync(dirFd);
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
  error?: string;
  message?: string;
  replaceAll?: boolean;
}): string {
  const attrs = [
    `path="${escapeXmlAttribute(opts.filePath)}"`,
    `success="${opts.success}"`,
    `replacements="${opts.replacements}"`,
    `replace_all="${opts.replaceAll ?? false}"`,
    `added="${opts.added}"`,
    `removed="${opts.removed}"`,
  ];
  if (opts.error) {
    attrs.push(`error="${escapeXmlAttribute(opts.error)}"`);
  }

  const lines = [`<edit_result ${attrs.join(' ')}>`];
  if (opts.message) {
    lines.push('<message>' + escapeXmlText(opts.message) + '</message>');
  }
  lines.push('</edit_result>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Extended range (for replace_symbol — includes decorators/comments)
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
