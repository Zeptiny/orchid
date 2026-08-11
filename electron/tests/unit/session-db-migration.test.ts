/**
 * Session DB v2 → v3 migration tests.
 *
 * v3 added the `tier_override` column to the sessions table (service-tier
 * per-session override). These tests open databases created with the v2
 * schema (no tier_override), run the store's open path / migration helper,
 * and assert the column is added and pre-existing rows load with
 * `tierOverride: null`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionDb } from '../../src/main/session/db';
import { applySessionSchemaMigrations } from '../../src/main/session/schema';
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

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-db-migration-'));
  instances = [];
});

afterEach(() => {
  for (const db of instances) db.dispose();
  _clearDbCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('session schema v2 → v3 tier_override migration', () => {
  it('adds the tier_override column through the store open path', () => {
    const dbPath = path.join(tempDir, 'v2.db');
    makeV2Database(dbPath);
    expect(sessionColumnNames(dbPath)).not.toContain('tier_override');

    const db = new SessionDb(dbPath);
    instances.push(db);
    void db.connection;

    expect(sessionColumnNames(dbPath)).toContain('tier_override');
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

    // Running again must not throw or duplicate the column.
    expect(() => applySessionSchemaMigrations(db)).not.toThrow();
    db.close();
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
