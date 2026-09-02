/**
 * Restore the durable tab strip once after startup, instead of auto-picking
 * the first session in the library.
 */
import { useEffect, useRef } from 'react';
import { hasSettledSessionList } from './chat-view-selectors';
import type { UseSessionReturn } from '../../hooks/useSession';
import type { UseSessionTabsReturn } from '../../hooks/useSessionTabs';

export interface UseChatViewTabRestoreOptions {
  readonly session: UseSessionReturn;
  readonly tabs: UseSessionTabsReturn;
  /** Guards against out-of-order session:load responses overwriting a newer pick. */
  readonly sessionSwitchGeneration: { current: number };
  readonly selectSession: (id: string, options?: { force?: boolean }) => Promise<void>;
  readonly enterDraftMode: (opts?: { clearComposer?: boolean }) => Promise<void>;
  readonly setDraftTabVisible: (visible: boolean) => void;
}

/** Pick the focused (then most-recent) open tab, or fall back to a draft. */
function resolveRestoredTab(tabs: UseSessionTabsReturn['snapshot']): string | null {
  const openIds = tabs.openSessionIds;
  const focusedIsOpen = tabs.focusedSessionId != null && openIds.includes(tabs.focusedSessionId);
  if (focusedIsOpen) return tabs.focusedSessionId;
  return tabs.mruSessionIds.find((id) => openIds.includes(id)) ?? openIds[0] ?? null;
}

/** Run the restore exactly once, and never over a navigation the user made. */
export function useChatViewTabRestore({
  session,
  tabs,
  sessionSwitchGeneration,
  selectSession,
  enterDraftMode,
  setDraftTabVisible,
}: UseChatViewTabRestoreOptions): void {
  const didBootstrapTabs = useRef(false);

  useEffect(() => {
    if (didBootstrapTabs.current) return;
    if (!tabs.ready) return;
    if (!hasSettledSessionList(session.listState)) return;
    // User already navigated before restore finished — do not clobber.
    if (sessionSwitchGeneration.current > 0 || session.activeSession) {
      didBootstrapTabs.current = true;
      return;
    }

    didBootstrapTabs.current = true;
    const focusId = resolveRestoredTab(tabs.snapshot);
    if (focusId) {
      void selectSession(focusId);
      setDraftTabVisible(false);
      return;
    }
    void enterDraftMode();
  }, [
    tabs.ready,
    tabs.snapshot,
    session.listState,
    session.activeSession,
    sessionSwitchGeneration,
    selectSession,
    enterDraftMode,
    setDraftTabVisible,
  ]);
}
