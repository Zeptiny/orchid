/**
 * AST Symbol Store — SQLite database for symbol index persistence.
 *
 * Uses `better-sqlite3` with WAL mode for concurrent read access.
 * Tables: files, symbols, meta. Corruption recovery on open.
 *
 * Ported from Python `src/orchid/ast/store.py`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { ASTStoreStatus } from '../../shared/types/ipc-boundary';

export type { ASTStoreStatus } from '../../shared/types/ipc-boundary';
/** @deprecated Use ASTStoreStatus from shared/types/ipc-boundary */
export type StoreStatus = ASTStoreStatus;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROJECT_AST_DIR = '.orchid/ast';
export const AST_INDEX_DB = 'symbols.db';

const CORRUPTION_RE = /malformed|not a database|disk image|header mismatch|is encrypted/i;

const DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    file_path TEXT PRIMARY KEY,
    hash TEXT NOT NULL DEFAULT '',
    symbol_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT '',
    start_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(file_path)
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Symbol {
  name: string;
  type: string;
  kind: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  charStart: number;
  charEnd: number;
}

export interface SymbolRow {
  filePath: string;
  name: string;
  type: string;
  kind: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  charStart: number;
  charEnd: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCorruptionError(err: unknown): boolean {
  if (err instanceof Error) {
    return CORRUPTION_RE.test(err.message);
  }
  return false;
}

// ---------------------------------------------------------------------------
// ASTStore
// ---------------------------------------------------------------------------

export class ASTStore {
  readonly projectPath: string;
  readonly astDir: string;
  readonly dbPath: string;

  /** Cached database connection (lazy-opened, reused). */
  private _db: Database.Database | null = null;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.astDir = path.join(projectPath, PROJECT_AST_DIR);
    this.dbPath = path.join(this.astDir, AST_INDEX_DB);
  }

  /**
   * Close the cached database connection. Call on shutdown or when the
   * store is no longer needed.
   */
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

  private ensureDir(): void {
    fs.mkdirSync(this.astDir, { recursive: true });
  }

  /**
   * Initialize the database schema. Creates the .orchid/ast directory
   * and symbols.db if they don't exist. Handles corruption by rebuilding.
   */
  initDb(): void {
    this.ensureDir();
    try {
      const db = new Database(this.dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec(DB_SCHEMA);
      db.close();
    } catch (err) {
      if (!isCorruptionError(err)) throw err;
      console.error(`Corrupted symbols.db, rebuilding: ${err}`);
      if (fs.existsSync(this.dbPath)) {
        fs.unlinkSync(this.dbPath);
      }
      const db = new Database(this.dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.exec(DB_SCHEMA);
      db.close();
    }
    // Close any cached connection so getConn() picks up the schema
    this.dispose();
  }

  /**
   * Get a database connection. Caches the connection for reuse.
   * Handles corruption recovery.
   */
  private getConn(): Database.Database {
    if (this._db) return this._db;
    this.ensureDir();
    try {
      this._db = new Database(this.dbPath);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('busy_timeout = 5000');
      // Quick corruption check
      this._db.prepare('SELECT 1 FROM files LIMIT 1').get();
      return this._db;
    } catch (err) {
      if (!isCorruptionError(err)) {
        if (this._db) { this._db.close(); this._db = null; }
        throw err;
      }
      console.error(`Corrupted symbols.db, rebuilding: ${err}`);
      if (this._db) { this._db.close(); this._db = null; }
      if (fs.existsSync(this.dbPath)) {
        fs.unlinkSync(this.dbPath);
      }
      this._db = new Database(this.dbPath);
      this._db.exec(DB_SCHEMA);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('busy_timeout = 5000');
      return this._db;
    }
  }

  /**
   * Upsert a file's symbols: delete old symbols, insert new ones, update file hash.
   */
  upsertFile(filePath: string, fileHash: string, symbols: Symbol[]): void {
    const db = this.getConn();
    // Disable FK checks to allow inserting symbols before the file record
    // (matches Python behavior where FK enforcement is off by default).
    db.pragma('foreign_keys = OFF');

    const deleteStmt = db.prepare('DELETE FROM symbols WHERE file_path = ?');
    deleteStmt.run(filePath);

    // Upsert file record before symbols (FK target must exist)
    const upsertFileStmt = db.prepare(
      'INSERT OR REPLACE INTO files (file_path, hash, symbol_count) VALUES (?, ?, ?)',
    );
    upsertFileStmt.run(filePath, fileHash, symbols.length);

    if (symbols.length > 0) {
      const insertStmt = db.prepare(
        'INSERT INTO symbols ' +
        '(file_path, name, type, kind, start_line, start_column, ' +
        'end_line, end_column, char_start, char_end) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insertMany = db.transaction((syms: Symbol[]) => {
        for (const s of syms) {
          insertStmt.run(
            filePath, s.name, s.type, s.kind,
            s.startLine, s.startColumn,
            s.endLine, s.endColumn,
            s.charStart, s.charEnd,
          );
        }
      });
      insertMany(symbols);
    }

    db.pragma('foreign_keys = ON');
  }

  /**
   * Get symbols by name, optionally filtered by type.
   */
  getSymbolsByName(name: string, typeFilter: string = 'both'): SymbolRow[] {
    const db = this.getConn();
    let rows: unknown[];
    if (typeFilter === 'both') {
      rows = db.prepare(
        'SELECT file_path, name, type, kind, start_line, start_column, ' +
        'end_line, end_column, char_start, char_end ' +
        'FROM symbols WHERE name = ?',
      ).all(name) as unknown[];
    } else {
      rows = db.prepare(
        'SELECT file_path, name, type, kind, start_line, start_column, ' +
        'end_line, end_column, char_start, char_end ' +
        'FROM symbols WHERE name = ? AND type = ?',
      ).all(name, typeFilter) as unknown[];
    }

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      filePath: row.file_path as string,
      name: row.name as string,
      type: row.type as string,
      kind: row.kind as string,
      startLine: row.start_line as number,
      startColumn: row.start_column as number,
      endLine: row.end_line as number,
      endColumn: row.end_column as number,
      charStart: row.char_start as number,
      charEnd: row.char_end as number,
    }));
  }

  /**
   * Get the stored hash for a file (empty string if not found).
   */
  getFileHash(filePath: string): string {
    if (!fs.existsSync(this.dbPath)) return '';
    const db = this.getConn();
    const row = db.prepare('SELECT hash FROM files WHERE file_path = ?').get(filePath) as
      | { hash: string }
      | undefined;
    return row?.hash ?? '';
  }

  /**
   * Get all file hashes (for change detection during indexing).
   */
  getAllFileHashes(): Record<string, string> {
    if (!fs.existsSync(this.dbPath)) return {};
    const db = this.getConn();
    const rows = db.prepare('SELECT file_path, hash FROM files').all() as Array<{
      file_path: string;
      hash: string;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.file_path] = row.hash;
    }
    return result;
  }

  /**
   * Delete a file and its symbols from the store.
   */
  deleteByFile(filePath: string): void {
    const db = this.getConn();
    db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);
  }

  /**
   * Delete the database file entirely.
   */
  clear(): void {
    this.dispose();
    if (fs.existsSync(this.dbPath)) {
      fs.unlinkSync(this.dbPath);
    }
  }

  /**
   * Record the current time as last_indexed and optional duration.
   */
  recordIndex(duration?: number): void {
    const db = this.getConn();
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'last_indexed',
      now,
    );
    if (duration !== undefined) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'last_index_duration',
        String(duration),
      );
    }
  }

  /**
   * Get store status (file count, symbol count, last indexed time).
   */
  status(): StoreStatus {
    if (!fs.existsSync(this.dbPath)) {
      return { totalFiles: 0, totalSymbols: 0, lastIndexed: null, lastIndexDuration: null };
    }
    const db = this.getConn();
    const fileCount = (db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number })
      .cnt;
    const symbolCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }
    ).cnt;
    const lastRow = db.prepare("SELECT value FROM meta WHERE key = 'last_indexed'").get() as
      | { value: string }
      | undefined;
    const lastIndexed = lastRow?.value ?? null;
    const durRow = db
      .prepare("SELECT value FROM meta WHERE key = 'last_index_duration'")
      .get() as { value: string } | undefined;
    const duration = durRow ? parseFloat(durRow.value) : null;

    return {
      totalFiles: fileCount,
      totalSymbols: symbolCount,
      lastIndexed,
      lastIndexDuration: duration,
    };
  }
}
