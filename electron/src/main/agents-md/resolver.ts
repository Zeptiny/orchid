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
    const onDisk = dirEntries.find((entry) => entry.toLowerCase() === lower);
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
  const canonicalCwd = canonicalizeExistingPath(cwd);
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
