/**
 * Analytics query runner — the main-process side of the analytics worker.
 *
 * Lazily spawns a single-worker pool on first use and falls back to inline
 * main-thread execution whenever the worker is unavailable (script missing,
 * native module ABI mismatch, worker crash, pool circuit open). Session names
 * are patched here — sessions.db is owned by the main process and is never
 * opened inside the worker. The worker resolves names from the accounting
 * ledger's tombstones; live names win and are overwritten here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkerPool } from '../../utils/worker-pool';
import {
  getContext,
  getModelDetail,
  getOverview,
  getQuotaOverview,
  getSubagentDetail,
  getContextSessionDetail,
  getContextSessionList,
} from './analytics-queries';
import { getSessionNames } from '../../session/storage';
import type { AnalyticsQueryKind, AnalyticsQueryWorkerResult } from './analytics-worker';
import type {
  AnalyticsTimeRange,
  ContextResult,
  ContextSessionDetailResult,
  ContextSessionsResult,
  ModelDetailResult,
  OverviewResult,
  SubagentAnalyticsDetailResult,
} from '../../../shared/types/analytics';

/** Same batch cap as analytics-queries: one IN(...) per 500 ids stays well
 * below the SQLite bound-variable limit for very long picker lists. */
const LIVE_NAME_BATCH = 500;

/**
 * Bound on a single worker query (queue wait + execution). An unresponsive
 * worker is terminated and the query re-run inline instead of hanging the UI.
 */
const WORKER_QUERY_TIMEOUT_MS = 30_000;

/** Inputs accepted by {@link runAnalyticsQuery}; each query kind reads its own. */
export interface AnalyticsQueryInput {
  sessionId?: string;
  timeRange?: AnalyticsTimeRange;
  modelDetail?: { modelId: string; providerId: string; connectionId: string };
  subagentDetail?: { agentName: string; agentType: string; agentTier: string };
}

let pool: WorkerPool | null = null;
let initPromise: Promise<WorkerPool | null> | null = null;

function workerScriptPath(): string {
  return path.join(__dirname, 'analytics-worker.js');
}

/**
 * Ensure the analytics worker pool exists. Resolves `null` when the pool
 * cannot be brought up (callers fall back to main-thread execution).
 */
export function ensureAnalyticsWorkerPool(): Promise<WorkerPool | null> {
  if (pool) return Promise.resolve(pool);
  if (initPromise) return initPromise;

  const scriptPath = workerScriptPath();
  if (!fs.existsSync(scriptPath)) {
    console.warn('[analytics-worker] Worker script not found, falling back to main-thread queries', { scriptPath });
    return Promise.resolve(null);
  }
  const candidate = new WorkerPool(scriptPath, 1);
  initPromise = (async (): Promise<WorkerPool | null> => {
    try {
      await candidate.init();
      if (initPromise === null) {
        // Disposed while initializing.
        await candidate.dispose();
        return null;
      }
      pool = candidate;
      return pool;
    } catch (err) {
      console.warn('[analytics-worker] Worker pool init failed, falling back to main-thread queries', {
        error: err instanceof Error ? err.message : String(err),
      });
      await candidate.dispose();
      return null;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

/** Inline (main-thread) execution — the fallback path and parity baseline. */
function runInlineAnalyticsQuery(query: AnalyticsQueryKind, input: AnalyticsQueryInput): unknown {
  switch (query) {
    case 'overview':
      return getOverview(input.timeRange);
    case 'context':
      return getContext(input.sessionId, input.timeRange);
    case 'model_detail':
      if (!input.modelDetail) throw new Error('model_detail query requires modelDetail input');
      return getModelDetail({ ...input.modelDetail, timeRange: input.timeRange });
    case 'subagent_detail':
      if (!input.subagentDetail) throw new Error('subagent_detail query requires subagentDetail input');
      return getSubagentDetail({ ...input.subagentDetail, timeRange: input.timeRange });
    case 'context_session_detail':
      if (!input.sessionId) throw new Error('context_session_detail query requires sessionId');
      return getContextSessionDetail({ sessionId: input.sessionId, timeRange: input.timeRange });
    case 'context_sessions':
      return getContextSessionList(input.timeRange);
  }
}

/**
 * Live sessions.db names for the ids the worker embedded tombstone names for.
 * Live-wins: only ids with a live name are returned, so patch callers keep
 * the worker's tombstone name everywhere else. Fail-soft and batched like the
 * ledger resolver (see LIVE_NAME_BATCH).
 */
function resolveLiveSessionNames(sessionIds: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (let i = 0; i < sessionIds.length; i += LIVE_NAME_BATCH) {
    try {
      for (const [id, name] of getSessionNames(sessionIds.slice(i, i + LIVE_NAME_BATCH))) {
        names.set(id, name);
      }
    } catch { /* session DB unavailable — tombstone names stand */ }
  }
  return names;
}

/**
 * Overwrite sessionName fields with live names where they exist, walking the
 * known name-bearing fields of each query result shape. Ids without a live
 * name keep the tombstone name the worker already embedded (or null). The
 * overview instead gets its quota panel patched: quota status is read from
 * main-process services the worker has no access to.
 */
function patchAnalyticsResultSessionNames(query: AnalyticsQueryKind, envelope: AnalyticsQueryWorkerResult): unknown {
  const liveNames = envelope.sessionIds.length > 0
    ? resolveLiveSessionNames(envelope.sessionIds)
    : new Map<string, string>();
  switch (query) {
    case 'overview': {
      const result = envelope.result as OverviewResult;
      return {
        ...result,
        quotaByProvider: getQuotaOverview(),
      };
    }
    case 'context': {
      const result = envelope.result as ContextResult;
      return {
        ...result,
        topSessions: result.topSessions.map((series) => ({
          ...series,
          sessionName: liveNames.get(series.sessionId) ?? series.sessionName,
        })),
      };
    }
    case 'model_detail': {
      const result = envelope.result as ModelDetailResult;
      return {
        ...result,
        topSessions: result.topSessions.map((entry) => ({
          ...entry,
          sessionName: liveNames.get(entry.sessionId) ?? entry.sessionName,
        })),
      };
    }
    case 'subagent_detail': {
      const result = envelope.result as SubagentAnalyticsDetailResult;
      return {
        ...result,
        invocations: result.invocations.map((invocation) => ({
          ...invocation,
          sessionName: liveNames.get(invocation.sessionId) ?? invocation.sessionName,
        })),
      };
    }
    case 'context_session_detail': {
      const result = envelope.result as ContextSessionDetailResult;
      return {
        ...result,
        sessionName: liveNames.get(result.sessionId) ?? result.sessionName,
      };
    }
    case 'context_sessions': {
      const result = envelope.result as ContextSessionsResult;
      return {
        ...result,
        sessions: result.sessions.map((entry) => ({
          ...entry,
          sessionName: liveNames.get(entry.sessionId) ?? entry.sessionName,
        })),
      };
    }
  }
}

/**
 * Run an analytics query. Prefers the worker thread; any worker failure
 * (unavailable pool, crashed worker, query error) falls back to inline
 * execution so analytics keeps working exactly as before.
 */
export async function runAnalyticsQuery(
  query: AnalyticsQueryKind,
  input: AnalyticsQueryInput = {},
): Promise<unknown> {
  const workerPool = await ensureAnalyticsWorkerPool();
  if (!workerPool) return runInlineAnalyticsQuery(query, input);

  const timeout = new AbortController();
  const timeoutTimer = setTimeout(() => timeout.abort(), WORKER_QUERY_TIMEOUT_MS);
  try {
    const envelope = await workerPool.run<AnalyticsQueryWorkerResult>({
      query,
      sessionId: input.sessionId ?? null,
      timeRange: input.timeRange ?? null,
      modelDetail: input.modelDetail ?? null,
      subagentDetail: input.subagentDetail ?? null,
    }, timeout.signal);
    return patchAnalyticsResultSessionNames(query, envelope);
  } catch (error) {
    console.warn('[analytics-worker] Worker query failed, falling back to main-thread execution', {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return runInlineAnalyticsQuery(query, input);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * Back-compat wrapper over {@link runAnalyticsQuery} for the Context view —
 * kept for the worker/inline parity test.
 */
export async function runContextQuery(
  sessionId?: string,
  timeRange?: AnalyticsTimeRange,
): Promise<ContextResult> {
  return runAnalyticsQuery('context', { sessionId, timeRange }) as Promise<ContextResult>;
}

export async function disposeAnalyticsWorkerPool(): Promise<void> {
  const candidate = pool;
  pool = null;
  initPromise = null;
  if (candidate) await candidate.dispose();
}
