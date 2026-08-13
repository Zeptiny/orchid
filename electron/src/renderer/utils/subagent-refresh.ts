import type { ChatStatus } from '../hooks/useChat';

/** Minimal transition state used to detect completion of one in-place chat turn. */
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
