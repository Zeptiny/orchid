/**
 * ChatView's keyboard surface: the registry-backed global shortcut table, the
 * gate that keeps overlay toggles reachable, the close-confirmation focus trap,
 * and the Escape capture that owns the running-tab dialog.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useFocusTrap, useGlobalShortcuts } from '../../keyboard';
import type { RefObject } from 'react';

/** Number of `session.switch.*` chords the registry defines. */
const SESSION_SWITCH_SLOTS = 9;

/** The chord id bound to the nth open tab (1-based, working-set order). */
function sessionSwitchChord(slot: number): string {
  return `session.switch.${slot}`;
}

/** Toggles that stay live behind every overlay because they close themselves. */
function isSelfClosingToggle(id: string): boolean {
  return id === 'palette.toggle' || id === 'shortcuts.help';
}

export interface UseChatViewShortcutsOptions {
  /** False while a full-window surface owns presentation. */
  readonly isVisible: boolean;
  /** Working-set tab order the numeric session-switch chords follow. */
  readonly openSessionIds: readonly string[];
  /** A palette / help / confirmation dialog currently owns the keyboard. */
  readonly overlayOwnsKeyboard: boolean;
  /** A running-tab close is awaiting confirmation. */
  readonly closeConfirmActive: boolean;
  readonly closeConfirmRef: RefObject<HTMLDivElement | null>;
  readonly closeConfirmCancelRef: RefObject<HTMLButtonElement | null>;
  readonly dismissCloseConfirm: () => void;
  readonly togglePalette: () => void;
  readonly toggleHelp: () => void;
  readonly openSettings: () => void;
  readonly createSession: () => void;
  readonly closeFocusedTab: () => void;
  readonly toggleInspector: () => void;
  readonly toggleSessionsRail: () => void;
  readonly selectSessionTab: (id: string) => void;
}

/** Wire the shell's shortcut ids to its handlers, one concern per entry. */
export function useChatViewShortcuts({
  isVisible,
  openSessionIds,
  overlayOwnsKeyboard,
  closeConfirmActive,
  closeConfirmRef,
  closeConfirmCancelRef,
  dismissCloseConfirm,
  togglePalette,
  toggleHelp,
  openSettings,
  createSession,
  closeFocusedTab,
  toggleInspector,
  toggleSessionsRail,
  selectSessionTab,
}: UseChatViewShortcutsOptions): void {
  const sessionSwitchHandlers = useMemo(() => {
    const handlers: Record<string, (event: KeyboardEvent) => void> = {};
    for (let slot = 1; slot <= SESSION_SWITCH_SLOTS; slot++) {
      handlers[sessionSwitchChord(slot)] = () => {
        const targetId = openSessionIds[slot - 1];
        if (targetId) selectSessionTab(targetId);
      };
    }
    return handlers;
  }, [openSessionIds, selectSessionTab]);

  const shortcutHandlers = useMemo(
    () => ({
      'palette.toggle': () => togglePalette(),
      'shortcuts.help': () => toggleHelp(),
      'settings.open': () => openSettings(),
      'session.new': () => {
        createSession();
      },
      'session.tab.close': () => {
        closeFocusedTab();
      },
      'inspector.toggle': () => toggleInspector(),
      'sessionsRail.toggle': () => toggleSessionsRail(),
      ...sessionSwitchHandlers,
    }),
    [
      togglePalette,
      toggleHelp,
      openSettings,
      createSession,
      closeFocusedTab,
      toggleInspector,
      toggleSessionsRail,
      sessionSwitchHandlers,
    ],
  );

  const shortcutGate = useCallback(
    (id: string) => {
      if (!isVisible) return false;
      // Always allow palette / help toggles (they close themselves).
      if (isSelfClosingToggle(id)) return true;
      // Suppress other globals while overlays own the keyboard.
      return !overlayOwnsKeyboard;
    },
    [isVisible, overlayOwnsKeyboard],
  );

  useGlobalShortcuts({
    handlers: shortcutHandlers,
    isEnabled: shortcutGate,
  });

  useFocusTrap({
    enabled: closeConfirmActive,
    containerRef: closeConfirmRef,
    initialFocusRef: closeConfirmCancelRef,
  });

  useEffect(() => {
    if (!closeConfirmActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissCloseConfirm();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeConfirmActive, dismissCloseConfirm]);
}
