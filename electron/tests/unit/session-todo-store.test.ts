/**
 * Session-scoped TodoStore lifecycle (P0-2).
 *
 * Verifies create/switch/clear rebinds the live store and tool mutations
 * persist via SessionManager.persistActiveTodos().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../../src/main/session/manager';
import { buildCreateTool } from '../../src/main/tools/todo/create';
import { TodoStatus } from '../../src/shared/types/todo';

describe('SessionManager TodoStore isolation', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-todo-session-'));
    manager = new SessionManager({
      storage: { sessionsDir: tmpDir },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isolates todos across sessions and reloads from disk', async () => {
    const a = manager.create('default/mimo-v2.5');
    const { handler: createA } = buildCreateTool(
      () => manager.getActiveTodoStore(),
      () => manager.persistActiveTodos(),
    );
    await createA({ title: 'Task in A' }, { cwd: tmpDir });
    expect(manager.getActiveTodoStore().list()).toHaveLength(1);
    expect(manager.getActive()!.todoStore.tasks).toHaveLength(1);

    const b = manager.create('default/mimo-v2.5');
    expect(b.id).not.toBe(a.id);
    expect(manager.getActiveTodoStore().list()).toHaveLength(0);

    const { handler: createB } = buildCreateTool(
      () => manager.getActiveTodoStore(),
      () => manager.persistActiveTodos(),
    );
    await createB({ title: 'Task in B' }, { cwd: tmpDir });
    expect(manager.getActiveTodoStore().list()[0]!.title).toBe('Task in B');

    // Switch back to A — only A's todo
    const restored = manager.switchTo(a.id);
    expect(restored).not.toBeNull();
    const todosA = manager.getActiveTodoStore().list();
    expect(todosA).toHaveLength(1);
    expect(todosA[0]!.title).toBe('Task in A');
    expect(todosA[0]!.status).toBe(TodoStatus.OPEN);

    // Switch to B
    manager.switchTo(b.id);
    expect(manager.getActiveTodoStore().list()[0]!.title).toBe('Task in B');
  });

  it('clearActive resets the live todo store', async () => {
    manager.create('default/mimo-v2.5');
    manager.getActiveTodoStore().create('Ephemeral');
    expect(manager.getActiveTodoStore().list()).toHaveLength(1);
    manager.clearActive();
    expect(manager.getActiveTodoStore().list()).toHaveLength(0);
  });
});
