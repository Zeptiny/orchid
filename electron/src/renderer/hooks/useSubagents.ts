/**
 * useSubagents — subscribes to subagent state updates.
 *
 * Provides:
 * - Subagent list from active session
 * - Loading/error states (interaction states)
 */
import { useState, useEffect, useCallback } from 'react';
import type { SubagentRecord } from '../../shared/types/subagent';

// ── Types ────────────────────────────────────────────────────────────────────

export type SubagentListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; subagents: readonly SubagentRecord[] }
  | { status: 'error'; error: string };

export interface UseSubagentsReturn {
  /** Subagent list state with interaction states. */
  state: SubagentListState;
  /** Refresh subagent list from active session. */
  refresh: () => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSubagents(activeSessionId: string | null): UseSubagentsReturn {
  const [state, setState] = useState<SubagentListState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    if (!activeSessionId) {
      setState({ status: 'empty' });
      return;
    }

    try {
      // Load the session to get subagent data
      const session = await window.orchid.session.load({ id: activeSessionId });
      if (!session) {
        setState({ status: 'empty' });
        return;
      }

      const subagents = session.subagentChains;
      if (subagents.length === 0) {
        setState({ status: 'empty' });
      } else {
        setState({ status: 'ready', subagents });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', error });
    }
  }, [activeSessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, refresh };
}
