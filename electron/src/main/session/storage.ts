/**
 * Session storage — SQLite-backed persistence for sessions.
 *
 * Database: ~/.orchid/sessions.db (single file, WAL mode)
 * Cache directories: ~/.orchid/cache/tool-output/<session_id>/
 *                    ~/.orchid/cache/web-fetch/<session_id>/
 *
 * Public facade over the implementation modules in this directory:
 * `storage-db` (options + connection), `storage-parse` (row/JSON parsing),
 * `storage-chains` (chain rows), `storage-sessions` (session rows),
 * `storage-history` (view + history reads), and `storage-compaction`
 * (targeted compaction writes).
 */
export type { SessionSummary } from '../../shared/types/ipc-boundary';

export {
  CACHE_DIR,
  TOOL_OUTPUT_CACHE_DIR,
  WEB_FETCH_CACHE_DIR,
  DEFAULT_SESSION_VIEW_MESSAGE_BUDGET,
  DEFAULT_SESSION_VIEW_BYTE_BUDGET,
  DEFAULT_HISTORY_PAGE_MESSAGE_BUDGET,
  DEFAULT_HISTORY_PAGE_BYTE_BUDGET,
  ensureSessionDb,
  isValidSessionId,
  onSessionStorageRecovered,
  closeSessionDb,
  _clearDbCache,
  type StorageOptions,
} from './storage-db';

export {
  appendActiveChain,
  finishChain,
  restoreMissingChain,
  updateChain,
} from './storage-chains';

export {
  deleteSession,
  deleteSessionCaches,
  getSessionNames,
  listSavedSessions,
  saveSession,
  updateSessionFields,
  type SessionFieldsUpdate,
} from './storage-sessions';

export {
  listSubagentRecordIds,
  loadSession,
  loadSessionForReplacement,
  loadSessionHistoryPage,
  loadSessionMessages,
  loadSessionView,
  loadSessionViewUnrecovered,
  loadSubagentRecord,
  loadSubagentRecords,
  loadSubagentSummaries,
  type SessionHistoryPage,
} from './storage-history';

export {
  applyCompactionPersistence,
  applySubagentCompactionPersistence,
  upsertSubagentRecords,
  type CompactionPersistencePayload,
  type CompactionPersistenceResult,
  type SubagentCompactionPayload,
  type SubagentCompactionResult,
  type SubagentUpsertResult,
} from './storage-compaction';
