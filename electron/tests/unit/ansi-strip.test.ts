import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/renderer/utils/ansi-strip';

describe('stripAnsi', () => {
  it('strips SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m plain')).toBe('bold green plain');
    expect(stripAnsi('\x1b[38;5;196mextended\x1b[0m')).toBe('extended');
    expect(stripAnsi('\x1b[48;2;10;20;30mtruecolor\x1b[49m')).toBe('truecolor');
  });

  it('strips cursor movement and erase CSI sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hcleared')).toBe('cleared');
    expect(stripAnsi('abc\x1b[Kdef')).toBe('abcdef');
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
    expect(stripAnsi('\x1b[10;20Hpos\x1b[3A')).toBe('pos');
  });

  it('strips OSC window-title sequences terminated by BEL or ST', () => {
    expect(stripAnsi('\x1b]0;My Title\x07body')).toBe('body');
    expect(stripAnsi('\x1b]2;Another Title\x1b\\body')).toBe('body');
    expect(stripAnsi('pre\x1b]0;t\x07post')).toBe('prepost');
  });

  it('preserves plain text and newlines', () => {
    expect(stripAnsi('line one\nline two\n')).toBe('line one\nline two\n');
    expect(stripAnsi('abc\rdef')).toBe('abc\rdef');
    expect(stripAnsi('no escapes [here] (at all)')).toBe('no escapes [here] (at all)');
    expect(stripAnsi('a[b;c]d $HOME {x}')).toBe('a[b;c]d $HOME {x}');
    expect(stripAnsi('\x1b[31mred\x1b[0m\n\x1b[32mgreen\x1b[0m\n'))
      .toBe('red\ngreen\n');
  });

  it('returns empty for empty input and escape-only strings', () => {
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi('\x1b[31m\x1b[0m')).toBe('');
    expect(stripAnsi('\x1b]0;title\x07')).toBe('');
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[?25l')).toBe('');
  });
});
