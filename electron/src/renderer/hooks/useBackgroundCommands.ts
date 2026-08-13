/**
 * useBackgroundCommands — session-wide background command fleet for the
 * inspector Commands section.
 *
 * Provides:
 * - Fleet list from `bgcmd:list` (running-first, then newest-first)
 * - Push refresh on `bgcmd:changed` events scoped to the active session
 * - Loading/error/empty states matching the sibling inspector hooks
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BgCommandListItem } from '../../shared/types/ipc';

// ── Types ────────────────────────────────────────────────────────────────────

export type BackgroundCommandsState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; commands: readonly BgCommandListItem[] }
  | { status: 'error'; error: string };

export interface UseBackgroundCommandsReturn {
  /** Fleet list state with interaction states. */
  state: BackgroundCommandsState;
  /** Refresh the fleet list for the active session. */
  refresh: () => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function listStateFrom(commands: readonly BgCommandListItem[]): BackgroundCommandsState {
  return commands.length === 0
    ? { status: 'empty' }
    : { status: 'ready', commands };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useBackgroundCommands(
  activeSessionId: string | null,
  enabled = true,
): UseBackgroundCommandsReturn {
  const [state, setState] = useState<BackgroundCommandsState>({ status: 'loading' });
  const sessionIdRef = useRef(activeSessionId);
  sessionIdRef.current = activeSessionId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const requestGenerationRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    if (!enabled || !activeSessionId || !window.orchid?.bgCmd?.list) {
      if (aliveRef.current) setState({ status: 'empty' });
      return;
    }

    const requestId = activeSessionId;
    try {
      const commands = await window.orchid.bgCmd.list({ sessionId: activeSessionId });
      if (
        !aliveRef.current
        || !enabledRef.current
        || requestGenerationRef.current !== generation
        || sessionIdRef.current !== requestId
      ) return;
      setState(listStateFrom(commands));
    } catch (err) {
      if (
        !aliveRef.current
        || !enabledRef.current
        || requestGenerationRef.current !== generation
        || sessionIdRef.current !== requestId
      ) return;
      const error = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', error });
    }
  }, [activeSessionId, enabled]);

  // Initial load + session switch: reset to loading, then fetch the fleet.
  useEffect(() => {
    if (!enabled || !activeSessionId) {
      setState({ status: 'empty' });
      return;
    }
    setState({ status: 'loading' });
    void refresh();
  }, [activeSessionId, enabled, refresh]);

  // Push refresh on fleet changes; only the owning session re-lists.
  useEffect(() => {
    if (!enabled || !activeSessionId || !window.orchid?.bgCmd?.onChanged) return undefined;
    return window.orchid.bgCmd.onChanged((event) => {
      if (event.sessionId === activeSessionId) void refresh();
    });
  }, [activeSessionId, enabled, refresh]);

  return { state, refresh };
}
