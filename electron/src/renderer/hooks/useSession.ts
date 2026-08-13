/**
 * useSession — manages session state, switching, creation.
 *
 * Shared module store so ChatView and ConfigView (both mounted under config)
 * share one active session / list / workspace instead of diverging.
 *
 * Provides:
 * - Active session
 * - Session list
 * - load(), create(), delete(), rename() actions
 * - Loading/error states (interaction states)
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Session } from '../../shared/types/session';
import type { ModelSelection } from '../../shared/types/provider';
import type { SessionSummary } from '../../shared/types/ipc-boundary';
import type { WorkspaceInfo, SessionOpenResult } from '../../shared/types/ipc';
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
   * Activate a session and return its full view payload (session, flattened
   * messages, live snapshot, workspace) in one round-trip. Used by switching.
   */
  open: (id: string) => Promise<SessionOpenResult | null>;
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
  /** Change the connection-scoped selection for a session (active only in main). */
  changeModel: (id: string, selection: ModelSelection | null, modelLabel?: string | null) => Promise<void>;
  /** Resolve current workspace from main. */
  getWorkspace: () => Promise<WorkspaceInfo | null>;
  /** Native folder picker — binds draft/session + sticky default. */
  pickProjectDir: () => Promise<WorkspaceInfo | null>;
  /** Bind absolute path without dialog (tests). */
  setWorkspace: (cwd: string) => Promise<WorkspaceInfo | null>;
  /** Change cwd on a session and update sticky default. */
  changeCwd: (id: string, cwd: string) => Promise<Session | null>;
  /** Monotonic draft-navigation identity for lazy chat creation events. */
  draftGeneration: number;
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

// ── Shared store (one session state for all useSession() callers) ────────────

type Listener = () => void;

interface SharedSnapshot {
  readonly activeSession: Session | null;
  readonly listState: SessionListState;
  readonly workspace: WorkspaceInfo | null;
  readonly isLoading: boolean;
  readonly draftGeneration: number;
}

let activeSession: Session | null = null;
let listState: SessionListState = { status: 'loading' };
let workspace: WorkspaceInfo | null = null;
let isLoading = false;
let draftGeneration = 0;
/** Monotonic generation so out-of-order session:load responses are dropped. */
let loadGeneration = 0;
let bootstrapped = false;
const listeners = new Set<Listener>();
const unsubscribers: Array<() => void> = [];

let cachedSnapshot: SharedSnapshot = {
  activeSession,
  listState,
  workspace,
  isLoading,
  draftGeneration,
};

function rebuildSnapshot(): void {
  cachedSnapshot = {
    activeSession,
    listState,
    workspace,
    isLoading,
    draftGeneration,
  };
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SharedSnapshot {
  return cachedSnapshot;
}

function setActiveSession(next: Session | null | ((prev: Session | null) => Session | null)): void {
  const resolved = typeof next === 'function' ? next(activeSession) : next;
  if (resolved === activeSession) return;
  activeSession = resolved;
  rebuildSnapshot();
}

function setListState(next: SessionListState | ((prev: SessionListState) => SessionListState)): void {
  const resolved = typeof next === 'function' ? next(listState) : next;
  if (resolved === listState) return;
  listState = resolved;
  rebuildSnapshot();
}

function setWorkspaceState(next: WorkspaceInfo | null): void {
  if (next === workspace) return;
  workspace = next;
  rebuildSnapshot();
}

function setIsLoading(next: boolean): void {
  if (next === isLoading) return;
  isLoading = next;
  rebuildSnapshot();
}

function advanceDraftGeneration(): number {
  draftGeneration += 1;
  rebuildSnapshot();
  return draftGeneration;
}

async function refreshShared(): Promise<void> {
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
}

async function getWorkspaceShared(): Promise<WorkspaceInfo | null> {
  if (!window.orchid?.session?.getWorkspace) {
    return UNBOUND_WORKSPACE;
  }
  try {
    const info = await window.orchid.session.getWorkspace();
    setWorkspaceState(info);
    return info;
  } catch (err) {
    console.error('Failed to get workspace:', err);
    return null;
  }
}

function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  void refreshShared();
  void getWorkspaceShared();

  if (window.orchid?.session?.onRenamed) {
    unsubscribers.push(
      window.orchid.session.onRenamed((event) => {
        setActiveSession((prev) => {
          if (prev && prev.id === event.id) {
            return { ...prev, name: event.name };
          }
          return prev;
        });
        void refreshShared();
      }),
    );
  }

  // Lazy create: first chat:send with no active session creates one in main
  // and pushes SESSION_CREATED so the sidebar gains a list entry. Only adopt
  // when this window is still in draft (no active session) so a concurrent
  // promotion cannot steal selection after the user navigated elsewhere.
  if (window.orchid?.session?.onCreated) {
    unsubscribers.push(
      window.orchid.session.onCreated((event) => {
        setActiveSession((prev) => {
          if (prev != null) return prev;
          if (
            event.draftGeneration != null &&
            event.draftGeneration !== draftGeneration
          ) {
            return prev;
          }
          return event.session;
        });
        void refreshShared();
        void getWorkspaceShared();
      }),
    );
  }

  // Multi-chain turn lifecycle: start/finish updates chains on the active session.
  if (window.orchid?.session?.onUpdated) {
    unsubscribers.push(
      window.orchid.session.onUpdated((event) => {
        setActiveSession((prev) => {
          // Only update when the same session is still active. Never resurrect
          // a session after New Chat/draft (prev === null) from a late event.
          if (prev?.id !== event.sessionId) return prev;
          const chainIndex = prev.chains.findIndex((chain) => chain.id === event.chain.id);
          const chains = chainIndex < 0
            ? [...prev.chains, event.chain]
            : prev.chains.map((chain, index) => index === chainIndex ? event.chain : chain);
          return {
            ...prev,
            chains,
            activeChainId: event.activeChainId,
            updatedAt: event.updatedAt,
          };
        });
      }),
    );
  }

  // Workspace changes (pick / change_cwd / load / clear)
  if (window.orchid?.session?.onWorkspaceChanged) {
    unsubscribers.push(
      window.orchid.session.onWorkspaceChanged((event) => {
        setWorkspaceState(event.workspace);
      }),
    );
  }
}

async function loadShared(id: string): Promise<Session | null> {
  if (!window.orchid?.session?.load) {
    return null;
  }

  const generation = ++loadGeneration;
  advanceDraftGeneration();
  setIsLoading(true);
  try {
    const session = await window.orchid.session.load({ id });
    // Drop stale responses when a newer load (or draft) superseded this one.
    if (generation !== loadGeneration) {
      return session;
    }
    setActiveSession(session);
    // Load does not rewrite sticky default; refresh workspace from session.
    void getWorkspaceShared();
    return session;
  } catch (err) {
    console.error('Failed to load session:', err);
    return null;
  } finally {
    if (generation === loadGeneration) {
      setIsLoading(false);
    }
  }
}

async function openShared(id: string): Promise<SessionOpenResult | null> {
  if (!window.orchid?.session?.open) {
    return null;
  }

  const generation = ++loadGeneration;
  advanceDraftGeneration();
  setIsLoading(true);
  try {
    const result = await window.orchid.session.open({ id });
    // Drop stale responses when a newer load (or draft) superseded this one.
    if (generation !== loadGeneration) {
      return result;
    }
    if (result.session) {
      setActiveSession(result.session);
      // session:open resolves the workspace itself; adopt it directly instead of
      // a second get_workspace round-trip.
      setWorkspaceState(result.workspace);
    }
    return result;
  } catch (err) {
    console.error('Failed to open session:', err);
    return null;
  } finally {
    if (generation === loadGeneration) {
      setIsLoading(false);
    }
  }
}

async function createShared(): Promise<Session> {
  if (!window.orchid?.session?.create) {
    const session = makeLocalSession();
    setActiveSession(session);
    setListState({
      status: 'ready',
      sessions: [{
        id: session.id,
        name: session.name,
        modelLabel: session.modelLabel,
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
    await refreshShared();
    return session;
  } finally {
    setIsLoading(false);
  }
}

async function enterDraftShared(): Promise<void> {
  loadGeneration += 1;
  advanceDraftGeneration();
  if (window.orchid?.session?.clearActive) {
    await window.orchid.session.clearActive();
  }
  setActiveSession(null);
  void getWorkspaceShared();
}

async function pickProjectDirShared(): Promise<WorkspaceInfo | null> {
  if (!window.orchid?.session?.pickProjectDir) {
    return null;
  }
  try {
    advanceDraftGeneration();
    const info = await window.orchid.session.pickProjectDir();
    setWorkspaceState(info);
    // The main process turns a non-empty session into a draft in the new
    // project. Do not make the old conversation appear to have moved.
    const current = activeSession;
    if (current?.chains.length) {
      setActiveSession(null);
    } else if (current && info.cwd) {
      setActiveSession((prev) => (prev ? { ...prev, cwd: info.cwd } : null));
    }
    return info;
  } catch (err) {
    console.error('Failed to pick project directory:', err);
    return null;
  }
}

async function setWorkspacePathShared(cwd: string): Promise<WorkspaceInfo | null> {
  if (!window.orchid?.session?.setWorkspace) {
    return null;
  }
  try {
    advanceDraftGeneration();
    const info = await window.orchid.session.setWorkspace({ cwd });
    setWorkspaceState(info);
    // Binding a new project from a non-empty conversation starts a draft in
    // main. Keep the old conversation out of the center pane rather than
    // making it look as though it moved projects.
    const current = activeSession;
    if (current?.chains.length) {
      setActiveSession(null);
    } else if (current && info.cwd) {
      setActiveSession((prev) => (prev ? { ...prev, cwd: info.cwd } : null));
    }
    return info;
  } catch (err) {
    console.error('Failed to set workspace:', err);
    return null;
  }
}

async function changeCwdShared(id: string, cwd: string): Promise<Session | null> {
  if (!window.orchid?.session?.changeCwd) {
    return null;
  }
  try {
    const session = await window.orchid.session.changeCwd({ id, cwd });
    if (activeSession?.id === id) {
      setActiveSession(session);
    }
    void getWorkspaceShared();
    await refreshShared();
    return session;
  } catch (err) {
    console.error('Failed to change session cwd:', err);
    return null;
  }
}

async function deleteSessionShared(id: string): Promise<void> {
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
  await refreshShared();
}

async function renameShared(id: string, name: string): Promise<void> {
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
  await refreshShared();
}

async function changeModelShared(
  id: string,
  selection: ModelSelection | null,
  modelLabel?: string | null,
): Promise<void> {
  const resolvedModelLabel = modelLabel ?? selection?.modelId ?? null;
  if (!window.orchid?.session?.changeModel) {
    if (activeSession?.id === id) {
      setActiveSession((prev) => (prev ? {
        ...prev,
        selection,
        modelLabel: resolvedModelLabel,
      } : null));
    }
    setListState((prev) => {
      if (prev.status !== 'ready' && prev.status !== 'partial') return prev;
      return {
        ...prev,
        sessions: prev.sessions.map((s) =>
          s.id === id ? {
            ...s,
            modelLabel: resolvedModelLabel,
          } : s,
        ),
      };
    });
    return;
  }

  await window.orchid.session.changeModel(
    id,
    selection,
    resolvedModelLabel,
  );
  if (activeSession?.id === id) {
    setActiveSession((prev) => (prev ? {
      ...prev,
      selection,
      modelLabel: resolvedModelLabel,
    } : null));
  }
  await refreshShared();
}

/** Test-only access to the shared cache (not for product code). */
export const __sessionCacheTest = {
  reset(): void {
    for (const unsub of unsubscribers.splice(0)) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    activeSession = null;
    listState = { status: 'loading' };
    workspace = null;
    isLoading = false;
    draftGeneration = 0;
    loadGeneration = 0;
    bootstrapped = false;
    listeners.clear();
    cachedSnapshot = {
      activeSession,
      listState,
      workspace,
      isLoading,
      draftGeneration,
    };
  },
  getSnapshot,
  getActiveSession: () => activeSession,
  getListState: () => listState,
  getWorkspace: () => workspace,
  getDraftGeneration: () => draftGeneration,
  getLoadGeneration: () => loadGeneration,
    refresh: refreshShared,
    load: loadShared,
    open: openShared,
    enterDraft: enterDraftShared,
  create: createShared,
  deleteSession: deleteSessionShared,
  rename: renameShared,
  changeModel: changeModelShared,
  pickProjectDir: pickProjectDirShared,
  setWorkspace: setWorkspacePathShared,
  changeCwd: changeCwdShared,
  getWorkspaceFromMain: getWorkspaceShared,
  ensureBootstrapped,
  subscribe,
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSession(): UseSessionReturn {
  ensureBootstrapped();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const load = useCallback((id: string) => loadShared(id), []);
  const open = useCallback((id: string) => openShared(id), []);
  const create = useCallback(() => createShared(), []);
  const enterDraft = useCallback(() => enterDraftShared(), []);
  const deleteSession = useCallback((id: string) => deleteSessionShared(id), []);
  const rename = useCallback((id: string, name: string) => renameShared(id, name), []);
  const changeModel = useCallback(
    (id: string, selection: ModelSelection | null, modelLabel?: string | null) =>
      changeModelShared(id, selection, modelLabel),
    [],
  );
  const getWorkspace = useCallback(() => getWorkspaceShared(), []);
  const pickProjectDir = useCallback(() => pickProjectDirShared(), []);
  const setWorkspace = useCallback((cwd: string) => setWorkspacePathShared(cwd), []);
  const changeCwd = useCallback((id: string, cwd: string) => changeCwdShared(id, cwd), []);
  const refresh = useCallback(() => refreshShared(), []);

  // Stable identity between store snapshot changes so consumers (and the
  // callbacks that depend on this object) do not re-render on every unrelated
  // ChatView update — e.g. per-token streaming. The snapshot ref only changes
  // when session/list/workspace state actually changes.
  return useMemo(
    () => ({
      activeSession: snapshot.activeSession,
      listState: snapshot.listState,
      workspace: snapshot.workspace,
      load,
      open,
      create,
      enterDraft,
      deleteSession,
      rename,
      changeModel,
      getWorkspace,
      pickProjectDir,
      setWorkspace,
      changeCwd,
      draftGeneration: snapshot.draftGeneration,
      refresh,
      isLoading: snapshot.isLoading,
    }),
    [
      snapshot,
      load,
      open,
      create,
      enterDraft,
      deleteSession,
      rename,
      changeModel,
      getWorkspace,
      pickProjectDir,
      setWorkspace,
      changeCwd,
      refresh,
    ],
  );
}

function makeLocalSession(): Session {
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const chainId = crypto.randomUUID();
  return {
    id: sessionId,
    name: 'Local Session',
    selection: null,
    modelLabel: null,
    cwd: null,
    chains: [{
      id: chainId,
      sessionId,
      messages: [],
      status: ChainStatus.ACTIVE,
      selection: null,
      modelLabel: null,
      agentName: 'general',
      agentType: 'internal',
      agentTier: 'bloom',
      subagentRecord: null,
      startTime: now,
      endTime: null,
      errorDetail: null,
      errorTitle: null,
    }],
    activeChainId: chainId,
    createdAt: now,
    updatedAt: now,
    subagentChains: [],
    todoStore: { tasks: [] },
    reasoningEffortOverride: null,
    tierOverride: null,
    permissionMode: null,
  };
}
