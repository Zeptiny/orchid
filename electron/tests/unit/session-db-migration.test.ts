/**
 * Session DB legacy → v6 migration tests.
 *
 * v3 added `tier_override`; v4 added the bounded `summary_json` subagent read
 * model; v5 added the equivalent chain summary; v6 added indexed message byte
 * ranges for bounded deep paging. These tests open databases
 * created with the v2 schema, run the store's open path / migration helper,
 * and assert the columns are added while pre-existing rows remain readable.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionDb } from '../../src/main/session/db';
import {
  applySessionSchemaMigrations,
  SESSION_SCHEMA_VERSION,
} from '../../src/main/session/schema';
import { openSqliteDb } from '../../src/main/utils/sqlite';
import {
  loadSession,
  saveSession,
  _clearDbCache,
} from '../../src/main/session/storage';

/** sessions table exactly as v2 created it — no tier_override column. */
const V2_SCHEMA_SQL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  selection_json TEXT,
  model_label TEXT,
  cwd TEXT,
  active_chain_id TEXT,
  todo_store_json TEXT NOT NULL DEFAULT '{}',
  reasoning_effort_override TEXT,
  permission_mode TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chains (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  selection_json TEXT,
  model_label TEXT,
  agent_name TEXT NOT NULL DEFAULT '',
  agent_type TEXT NOT NULL DEFAULT '',
  agent_tier TEXT NOT NULL DEFAULT '',
  subagent_record_json TEXT,
  messages_json TEXT NOT NULL DEFAULT '[]',
  start_time TEXT,
  end_time TEXT
);

CREATE TABLE subagent_chains (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subagent_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (session_id, subagent_id)
);

CREATE INDEX IF NOT EXISTS idx_chains_session ON chains(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`;

const V2_SID = 'a1a1a1a1-1a1a-4a1a-8a1a-a1a1a1a1a1a1';
const V2_SID_TWO = 'b2b2b2b2-2b2b-4b2b-8b2b-b2b2b2b2b2b2';

let tempDir: string;
let instances: SessionDb[];

function makeV2Database(dbPath: string): void {
  const db = openSqliteDb(dbPath);
  db.exec(V2_SCHEMA_SQL);
  const insert = db.prepare(`
    INSERT INTO sessions (id, name, todo_store_json, reasoning_effort_override, permission_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(V2_SID, 'Pre-migration session', '{}', '"high"', 'ask', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  insert.run(V2_SID_TWO, 'Another pre-migration session', '{}', null, null, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  db.close();
}

function sessionColumnNames(dbPath: string): string[] {
  const db = openSqliteDb(dbPath);
  const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  db.close();
  return columns.map((column) => column.name);
}

function subagentColumnNames(dbPath: string): string[] {
  const db = openSqliteDb(dbPath);
  const columns = db.prepare('PRAGMA table_info(subagent_chains)').all() as Array<{ name: string }>;
  db.close();
  return columns.map((column) => column.name);
}

function chainColumnNames(dbPath: string): string[] {
  const db = openSqliteDb(dbPath);
  const columns = db.prepare('PRAGMA table_info(chains)').all() as Array<{ name: string }>;
  db.close();
  return columns.map((column) => column.name);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-db-migration-'));
  instances = [];
});

afterEach(() => {
  for (const db of instances) db.dispose();
  _clearDbCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('session schema legacy → v6 migration', () => {
  it('adds the tier_override column through the store open path', () => {
    const dbPath = path.join(tempDir, 'v2.db');
    makeV2Database(dbPath);
    expect(sessionColumnNames(dbPath)).not.toContain('tier_override');

    const db = new SessionDb(dbPath);
    instances.push(db);
    void db.connection;

    expect(sessionColumnNames(dbPath)).toContain('tier_override');
    expect(subagentColumnNames(dbPath)).toContain('summary_json');
    expect(chainColumnNames(dbPath)).toContain('summary_json');
    expect(chainColumnNames(dbPath)).toContain('recent_messages_json');
    expect(db.connection.prepare(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'chain_message_offsets'",
    ).pluck().get()).toBe(1);
  });

  it('loads pre-existing v2 rows with tierOverride null after migration', () => {
    const dbPath = path.join(tempDir, 'v2-load.db');
    makeV2Database(dbPath);

    const loaded = loadSession(V2_SID, { dbPath });
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(V2_SID);
    expect(loaded!.name).toBe('Pre-migration session');
    expect(loaded!.tierOverride).toBeNull();
    expect(loaded!.reasoningEffortOverride).toBe('high');

    const second = loadSession(V2_SID_TWO, { dbPath });
    expect(second).not.toBeNull();
    expect(second!.tierOverride).toBeNull();
  });

  it('is idempotent when run directly against an already-migrated database', () => {
    const dbPath = path.join(tempDir, 'v2-direct.db');
    makeV2Database(dbPath);

    const db = openSqliteDb(dbPath);
    applySessionSchemaMigrations(db);
    expect(
      db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'tier_override' })]));
    expect(
      db.prepare('PRAGMA table_info(subagent_chains)').all() as Array<{ name: string }>,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'summary_json' })]));

    // Running again must not throw or duplicate the column.
    expect(() => applySessionSchemaMigrations(db)).not.toThrow();
    db.close();
  });

  it('invalidates stale projections after an older writer updates canonical rows', () => {
    const dbPath = path.join(tempDir, 'downgrade-write.db');
    const initial = new SessionDb(dbPath);
    instances.push(initial);
    const db = initial.connection;
    db.prepare(`
      INSERT INTO sessions (
        id, name, todo_store_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      V2_SID,
      'Downgrade session',
      '{}',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO chains (
        id, session_id, ordinal, status, messages_json,
        summary_json, recent_messages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'chain-downgrade',
      V2_SID,
      0,
      'completed',
      '[{"id":"before"}]',
      '{"messageCount":1}',
      '[{"id":"before"}]',
    );
    db.prepare(`
      INSERT INTO subagent_chains (
        session_id, subagent_id, record_json, summary_json
      ) VALUES (?, ?, ?, ?)
    `).run(
      V2_SID,
      'sub-downgrade',
      '{"id":"before"}',
      '{"id":"before-summary"}',
    );
    db.prepare(`
      INSERT INTO chain_message_offsets (
        chain_id, message_index, byte_offset, byte_length
      ) VALUES (?, ?, ?, ?)
    `).run('chain-downgrade', 0, 1, 15);

    // Simulate a v5 binary reopening a v6 database and updating only the
    // canonical columns known to that writer.
    db.prepare('UPDATE chains SET messages_json = ? WHERE id = ?')
      .run('[{"id":"after"}]', 'chain-downgrade');
    db.prepare('UPDATE subagent_chains SET record_json = ? WHERE subagent_id = ?')
      .run('{"id":"after"}', 'sub-downgrade');
    db.prepare('UPDATE schema_meta SET value = ? WHERE key = ?')
      .run('5', 'schema_version');
    initial.dispose();

    const reopened = new SessionDb(dbPath);
    instances.push(reopened);
    const migrated = reopened.connection;
    expect(migrated.prepare(`
      SELECT messages_json, summary_json, recent_messages_json
      FROM chains WHERE id = ?
    `).get('chain-downgrade')).toEqual({
      messages_json: '[{"id":"after"}]',
      summary_json: null,
      recent_messages_json: null,
    });
    expect(migrated.prepare(`
      SELECT record_json, summary_json
      FROM subagent_chains WHERE subagent_id = ?
    `).get('sub-downgrade')).toEqual({
      record_json: '{"id":"after"}',
      summary_json: null,
    });
    expect(migrated.prepare(
      'SELECT COUNT(*) FROM chain_message_offsets WHERE chain_id = ?',
    ).pluck().get('chain-downgrade')).toBe(0);
    expect(migrated.prepare(
      'SELECT value FROM schema_meta WHERE key = ?',
    ).pluck().get('schema_version')).toBe(String(SESSION_SCHEMA_VERSION));
  });

  it('keeps new saves able to persist a tier override after migration', () => {
    const dbPath = path.join(tempDir, 'v2-save.db');
    makeV2Database(dbPath);

    const db = new SessionDb(dbPath);
    instances.push(db);
    void db.connection;

    // Persist through the storage layer and read back the override.
    _clearDbCache();
    saveSession({
      id: V2_SID,
      name: 'Pre-migration session',
      selection: null,
      modelLabel: null,
      cwd: null,
      chains: [],
      activeChainId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      subagentChains: [],
      todoStore: { tasks: [] },
      reasoningEffortOverride: null,
      tierOverride: 'flex',
      permissionMode: null,
    }, { dbPath });

    const loaded = loadSession(V2_SID, { dbPath })!;
    expect(loaded.tierOverride).toBe('flex');
  });
});
