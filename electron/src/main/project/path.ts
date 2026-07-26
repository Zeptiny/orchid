/**
 * Project path validation and normalization.
 *
 * Shared helpers for session cwd / sticky default_project_dir.
 * Absolute paths only; never process.chdir; realpath when the path exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse status for a candidate project directory. */
export type ProjectDirectoryStatus = 'unbound' | 'valid' | 'missing';

/** Full inspection result for a candidate project directory. */
export interface ProjectDirectoryInspection {
  /** Coarse status (unbound / valid / missing). */
  readonly status: ProjectDirectoryStatus;
  /**
   * Canonical absolute path when `status === 'valid'`.
   * Absolute (resolved) candidate when the path was absolute but not valid.
   * `null` when unbound or when a relative path was rejected.
   */
  readonly path: string | null;
  /** Human-readable reason when not valid; `null` when valid or unbound. */
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a candidate project directory.
 *
 * - `null` / `undefined` / whitespace-only → `unbound`
 * - relative paths are rejected at the API boundary (not resolved against cwd)
 * - absolute paths are checked for existence, directory-ness, and R_OK|X_OK
 * - when present and accessible, the path is canonicalized via `realpath`
 */
export function inspectProjectDirectory(
  dir: string | null | undefined,
): ProjectDirectoryInspection {
  if (dir == null || dir.trim() === '') {
    return { status: 'unbound', path: null, reason: null };
  }

  if (!path.isAbsolute(dir)) {
    return {
      status: 'missing',
      path: null,
      reason: 'path must be absolute',
    };
  }

  // Normalize `.` / `..` / redundant separators without resolving against cwd.
  const absolute = path.resolve(dir);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        status: 'missing',
        path: absolute,
        reason: 'path does not exist',
      };
    }
    return {
      status: 'missing',
      path: absolute,
      reason: 'path is not accessible',
    };
  }

  if (!stat.isDirectory()) {
    return {
      status: 'missing',
      path: absolute,
      reason: 'not a directory',
    };
  }

  try {
    fs.accessSync(absolute, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return {
      status: 'missing',
      path: absolute,
      reason: 'directory is not readable/executable',
    };
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(absolute);
  } catch {
    // Extremely rare race (deleted between stat and realpath); treat as missing.
    return {
      status: 'missing',
      path: absolute,
      reason: 'path does not exist',
    };
  }

  return { status: 'valid', path: canonical, reason: null };
}

/**
 * Return the canonical absolute path when `dir` is a valid project directory,
 * otherwise `null`. Relative paths are rejected (not resolved against cwd).
 */
export function canonicalizeProjectDirectory(dir: string): string | null {
  const inspection = inspectProjectDirectory(dir);
  return inspection.status === 'valid' ? inspection.path : null;
}

/**
 * Coarse status for a candidate project directory (or sticky default).
 *
 * - unbound: no path configured
 * - valid: absolute, exists, is a directory, R_OK|X_OK
 * - missing: configured but not usable (relative, gone, file, no access, …)
 */
export function getProjectDirectoryStatus(
  dir: string | null | undefined,
): ProjectDirectoryStatus {
  return inspectProjectDirectory(dir).status;
}

/** Whether an effective absolute target remains within a canonical workspace. */
export function isPathContainedIn(target: string, workspace: string): boolean {
  return target === workspace || target.startsWith(workspace + path.sep);
}

/** Canonicalize an existing path, returning null for missing or inaccessible paths. */
export function canonicalizeExistingPath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return null;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Resolve a path through its nearest existing parent. This preserves symlink
 * containment checks for paths that will be created by a mutation.
 */
export function canonicalizeEffectivePath(candidate: string): string | null {
  let current = path.resolve(candidate);
  const missingParts: string[] = [];

  while (true) {
    try {
      const existingParent = fs.realpathSync.native(current);
      return path.resolve(existingParent, ...missingParts);
    } catch (error) {
      if (!isMissingPathError(error)) return null;

      try {
        fs.lstatSync(current);
        return null;
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) return null;
      }

      const parent = path.dirname(current);
      if (parent === current) return null;
      missingParts.unshift(path.basename(current));
      current = parent;
    }
  }
}
