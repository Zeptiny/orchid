/**
 * ForegroundLiveRegistry — live output mirror for foreground commands.
 *
 * Additive side channel keyed by tool call id: foreground `execute_command`
 * runs mirror every stdout/stderr chunk here while `readBounded` stays the
 * canonical collector (stdout/stderr separation, truncation cap, timeout and
 * abort kills). Entries finalize with the process exit code, linger for a
 * grace period so late snapshots still see the final tail, and the registry
 * is bounded with oldest-first eviction. Reached via getForegroundLiveRegistry().
 */
import { HeadTailBuffer } from './head-tail-buffer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a finalized entry stays snapshotable before removal. */
const DEFAULT_GRACE_MS = 5_000;
/** Max live entries; the oldest entry is evicted on overflow. */
const DEFAULT_MAX_ENTRIES = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForegroundLiveEntry {
  toolCallId: string;
  command: string;
  buffer: HeadTailBuffer;
  sessionId: string | null;
  agentScopeId: string;
  exitCode: number | null;
  startedAt: number;
}

export interface ForegroundLiveSnapshot {
  tail: string;
  exitCode: number | null;
}

/** Session-aware query result used by the bgcmd:snapshot IPC surface. */
export interface ForegroundLiveSessionSnapshot {
  tail: string;
  exitCode: number | null;
  running: boolean;
  command: string;
  agentScopeId: string;
  /** Restart-stable spawn identity (the entry's `startedAt`). */
  createdAt: number;
}

export interface ForegroundLiveRegistryOptions {
  /** Delay between finalize and entry removal (ms). */
  graceMs?: number;
  /** Max live entries before oldest-first eviction. */
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// ForegroundLiveRegistry
// ---------------------------------------------------------------------------

export class ForegroundLiveRegistry {
  private _entries = new Map<string, ForegroundLiveEntry>();
  private _removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _graceMs: number;
  private readonly _maxEntries: number;

  constructor(options: ForegroundLiveRegistryOptions = {}) {
    this._graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this._maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  // -- lifecycle ---------------------------------------------------------------

  /** Create the entry for a tool call (idempotent: an existing entry wins). */
  register(
    toolCallId: string,
    meta: { command: string; sessionId: string | null; agentScopeId: string },
  ): ForegroundLiveEntry {
    const existing = this._entries.get(toolCallId);
    if (existing) return existing;
    const entry: ForegroundLiveEntry = {
      toolCallId,
      command: meta.command,
      buffer: new HeadTailBuffer(),
      sessionId: meta.sessionId,
      agentScopeId: meta.agentScopeId,
      exitCode: null,
      startedAt: Date.now(),
    };
    this._entries.set(toolCallId, entry);
    this._evictIfNeeded();
    return entry;
  }

  /** Mirror one output chunk; safe no-op when the id was never registered. */
  append(toolCallId: string, chunk: Buffer): void {
    const entry = this._entries.get(toolCallId);
    if (!entry) return;
    entry.buffer.append(chunk);
  }

  /**
   * Record the terminal exit code and schedule removal after the grace
   * period. Idempotent: a second finalize keeps the first code and timer.
   * Safe no-op when the id was never registered.
   */
  finalize(toolCallId: string, exitCode: number): void {
    const entry = this._entries.get(toolCallId);
    if (!entry || entry.exitCode !== null) return;
    entry.exitCode = exitCode;
    const timer = setTimeout(() => {
      this._removalTimers.delete(toolCallId);
      this._remove(toolCallId);
    }, this._graceMs);
    // Display-only mirror entries must never hold the process open.
    if (typeof timer.unref === 'function') timer.unref();
    this._removalTimers.set(toolCallId, timer);
  }

  // -- query -------------------------------------------------------------------

  get(toolCallId: string): ForegroundLiveEntry | undefined {
    return this._entries.get(toolCallId);
  }

  snapshot(toolCallId: string, lastN?: number): ForegroundLiveSnapshot | undefined {
    const entry = this._entries.get(toolCallId);
    if (!entry) return undefined;
    return { tail: entry.buffer.getTail(lastN), exitCode: entry.exitCode };
  }

  /**
   * Session-owned query for UI IPC: applies the session visibility check
   * (entries owned by another session — or unbound entries — are denied).
   * Returns undefined when the entry is absent or not visible to the session.
   */
  snapshotForSession(
    toolCallId: string,
    lastN: number | undefined,
    sessionId: string,
  ): ForegroundLiveSessionSnapshot | undefined {
    const entry = this._entries.get(toolCallId);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    return {
      tail: entry.buffer.getTail(lastN),
      exitCode: entry.exitCode,
      running: entry.exitCode === null,
      command: entry.command,
      agentScopeId: entry.agentScopeId,
      createdAt: entry.startedAt,
    };
  }

  get size(): number {
    return this._entries.size;
  }

  // -- cleanup -------------------------------------------------------------------

  /** Remove every entry owned by the session (all agent scopes). */
  dropSession(sessionId: string): void {
    for (const [toolCallId, entry] of [...this._entries]) {
      if (entry.sessionId === sessionId) this._remove(toolCallId);
    }
  }

  /**
   * Remove the entries owned by one agent scope within the session.
   * A null session id never matches: unbound entries survive scope cleanup
   * (mirrors `BackgroundProcessStore.terminateScope`).
   */
  dropScope(sessionId: string | null, agentScopeId: string): void {
    if (sessionId === null) return;
    for (const [toolCallId, entry] of [...this._entries]) {
      if (entry.sessionId === sessionId && entry.agentScopeId === agentScopeId) {
        this._remove(toolCallId);
      }
    }
  }

  clear(): void {
    for (const toolCallId of [...this._entries.keys()]) {
      this._remove(toolCallId);
    }
  }

  // -- internals -----------------------------------------------------------------

  private _remove(toolCallId: string): void {
    this._entries.delete(toolCallId);
    const timer = this._removalTimers.get(toolCallId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._removalTimers.delete(toolCallId);
    }
  }

  /** Map iteration order is insertion order, so the first key is the oldest. */
  private _evictIfNeeded(): void {
    while (this._entries.size > this._maxEntries) {
      const oldest = this._entries.keys().next();
      if (oldest.done) break;
      this._remove(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _currentRegistry: ForegroundLiveRegistry | null = null;

export function getForegroundLiveRegistry(): ForegroundLiveRegistry {
  if (_currentRegistry === null) {
    _currentRegistry = new ForegroundLiveRegistry();
  }
  return _currentRegistry;
}

export function setForegroundLiveRegistry(registry: ForegroundLiveRegistry): void {
  _currentRegistry = registry;
}
