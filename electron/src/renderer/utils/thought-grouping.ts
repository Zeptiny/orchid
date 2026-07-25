/**
 * Pure helpers for compact consecutive thought groups in the chat stream.
 *
 * Only adjacent thinking messages fold together (option A). Tools, text, or
 * other stream items break a run — same adjacency rule as tool groups.
 */

export interface ThoughtGroupMember {
  /** Stable id for keys (message.id or synthetic). */
  id: string;
  content: string;
  /** When true, this segment is still streaming. */
  isStreaming?: boolean;
}

export interface ThoughtGroupSummary {
  /** e.g. "Thought 623ms · 3" or "Thinking… · 2" */
  title: string;
  segmentCount: number;
  totalMs: number | null;
  isStreaming: boolean;
}

/**
 * Rough duration estimate for a thought body (matches MessageWidget heuristic).
 * ~3.5 chars/ms, clamped.
 */
export function estimateThoughtDurationMs(content: string): number | null {
  if (!content) return null;
  return Math.max(40, Math.min(8000, Math.round(content.length * 3.5)));
}

export function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function summarizeThoughtGroup(
  members: readonly ThoughtGroupMember[],
): ThoughtGroupSummary {
  const segmentCount = members.length;
  const isStreaming = members.some((m) => Boolean(m.isStreaming));

  let totalMs = 0;
  let anyDuration = false;
  for (const m of members) {
    if (m.isStreaming) continue;
    const ms = estimateThoughtDurationMs(m.content);
    if (ms != null) {
      totalMs += ms;
      anyDuration = true;
    }
  }

  if (isStreaming) {
    const title =
      segmentCount <= 1
        ? 'Thinking…'
        : `Thinking… · ${segmentCount}`;
    return {
      title,
      segmentCount,
      totalMs: anyDuration ? totalMs : null,
      isStreaming: true,
    };
  }

  const durationPart =
    anyDuration && totalMs > 0 ? ` ${formatDurationMs(totalMs)}` : '';
  const countPart = segmentCount > 1 ? ` · ${segmentCount}` : '';
  return {
    title: `Thought${durationPart}${countPart}`,
    segmentCount,
    totalMs: anyDuration ? totalMs : null,
    isStreaming: false,
  };
}

/**
 * Fold consecutive matching items into groups when run length ≥ minSize.
 * Non-matching items break the run and pass through unchanged.
 */
export function foldConsecutiveWhere<T>(
  items: readonly T[],
  isMatch: (item: T) => boolean,
  makeGroup: (matched: T[]) => T,
  minSize = 2,
): T[] {
  const out: T[] = [];
  let buf: T[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length >= minSize) {
      out.push(makeGroup(buf));
    } else {
      out.push(...buf);
    }
    buf = [];
  };

  for (const item of items) {
    if (isMatch(item)) {
      buf.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}
