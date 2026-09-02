/**
 * Project and draft switching for ChatView: new chat (global and per-project),
 * the folder picker, tab restoration, and the trust entry points they reach.
 */
import { useCallback, useEffect, useRef } from 'react';
import { flattenSessionMessages } from '../../../shared/types/session';
import { hasPersistedChains } from './chat-view-selectors';
import type { UseMessageQueueReturn } from '../../hooks/useMessageQueue';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { UseTodosReturn } from '../../hooks/useTodos';
import type { Session } from '../../../shared/types/session';
import type { Message } from '../../../shared/types/message';
import type { ChatSessionSnapshot, SessionOpenResult } from '../../../shared/types/ipc';
import type { Notify } from '../../utils/notify';
import type { UseChatViewSurfacesReturn } from './use-chat-view-surfaces';

/** The live-chat primitives a session switch commits through. */
export interface ChatSwitchBridge {
  readonly setMessages: (messages: Message[]) => void;
  readonly beginSessionSwitch: (sessionId: string | null) => void;
  readonly hydrateSnapshot: (snapshot: ChatSessionSnapshot | null) => void;
}

export interface UseChatViewSessionSurfacesOptions {
  readonly session: UseSessionReturn;
  readonly chat: ChatSwitchBridge;
  readonly todos: UseTodosReturn;
  readonly messageQueue: UseMessageQueueReturn;
  readonly surfaces: UseChatViewSurfacesReturn;
  readonly notify: Notify;
  /** Open the trust dialog for a directory (picker, project rows, badge). */
  readonly openTrustPrompt: (cwd: string) => void;
}

export interface UseChatViewSessionSurfacesReturn {
  /** Guards against out-of-order session:load responses overwriting a newer pick. */
  readonly sessionSwitchGeneration: { current: number };
  readonly handleSessionSelect: (id: string, options?: { force?: boolean }) => Promise<void>;
  /** Hydrate the next older bounded message page for one active-session chain. */
  readonly handleLoadHistoryPage: (chainIndex: number) => Promise<void>;
  readonly enterDraftMode: (opts?: { clearComposer?: boolean }) => Promise<void>;
  readonly handleSessionCreate: () => Promise<void>;
  readonly handleProjectSessionCreate: (projectDir: string) => Promise<void>;
  readonly handleProjectSelect: (projectDir: string) => void;
  readonly handlePickProjectDir: () => Promise<void>;
  readonly handleTrustBadgeClick: () => void;
  readonly handleSessionCreateClick: () => void;
  readonly handleProjectSessionCreateClick: (projectDir: string) => void;
  readonly handlePickProjectDirClick: () => void;
}

/**
 * Owns every path that re-binds this window's project or enters draft mode.
 * The durable tab strip is restored here once both the working set and the
 * session list have settled, so a tab restore always wins over a picker.
 */
export function useChatViewSessionSurfaces({
  session,
  chat,
  todos,
  messageQueue,
  surfaces,
  notify,
  openTrustPrompt,
}: UseChatViewSessionSurfacesOptions): UseChatViewSessionSurfacesReturn {
  const sessionSwitchGen = useRef(0);
  const {
    draftTabVisible,
    setDraftTabVisible,
    setProjectConfigDir,
    setComposerDraftKey,
  } = surfaces;

  const applySessionMessages = useCallback(
    (loadedSession: Session | null) => {
      if (!loadedSession) {
        chat.setMessages([]);
        todos.applyFromSession([]);
        return;
      }
      chat.setMessages(flattenSessionMessages(loadedSession));
      todos.applyFromSession(loadedSession.todoStore.tasks);
    },
    [chat.setMessages, todos.applyFromSession],
  );

  const handleSessionSelect = useCallback(
    async (id: string, options?: { force?: boolean }) => {
      setProjectConfigDir(null);
      // Already focused this session (not draft) — skip full reload to avoid flicker.
      // `force` re-fetches anyway (reconnect resync: the view must land on the
      // same complete state as a fresh open).
      const refetchRequested = options?.force === true;
      const alreadyFocusedHere = session.activeSession?.id === id && !draftTabVisible;
      if (!refetchRequested && alreadyFocusedHere) {
        return;
      }

      const gen = ++sessionSwitchGen.current;

      // Rebind stream affinity immediately so previous-session events cannot
      // repopulate the pane — but keep painting the previous session until
      // the full target payload is ready (no intermediate empty/zero state).
      chat.beginSessionSwitch(id);

      // Single round-trip: activate the session and fetch its bounded renderer
      // view (session + loaded messages + live snapshot + workspace) at once.
      let result: SessionOpenResult | null = null;
      try {
        result = await session.open(id);
      } catch {
        // result stays null on failure — handled by the !result guard below.
      }
      if (gen !== sessionSwitchGen.current) return;

      if (!result || !result.session) {
        // Could not load (missing/corrupt) — keep the previous paint and release
        // the switch hold without blanking the pane.
        chat.hydrateSnapshot(null);
        return;
      }

      setDraftTabVisible(false);
      messageQueue.clearQueue();
      // Commit once: subagent summaries hydrate independently; chat messages
      // and live state hydrate here without a duplicate message replace.
      todos.applyFromSession(result.session.todoStore.tasks);
      chat.hydrateSnapshot({
        sessionId: result.session.id,
        messages: result.messages,
        live: result.live,
        lastChainError: result.lastChainError,
      });
    },
    [
      session,
      chat.beginSessionSwitch,
      chat.hydrateSnapshot,
      todos.applyFromSession,
      draftTabVisible,
      messageQueue.clearQueue,
      setProjectConfigDir,
      setDraftTabVisible,
    ],
  );

  // Hydrate the next older bounded page for one chain of the active session.
  const handleLoadHistoryPage = useCallback(async (chainIndex: number) => {
    const chain = session.activeSession?.chains[chainIndex];
    if (!chain) return;
    await session.loadHistoryPage(chain.id);
  }, [session]);

  const enterDraftMode = useCallback(async (opts?: { clearComposer?: boolean }) => {
    setProjectConfigDir(null);
    const gen = ++sessionSwitchGen.current;
    chat.beginSessionSwitch(null);
    messageQueue.clearQueue();
    try {
      await session.enterDraft();
    } catch (err) {
      // The switch already began — still land on the draft surface so the
      // pane cannot hang mid-switch when clearing the active session fails.
      console.error('Failed to enter draft mode:', err);
    }
    if (gen !== sessionSwitchGen.current) return;
    applySessionMessages(null);
    setDraftTabVisible(true);
    if (opts?.clearComposer) {
      setComposerDraftKey((k) => k + 1);
    }
  }, [session, chat.beginSessionSwitch, applySessionMessages, messageQueue.clearQueue, setProjectConfigDir, setDraftTabVisible, setComposerDraftKey]);

  // New chat: draft in the currently selected project. Never open a folder
  // picker here — inherit session.cwd → workspace.cwd → sticky default.
  // Without a bound project, stay draft-unbound until the user picks a folder.
  const handleSessionCreate = useCallback(async () => {
    const gen = ++sessionSwitchGen.current;
    const activeCwd = session.activeSession?.cwd?.trim() ?? '';
    const boundCwd = session.workspace?.status === 'valid' ? session.workspace.cwd : null;
    const inheritCwd = activeCwd || boundCwd;
    if (inheritCwd) {
      const workspace = await session.setWorkspace(inheritCwd);
      if (gen !== sessionSwitchGen.current) return;
      if (!workspace?.cwd) {
        applySessionMessages(null);
        return;
      }
      const needsTrustPrompt = workspace.trust !== 'trusted';
      if (needsTrustPrompt) {
        openTrustPrompt(workspace.cwd);
      }
    }
    await enterDraftMode({ clearComposer: true });
  }, [session, enterDraftMode, applySessionMessages, openTrustPrompt]);

  // Project-row New Chat: make that project the window's draft workspace, then
  // clear selection. The first message creates a new session there while any
  // previous conversation keeps running in its own project.
  const handleProjectSessionCreate = useCallback(async (projectDir: string) => {
    const gen = ++sessionSwitchGen.current;
    const workspace = await session.setWorkspace(projectDir);
    const usable = workspace?.cwd != null && gen === sessionSwitchGen.current;
    if (!usable || !workspace?.cwd) return;
    if (workspace.trust !== 'trusted') {
      openTrustPrompt(workspace.cwd);
    }
    await enterDraftMode({ clearComposer: true });
    notify(`New chat in project: ${workspace.cwd}`, 'info');
  }, [session, enterDraftMode, notify, openTrustPrompt]);

  const handleProjectSelect = useCallback((projectDir: string) => {
    setProjectConfigDir(projectDir);
  }, [setProjectConfigDir]);

  const handlePickProjectDir = useCallback(async () => {
    const startsDraft = hasPersistedChains(session.activeSession);
    const info = await session.pickProjectDir();
    if (info?.status === 'valid' && info.cwd) {
      if (info.trust !== 'trusted') {
        openTrustPrompt(info.cwd);
      }
      if (startsDraft) {
        ++sessionSwitchGen.current;
        chat.beginSessionSwitch(null);
        // Forced rebind: the queued messages belong to the session being left.
        messageQueue.clearQueue();
        applySessionMessages(null);
        setDraftTabVisible(true);
        setComposerDraftKey((k) => k + 1);
        notify(`New chat in project: ${info.cwd}`, 'info');
      } else {
        notify(`Project folder: ${info.cwd}`, 'info');
      }
    }
  }, [session, chat.beginSessionSwitch, applySessionMessages, notify, messageQueue.clearQueue, openTrustPrompt, setDraftTabVisible, setComposerDraftKey]);

  // Workspace trust badge (LeftSidebar) opens the dialog for the bound cwd.
  const handleTrustBadgeClick = useCallback(() => {
    const cwd = session.workspace?.cwd;
    if (cwd) openTrustPrompt(cwd);
  }, [session.workspace?.cwd, openTrustPrompt]);

  useEffect(() => {
    if (session.activeSession?.id) {
      setDraftTabVisible(false);
    }
  }, [session.activeSession?.id, setDraftTabVisible]);

  // Stable prop wrappers for the memoized LeftSidebar. Inline arrows here would
  // give the rail a fresh identity every render and defeat React.memo, so the
  // whole sidebar re-rendered on each streamed token / activity broadcast.
  const handleSessionCreateClick = useCallback(() => {
    void handleSessionCreate();
  }, [handleSessionCreate]);
  const handleProjectSessionCreateClick = useCallback((projectDir: string) => {
    void handleProjectSessionCreate(projectDir);
  }, [handleProjectSessionCreate]);
  const handlePickProjectDirClick = useCallback(() => {
    void handlePickProjectDir();
  }, [handlePickProjectDir]);

  return {
    sessionSwitchGeneration: sessionSwitchGen,
    handleSessionSelect,
    handleLoadHistoryPage,
    enterDraftMode,
    handleSessionCreate,
    handleProjectSessionCreate,
    handleProjectSelect,
    handlePickProjectDir,
    handleTrustBadgeClick,
    handleSessionCreateClick,
    handleProjectSessionCreateClick,
    handlePickProjectDirClick,
  };
}
