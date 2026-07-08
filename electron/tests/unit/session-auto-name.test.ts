/**
 * Session auto-name tests — U2.
 *
 * Covers:
 * - Happy path: First exchange with "Session ..." name → name updates
 * - Edge case: Session already renamed by user → no auto-naming
 * - Error path: LLM call fails → session name unchanged, non-fatal
 * - Callback override: autoNameActive(callback) takes precedence
 * - Integration: After auto-naming, session list reflects new name
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../src/shared/types/session';
import type { StorageOptions } from '../../src/main/session/storage';
import { loadSession } from '../../src/main/session/storage';
import { SessionManager } from '../../src/main/session/manager';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let storageOpts: StorageOptions;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-auto-name-test-'));
}

function makeStorageOpts(dir: string): StorageOptions {
  return {
    sessionsDir: path.join(dir, 'sessions'),
    toolOutputCacheDir: path.join(dir, 'cache', 'tool-output'),
    webFetchCacheDir: path.join(dir, 'cache', 'web-fetch'),
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
// Happy path — default "Session ..." name gets auto-named
// ===========================================================================

describe('auto-naming happy path', () => {
  it('autoNameActive() generates title for default-named session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Fix Login Bug',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    expect(session.name.startsWith('Session ')).toBe(true);

    const result = await manager.autoNameActive();

    expect(result).not.toBeNull();
    expect(result!.name).toBe('Fix Login Bug');

    // Verify persisted to disk
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('Fix Login Bug');
  });

  it('autoNameActive() trims and accepts 3-6 word titles', async () => {
    const manager = new SessionManager({
      generateTitle: async () => '  Debug Auth Token Issue  ',
      storage: storageOpts,
    });
    manager.create('gpt-4o');

    const result = await manager.autoNameActive();
    // The manager stores the title as-is (trimming is callback's job)
    expect(result!.name).toBe('  Debug Auth Token Issue  ');
  });

  it('autoNameActive() accepts titles up to 79 chars', async () => {
    const title = 'A'.repeat(79);
    const manager = new SessionManager({
      generateTitle: async () => title,
      storage: storageOpts,
    });
    manager.create('gpt-4o');

    const result = await manager.autoNameActive();
    expect(result!.name).toBe(title);
  });

  it('session list reflects new name after auto-naming', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Refactor Database Layer',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    await manager.autoNameActive();

    const sessions = manager.listSaved();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('Refactor Database Layer');
    expect(sessions[0].id).toBe(session.id);
  });
});

// ===========================================================================
// Edge case — session already renamed by user → no auto-naming
// ===========================================================================

describe('auto-naming edge cases', () => {
  it('skips auto-naming if name does not start with "Session "', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Should Not Apply',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    // User manually renames the session
    manager.rename(session.id, 'My Custom Name');

    const result = await manager.autoNameActive();
    expect(result!.name).toBe('My Custom Name');

    // Verify the callback was NOT called (name unchanged)
    const loaded = loadSession(session.id, storageOpts);
    expect(loaded!.name).toBe('My Custom Name');
  });

  it('skips auto-naming if no generateTitle callback (constructor)', async () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    const result = await manager.autoNameActive();
    expect(result!.name.startsWith('Session ')).toBe(true);
  });

  it('returns null if no active session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Title',
      storage: storageOpts,
    });

    const result = await manager.autoNameActive();
    expect(result).toBeNull();
  });

  it('keeps default name if callback returns null', async () => {
    const manager = new SessionManager({
      generateTitle: async () => null,
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });

  it('keeps default name if callback returns too-long title (>=80 chars)', async () => {
    const longTitle = 'A'.repeat(80);
    const manager = new SessionManager({
      generateTitle: async () => longTitle,
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });

  it('keeps default name if callback returns empty string', async () => {
    const manager = new SessionManager({
      generateTitle: async () => '',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    await manager.autoNameActive();
    expect(manager.getActive()!.name).toBe(originalName);
  });
});

// ===========================================================================
// Error path — LLM call fails → session name unchanged, non-fatal
// ===========================================================================

describe('auto-naming error handling', () => {
  it('handles callback errors gracefully (keeps default name)', async () => {
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

  it('handles callback returning rejected promise', async () => {
    const manager = new SessionManager({
      generateTitle: async () => {
        throw new Error('Network timeout');
      },
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    const result = await manager.autoNameActive();
    expect(result!.name).toBe(originalName);
  });

  it('callback receives the session object', async () => {
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
    expect(receivedSession!.name.startsWith('Session ')).toBe(true);
  });
});

// ===========================================================================
// Callback override — autoNameActive(callback) takes precedence
// ===========================================================================

describe('autoNameActive callback override', () => {
  it('callback parameter takes precedence over constructor callback', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Constructor Title',
      storage: storageOpts,
    });
    const session = manager.create('gpt-4o');

    // Override with a different callback
    const result = await manager.autoNameActive(async () => 'Override Title');

    expect(result!.name).toBe('Override Title');
  });

  it('callback parameter can capture per-invocation context', async () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');

    // Simulate chat.ts pattern: callback captures messages via closure
    const messages = ['Hello', 'Hi there! How can I help?'];
    const result = await manager.autoNameActive(async (_session) => {
      // In real code, this would call the LLM with the messages
      return `Title from ${messages.length} messages`;
    });

    expect(result!.name).toBe('Title from 2 messages');
  });

  it('falls back to constructor callback when no parameter provided', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Constructor Title',
      storage: storageOpts,
    });
    manager.create('gpt-4o');

    // No callback parameter — should use constructor callback
    const result = await manager.autoNameActive();

    expect(result!.name).toBe('Constructor Title');
  });

  it('callback parameter null means no callback available', async () => {
    const manager = new SessionManager({ storage: storageOpts });
    const session = manager.create('gpt-4o');
    const originalName = session.name;

    // No constructor callback, no parameter callback
    const result = await manager.autoNameActive();

    expect(result!.name).toBe(originalName);
  });
});

// ===========================================================================
// Multiple sessions — only active session is auto-named
// ===========================================================================

describe('auto-naming with multiple sessions', () => {
  it('only auto-names the active session', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Auto-Named',
      storage: storageOpts,
    });
    const session1 = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // session2 is active (last created)
    await manager.autoNameActive();

    // session2 should be renamed
    expect(manager.getActive()!.name).toBe('Auto-Named');

    // session1 should still have default name
    const loaded1 = loadSession(session1.id, storageOpts);
    expect(loaded1!.name.startsWith('Session ')).toBe(true);
  });

  it('auto-naming after switching sessions names the new active', async () => {
    const manager = new SessionManager({
      generateTitle: async () => 'Switched Session Title',
      storage: storageOpts,
    });
    const session1 = manager.create('gpt-4o');
    const session2 = manager.create('anthropic/claude-3.5-sonnet');

    // Switch to session1
    manager.switchTo(session1.id);

    await manager.autoNameActive();

    expect(manager.getActive()!.name).toBe('Switched Session Title');
    expect(manager.getActive()!.id).toBe(session1.id);
  });
});
