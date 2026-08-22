/**
 * useDebugRequests — per-session captured provider request debug list (issue 146).
 *
 * Provides:
 * - Capture list from `debug:sessionRequests` (any agent origin: main,
 *   subagent, compactor, title namer, permission evaluator)
 * - Adaptive interval polling: fast while a chat turn is streaming (attempts
 *   land continuously), slow when idle — pacing mirrors the subagents tick
 * - Row selection with lazy full-capture loading via `debug:requestCapture`
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DebugRequestCapture,
  DebugRequestSummary,
} from '../../shared/types/debug';

// ── Types ────────────────────────────────────────────────────────────────────

export type DebugRequestsListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; requests: readonly DebugRequestSummary[]; total: number }
  | { status: 'error'; error: string };

export type DebugRequestCaptureState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; capture: DebugRequestCapture }
  | { status: 'unavailable' }
  | { status: 'error'; error: string };

export interface UseDebugRequestsReturn {
  /** Capture list state with interaction states. */
  state: DebugRequestsListState;
  /** Flat capture list (empty unless the state is ready). */
  requests: readonly DebugRequestSummary[];
  /** Refresh the capture list for the active session. */
  refresh: () => Promise<void>;
  /** Grow the window and re-fetch (Show more). */
  showMore: () => Promise<void>;
  /** Currently selected attempt id (null when none). */
  selectedId: string | null;
  /** Toggle row selection; selecting the active id clears it. */
  select: (attemptId: string | null) => void;
  /** Full capture load state for the selected attempt. */
  capture: DebugRequestCaptureState;
  /** Retry the selected attempt's capture load. */
  retryCapture: () => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Attempts land continuously while a turn streams — match the subagents tick. */
const POLL_INTERVAL_STREAMING_MS = 1_000;
/** Idle sessions only accrue captures from background origins (titler, …). */
const POLL_INTERVAL_IDLE_MS = 5_000;
/** Initial list window — matches the main-process default. */
const LIST_WINDOW_INITIAL = 200;
/** Each Show more grows the window by this many rows. */
const LIST_WINDOW_STEP = 200;

/** Distinct agent origins among captures ('main' when the scope is absent). */
export function countRequestAgentOrigins(requests: readonly DebugRequestSummary[]): number {
  const origins = new Set<string>();
  for (const request of requests) {
    origins.add(request.agentScope || request.agentName || 'main');
  }
  return origins.size;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Track the captured provider requests for one session and lazily load the
 * full capture for the selected attempt.
 *
 * @param activeSessionId - Session whose captures should be listed.
 * @param enabled - Whether list polling and capture loads are active.
 * @param isStreaming - Whether a chat turn is live; paces the poll interval.
 * @returns The capture list, selection, capture detail state, and refresh actions.
 */
export function useDebugRequests(
  activeSessionId: string | null,
  enabled = true,
  isStreaming = false,
): UseDebugRequestsReturn {
  const [state, setState] = useState<DebugRequestsListState>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capture, setCapture] = useState<DebugRequestCaptureState>({ status: 'idle' });
  const sessionIdRef = useRef(activeSessionId);
  sessionIdRef.current = activeSessionId;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Window size survives polls and refreshes; resets on session switch.
  const windowRef = useRef(LIST_WINDOW_INITIAL);
  const requestGenerationRef = useRef(0);
  const captureGenerationRef = useRef(0);
  // Prevent overlapping same-session polls (IPC > poll interval) from
  // reordering lists. Session switches always proceed so they are never
  // starved by a slow in-flight poll for the previous session.
  const isPollingRef = useRef(false);
  const pollingSessionRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !activeSessionId || !window.orchid?.debug?.sessionRequests) {
      if (aliveRef.current) setState({ status: 'empty' });
      return;
    }
    if (isPollingRef.current && pollingSessionRef.current === activeSessionId) return;
    isPollingRef.current = true;
    pollingSessionRef.current = activeSessionId;
    const generation = ++requestGenerationRef.current;
    const requestId = activeSessionId;
    try {
      const result = await window.orchid.debug.sessionRequests({
        sessionId: requestId,
        limit: windowRef.current,
      });
      if (
        !aliveRef.current
        || !enabledRef.current
        || requestGenerationRef.current !== generation
        || sessionIdRef.current !== requestId
      ) return;
      setState(result.requests.length
        ? { status: 'ready', requests: result.requests, total: result.total }
        : { status: 'empty' });
    } catch (err) {
      if (
        !aliveRef.current
        || !enabledRef.current
        || requestGenerationRef.current !== generation
        || sessionIdRef.current !== requestId
      ) return;
      setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (pollingSessionRef.current === requestId) {
        pollingSessionRef.current = null;
        isPollingRef.current = false;
      }
    }
  }, [activeSessionId, enabled]);

  // Initial load + session switch / re-enable: reset to loading, then fetch.
  useEffect(() => {
    if (!enabled || !activeSessionId) {
      setState({ status: 'empty' });
      return;
    }
    windowRef.current = LIST_WINDOW_INITIAL;
    setState({ status: 'loading' });
    void refresh();
  }, [activeSessionId, enabled, refresh]);

  // Selection is session-affine: switching sessions clears row + capture state.
  useEffect(() => {
    setSelectedId(null);
  }, [activeSessionId]);

  // Adaptive polling — immediate refresh on (re)arm so a turn that just ended
  // lands its terminal captures without waiting out the idle interval.
  useEffect(() => {
    if (!enabled || !activeSessionId) return undefined;
    void refresh();
    const intervalMs = isStreaming ? POLL_INTERVAL_STREAMING_MS : POLL_INTERVAL_IDLE_MS;
    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [activeSessionId, enabled, isStreaming, refresh]);

  const select = useCallback((attemptId: string | null) => {
    setSelectedId((previous) => (previous === attemptId ? null : attemptId));
  }, []);

  const showMore = useCallback(async () => {
    windowRef.current += LIST_WINDOW_STEP;
    await refresh();
  }, [refresh]);

  const requests = state.status === 'ready' ? state.requests : [];
  const selectedSummary = selectedId
    ? requests.find((request) => request.attemptId === selectedId) ?? null
    : null;

  const loadCapture = useCallback(async (attemptId: string): Promise<void> => {
    const generation = ++captureGenerationRef.current;
    if (!window.orchid?.debug?.requestCapture) {
      setCapture({ status: 'error', error: 'Request capture is unavailable' });
      return;
    }
    setCapture({ status: 'loading' });
    try {
      const result = await window.orchid.debug.requestCapture({ attemptId });
      if (generation !== captureGenerationRef.current) return;
      setCapture(result.capture
        ? { status: 'ready', capture: result.capture }
        : { status: 'unavailable' });
    } catch (err) {
      if (generation !== captureGenerationRef.current) return;
      setCapture({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // (Re)load the selected capture; a pending attempt reloads when its outcome
  // or completion time changes so the response body appears once it settles.
  useEffect(() => {
    if (!selectedId || !selectedSummary) {
      captureGenerationRef.current += 1;
      setCapture({ status: 'idle' });
      return;
    }
    void loadCapture(selectedId);
  }, [
    selectedId,
    loadCapture,
    selectedSummary?.outcome,
    selectedSummary?.completedAt,
  ]);

  const retryCapture = useCallback(async () => {
    if (!selectedId) return;
    await loadCapture(selectedId);
  }, [loadCapture, selectedId]);

  return { state, requests, refresh, showMore, selectedId, select, capture, retryCapture };
}
