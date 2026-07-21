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
import { _clearDbCache } from '../../src/main/session/storage';
import { buildCreateTool } from '../../src/main/tools/todo/create';
import { TodoStatus } from '../../src/shared/types/todo';

describe('SessionManager TodoStore isolation', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchid-todo-session-'));
    manager = new SessionManager({
      storage: { dbPath: path.join(tmpDir, 'sessions.db') },
    });
  });

  afterEach(() => {
    _clearDbCache();
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

  it('resolves and persists todos by frozen tool session rather than current selection', async () => {
    const a = manager.create('default/mimo-v2.5');
    const b = manager.create('default/mimo-v2.5');
    const resolvedSessions: string[] = [];
    const persistedSessions: string[] = [];
    const { handler: create } = buildCreateTool(
      (ctx) => {
        resolvedSessions.push(ctx.sessionId ?? 'missing');
        return manager.getTodoStore(ctx.sessionId!);
      },
      (ctx) => {
        persistedSessions.push(ctx.sessionId ?? 'missing');
        manager.persistTodos(ctx.sessionId!);
      },
    );

    // B is selected, but an in-flight A turn must still write into A.
    await create(
      { title: 'Task in A' },
      { cwd: tmpDir, sessionId: a.id, agentScopeId: 'main' },
    );
    await create(
      { title: 'Task in B' },
      { cwd: tmpDir, sessionId: b.id, agentScopeId: 'main' },
    );

    expect(resolvedSessions).toEqual([a.id, b.id]);
    expect(persistedSessions).toEqual([a.id, b.id]);
    expect(manager.getTodoStore(a.id).list().map((todo) => todo.title)).toEqual(['Task in A']);
    expect(manager.getTodoStore(b.id).list().map((todo) => todo.title)).toEqual(['Task in B']);
  });
});
