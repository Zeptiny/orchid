/**
 * Session persistence module — public API.
 */
export {
  type SessionSummary,
  type StorageOptions,
  SESSIONS_DIR,
  CACHE_DIR,
  TOOL_OUTPUT_CACHE_DIR,
  WEB_FETCH_CACHE_DIR,
  ensureSessionsDir,
  saveSession,
  loadSession,
  listSavedSessions,
  deleteSession,
} from './storage';

export {
  SessionManager,
  type CreateSessionOptions,
  type GenerateTitleCallback,
  type SessionManagerOptions,
} from './manager';
