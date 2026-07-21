/**
 * Shared SQLite database utility — consolidates open/pragma/corruption-recovery
 * logic used across session, RAG, AST, and accounting stores.
 *
 * Uses dynamic `require('better-sqlite3')` for ABI-mismatch detection with
 * actionable error messaging (matching the RAG store pattern).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** better-sqlite3 database handle. */
export type SqliteDatabase = import('better-sqlite3').Database;

/** Matches SQLite corruption-class error messages. */
export const SQLITE_CORRUPTION_RE =
  /malformed|not a database|disk image|header mismatch|is encrypted/i;

/** Options for {@link openSqliteDb}. */
export interface OpenSqliteDbOptions {
  /** SQL schema to execute after opening (CREATE TABLE IF NOT EXISTS ...). */
  readonly schema?: string;
  /**
   * A lightweight query to verify the schema is intact (e.g.,
   * `SELECT 1 FROM sessions LIMIT 1`). When provided and the check fails
   * with a corruption error, the DB file is recovered per `recovery`.
   */
  readonly corruptionCheck?: string;
  /**
   * Corruption recovery strategy (default `'rebuild'`):
   * - `'rebuild'`: move the corrupt file aside (`<db>.corrupt-<timestamp>`)
   *   and recreate from schema. For rebuildable stores (session, RAG, AST).
   * - `'preserve'`: never delete; rethrow corruption errors to the caller
   *   (fail-closed). For irreplaceable data (e.g., the accounting ledger).
   */
  readonly recovery?: 'rebuild' | 'preserve';
}

/** True when `err` is a SQLite corruption-class error. */
export function isSqliteCorruptionError(err: unknown): boolean {
  if (err instanceof Error) {
    return SQLITE_CORRUPTION_RE.test(err.message);
  }
  return false;
}

/**
 * Safely remove a SQLite database and its WAL/SHM sidecar files.
 */
export function deleteSqliteDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbPath + suffix;
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    }
  }
}

/**
 * Move a corrupt database (and its WAL/SHM sidecars) aside for later salvage
 * instead of permanently deleting it. Falls back to deletion if the rename
 * fails (e.g., non-POSIX filesystem). Returns the backup base path.
 */
export function moveCorruptDbAside(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${dbPath}.corrupt-${stamp}`;
  try {
    fs.renameSync(dbPath, backup);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) {
        try { fs.renameSync(dbPath + suffix, backup + suffix); } catch { /* best effort */ }
      }
    }
  } catch {
    deleteSqliteDb(dbPath);
  }
  return backup;
}

/**
 * Open (or create) a SQLite database with WAL mode and busy timeout.
 *
 * When `schema` is provided it is executed on every open (idempotent via
 * CREATE TABLE IF NOT EXISTS). When a corruption-class error is encountered,
 * recovery follows `opts.recovery`: `'rebuild'` (default) moves the corrupt
 * file aside and re-applies the schema from scratch; `'preserve'` rethrows so
 * the caller can fail closed without destroying data.
 */
export function openSqliteDb(
  dbPath: string,
  opts?: OpenSqliteDbOptions,
): SqliteDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const preserve = opts?.recovery === 'preserve';

  let db: SqliteDatabase;
  try {
    db = createConnection(dbPath);
  } catch (err) {
    if (!isSqliteCorruptionError(err) || preserve) throw err;
    console.error(`[sqlite] corrupt database at ${dbPath} (open); rebuilding`, err);
    moveCorruptDbAside(dbPath);
    db = createConnection(dbPath);
  }

  if (opts?.schema) {
    try {
      db.exec(opts.schema);
    } catch (err) {
      if (!isSqliteCorruptionError(err) || preserve) throw err;
      console.error(`[sqlite] corrupt database at ${dbPath} (schema); rebuilding`, err);
      try { db.close(); } catch { /* corrupted */ }
      moveCorruptDbAside(dbPath);
      db = createConnection(dbPath);
      db.exec(opts.schema);
    }
  }

  if (opts?.corruptionCheck) {
    try {
      db.prepare(opts.corruptionCheck).get();
    } catch (err) {
      if (!isSqliteCorruptionError(err) || preserve) throw err;
      console.error(`[sqlite] corrupt database at ${dbPath} (integrity check); rebuilding`, err);
      try { db.close(); } catch { /* corrupted */ }
      moveCorruptDbAside(dbPath);
      db = createConnection(dbPath);
      if (opts.schema) {
        db.exec(opts.schema);
      }
    }
  }

  return db;
}

function createConnection(dbPath: string): SqliteDatabase {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (
      path: string,
    ) => SqliteDatabase;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const abiMismatch =
      /NODE_MODULE_VERSION|did not self-register|was compiled against a different/i.test(
        detail,
      );
    if (abiMismatch) {
      throw new Error(
        `better-sqlite3 native module is not compatible with this Electron runtime. ` +
          `From electron/, run: npm run rebuild:native\n\nUnderlying error: ${detail}`,
        { cause: err },
      );
    }
    throw new Error(
      `better-sqlite3 failed to load (${detail}). ` +
        `From electron/, run: npm install && npm run rebuild:native`,
      { cause: err },
    );
  }
}
