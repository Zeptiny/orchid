/**
 * useLiveCommandOutput — polls live command output from the main process.
 *
 * Targets either a background command (`commandId`) or a foreground live
 * mirror (`toolCallId`), resolving visibility against the explicit owning
 * session. Adaptive polling (200ms expanded / 1000ms collapsed) with
 * inflight coalescing so concurrent widgets polling the same command share
 * one IPC round-trip. When the command exits or becomes unavailable, polling
 * stops automatically.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BgCommandOwner, BgCommandSnapshotRequest, BgCommandSnapshotResult } from '../../shared/types/ipc';

// ── Types ────────────────────────────────────────────────────────────────────

/** Discriminated live-command target: exactly one of commandId / toolCallId. */
export type LiveCommandTarget = { commandId: number } | { toolCallId: string };

export interface LiveCommandState {
  /** Accumulated tail output. */
  output: string;
  /** Exit code (null if still running). */
  exitCode: number | null;
  /** Whether the command is still running. */
  isRunning: boolean;
  /** Whether the command is still available in the current process and session. */
  isAvailable: boolean;
  /** Whether the command accepts user input (interactive PTY only). */
  interactive: boolean;
  /** Current input owner; null until the first found snapshot. */
  owner: BgCommandOwner | null;
  /** Spawned command line; empty until the first found snapshot. */
  command: string;
  /** Human-readable label, when the snapshot provides one. */
  description: string | undefined;
  /** Owning agent scope ('main' or a subagent id), once known. */
  agentScopeId: string | undefined;
  /** Force an immediate poll (e.g. right after a user control action). */
  refresh: () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_EXPANDED_MS = 200;
const POLL_INTERVAL_COLLAPSED_MS = 1000;
const MAX_LINES = 50;

// ── Snapshot coalescing cache ────────────────────────────────────────────────
// Module-level dedup so concurrent widgets polling the same command share one
// IPC round-trip while the request is in flight. Halves the chat+sidebar
// double-poll cost without a snapshotBatch endpoint. Only inflight promises
// are coalesced; settled snapshots are not cached for reuse so sequential
// refresh() calls and interval polls still fetch fresh data.

type SnapshotResult = BgCommandSnapshotResult;

interface CoalesceEntry {
  inflightPromise: Promise<SnapshotResult>;
  snapshotFn: unknown;
}

const snapshotCoalesceCache = new Map<string, CoalesceEntry>();

function buildCoalesceKey(
  sessionId: string | null,
  commandId: number | null,
  toolCallId: string | null,
  lastN: number,
  includeTail: boolean,
): string {
  return `${sessionId ?? ''}:${commandId ?? ''}:${toolCallId ?? ''}:${lastN}:${includeTail ? '1' : '0'}`;
}

async function fetchCoalescedSnapshot(
  request: BgCommandSnapshotRequest,
): Promise<SnapshotResult> {
  if (!window.orchid?.bgCmd) throw new Error('bgCmd unavailable');
  const key = buildCoalesceKey(
    request.sessionId ?? null,
    request.commandId ?? null,
    request.toolCallId ?? null,
    request.lastN ?? MAX_LINES,
    request.includeTail !== false,
  );
  const snapshotFn = window.orchid.bgCmd.snapshot;
  const existing = snapshotCoalesceCache.get(key);
  // Only reuse if the underlying snapshot function is the same instance
  // (prevents cross-test pollution where window.orchid is re-stubbed).
  if (existing && existing.snapshotFn === snapshotFn) {
    return existing.inflightPromise;
  }
  const promise: Promise<SnapshotResult> = (window.orchid.bgCmd.snapshot(request) as Promise<SnapshotResult>)
    .catch((err) => {
      throw err;
    })
    .finally(() => {
      // Clear inflight after settlement so the next poll fetches fresh data.
      const cur = snapshotCoalesceCache.get(key);
      if (cur?.inflightPromise === promise) {
        snapshotCoalesceCache.delete(key);
      }
    });
  snapshotCoalesceCache.set(key, { inflightPromise: promise, snapshotFn });
  return promise;
}

/** Test helper: clear the coalesce cache between isolated tests. */
export function __clearSnapshotCoalesceCacheForTest(): void {
  snapshotCoalesceCache.clear();
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Polls a live command's output and metadata.
 *
 * @param target Background command id or foreground tool-call id; null disables polling.
 * @param sessionId Owning session for visibility; omitted from the request when null.
 * @param enabled Whether status polling should be active.
 * @param refreshOutput Whether tail output should refresh while polling.
 * @param expectedCreatedAt Persisted spawn time (epoch ms) for a replayed background
 *   command. When a found snapshot reports a different `createdAt`, the integer
 *   commandId was reused by an unrelated process after an app restart, so the
 *   widget freezes as unavailable. Legacy facts without createdAt must not alias
 *   onto a new live process that does have a createdAt.
 * @returns Current output and metadata state.
 */
export function useLiveCommandOutput(
  target: LiveCommandTarget | null,
  sessionId: string | null,
  enabled: boolean,
  refreshOutput = enabled,
  expectedCreatedAt?: number,
): LiveCommandState {
  const commandId = target !== null && 'commandId' in target ? target.commandId : null;
  const toolCallId = target !== null && 'toolCallId' in target ? target.toolCallId : null;
  // Scalar identity for effect deps and stale-poll guarding.
  const targetKey =
    commandId !== null
      ? `command:${commandId}`
      : toolCallId !== null
        ? `tool:${toolCallId}`
        : null;

  const [output, setOutput] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(true);
  const [isAvailable, setIsAvailable] = useState(true);
  const [interactive, setInteractive] = useState(false);
  const [owner, setOwner] = useState<BgCommandOwner | null>(null);
  const [command, setCommand] = useState('');
  const [description, setDescription] = useState<string | undefined>(undefined);
  const [agentScopeId, setAgentScopeId] = useState<string | undefined>(undefined);

  // Track accumulated output for delta computation (matches Python pattern)
  const accumulatedRef = useRef('');
  // Status polling stays active while collapsed, but only publish tail changes
  // when the consumer currently wants them rendered.
  const refreshOutputRef = useRef(refreshOutput);
  refreshOutputRef.current = refreshOutput;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Prevent overlapping async polls (IPC > POLL_INTERVAL_MS) from reordering deltas
  const isPollingRef = useRef(false);
  // Guard against setState after unmount
  const mountedRef = useRef(true);
  // Track the target that was active when poll() was invoked, so a stale
  // in-flight IPC response can't write into a newer target's state.
  const activeTargetRef = useRef(targetKey);

  // Mount status + cleanup — StrictMode safe (remount resets mounted flag)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      isPollingRef.current = false;
    };
  }, []);

  // Reset all accumulated state when the target or owning session changes
  useEffect(() => {
    accumulatedRef.current = '';
    isPollingRef.current = false;
    activeTargetRef.current = targetKey;
    setOutput('');
    setExitCode(null);
    setIsRunning(true);
    setIsAvailable(true);
    setInteractive(false);
    setOwner(null);
    setCommand('');
    setDescription(undefined);
    setAgentScopeId(undefined);
  }, [targetKey, sessionId]);

  // Shared freeze path: the target either resolves now or never — stop polling
  // and surface the command as unavailable and not running.
  const freezeUnavailable = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsAvailable(false);
    setIsRunning(false);
  }, []);

  const poll = useCallback(async () => {
    const targetPayload: Pick<BgCommandSnapshotRequest, 'commandId' | 'toolCallId'> | null =
      commandId !== null
        ? { commandId }
        : toolCallId !== null
          ? { toolCallId }
          : null;
    if (!targetPayload || !window.orchid?.bgCmd) return;
    // Skip if a previous poll is still in flight — avoids out-of-order tail updates
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const snap = await fetchCoalescedSnapshot({
        ...targetPayload,
        lastN: MAX_LINES,
        includeTail: !!refreshOutputRef.current,
        // An explicit sessionId owns non-null sessions; omitting it for null sessions intentionally uses the window active-session fallback.
        ...(sessionId ? { sessionId } : {}),
      });

      // Bail if component unmounted or the target changed during await
      if (!mountedRef.current) return;
      if (activeTargetRef.current !== targetKey) return;

      if (!snap.found) {
        // A foreground mirror only registers once the tool actually starts
        // executing — after the permission gate. Until then snapshots report
        // not-found, so keep polling rather than freezing; the widget unmounts
        // when the canonical result replaces the running block. Background and
        // replayed targets keep the one-snapshot freeze (their id either
        // resolves now or never).
        if (toolCallId !== null) return;
        freezeUnavailable();
        return;
      }

      // Restart-aliasing guard (background integer commandIds only): the
      // background store's counter restarts at 1 after an app restart, so a
      // replayed widget could bind to an unrelated process that reused the id.
      // Foreground toolCallIds are UUIDs and never alias, so skip the guard.
      // For live fleet widgets CommandsSection now provides expectedCreatedAt
      // (item.createdAt) so they match; persisted replay widgets compare
      // against the stored fact. Legacy facts without createdAt must not alias
      // onto a new live process that does have a createdAt.
      if (commandId !== null) {
        if (expectedCreatedAt == null) {
          if (snap.createdAt != null) {
            freezeUnavailable();
            return;
          }
        } else if (snap.createdAt != null && snap.createdAt !== expectedCreatedAt) {
          freezeUnavailable();
          return;
        }
      }

      setIsAvailable(true);
      setInteractive(snap.interactive ?? false);
      setOwner(snap.owner ?? 'AGENT');
      setCommand(snap.command ?? '');
      setDescription(snap.description);
      setAgentScopeId(snap.agentScopeId ?? undefined);

      // Update exit code and running state
      if (snap.exitCode !== null) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setExitCode(snap.exitCode);
        setIsRunning(false);
      }

      if (!refreshOutputRef.current) return;

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
  }, [commandId, toolCallId, sessionId, targetKey, expectedCreatedAt, freezeUnavailable]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  // Start/stop polling based on enabled state — adaptive interval: 200ms when
  // tail is visible (expanded), 1000ms when collapsed (status-only).
  useEffect(() => {
    if (!enabled || targetKey === null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Initial poll
    void poll();

    // Start polling interval
    const intervalMs = refreshOutput ? POLL_INTERVAL_EXPANDED_MS : POLL_INTERVAL_COLLAPSED_MS;
    intervalRef.current = setInterval(() => void poll(), intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, targetKey, poll, refreshOutput]);

  // A command may finish while collapsed (and stop the status interval), so
  // reopening explicitly refreshes its final output tail once.
  useEffect(() => {
    if (enabled && refreshOutput) void poll();
  }, [enabled, refreshOutput, poll]);

  // Stop polling when command finishes
  useEffect(() => {
    if (!isRunning && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [isRunning]);

  return {
    output,
    exitCode,
    isRunning,
    isAvailable,
    interactive,
    owner,
    command,
    description,
    agentScopeId,
    refresh,
  };
}
