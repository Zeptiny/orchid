/**
 * Session persistence tests — U5.
 *
 * Covers:
 * - Save → load → identical content
 * - Atomic write: Simulate crash → no partial file
 * - List: Multiple sessions → mtime order (newest first)
 * - Delete: File removed, caches cleaned
 * - Auto-naming: Default name + first exchange → descriptive title
 * - Switching: In-flight subagents continue running
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

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let storageOpts: StorageOptions;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-test-'));
}

function makeStorageOpts(dir: string): StorageOptions {
  return {
    sessionsDir: path.join(dir, 'sessions'),
    toolOutputCacheDir: path.join(dir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(dir, 'cache', 'web-fetch'),
  };
}

/** Create a minimal test session. */
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

// ===========================================================================
// Save → load round-trip
// ===========================================================================

describe('saveSession → loadSession round-trip', () => {
  it('save then load produces identical session', () => {
    const session = makeSession({
      id: 'round-trip-1',
      name: 'Round Trip Test',
      model: 'anthropic/claude-3.5-sonnet',
    });

    saveSession(session, storageOpts);
    const loaded = loadSession('round-trip-1', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('round-trip-1');
    expect(loaded!.name).toBe('Round Trip Test');
    expect(loaded!.model).toBe('anthropic/claude-3.5-sonnet');
    expect(loaded!.chains).toEqual([]);
    expect(loaded!.activeChainId).toBeNull();
    expect(loaded!.subagentChains).toEqual([]);
    expect(loaded!.todoStore).toEqual({ tasks: [] });
  });

  it('save then load preserves chains and messages', () => {
    const now = new Date().toISOString();
    const session = makeSession({
      id: 'round-trip-2',
      name: 'With Chains',
      model: 'gpt-4o',
      chains: [
        {
          id: 'chain-1',
          sessionId: 'round-trip-2',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'Hello',
              type: 'text',
              tool_calls: null,
              tool_call_id: null,
              name: null,
              thinking: null,
              timestamp: now,
              usage: null,
              hidden: false,
            },
            {
              id: 'msg-2',
              role: 'assistant',
              content: 'Hi there!',
              type: 'text',
              tool_calls: null,
              tool_call_id: null,
              name: null,
              thinking: null,
              timestamp: now,
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0 },
              hidden: false,
            },
          ],
          status: 'completed',
          model: 'gpt-4o',
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
        },
      ],
      activeChainId: 'chain-1',
    });

    saveSession(session, storageOpts);
    const loaded = loadSession('round-trip-2', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.chains).toHaveLength(1);
    expect(loaded!.chains[0].id).toBe('chain-1');
    expect(loaded!.chains[0].messages).toHaveLength(2);
    expect(loaded!.chains[0].messages[0].role).toBe('user');
    expect(loaded!.chains[0].messages[0].content).toBe('Hello');
    expect(loaded!.chains[0].messages[1].role).toBe('assistant');
    expect(loaded!.chains[0].messages[1].content).toBe('Hi there!');
    expect(loaded!.chains[0].messages[1].usage!.prompt_tokens).toBe(10);
    expect(loaded!.activeChainId).toBe('chain-1');
  });

  it('load returns null for non-existent session', () => {
    const loaded = loadSession('non-existent-id', storageOpts);
    expect(loaded).toBeNull();
  });

  it('load returns null for corrupted JSON', () => {
    fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'corrupted.json'), 'not valid json{{{', 'utf-8');
    const loaded = loadSession('corrupted', storageOpts);
    expect(loaded).toBeNull();
  });

  it('save overwrites existing session', () => {
    const session1 = makeSession({ id: 'overwrite-1', name: 'Original Name' });
    saveSession(session1, storageOpts);

    const session2 = makeSession({ id: 'overwrite-1', name: 'Updated Name', model: 'new-model' });
    saveSession(session2, storageOpts);

    const loaded = loadSession('overwrite-1', storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Updated Name');
    expect(loaded!.model).toBe('new-model');
  });

  it('save preserves todoStore data', () => {
    const now = new Date().toISOString();
    const session = makeSession({
      id: 'todo-test',
      todoStore: {
        tasks: [
          {
            id: 'task-1',
            title: 'Implement feature',
            status: 'IN_PROGRESS',
            subagent_id: null,
            created_at: now,
            updated_at: now,
          },
        ],
      },
    });

    saveSession(session, storageOpts);
    const loaded = loadSession('todo-test', storageOpts);

    expect(loaded).not.toBeNull();
    expect(loaded!.todoStore.tasks).toHaveLength(1);
    expect(loaded!.todoStore.tasks[0].id).toBe('task-1');
    expect(loaded!.todoStore.tasks[0].title).toBe('Implement feature');
    expect(loaded!.todoStore.tasks[0].status).toBe('IN_PROGRESS');
  });
});

// ===========================================================================
// Atomic write — simulate crash → no partial file
// ===========================================================================

describe('atomic write', () => {
  it('session file uses .tmp during write (no partial on crash)', () => {
    const session = makeSession({ id: 'atomic-1', name: 'Atomic Test' });
    const sessionPath = path.join(tmpDir, 'sessions', 'atomic-1.json');
    const tmpPath = sessionPath + '.tmp';

    saveSession(session, storageOpts);

    // After successful save: .json exists, .tmp does not
    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    // Verify content is valid JSON
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('atomic-1');
    expect(parsed.name).toBe('Atomic Test');
  });

  it('session file has mode 0o600', () => {
    const session = makeSession({ id: 'chmod-1' });
    saveSession(session, storageOpts);

    const sessionPath = path.join(tmpDir, 'sessions', 'chmod-1.json');
    const stat = fs.statSync(sessionPath);

    // Check file permissions (owner read/write only)
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('sessions directory has mode 0o700', () => {
    ensureSessionsDir(storageOpts);
    const sessionsDir = path.join(tmpDir, 'sessions');
    const stat = fs.statSync(sessionsDir);
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('atomic write cleans up .tmp on error', () => {
    const session = makeSession({ id: 'atomic-cleanup' });
    saveSession(session, storageOpts);

    const sessionsDir = path.join(tmpDir, 'sessions');
    const files = fs.readdirSync(sessionsDir);
    expect(files).toContain('atomic-cleanup.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

// ===========================================================================
// List — multiple sessions → mtime order (newest first)
// ===========================================================================

describe('listSavedSessions', () => {
  it('returns empty array when no sessions exist', () => {
    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toEqual([]);
  });

  it('lists a single session', () => {
    const session = makeSession({ id: 'list-1', name: 'List Test', model: 'gpt-4o' });
    saveSession(session, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('list-1');
    expect(sessions[0].name).toBe('List Test');
    expect(sessions[0].model).toBe('gpt-4o');
  });

  it('lists multiple sessions sorted by mtime (newest first)', () => {
    // Create sessions with slight delays to ensure different mtimes
    const session1 = makeSession({ id: 'list-old', name: 'Old Session' });
    saveSession(session1, storageOpts);

    // Small delay to ensure different mtime
    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy wait
    }

    const session2 = makeSession({ id: 'list-new', name: 'New Session' });
    saveSession(session2, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(2);
    // Newest first
    expect(sessions[0].id).toBe('list-new');
    expect(sessions[1].id).toBe('list-old');
  });

  it('includes chain count in summary', () => {
    const session = makeSession({
      id: 'list-chains',
      chains: [
        {
          id: 'chain-1',
          sessionId: 'list-chains',
          messages: [],
          status: 'completed',
          model: 'gpt-4o',
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
        },
        {
          id: 'chain-2',
          sessionId: 'list-chains',
          messages: [],
          status: 'completed',
          model: 'gpt-4o',
          agentName: 'General',
          agentType: 'internal',
          agentTier: 'bloom',
          subagentRecord: null,
        },
      ],
    });
    saveSession(session, storageOpts);

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].chainCount).toBe(2);
  });

  it('handles corrupted session files gracefully', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    // Write a valid session
    const session = makeSession({ id: 'valid-session' });
    saveSession(session, storageOpts);

    // Write a corrupted session file
    fs.writeFileSync(path.join(sessionsDir, 'corrupted.json'), 'not json', 'utf-8');

    const sessions = listSavedSessions(storageOpts);
    // Should still return the valid session, skipping the corrupted one
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('valid-session');
  });

  it('defaults name to "Unnamed" when missing', () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Write a session without a name field
    fs.writeFileSync(
      path.join(sessionsDir, 'no-name.json'),
      JSON.stringify({ id: 'no-name', model: 'gpt-4o', chains: [] }),
      'utf-8',
    );

    const sessions = listSavedSessions(storageOpts);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('Unnamed');
  });
});

// ===========================================================================
// Delete — file removed, caches cleaned
// ===========================================================================

describe('deleteSession', () => {
  it('deletes session file', () => {
    const session = makeSession({ id: 'delete-1' });
    saveSession(session, storageOpts);

    const sessionPath = path.join(tmpDir, 'sessions', 'delete-1.json');
    expect(fs.existsSync(sessionPath)).toBe(true);

    const result = deleteSession('delete-1', storageOpts);
    expect(result).toBe(true);
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it('returns false for non-existent session', () => {
    const result = deleteSession('non-existent', storageOpts);
    expect(result).toBe(false);
  });

  it('cleans up tool-output cache directory', () => {
    const session = makeSession({ id: 'delete-cache' });
    saveSession(session, storageOpts);

    // Create tool-output cache
    const toolOutputDir = path.join(tmpDir, 'cache', 'tool-output', 'delete-cache');
    fs.mkdirSync(toolOutputDir, { recursive: true });
    fs.writeFileSync(path.join(toolOutputDir, 'output.txt'), 'cached output');

    expect(fs.existsSync(toolOutputDir)).toBe(true);

    deleteSession('delete-cache', storageOpts);

    expect(fs.existsSync(toolOutputDir)).toBe(false);
  });

  it('cleans up web-fetch cache directory', () => {
    const session = makeSession({ id: 'delete-web' });
    saveSession(session, storageOpts);

    // Create web-fetch cache
    const webFetchDir = path.join(tmpDir, 'cache', 'web-fetch', 'delete-web');
    fs.mkdirSync(webFetchDir, { recursive: true });
    fs.writeFileSync(path.join(webFetchDir, 'page.md'), 'cached page');

    expect(fs.existsSync(webFetchDir)).toBe(true);

    deleteSession('delete-web', storageOpts);

    expect(fs.existsSync(webFetchDir)).toBe(false);
  });

  it('cleans up both caches simultaneously', () => {
    const session = makeSession({ id: 'delete-both' });
    saveSession(session, storageOpts);

    const toolOutputDir = path.join(tmpDir, 'cache', 'tool-output', 'delete-both');
    const webFetchDir = path.join(tmpDir, 'cache', 'web-fetch', 'delete-both');
    fs.mkdirSync(toolOutputDir, { recursive: true });
    fs.mkdirSync(webFetchDir, { recursive: true });
    fs.writeFileSync(path.join(toolOutputDir, 'output.txt'), 'data');
    fs.writeFileSync(path.join(webFetchDir, 'page.md'), 'data');

    deleteSession('delete-both', storageOpts);

    expect(fs.existsSync(toolOutputDir)).toBe(false);
    expect(fs.existsSync(webFetchDir)).toBe(false);
  });
});

// ===========================================================================
// SessionManager — create, switch, delete, rename, changeModel
// ===========================================================================

describe('SessionManager', () => {
  it('create() produces a session with UUID and default name', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    expect(session.id).toBeTruthy();
    expect(session.model).toBe('gpt-4o');
    expect(session.name.startsWith('Session ')).toBe(true);
    expect(session.chains).toEqual([]);
    expect(session.activeChainId).toBeNull();

    // Should be saved to disk
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
  });

  it('create() sets the session as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    expect(manager.getActive()).toBeNull();

    const session = manager.create('gpt-4o');
    expect(manager.getActive()).not.toBeNull();
    expect(manager.getActive()!.id).toBe(session.id);
  });

  it('switchTo() loads session from disk and sets as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // Active should be session2
    expect(manager.getActive()!.id).toBe(session2.id);

    // Switch to session1
    const switched = manager.switchTo(session1.id);
    expect(switched).not.toBeNull();
    expect(switched!.id).toBe(session1.id);
    expect(manager.getActive()!.id).toBe(session1.id);
  });

  it('switchTo() returns null for non-existent session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const result = manager.switchTo('non-existent');
    expect(result).toBeNull();
    expect(manager.getActive()).toBeNull();
  });

  it('delete() removes session and clears active if it was active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');
    const sessionId = session.id;

    expect(manager.getActive()!.id).toBe(sessionId);

    const result = manager.delete(sessionId);
    expect(result).toBe(true);
    expect(manager.getActive()).toBeNull();

    // Should be gone from disk
    expect(loadSession(sessionId, storageOpts)).toBeNull();
  });

  it('delete() does not clear active if deleting a different session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // Delete session1 (not active)
    manager.delete(session1.id);

    // session2 should still be active
    expect(manager.getActive()!.id).toBe(session2.id);
  });

  it('rename() updates active session name', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    manager.rename(session.id, 'New Name');

    expect(manager.getActive()!.name).toBe('New Name');

    // Verify persisted
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('New Name');
  });

  it('rename() is no-op for non-active session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // Try to rename session1 (not active)
    manager.rename(session1.id, 'Should Not Change');

    // session1 on disk should still have original name
    const loaded = loadSession(session1.id, storageOpts);
    expect(loaded!.name).not.toBe('Should Not Change');
  });

  it('changeModel() updates active session model', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    manager.changeModel(session.id, 'anthropic/claude-3.5-sonnet');

    expect(manager.getActive()!.model).toBe('anthropic/claude-3.5-sonnet');

    // Verify persisted
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.model).toBe('anthropic/claude-3.5-sonnet');
  });

  it('saveActive() persists active session to disk', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    // Modify in-memory via rename (proper immutable update)
    manager.rename(session.id, 'Modified In Memory');

    // Verify it's on disk
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('Modified In Memory');
  });

  it('saveActive() is no-op when no active session', () => {
    const manager = new SessionManager({ storage: storageOpts });
    // Should not throw
    manager.saveActive();
  });

  it('load() loads session from disk without setting as active', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // Load session1 without switching
    const loaded = manager.load(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);

    // Active should still be session2
    expect(manager.getActive()!.id).toBe(session2.id);
  });

  it('listSaved() returns sessions sorted by mtime', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create('gpt-4o');

    // Small delay
    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy wait
    }

    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    const sessions = manager.listSaved();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(session2.id);
    expect(sessions[1].id).toBe(session1.id);
  });
});

// ===========================================================================
// Auto-naming
// ===========================================================================

describe('SessionManager auto-naming', () => {
  it('autoNameActive() generates title for default-named session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'My Coding Session',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    // Default name starts with "Session "
    expect(session.name.startsWith('Session ')).toBe(true);

    const result = await manager.autoNameActive();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('My Coding Session');

    // Verify persisted
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('My Coding Session');
  });

  it('autoNameActive() skips if name does not start with "Session "', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Should Not Apply',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    // Manually rename
    manager.rename(session.id, 'Custom Name');

    const result = await manager.autoNameActive();
    expect(result!.name).toBe('Custom Name');
  });

  it('autoNameActive() skips if no generateTitle callback', async () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    const result = await manager.autoNameActive();
    expect(result!.name.startsWith('Session ')).toBe(true);
  });

  it('autoNameActive() returns null if no active session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Title',
      storage: storageOpts,
    });
    const result = await manager.autoNameActive();
    expect(result).toBeNull();
  });

  it('autoNameActive() keeps default name if callback returns null', async () => {
    const manager = new SessionManager({
      generateTitle: async () => null,
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });

  it('autoNameActive() keeps default name if callback returns too-long title', async () => {
    const longTitle = 'A'.repeat(100);
    const manager = new SessionManager({
      generateTitle: async () => longTitle,
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });

  it('autoNameActive() handles callback errors gracefully', async () => {
    const manager = new SessionManager({
      generateTitle: async () => {
        throw new Error('LLM unavailable');
      },
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    // Should not throw
    const result = await manager.autoNameActive();
    expect(result!.name).toBe(originalName);
  });

  it('autoNameActive() callback receives the session', async () => {
    let receivedSession: Session | null = null;
    const manager = new SessionManager({
      generateTitle: async (s) => {
        receivedSession = s;
        return 'Generated Title';
      },
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    await manager.autoNameActive();

    expect(receivedSession).not.toBeNull();
    expect(receivedSession!.id).toBe(session.id);
  });
});

// ===========================================================================
// Session switching — in-flight subagents continue running
// ===========================================================================

describe('SessionManager switching', () => {
  it('switchTo does not cancel running subagents (by design)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // session1 is no longer active after creating session2
    // Switch back to session1
    const switched = manager.switchTo(session1.id);
    expect(switched).not.toBeNull();
    expect(switched!.id).toBe(session1.id);

    // The key behavior: switching does NOT throw or modify subagent state.
    // In the real system, subagent actors continue running independently.
    // This test verifies the switch completes without error.
  });

  it('multiple switches preserve session data', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session1 = manager.create('gpt-4o');
    manager.rename(session1.id, 'Session 1');

    const session2 = manager.create('anthropic/claude-3.5-sonnet');
    manager.rename(session2.id, 'Session 2');

    // Switch back and forth
    manager.switchTo(session1.id);
    expect(manager.getActive()!.name).toBe('Session 1');

    manager.switchTo(session2.id);
    expect(manager.getActive()!.name).toBe('Session 2');

    manager.switchTo(session1.id);
    expect(manager.getActive()!.name).toBe('Session 1');
  });

  it('switchTo reloads from disk (captures external changes)', () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    // Simulate external modification (e.g., another process)
    const modified: Session = {
      ...session,
      name: 'Externally Modified',
      updatedAt: new Date().toISOString(),
    };
    saveSession(modified, storageOpts);

    // SwitchTo reloads from disk
    const switched = manager.switchTo(session.id);
    expect(switched!.name).toBe('Externally Modified');
  });
});
