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
  'upsertFiles' | 'deleteFiles' | 'indexProject'
>;

/** The AST indexer surface the coordinator consumes. */
export type RefreshAstIndexer = Pick<
  typeof astIndexer,
  'upsertFiles' | 'deleteFiles' | 'indexProject'
>;

/** One queued file mutation. */
export interface IndexMutationEntry {
  /** Project-relative mutated file path. */
  rel: string;
  /** `upsert` = added/changed, `delete` = removed. */
  op: 'upsert' | 'delete';
}

type IndexMutationOp = IndexMutationEntry['op'];

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
  /** Set when a full hash-diff scan is needed on the next flush. */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** True while a flush is executing for this project. */
  flushing: boolean;
}

const DEFAULT_DEBOUNCE_MS = 2000;

/**
 * RAG single-flight sentinel: the RAG indexer reports an in-flight run for
 * the project as a success-shaped result carrying this error instead of
 * queueing or sharing the run (AST shares its in-flight promise instead).
 */
const RAG_INDEX_BUSY_ERROR = 'Indexing already in progress';

/** Pending + in-flight state keyed by resolved project path. */
const refreshStates = new Map<string, ProjectRefreshState>();

let ragIndexerOverride: RefreshRagIndexer | null = null;
let astIndexerOverride: RefreshAstIndexer | null = null;
let configLoaderOverride: (() => Config) | null = null;
let projectConfigResolverOverride: ((projectPath: string) => Config) | null = null;
let trustStateResolverOverride: ((projectPath: string) => TrustState) | null = null;

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
      dirty: false,
      timer: null,
      flushing: false,
    };
    refreshStates.set(key, state);
  }
  return state;
}

/** (Re)start the per-project debounce timer for the pending batch. */
function scheduleFlush(state: ProjectRefreshState): void {
  if (state.timer !== null) clearTimeout(state.timer);
  const timer = setTimeout(() => flush(state), readDebounceMs(state.projectPath));
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }
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
  if (state.pending.size === 0 && !state.dirty) return;

  state.flushing = true;
  const entries = state.pending;
  const dirty = state.dirty;
  state.pending = new Map();
  state.dirty = false;
  void runFlush(state, entries, dirty);
}

async function runFlush(
  state: ProjectRefreshState,
  entries: Map<string, IndexMutationOp>,
  dirty: boolean,
): Promise<void> {
  try {
    if (!projectTrusted(state.projectPath)) {
      console.warn('[index-refresh] project not trusted; dropping batch', state.projectPath);
      return;
    }
    const config = currentConfig(state.projectPath);
    if (config === null) return;
    const flags = config.index_refresh;
    // Defensive against partial configs: no refresh flags means no refresh.
    if (flags == null || (!flags.rag && !flags.ast && !dirty)) return;

    const upserts: string[] = [];
    const deletes: string[] = [];
    for (const [rel, op] of entries) {
      if (op === 'upsert') upserts.push(rel);
      else deletes.push(rel);
    }

    const { projectPath } = state;
    // Different stores, so the two indexes may refresh concurrently; each
    // index's own work stays sequential (its runs are per-project single-flight).
    await Promise.all([
      runIndexBranch('rag', async () => {
        if (!flags.rag) return;
        const rag = resolveRagIndexer();
        let collided = false;
        if (upserts.length > 0) {
          const result = await rag.upsertFiles({ projectPath, rels: upserts, config });
          if (isRagBusy(result)) collided = true;
        }
        if (deletes.length > 0) {
          await rag.deleteFiles(projectPath, deletes);
        }
        if (dirty) {
          const result = await rag.indexProject(projectPath, undefined, false, undefined, undefined, { config });
          if (isRagBusy(result)) collided = true;
        }
        if (collided) requeueRagCollision(state, entries, dirty);
      }),
      runIndexBranch('ast', async () => {
        if (!flags.ast) return;
        const ast = resolveAstIndexer();
        if (upserts.length > 0) {
          await ast.upsertFiles({ projectPath, rels: upserts, config });
        }
        if (deletes.length > 0) {
          await ast.deleteFiles(projectPath, deletes);
        }
        if (dirty) {
          await ast.indexProject({ projectPath, config });
        }
      }),
    ]);
  } finally {
    state.flushing = false;
    if (state.pending.size > 0 || state.dirty) scheduleFlush(state);
  }
}

/** The RAG indexer reports single-flight collisions as a success-shaped sentinel. */
function isRagBusy(result: RAGIndexResult): boolean {
  return result.errors.includes(RAG_INDEX_BUSY_ERROR);
}

/**
 * Restore a batch the RAG indexer rejected with its single-flight sentinel:
 * drained entries go back to pending (arrivals during the flush win) and the
 * debounce re-arms so the batch retries after the in-flight run completes.
 * Bounded by the debounce itself — a still-busy run repeats the cycle once
 * per debounce window instead of spinning.
 */
function requeueRagCollision(
  state: ProjectRefreshState,
  entries: Map<string, IndexMutationOp>,
  dirty: boolean,
): void {
  for (const [rel, op] of entries) {
    if (!state.pending.has(rel)) state.pending.set(rel, op);
  }
  if (dirty) state.dirty = true;
  scheduleFlush(state);
}

/** Run one index's refresh work, logging and dropping any failure (R2). */
async function runIndexBranch(index: 'rag' | 'ast', work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.warn(`[index-refresh] ${index} refresh failed`, error);
  }
}

/**
 * Enqueue file mutations for a project. Entries dedupe by relative path with
 * last-write-wins (a delete replacing a pending upsert collapses to a single
 * delete, and vice versa) and (re)start the per-project debounce timer.
 */
export function enqueueMutation(projectPath: string, entries: IndexMutationEntry[]): void {
  if (entries.length === 0) return;
  const state = getState(projectPath);
  for (const entry of entries) {
    state.pending.set(entry.rel, entry.op);
  }
  scheduleFlush(state);
}

/**
 * Record that a hash-diff scan is needed for a project (mutating commands do
 * not report which files they touched) and (re)start the debounce timer; the
 * scan flushes together with any queued mutations.
 */
export function markDirty(projectPath: string): void {
  const state = getState(projectPath);
  state.dirty = true;
  scheduleFlush(state);
}

/** Clear every pending queue and timer (shutdown + tests). */
export function disposeIndexRefreshCoordinator(): void {
  for (const state of refreshStates.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.pending.clear();
    state.dirty = false;
  }
  refreshStates.clear();
}

/**
 * Clear one project's pending refresh state — queued mutations, the dirty
 * flag, and any armed timer (trust revocation). No-op when the project has
 * no pending state.
 */
export function cancelProjectRefresh(projectPath: string): void {
  const key = path.resolve(projectPath);
  const state = refreshStates.get(key);
  if (!state) return;
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.pending.clear();
  state.dirty = false;
  refreshStates.delete(key);
}

/**
 * @internal Test-only indexer/config overrides (pass null per slot to reset).
 * Mirrors the `_setAgentsMdStoreResolverForTests` convention. Unset slots
 * reset to their real implementations.
 */
export function _setIndexRefreshCoordinatorForTests(overrides: {
  ragIndexer?: RefreshRagIndexer | null;
  astIndexer?: RefreshAstIndexer | null;
  configLoader?: (() => Config) | null;
  /** Replaces the whole per-project config resolution (registry + fallback). */
  projectConfigResolver?: ((projectPath: string) => Config) | null;
  /** Replaces the trust-state read behind the flush gate. */
  trustStateResolver?: ((projectPath: string) => TrustState) | null;
}): void {
  ragIndexerOverride = overrides.ragIndexer ?? null;
  astIndexerOverride = overrides.astIndexer ?? null;
  configLoaderOverride = overrides.configLoader ?? null;
  projectConfigResolverOverride = overrides.projectConfigResolver ?? null;
  trustStateResolverOverride = overrides.trustStateResolver ?? null;
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
