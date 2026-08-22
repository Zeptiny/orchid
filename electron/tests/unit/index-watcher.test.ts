/**
 * Workspace watcher tests — U6.
 *
 * Chokidar watches a real temp directory (no fake timers); events are awaited
 * with poll-based waits and a short awaitWriteFinish injected through the
 * options test seam. Trust and the project runtime registry are module mocks
 * (the registry routes every per-project config read through the test-home
 * ConfigManager), and mutations enqueue into the real refresh coordinator,
 * observed via `_getPendingIndexRefreshForTests`; the coordinator's config
 * override disables both indexes (and stretches the debounce) so no flush can
 * ever reach a real indexer.
 *
 * Covers:
 * - add and change events enqueue an upsert for the rel path
 * - unlink enqueues a delete; unlinkDir marks the project dirty
 * - events under `.orchid/` and node_modules are filtered before enqueue
 * - the ignore matcher filters win32-style backslash paths like POSIX ones
 * - two attaches share one instance; two detaches release it
 * - a watcher error disables the instance without throwing into the coordinator
 * - rebind releases the old project's watcher while the new one keeps watching
 * - config `index_refresh.watch: false` never starts an instance
 * - an untrusted project never starts an instance; a trust grant starts one
 *   for the references windows already hold (without a second refcount)
 * - a rejected chokidar import is not memoized (a later attach retries it)
 * - reconfigureWorkspaceWatchers applies runtime config changes to instances
 * - the event-time config read is TTL-cached and invalidated on reconfigure
 * - a config that fails to load fails safe: no instance, no throw, no entries
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  attachWorkspaceWatcher,
  detachWorkspaceWatcher,
  disposeAllWorkspaceWatchers,
  ensureWorkspaceWatcherStarted,
  getWorkspaceWatcherState,
  reconfigureWorkspaceWatchers,
  _setWatcherOptionsForTests,
  _getWorkspaceWatcherForTests,
  _awaitWorkspaceWatcherReadyForTests,
  _makeIgnoredMatcherForTests,
  _clearWatcherConfigCacheForTests,
  _setWatcherConfigCacheTtlForTests,
  _resetChokidarLoadForTests,
} from '../../src/main/indexing/watcher';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
  _getPendingIndexRefreshForTests,
} from '../../src/main/indexing/refresh-coordinator';
import { ConfigManager } from '../../src/main/config/loader';
import { defaults, type Config } from '../../src/main/config';
import type { TrustState } from '../../src/shared/types/ipc';

/** Controllable ESM loader: `failures` counts down rejected chokidar imports. */
const mockEsm = vi.hoisted(() => ({ failures: 0 }));

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async (specifier: string) => {
    if (specifier !== 'chokidar') {
      throw new Error(`unexpected ESM-only import in watcher test: ${specifier}`);
    }
    if (mockEsm.failures > 0) {
      mockEsm.failures -= 1;
      throw new Error('simulated transient chokidar import failure');
    }
    return import('chokidar');
  }),
}));

// Trust gate control: default trusted (existing fixtures are bare projects);
// the trust test flips to untrusted and back to simulate revoke/grant.
const mockTrust = vi.hoisted(() => ({
  state: 'trusted' as TrustState,
}));

vi.mock('../../src/main/project/trust', () => ({
  getProjectTrustState: (_dir: string) => mockTrust.state,
}));

/**
 * Test-home config location, held in a hoisted mutable because the mock
 * factories below run before the test body assigns the temp directories.
 * Routing every load through it keeps the watcher (both the registry path and
 * the home-config fallback) off the developer's real `~/.orchid/config.json`.
 */
const mockHome = vi.hoisted(() => ({
  loadOptions: null as { homeConfigPath: string; projectDir: string } | null,
}));

// Per-project config resolution routes through the test-home ConfigManager,
// keeping the watcher off the real ~/.orchid config.
vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    get: (_projectDir: string) => ({
      config: ConfigManager.load(mockHome.loadOptions ?? undefined),
    }),
  }),
}));

// The watcher's home-config fallback (`getConfig`) must resolve the same
// test-home config the registry path does, or a deliberately broken config
// would be masked by a successful read of the real home config.
vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => actual.ConfigManager.load(mockHome.loadOptions ?? undefined),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let root: string;
let homeDir: string;
let homeConfigPath: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const coordinatorConfig: Config = {
  ...defaults(),
  index_refresh: { ...defaults().index_refresh, rag: false, ast: false, debounce_ms: 60_000 },
};

function makeProject(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return dir;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  expect(predicate(), 'waitFor timed out').toBe(true);
}

/**
 * Bounded settle wait for *negative* assertions: absence of an event cannot be
 * polled for, so the delivery path is proven alive first (a control event
 * awaited with `waitFor`) and only then is the quiet window sampled. Generous
 * against the injected 60ms awaitWriteFinish threshold.
 */
async function settle(ms = 400): Promise<void> {
  await sleep(ms);
}

/** Replace the home config wholesale and reload it into ConfigManager. */
function writeHomeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(homeConfigPath, JSON.stringify(config));
  loadHomeConfig();
}

function pending(project: string) {
  return _getPendingIndexRefreshForTests(project);
}

function pendingRels(project: string): string[] {
  return pending(project).entries.map((entry) => entry.rel);
}

function loadHomeConfig(): void {
  ConfigManager.reset();
  ConfigManager.load({ homeConfigPath: homeConfigPath, projectDir: homeDir });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-index-watcher-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-index-watcher-home-'));
  homeConfigPath = path.join(homeDir, 'config.json');
  mockHome.loadOptions = { homeConfigPath: homeConfigPath, projectDir: homeDir };
  loadHomeConfig();
  mockTrust.state = 'trusted';
  mockEsm.failures = 0;
  _setWatcherConfigCacheTtlForTests(5000);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  _setIndexRefreshCoordinatorForTests({ configLoader: () => coordinatorConfig });
  _setWatcherOptionsForTests({
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
});

afterEach(() => {
  disposeAllWorkspaceWatchers();
  _setWatcherOptionsForTests(null);
  _setWatcherConfigCacheTtlForTests(5000);
  _clearWatcherConfigCacheForTests();
  disposeIndexRefreshCoordinator();
  _setIndexRefreshCoordinatorForTests({
    ragIndexer: null,
    astIndexer: null,
    configLoader: null,
  });
  mockEsm.failures = 0;
  warnSpy.mockRestore();
  ConfigManager.reset();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspace watcher', () => {
  it('enqueues an upsert for added and changed files', async () => {
    const project = makeProject('proj');
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });

    fs.writeFileSync(path.join(project, 'a.ts'), 'export const a = 1;\n');
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'a.ts' && entry.op === 'upsert'),
    );

    disposeIndexRefreshCoordinator();
    fs.appendFileSync(path.join(project, 'a.ts'), 'export const b = 2;\n');
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'a.ts' && entry.op === 'upsert'),
    );
  });

  it('enqueues a delete for unlinked files and marks the project dirty on unlinkDir', async () => {
    const project = makeProject('proj');
    fs.mkdirSync(path.join(project, 'sub'));
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);

    fs.writeFileSync(path.join(project, 'gone.ts'), 'x');
    await waitFor(() => pending(project).entries.length > 0);

    fs.unlinkSync(path.join(project, 'gone.ts'));
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'gone.ts' && entry.op === 'delete'),
    );

    disposeIndexRefreshCoordinator();
    fs.rmSync(path.join(project, 'sub'), { recursive: true });
    await waitFor(() => pending(project).dirty === true);
    expect(pending(project).entries).toEqual([]);
  });

  it('filters events under .orchid/ and node_modules before enqueue', async () => {
    const project = makeProject('proj');
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);

    fs.mkdirSync(path.join(project, '.orchid', 'rag'), { recursive: true });
    fs.mkdirSync(path.join(project, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, '.orchid', 'rag', 'store.db'), 'x');
    fs.writeFileSync(path.join(project, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.writeFileSync(path.join(project, 'src', 'ok.ts'), 'x');

    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'src/ok.ts' && entry.op === 'upsert'),
    );
    // Control delivery is awaited first; the quiet window only rules out the
    // writes that precede it.
    fs.writeFileSync(path.join(project, 'src', 'control.ts'), 'x');
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'src/control.ts' && entry.op === 'upsert'),
    );
    await settle();
    expect(pending(project).entries).toEqual([
      { rel: 'src/ok.ts', op: 'upsert' },
      { rel: 'src/control.ts', op: 'upsert' },
    ]);
    expect(pending(project).dirty).toBe(false);
  });

  it('shares one instance across attaches and releases it on the last detach', async () => {
    const project = makeProject('proj');
    attachWorkspaceWatcher(project);
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);

    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 2 });
    expect(getWorkspaceWatcherState()).toEqual({ watching: true, refcount: 2 });

    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });

    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 0 });
    expect(getWorkspaceWatcherState()).toEqual({ watching: false, refcount: 0 });
  });

  it('disables the instance on a watcher error without throwing', async () => {
    const project = makeProject('proj');
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);

    const watcher = _getWorkspaceWatcherForTests(project);
    expect(watcher).not.toBeNull();
    watcher!.emit('error', new Error('inotify limit reached'));

    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[index-watcher] watcher error for'),
      expect.any(Error),
    );

    fs.writeFileSync(path.join(project, 'after-error.ts'), 'x');
    await settle();
    expect(pending(project).entries).toEqual([]);
  });

  it('releases the old project on rebind while the new project keeps watching', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    attachWorkspaceWatcher(a);
    attachWorkspaceWatcher(b);
    await _awaitWorkspaceWatcherReadyForTests(a);
    await _awaitWorkspaceWatcherReadyForTests(b);

    detachWorkspaceWatcher(a);
    expect(getWorkspaceWatcherState(a)).toEqual({ watching: false, refcount: 0 });
    expect(getWorkspaceWatcherState(b)).toEqual({ watching: true, refcount: 1 });

    fs.writeFileSync(path.join(b, 'kept.ts'), 'x');
    await waitFor(() =>
      pending(b).entries.some((entry) => entry.rel === 'kept.ts' && entry.op === 'upsert'),
    );
  });

  it('never starts an instance when index_refresh.watch is false', async () => {
    const project = makeProject('proj');
    writeHomeConfig({ index_refresh: { watch: false } });
    expect(ConfigManager.load().index_refresh.watch).toBe(false);

    attachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    fs.writeFileSync(path.join(project, 'no-watch.ts'), 'x');
    await settle();
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });
    expect(pending(project).entries).toEqual([]);

    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 0 });
  });

  it('never starts an instance for an untrusted project; a grant starts it', async () => {
    mockTrust.state = 'untrusted';
    const project = makeProject('proj');
    attachWorkspaceWatcher(project);
    // The reference is held (refcount 1) but no instance is ever created —
    // the trust check runs synchronously before any await, so only the event
    // loop needs to turn for the (rejected) creation attempt to settle.
    await settle(100);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    fs.writeFileSync(path.join(project, 'untrusted.ts'), 'x');
    await settle();
    expect(pending(project).entries).toEqual([]);

    // Grant: the held reference gains an instance without a second refcount.
    mockTrust.state = 'trusted';
    ensureWorkspaceWatcherStarted(project);
    await _awaitWorkspaceWatcherReadyForTests(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });

    fs.writeFileSync(path.join(project, 'seen.ts'), 'x');
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'seen.ts' && entry.op === 'upsert'),
    );
  });

  it('leaves projects no window holds unattached on grant', async () => {
    mockTrust.state = 'untrusted';
    const bound = makeProject('bound');
    const unbound = makeProject('unbound');
    attachWorkspaceWatcher(bound);

    mockTrust.state = 'trusted';
    ensureWorkspaceWatcherStarted(bound);
    await _awaitWorkspaceWatcherReadyForTests(bound);
    expect(getWorkspaceWatcherState(bound)).toEqual({ watching: true, refcount: 1 });

    // No reference exists for the unbound project — the grant must not
    // attach one that no detach would release.
    ensureWorkspaceWatcherStarted(unbound);
    expect(getWorkspaceWatcherState(unbound)).toEqual({ watching: false, refcount: 0 });
    expect(getWorkspaceWatcherState()).toEqual({ watching: true, refcount: 1 });
  });

  it('keeps watching a path another window still holds after one rebinds away', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    // Two windows on `a`; the first then rebinds to `b`.
    attachWorkspaceWatcher(a);
    attachWorkspaceWatcher(a);
    attachWorkspaceWatcher(b);
    detachWorkspaceWatcher(a);
    await _awaitWorkspaceWatcherReadyForTests(a);
    await _awaitWorkspaceWatcherReadyForTests(b);
    expect(getWorkspaceWatcherState(a)).toEqual({ watching: true, refcount: 1 });
    expect(getWorkspaceWatcherState(b)).toEqual({ watching: true, refcount: 1 });

    // The surviving holder keeps receiving events.
    fs.writeFileSync(path.join(a, 'held.ts'), 'x');
    await waitFor(() =>
      pending(a).entries.some((entry) => entry.rel === 'held.ts' && entry.op === 'upsert'),
    );

    // The last holder rebinds away too: the instance closes and stops
    // delivering. `b`'s delivery is the control event proving the pipeline
    // stayed alive past the write that `a` must not report.
    disposeIndexRefreshCoordinator();
    detachWorkspaceWatcher(a);
    expect(getWorkspaceWatcherState(a)).toEqual({ watching: false, refcount: 0 });
    fs.writeFileSync(path.join(a, 'released.ts'), 'x');
    fs.writeFileSync(path.join(b, 'still-watched.ts'), 'x');
    await waitFor(() =>
      pending(b).entries.some((entry) => entry.rel === 'still-watched.ts' && entry.op === 'upsert'),
    );
    await settle();
    expect(pending(a).entries).toEqual([]);
    expect(getWorkspaceWatcherState()).toEqual({ watching: true, refcount: 1 });
  });

  it('retries the chokidar import after a transient failure instead of caching the rejection', async () => {
    const project = makeProject('proj');
    _resetChokidarLoadForTests();
    mockEsm.failures = 1;

    attachWorkspaceWatcher(project);
    await settle(100);
    // The reference is held, the failure is logged, nothing throws.
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to start watcher for'),
      expect.any(Error),
    );

    // The rejected import is not memoized: a later attempt retries the load
    // and starts the instance for the reference windows already hold.
    ensureWorkspaceWatcherStarted(project);
    await _awaitWorkspaceWatcherReadyForTests(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });

    fs.writeFileSync(path.join(project, 'after-retry.ts'), 'x');
    await waitFor(() =>
      pending(project).entries.some(
        (entry) => entry.rel === 'after-retry.ts' && entry.op === 'upsert',
      ),
    );
  });

  it('applies runtime config changes to live instances through reconfigureWorkspaceWatchers', async () => {
    const project = makeProject('proj');
    writeHomeConfig({ index_refresh: { watch: false } });

    // Bound while watch is false: reference held, no instance.
    attachWorkspaceWatcher(project);
    await settle(100);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    // Watch enabled (covers both the toggle-on and the "trust granted while
    // watch was false" shapes): an instance appears with no extra refcount.
    writeHomeConfig({ index_refresh: { watch: true } });
    reconfigureWorkspaceWatchers();
    await _awaitWorkspaceWatcherReadyForTests(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });
    fs.writeFileSync(path.join(project, 'on.ts'), 'x');
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'on.ts' && entry.op === 'upsert'),
    );

    // A reconfigure that changes nothing relevant leaves the instance alone.
    const healthy = _getWorkspaceWatcherForTests(project);
    reconfigureWorkspaceWatchers();
    expect(_getWorkspaceWatcherForTests(project)).toBe(healthy);

    // Watch disabled: the instance closes while the reference is kept.
    disposeIndexRefreshCoordinator();
    writeHomeConfig({ index_refresh: { watch: false } });
    reconfigureWorkspaceWatchers();
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });
    fs.writeFileSync(path.join(project, 'off.ts'), 'x');
    await settle();
    expect(pending(project).entries).toEqual([]);

    // Re-enabled: the recreated instance captures the *current* ignored_dirs.
    writeHomeConfig({
      index_refresh: { watch: true },
      ignored_dirs: ['generated'],
    });
    reconfigureWorkspaceWatchers();
    await _awaitWorkspaceWatcherReadyForTests(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });
    expect(_getWorkspaceWatcherForTests(project)).not.toBe(healthy);

    fs.mkdirSync(path.join(project, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(project, 'generated', 'skip-me.ts'), 'x');
    fs.writeFileSync(path.join(project, 'captured.ts'), 'x');
    await waitFor(() =>
      pending(project).entries.some((entry) => entry.rel === 'captured.ts' && entry.op === 'upsert'),
    );
    await settle();
    expect(pending(project).entries).toEqual([{ rel: 'captured.ts', op: 'upsert' }]);

    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 0 });
  });

  it('skips entries no window references when reconfiguring', async () => {
    const project = makeProject('proj');
    writeHomeConfig({ index_refresh: { watch: false } });
    attachWorkspaceWatcher(project);
    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState()).toEqual({ watching: false, refcount: 0 });

    writeHomeConfig({ index_refresh: { watch: true } });
    expect(() => reconfigureWorkspaceWatchers()).not.toThrow();
    await settle(100);
    // A released project must not be resurrected by a config change.
    expect(getWorkspaceWatcherState()).toEqual({ watching: false, refcount: 0 });
  });

  it('caches the event-time config read and drops it on invalidation', async () => {
    const project = makeProject('proj');
    // Long TTL so the assertions below cannot race an expiry.
    _setWatcherConfigCacheTtlForTests(60_000);
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);

    // Warm the event-time cache with watch still enabled.
    fs.writeFileSync(path.join(project, 'warm.ts'), 'x');
    await waitFor(() => pendingRels(project).includes('warm.ts'));

    // Flipping watch off on disk does not reach the event-time guard while the
    // cached resolution is still served (this is the documented TTL trade-off).
    writeHomeConfig({ index_refresh: { watch: false } });
    fs.writeFileSync(path.join(project, 'stale.ts'), 'x');
    await waitFor(() => pendingRels(project).includes('stale.ts'));
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });

    // Invalidating the cache — what reconfigureWorkspaceWatchers does — makes
    // the very next event fail safe.
    _clearWatcherConfigCacheForTests();
    fs.writeFileSync(path.join(project, 'filtered.ts'), 'x');
    await settle();
    expect(pendingRels(project)).not.toContain('filtered.ts');

    // The reconfigure path itself invalidates the same cache: it closes the
    // instance for the held reference.
    reconfigureWorkspaceWatchers();
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });
  });

  it('re-reads the event-time config once the cache TTL expires', async () => {
    const project = makeProject('proj');
    _setWatcherConfigCacheTtlForTests(50);
    attachWorkspaceWatcher(project);
    await _awaitWorkspaceWatcherReadyForTests(project);

    fs.writeFileSync(path.join(project, 'warm.ts'), 'x');
    await waitFor(() => pendingRels(project).includes('warm.ts'));

    writeHomeConfig({ index_refresh: { watch: false } });
    await settle(250);
    fs.writeFileSync(path.join(project, 'expired.ts'), 'x');
    await settle();
    expect(pendingRels(project)).not.toContain('expired.ts');
    // The instance itself is untouched — only the event-time guard read stale.
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: true, refcount: 1 });
  });

  it('fails safe when the config cannot be loaded before attach', async () => {
    const project = makeProject('proj');
    // Schema-invalid config: every load throws, so the watcher must treat the
    // project as unwatchable instead of propagating the failure.
    fs.writeFileSync(homeConfigPath, JSON.stringify({ index_refresh: { watch: 'yes' } }));
    expect(() => loadHomeConfig()).toThrow();

    expect(() => attachWorkspaceWatcher(project)).not.toThrow();
    await settle(100);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    fs.writeFileSync(path.join(project, 'broken.ts'), 'x');
    await settle();
    expect(pending(project).entries).toEqual([]);
    expect(pending(project).dirty).toBe(false);

    // A reconfigure on a broken config must not throw or start anything.
    expect(() => reconfigureWorkspaceWatchers()).not.toThrow();
    await settle(100);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 0 });
    expect(getWorkspaceWatcherState()).toEqual({ watching: false, refcount: 0 });
  });

  describe('ignore matcher', () => {
    const skipNames = new Set(['node_modules', '.orchid', 'generated']);

    it('filters win32-style backslash paths exactly like POSIX ones', () => {
      const rootWin = 'C:\\proj';
      const matcher = _makeIgnoredMatcherForTests(rootWin, skipNames);

      // Relative candidates separated by backslashes only.
      expect(matcher(path.win32.join('node_modules', 'pkg', 'index.js'))).toBe(true);
      expect(matcher(path.win32.join('generated', 'out.ts'))).toBe(true);
      expect(matcher(path.win32.join('src', 'ok.ts'))).toBe(false);

      // Absolute win32 candidates (drive letter + backslashes) — what chokidar
      // reports on Windows.
      expect(matcher(path.win32.join(rootWin, 'node_modules', 'pkg', 'index.js'))).toBe(true);
      expect(matcher(path.win32.join(rootWin, 'deep', '.orchid', 'rag', 'store.db'))).toBe(true);
      expect(matcher(path.win32.join(rootWin, 'src', 'ok.ts'))).toBe(false);
      expect(matcher(rootWin)).toBe(false);

      // POSIX separators behave identically.
      expect(matcher('node_modules/pkg/index.js')).toBe(true);
      expect(matcher('src/ok.ts')).toBe(false);
    });

    it('ignores a whole subtree whose parent segment names a skipped directory', () => {
      const project = makeProject('matcher');
      const matcher = _makeIgnoredMatcherForTests(project, skipNames);

      expect(matcher(path.join(project, 'node_modules', 'pkg', 'deep', 'index.js'))).toBe(true);
      expect(matcher(path.join(project, 'src', 'nested', 'ok.ts'))).toBe(false);
      // A directory *name* must match exactly, never as a substring.
      expect(matcher(path.join(project, 'src', 'node_modules-ish', 'ok.ts'))).toBe(false);
      expect(matcher(project)).toBe(false);
    });
  });
});
