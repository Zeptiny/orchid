import { describe, it, expect } from 'vitest';
import {
  applyChunksToContent,
  ApplyPatchApplyError,
} from '../../src/main/tools/filesystem/apply-patch-apply';
import type { UpdateFileChunk } from '../../src/main/tools/filesystem/apply-patch-parser';

// ── Helpers ────────────────────────────────────────────────────────────────

function chunk(overrides: Partial<UpdateFileChunk> = {}): UpdateFileChunk {
  return {
    changeContext: null,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
    ...overrides,
  };
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

  it('adds trailing newline to content without one', () => {
    const content = 'no\ntrailing\nnewline';
    const chunks = [
      chunk({ oldLines: ['trailing'], newLines: ['TRAILING'] }),
    ];
    expect(applyChunksToContent(content, chunks, 'test.txt')).toBe(
      'no\nTRAILING\nnewline\n',
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
