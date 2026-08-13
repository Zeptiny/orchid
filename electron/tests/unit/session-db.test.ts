import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionDb } from '../../src/main/session/db';
import { SESSION_SCHEMA_VERSION } from '../../src/main/session/schema';

let tempDir: string;
let instances: SessionDb[];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-db-test-'));
  instances = [];
});

afterEach(() => {
  for (const db of instances) db.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function tableNames(db: SessionDb): string[] {
  const rows = db.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('SessionDb', () => {
  it('creates a DB with sessions and chains tables', () => {
    const dbPath = path.join(tempDir, 'sessions.db');
    const db = new SessionDb(dbPath);
    instances.push(db);

    const names = tableNames(db);
    expect(names).toContain('schema_meta');
    expect(names).toContain('sessions');
    expect(names).toContain('chains');
    expect(names).toContain('chain_message_offsets');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('returns the same connection instance on repeated access', () => {
    const db = new SessionDb(path.join(tempDir, 'cached.db'));
    instances.push(db);

    const first = db.connection;
    const second = db.connection;
    expect(second).toBe(first);
  });

  it('dispose() closes the connection and re-opens on next access', () => {
    const db = new SessionDb(path.join(tempDir, 'reopen.db'));
    instances.push(db);

    const first = db.connection;
    expect(first.open).toBe(true);

    db.dispose();
    expect(first.open).toBe(false);

    const second = db.connection;
    expect(second).not.toBe(first);
    expect(second.open).toBe(true);
    expect(tableNames(db)).toContain('sessions');
  });

  it('creates parent directories if the path directory does not exist', () => {
    const dbPath = path.join(tempDir, 'deep', 'nested', 'dir', 'sessions.db');
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

    const db = new SessionDb(dbPath);
    instances.push(db);

    void db.connection;
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('records the schema version in schema_meta on open', () => {
    const db = new SessionDb(path.join(tempDir, 'version.db'));
    instances.push(db);

    const row = db.connection
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe(String(SESSION_SCHEMA_VERSION));
  });

  it('hardens the DB file to owner-only permissions (0o600)', () => {
    const dbPath = path.join(tempDir, 'perms.db');
    const db = new SessionDb(dbPath);
    instances.push(db);
    void db.connection;

    // eslint-disable-next-line no-bitwise
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rebuilds a corrupted DB file on next connection access', () => {
    const dbPath = path.join(tempDir, 'corrupt.db');
    fs.writeFileSync(dbPath, Buffer.alloc(4096, 0xde));

    const db = new SessionDb(dbPath);
    instances.push(db);

    const names = tableNames(db);
    expect(names).toContain('sessions');
    expect(names).toContain('chains');

    db.connection
      .prepare(
        'INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('s1', 'recovered', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
    const row = db.connection
      .prepare('SELECT id FROM sessions WHERE id = ?')
      .get('s1') as { id: string };
    expect(row.id).toBe('s1');
  });
});
