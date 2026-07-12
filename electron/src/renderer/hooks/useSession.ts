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
import type { WorkspaceInfo } from '../../shared/types/ipc';
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
  /** Current workspace (draft → session → sticky → unbound). */
  workspace: WorkspaceInfo | null;
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
  /** Resolve current workspace from main. */
  getWorkspace: () => Promise<WorkspaceInfo | null>;
  /** Native folder picker — binds draft/session + sticky default. */
  pickProjectDir: () => Promise<WorkspaceInfo | null>;
  /** Bind absolute path without dialog (tests). */
  setWorkspace: (cwd: string) => Promise<WorkspaceInfo | null>;
  /** Change cwd on a session and update sticky default. */
  changeCwd: (id: string, cwd: string) => Promise<Session | null>;
  /** Refresh the session list. */
  refresh: () => Promise<void>;
  /** Whether a session is currently loading. */
  isLoading: boolean;
}

const UNBOUND_WORKSPACE: WorkspaceInfo = {
  cwd: null,
  source: 'unbound',
  status: 'unbound',
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSession(): UseSessionReturn {
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [listState, setListState] = useState<SessionListState>({ status: 'loading' });
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
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

  const getWorkspace = useCallback(async (): Promise<WorkspaceInfo | null> => {
    if (!window.orchid?.session?.getWorkspace) {
      return UNBOUND_WORKSPACE;
    }
    try {
      const info = await window.orchid.session.getWorkspace();
      setWorkspace(info);
      return info;
    } catch (err) {
      console.error('Failed to get workspace:', err);
      return null;
    }
  }, []);

  // Load session list + workspace on mount
  useEffect(() => {
    refresh();
    void getWorkspace();
  }, [refresh, getWorkspace]);

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
      void getWorkspace();
    });
    return unsubscribe;
  }, [refresh, getWorkspace]);

  // Multi-chain turn lifecycle: start/finish updates chains on the active session.
  useEffect(() => {
    if (!window.orchid?.session?.onUpdated) {
      return undefined;
    }

    const unsubscribe = window.orchid.session.onUpdated((event) => {
      setActiveSession((prev) => {
        // Only update when the same session is still active. Never resurrect
        // a session after New Chat/draft (prev === null) from a late event.
        if (prev?.id === event.session.id) {
          return event.session;
        }
        return prev;
      });
    });
    return unsubscribe;
  }, []);

  // Workspace changes (pick / change_cwd / load / clear)
  useEffect(() => {
    if (!window.orchid?.session?.onWorkspaceChanged) {
      return undefined;
    }

    const unsubscribe = window.orchid.session.onWorkspaceChanged((event) => {
      setWorkspace(event.workspace);
    });
    return unsubscribe;
  }, []);

  const load = useCallback(async (id: string): Promise<Session | null> => {
    if (!window.orchid?.session?.load) {
      return null;
    }

    setIsLoading(true);
    try {
      const session = await window.orchid.session.load({ id });
      setActiveSession(session);
      // Load does not rewrite sticky default; refresh workspace from session.
      void getWorkspace();
      return session;
    } catch (err) {
      console.error('Failed to load session:', err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [getWorkspace]);

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
    void getWorkspace();
  }, [getWorkspace]);

  const pickProjectDir = useCallback(async (): Promise<WorkspaceInfo | null> => {
    if (!window.orchid?.session?.pickProjectDir) {
      return null;
    }
    try {
      const info = await window.orchid.session.pickProjectDir();
      setWorkspace(info);
      // The main process turns a non-empty session into a draft in the new
      // project. Do not make the old conversation appear to have moved.
      if (activeSession?.chains.length) {
        setActiveSession(null);
      } else if (activeSession && info.cwd) {
        setActiveSession((prev) => (prev ? { ...prev, cwd: info.cwd } : null));
      }
      return info;
    } catch (err) {
      console.error('Failed to pick project directory:', err);
      return null;
    }
  }, [activeSession]);

  const setWorkspacePath = useCallback(async (cwd: string): Promise<WorkspaceInfo | null> => {
    if (!window.orchid?.session?.setWorkspace) {
      return null;
    }
    try {
      const info = await window.orchid.session.setWorkspace({ cwd });
      setWorkspace(info);
      if (activeSession && info.cwd) {
        setActiveSession((prev) => (prev ? { ...prev, cwd: info.cwd } : null));
      }
      return info;
    } catch (err) {
      console.error('Failed to set workspace:', err);
      return null;
    }
  }, [activeSession]);

  const changeCwd = useCallback(
    async (id: string, cwd: string): Promise<Session | null> => {
      if (!window.orchid?.session?.changeCwd) {
        return null;
      }
      try {
        const session = await window.orchid.session.changeCwd({ id, cwd });
        if (activeSession?.id === id) {
          setActiveSession(session);
        }
        void getWorkspace();
        await refresh();
        return session;
      } catch (err) {
        console.error('Failed to change session cwd:', err);
        return null;
      }
    },
    [activeSession, getWorkspace, refresh],
  );

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
    workspace,
    load,
    create,
    enterDraft,
    deleteSession,
    rename,
    changeModel,
    getWorkspace,
    pickProjectDir,
    setWorkspace: setWorkspacePath,
    changeCwd,
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
      startTime: now,
      endTime: null,
    }],
    activeChainId: chainId,
    createdAt: now,
    updatedAt: now,
    subagentChains: [],
    todoStore: { tasks: [] },
  };
}
