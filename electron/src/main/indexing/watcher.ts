/**
 * Workspace watcher — external file changes feed the index refresh coordinator.
 *
 * One chokidar instance per watched project path, refcounted across the
 * windows/sessions that bind the same workspace. Untrusted projects never
 * get an instance (fail-closed trust gating, same gate as the rag/ast IPC);
 * config is resolved per project so `.orchid.json` overrides are
 * honored. `add`/`change` enqueue upserts, `unlink` enqueues deletes,
 * `unlinkDir` marks the project dirty (subtree membership is not cheaply
 * known), `addDir` is ignored. The index store root `.orchid` is hard-ignored
 * regardless of config so refreshes never observe their own index writes.
 * Every event is wrapped: a watcher failure logs, disables that project's
 * instance, and never throws into the caller. Config saves reconcile live
 * instances through `reconfigureWorkspaceWatchers`; the event-time config
 * check reads through a short TTL cache so per-event cost stays flat.
 */
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { getProjectTrustState } from '../project/trust';
import { importESM } from '../utils/esm-import';
import { enqueueMutation, markDirty } from './refresh-coordinator';
import { INDEX_SKIP_DIR_NAMES } from './skip-dirs';

type ChokidarModule = typeof import('chokidar');
type ChokidarOptions = import('chokidar').ChokidarOptions;
type ChokidarWatcher = import('chokidar').FSWatcher;

/** Minimal introspection surface (tests + diagnostics). */
export interface WorkspaceWatcherState {
  watching: boolean;
  refcount: number;
}

interface WatcherEntry {
  /** Resolved absolute project path (also the map key). */
  projectPath: string;
  refcount: number;
  watcher: ChokidarWatcher | null;
  creating: boolean;
  ready: Promise<void> | null;
  /** Set after a watcher error; blocks instance (re)creation while held. */
  disabled: boolean;
}

const LOG_PREFIX = '[index-watcher]';

/** Default skip dirs shared with both indexers, matched by directory name. */
const DEFAULT_SKIP_DIR_NAMES = new Set(INDEX_SKIP_DIR_NAMES);

/**
 * Always ignored regardless of config (R9): both index stores live under
 * `.orchid/`, so watching it would re-trigger refresh forever.
 */
const ALWAYS_SKIP_DIR_NAMES = new Set(['.orchid']);

/** Live watcher entries keyed by resolved project path. */
const watcherEntries = new Map<string, WatcherEntry>();

let chokidarModulePromise: Promise<ChokidarModule> | null = null;
let watcherOptionsOverride: ChokidarOptions | null = null;

function loadChokidar(): Promise<ChokidarModule> {
  if (chokidarModulePromise === null) {
    const attempt = importESM<ChokidarModule>('chokidar');
    // A rejected import must not stay memoized (P3 #1): one transient
    // failure would otherwise disable watching until restart. Clearing the
    // slot on rejection lets the next attach retry; the handler swallows the
    // rejection so callers still observe it (and log it) themselves.
    attempt.catch(() => {
      if (chokidarModulePromise === attempt) chokidarModulePromise = null;
    });
    chokidarModulePromise = attempt;
  }
  return chokidarModulePromise;
}

/**
 * Per-project config resolution: the project runtime registry applies the
 * project's `.orchid.json` layer; when the runtime cannot resolve the
 * directory the home-only config applies (mirrors the ipc/ast.ts fallback).
 * Config-load failure fails safe: null.
 */
function resolveProjectConfig(projectPath: string): Config | null {
  try {
    return getProjectRuntimeRegistry().get(projectPath).config;
  } catch {
    // Runtime cannot resolve the project — home-only config applies.
  }
  try {
    return getConfig();
  } catch {
    return null;
  }
}

/**
 * Trust gate (fail closed like the rag/ast IPC handlers): only `'trusted'`
 * projects may watch — `untrusted` and `changed` (drifted surface) never do.
 */
function projectTrusted(projectPath: string): boolean {
  try {
    return getProjectTrustState(projectPath) === 'trusted';
  } catch {
    return false;
  }
}

/**
 * Event-time config cache (Minor-a): `eventsEnabled` runs on *every* chokidar
 * event, and a fresh per-project resolution costs a registry miss (realpath +
 * config load) each time. Event-time checks therefore read through this short
 * TTL cache — a config flip lands within the TTL, and immediately on
 * `reconfigureWorkspaceWatchers` (which invalidates it). Instance-creation
 * captures (`ensureInstance`, `reconfigureWorkspaceWatchers`) always take the
 * fresh path above so a new instance never starts on a stale config.
 */
const WATCH_CONFIG_CACHE_TTL_MS = 5000;

let watcherConfigCacheTtlMs = WATCH_CONFIG_CACHE_TTL_MS;

const watcherConfigCache = new Map<string, { value: Config | null; expiresAt: number }>();

/** Cached resolution for event-time checks only (see above). */
function resolveProjectConfigCached(projectPath: string): Config | null {
  const key = path.resolve(projectPath);
  const now = Date.now();
  const cached = watcherConfigCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.value;
  const value = resolveProjectConfig(key);
  watcherConfigCache.set(key, { value, expiresAt: now + watcherConfigCacheTtlMs });
  return value;
}

/** Drop every cached event-time config read (config change / dispose / tests). */
function clearWatcherConfigCache(): void {
  watcherConfigCache.clear();
}

/**
 * Live `index_refresh.watch` read per project, checked at event time (cached —
 * see `resolveProjectConfigCached`). Config-load failure fails safe: no
 * watching.
 */
function watchEnabledForEvents(projectPath: string): boolean {
  const config = resolveProjectConfigCached(projectPath);
  return config !== null && config.index_refresh.watch;
}

/**
 * Segment matcher mirroring the indexers' exact directory-name skip semantics:
 * any path segment (relative to the project root) naming a skipped directory
 * ignores the whole subtree. Candidate paths are split on both `/` and `\`
 * (not `path.sep`) so win32-style event paths are filtered identically to
 * POSIX ones — chokidar reports host-separator paths, and the two must agree
 * for tests that exercise backslash paths on a POSIX host.
 */
function makeIgnoredMatcher(root: string, skipNames: Set<string>): (candidate: string) => boolean {
  return (candidate: string): boolean => {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
    const rel = path.relative(root, abs);
    if (rel === '') return false;
    const segments = rel.split(/[\\/]+/);
    return segments.some((segment) => skipNames.has(segment));
  };
}

/** @internal Test seam exposing the ignore matcher for direct unit tests. */
export function _makeIgnoredMatcherForTests(
  root: string,
  skipNames: Set<string>,
): (candidate: string) => boolean {
  return makeIgnoredMatcher(root, skipNames);
}

function buildChokidarOptions(projectPath: string, configIgnoredDirs: string[]): ChokidarOptions {
  const skipNames = new Set<string>([
    ...configIgnoredDirs,
    ...DEFAULT_SKIP_DIR_NAMES,
    ...ALWAYS_SKIP_DIR_NAMES,
  ]);
  const options: ChokidarOptions = {
    ignored: makeIgnoredMatcher(projectPath, skipNames),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  };
  return watcherOptionsOverride === null ? options : { ...options, ...watcherOptionsOverride };
}

/** Log and disable a project's instance; the command dirty-flag stays as floor. */
function disableEntry(entry: WatcherEntry): void {
  entry.disabled = true;
  const watcher = entry.watcher;
  entry.watcher = null;
  if (watcher !== null) void watcher.close().catch(() => {});
}

async function ensureInstance(entry: WatcherEntry): Promise<void> {
  if (entry.watcher !== null || entry.disabled || entry.creating) return;
  if (!projectTrusted(entry.projectPath)) return;
  const config = resolveProjectConfig(entry.projectPath);
  if (config === null || !config.index_refresh.watch) return;
  entry.creating = true;
  try {
    const chokidar = await loadChokidar();
    if (watcherEntries.get(entry.projectPath) !== entry) return;
    if (entry.watcher !== null || entry.disabled) return;
    // Re-resolve after the await: a config change (or a load failure) that
    // landed while chokidar was loading must not leave an unwanted instance.
    const liveConfig = resolveProjectConfig(entry.projectPath);
    if (liveConfig === null || !liveConfig.index_refresh.watch) return;
    const configIgnoredDirs = liveConfig.ignored_dirs;
    const watcher = chokidar.watch(entry.projectPath, buildChokidarOptions(entry.projectPath, configIgnoredDirs));
    entry.watcher = watcher;
    entry.ready = new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });
    watcher.on('add', (absPath) => enqueueUpsert(entry, absPath));
    watcher.on('change', (absPath) => enqueueUpsert(entry, absPath));
    watcher.on('unlink', (absPath) => enqueueDelete(entry, absPath));
    watcher.on('unlinkDir', () => markProjectDirty(entry));
    watcher.on('error', (error) => {
      console.warn(`${LOG_PREFIX} watcher error for ${entry.projectPath}; disabling`, error);
      disableEntry(entry);
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to start watcher for ${entry.projectPath}`, error);
  } finally {
    entry.creating = false;
  }
}

/**
 * Event-time guard (cheap belt-and-braces — events cannot fire without an
 * instance, and revocation detaches the instance): the watcher is alive, the
 * project is still trusted, and watching is still enabled.
 */
function eventsEnabled(entry: WatcherEntry): boolean {
  if (entry.watcher === null) return false;
  if (!projectTrusted(entry.projectPath)) return false;
  return watchEnabledForEvents(entry.projectPath);
}

/**
 * Exact `..`-segment escape check: a workspace-relative path is outside only
 * when it is `..` itself or starts with a `..` path segment. A file literally
 * named `..notes.ts` at the root stays inside.
 */
function isInsideWorkspaceRel(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../');
}

function enqueueUpsert(entry: WatcherEntry, absPath: string): void {
  try {
    if (!eventsEnabled(entry)) return;
    const rel = path.relative(entry.projectPath, absPath);
    if (!isInsideWorkspaceRel(rel)) return;
    enqueueMutation(entry.projectPath, [{ rel, op: 'upsert' }]);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to enqueue upsert for ${absPath}`, error);
  }
}

function enqueueDelete(entry: WatcherEntry, absPath: string): void {
  try {
    if (!eventsEnabled(entry)) return;
    const rel = path.relative(entry.projectPath, absPath);
    if (!isInsideWorkspaceRel(rel)) return;
    enqueueMutation(entry.projectPath, [{ rel, op: 'delete' }]);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to enqueue delete for ${absPath}`, error);
  }
}

function markProjectDirty(entry: WatcherEntry): void {
  try {
    if (!eventsEnabled(entry)) return;
    markDirty(entry.projectPath);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to mark ${entry.projectPath} dirty`, error);
  }
}

/**
 * Attach a watcher for a project path (refcounted: the first attach for a
 * resolved path creates the chokidar instance, later attaches only increment).
 * Config `index_refresh.watch: false` and untrusted projects never start an
 * instance; the refcount is still tracked so the lifecycle stays balanced.
 */
export function attachWorkspaceWatcher(projectPath: string): void {
  const key = path.resolve(projectPath);
  let entry = watcherEntries.get(key);
  if (!entry) {
    entry = {
      projectPath: key,
      refcount: 0,
      watcher: null,
      creating: false,
      ready: null,
      disabled: false,
    };
    watcherEntries.set(key, entry);
  }
  entry.refcount += 1;
  void ensureInstance(entry);
}

/**
 * Trust-grant hook: (re)attempt instance creation for a project that windows
 * already reference. A project bound while untrusted holds a refcount but no
 * instance, so the grant is what starts it. Never adjusts refcounts — a
 * project already watching is left untouched (no second reference that no
 * detach would release), and a project no window holds stays unattached
 * (the next workspace transition attaches it normally).
 */
export function ensureWorkspaceWatcherStarted(projectPath: string): void {
  const entry = watcherEntries.get(path.resolve(projectPath));
  if (!entry) return;
  void ensureInstance(entry);
}

/** Close a live instance without touching the refcount or `disabled` flag. */
function closeInstance(entry: WatcherEntry, reason: string): void {
  const watcher = entry.watcher;
  entry.watcher = null;
  entry.ready = null;
  if (watcher === null) return;
  console.warn(`${LOG_PREFIX} closing watcher for ${entry.projectPath} (${reason})`);
  void watcher.close().catch(() => {});
}

/**
 * Config-change hook (P3 #6 / #13): re-resolve per-project config for every
 * entry a window still references and reconcile the live instances.
 *
 * For each entry with `refcount > 0`:
 * - `index_refresh.watch` is now false (or config fails to load) → close the
 *   instance. The reference is kept so re-enabling (or a later rebind) can
 *   start it again without an unbalanced refcount.
 * - watch is true but no instance exists (toggled on while held, or a project
 *   granted trust while watch was false) → create one, capturing the current
 *   `ignored_dirs`.
 * - watch is true and a healthy instance exists → leave it alone. In
 *   particular an `ignored_dirs` edit does not restart a live instance; the
 *   new list is captured the next time an instance is created.
 *
 * Never throws — callers hook this fire-and-forget behind config saves, which
 * must not fail because of watching.
 */
export function reconfigureWorkspaceWatchers(): void {
  // The event-time cache must not keep serving the previous config.
  clearWatcherConfigCache();
  for (const entry of [...watcherEntries.values()]) {
    try {
      if (entry.refcount <= 0) continue;
      // Fresh (uncached) read: an instance must never start on stale config.
      const config = resolveProjectConfig(entry.projectPath);
      const watch = config !== null && config.index_refresh.watch;
      if (!watch) {
        if (entry.watcher !== null) closeInstance(entry, 'index_refresh.watch is false');
        continue;
      }
      if (entry.watcher === null && !entry.disabled && !entry.creating) {
        void ensureInstance(entry);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} reconfigure failed for ${entry.projectPath}`, error);
    }
  }
}

/**
 * Detach one reference; the last detach closes and releases the instance.
 * Detaching a path with no live entry is a no-op.
 */
export function detachWorkspaceWatcher(projectPath: string): void {
  const key = path.resolve(projectPath);
  const entry = watcherEntries.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount > 0) return;
  watcherEntries.delete(key);
  if (entry.watcher !== null) {
    const watcher = entry.watcher;
    entry.watcher = null;
    void watcher.close().catch(() => {});
  }
}

/** Close every watcher and drop all refcounts (shutdown + tests). */
export function disposeAllWorkspaceWatchers(): void {
  for (const entry of watcherEntries.values()) {
    entry.disabled = true;
    const watcher = entry.watcher;
    entry.watcher = null;
    entry.refcount = 0;
    if (watcher !== null) void watcher.close().catch(() => {});
  }
  watcherEntries.clear();
  clearWatcherConfigCache();
}

/**
 * Watcher introspection: per-project (refcount of that entry) or aggregated
 * across every live entry when no path is given.
 */
export function getWorkspaceWatcherState(projectPath?: string): WorkspaceWatcherState {
  if (projectPath !== undefined) {
    const entry = watcherEntries.get(path.resolve(projectPath));
    if (!entry) return { watching: false, refcount: 0 };
    return { watching: entry.watcher !== null, refcount: entry.refcount };
  }
  let watching = false;
  let refcount = 0;
  for (const entry of watcherEntries.values()) {
    if (entry.watcher !== null) watching = true;
    refcount += entry.refcount;
  }
  return { watching, refcount };
}

/**
 * @internal Test-only chokidar options override merged over the computed
 * options (pass null to reset). Mirrors the coordinator's override seams.
 */
export function _setWatcherOptionsForTests(overrides: ChokidarOptions | null): void {
  watcherOptionsOverride = overrides;
}

/**
 * @internal Test-only TTL override for the event-time config cache so expiry
 * can be exercised without a 5s wait (pass 5000 to restore the default).
 */
export function _setWatcherConfigCacheTtlForTests(ttlMs: number): void {
  watcherConfigCacheTtlMs = ttlMs;
}

/** @internal Test-only cache drop (the invalidation reconfigure performs). */
export function _clearWatcherConfigCacheForTests(): void {
  clearWatcherConfigCache();
}

/**
 * @internal Test-only: forget the memoized chokidar module promise so a test
 * can exercise the rejection/retry path of `loadChokidar` even after an
 * earlier successful load in the same process.
 */
export function _resetChokidarLoadForTests(): void {
  chokidarModulePromise = null;
}

/**
 * @internal Test-only raw instance accessor, e.g. to simulate a watcher error
 * by emitting `'error'` on it.
 */
export function _getWorkspaceWatcherForTests(projectPath: string): ChokidarWatcher | null {
  return watcherEntries.get(path.resolve(projectPath))?.watcher ?? null;
}

/**
 * @internal Test-only readiness gate resolving when the project's initial
 * scan finished ('ready'); events for pre-existing files are suppressed by
 * `ignoreInitial`, so tests must await this before mutating the tree.
 */
export async function _awaitWorkspaceWatcherReadyForTests(
  projectPath: string,
  timeoutMs = 5000,
): Promise<void> {
  const key = path.resolve(projectPath);
  const deadline = Date.now() + timeoutMs;
  let entry = watcherEntries.get(key);
  while ((entry?.ready ?? null) === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    entry = watcherEntries.get(key);
  }
  if (!entry || entry.ready === null) {
    throw new Error(`No watcher instance for ${projectPath}`);
  }
  await Promise.race([
    entry.ready,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Watcher for ${projectPath} not ready`)), timeoutMs);
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    }),
  ]);
}
