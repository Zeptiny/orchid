/**
 * AGENTS.md governing-chain resolver.
 *
 * Maps a target path to the ordered chain of instruction files that govern it,
 * walking up from the target's directory to the workspace root (`cwd`). Pure
 * and side-effect-light: it reports file metadata only and never reads content
 * (content reading + the byte cap live with the injection units). Canonical,
 * symlink-resolved paths are the identity used for dedupe across the feature.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema';
import { resolveToolPath } from '../tools/types';
import { effectiveAgentsMdFilenames } from './config';

/** A single governing instruction file discovered during the upward walk. */
export interface AgentsMdEntry {
  /** Canonical absolute path (symlink-resolved) — the dedupe identity. */
  path: string;
  /** Workspace-relative form for human-facing messages. */
  displayPath: string;
  /** `root` for the file at `cwd` level, `nested` otherwise. */
  tier: 'root' | 'nested';
  /** File size in bytes (callers apply the `max_file_bytes` cap). */
  sizeBytes: number;
  /** Modification time in ms (callers use this for staleness). */
  mtimeMs: number;
}

/** Result of reading an instruction file under the byte cap. */
export interface AgentsMdContent {
  content: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Path canonicalization + containment (mirrors permissions/resolver.ts)
// ---------------------------------------------------------------------------

function isPathContainedIn(resolved: string, cwd: string): boolean {
  return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

function isMissingPathError(error: unknown): boolean {
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
function canonicalizeEffectivePath(candidate: string): string | null {
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

function canonicalizeExistingPath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return null;
  }
}

// The cwd is frozen per turn, so canonicalizing it on every file-tool call
// repeats a blocking fs.realpathSync.native on the main-process event loop
// (amplified N× across an apply_patch's files). Memoize the result in a small
// bounded cache keyed by the resolved cwd, mirroring permissions/resolver.ts.
// Per-target symlink resolution (canonicalizeEffectivePath) stays live.
const canonicalPathCache = new Map<string, string | null>();
const CANONICAL_CACHE_MAX = 256;

function canonicalizeExistingPathCached(candidate: string): string | null {
  const key = path.resolve(candidate);
  if (canonicalPathCache.has(key)) return canonicalPathCache.get(key) ?? null;
  const result = canonicalizeExistingPath(key);
  if (canonicalPathCache.size >= CANONICAL_CACHE_MAX) canonicalPathCache.clear();
  canonicalPathCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Per-directory instruction-file lookup
// ---------------------------------------------------------------------------

interface InstructionHit {
  canonical: string;
  stat: fs.Stats;
}

/**
 * Find the governing instruction file in `dir`, testing each configured
 * filename in order; the first existing match wins (alias precedence).
 * Filenames match case-insensitively but the on-disk name is preserved.
 * Returns the canonical (symlink-resolved) path and stat of the match.
 */
function findInstructionFile(
  dir: string,
  filenames: string[],
): InstructionHit | null {
  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  for (const filename of filenames) {
    const lower = filename.toLowerCase();
    // Prefer an exact-case match for determinism when both `AGENTS.md` and
    // `agents.md` coexist on a case-sensitive FS; fall back to case-insensitive.
    const onDisk =
      dirEntries.find((entry) => entry === filename) ??
      dirEntries.find((entry) => entry.toLowerCase() === lower);
    if (onDisk === undefined) continue;

    let canonical: string;
    try {
      canonical = fs.realpathSync.native(path.join(dir, onDisk));
    } catch {
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(canonical);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    return { canonical, stat };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the ordered chain of AGENTS.md files governing `targetPath`.
 *
 * Walks up from `dirname(canonicalTarget)` to `cwd` inclusive, collecting at
 * most one instruction file per directory (first configured alias present).
 * The result is ordered from the target's directory upward; the `cwd`-level
 * file, if any, is tagged `tier: "root"` and is the last entry. The walk never
 * rises above `cwd`, is capped at `agents_md.max_chain_depth` directories, and
 * excludes any file whose canonical path escapes `cwd` (symlink containment).
 * Returns an empty chain when the target lies outside `cwd` or cannot resolve.
 */
export function resolveAgentsMdChain(
  targetPath: string,
  cwd: string,
  config: Config,
): AgentsMdEntry[] {
  const canonicalCwd = canonicalizeExistingPathCached(cwd);
  if (canonicalCwd === null) return [];

  const canonicalTarget = canonicalizeEffectivePath(path.resolve(cwd, targetPath));
  if (canonicalTarget === null || !isPathContainedIn(canonicalTarget, canonicalCwd)) {
    return [];
  }

  const filenames = effectiveAgentsMdFilenames(config);
  if (filenames.length === 0) return [];

  const maxDepth = config.agents_md.max_chain_depth;
  const entries: AgentsMdEntry[] = [];

  let dir = path.dirname(canonicalTarget);
  for (let walked = 0; isPathContainedIn(dir, canonicalCwd) && walked < maxDepth; walked++) {
    const hit = findInstructionFile(dir, filenames);
    if (hit !== null && isPathContainedIn(hit.canonical, canonicalCwd)) {
      entries.push({
        path: hit.canonical,
        displayPath: path.relative(canonicalCwd, hit.canonical),
        tier: dir === canonicalCwd ? 'root' : 'nested',
        sizeBytes: hit.stat.size,
        mtimeMs: hit.stat.mtimeMs,
      });
    }

    if (dir === canonicalCwd) break;
    dir = path.dirname(dir);
  }

  return entries;
}

/**
 * Stat an existing instruction file and build a fresh `AgentsMdEntry` for it
 * (current mtime/size, tier from whether its containing directory is the
 * workspace root, displayPath relative to cwd). Returns null when the path does
 * not exist, is not a file, or escapes cwd. The dispatcher uses this to refresh
 * the tracker with the POST-write state of an edited/created instruction file
 * (R10), so the recorded mtime matches what the handler just wrote to disk.
 */
export function statAgentsMdEntry(
  rawPath: string,
  cwd: string,
  config: Config,
): AgentsMdEntry | null {
  void config;
  const canonicalCwd = canonicalizeExistingPathCached(cwd);
  if (canonicalCwd === null) return null;

  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync.native(resolveToolPath(cwd, rawPath));
    stat = fs.statSync(canonical);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (!isPathContainedIn(canonical, canonicalCwd)) return null;

  return {
    path: canonical,
    displayPath: path.relative(canonicalCwd, canonical),
    tier: path.dirname(canonical) === canonicalCwd ? 'root' : 'nested',
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Read an instruction file's content under a byte cap (R5). Reads at most
 * `maxBytes` from the head; `truncated` is true when the file exceeds the cap.
 * Pure helper shared by the injection units — does not touch the tracker.
 */
export function readAgentsMdContent(
  entry: AgentsMdEntry,
  maxBytes: number,
): AgentsMdContent {
  const fd = fs.openSync(entry.path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return {
      content: buffer.toString('utf8', 0, bytesRead),
      truncated: entry.sizeBytes > maxBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}
