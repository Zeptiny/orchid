import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openSqliteDb,
  isSqliteCorruptionError,
  SQLITE_CORRUPTION_RE,
} from '../../src/main/utils/sqlite';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-sqlite-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('openSqliteDb', () => {
  it('opens a fresh DB with WAL mode and returns a usable connection', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = openSqliteDb(dbPath);

    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');

    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO t (val) VALUES (?)').run('hello');
    const row = db.prepare('SELECT val FROM t WHERE id = 1').get() as { val: string };
    expect(row.val).toBe('hello');

    db.close();
  });

  it('runs provided schema SQL on open', () => {
    const dbPath = path.join(tempDir, 'schema.db');
    const db = openSqliteDb(dbPath, {
      schema: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)',
    });

    db.prepare('INSERT INTO items (name) VALUES (?)').run('widget');
    const row = db.prepare('SELECT name FROM items').get() as { name: string };
    expect(row.name).toBe('widget');

    db.close();
  });

  it('creates parent directories if missing', () => {
    const dbPath = path.join(tempDir, 'deep', 'nested', 'dir', 'test.db');
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

    const db = openSqliteDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('rebuilds a corrupted DB when schema is provided', () => {
    const dbPath = path.join(tempDir, 'corrupt.db');
    fs.writeFileSync(dbPath, Buffer.alloc(4096, 0xde));

    const db = openSqliteDb(dbPath, {
      schema: 'CREATE TABLE IF NOT EXISTS recovered (id INTEGER PRIMARY KEY)',
      corruptionCheck: 'SELECT 1 FROM recovered LIMIT 1',
    });

    db.prepare('INSERT INTO recovered (id) VALUES (?)').run(42);
    const row = db.prepare('SELECT id FROM recovered').get() as { id: number };
    expect(row.id).toBe(42);

    db.close();
  });

  it('propagates non-corruption errors from schema execution', () => {
    const dbPath = path.join(tempDir, 'bad-schema.db');

    expect(() =>
      openSqliteDb(dbPath, { schema: 'CREATE TABL broken_syntax (' }),
    ).toThrow();
  });
});

describe('isSqliteCorruptionError', () => {
  it('returns true for corruption-class messages', () => {
    expect(isSqliteCorruptionError(new Error('database disk image is malformed'))).toBe(true);
    expect(isSqliteCorruptionError(new Error('file is not a database'))).toBe(true);
    expect(isSqliteCorruptionError(new Error('disk I/O error: header mismatch'))).toBe(true);
  });

  it('returns false for generic errors', () => {
    expect(isSqliteCorruptionError(new Error('ENOENT: no such file'))).toBe(false);
    expect(isSqliteCorruptionError(new Error('syntax error near CREATE'))).toBe(false);
    expect(isSqliteCorruptionError('not an error object')).toBe(false);
    expect(isSqliteCorruptionError(null)).toBe(false);
  });
});

describe('SQLITE_CORRUPTION_RE', () => {
  it('matches expected corruption patterns', () => {
    expect(SQLITE_CORRUPTION_RE.test('malformed')).toBe(true);
    expect(SQLITE_CORRUPTION_RE.test('not a database')).toBe(true);
    expect(SQLITE_CORRUPTION_RE.test('disk image')).toBe(true);
    expect(SQLITE_CORRUPTION_RE.test('is encrypted')).toBe(true);
    expect(SQLITE_CORRUPTION_RE.test('healthy database')).toBe(false);
  });
});
