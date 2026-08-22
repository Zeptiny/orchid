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
 * - two attaches share one instance; two detaches release it
 * - a watcher error disables the instance without throwing into the coordinator
 * - rebind releases the old project's watcher while the new one keeps watching
 * - config `index_refresh.watch: false` never starts an instance
 * - an untrusted project never starts an instance; a trust grant starts one
 *   for the references windows already hold (without a second refcount)
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
  _setWatcherOptionsForTests,
  _getWorkspaceWatcherForTests,
  _awaitWorkspaceWatcherReadyForTests,
} from '../../src/main/indexing/watcher';
import {
  disposeIndexRefreshCoordinator,
  _setIndexRefreshCoordinatorForTests,
  _getPendingIndexRefreshForTests,
} from '../../src/main/indexing/refresh-coordinator';
import { ConfigManager } from '../../src/main/config/loader';
import { defaults, type Config } from '../../src/main/config';
import type { TrustState } from '../../src/shared/types/ipc';

vi.mock('../../src/main/utils/esm-import', () => ({
  importESM: vi.fn(async (specifier: string) => {
    if (specifier !== 'chokidar') {
      throw new Error(`unexpected ESM-only import in watcher test: ${specifier}`);
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

// Per-project config resolution routes through the test-home ConfigManager,
// keeping the watcher off the real ~/.orchid config.
vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({
    get: (_projectDir: string) => ({ config: ConfigManager.load() }),
  }),
}));

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

function pending(project: string) {
  return _getPendingIndexRefreshForTests(project);
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
  loadHomeConfig();
  mockTrust.state = 'trusted';
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  _setIndexRefreshCoordinatorForTests({ configLoader: () => coordinatorConfig });
  _setWatcherOptionsForTests({
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
});

afterEach(() => {
  disposeAllWorkspaceWatchers();
  _setWatcherOptionsForTests(null);
  disposeIndexRefreshCoordinator();
  _setIndexRefreshCoordinatorForTests({
    ragIndexer: null,
    astIndexer: null,
    configLoader: null,
  });
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
    await sleep(400);
    expect(pending(project).entries).toEqual([{ rel: 'src/ok.ts', op: 'upsert' }]);
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
    await sleep(400);
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
    fs.writeFileSync(
      homeConfigPath,
      JSON.stringify({ index_refresh: { watch: false } }),
    );
    loadHomeConfig();
    expect(ConfigManager.load().index_refresh.watch).toBe(false);

    attachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    fs.writeFileSync(path.join(project, 'no-watch.ts'), 'x');
    await sleep(400);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });
    expect(pending(project).entries).toEqual([]);

    detachWorkspaceWatcher(project);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 0 });
  });

  it('never starts an instance for an untrusted project; a grant starts it', async () => {
    mockTrust.state = 'untrusted';
    const project = makeProject('proj');
    attachWorkspaceWatcher(project);
    // The reference is held (refcount 1) but no instance is ever created.
    await sleep(200);
    expect(getWorkspaceWatcherState(project)).toEqual({ watching: false, refcount: 1 });

    fs.writeFileSync(path.join(project, 'untrusted.ts'), 'x');
    await sleep(400);
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
});
