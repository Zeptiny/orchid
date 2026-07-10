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
import { ChainStatus } from '../../shared/types/chain';

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; sessions: SessionSummary[] }
  | { status: 'partial'; sessions: SessionSummary[]; error: string }
  | { status: 'error'; error: string };

export interface UseSessionReturn {
  /** The active (loaded) session, or null (draft / new chat). */
  activeSession: Session | null;
  /** Session list state with interaction states. */
  listState: SessionListState;
  /** Load a session by ID. Returns the loaded session (or null on failure). */
  load: (id: string) => Promise<Session | null>;
  /**
   * Eagerly create a session file (legacy / tests). Prefer `enterDraft` for
   * the New Chat button — session is created on first message instead.
   */
  create: () => Promise<Session>;
  /**
   * Enter draft mode: no active session, no new disk file. First chat:send
   * will lazy-create a session in main.
   */
  enterDraft: () => Promise<void>;
  /** Delete a session by ID. */
  deleteSession: (id: string) => Promise<void>;
  /** Rename a session. */
  rename: (id: string, name: string) => Promise<void>;
  /** Change the model for a session (active only in main). */
  changeModel: (id: string, model: string) => Promise<void>;
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
    if (!window.orchid?.session?.list) {
      setListState({ status: 'empty' });
      return;
    }

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
    if (!window.orchid?.session?.onRenamed) {
      return undefined;
    }

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

  // Lazy create: first chat:send with no active session creates one in main
  // and pushes SESSION_CREATED so the sidebar gains a list entry.
  useEffect(() => {
    if (!window.orchid?.session?.onCreated) {
      return undefined;
    }

    const unsubscribe = window.orchid.session.onCreated((event) => {
      setActiveSession(event.session);
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  const load = useCallback(async (id: string): Promise<Session | null> => {
    if (!window.orchid?.session?.load) {
      return null;
    }

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
    if (!window.orchid?.session?.create) {
      const session = makeLocalSession();
      setActiveSession(session);
      setListState({
        status: 'ready',
        sessions: [{
          id: session.id,
          name: session.name,
          model: session.model,
          cwd: session.cwd,
          chainCount: session.chains.length,
          updatedAt: Date.now(),
        }],
      });
      return session;
    }

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

  const enterDraft = useCallback(async () => {
    if (window.orchid?.session?.clearActive) {
      await window.orchid.session.clearActive();
    }
    setActiveSession(null);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      if (!window.orchid?.session?.delete) {
        if (activeSession?.id === id) {
          setActiveSession(null);
        }
        setListState({ status: 'empty' });
        return;
      }

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
      if (!window.orchid?.session?.rename) {
        if (activeSession?.id === id) {
          setActiveSession((prev) => (prev ? { ...prev, name } : null));
        }
        setListState((prev) => {
          if (prev.status !== 'ready' && prev.status !== 'partial') return prev;
          return {
            ...prev,
            sessions: prev.sessions.map((session) => (
              session.id === id ? { ...session, name } : session
            )),
          };
        });
        return;
      }

      await window.orchid.session.rename(id, name);
      if (activeSession?.id === id) {
        setActiveSession((prev) => (prev ? { ...prev, name } : null));
      }
      await refresh();
    },
    [activeSession, refresh],
  );

  const changeModel = useCallback(
    async (id: string, model: string) => {
      if (!window.orchid?.session?.changeModel) {
        if (activeSession?.id === id) {
          setActiveSession((prev) => (prev ? { ...prev, model } : null));
        }
        setListState((prev) => {
          if (prev.status !== 'ready' && prev.status !== 'partial') return prev;
          return {
            ...prev,
            sessions: prev.sessions.map((s) =>
              s.id === id ? { ...s, model } : s,
            ),
          };
        });
        return;
      }

      await window.orchid.session.changeModel(id, model);
      if (activeSession?.id === id) {
        setActiveSession((prev) => (prev ? { ...prev, model } : null));
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
    enterDraft,
    deleteSession,
    rename,
    changeModel,
    refresh,
    isLoading,
  };
}

function makeLocalSession(): Session {
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const chainId = crypto.randomUUID();
  return {
    id: sessionId,
    name: 'Local Session',
    model: '',
    cwd: null,
    chains: [{
      id: chainId,
      sessionId,
      messages: [],
      status: ChainStatus.ACTIVE,
      model: '',
      agentName: 'general',
      agentType: 'internal',
      agentTier: 'bloom',
      subagentRecord: null,
    }],
    activeChainId: chainId,
    createdAt: now,
    updatedAt: now,
    subagentChains: [],
    todoStore: { tasks: [] },
  };
}
