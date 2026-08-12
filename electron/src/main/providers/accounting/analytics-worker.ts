/**
 * Analytics query worker. Executes heavy read-model queries (the Context view
 * scans the whole context_snapshots table) off the Electron main process so
 * the UI never freezes while analytics loads.
 *
 * Opens its own accounting.db connection (WAL allows concurrent readers with
 * the main-process writer). sessions.db stays main-process-owned: session-name
 * resolution is deferred to the runner, which patches names after the worker
 * returns.
 */
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { openSqliteDb, type SqliteDatabase } from '../../utils/sqlite';
import { ACCOUNTING_SCHEMA_SQL, applyAccountingSchemaMigrations } from './schema';
import { getContext } from './analytics-queries';
import type { AnalyticsTimeRange, ContextResult } from '../../../shared/types/analytics';

const ACCOUNTING_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

/** Envelope returned for the context query: the result plus the session ids
 * whose names must be resolved on the main process (sessions.db access). */
export interface ContextQueryWorkerResult {
  result: ContextResult;
  sessionIds: string[];
}

interface AnalyticsWorkerExecuteMessage {
  type: 'execute';
  taskId: number;
  query: 'context';
  sessionId?: string | null;
  timeRange?: AnalyticsTimeRange | null;
}

type AnalyticsWorkerOutbound =
  | { type: 'ready' }
  | { type: 'result'; taskId: number; result: unknown }
  | { type: 'error'; taskId: number; error: string };

function post(msg: AnalyticsWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

let db: SqliteDatabase | null = null;

function getDb(): SqliteDatabase {
  if (db) return db;
  const connection = openSqliteDb(ACCOUNTING_DB_PATH, {
    schema: ACCOUNTING_SCHEMA_SQL,
    recovery: 'preserve',
  });
  // Idempotent: guarantees the agent_scope column and covering indexes exist
  // even if this worker opens the database before the main-process stores do.
  applyAccountingSchemaMigrations(connection);
  db = connection;
  return connection;
}

post({ type: 'ready' });

function handleExecute(message: AnalyticsWorkerExecuteMessage): void {
  const { taskId, query, sessionId, timeRange } = message;
  try {
    if (query !== 'context') {
      post({ type: 'error', taskId, error: `Unknown analytics query: ${query}` });
      return;
    }
    // Session names are resolved by the main process (sessions.db owner);
    // the worker passes a no-op resolver so getContext never touches it.
    const result = getContext(sessionId ?? undefined, timeRange ?? undefined, {
      db: getDb(),
      resolveSessionNames: () => new Map(),
    });
    const envelope: ContextQueryWorkerResult = {
      result,
      sessionIds: result.topSessions.map((series) => series.sessionId),
    };
    post({ type: 'result', taskId, result: envelope });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    post({ type: 'error', taskId, error: errorMessage });
  }
}

parentPort?.on('message', (message: AnalyticsWorkerExecuteMessage) => {
  if (!message || typeof message !== 'object' || message.type !== 'execute') return;
  handleExecute(message);
});
