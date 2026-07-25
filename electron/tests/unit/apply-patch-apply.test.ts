import { describe, it, expect } from 'vitest';
import {
  applyChunksToContent,
  ApplyPatchApplyError,
} from '../../src/main/tools/filesystem/apply-patch-apply';
import type { UpdateFileChunk, HunkLineOp } from '../../src/main/tools/filesystem/apply-patch-parser';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Reconstruct ordered lineOps from parallel oldLines/newLines arrays.
 * Used by the chunk() helper so tests can stay ergonomic. O(n²) is fine
 * for the small arrays in unit tests.
 */
function deriveLineOps(oldLines: string[], newLines: string[]): HunkLineOp[] {
  const ops: HunkLineOp[] = [];
  let o = 0;
  let n = 0;
  while (o < oldLines.length && n < newLines.length) {
    if (oldLines[o] === newLines[n]) {
      ops.push({ kind: 'context', content: oldLines[o] });
      o++;
      n++;
    } else {
      // Find the next alignment point — a line that appears in both arrays
      // at or after the current positions. Lines before it are removes (old)
      // or adds (new).
      let nextO = -1;
      let nextN = -1;
      for (let i = o + 1; i < oldLines.length; i++) {
        for (let j = n; j < newLines.length; j++) {
          if (oldLines[i] === newLines[j]) {
            nextO = i;
            nextN = j;
            break;
          }
        }
        if (nextO !== -1) break;
      }
      if (nextO === -1) {
        while (o < oldLines.length) {
          ops.push({ kind: 'remove', content: oldLines[o] });
          o++;
        }
        while (n < newLines.length) {
          ops.push({ kind: 'add', content: newLines[n] });
          n++;
        }
      } else {
        while (o < nextO) {
          ops.push({ kind: 'remove', content: oldLines[o] });
          o++;
        }
        while (n < nextN) {
          ops.push({ kind: 'add', content: newLines[n] });
          n++;
        }
      }
    }
  }
  while (o < oldLines.length) {
    ops.push({ kind: 'remove', content: oldLines[o] });
    o++;
  }
  while (n < newLines.length) {
    ops.push({ kind: 'add', content: newLines[n] });
    n++;
  }
  return ops;
}

function chunk(overrides: Partial<UpdateFileChunk> = {}): UpdateFileChunk {
  const base: UpdateFileChunk = {
    changeContext: null,
    lineOps: [],
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
    ...overrides,
  };
  // Test convenience: if the test sets oldLines/newLines directly (bypassing
  // the parser), derive lineOps so the apply engine has the ordered ops it
  // needs to preserve context-line whitespace.
  if (base.lineOps.length === 0 && (base.oldLines.length > 0 || base.newLines.length > 0)) {
    base.lineOps = deriveLineOps(base.oldLines, base.newLines);
  }
  return base;
}

// ── Happy path ─────────────────────────────────────────────────────────────

describe('applyChunksToContent', () => {
  it('applies a single chunk replacement', () => {
    const content = 'line1\nline2\nline3\n';
    const chunks = [
      chunk({ oldLines: ['line2'], newLines: ['replaced'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'line1\nreplaced\nline3\n',
    );
  });

  it('applies multiple chunks in one file', () => {
    const content = 'aaa\nbbb\nccc\nddd\neee\n';
    const chunks = [
      chunk({ oldLines: ['bbb'], newLines: ['BBB'] }),
      chunk({ oldLines: ['ddd'], newLines: ['DDD'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'aaa\nBBB\nccc\nDDD\neee\n',
    );
  });

  it('inserts pure addition at end of file', () => {
    const content = 'existing\n';
    const chunks = [
      chunk({ oldLines: [], newLines: ['added1', 'added2'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'existing\nadded1\nadded2\n',
    );
  });

  it('handles isEndOfFile chunk anchored to file end', () => {
    const content = 'foo\nbar\nfoo\nbar\n';
    const chunks = [
      chunk({ oldLines: ['foo', 'bar'], newLines: ['baz'], isEndOfFile: true }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'foo\nbar\nbaz\n',
    );
  });

  it('uses context hint to narrow search location', () => {
    const content = 'header\ntarget\nfooter\ntarget\nend\n';
    const chunks = [
      chunk({
        changeContext: 'header',
        oldLines: ['target'],
        newLines: ['CHANGED'],
      }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'header\nCHANGED\nfooter\ntarget\nend\n',
    );
  });

  it('uses stacked context-advancing chunks to narrow search', () => {
    const lines = Array.from({ length: 21 }, (_, i) => `line${i + 1}`);
    lines[0] = 'class Foo';
    lines[4] = 'def bar';
    lines[5] = 'target';
    lines[19] = 'target';
    const content = lines.join('\n') + '\n';
    const chunks = [
      chunk({ changeContext: 'class Foo', oldLines: [], newLines: [] }),
      chunk({ changeContext: 'def bar', oldLines: ['target'], newLines: ['CHANGED'] }),
    ];
    const result = applyChunksToContent(content, chunks, 'test.txt');
    const resultLines = result.split('\n');
    expect(resultLines[5]).toBe('CHANGED');
    expect(resultLines[19]).toBe('target');
  });

  it('retries without trailing empty line in oldLines', () => {
    const content = 'alpha\nbeta\n';
    const chunks = [
      chunk({ oldLines: ['beta', ''], newLines: ['gamma', ''] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'alpha\ngamma\n',
    );
  });

  it('preserves context lines in both old and new', () => {
    const content = 'ctx_before\nold_line\nctx_after\n';
    const chunks = [
      chunk({
        oldLines: ['ctx_before', 'old_line', 'ctx_after'],
        newLines: ['ctx_before', 'new_line', 'ctx_after'],
      }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'ctx_before\nnew_line\nctx_after\n',
    );
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('creates content from empty file with pure addition', () => {
    const chunks = [
      chunk({ oldLines: [], newLines: ['hello', 'world'] }),
    ];
    expect(applyChunksToContent('', chunks, 'test.txt')).toBe(
      'hello\nworld\n',
    );
  });

  it('replaces the first line', () => {
    const content = 'first\nsecond\nthird\n';
    const chunks = [
      chunk({ oldLines: ['first'], newLines: ['FIRST'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'FIRST\nsecond\nthird\n',
    );
  });

  it('replaces the last line', () => {
    const content = 'first\nsecond\nlast\n';
    const chunks = [
      chunk({ oldLines: ['last'], newLines: ['LAST'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'first\nsecond\nLAST\n',
    );
  });

  it('handles interleaved additions and deletions across non-adjacent regions', () => {
    const content = 'a\nb\nc\nd\ne\nf\n';
    const chunks = [
      chunk({ oldLines: ['b'], newLines: ['B1', 'B2'] }),
      chunk({ oldLines: ['e'], newLines: [] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'a\nB1\nB2\nc\nd\nf\n',
    );
  });

  it('preserves absence of trailing newline (F7)', () => {
    const content = 'no\ntrailing\nnewline';
    const chunks = [
      chunk({ oldLines: ['trailing'], newLines: ['TRAILING'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'no\nTRAILING\nnewline',
    );
  });

  it('preserves presence of trailing newline (F7)', () => {
    const content = 'no\ntrailing\nnewline\n';
    const chunks = [
      chunk({ oldLines: ['trailing'], newLines: ['TRAILING'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'no\nTRAILING\nnewline\n',
    );
  });

  it('preserves CRLF line endings across the whole file (F4)', () => {
    const content = 'line1\r\nline2\r\nline3\r\n';
    const chunks = [
      chunk({ oldLines: ['line2'], newLines: ['LINE2'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'line1\r\nLINE2\r\nline3\r\n',
    );
  });

  it('preserves file whitespace on context lines (F1)', () => {
    // File has trailing spaces on a context line; the patch's context line
    // lacks them. The file's version must be preserved in the output.
    // lineOps must be set explicitly — deriveLineOps can't infer a context
    // line when the patch's version differs from the file's in whitespace.
    const content = 'hello   \nold\nworld\n';
    const chunks = [
      {
        changeContext: null,
        isEndOfFile: false,
        lineOps: [
          { kind: 'context', content: 'hello' },
          { kind: 'remove', content: 'old' },
          { kind: 'add', content: 'new' },
          { kind: 'context', content: 'world' },
        ],
        oldLines: ['hello', 'old', 'world'],
        newLines: ['hello', 'new', 'world'],
      } as UpdateFileChunk,
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'hello   \nnew\nworld\n',
    );
  });

  it('fails when *** End of File anchor does not match EOF (F2)', () => {
    const content = 'aaa\nbbb\nccc\nddd\neee\n';
    const chunks = [
      chunk({ oldLines: ['bbb', 'ccc'], newLines: ['BBB', 'CCC'], isEndOfFile: true }),
    ];
    expect(() => applyChunksToContent(content, chunks, 'test.txt')).toThrow(
      ApplyPatchApplyError,
    );
    expect(() => applyChunksToContent(content, chunks, 'test.txt')).toThrow(
      'End of File anchor failed',
    );
  });

  it('succeeds when *** End of File anchor matches EOF (F2)', () => {
    const content = 'aaa\nbbb\nccc\nddd\neee\n';
    const chunks = [
      chunk({ oldLines: ['ddd', 'eee'], newLines: ['DDD', 'EEE'], isEndOfFile: true }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'aaa\nbbb\nccc\nDDD\nEEE\n',
    );
  });

  it('errors on ambiguous match without @@ context header (F6)', () => {
    const content = 'foo\nbar\nfoo\nbar\n';
    const chunks = [
      chunk({ oldLines: ['foo', 'bar'], newLines: ['FOO', 'BAR'] }),
    ];
    expect(() => applyChunksToContent(content, chunks, 'test.txt')).toThrow(
      ApplyPatchApplyError,
    );
    expect(() => applyChunksToContent(content, chunks, 'test.txt')).toThrow(
      'matches multiple locations',
    );
  });

  it('does not error on ambiguous match when @@ context header is present (F6)', () => {
    // With a @@ header, the context hint narrows the search position past
    // the first 'foo', so the pattern matches only the second 'foo\nbar'
    // unambiguously. The user attempted disambiguation; we honor the match.
    const content = 'foo\nbar\nfoo\nbar\n';
    const chunks = [
      chunk({ changeContext: 'foo', oldLines: ['foo', 'bar'], newLines: ['FOO', 'BAR'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'foo\nbar\nFOO\nBAR\n',
    );
  });

  // ── Error paths ────────────────────────────────────────────────────────

  it('throws ApplyPatchApplyError when old lines not found', () => {
    const content = 'aaa\nbbb\nccc\n';
    const chunks = [
      chunk({ oldLines: ['zzz'], newLines: ['replacement'] }),
    ];
    expect(() => applyChunksToContent(content, chunks, 'test.txt')).toThrow(
      ApplyPatchApplyError,
    );
    try {
      applyChunksToContent(content, chunks, 'test.txt');
    } catch (e) {
      const err = e as ApplyPatchApplyError;
      expect(err.filePath).toBe('test.txt');
      expect(err.unmatchedLines).toEqual(['zzz']);
      expect(err.message).toContain('Failed to find expected lines in test.txt');
    }
  });

  it('throws ApplyPatchApplyError when context hint not found', () => {
    const content = 'aaa\nbbb\n';
    const chunks = [
      chunk({
        changeContext: 'nonexistent_context',
        oldLines: ['bbb'],
        newLines: ['ccc'],
      }),
    ];
    expect(() => applyChunksToContent(content, chunks, 'test.txt')).toThrow(
      ApplyPatchApplyError,
    );
    try {
      applyChunksToContent(content, chunks, 'test.txt');
    } catch (e) {
      const err = e as ApplyPatchApplyError;
      expect(err.filePath).toBe('test.txt');
      expect(err.message).toContain("Failed to find context 'nonexistent_context' in test.txt");
    }
  });
});
