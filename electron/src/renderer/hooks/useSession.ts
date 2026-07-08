/**
 * useSession — manages session state, switching, creation.
 *
 * Provides:
 * - Active session
 * - Session list
 * - load(), create(), delete(), rename() actions
 * - Loading/error states (interaction states)
 */
import { useState, useEffect, useCallback } from 'react';
import type { Session } from '../../shared/types/session';
import type { SessionSummary } from '../../shared/types/ipc-boundary';

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; sessions: SessionSummary[] }
  | { status: 'partial'; sessions: SessionSummary[]; error: string }
  | { status: 'error'; error: string };

export interface UseSessionReturn {
  /** The active (loaded) session, or null. */
  activeSession: Session | null;
  /** Session list state with interaction states. */
  listState: SessionListState;
  /** Load a session by ID. Returns the loaded session (or null on failure). */
  load: (id: string) => Promise<Session | null>;
  /** Create a new session. */
  create: () => Promise<Session>;
  /** Delete a session by ID. */
  deleteSession: (id: string) => Promise<void>;
  /** Rename a session. */
  rename: (id: string, name: string) => Promise<void>;
  /** Refresh the session list. */
  refresh: () => Promise<void>;
  /** Whether a session is currently loading. */
  isLoading: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSession(): UseSessionReturn {
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [listState, setListState] = useState<SessionListState>({ status: 'loading' });
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const sessions = await window.orchid.session.list();
      if (sessions.length === 0) {
        setListState({ status: 'empty' });
      } else {
        setListState({ status: 'ready', sessions });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setListState((prev) => {
        if (prev.status === 'ready' || prev.status === 'partial') {
          return { status: 'partial', sessions: prev.sessions, error };
        }
        return { status: 'error', error };
      });
    }
  }, []);

  // Load session list on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Listen for push rename events from main process (e.g. auto-naming)
  useEffect(() => {
    const unsubscribe = window.orchid.session.onRenamed((event) => {
      setActiveSession((prev) => {
        if (prev && prev.id === event.id) {
          return { ...prev, name: event.name };
        }
        return prev;
      });
      // Refresh session list so sidebar shows updated name
      refresh();
    });
    return unsubscribe;
  }, [refresh]);

  const load = useCallback(async (id: string): Promise<Session | null> => {
    setIsLoading(true);
    try {
      const session = await window.orchid.session.load({ id });
      setActiveSession(session);
      return session;
    } catch (err) {
      console.error('Failed to load session:', err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const create = useCallback(async () => {
    setIsLoading(true);
    try {
      const session = await window.orchid.session.create();
      setActiveSession(session);
      await refresh();
      return session;
    } finally {
      setIsLoading(false);
    }
  }, [refresh]);

  const deleteSession = useCallback(
    async (id: string) => {
      await window.orchid.session.delete({ id });
      if (activeSession?.id === id) {
        setActiveSession(null);
      }
      await refresh();
    },
    [activeSession, refresh],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      await window.orchid.session.rename(id, name);
      if (activeSession?.id === id) {
        setActiveSession((prev) => (prev ? { ...prev, name } : null));
      }
      await refresh();
    },
    [activeSession, refresh],
  );

  return {
    activeSession,
    listState,
    load,
    create,
    deleteSession,
    rename,
    refresh,
    isLoading,
  };
}
