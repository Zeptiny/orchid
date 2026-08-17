/**
 * Realpath-based workspace path sandboxing.
 *
 * All mutating filesystem tools must resolve user-supplied paths through
 * `assertPathInWorkspace` to block symlink-based workspace escapes. The
 * canonicalization helpers here are the single source of truth — other
 * modules (`permissions/resolver.ts`, `agents-md/resolver.ts`) import from
 * here instead of maintaining their own copies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveToolPath } from './types';

/** Lexical containment check (does not resolve symlinks). */
export function isPathContainedIn(resolved: string, cwd: string): boolean {
  return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

export function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Canonicalize a path that may not fully exist yet (e.g. a file about to be
 * created): resolve the nearest existing ancestor with `realpathSync.native`
 * and re-append the missing components. Returns null if nothing resolves.
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

/** Canonicalize a path that must already exist on disk. */
export function canonicalizeExistingPath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return null;
  }
}

// The cwd is frozen per turn, so canonicalizing it on every file-tool call
// repeats a blocking fs.realpathSync.native on the main-process event loop
// (amplified N× across an apply_patch's files). Memoize the result in a small
// bounded cache keyed by the resolved cwd.
// Per-target symlink resolution (canonicalizeEffectivePath) stays live.
const canonicalPathCache = new Map<string, string | null>();
const CANONICAL_CACHE_MAX = 256;

export function canonicalizeExistingPathCached(candidate: string): string | null {
  const key = path.resolve(candidate);
  if (canonicalPathCache.has(key)) return canonicalPathCache.get(key) ?? null;
  const result = canonicalizeExistingPath(key);
  if (canonicalPathCache.size >= CANONICAL_CACHE_MAX) canonicalPathCache.clear();
  canonicalPathCache.set(key, result);
  return result;
}

/**
 * Resolve a user-supplied path against the workspace cwd and verify (via
 * realpath) that it stays inside the workspace after symlink resolution.
 *
 * Handles not-yet-existing paths (e.g. files about to be created) by
 * resolving the nearest existing ancestor and re-appending missing
 * components, mirroring the logic in `permissions/resolver.ts`.
 *
 * @returns The resolved logical path (symlinks are followed by the caller's
 *          fs operations, not resolved here).
 * @throws  If the path escapes the workspace via symlink or cannot be resolved.
 */
export function assertPathInWorkspace(userPath: string, cwd: string): string {
  const resolved = resolveToolPath(cwd, userPath);

  const canonicalCwd = canonicalizeExistingPathCached(cwd);
  if (canonicalCwd === null) {
    throw new Error(`Cannot resolve working directory: ${cwd}`);
  }

  const canonicalTarget = canonicalizeEffectivePath(resolved);
  if (canonicalTarget === null) {
    throw new Error(`Cannot resolve path: ${userPath}`);
  }

  if (!isPathContainedIn(canonicalTarget, canonicalCwd)) {
    throw new Error(`Path '${userPath}' escapes the working directory.`);
  }

  return resolved;
}
