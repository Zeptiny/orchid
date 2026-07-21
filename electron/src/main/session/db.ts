/**
 * Session database — thin wrapper around the shared SQLite utility.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { openSqliteDb, type SqliteDatabase } from '../utils/sqlite';
import { SESSION_SCHEMA_SQL } from './schema';

export const SESSION_DB_PATH = path.join(os.homedir(), '.orchid', 'sessions.db');

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
      this._db.pragma('foreign_keys = ON');
    }
    return this._db;
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
