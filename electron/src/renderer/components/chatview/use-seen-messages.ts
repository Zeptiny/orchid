/**
 * Report the visible session as seen: the activity store clears its unread dot
 * whenever this window is focused, and never while it is hidden.
 */
import { useEffect } from 'react';

export interface UseSeenMessagesOptions {
  /** Session currently on screen; no session (draft) has nothing to mark. */
  readonly sessionId: string | undefined;
  readonly markSeen: (sessionId: string) => Promise<void>;
}

/** Mark the active session seen on mount, on window focus, and on tab return. */
export function useSeenMessages({ sessionId, markSeen }: UseSeenMessagesOptions): void {
  useEffect(() => {
    if (!sessionId) return undefined;
    const reportSeen = () => {
      if (document.visibilityState === 'visible') {
        void markSeen(sessionId);
      }
    };
    reportSeen();
    window.addEventListener('focus', reportSeen);
    document.addEventListener('visibilitychange', reportSeen);
    return () => {
      window.removeEventListener('focus', reportSeen);
      document.removeEventListener('visibilitychange', reportSeen);
    };
  }, [sessionId, markSeen]);
}
