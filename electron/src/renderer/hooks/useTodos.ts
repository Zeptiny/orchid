/**
 * useTodos — subscribes to todo state updates.
 *
 * Provides:
 * - Todo list from active session
 * - Loading/error states (interaction states)
 * - applyFromSession to avoid a second load peek on session switch
 */
import { useState, useEffect, useCallback, useRef } from 'react';
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
  /**
   * Apply todos already loaded with the session (avoids a second session.load
   * peek and spinner flash on session switch).
   */
  applyFromSession: (todos: readonly Todo[]) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function listStateFrom(todos: readonly Todo[]): TodoListState {
  return todos.length === 0
    ? { status: 'empty' }
    : { status: 'ready', todos };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useTodos(activeSessionId: string | null): UseTodosReturn {
  const [state, setState] = useState<TodoListState>({ status: 'loading' });
  const sessionIdRef = useRef(activeSessionId);
  sessionIdRef.current = activeSessionId;

  const applyFromSession = useCallback((todos: readonly Todo[]) => {
    setState(listStateFrom(todos));
  }, []);

  const refresh = useCallback(async () => {
    if (!activeSessionId || !window.orchid?.session?.load) {
      setState({ status: 'empty' });
      return;
    }

    const requestId = activeSessionId;
    try {
      // Peek only — do not switch active session or reseed chat history.
      const session = await window.orchid.session.load({
        id: activeSessionId,
        activate: false,
      });
      if (sessionIdRef.current !== requestId) return;
      if (!session) {
        setState({ status: 'empty' });
        return;
      }

      setState(listStateFrom(session.todoStore.tasks));
    } catch (err) {
      if (sessionIdRef.current !== requestId) return;
      const error = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', error });
    }
  }, [activeSessionId]);

  // Stale-while-revalidate: do not blank ready data before the peek resolves.
  useEffect(() => {
    if (!activeSessionId) {
      setState({ status: 'empty' });
      return;
    }
    void refresh();
  }, [activeSessionId, refresh]);

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

  return { state, refresh, applyFromSession };
}
