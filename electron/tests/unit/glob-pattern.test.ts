/**
 * Unit tests for shared glob → RegExp conversion.
 */
import { describe, it, expect } from 'vitest';
import { globToRegex } from '../../src/main/tools/glob-pattern';

describe('globToRegex', () => {
  it('matches common extension globs', () => {
    const re = globToRegex('*.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('foo.tsx')).toBe(false);
    expect(re.test('foo.js')).toBe(false);
  });

  it('matches single-character wildcards', () => {
    const re = globToRegex('test_?.py');
    expect(re.test('test_a.py')).toBe(true);
    expect(re.test('test_ab.py')).toBe(false);
    expect(re.test('test_.py')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    const re = globToRegex('file.name');
    expect(re.test('file.name')).toBe(true);
    expect(re.test('fileXname')).toBe(false);
  });

  it('supports character classes when enabled (default)', () => {
    const re = globToRegex('file[ab].ts');
    expect(re.test('filea.ts')).toBe(true);
    expect(re.test('fileb.ts')).toBe(true);
    expect(re.test('filec.ts')).toBe(false);
  });

  it('treats unclosed [ as a literal', () => {
    const re = globToRegex('file[a.ts');
    expect(re.test('file[a.ts')).toBe(true);
    expect(re.test('fileXa.ts')).toBe(false);
  });

  it('treats [ as a literal when characterClasses is false', () => {
    const re = globToRegex('file[ab].ts', { characterClasses: false });
    expect(re.test('file[ab].ts')).toBe(true);
    expect(re.test('filea.ts')).toBe(false);
  });

  it('is case-sensitive by default', () => {
    const re = globToRegex('*.TS');
    expect(re.test('foo.TS')).toBe(true);
    expect(re.test('foo.ts')).toBe(false);
  });

  it('is case-insensitive when requested', () => {
    const re = globToRegex('*.ts', { caseInsensitive: true });
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('foo.TS')).toBe(true);
    expect(re.test('FOO.Ts')).toBe(true);
  });

  it('anchors the full string', () => {
    const re = globToRegex('*.ts');
    expect(re.test('prefix-foo.ts-suffix')).toBe(false);
    expect(re.test('foo.ts.bak')).toBe(false);
  });
});
