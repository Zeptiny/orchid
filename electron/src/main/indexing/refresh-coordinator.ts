/**
 * Index refresh coordinator — debounced, coalesced RAG/AST index updates.
 *
 * Producers (tool dispatch, the workspace watcher) enqueue file mutations or
 * mark a project dirty; a per-project debounce timer flushes one coalesced
 * batch into the indexers' incremental-update APIs (plus a full hash-diff
 * scan when dirty). Everything is fire-and-forget: any failure is logged and
 * dropped so a background refresh can never fail the work that caused it.
 * Flushes fail closed on project trust (same gate as the rag/ast IPC) and
 * resolve config per project so `.orchid.json` overrides are honored.
 *
 * Observability: a branch that lands work stamps the store's separate
 * `last_auto_refresh` meta key and — via the wired notifier — triggers the
 * `index:auto_refresh` lifecycle broadcast (started/landed/settled) so the
 * renderer sees live busy state and fresh statuses without polling.
 * `last_indexed` stays reserved for manual/full index runs.
 *
 * Reliability rails:
 * - The debounce is bounded by a max-wait anchored at the first pending
 *   mutation, so sustained sub-window churn can never postpone a flush forever.
 * - A failed flush retries once via the dirty hash-diff scan (content state is
 *   unknown after a partial run); a second consecutive failure drops.
 * - Each index branch runs under a watchdog timeout so a wedged indexer run
 *   is abandoned instead of wedging the flushing flag.
 * - A RAG single-flight sentinel requeues only the entries RAG still owes;
 *   entries the other index already consumed stay consumed.
 */
import * as path from 'node:path';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import * as ragIndexer from '../rag/indexer';
import * as astIndexer from '../ast/indexer';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { getProjectTrustState } from '../project/trust';
import type { RAGIndexResult } from '../../shared/types/ipc-boundary';
import type { TrustState } from '../../shared/types/ipc';

/** The RAG indexer surface the coordinator consumes. */
export type RefreshRagIndexer = Pick<
  typeof ragIndexer,
  'upsertFiles' | 'deleteFiles' | 'indexProject' | 'touchAutoRefresh'
>;

/** The AST indexer surface the coordinator consumes. */
export type RefreshAstIndexer = Pick<
  typeof astIndexer,
  'upsertFiles' | 'deleteFiles' | 'indexProject' | 'touchAutoRefresh'
>;

/** One queued file mutation. */
export interface IndexMutationEntry {
  /** Project-relative mutated file path. */
  rel: string;
  /** `upsert` = added/changed, `delete` = removed. */
  op: 'upsert' | 'delete';
}

type IndexMutationOp = IndexMutationEntry['op'];

/**
 * Which indexes still owe a pending entry. Freshly enqueued entries are owed
 * by both; a sentinel requeue narrows the scope so the other index does not
 * redundantly re-process entries it already consumed.
 */
type RefreshScope = 'both' | 'rag' | 'ast';

/** Outcome of one index's flush work. */
type BranchOutcome = 'ok' | 'failed' | 'timeout';

/** Snapshot of a project's coordinator state (test observation only). */
export interface IndexRefreshPendingState {
  entries: IndexMutationEntry[];
  dirty: boolean;
  timerArmed: boolean;
  flushing: boolean;
}

interface ProjectRefreshState {
  /** Resolved absolute project path (also the map key). */
  projectPath: string;
  /** Pending mutations keyed by rel path; last write wins. */
  pending: Map<string, IndexMutationOp>;
  /** Per-rel refresh scope: which indexes still owe the pending entry. */
  scopes: Map<string, RefreshScope>;
  /** Set when a full hash-diff scan is needed on the next flush. */
  dirty: boolean;
  /**
   * Max-wait anchor: when this batch first became pending (null while the
   * queue is fully drained).
   */
  firstPendingAt: number | null;
  /** True once a failed flush has been retried (bounds failure retries to one per batch). */
  failureRetried: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** True while a flush is executing for this project. */
  flushing: boolean;
  /** The in-flight runFlush promise, if any (awaited by the async dispose). */
  flushPromise: Promise<void> | null;
  /**
   * Set by {@link cancelProjectRefresh} before the state is dropped: an
   * in-flight flush still holding this state must observe the flag in its
   * requeue / retry / finally paths and never re-arm work for the cancelled
   * batch (e.g. after a trust revocation or an index clear).
   */
  cancelled: boolean;
}

const DEFAULT_DEBOUNCE_MS = 2000;

/** Floor for the debounce max-wait (see {@link maxWaitMs}). */
const MAX_WAIT_FLOOR_MS = 10_000;

/**
 * Watchdog around each index branch's flush work: a wedged indexer run is
 * abandoned once this elapses. Internal constant — deliberately not config.
 */
const FLUSH_BRANCH_TIMEOUT_MS = 600_000;

/** Cap on how long the async dispose waits for in-flight flushes to settle. */
const DISPOSE_AWAIT_CAP_MS = 5_000;

/**
 * RAG single-flight sentinel: the RAG indexer reports an in-flight run for
 * the project as a success-shaped result carrying this error instead of
 * queueing or sharing the run (AST shares its in-flight promise instead).
 */
const RAG_INDEX_BUSY_ERROR = 'Indexing already in progress';

/** Pending + in-flight state keyed by resolved project path. */
const refreshStates = new Map<string, ProjectRefreshState>();

/**
 * Sink notified with the auto-refresh lifecycle for a flush. Wired by the IPC
 * layer (which owns window routing) to broadcast the `index:auto_refresh`
 * push event: `started` when a flush begins running work, `landed` when an
 * index completes work, `settled` when the flush finishes (any outcome).
 */
export type IndexAutoRefreshNotification =
  | { phase: 'started'; rag: boolean; ast: boolean }
  | { phase: 'settled'; rag: boolean; ast: boolean }
  | { phase: 'landed'; rag: boolean; ast: boolean };

export type IndexAutoRefreshNotifier = (
  projectPath: string,
  event: IndexAutoRefreshNotification,
) => void;

let autoRefreshNotifier: IndexAutoRefreshNotifier | null = null;

/** Wire (or clear, with null) the auto-refresh lifecycle sink. */
export function setIndexAutoRefreshNotifier(notifier: IndexAutoRefreshNotifier | null): void {
  autoRefreshNotifier = notifier;
}

let ragIndexerOverride: RefreshRagIndexer | null = null;
let astIndexerOverride: RefreshAstIndexer | null = null;
let configLoaderOverride: (() => Config) | null = null;
let projectConfigResolverOverride: ((projectPath: string) => Config) | null = null;
let trustStateResolverOverride: ((projectPath: string) => TrustState) | null = null;
let flushTimeoutMsOverride: number | null = null;

/** Dispose latch: set by the async dispose; producers become logged no-ops. */
let disposed = false;
let disposedLogged = false;

/** Log-and-drop wrapper: any config failure drops the batch (R2). */
function configOrNull(load: () => Config): Config | null {
  try {
    return load();
  } catch (error) {
    console.warn('[index-refresh] config load failed; dropping batch', error);
    return null;
  }
}

/**
 * Resolve the live config for a project (background work — never a
 * turn-frozen projectRuntime snapshot). The project runtime registry applies
 * the project's `.orchid.json` layer; when the runtime cannot resolve the
 * directory (e.g. it vanished) the home-only config applies, mirroring the
 * ipc/ast.ts fallback.
 */
function currentConfig(projectPath: string): Config | null {
  const resolver = projectConfigResolverOverride;
  if (resolver !== null) {
    return configOrNull(() => resolver(projectPath));
  }
  if (configLoaderOverride !== null) {
    return configOrNull(configLoaderOverride);
  }
  try {
    return getProjectRuntimeRegistry().get(projectPath).config;
  } catch {
    // Runtime cannot resolve the project — home-only config applies.
  }
  return configOrNull(getConfig);
}

function readDebounceMs(projectPath: string): number {
  return currentConfig(projectPath)?.index_refresh?.debounce_ms ?? DEFAULT_DEBOUNCE_MS;
}

/** Debounce max-wait: three debounce windows, floored at 10s. */
function maxWaitMs(debounceMs: number): number {
  return Math.max(debounceMs * 3, MAX_WAIT_FLOOR_MS);
}

/** Internal watchdog timeout for one index branch (seam-overridable for tests). */
function currentFlushTimeoutMs(): number {
  return flushTimeoutMsOverride ?? FLUSH_BRANCH_TIMEOUT_MS;
}

/**
 * Trust gate for the refresh path — fail closed exactly like the rag/ast IPC
 * handlers: only `'trusted'` may refresh; `untrusted` and `changed`
 * (drifted surface) both drop.
 */
function projectTrusted(projectPath: string): boolean {
  try {
    const state = trustStateResolverOverride !== null
      ? trustStateResolverOverride(projectPath)
      : getProjectTrustState(projectPath);
    return state === 'trusted';
  } catch {
    return false;
  }
}

function resolveRagIndexer(): RefreshRagIndexer {
  return ragIndexerOverride ?? ragIndexer;
}

function resolveAstIndexer(): RefreshAstIndexer {
  return astIndexerOverride ?? astIndexer;
}

function getState(projectPath: string): ProjectRefreshState {
  const key = path.resolve(projectPath);
  let state = refreshStates.get(key);
  if (!state) {
    state = {
      projectPath: key,
      pending: new Map(),
      scopes: new Map(),
      dirty: false,
      firstPendingAt: null,
      failureRetried: false,
      timer: null,
      flushing: false,
      flushPromise: null,
      cancelled: false,
    };
    refreshStates.set(key, state);
  }
  return state;
}

/** Best-effort unref so background timers never hold the process open. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}

/**
 * Anchor the max-wait clock: stamped when a batch first becomes pending
 * (mutation or dirty) and reset when the queue fully drains.
 */
function markFirstPending(state: ProjectRefreshState): void {
  if (state.firstPendingAt === null && (state.pending.size > 0 || state.dirty)) {
    state.firstPendingAt = Date.now();
  }
}

/** Dispose guard: post-dispose producer calls become logged no-ops (logged once). */
function ensureLive(): boolean {
  if (!disposed) return true;
  if (!disposedLogged) {
    disposedLogged = true;
    console.warn('[index-refresh] coordinator disposed; ignoring index refresh requests');
  }
  return false;
}

/**
 * (Re)start the per-project debounce timer for the pending batch. The
 * debounce is bounded by a max-wait anchored at the first pending mutation:
 * once a batch has been pending that long, churn can no longer postpone the
 * flush and it runs immediately instead of restarting the timer.
 */
function scheduleFlush(state: ProjectRefreshState): void {
  if (disposed) return;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const debounceMs = readDebounceMs(state.projectPath);
  if (
    state.firstPendingAt !== null &&
    !state.flushing &&
    Date.now() - state.firstPendingAt >= maxWaitMs(debounceMs)
  ) {
    flush(state);
    return;
  }
  const timer = setTimeout(() => flush(state), debounceMs);
  unrefTimer(timer);
  state.timer = timer;
}

function flush(state: ProjectRefreshState): void {
  state.timer = null;
  if (state.flushing) {
    // A flush is already running: keep accumulating into the next batch
    // instead of running concurrently or dropping anything.
    scheduleFlush(state);
    return;
  }
  if (state.pending.size === 0 && !state.dirty) {
    state.firstPendingAt = null;
    return;
  }

  state.flushing = true;
  const entries = state.pending;
  const scopes = state.scopes;
  const dirty = state.dirty;
  state.pending = new Map();
  state.scopes = new Map();
  state.dirty = false;
  // The queue fully drained: the max-wait anchor resets with it.
  state.firstPendingAt = null;
  state.flushPromise = runFlush(state, entries, scopes, dirty);
}

async function runFlush(
  state: ProjectRefreshState,
  entries: Map<string, IndexMutationOp>,
  scopes: Map<string, RefreshScope>,
  dirty: boolean,
): Promise<void> {
  /** Which indexes this flush is running work for — drives lifecycle events. */
  let flushActive: { rag: boolean; ast: boolean } | null = null;
  try {
    if (!projectTrusted(state.projectPath)) {
      console.warn('[index-refresh] project not trusted; dropping batch', state.projectPath);
      return;
    }
    const config = currentConfig(state.projectPath);
    if (config === null) return;
    const flags = config.index_refresh;
    // Defensive against partial configs: no refresh flags means no refresh.
    if (flags == null || (!flags.rag && !flags.ast)) return;

    // Scope-aware split: an entry requeued for one index (sentinel collision)
    // is not re-sent to the index that already consumed it.
    const ragUpserts: string[] = [];
    const ragDeletes: string[] = [];
    const astUpserts: string[] = [];
    const astDeletes: string[] = [];
    for (const [rel, op] of entries) {
      const scope = scopes.get(rel) ?? 'both';
      if (scope !== 'ast') {
        if (op === 'upsert') ragUpserts.push(rel);
        else ragDeletes.push(rel);
      }
      if (scope !== 'rag') {
        if (op === 'upsert') astUpserts.push(rel);
        else astDeletes.push(rel);
      }
    }

    const { projectPath } = state;
    // Which indexes completed work this flush (post-stamp) — drives the
    // auto-refresh notification. Only set after the branch's stamp landed, so
    // a failed, timed-out, or sentinel-collided branch never reports itself.
    const refreshed: { rag: boolean; ast: boolean } = { rag: false, ast: false };
    // Announce the flush before it starts, scoped to the indexes that actually
    // have work (an index with no entries in this batch never runs).
    const ragActive = flags.rag && (ragUpserts.length > 0 || ragDeletes.length > 0 || dirty);
    const astActive = flags.ast && (astUpserts.length > 0 || astDeletes.length > 0 || dirty);
    if (ragActive || astActive) {
      flushActive = { rag: ragActive, ast: astActive };
      notifyAutoRefresh(projectPath, { phase: 'started', ...flushActive });
    }
    // Different stores, so the two indexes may refresh concurrently; each
    // index's own work stays sequential (its runs are per-project single-flight).
    const outcomes = await Promise.all([
      runIndexBranch('rag', async () => {
        if (!flags.rag) return;
        const rag = resolveRagIndexer();
        let mutationsCollided = false;
        let dirtyScanCollided = false;
        if (ragUpserts.length > 0) {
          const result = await rag.upsertFiles({ projectPath, rels: ragUpserts, config });
          if (isRagBusy(result)) mutationsCollided = true;
        }
        if (ragDeletes.length > 0) {
          const result = await rag.deleteFiles(projectPath, ragDeletes);
          if (isRagBusy(result)) mutationsCollided = true;
        }
        if (dirty) {
          const result = await rag.indexProject(projectPath, undefined, false, undefined, undefined, { config });
          if (isRagBusy(result)) dirtyScanCollided = true;
        }
        if (mutationsCollided || dirtyScanCollided) {
          requeueRagCollision(state, entries, scopes, dirtyScanCollided);
        } else if (ragUpserts.length > 0 || ragDeletes.length > 0 || dirty) {
          rag.touchAutoRefresh(projectPath);
          refreshed.rag = true;
        }
      }),
      runIndexBranch('ast', async () => {
        if (!flags.ast) return;
        const ast = resolveAstIndexer();
        if (astUpserts.length > 0) {
          await ast.upsertFiles({ projectPath, rels: astUpserts, config });
        }
        if (astDeletes.length > 0) {
          await ast.deleteFiles(projectPath, astDeletes);
        }
        if (dirty) {
          await ast.indexProject({ projectPath, config });
        }
        if (astUpserts.length > 0 || astDeletes.length > 0 || dirty) {
          ast.touchAutoRefresh(projectPath);
          refreshed.ast = true;
        }
      }),
    ]);
    if (!state.cancelled && (refreshed.rag || refreshed.ast)) {
      notifyAutoRefresh(projectPath, { phase: 'landed', rag: refreshed.rag, ast: refreshed.ast });
    }
    if (outcomes.includes('failed')) {
      retryOrDropFailedFlush(state);
    } else if (!outcomes.includes('timeout')) {
      // A fully successful flush re-arms the one-shot failure retry.
      state.failureRetried = false;
    }
  } finally {
    // Settled fires for every outcome (landed, failed, timeout, cancelled,
    // requeued) so an in-progress indication can never stick.
    if (flushActive !== null) {
      notifyAutoRefresh(state.projectPath, { phase: 'settled', ...flushActive });
    }
    state.flushing = false;
    if (!state.cancelled && (state.pending.size > 0 || state.dirty)) scheduleFlush(state);
  }
}

/** The RAG indexer reports single-flight collisions as a success-shaped sentinel. */
function isRagBusy(result: RAGIndexResult): boolean {
  return result.errors.includes(RAG_INDEX_BUSY_ERROR);
}

/** Fire-and-forget lifecycle notification — never fails the flush (R2). */
function notifyAutoRefresh(
  projectPath: string,
  event: IndexAutoRefreshNotification,
): void {
  if (autoRefreshNotifier === null) return;
  try {
    autoRefreshNotifier(projectPath, event);
  } catch (error) {
    console.warn('[index-refresh] auto-refresh notification failed', error);
  }
}

/**
 * Restore a batch the RAG indexer rejected with its single-flight sentinel:
 * only the entries RAG still owed go back to pending (arrivals during the
 * flush win), scoped rag-only so the other index does not redundantly
 * re-process entries it already consumed. The dirty flag is re-set only when
 * the dirty scan itself collided. The debounce re-arms so the batch retries
 * after the in-flight run completes; a still-busy run repeats the cycle once
 * per debounce window instead of spinning.
 */
function requeueRagCollision(
  state: ProjectRefreshState,
  entries: Map<string, IndexMutationOp>,
  scopes: Map<string, RefreshScope>,
  dirtyScanCollided: boolean,
): void {
  if (state.cancelled) return;
  for (const [rel, op] of entries) {
    if (scopes.get(rel) === 'ast') continue;
    if (!state.pending.has(rel)) {
      state.pending.set(rel, op);
      state.scopes.set(rel, 'rag');
    }
  }
  if (dirtyScanCollided) state.dirty = true;
  markFirstPending(state);
  scheduleFlush(state);
}

/**
 * Self-heal a failed flush (transient embedder/SQLITE error): content state
 * is unknown after a partial run, so the dirty hash-diff scan is the correct
 * retry. Bounded to one retry per drained batch — a second consecutive
 * failure drops the batch instead of retrying forever.
 */
function retryOrDropFailedFlush(state: ProjectRefreshState): void {
  if (state.cancelled) return;
  if (state.failureRetried) {
    console.warn('[index-refresh] flush failed again; dropping batch', state.projectPath);
    return;
  }
  state.failureRetried = true;
  state.dirty = true;
  markFirstPending(state);
  scheduleFlush(state);
}

/**
 * Run one index's refresh work under a watchdog: failures are logged and
 * dropped (R2), and a wedged run is abandoned once the timeout elapses so
 * the flushing flag can never wedge. Never throws.
 */
async function runIndexBranch(index: 'rag' | 'ast', work: () => Promise<void>): Promise<BranchOutcome> {
  const timeoutMs = currentFlushTimeoutMs();
  let timedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          timedOut = true;
          reject(new Error(`flush timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        unrefTimer(watchdog);
      }),
    ]);
    return 'ok';
  } catch (error) {
    if (timedOut) {
      console.warn(`[index-refresh] ${index} refresh timed out after ${timeoutMs}ms; abandoning branch`);
      return 'timeout';
    }
    console.warn(`[index-refresh] ${index} refresh failed`, error);
    return 'failed';
  } finally {
    if (watchdog !== null) clearTimeout(watchdog);
  }
}

/**
 * Enqueue file mutations for a project. Entries dedupe by relative path with
 * last-write-wins (a delete replacing a pending upsert collapses to a single
 * delete, and vice versa) and (re)start the per-project debounce timer.
 * No-op once the coordinator has been disposed.
 */
export function enqueueMutation(projectPath: string, entries: IndexMutationEntry[]): void {
  if (entries.length === 0) return;
  if (!ensureLive()) return;
  const state = getState(projectPath);
  for (const entry of entries) {
    state.pending.set(entry.rel, entry.op);
    state.scopes.set(entry.rel, 'both');
  }
  markFirstPending(state);
  scheduleFlush(state);
}

/**
 * Record that a hash-diff scan is needed for a project (mutating commands do
 * not report which files they touched) and (re)start the debounce timer; the
 * scan flushes together with any queued mutations.
 * No-op once the coordinator has been disposed.
 */
export function markDirty(projectPath: string): void {
  if (!ensureLive()) return;
  const state = getState(projectPath);
  state.dirty = true;
  markFirstPending(state);
  scheduleFlush(state);
}

/** Shared clear path for both dispose entry points; returns in-flight flush promises. */
function clearAllState(): Promise<void>[] {
  const inFlight: Promise<void>[] = [];
  for (const state of refreshStates.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.pending.clear();
    state.scopes.clear();
    state.dirty = false;
    state.firstPendingAt = null;
    state.failureRetried = false;
    if (state.flushPromise !== null) inFlight.push(state.flushPromise);
  }
  refreshStates.clear();
  return inFlight;
}

/** Clear every pending queue and timer (tests). Does not await in-flight flushes. */
export function disposeIndexRefreshCoordinator(): void {
  clearAllState();
}

/**
 * Shutdown dispose: latch producers off (post-dispose enqueueMutation/markDirty
 * become logged no-ops — logged once), clear every timer and queue, then wait
 * — capped at 5s — for in-flight flushes to settle so a mid-flush indexer run
 * is not torn down while writing.
 */
export async function disposeIndexRefreshCoordinatorAsync(): Promise<void> {
  disposed = true;
  const inFlight = clearAllState();
  if (inFlight.length === 0) return;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, DISPOSE_AWAIT_CAP_MS);
        unrefTimer(capTimer);
      }),
    ]);
  } finally {
    if (capTimer !== null) clearTimeout(capTimer);
  }
}

/**
 * Clear one project's pending refresh state — queued mutations, the dirty
 * flag, and any armed timer (trust revocation). No-op when the project has
 * no pending state. An in-flight flush holding the dropped state observes the
 * cancellation flag and never requeues, retries, or reschedules work for it.
 */
export function cancelProjectRefresh(projectPath: string): void {
  const key = path.resolve(projectPath);
  const state = refreshStates.get(key);
  if (!state) return;
  // Flag before clearing: a flush that is mid-flight on this state checks the
  // flag once its indexer calls settle and must not re-arm the cancelled batch.
  state.cancelled = true;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.pending.clear();
  state.scopes.clear();
  state.dirty = false;
  refreshStates.delete(key);
}

/**
 * Cancel one project's refresh state (see {@link cancelProjectRefresh}) and
 * wait — capped at {@link DISPOSE_AWAIT_CAP_MS} — for an in-flight flush to
 * settle, so a caller about to drop the underlying store (rag:clear) cannot
 * race a flush that would repopulate it.
 */
export async function cancelProjectRefreshAsync(projectPath: string): Promise<void> {
  const flushPromise = refreshStates.get(path.resolve(projectPath))?.flushPromise ?? null;
  cancelProjectRefresh(projectPath);
  if (flushPromise === null) return;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      flushPromise.catch(() => {}),
      new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, DISPOSE_AWAIT_CAP_MS);
        unrefTimer(capTimer);
      }),
    ]);
  } finally {
    if (capTimer !== null) clearTimeout(capTimer);
  }
}

/**
 * @internal Test-only indexer/config overrides (pass null per slot to reset).
 * Mirrors the `_setAgentsMdStoreResolverForTests` convention. Unset slots
 * reset to their real implementations. Also resets the dispose latch so a
 * disposed coordinator can be revived between tests.
 */
export function _setIndexRefreshCoordinatorForTests(overrides: {
  ragIndexer?: RefreshRagIndexer | null;
  astIndexer?: RefreshAstIndexer | null;
  configLoader?: (() => Config) | null;
  /** Replaces the whole per-project config resolution (registry + fallback). */
  projectConfigResolver?: ((projectPath: string) => Config) | null;
  /** Replaces the trust-state read behind the flush gate. */
  trustStateResolver?: ((projectPath: string) => TrustState) | null;
  /** Overrides the per-branch flush watchdog timeout (null resets to the default). */
  flushTimeoutMs?: number | null;
}): void {
  ragIndexerOverride = overrides.ragIndexer ?? null;
  astIndexerOverride = overrides.astIndexer ?? null;
  configLoaderOverride = overrides.configLoader ?? null;
  projectConfigResolverOverride = overrides.projectConfigResolver ?? null;
  trustStateResolverOverride = overrides.trustStateResolver ?? null;
  flushTimeoutMsOverride = overrides.flushTimeoutMs ?? null;
  autoRefreshNotifier = null;
  disposed = false;
  disposedLogged = false;
}

/** @internal Test-only pending-state snapshot for a project path. */
export function _getPendingIndexRefreshForTests(projectPath: string): IndexRefreshPendingState {
  const state = refreshStates.get(path.resolve(projectPath));
  if (!state) {
    return { entries: [], dirty: false, timerArmed: false, flushing: false };
  }
  return {
    entries: [...state.pending].map(([rel, op]) => ({ rel, op })),
    dirty: state.dirty,
    timerArmed: state.timer !== null,
    flushing: state.flushing,
  };
}
