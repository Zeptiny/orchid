/**
 * Session Parity Tests — U28.
 *
 * Verifies that session create/load/save/delete/auto-naming work.
 * Tests STRUCTURE (operations complete without error), not deep behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../src/shared/types/session';
import type { StorageOptions } from '../../src/main/session/storage';
import {
  ensureSessionsDir,
  saveSession,
  loadSession,
  listSavedSessions,
  deleteSession,
} from '../../src/main/session/storage';
import { SessionManager } from '../../src/main/session/manager';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let storageOpts: StorageOptions;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-parity-'));
}

function makeStorageOpts(dir: string): StorageOptions {
  return {
    sessionsDir: path.join(dir, 'sessions'),
    toolOutputCacheDir: path.join(dir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(dir, 'cache', 'web-fetch'),
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `session-${Math.random().toString(36).slice(2, 10)}`,
    name: overrides.name ?? 'Test Session',
    model: overrides.model ?? 'gpt-4o',
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Session Parity', () => {
  describe('create', () => {
    it('SessionManager.create() produces a session with UUID', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create('gpt-4o');

      expect(session.id).toBeTruthy();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.model).toBe('gpt-4o');
    });

    it('SessionManager.create() sets default name starting with "Session "', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create('gpt-4o');

      expect(session.name.startsWith('Session ')).toBe(true);
    });

    it('SessionManager.create() initializes empty chains', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session = manager.create('gpt-4o');

      expect(session.chains).toEqual([]);
      expect(session.activeChainId).toBeNull();
      expect(session.subagentChains).toEqual([]);
      expect(session.todoStore).toEqual({ tasks: [] });
    });

    it('SessionManager.create() sets as active session', () => {
      const manager = new SessionManager({ storage: storageOpts });
      expect(manager.getActive()).toBeNull();

      const session = manager.create('gpt-4o');
      expect(manager.getActive()).not.toBeNull();
      expect(manager.getActive()!.id).toBe(session.id);
    });
  });

  describe('load', () => {
    it('save then load produces identical session', () => {
      const session = makeSession({ id: 'load-test', name: 'Load Test' });
      saveSession(session, storageOpts);

      const loaded = loadSession('load-test', storageOpts);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('load-test');
      expect(loaded!.name).toBe('Load Test');
    });

    it('load returns null for non-existent session', () => {
      const loaded = loadSession('non-existent', storageOpts);
      expect(loaded).toBeNull();
    });

    it('load returns null for corrupted JSON', () => {
      fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'sessions', 'corrupted.json'), 'not json', 'utf-8');

      const loaded = loadSession('corrupted', storageOpts);
      expect(loaded).toBeNull();
    });
  });

  describe('save', () => {
    it('save creates a session file', () => {
      const session = makeSession({ id: 'save-test' });
      saveSession(session, storageOpts);

      const filePath = path.join(tmpDir, 'sessions', 'save-test.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('save uses atomic write (no .tmp file after completion)', () => {
      const session = makeSession({ id: 'atomic-test' });
      saveSession(session, storageOpts);

      const files = fs.readdirSync(path.join(tmpDir, 'sessions'));
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    });

    it('save overwrites existing session', () => {
      const session1 = makeSession({ id: 'overwrite', name: 'Original' });
      saveSession(session1, storageOpts);

      const session2 = makeSession({ id: 'overwrite', name: 'Updated' });
      saveSession(session2, storageOpts);

      const loaded = loadSession('overwrite', storageOpts);
      expect(loaded!.name).toBe('Updated');
    });
  });

  describe('delete', () => {
    it('delete removes session file', () => {
      const session = makeSession({ id: 'delete-test' });
      saveSession(session, storageOpts);

      const result = deleteSession('delete-test', storageOpts);
      expect(result).toBe(true);
      expect(loadSession('delete-test', storageOpts)).toBeNull();
    });

    it('delete returns false for non-existent session', () => {
      const result = deleteSession('non-existent', storageOpts);
      expect(result).toBe(false);
    });

    it('delete cleans up cache directories', () => {
      const session = makeSession({ id: 'cache-test' });
      saveSession(session, storageOpts);

      // Create cache dirs
      const toolOutputDir = path.join(tmpDir, 'cache', 'tool-output', 'cache-test');
      const webFetchDir = path.join(tmpDir, 'cache', 'web-fetch', 'cache-test');
      fs.mkdirSync(toolOutputDir, { recursive: true });
      fs.mkdirSync(webFetchDir, { recursive: true });

      deleteSession('cache-test', storageOpts);

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
      const session1 = makeSession({ id: 'old', name: 'Old' });
      saveSession(session1, storageOpts);

      // Small delay for different mtime
      const start = Date.now();
      while (Date.now() - start < 50) { /* busy wait */ }

      const session2 = makeSession({ id: 'new', name: 'New' });
      saveSession(session2, storageOpts);

      const sessions = listSavedSessions(storageOpts);
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('new');
      expect(sessions[1].id).toBe('old');
    });

    it('list includes chain count', () => {
      const session = makeSession({
        id: 'chains-test',
        chains: [
          { id: 'c1', sessionId: 'chains-test', messages: [], status: 'completed', model: 'gpt-4o', agentName: 'General', agentType: 'internal', agentTier: 'bloom', subagentRecord: null },
          { id: 'c2', sessionId: 'chains-test', messages: [], status: 'completed', model: 'gpt-4o', agentName: 'General', agentType: 'internal', agentTier: 'bloom', subagentRecord: null },
        ],
      });
      saveSession(session, storageOpts);

      const sessions = listSavedSessions(storageOpts);
      expect(sessions[0].chainCount).toBe(2);
    });
  });

  describe('auto-naming', () => {
    it('autoNameActive() generates title for default-named session', async () => {
      const manager = new SessionManager({
        generateTitle: async () => 'My Coding Session',
        storage: storageOpts,
      });
      const session = manager.create('gpt-4o');

      const result = await manager.autoNameActive();
      expect(result).not.toBeNull();
      expect(result!.name).toBe('My Coding Session');
    });

    it('autoNameActive() skips if name does not start with "Session "', async () => {
      const manager = new SessionManager({
        generateTitle: async () => 'Should Not Apply',
        storage: storageOpts,
      });
      const session = manager.create('gpt-4o');
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
        generateTitle: async () => { throw new Error('LLM unavailable'); },
        storage: storageOpts,
      });
      const session = manager.create('gpt-4o');
      const originalName = session.name;

      const result = await manager.autoNameActive();
      expect(result!.name).toBe(originalName);
    });
  });

  describe('switch', () => {
    it('switchTo() loads session and sets as active', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session1 = manager.create('gpt-4o');
      const session2 = manager.create('anthropic/claude-3.5-sonnet');

      const switched = manager.switchTo(session1.id);
      expect(switched).not.toBeNull();
      expect(switched!.id).toBe(session1.id);
      expect(manager.getActive()!.id).toBe(session1.id);
    });

    it('switchTo() returns null for non-existent session', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const result = manager.switchTo('non-existent');
      expect(result).toBeNull();
    });

    it('multiple switches preserve session data', () => {
      const manager = new SessionManager({ storage: storageOpts });
      const session1 = manager.create('gpt-4o');
      manager.rename(session1.id, 'Session 1');
      const session2 = manager.create('anthropic/claude-3.5-sonnet');
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
    it('ensureSessionsDir creates directory with mode 0o700', () => {
      const dir = ensureSessionsDir(storageOpts);
      expect(fs.existsSync(dir)).toBe(true);

      const stat = fs.statSync(dir);
      // eslint-disable-next-line no-bitwise
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });
});
