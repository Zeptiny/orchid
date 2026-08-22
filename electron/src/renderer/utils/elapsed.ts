/**
 * Shared elapsed-time hook for live timers (thinking + tool runtimes).
 *
 * Timers anchor on wire-provided timestamps (segment stamps, tool
 * startedAt/finishedAt), never view-mount clocks — a timer mounted late shows
 * the true elapsed value at first paint instead of restarting from zero.
 */
import { useEffect, useState } from 'react';

const TICK_MS = 100;

export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  const totalSeconds = Math.floor(clamped / 1000);
  if (totalSeconds < 60) {
    return `${(clamped / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function elapsedBetween(startedAt: string | null | undefined, endedAt: string | null | undefined, now: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = endedAt != null ? Date.parse(endedAt) : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export interface UseElapsedMsOptions {
  /** ISO timestamp when the activity began; null/undefined when unknown. */
  startedAt: string | null | undefined;
  /** ISO timestamp when the activity settled; null while still live. */
  endedAt: string | null | undefined;
}

/**
 * Live elapsed ms for a timestamped activity.
 * - Ticks while `endedAt` is null.
 * - Freezes at `endedAt - startedAt` once settled.
 * - Returns null when `startedAt` is missing (render no timer).
 */
export function useElapsedMs({ startedAt, endedAt }: UseElapsedMsOptions): number | null {
  const live = endedAt == null && startedAt != null;
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [live]);

  return elapsedBetween(startedAt, endedAt, live ? now : Date.now());
}
