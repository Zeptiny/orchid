/**
 * AgentsMdContextStore — per-session tracker of which AGENTS.md files are
 * already in the LLM context.
 *
 * Identity is the canonical (symlink-resolved) path carried by `AgentsMdEntry`,
 * so relative and symlinked variants of one file dedupe to a single entry
 * (R14). Each tracked path records the mtime it was seen at so a file that
 * changes on disk is detected as stale and re-injected on next encounter
 * (R16).
 *
 * The store is ephemeral — in-memory only, never persisted to the session
 * file — because the LLM context is rebuilt on reload anyway. This is a
 * deliberate difference from TodoStore (which has toData/fromData).
 */
import type { AgentsMdEntry } from '../agents-md/resolver';

/** What the tracker remembers per canonical path. */
interface SeenRecord {
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * In-memory, per-session, scope-aware set of AGENTS.md files in context.
 *
 * Callers pass `entry.path` (already canonical) — the store never
 * re-canonicalizes. A fresh store is empty; the root file is seeded by the
 * caller at session start (R13) so the nested mechanism never re-injects it
 * (R4).
 */
export class AgentsMdContextStore {
  private _seen = new Map<string, SeenRecord>();

  /** Record an instruction file as present in context (canonical path identity). */
  markSeen(entry: AgentsMdEntry): void {
    this._seen.set(entry.path, {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
    });
  }

  /**
   * Seed the root instruction file (R13). Semantically the session-start seed;
   * delegates to markSeen. Provided for call-site clarity.
   */
  seedRoot(entry: AgentsMdEntry): void {
    this.markSeen(entry);
  }

  /** Whether a canonical path has been seen at all (R14 membership). */
  isSeen(canonicalPath: string): boolean {
    return this._seen.has(canonicalPath);
  }

  /**
   * Whether a seen entry is still current: seen AND the recorded mtime and
   * size both equal the entry's values (R16). A seen-but-changed file is not
   * fresh.
   */
  isFresh(entry: AgentsMdEntry): boolean {
    const record = this._seen.get(entry.path);
    return (
      record !== undefined &&
      record.mtimeMs === entry.mtimeMs &&
      record.sizeBytes === entry.sizeBytes
    );
  }

  /**
   * Entries not yet in context — unseen OR stale — preserving input order.
   * The primitive the read-path injection and write-path enforcement use.
   */
  unseen(chain: AgentsMdEntry[]): AgentsMdEntry[] {
    return chain.filter((entry) => !this.isFresh(entry));
  }

  /** Reset all tracked entries. */
  clear(): void {
    this._seen.clear();
  }

  /** Number of tracked canonical paths (for tests/debugging). */
  get size(): number {
    return this._seen.size;
  }
}
