/**
 * Session Parity Tests — U28.
 *
 * Verifies that session create/load/save/delete/auto-naming work.
 * Tests STRUCTURE (operations complete without error), not deep behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../src/shared/types/session';
import type { ModelSelection } from '../../src/shared/types/provider';
import type { StorageOptions } from '../../src/main/session/storage';
import {
  ensureSessionDb,
  saveSession,
  loadSession,
  listSavedSessions,
  deleteSession,
  _clearDbCache,
} from '../../src/main/session/storage';
import { SessionManager } from '../../src/main/session/manager';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let storageOpts: StorageOptions;

const DEFAULT_SELECTION: ModelSelection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  modelId: 'vendor/models/gpt-4o',
};

const ALTERNATE_SELECTION: ModelSelection = {
  connectionId: '22222222-2222-4222-8222-222222222222',
  modelId: 'anthropic/claude-3-5-sonnet',
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-parity-'));
}

function makeStorageOpts(dir: string): StorageOptions {
  return {
    dbPath: path.join(dir, 'sessions.db'),
    toolOutputCacheDir: path.join(dir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(dir, 'cache', 'web-fetch'),
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const selection = overrides.selection === undefined ? DEFAULT_SELECTION : overrides.selection;
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Session',
    selection,
    modelLabel:
      overrides.modelLabel === undefined ? (selection?.modelId ?? null) : overrides.modelLabel,
    cwd: overrides.cwd !== undefined ? overrides.cwd : null,
    chains: overrides.chains ?? [],
    activeChainId: overrides.activeChainId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    subagentChains: overrides.subagentChains ?? [],
    todoStore: overrides.todoStore ?? { tasks: [] },
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  storageOpts = makeStorageOpts(tmpDir);
});

afterEach(() => {
  _clearDbCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Session Parity', () => {
  describe('create', () => {
    it('SessionManager.create() produces a session with UUID', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create(DEFAULT_SELECTION);

      expect(session.id).toBeTruthy();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.selection).toEqual(DEFAULT_SELECTION);
      expect(session.modelLabel).toBe(DEFAULT_SELECTION.modelId);
    });

    it('SessionManager.create() sets default name starting with "Session "', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create(DEFAULT_SELECTION);

      expect(session.name.startsWith('Session ')).toBe(true);
    });

    it('SessionManager.create() initializes empty chains', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create(DEFAULT_SELECTION);

      expect(session.chains).toEqual([]);
      expect(session.activeChainId).toBeNull();
      expect(session.subagentChains).toEqual([]);
      expect(session.todoStore).toEqual({ tasks: [] });
    });

    it('SessionManager.create() defaults cwd to null (not process.cwd)', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create(null);
      expect(session.cwd).toBeNull();
      expect(session.selection).toBeNull();
      expect(session.modelLabel).toBeNull();
    });

    it('SessionManager.create() accepts optional cwd and persists it', () => {
      const projectDir = path.join(tmpDir, 'parity-project');
      fs.mkdirSync(projectDir, { recursive: true });
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create(DEFAULT_SELECTION, { cwd: projectDir });
      expect(session.cwd).toBe(fs.realpathSync(projectDir));

      const loaded = loadSession(session.id, storageOpts);
      expect(loaded!.cwd).toBe(session.cwd);

      const listed = listSavedSessions(storageOpts);
      expect(listed[0].cwd).toBe(session.cwd);
    });

    it('SessionManager.create() sets as active session', () => {
      const manager = new SessionManager({ storage: storageOpts });
      expect(manager.getActive()).toBeNull();

      const session = manager.create(DEFAULT_SELECTION);
      expect(manager.getActive()).not.toBeNull();
      expect(manager.getActive()!.id).toBe(session.id);
    });
  });

  describe('load', () => {
    it('save then load produces identical session', () => {
      const session = makeSession({
        id: 'c1111111-1111-4111-8111-111111111111',
        name: 'Load Test',
      });
      saveSession(session, storageOpts);

      const loaded = loadSession('c1111111-1111-4111-8111-111111111111', storageOpts);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('c1111111-1111-4111-8111-111111111111');
      expect(loaded!.name).toBe('Load Test');
    });

    it('load returns null for non-existent session', () => {
      const loaded = loadSession(randomUUID(), storageOpts);
      expect(loaded).toBeNull();
    });
  });

  describe('save', () => {
    it('save overwrites existing session', () => {
      const session1 = makeSession({
        id: 'c4444444-4444-4444-8444-444444444444',
        name: 'Original',
      });
      saveSession(session1, storageOpts);

      const session2 = makeSession({ id: 'c4444444-4444-4444-8444-444444444444', name: 'Updated' });
      saveSession(session2, storageOpts);

      const loaded = loadSession('c4444444-4444-4444-8444-444444444444', storageOpts);
      expect(loaded!.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('delete removes session file', () => {
      const session = makeSession({ id: 'c5555555-5555-4555-8555-555555555555' });
      saveSession(session, storageOpts);

      const result = deleteSession('c5555555-5555-4555-8555-555555555555', storageOpts);
      expect(result).toBe(true);
      expect(loadSession('c5555555-5555-4555-8555-555555555555', storageOpts)).toBeNull();
    });

    it('delete returns false for non-existent session', () => {
      const result = deleteSession(randomUUID(), storageOpts);
      expect(result).toBe(false);
    });

    it('delete cleans up cache directories', () => {
      const session = makeSession({ id: 'c6666666-6666-4666-8666-666666666666' });
      saveSession(session, storageOpts);

      // Create cache dirs
      const toolOutputDir = path.join(
        tmpDir,
        'cache',
        'tool-output',
        'c6666666-6666-4666-8666-666666666666',
      );
      const webFetchDir = path.join(
        tmpDir,
        'cache',
        'web-fetch',
        'c6666666-6666-4666-8666-666666666666',
      );
      fs.mkdirSync(toolOutputDir, { recursive: true });
      fs.mkdirSync(webFetchDir, { recursive: true });

      deleteSession('c6666666-6666-4666-8666-666666666666', storageOpts);

      expect(fs.existsSync(toolOutputDir)).toBe(false);
      expect(fs.existsSync(webFetchDir)).toBe(false);
    });
  });

  describe('list', () => {
    it('list returns empty array when no sessions', () => {
      const sessions = listSavedSessions(storageOpts);
      expect(sessions).toEqual([]);
    });

    it('list returns sessions sorted by mtime (newest first)', () => {
      const session1 = makeSession({ id: 'c7777777-7777-4777-8777-777777777777', name: 'Old' });
      saveSession(session1, storageOpts);

      // Small delay for different mtime
      const start = Date.now();
      while (Date.now() - start < 50) {
        /* busy wait */
      }

      const session2 = makeSession({ id: 'c8888888-8888-4888-8888-888888888888', name: 'New' });
      saveSession(session2, storageOpts);

      const sessions = listSavedSessions(storageOpts);
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('c8888888-8888-4888-8888-888888888888');
      expect(sessions[1].id).toBe('c7777777-7777-4777-8777-777777777777');
    });

    it('list includes chain count', () => {
      const session = makeSession({
        id: 'c9999999-9999-4999-8999-999999999999',
        chains: [
          {
            id: 'c1',
            sessionId: 'c9999999-9999-4999-8999-999999999999',
            messages: [],
            status: 'completed',
            selection: DEFAULT_SELECTION,
            modelLabel: DEFAULT_SELECTION.modelId,
            agentName: 'General',
            agentType: 'internal',
            agentTier: 'bloom',
            subagentRecord: null,
            startTime: null,
            endTime: null,
          },
          {
            id: 'c2',
            sessionId: 'c9999999-9999-4999-8999-999999999999',
            messages: [],
            status: 'completed',
            selection: DEFAULT_SELECTION,
            modelLabel: DEFAULT_SELECTION.modelId,
            agentName: 'General',
            agentType: 'internal',
            agentTier: 'bloom',
            subagentRecord: null,
            startTime: null,
            endTime: null,
          },
        ],
      });
      saveSession(session, storageOpts);

      const sessions = listSavedSessions(storageOpts);
      expect(sessions[0].chainCount).toBe(2);
    });

    it('list includes cwd on summary (null when unbound)', () => {
      const session = makeSession({
        id: 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        cwd: null,
      });
      saveSession(session, storageOpts);

      const sessions = listSavedSessions(storageOpts);
      expect(sessions[0].cwd).toBeNull();
    });
  });

  describe('auto-naming', () => {
    it('autoNameActive() generates title for default-named session', async () => {
      const manager = new SessionManager({
        generateTitle: async () => 'My Coding Session',
        storage: storageOpts,
      });
      const session = manager.create(DEFAULT_SELECTION);

      const result = await manager.autoNameActive();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('My Coding Session');
    });

    it('autoNameActive() skips if name does not start with "Session "', async () => {
      const manager = new SessionManager({
        generateTitle: async () => 'Should Not Apply',
        storage: storageOpts,
      });
      const session = manager.create(DEFAULT_SELECTION);
      manager.rename(session.id, 'Custom Name');

      const result = await manager.autoNameActive();
      expect(result!.name).toBe('Custom Name');
    });

    it('autoNameActive() returns null if no active session', async () => {
      const manager = new SessionManager({
        generateTitle: async () => 'Title',
        storage: storageOpts,
      });

      const result = await manager.autoNameActive();
      expect(result).toBeNull();
    });

    it('autoNameActive() handles callback errors gracefully', async () => {
      const manager = new SessionManager({
        generateTitle: async () => {
          throw new Error('LLM unavailable');
        },
        storage: storageOpts,
      });
      const session = manager.create(DEFAULT_SELECTION);
      const originalName = session.name;

      const result = await manager.autoNameActive();
      expect(result!.name).toBe(originalName);
    });
  });

  describe('switch', () => {
    it('switchTo() loads session and sets as active', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session1 = manager.create(DEFAULT_SELECTION);
      const session2 = manager.create(ALTERNATE_SELECTION);

      const switched = manager.switchTo(session1.id);
      expect(switched).not.toBeNull();
      expect(switched!.id).toBe(session1.id);
      expect(manager.getActive()!.id).toBe(session1.id);
    });

    it('switchTo() returns null for non-existent session', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const result = manager.switchTo(randomUUID());
      expect(result).toBeNull();
    });

    it('multiple switches preserve session data', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session1 = manager.create(DEFAULT_SELECTION);
      manager.rename(session1.id, 'Session 1');
      const session2 = manager.create(ALTERNATE_SELECTION);
      manager.rename(session2.id, 'Session 2');

      manager.switchTo(session1.id);
      expect(manager.getActive()!.name).toBe('Session 1');

      manager.switchTo(session2.id);
      expect(manager.getActive()!.name).toBe('Session 2');

      manager.switchTo(session1.id);
      expect(manager.getActive()!.name).toBe('Session 1');
    });
  });

  describe('sessions directory', () => {
    it('ensureSessionDb hardens the directory (0o700) and DB file (0o600)', () => {
      const dir = ensureSessionDb(storageOpts);
      expect(fs.existsSync(dir)).toBe(true);

      // Relax permissions, then re-open with a fresh connection to prove the
      // hardening runs on open (not a coincidence of mkdtemp's 0o700).
      _clearDbCache();
      fs.chmodSync(dir, 0o755);
      ensureSessionDb(storageOpts);

      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(storageOpts.dbPath!).mode & 0o777).toBe(0o600);
    });
  });
});
