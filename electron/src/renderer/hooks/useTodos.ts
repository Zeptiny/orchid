/**
 * useTodos — subscribes to todo state updates.
 *
 * Provides:
 * - Todo list from active session
 * - Loading/error states (interaction states)
 */
import { useState, useEffect, useCallback } from 'react';
import type { Todo } from '../../shared/types/todo';

// ── Types ────────────────────────────────────────────────────────────────────

export type TodoListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; todos: readonly Todo[] }
  | { status: 'error'; error: string };

export interface UseTodosReturn {
  /** Todo list state with interaction states. */
  state: TodoListState;
  /** Refresh todo list from active session. */
  refresh: () => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useTodos(activeSessionId: string | null): UseTodosReturn {
  const [state, setState] = useState<TodoListState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    if (!activeSessionId || !window.orchid?.session?.load) {
      setState({ status: 'empty' });
      return;
    }

    try {
      // Peek only — do not switch active session or reseed chat history.
      const session = await window.orchid.session.load({
        id: activeSessionId,
        activate: false,
      });
      if (!session) {
        setState({ status: 'empty' });
        return;
      }

      const todos = session.todoStore.tasks;
      if (todos.length === 0) {
        setState({ status: 'empty' });
      } else {
        setState({ status: 'ready', todos });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', error });
    }
  }, [activeSessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live updates when tools mutate the session-scoped todo store.
  useEffect(() => {
    if (!window.orchid?.session?.onTodosChanged) {
      return;
    }
    return window.orchid.session.onTodosChanged((event) => {
      if (
        activeSessionId &&
        (event.sessionId === null || event.sessionId === activeSessionId)
      ) {
        void refresh();
      }
    });
  }, [activeSessionId, refresh]);

  return { state, refresh };
}
