import type { ChatStatus } from '../hooks/useChat';

export interface SubagentRefreshState {
  readonly sessionId: string | null;
  readonly status: ChatStatus;
}

/** Refresh durable summaries only after a real turn completes in-place. */
export function shouldRefreshSubagentsAfterTurn(
  previous: SubagentRefreshState,
  current: SubagentRefreshState,
): boolean {
  return current.sessionId !== null
    && previous.sessionId === current.sessionId
    && previous.status === 'streaming'
    && current.status === 'idle';
}
