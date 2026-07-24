/**
 * Session database — thin wrapper around the shared SQLite utility.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openSqliteDb, type SqliteDatabase } from '../utils/sqlite';
import { SESSION_SCHEMA_SQL, SESSION_SCHEMA_VERSION } from './schema';

/** Default session database path (~/.orchid/sessions.db). */
export const SESSION_DB_PATH = path.join(os.homedir(), '.orchid', 'sessions.db');

/** Lazy, cached session database connection with disposal. */
export class SessionDb {
  private _db: SqliteDatabase | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? SESSION_DB_PATH;
  }

  get connection(): SqliteDatabase {
    if (!this._db) {
      this._db = openSqliteDb(this.dbPath, {
        schema: SESSION_SCHEMA_SQL,
        corruptionCheck: 'SELECT 1 FROM sessions LIMIT 1',
      });
      try {
        this._db.exec('ALTER TABLE sessions ADD COLUMN reasoning_effort_override TEXT');
      } catch (error) {
        // Ignore only the expected duplicate-column error on migrated databases;
        // surface every other migration failure to the caller.
        if (!(error instanceof Error && /duplicate column name/i.test(error.message))) {
          throw error;
        }
      }
      try {
        this._db.exec('ALTER TABLE sessions ADD COLUMN permission_mode TEXT');
      } catch (error) {
        if (!(error instanceof Error && /duplicate column name/i.test(error.message))) {
          throw error;
        }
      }
      this._db.pragma('foreign_keys = ON');
      this._db
        .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SESSION_SCHEMA_VERSION));
      this.harden();
    }
    return this._db;
  }

  /** Best-effort owner-only permissions on the DB file and its parent directory. */
  private harden(): void {
    try {
      fs.chmodSync(path.dirname(this.dbPath), 0o700);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
  }

  dispose(): void {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        // ignore
      }
      this._db = null;
    }
  }
}
