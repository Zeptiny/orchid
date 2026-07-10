/**
 * Project path helpers — U1.
 *
 * Covers:
 * - Happy path: absolute existing directory → valid + canonical path
 * - Edge case: relative path rejected at API boundary
 * - Edge case: missing path → missing (not remapped to process.cwd())
 * - Error path: non-directory path → not valid
 * - unbound: null / empty / whitespace
 * - canonicalize + status convenience wrappers
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inspectProjectDirectory,
  canonicalizeProjectDirectory,
  getProjectDirectoryStatus,
} from '../../src/main/project/path';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-project-path-'));
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// inspectProjectDirectory
// ===========================================================================

describe('inspectProjectDirectory', () => {
  it('returns valid + canonical path for an absolute existing directory', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir);

    const result = inspectProjectDirectory(dir);

    expect(result.status).toBe('valid');
    expect(result.reason).toBeNull();
    expect(result.path).toBe(fs.realpathSync(dir));
    expect(path.isAbsolute(result.path!)).toBe(true);
  });

  it('canonicalizes trailing slashes and . segments on absolute paths', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir);
    const messy = path.join(dir, '.', '') + path.sep;

    const result = inspectProjectDirectory(messy);

    expect(result.status).toBe('valid');
    expect(result.path).toBe(fs.realpathSync(dir));
  });

  it('resolves symlinks via realpath when present', () => {
    const real = path.join(tmpDir, 'real-project');
    const link = path.join(tmpDir, 'link-project');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    const result = inspectProjectDirectory(link);

    expect(result.status).toBe('valid');
    expect(result.path).toBe(fs.realpathSync(real));
  });

  it('rejects relative paths at the API boundary (does not resolve against cwd)', () => {
    const cwdBefore = process.cwd();
    try {
      process.chdir(tmpDir);
      const result = inspectProjectDirectory('relative/project');

      expect(result.status).toBe('missing');
      expect(result.path).toBeNull();
      expect(result.reason).toMatch(/absolute/i);
      // Must not invent a path under cwd
      expect(result.path).not.toBe(path.join(tmpDir, 'relative/project'));
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it('returns missing for a non-existent absolute path (not process.cwd())', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const cwd = process.cwd();

    const result = inspectProjectDirectory(missing);

    expect(result.status).toBe('missing');
    expect(result.path).toBe(path.resolve(missing));
    expect(result.path).not.toBe(cwd);
    expect(result.reason).toMatch(/does not exist/i);
  });

  it('returns missing for a path that is a file (not a directory)', () => {
    const filePath = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'hello', 'utf-8');

    const result = inspectProjectDirectory(filePath);

    expect(result.status).toBe('missing');
    expect(result.path).toBe(path.resolve(filePath));
    expect(result.reason).toMatch(/not a directory/i);
  });

  it('returns unbound for null, undefined, and whitespace-only', () => {
    expect(inspectProjectDirectory(null)).toEqual({
      status: 'unbound',
      path: null,
      reason: null,
    });
    expect(inspectProjectDirectory(undefined)).toEqual({
      status: 'unbound',
      path: null,
      reason: null,
    });
    expect(inspectProjectDirectory('')).toEqual({
      status: 'unbound',
      path: null,
      reason: null,
    });
    expect(inspectProjectDirectory('   ')).toEqual({
      status: 'unbound',
      path: null,
      reason: null,
    });
  });

  it('does not call process.chdir', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir);
    const cwdBefore = process.cwd();

    inspectProjectDirectory(dir);
    canonicalizeProjectDirectory(dir);
    getProjectDirectoryStatus(dir);

    expect(process.cwd()).toBe(cwdBefore);
  });
});

// ===========================================================================
// canonicalizeProjectDirectory
// ===========================================================================

describe('canonicalizeProjectDirectory', () => {
  it('returns canonical path for a valid absolute directory', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir);

    expect(canonicalizeProjectDirectory(dir)).toBe(fs.realpathSync(dir));
  });

  it('returns null for relative, missing, or non-directory paths', () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'x', 'utf-8');

    expect(canonicalizeProjectDirectory('relative')).toBeNull();
    expect(canonicalizeProjectDirectory(path.join(tmpDir, 'missing'))).toBeNull();
    expect(canonicalizeProjectDirectory(filePath)).toBeNull();
  });
});

// ===========================================================================
// getProjectDirectoryStatus
// ===========================================================================

describe('getProjectDirectoryStatus', () => {
  it('maps unbound / valid / missing correctly', () => {
    const dir = path.join(tmpDir, 'project');
    fs.mkdirSync(dir);

    expect(getProjectDirectoryStatus(null)).toBe('unbound');
    expect(getProjectDirectoryStatus(undefined)).toBe('unbound');
    expect(getProjectDirectoryStatus('')).toBe('unbound');
    expect(getProjectDirectoryStatus(dir)).toBe('valid');
    expect(getProjectDirectoryStatus(path.join(tmpDir, 'gone'))).toBe('missing');
    expect(getProjectDirectoryStatus('relative')).toBe('missing');
  });
});
