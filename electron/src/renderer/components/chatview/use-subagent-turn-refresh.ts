/**
 * Refresh subagent summaries after a turn completes in the same session, so
 * chain footers pick up token usage written into subagent_chains.
 */
import { useEffect, useRef } from 'react';
import { shouldRefreshSubagentsAfterTurn } from '../../utils/subagent-refresh';
import type { ChatStatus } from '../../hooks/useChat';

export interface UseSubagentTurnRefreshOptions {
  readonly sessionId: string | null;
  readonly status: ChatStatus;
  readonly refresh: () => Promise<void>;
}

/** Fire exactly on the streaming → idle edge within one unchanged session. */
export function useSubagentTurnRefresh({
  sessionId,
  status,
  refresh,
}: UseSubagentTurnRefreshOptions): void {
  // Memoized so the composer, footer, and command palette (all memoized) are
  // not invalidated on every render — previously a fresh object each render
  // forced those subtrees to re-render on every streamed token.
  const turnState = { sessionId, status } as const;
  const previousTurnState = useRef(turnState);
  useEffect(() => {
    const previous = previousTurnState.current;
    previousTurnState.current = turnState;
    if (shouldRefreshSubagentsAfterTurn(previous, turnState)) {
      void refresh();
    }
  }, [turnState.sessionId, turnState.status, refresh]);
}
