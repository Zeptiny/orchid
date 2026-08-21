/**
 * Analytics query worker. Executes heavy read-model queries (the Context view
 * scans the whole context_snapshots table; the drill-downs aggregate the
 * attempt ledger) off the Electron main process so the UI never freezes while
 * analytics loads.
 *
 * Opens its own accounting.db connection (WAL allows concurrent readers with
 * the main-process writer). sessions.db stays main-process-owned: the worker
 * resolves names from the accounting ledger's session-name tombstones only,
 * and the runner live-patches names after the worker returns.
 */
import * as path from 'node:path';
import { parentPort } from 'node:worker_threads';
import { HOME_CONFIG_DIR } from '../../config/loader';
import { openSqliteDb, type SqliteDatabase } from '../../utils/sqlite';
import { ACCOUNTING_SCHEMA_SQL, applyAccountingSchemaMigrations } from './schema';
import {
  getContext,
  getModelDetail,
  getSubagentDetail,
  getContextSessionDetail,
  getContextSessionList,
  resolveTombstoneNames,
  type AnalyticsQueryContext,
} from './analytics-queries';
import type { AnalyticsTimeRange } from '../../../shared/types/analytics';

const ACCOUNTING_DB_PATH = path.join(HOME_CONFIG_DIR, 'accounting.db');

/** Query kinds the worker can execute (mirrored by the runner's dispatch). */
export type AnalyticsQueryKind =
  | 'context'
  | 'model_detail'
  | 'subagent_detail'
  | 'context_session_detail'
  | 'context_sessions';

/**
 * Envelope returned for every query: the result plus the session ids whose
 * names must be live-patched on the main process (sessions.db access).
 */
export interface AnalyticsQueryWorkerResult {
  result: unknown;
  sessionIds: string[];
}

interface AnalyticsWorkerExecuteMessage {
  type: 'execute';
  taskId: number;
  query: AnalyticsQueryKind;
  sessionId?: string | null;
  timeRange?: AnalyticsTimeRange | null;
  modelDetail?: { modelId: string; providerId: string; connectionId: string } | null;
  subagentDetail?: { agentName: string; agentType: string; agentTier: string } | null;
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
  const { taskId, query, sessionId, timeRange, modelDetail, subagentDetail } = message;
  try {
    // Tombstone-only name resolution: the session_names table lives in this
    // db, so the worker fills names for deleted sessions itself; live
    // sessions.db names are patched on the main process, which owns it.
    const workerDb = getDb();
    const ctx: AnalyticsQueryContext = {
      db: workerDb,
      resolveSessionNames: (ids: readonly string[]) => resolveTombstoneNames(workerDb, ids),
    };

    let result: unknown;
    let sessionIds: string[];
    switch (query) {
      case 'context': {
        const context = getContext(sessionId ?? undefined, timeRange ?? undefined, ctx);
        result = context;
        sessionIds = context.topSessions.map((series) => series.sessionId);
        break;
      }
      case 'model_detail': {
        if (!modelDetail) throw new Error('model_detail query requires modelDetail input');
        const detail = getModelDetail({ ...modelDetail, timeRange: timeRange ?? undefined }, ctx);
        result = detail;
        sessionIds = detail.topSessions.map((entry) => entry.sessionId);
        break;
      }
      case 'subagent_detail': {
        if (!subagentDetail) throw new Error('subagent_detail query requires subagentDetail input');
        const detail = getSubagentDetail({ ...subagentDetail, timeRange: timeRange ?? undefined }, ctx);
        result = detail;
        sessionIds = detail.invocations.map((invocation) => invocation.sessionId);
        break;
      }
      case 'context_session_detail': {
        if (!sessionId) throw new Error('context_session_detail query requires sessionId');
        const detail = getContextSessionDetail({ sessionId, timeRange: timeRange ?? undefined }, ctx);
        result = detail;
        sessionIds = [detail.sessionId];
        break;
      }
      case 'context_sessions': {
        const picker = getContextSessionList(timeRange ?? undefined, ctx);
        result = picker;
        sessionIds = picker.sessions.map((entry) => entry.sessionId);
        break;
      }
      default: {
        // Guards against version skew between a compiled runner and an older
        // worker script; the runner falls back to inline execution.
        post({ type: 'error', taskId, error: `Unknown analytics query: ${String(query)}` });
        return;
      }
    }
    const envelope: AnalyticsQueryWorkerResult = { result, sessionIds };
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
