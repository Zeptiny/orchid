// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTodos } from '../../src/renderer/hooks/useTodos';
import { TodoStatus, type Todo } from '../../src/shared/types/todo';

const sessionId = '11111111-1111-4111-8111-111111111111';

function makeTodo(id: string, title: string): Todo {
  return {
    id,
    title,
    status: TodoStatus.OPEN,
    subagent_id: null,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  };
}

type TodosChangedCallback = (event: { sessionId: string | null }) => void;

function installSessionApi() {
  const callbacks = new Set<TodosChangedCallback>();
  const load = vi.fn();
  window.orchid = {
    session: {
      load,
      onTodosChanged: (callback: TodosChangedCallback) => {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    },
  } as never;
  return { callbacks, load };
}

describe('useTodos', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('uses the session-open todo snapshot without loading the session again', async () => {
    const sessionApi = installSessionApi();
    const seeded = [makeTodo('todo-1', 'Already loaded')];

    const { result, rerender } = renderHook(
      ({ activeSessionId, todos }) => useTodos(activeSessionId, todos),
      {
        initialProps: {
          activeSessionId: null as string | null,
          todos: null as readonly Todo[] | null,
        },
      },
    );

    rerender({ activeSessionId: sessionId, todos: seeded });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sessionApi.load).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'ready', todos: seeded });
  });

  it('refreshes the seeded snapshot after a matching todo mutation event', async () => {
    const sessionApi = installSessionApi();
    const seeded = [makeTodo('todo-1', 'Initial')];
    const refreshed = [makeTodo('todo-2', 'Updated')];
    sessionApi.load.mockResolvedValue({ todoStore: { tasks: refreshed } });

    const { result } = renderHook(() => useTodos(sessionId, seeded));

    await act(async () => {
      for (const callback of sessionApi.callbacks) callback({ sessionId });
      await Promise.resolve();
    });

    expect(sessionApi.load).toHaveBeenCalledOnce();
    expect(sessionApi.load).toHaveBeenCalledWith({ id: sessionId, activate: false });
    expect(result.current.state).toEqual({ status: 'ready', todos: refreshed });
  });
});
