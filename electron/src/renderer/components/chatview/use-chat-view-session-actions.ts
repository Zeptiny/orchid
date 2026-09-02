/**
 * Session library actions for ChatView: tab close (with the running-session
 * confirmation), session delete/rename, and deletion reconciliation against
 * the durable working set.
 */
import { useCallback, useMemo } from 'react';
import { marksLiveSessionActivity } from './chat-view-selectors';
import { useSessionDeletionReconciliation } from '../../hooks/useSessionDeletionReconciliation';
import type { UseSessionActivityReturn } from '../../hooks/useSessionActivity';
import type { UseChatReturn } from '../../hooks/useChat';
import type { UseMessageQueueReturn } from '../../hooks/useMessageQueue';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { UseSessionTabsReturn } from '../../hooks/useSessionTabs';
import type { Notify } from '../../utils/notify';
import type { UseChatViewSurfacesReturn } from './use-chat-view-surfaces';

export interface UseChatViewSessionActionsOptions {
  readonly session: UseSessionReturn;
  readonly chat: UseChatReturn;
  readonly tabs: UseSessionTabsReturn;
  readonly activity: UseSessionActivityReturn;
  readonly messageQueue: UseMessageQueueReturn;
  readonly surfaces: UseChatViewSurfacesReturn;
  readonly notify: Notify;
  readonly selectSession: (id: string, options?: { force?: boolean }) => Promise<void>;
  readonly enterDraftMode: (opts?: { clearComposer?: boolean }) => Promise<void>;
}

export interface UseChatViewSessionActionsReturn {
  readonly handleSessionDelete: (id: string) => Promise<void>;
  readonly handleProjectDelete: (project: { label: string; sessionIds: readonly string[] }) => Promise<void>;
  readonly handleSessionDeleteError: (error: unknown) => void;
  readonly handleSessionRename: (id: string, name: string) => Promise<void>;
  readonly requestCloseTab: (id: string) => void;
  readonly performCloseTab: (id: string) => Promise<void>;
  readonly handleCloseFocusedTab: () => void;
  readonly handleTabSelect: (id: string) => void;
  readonly handleSelectDraftTab: () => void;
  readonly handleCloseDraftTab: () => void;
  readonly handleStopSession: (sessionId: string) => void;
}

/**
 * Every path that closes, deletes, or renames a session. Closing a tab whose
 * session is still working asks first; deletions reconcile through the
 * authoritative working-set snapshot.
 */
export function useChatViewSessionActions({
  session,
  chat,
  tabs,
  activity,
  messageQueue,
  surfaces,
  notify,
  selectSession,
  enterDraftMode,
}: UseChatViewSessionActionsOptions): UseChatViewSessionActionsReturn {
  const {
    draftTabVisible,
    setDraftTabVisible,
    setCloseConfirmId,
    setComposerDraftKey,
  } = surfaces;

  const isLiveSession = useCallback(
    (id: string) => {
      // Prefer activity store; also treat focused streaming chat as live so
      // confirm still fires if the activity broadcast has not arrived yet.
      const row = activity.activities.find((candidate) => candidate.sessionId === id);
      if (marksLiveSessionActivity(row)) return true;
      // Focused session currently streaming — cover activity broadcast lag.
      return session.activeSession?.id === id && chat.status === 'streaming';
    },
    [activity.activities, session.activeSession?.id, chat.status],
  );

  const focusAfterWorkingSet = useCallback(
    async (snapshot: { focusedSessionId: string | null; openSessionIds: readonly string[] }) => {
      const nextId = snapshot.focusedSessionId;
      if (nextId) {
        setDraftTabVisible(false);
        await selectSession(nextId);
        return;
      }
      await enterDraftMode();
    },
    [selectSession, enterDraftMode, setDraftTabVisible],
  );

  const handleSessionDeleteError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    notify(`Delete failed: ${message}`, 'error');
  }, [notify]);

  const deletionReconciliation = useMemo(() => ({
    applySnapshot: tabs.applySnapshot,
    clearQueue: messageQueue.clearQueue,
    clearMessages: () => chat.setMessages([]),
    focusAfterWorkingSet,
    onError: handleSessionDeleteError,
  }), [
    tabs.applySnapshot,
    messageQueue.clearQueue,
    chat.setMessages,
    focusAfterWorkingSet,
    handleSessionDeleteError,
  ]);
  useSessionDeletionReconciliation(
    session.deletionNotice,
    deletionReconciliation,
  );

  const performCloseTab = useCallback(
    async (id: string) => {
      const wasFocused = session.activeSession?.id === id;
      const snapshot = await tabs.closeTab(id);
      if (wasFocused) {
        await focusAfterWorkingSet(snapshot);
      }
    },
    [tabs, session.activeSession?.id, focusAfterWorkingSet],
  );

  const requestCloseTab = useCallback(
    (id: string) => {
      if (isLiveSession(id)) {
        setCloseConfirmId(id);
        return;
      }
      void performCloseTab(id);
    },
    [isLiveSession, performCloseTab, setCloseConfirmId],
  );

  // The deletion event/result reconciliation follows MRU for every window.
  const handleSessionDelete = useCallback(
    async (id: string) => {
      const wasActive = session.activeSession?.id === id;
      // Clear before the invoke so queued work can never target a session whose
      // durable row is about to disappear.
      if (wasActive) messageQueue.clearQueue();
      await session.deleteSession(id);
    },
    [session, messageQueue.clearQueue],
  );

  // Project delete removes every session in the group. Sequential so each
  // delete's working-set snapshot reflects the previous one; one failure must
  // not abort the rest.
  const handleProjectDelete = useCallback(
    async (project: { label: string; sessionIds: readonly string[] }) => {
      const deletesActiveSession = project.sessionIds.includes(session.activeSession?.id ?? '');
      if (deletesActiveSession) {
        messageQueue.clearQueue();
      }
      let failures = 0;
      let lastError: unknown = null;
      for (const id of project.sessionIds) {
        try {
          await session.deleteSession(id);
        } catch (err) {
          failures += 1;
          lastError = err;
          console.error(`Project delete failed for session ${id}:`, err);
        }
      }
      if (failures > 0) {
        const reason = lastError instanceof Error ? ` (${lastError.message})` : '';
        notify(
          `Deleted ${project.sessionIds.length - failures} of ${project.sessionIds.length} sessions in ${project.label}; ${failures} failed${reason}.`,
          'error',
        );
      }
    },
    [session, messageQueue.clearQueue, notify],
  );

  const handleSessionRename = useCallback(
    async (id: string, name: string) => {
      try {
        await session.rename(id, name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify(`Rename failed: ${message}`, 'error');
      }
    },
    [session, notify],
  );

  const leaveDraftToOpenTab = useCallback(async () => {
    const openIds = tabs.snapshot.openSessionIds;
    if (openIds.length === 0) {
      // Empty working set: draft is the only surface — keep it visible.
      setDraftTabVisible(true);
      return;
    }
    const mru = tabs.snapshot.mruSessionIds.find((id) => openIds.includes(id));
    const nextId = mru ?? openIds[openIds.length - 1] ?? openIds[0];
    setDraftTabVisible(false);
    setComposerDraftKey((k) => k + 1);
    await selectSession(nextId);
  }, [tabs.snapshot, selectSession, setDraftTabVisible, setComposerDraftKey]);

  // Stable prop wrappers for the memoized tab bar / composer / inspector.
  // Inline arrows would hand those components a fresh identity every render and
  // defeat React.memo, re-rendering them on each streamed token.
  const handleTabSelect = useCallback((id: string) => {
    setDraftTabVisible(false);
    void selectSession(id);
  }, [selectSession, setDraftTabVisible]);
  const handleSelectDraftTab = useCallback(() => {
    void enterDraftMode();
  }, [enterDraftMode]);
  const handleCloseDraftTab = useCallback(() => {
    void leaveDraftToOpenTab();
  }, [leaveDraftToOpenTab]);

  const handleCloseFocusedTab = useCallback(() => {
    const closingDraft = draftTabVisible && session.activeSession == null;
    if (closingDraft) {
      void leaveDraftToOpenTab();
      return;
    }
    const id = session.activeSession?.id ?? tabs.snapshot.focusedSessionId;
    if (id) requestCloseTab(id);
  }, [
    draftTabVisible,
    session.activeSession,
    tabs.snapshot.focusedSessionId,
    requestCloseTab,
    leaveDraftToOpenTab,
  ]);

  const handleStopSession = useCallback((sessionId: string) => {
    void chat.stop(sessionId);
  }, [chat.stop]);

  return {
    handleSessionDelete,
    handleProjectDelete,
    handleSessionDeleteError,
    handleSessionRename,
    requestCloseTab,
    performCloseTab,
    handleCloseFocusedTab,
    handleTabSelect,
    handleSelectDraftTab,
    handleCloseDraftTab,
    handleStopSession,
  };
}
