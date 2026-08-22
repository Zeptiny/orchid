/**
 * Workspace watcher — external file changes feed the index refresh coordinator.
 *
 * One chokidar instance per watched project path, refcounted across the
 * windows/sessions that bind the same workspace. `add`/`change` enqueue
 * upserts, `unlink` enqueues deletes, `unlinkDir` marks the project dirty
 * (subtree membership is not cheaply known), `addDir` is ignored. The index
 * store root `.orchid` is hard-ignored regardless of config so refreshes never
 * observe their own index writes. Every event is wrapped: a watcher failure
 * logs, disables that project's instance, and never throws into the caller.
 */
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import { importESM } from '../utils/esm-import';
import { enqueueMutation, markDirty } from './refresh-coordinator';

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

/**
 * Default skip dirs shared by both indexers (AST `SKIP_DIRS` ∪ RAG
 * `DEFAULT_IGNORED_DIRS`), matched by directory name anywhere in the tree.
 */
const DEFAULT_SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '__pycache__',
  '.venv', 'venv', 'env',
  '.orchid', 'dist', 'build',
  '.next', '.cache', 'target',
]);

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
    chokidarModulePromise = importESM<ChokidarModule>('chokidar');
  }
  return chokidarModulePromise;
}

/**
 * Live `index_refresh.watch` read (checked at instance-creation and event
 * time). Config-load failure fails safe: no watching.
 */
function watchEnabled(): boolean {
  try {
    return getConfig().index_refresh.watch;
  } catch {
    return false;
  }
}

/**
 * Segment matcher mirroring the indexers' exact directory-name skip semantics:
 * any path segment (relative to the project root) naming a skipped directory
 * ignores the whole subtree.
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
  if (!watchEnabled()) return;
  entry.creating = true;
  try {
    const configIgnoredDirs = getConfig().ignored_dirs;
    const chokidar = await loadChokidar();
    if (watcherEntries.get(entry.projectPath) !== entry) return;
    if (entry.watcher !== null || entry.disabled) return;
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

function enqueueUpsert(entry: WatcherEntry, absPath: string): void {
  try {
    if (entry.watcher === null || !watchEnabled()) return;
    const rel = path.relative(entry.projectPath, absPath);
    if (rel === '' || rel.startsWith('..')) return;
    enqueueMutation(entry.projectPath, [{ rel, op: 'upsert' }]);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to enqueue upsert for ${absPath}`, error);
  }
}

function enqueueDelete(entry: WatcherEntry, absPath: string): void {
  try {
    if (entry.watcher === null || !watchEnabled()) return;
    const rel = path.relative(entry.projectPath, absPath);
    if (rel === '' || rel.startsWith('..')) return;
    enqueueMutation(entry.projectPath, [{ rel, op: 'delete' }]);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to enqueue delete for ${absPath}`, error);
  }
}

function markProjectDirty(entry: WatcherEntry): void {
  try {
    if (entry.watcher === null || !watchEnabled()) return;
    markDirty(entry.projectPath);
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to mark ${entry.projectPath} dirty`, error);
  }
}

/**
 * Attach a watcher for a project path (refcounted: the first attach for a
 * resolved path creates the chokidar instance, later attaches only increment).
 * Config `index_refresh.watch: false` never starts an instance; the refcount
 * is still tracked so the lifecycle stays balanced.
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
