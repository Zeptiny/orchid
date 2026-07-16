/**
 * Session lifecycle agent tools (M-P0-024).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '../../src/main/session/manager';

const connectionId = randomUUID();
const selection = { connectionId, modelId: 'test-model' };

let manager: SessionManager;

vi.mock('../../src/main/ipc/session', () => ({
  getSessionManager: () => manager,
}));

vi.mock('../../src/main/ipc/chat', () => ({
  forceStopSession: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import {
  sessionListHandler,
  sessionCreateHandler,
  sessionLoadHandler,
  sessionRenameHandler,
  sessionDeleteHandler,
  sessionChangeModelHandler,
} from '../../src/main/tools/session';

describe('session tools', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-tools-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-session-proj-'));
    manager = new SessionManager({
      storage: { sessionsDir: tmpDir },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('session_list returns empty when no sessions', async () => {
    const result = await sessionListHandler({}, { cwd: projectDir });
    expect(result).toBe('No saved sessions.');
  });

  it('session_create + list + rename + change_model + delete', async () => {
    const created = await sessionCreateHandler(
      { selection },
      { cwd: projectDir },
    );
    expect(created).toContain('Session created:');
    expect(created).toContain(projectDir);

    const listed = await sessionListHandler({}, { cwd: projectDir });
    expect(listed).toContain('Found 1 session');
    expect(listed).toContain('test-model');

    const session = manager.getActive()!;
    const renamed = await sessionRenameHandler(
      { id: session.id, name: 'My Session' },
      { cwd: projectDir },
    );
    expect(renamed).toContain("renamed to 'My Session'");
    expect(manager.getActive()!.name).toBe('My Session');

    const newSel = { connectionId, modelId: 'other-model' };
    const changed = await sessionChangeModelHandler(
      { id: session.id, selection: newSel },
      { cwd: projectDir },
    );
    expect(changed).toContain('Session model updated');
    expect(manager.getActive()!.selection?.modelId).toBe('other-model');

    const other = manager.create(selection, { cwd: projectDir });
    const deleted = await sessionDeleteHandler(
      { id: other.id },
      { cwd: projectDir, sessionId: session.id },
    );
    expect(deleted).toContain('deleted');
    expect(manager.load(other.id)).toBeNull();
  });

  it('session_delete refuses deleting the active turn session', async () => {
    const session = manager.create(selection, { cwd: projectDir });
    const result = await sessionDeleteHandler(
      { id: session.id },
      { cwd: projectDir, sessionId: session.id },
    );
    expect(result).toContain('Cannot delete the session currently running');
    expect(manager.load(session.id)).not.toBeNull();
  });

  it('session_load peeks without activate', async () => {
    const session = manager.create(selection, { cwd: projectDir });
    manager.clearActive();
    const result = await sessionLoadHandler(
      { id: session.id, activate: false },
      { cwd: projectDir },
    );
    expect(result).toContain('Session (peek)');
    expect(manager.getActive()).toBeNull();
  });

  it('session_load activates session', async () => {
    const session = manager.create(selection, { cwd: projectDir });
    manager.clearActive();
    const result = await sessionLoadHandler(
      { id: session.id, activate: true },
      { cwd: projectDir },
    );
    expect(result).toContain('loaded and activated');
    expect(manager.getActive()?.id).toBe(session.id);
  });
});
