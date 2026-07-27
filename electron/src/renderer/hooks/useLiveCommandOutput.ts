/**
 * useLiveCommandOutput — polls background command output from main process.
 *
 * Throttled to 200ms to match Python's LiveCommandOutputWidget.
 * When the command finishes (exitCode !== null), polling stops automatically.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LiveCommandState {
  /** Accumulated tail output. */
  output: string;
  /** Exit code (null if still running). */
  exitCode: number | null;
  /** Whether the command is still running. */
  isRunning: boolean;
  /** Whether the command is still available in the current process and session. */
  isAvailable: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 200;
const MAX_LINES = 50;

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Polls a background command's output.
 *
 * @param commandId The background command ID (from the tool result content).
 * @param enabled Whether polling should be active.
 * @returns Current output state.
 */
export function useLiveCommandOutput(
  commandId: number | null,
  enabled: boolean,
): LiveCommandState {
  const [output, setOutput] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(true);
  const [isAvailable, setIsAvailable] = useState(true);

  // Track accumulated output for delta computation (matches Python pattern)
  const accumulatedRef = useRef('');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Prevent overlapping async polls (IPC > POLL_INTERVAL_MS) from reordering deltas
  const isPollingRef = useRef(false);
  // Guard against setState after unmount
  const mountedRef = useRef(true);
  // Track the commandId that was active when poll() was invoked, so a stale
  // in-flight IPC response can't write into a newer commandId's state.
  const activeCommandIdRef = useRef(commandId);

  // Keep activeCommandIdRef in sync with the latest commandId prop
  useEffect(() => {
    activeCommandIdRef.current = commandId;
  }, [commandId]);

  // Mount status + cleanup — StrictMode safe (remount resets mounted flag)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      isPollingRef.current = false;
    };
  }, []);

  // P1 #5: Reset all accumulated state when commandId changes
  useEffect(() => {
    accumulatedRef.current = '';
    isPollingRef.current = false;
    activeCommandIdRef.current = commandId;
    setOutput('');
    setExitCode(null);
    setIsRunning(true);
    setIsAvailable(true);
  }, [commandId]);

  const poll = useCallback(async () => {
    if (!commandId || !window.orchid?.bgCmd) return;
    // Skip if a previous poll is still in flight — avoids out-of-order tail updates
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const snap = await window.orchid.bgCmd.snapshot({
        commandId,
        lastN: MAX_LINES,
      });

      // P2 #8: Bail if component unmounted or commandId changed during await
      if (!mountedRef.current) return;
      if (activeCommandIdRef.current !== commandId) return;

      if (!snap.found) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setIsAvailable(false);
        setIsRunning(false);
        return;
      }

      setIsAvailable(true);

      // Update exit code and running state
      if (snap.exitCode !== null) {
        setExitCode(snap.exitCode);
        setIsRunning(false);
      }

      // Compute delta from accumulated content (Python pattern)
      const tailText = snap.tail;
      let delta: string;
      if (tailText.startsWith(accumulatedRef.current)) {
        delta = tailText.slice(accumulatedRef.current.length);
      } else {
        // Buffer was trimmed or reset — push full tail
        delta = tailText;
        accumulatedRef.current = '';
      }

      if (delta) {
        accumulatedRef.current += delta;
        // Trim to prevent unbounded growth (matching Python's MAX_BUFFER_LINES)
        const lines = accumulatedRef.current.split('\n');
        if (lines.length > MAX_LINES) {
          accumulatedRef.current = lines.slice(-MAX_LINES).join('\n');
        }
        setOutput(accumulatedRef.current);
      }
    } catch {
      // Polling failure is non-fatal; will retry on next interval
    } finally {
      isPollingRef.current = false;
    }
  }, [commandId]);

  // Start/stop polling based on enabled state
  useEffect(() => {
    if (!enabled || commandId === null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial poll
    poll();

    // Start polling interval
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, commandId, poll]);

  // Stop polling when command finishes
  useEffect(() => {
    if (!isRunning && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [isRunning]);

  return { output, exitCode, isRunning, isAvailable };
}
