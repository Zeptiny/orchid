/**
 * Session storage infrastructure — cache paths, storage options, session-id
 * validation, and the corruption-recovering cached SQLite connection.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type SqliteDatabase, isSqliteCorruptionError } from '../utils/sqlite';
import { SESSION_DB_PATH, SessionDb } from './db';

export const CACHE_DIR = path.join(os.homedir(), '.orchid', 'cache');
export const TOOL_OUTPUT_CACHE_DIR = path.join(CACHE_DIR, 'tool-output');
export const WEB_FETCH_CACHE_DIR = path.join(CACHE_DIR, 'web-fetch');

export interface StorageOptions {
  /** Override path to the sessions database. Defaults to `~/.orchid/sessions.db`. */
  dbPath?: string;
  /** Override path to tool-output cache directory. */
  toolOutputCacheDir?: string;
  /** Override path to web-fetch cache directory. */
  webFetchCacheDir?: string;
  /** Initial renderer history budget; primarily overridden by focused tests. */
  sessionViewMessageBudget?: number;
  /** Initial renderer serialized-message byte budget. */
  sessionViewByteBudget?: number;
}

export const DEFAULT_SESSION_VIEW_MESSAGE_BUDGET = 240;
export const DEFAULT_SESSION_VIEW_BYTE_BUDGET = 2 * 1024 * 1024;
export const DEFAULT_HISTORY_PAGE_MESSAGE_BUDGET = 100;
export const DEFAULT_HISTORY_PAGE_BYTE_BUDGET = 512 * 1024;

declare const databasePathBrand: unique symbol;

/** Absolute path to a sessions database; minted only by `resolveOptions`. */
export type DatabasePath = string & {
  readonly [databasePathBrand]?: typeof databasePathBrand;
};

export interface ResolvedStorageOptions {
  readonly dbPath: DatabasePath;
  readonly toolOutputCacheDir: string;
  readonly webFetchCacheDir: string;
  readonly sessionViewMessageBudget: number;
  readonly sessionViewByteBudget: number;
}

export function resolveOptions(opts?: StorageOptions): ResolvedStorageOptions {
  return {
    dbPath: (opts?.dbPath ?? SESSION_DB_PATH) as DatabasePath,
    toolOutputCacheDir: opts?.toolOutputCacheDir ?? TOOL_OUTPUT_CACHE_DIR,
    webFetchCacheDir: opts?.webFetchCacheDir ?? WEB_FETCH_CACHE_DIR,
    sessionViewMessageBudget:
      opts?.sessionViewMessageBudget ?? DEFAULT_SESSION_VIEW_MESSAGE_BUDGET,
    sessionViewByteBudget:
      opts?.sessionViewByteBudget ?? DEFAULT_SESSION_VIEW_BYTE_BUDGET,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Defense-in-depth: true only for canonical UUID session IDs. */
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

const dbCache = new Map<DatabasePath, SessionDb>();
const storageRecoveryListeners = new Set<() => void>();

/**
 * Subscribe to a successful SQLite connection recovery.
 *
 * Consumers with previously failed best-effort writes can use this as a safe
 * signal to retry once; the storage layer itself still owns recovery.
 */
export function onSessionStorageRecovered(listener: () => void): () => void {
  storageRecoveryListeners.add(listener);
  return () => storageRecoveryListeners.delete(listener);
}

function notifySessionStorageRecovered(): void {
  for (const listener of storageRecoveryListeners) {
    try {
      listener();
    } catch (error) {
      console.warn('Session storage recovery observer failed:', error);
    }
  }
}

function getDb(dbPath: DatabasePath): SqliteDatabase {
  let cached = dbCache.get(dbPath);
  if (!cached) {
    cached = new SessionDb(dbPath);
    dbCache.set(dbPath, cached);
  }
  return cached.connection;
}

/**
 * Run a database operation; on a corruption-class error, reset the cached
 * connection and retry once. Reopening triggers the shared utility's
 * open-time recovery (move-aside + rebuild), so mid-life corruption heals
 * instead of permanently poisoning the cached handle.
 */
const activeRecoveryPaths = new Set<DatabasePath>();

export function withCorruptionRecovery<T>(
  dbPath: DatabasePath,
  op: (db: SqliteDatabase) => T,
): T {
  try {
    return op(getDb(dbPath));
  } catch (err) {
    if (!isSqliteCorruptionError(err)) throw err;
    console.error(`[session] corruption detected during operation at ${dbPath}; resetting connection`, err);
    const cached = dbCache.get(dbPath);
    if (cached) {
      cached.dispose();
      dbCache.delete(dbPath);
    }
    const result = op(getDb(dbPath));
    if (!activeRecoveryPaths.has(dbPath)) {
      activeRecoveryPaths.add(dbPath);
      try {
        notifySessionStorageRecovered();
      } finally {
        activeRecoveryPaths.delete(dbPath);
      }
    }
    return result;
  }
}

/** Close all cached session database connections (invoked on app shutdown). */
export function closeSessionDb(): void {
  for (const db of dbCache.values()) {
    db.dispose();
  }
  dbCache.clear();
}

/** @internal Test-only: clear cached connections. */
export function _clearDbCache(): void {
  closeSessionDb();
}

/** Ensure the DB parent directory exists and the connection is open; returns the directory. */
export function ensureSessionDb(opts?: StorageOptions): string {
  const { dbPath } = resolveOptions(opts);
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  getDb(dbPath);
  return dir;
}
