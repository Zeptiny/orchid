/**
 * Analytics query runner — the main-process side of the analytics worker.
 *
 * Lazily spawns a single-worker pool on first use and falls back to inline
 * main-thread execution whenever the worker is unavailable (script missing,
 * native module ABI mismatch, worker crash, pool circuit open). Session names
 * are resolved here — sessions.db is owned by the main process and is never
 * opened inside the worker.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkerPool } from '../../utils/worker-pool';
import { getContext } from './analytics-queries';
import { getSessionNames } from '../../session/storage';
import type { ContextQueryWorkerResult } from './analytics-worker';
import type { AnalyticsTimeRange, ContextResult } from '../../../shared/types/analytics';

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

/**
 * Run the analytics context query. Prefers the worker thread; any worker
 * failure (unavailable pool, crashed worker, query error) falls back to
 * inline execution so analytics keeps working exactly as before.
 */
export async function runContextQuery(
  sessionId?: string,
  timeRange?: AnalyticsTimeRange,
): Promise<ContextResult> {
  const workerPool = await ensureAnalyticsWorkerPool();
  if (!workerPool) return getContext(sessionId, timeRange);

  try {
    const envelope = await workerPool.run<ContextQueryWorkerResult>({
      query: 'context',
      sessionId: sessionId ?? null,
      timeRange: timeRange ?? null,
    });
    return patchSessionNames(envelope);
  } catch (error) {
    console.warn('[analytics-worker] Worker query failed, falling back to main-thread execution', {
      error: error instanceof Error ? error.message : String(error),
    });
    return getContext(sessionId, timeRange);
  }
}

function patchSessionNames(envelope: ContextQueryWorkerResult): ContextResult {
  let nameMap = new Map<string, string>();
  if (envelope.sessionIds.length > 0) {
    try {
      nameMap = getSessionNames(envelope.sessionIds);
    } catch (error) {
      console.warn('[analytics] Session name lookup failed', { error });
    }
  }
  return {
    ...envelope.result,
    topSessions: envelope.result.topSessions.map((series) => ({
      ...series,
      sessionName: nameMap.get(series.sessionId) ?? null,
    })),
  };
}

export async function disposeAnalyticsWorkerPool(): Promise<void> {
  const candidate = pool;
  pool = null;
  initPromise = null;
  if (candidate) await candidate.dispose();
}
