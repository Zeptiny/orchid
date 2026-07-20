import { describe, it, expect } from 'vitest';
import {
  seekSequence,
  seekSequenceWithMeta,
  findContextHint,
  normalizeUnicode,
} from '../../src/main/tools/filesystem/apply-patch-match';

// ── seekSequence ───────────────────────────────────────────────────────────

describe('seekSequence', () => {
  it('finds an exact match at the correct index', () => {
    const lines = ['foo', 'bar', 'baz'];
    expect(seekSequence(lines, ['bar', 'baz'], 0, false)).toBe(1);
  });

  it('matches with trim-end ignoring trailing whitespace', () => {
    const lines = ['foo   ', 'bar\t\t'];
    expect(seekSequence(lines, ['foo', 'bar'], 0, false)).toBe(0);
  });

  it('matches with trim ignoring leading and trailing whitespace', () => {
    const lines = ['    foo   ', '   bar\t'];
    expect(seekSequence(lines, ['foo', 'bar'], 0, false)).toBe(0);
  });

  it('matches ASCII dash against en-dash via Unicode normalization', () => {
    const lines = ['a\u{2013}b'];
    expect(seekSequence(lines, ['a-b'], 0, false)).toBe(0);
  });

  it('matches ASCII single quote against curly quote via Unicode normalization', () => {
    const lines = ['\u{2018}hello\u{2019}'];
    expect(seekSequence(lines, ["'hello'"], 0, false)).toBe(0);
  });

  it('matches ASCII double quote against curly quote via Unicode normalization', () => {
    const lines = ['\u{201C}hello\u{201D}'];
    expect(seekSequence(lines, ['"hello"'], 0, false)).toBe(0);
  });

  it('matches ASCII space against non-breaking space via Unicode normalization', () => {
    const lines = ['a\u{00A0}b'];
    expect(seekSequence(lines, ['a b'], 0, false)).toBe(0);
  });

  it('anchors match to end of file when eof is true', () => {
    const lines = ['foo', 'bar', 'foo', 'bar'];
    expect(seekSequence(lines, ['foo', 'bar'], 0, true)).toBe(2);
  });

  it('returns null when eof anchor misses (no fallback)', () => {
    const lines = ['target', 'a', 'b', 'c'];
    expect(seekSequence(lines, ['target'], 0, true)).toBeNull();
  });

  it('reports ambiguity when multiple matches exist at winning tier', () => {
    const lines = ['foo', 'bar', 'foo', 'bar'];
    const result = seekSequenceWithMeta(lines, ['foo', 'bar'], 0, false);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(result!.ambiguous).toBe(true);
  });

  it('reports no ambiguity when exactly one match at winning tier', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const result = seekSequenceWithMeta(lines, ['b', 'c'], 0, false);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
    expect(result!.ambiguous).toBe(false);
  });

  it('matches a multi-line pattern correctly', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    expect(seekSequence(lines, ['b', 'c', 'd'], 0, false)).toBe(1);
  });

  it('returns start for an empty pattern', () => {
    expect(seekSequence(['a', 'b'], [], 1, false)).toBe(1);
  });

  it('returns null when pattern is longer than lines', () => {
    expect(seekSequence(['one'], ['a', 'b', 'c'], 0, false)).toBeNull();
  });

  it('returns null when no tier matches', () => {
    const lines = ['alpha', 'beta'];
    expect(seekSequence(lines, ['gamma'], 0, false)).toBeNull();
  });

  it('prefers exact match over trim match', () => {
    const lines = ['  foo  ', 'foo'];
    expect(seekSequence(lines, ['foo'], 0, false)).toBe(1);
  });

  it('skips earlier occurrences when start offset is set', () => {
    const lines = ['x', 'x', 'x'];
    expect(seekSequence(lines, ['x'], 1, false)).toBe(1);
  });
});

// ── findContextHint ────────────────────────────────────────────────────────

describe('findContextHint', () => {
  it('finds hint and returns index after it', () => {
    const lines = ['header', '@@ context', 'body'];
    expect(findContextHint(lines, '@@ context', 0)).toBe(2);
  });

  it('returns null when hint is not found', () => {
    expect(findContextHint(['a', 'b'], 'missing', 0)).toBeNull();
  });

  it('tolerates whitespace differences in hint', () => {
    const lines = ['  @@ context  '];
    expect(findContextHint(lines, '@@ context', 0)).toBe(1);
  });
});

// ── normalizeUnicode ───────────────────────────────────────────────────────

describe('normalizeUnicode', () => {
  it('trims and maps dashes', () => {
    expect(normalizeUnicode('  \u{2014}  ')).toBe('-');
  });

  it('maps all dash variants', () => {
    const dashes = '\u{2010}\u{2011}\u{2012}\u{2013}\u{2014}\u{2015}\u{2212}';
    expect(normalizeUnicode(dashes)).toBe('-------');
  });

  it('maps single quotes', () => {
    expect(normalizeUnicode('\u{2018}\u{2019}\u{201A}\u{201B}')).toBe("''''");
  });

  it('maps double quotes', () => {
    expect(normalizeUnicode('\u{201C}\u{201D}\u{201E}\u{201F}')).toBe('""""');
  });

  it('maps space variants', () => {
    expect(normalizeUnicode('a\u{00A0}\u{3000}b')).toBe('a  b');
  });

  it('leaves ASCII unchanged', () => {
    expect(normalizeUnicode('  hello world  ')).toBe('hello world');
  });
});
