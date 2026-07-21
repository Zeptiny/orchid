/**
 * Shared SQLite database utility — consolidates open/pragma/corruption-recovery
 * logic used across session, RAG, AST, and accounting stores.
 *
 * Uses dynamic `require('better-sqlite3')` for ABI-mismatch detection with
 * actionable error messaging (matching the RAG store pattern).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SqliteDatabase = import('better-sqlite3').Database;

export const SQLITE_CORRUPTION_RE =
  /malformed|not a database|disk image|header mismatch|is encrypted/i;

export interface OpenSqliteDbOptions {
  /** SQL schema to execute after opening (CREATE TABLE IF NOT EXISTS ...). */
  readonly schema?: string;
  /**
   * A lightweight query to verify the schema is intact (e.g.,
   * `SELECT 1 FROM sessions LIMIT 1`). When provided and the check fails
   * with a corruption error, the DB file is deleted and rebuilt.
   */
  readonly corruptionCheck?: string;
}

export function isSqliteCorruptionError(err: unknown): boolean {
  if (err instanceof Error) {
    return SQLITE_CORRUPTION_RE.test(err.message);
  }
  return false;
}

/**
 * Open (or create) a SQLite database with WAL mode and busy timeout.
 *
 * When `schema` is provided it is executed on every open (idempotent via
 * CREATE TABLE IF NOT EXISTS). When `corruptionCheck` is provided and fails
 * with a corruption-class error, the file is deleted and the schema is
 * re-applied from scratch.
 */
export function openSqliteDb(
  dbPath: string,
  opts?: OpenSqliteDbOptions,
): SqliteDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  let db: SqliteDatabase;
  try {
    db = createConnection(dbPath);
  } catch (err) {
    if (!isSqliteCorruptionError(err)) throw err;
    fs.unlinkSync(dbPath);
    db = createConnection(dbPath);
  }

  if (opts?.schema) {
    try {
      db.exec(opts.schema);
    } catch (err) {
      if (!isSqliteCorruptionError(err)) throw err;
      db.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      db = createConnection(dbPath);
      db.exec(opts.schema);
    }
  }

  if (opts?.corruptionCheck) {
    try {
      db.prepare(opts.corruptionCheck).get();
    } catch (err) {
      if (!isSqliteCorruptionError(err)) throw err;
      db.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
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
      `better-sqlite3 is not available (${detail}). ` +
        `Install optional deps, then rebuild for Electron: npm install && npm run rebuild:native`,
      { cause: err },
    );
  }
}
