/**
 * useSubagents — subscribes to subagent state updates.
 *
 * Provides:
 * - Subagent list from active session
 * - Loading/error states (interaction states)
 * - Per-subagent detail with live elapsed time tracking
 * - Expand/collapse selection state
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { SubagentRecord } from '../../shared/types/subagent';

// ── Types ────────────────────────────────────────────────────────────────────

export type SubagentListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; subagents: readonly SubagentRecord[] }
  | { status: 'error'; error: string };

/** Enriched per-subagent detail for sidebar display. */
export interface SubagentDetail {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly tier: string;
  readonly state: string;
  readonly task: string;
  /** Formatted elapsed time string (e.g. "12s", "2m 15s"). */
  readonly elapsed: string;
  /** Whether the subagent is still running (elapsed time ticking). */
  readonly isRunning: boolean;
  /** Result text on success, null if not completed. */
  readonly result: string | null;
  /** Error text on failure, null if not failed. */
  readonly error: string | null;
}

export interface UseSubagentsReturn {
  /** Subagent list state with interaction states. */
  state: SubagentListState;
  /** Refresh subagent list from active session. */
  refresh: () => Promise<void>;
  /** Currently expanded subagent ID (null = none expanded). */
  selectedId: string | null;
  /** Select/deselect a subagent for detail view. */
  select: (id: string | null) => void;
  /** Get enriched detail for a specific subagent. */
  getDetail: (id: string) => SubagentDetail | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format milliseconds into a human-readable elapsed string. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Build a SubagentDetail from a SubagentRecord and current time. */
function buildDetail(record: SubagentRecord, now: number): SubagentDetail {
  const startTime = new Date(record.start_time).getTime();
  const endTime = record.end_time ? new Date(record.end_time).getTime() : null;
  const isRunning = record.status === 'running' || record.status === 'pending';
  const elapsedMs = endTime ? endTime - startTime : now - startTime;

  return {
    id: record.id,
    name: record.agent_name || 'Subagent',
    type: record.agent_type || 'subagent',
    tier: record.agent_tier || 'bloom',
    state: record.status,
    task: record.task || '',
    elapsed: formatElapsed(Math.max(0, elapsedMs)),
    isRunning,
    result: record.result,
    error: record.error,
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSubagents(activeSessionId: string | null): UseSubagentsReturn {
  const [state, setState] = useState<SubagentListState>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Live elapsed time ticker: update every second while any subagent is running
  useEffect(() => {
    if (state.status !== 'ready') {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return;
    }

    const hasRunning = state.subagents.some(
      (s) => s.status === 'running' || s.status === 'pending',
    );

    if (hasRunning && !tickRef.current) {
      tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    } else if (!hasRunning && tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }

    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [state]);

  const select = useCallback((id: string | null) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const getDetail = useCallback(
    (id: string): SubagentDetail | null => {
      if (state.status !== 'ready') return null;
      const record = state.subagents.find((s) => s.id === id);
      if (!record) return null;
      // tick is used as a dependency to force recalculation every second
      void tick;
      return buildDetail(record, Date.now());
    },
    [state, tick],
  );

  return { state, refresh, selectedId, select, getDetail };
}
