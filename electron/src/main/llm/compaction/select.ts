/**
 * Cut-point selection — pure function partitioning replayable history.
 *
 * Requirements R5,R6:
 * - Never leaves a dangling tool_calls block or orphaned tool_result (R5).
 * - Preserve window is last keep_recent_chains completed real chains + always the
 *   trailing open tool group (R6). Summary head (via U2 compacted marker) does
 *   not count toward keep_recent_chains.
 * - Best-effort budget: if preserve window alone exceeds threshold, shrink keep
 *   down to minimum of open group.
 * - Single-only-chain yields empty compactable range.
 *
 * Patterns followed:
 * - Tool-group atomicity in reconcileOrphanToolResults (chain.ts)
 * - Survival pre-pass in history.ts (toApiMessages) for pending tool_calls
 * - Coalescing of consecutive tool-call messages (history.ts)
 */

import type { Message } from '../../../shared/types/message';
import { MessageType, MessageRole } from '../../../shared/types/message';

// ── Public types ────────────────────────────────────────────────────────────

export interface CompactableRange {
  readonly start: number;
  readonly end: number;
}

export interface CutResult {
  /** Index in the original messages array where the preserved window starts (0..n). Compactable is [0,cutIndex). */
  readonly cutIndex: number;
  readonly compactableRange: CompactableRange;
  /** Number of real (non-summary) chains actually preserved after budget shrinking. */
  readonly preservedCount: number;
  /** Start index of the trailing open tool group in original messages, or null if none. Always preserved. */
  readonly openGroupStart: number | null;
  /** For diagnostics: the preserve window [cutIndex,n) */
  readonly preservedRange: CompactableRange;
}

export interface SelectCutBudget {
  readonly contextTokens?: number;
  readonly threshold?: number;
  /** Direct token ceiling; overrides contextTokens*threshold when present. */
  readonly maxPreserveTokens?: number;
  /** Provider-reported inputTokens to scale char estimate; optional. */
  readonly inputTokens?: number;
}

export interface SelectCutOptions {
  readonly keepRecentChains: number;
  /** Sorted ascending indices where each chain starts (0 should be first). If omitted, inferred from USER role. */
  readonly chainBoundaries?: readonly number[];
  /** Budget for shrinking preserve window. If omitted, no shrinking. */
  readonly budget?: SelectCutBudget;
  /** Alias for budget.maxPreserveTokens — convenient for tests. */
  readonly maxPreserveTokens?: number;
  /** Custom token estimator for the preserve window; receives the slice. Defaults to char/4 heuristic. */
  readonly tokenEstimator?: (messages: readonly Message[]) => number;
  /** Direct chars estimator override (rare). */
  readonly contextTokens?: number;
  readonly threshold?: number;
}

// ── Helpers: history-like predicates ───────────────────────────────────────

function isOmittedFromReplay(message: Message): boolean {
  if (message.type === MessageType.ERROR) return true;
  if (message.hidden || message.excludeFromModel) return true;
  if (message.type === MessageType.TOOL_CALL && (!message.tool_calls || message.tool_calls.length === 0)) return true;
  if (message.type === MessageType.THINKING && !message.content) return true;
  if (!message.content && (!message.tool_calls || message.tool_calls.length === 0)) return true;
  return false;
}

function isReplayableToolCallMessage(message: Message): boolean {
  return (
    message.role === MessageRole.ASSISTANT &&
    message.type === MessageType.TOOL_CALL &&
    !message.hidden &&
    !message.excludeFromModel &&
    Boolean(message.tool_calls?.length)
  );
}

function hasCompactedMarker(message: Message): boolean {
  return Boolean((message as Message & { compacted?: unknown }).compacted);
}

// ── Coalescing (mirrors history.ts coalesceConsecutiveToolCallMessages) ────

interface NormalizedEntry {
  normalizedMsg: Message;
  /** Original start index of this (possibly coalesced) entry. */
  originalStart: number;
  originalIndices: number[];
}

function buildNormalized(messages: readonly Message[]): NormalizedEntry[] {
  const normalized: NormalizedEntry[] = [];
  let lastReplayableIndex = -1;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (isReplayableToolCallMessage(message)) {
      if (lastReplayableIndex !== -1) {
        let allSkippable = true;
        for (let j = lastReplayableIndex + 1; j < normalized.length; j += 1) {
          if (!isOmittedFromReplay(normalized[j]!.normalizedMsg)) {
            allSkippable = false;
            break;
          }
        }
        if (allSkippable) {
          const prev = normalized[lastReplayableIndex]!;
          const mergedContent = [prev.normalizedMsg.content, message.content].filter(Boolean).join('\n');
          const mergedToolCalls = [...(prev.normalizedMsg.tool_calls ?? []), ...(message.tool_calls ?? [])];
          const merged: Message = {
            ...prev.normalizedMsg,
            content: mergedContent,
            tool_calls: mergedToolCalls as Message['tool_calls'],
            tool_call_id: null,
          };
          prev.normalizedMsg = merged;
          prev.originalIndices.push(i);
          // keep originalStart as earliest
          continue;
        }
      }
      normalized.push({ normalizedMsg: message, originalStart: i, originalIndices: [i] });
      lastReplayableIndex = normalized.length - 1;
      continue;
    }

    if (!isOmittedFromReplay(message)) {
      lastReplayableIndex = -1;
    }
    normalized.push({ normalizedMsg: message, originalStart: i, originalIndices: [i] });
  }

  return normalized;
}

// ── Chain boundaries ────────────────────────────────────────────────────────

export function inferChainBoundaries(messages: readonly Message[]): number[] {
  if (messages.length === 0) return [];
  const boundaries: number[] = [0];
  for (let i = 1; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role === MessageRole.USER) {
      // Avoid duplicate when 0 is already USER
      if (boundaries[boundaries.length - 1] !== i) boundaries.push(i);
    }
  }
  return boundaries;
}

function normalizeChainBoundaries(
  messages: readonly Message[],
  provided?: readonly number[],
): number[] {
  if (provided && provided.length > 0) {
    const sorted = [...provided].sort((a, b) => a - b);
    // Ensure 0 present and clamp to [0,n]
    const n = messages.length;
    const clamped = sorted.map((v) => Math.max(0, Math.min(v, n)));
    // Dedupe and ensure starts at 0
    const deduped: number[] = [];
    for (const v of clamped) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== v) deduped.push(v);
    }
    if (deduped[0] !== 0) deduped.unshift(0);
    return deduped;
  }
  return inferChainBoundaries(messages);
}

interface ChainInfo {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly hasCompacted: boolean;
}

// ── Tool-group analysis ─────────────────────────────────────────────────────

export interface ToolGroupAnalysis {
  /** Completed groups: [startOrig, endOrig] inclusive for start and end original indices. */
  readonly completedIntervals: Array<readonly [number, number]>;
  readonly openGroupStart: number | null;
}

export function analyzeToolGroups(messages: readonly Message[]): ToolGroupAnalysis {
  const normalized = buildNormalized(messages);
  const completedIntervals: Array<readonly [number, number]> = [];
  let pending:
    | {
        startOrig: number;
        ids: Set<string>;
        satisfied: Set<string>;
        lastResultOrig: number | null;
      }
    | null = null;
  let openGroupStart: number | null = null;

  for (let ni = 0; ni < normalized.length; ni += 1) {
    const entry = normalized[ni]!;
    const msg = entry.normalizedMsg;

    if (msg.type === MessageType.ERROR) continue;
    if (msg.hidden || msg.excludeFromModel) continue;
    if (msg.type === MessageType.TOOL_CALL && (!msg.tool_calls || msg.tool_calls.length === 0)) continue;
    if (msg.type === MessageType.THINKING) continue;

    if (msg.role === MessageRole.TOOL) {
      if (pending && msg.tool_call_id && pending.ids.has(msg.tool_call_id)) {
        pending.satisfied.add(msg.tool_call_id);
        pending.lastResultOrig = entry.originalIndices[0]!;
      }
      continue;
    }

    if (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) continue;

    // Breaking message: previous pending group ends here
    if (pending && pending.satisfied.size === pending.ids.size && pending.satisfied.size > 0 && pending.lastResultOrig !== null) {
      // Only a fully satisfied group is completed (R5). Partial groups remain open
      // and will be handled via openGroupStart so cut snaps before the group.
      completedIntervals.push([pending.startOrig, pending.lastResultOrig]);
    }
    pending = null;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const ids = new Set<string>();
      for (const tc of msg.tool_calls) if (tc.id) ids.add(tc.id);
      pending = {
        startOrig: entry.originalStart,
        ids,
        satisfied: new Set<string>(),
        lastResultOrig: null,
      };
    }
  }

  // Tail handling
  if (pending) {
    if (pending.satisfied.size === pending.ids.size && pending.satisfied.size > 0 && pending.lastResultOrig !== null) {
      completedIntervals.push([pending.startOrig, pending.lastResultOrig]);
    } else if (pending.satisfied.size < pending.ids.size) {
      // Open group: unsatisfied (including partially satisfied or zero satisfied)
      openGroupStart = pending.startOrig;
    } else if (pending.satisfied.size === 0) {
      // Dangling with no results — treat as open so it is preserved whole
      openGroupStart = pending.startOrig;
    }
  }

  // Sort intervals by start (already in order)
  completedIntervals.sort((a, b) => a[0] - b[0]);

  return { completedIntervals, openGroupStart };
}

function adjustCutToSafeBoundary(
  cut: number,
  completedIntervals: ReadonlyArray<readonly [number, number]>,
  openGroupStart: number | null,
  n: number,
): number {
  // Include open group as an interval [openStart, n-1] for boundary checks
  const allIntervals: Array<readonly [number, number]> = [...completedIntervals];
  if (openGroupStart !== null) {
    allIntervals.push([openGroupStart, n - 1]);
  }
  allIntervals.sort((a, b) => a[0] - b[0]);

  let adjusted = cut;
  let changed = true;
  // Iteratively move earlier if inside any interval (excluding start edge)
  while (changed) {
    changed = false;
    for (const [s, e] of allIntervals) {
      if (s < adjusted && adjusted <= e) {
        adjusted = s;
        changed = true;
        break;
      }
      // Also handle inclusive end: if cut == e+1 it's safe (after group). No move.
    }
    // Prevent infinite loop; but intervals are non-overlapping sorted, one pass usually enough
    if (adjusted < 0) {
      adjusted = 0;
      break;
    }
  }
  return adjusted;
}

// ── Token estimation ────────────────────────────────────────────────────────

function defaultEstimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
    if (m.thinking) chars += m.thinking.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    if (m.tool_call_id) chars += m.tool_call_id.length;
    if (m.name) chars += m.name.length;
    if (m.tool_result) chars += JSON.stringify(m.tool_result).length;
    // compacted marker small
    if (hasCompactedMarker(m)) chars += JSON.stringify((m as unknown as { compacted: unknown }).compacted).length;
  }
  // Rough 4 chars per token, at least 1 per message
  return Math.max(messages.length, Math.ceil(chars / 4));
}

function resolveMaxPreserveTokens(opts: SelectCutOptions): number | null {
  if (typeof opts.maxPreserveTokens === 'number') return opts.maxPreserveTokens;
  if (opts.budget?.maxPreserveTokens !== undefined) return opts.budget.maxPreserveTokens;
  // threshold * contextTokens
  const threshold = opts.threshold ?? opts.budget?.threshold;
  const contextTokens = opts.contextTokens ?? opts.budget?.contextTokens;
  if (typeof threshold === 'number' && typeof contextTokens === 'number' && Number.isFinite(threshold) && Number.isFinite(contextTokens)) {
    return Math.floor(threshold * contextTokens);
  }
  return null;
}

// ── Core: selectCut ─────────────────────────────────────────────────────────

export function selectCut(
  messages: readonly Message[],
  opts: SelectCutOptions,
): CutResult {
  const n = messages.length;
  const keepRecentChainsRaw = Math.max(0, Math.floor(opts.keepRecentChains));

  if (n === 0) {
    return {
      cutIndex: 0,
      compactableRange: { start: 0, end: 0 },
      preservedCount: 0,
      openGroupStart: null,
      preservedRange: { start: 0, end: 0 },
    };
  }

  const boundaries = normalizeChainBoundaries(messages, opts.chainBoundaries);
  // Build chain infos
  const chainInfos: ChainInfo[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i]!;
    const end = i + 1 < boundaries.length ? boundaries[i + 1]! : n;
    if (start >= end) continue;
    let hasCompacted = false;
    for (let j = start; j < end; j += 1) {
      if (hasCompactedMarker(messages[j]!)) {
        hasCompacted = true;
        break;
      }
    }
    chainInfos.push({ index: i, start, end, hasCompacted });
  }

  // Real chains are those without summary head
  const realChains = chainInfos.filter((c) => !c.hasCompacted);

  const { completedIntervals, openGroupStart } = analyzeToolGroups(messages);

  // Empty realChains (only summary heads) => nothing to compact (preserve guard for 0 case)
  if (realChains.length === 0) {
    return {
      cutIndex: 0,
      compactableRange: { start: 0, end: 0 },
      preservedCount: 0,
      openGroupStart,
      preservedRange: { start: 0, end: n },
    };
  }

  const maxPreserveTokens = resolveMaxPreserveTokens(opts);
  const estimator = opts.tokenEstimator ?? defaultEstimateTokens;

  // Helper to compute preserve start for a given keep
  const computePreserveStart = (keep: number): number => {
    const k = Math.max(0, Math.min(keep, realChains.length));
    let preserveFromChains: number | null = null;
    if (k > 0) {
      const slice = realChains.slice(-k);
      preserveFromChains = slice[0]!.start;
    }
    const candidates: number[] = [];
    if (preserveFromChains !== null) candidates.push(preserveFromChains);
    if (openGroupStart !== null) candidates.push(openGroupStart);
    if (candidates.length === 0) return n; // preserve nothing (all compactable)
    return Math.min(...candidates);
  };

  // Single-chain fast-path removed (P0 #1): always run chain-boundary + tool-group walk.
  // A runaway 900k turn (1 chain, 3 completed groups + 1 open group) must compact to
  // openGroupStart instead of yielding empty. keep_recent_chains is still honored via
  // computePreserveStart and then bounded by cutToSafeBoundary (tool-group atomicity).
  // Empty compactable now only occurs when the single chain is fully open (no completed
  // intervals and openGroupStart at 0) or when keep covers the whole history and no
  // tool boundary forces an earlier cut.

  // Prefix-sum char array for budget loop (P2 #25): compute once, O(1) per keep iteration
  const usePrefixForDefaultEstimator = !opts.tokenEstimator && maxPreserveTokens !== null;
  let prefixChars: number[] | null = null;
  let totalChars = 0;
  if (usePrefixForDefaultEstimator) {
    prefixChars = new Array(n + 1);
    prefixChars[0] = 0;
    for (let i = 0; i < n; i += 1) {
      const m = messages[i]!;
      let c = 0;
      if (m.content) c += m.content.length;
      if (m.thinking) c += m.thinking.length;
      if (m.tool_calls) c += JSON.stringify(m.tool_calls).length;
      if (m.tool_call_id) c += m.tool_call_id.length;
      if (m.name) c += m.name.length;
      if (m.tool_result) c += JSON.stringify(m.tool_result).length;
      if (hasCompactedMarker(m)) c += JSON.stringify((m as unknown as { compacted: unknown }).compacted).length;
      prefixChars[i + 1] = prefixChars[i]! + c;
    }
    totalChars = prefixChars[n]!;
  }

  // Try shrinking keep from initial down to 0 to fit budget, always adjusting to safe boundary
  for (let keep = keepRecentChainsRaw; keep >= 0; keep -= 1) {
    let cutCandidate = computePreserveStart(keep);
    // Adjust to safe boundary (never split a tool group). For cross-chain splits where
    // a USER boundary lands inside a tool group, snap backward to group start so the
    // entire call/result pair stays together in the preserved window (P1 #6). This
    // avoids the forward-snap orphan where result is compacted but call is kept.
    const adjustedCut = adjustCutToSafeBoundary(cutCandidate, completedIntervals, openGroupStart, n);
    cutCandidate = adjustedCut;

    // After adjustment, recompute preservedCount (may have grown to include whole chain before tool group)
    // preservedCount is number of real chains whose start is >= cutCandidate (or chain interval overlapping preserve)
    // Simpler: count real chains where chain.start >= cutCandidate or chain.end > cutCandidate (partially overlapping due to adjust)
    let preservedCount: number;
    if (cutCandidate <= 0) {
      preservedCount = realChains.length;
    } else {
      preservedCount = realChains.filter((c) => c.end > cutCandidate || c.start >= cutCandidate).length;
      // More precise: chain is preserved if any of its messages are in [cutCandidate, n)
      // That's c.end > cutCandidate && c.start < n (always). So filter c.end > cutCandidate
      // But if adjust moved cut earlier than chain start, that chain still counts.
      // So count chains with c.end > cutCandidate
      preservedCount = realChains.filter((c) => c.end > cutCandidate).length;
      // However if keep was 0 and open group inside a chain, that chain counts even though keep=0
      // So this derived count may differ from keep; expose actual.
    }

    // Budget check: estimate preserve window tokens
    if (maxPreserveTokens !== null) {
      let preserveTokens: number;
      if (usePrefixForDefaultEstimator && prefixChars) {
        const preservedChars = totalChars - prefixChars[cutCandidate]!;
        const preservedLen = n - cutCandidate;
        preserveTokens = Math.max(preservedLen, Math.ceil(preservedChars / 4));
      } else {
        const preserveSlice = messages.slice(cutCandidate);
        preserveTokens = estimator(preserveSlice);
      }
      if (preserveTokens > maxPreserveTokens) {
        // Budget exceeded — try smaller keep (shrink) unless we're already at minimal (open group only)
        // Minimal is keep=0 -> preserve only open group (or empty if no open)
        // If even minimal still exceeds and keep>0, continue shrinking
        // If keep === 0 and still exceeds, we cannot shrink further — return minimal anyway (best-effort)
        if (keep > 0) continue;
        // keep === 0 is minimal, return it even if over budget (floor)
      }
    }

    // Found a keep that fits (or no budget)
    // Compute compactableRange: contiguous [0, cutCandidate)
    // But if cutCandidate is inside summary head? Summary head at 0..summaryEnd, and cutCandidate may be after summary head or at 0.
    // Compactable is everything before cut, but we should ensure summary head is not considered compactable again?
    // Replayable history after compaction excludes old compacted range; summary head is at 0 and is not excludeFromModel.
    // For next compaction, compactable should be [0,cutCandidate) but if messages[0] is summary head, should we exclude it from compactable?
    // The plan says: preserve window measured excluding summary head; compactable = all replayable history before cut.
    // So summary head is part of history before cut if cut > 0. But should it be re-compacted?
    // If we include it, compactableRange would include summary head, leading to summary-of-summary.
    // To avoid that, we could exclude summary head from compactable on next pass by ensuring compactableRange starts after summary head if summary present?
    // However plan says "The summary sits before the preserved chains; if it counted toward the window it would shrink the preserve count" — implies summary head is before preserved window, and compactable is old history before summary head? Actually after first compaction, old history is flagged excluded, so replayable history is [summaryHead, preservedChains, open]. The old compacted range is not in replayable, so not considered.
    // For next compaction, compactable should be [summaryHeadEnd, cut) or [0,cut) including summary? The summary head is replayable and could be re-summarized, but risk is summary-of-summary collapse.
    // The spec for U3 says "Exclude summary head (via U2 marker compacted) from preserve count." No explicit exclusion from compactable, but context-snapshot treats summary head as its own bucket.
    // For cut selection, we should treat compactableRange as [0,cut) as contiguous, including summary head if cut beyond it. That's acceptable; U7 persistence will handle summary re-creation? But to mitigate collapse, later logic may avoid re-summarizing summary head? For U3, we just return cut as computed; caller can decide.
    // For test "summary head not counted", we need to ensure keep count excludes summary head.
    // So compactableRange remains [0,cut) in the single-summary case.
    // To avoid duplicate compaction input when multiple compactions occur, the
    // already-compacted prefix (hidden / excludeFromModel) must not be re-fed
    // to the next summarizer — it would duplicate the same user messages that
    // are already represented inside the prior summary. The previous summary
    // head itself is *not* skipped here: when the window contains only the
    // summary, re-compacting it alone (summary-of-summary) is expected, and
    // when it sits before preserved chains it should be included once so the
    // next handoff can merge old summary + newly-eligible chains.
    let compactableStart = 0;
    while (
      compactableStart < cutCandidate &&
      (messages[compactableStart]?.excludeFromModel || messages[compactableStart]?.hidden)
    ) {
      compactableStart++;
    }
    const compactableRange: CompactableRange = { start: compactableStart, end: cutCandidate };

    // Edge: if cutCandidate === 0, compactable empty
    // If cutCandidate === n, compactable is whole history (preserve empty) — but R6 says open group never compacted, so if open exists cutCandidate <= openStart < n, never n when open exists.

    // For single-chain we already returned. For multi-chain, if cutCandidate === n and keep=0 and no open, compactable is all. That's allowed when budget forces compact all? But R6 preserve window is never compacted, but keep=0 means preserve window is empty (except open). So compacting all but open is okay.

    return {
      cutIndex: cutCandidate,
      compactableRange,
      preservedCount,
      openGroupStart,
      preservedRange: { start: cutCandidate, end: n },
    };
  }

  // Fallback (should not reach): return minimal preserve (open group only)
  const fallbackCut = adjustCutToSafeBoundary(openGroupStart ?? n, completedIntervals, openGroupStart, n);
  const fallbackPreservedCount = realChains.filter((c) => c.end > fallbackCut).length;
  let fallbackStart = 0;
  while (
    fallbackStart < fallbackCut &&
    (messages[fallbackStart]?.excludeFromModel || messages[fallbackStart]?.hidden)
  ) {
    fallbackStart++;
  }
  return {
    cutIndex: fallbackCut,
    compactableRange: { start: fallbackStart, end: fallbackCut },
    preservedCount: fallbackPreservedCount,
    openGroupStart,
    preservedRange: { start: fallbackCut, end: n },
  };
}

// ── Utility for external checks (used by trigger/validator) ─────────────────

/**
 * Whether a given cut index is a clean tool-group boundary (no unresolved
 * tool_calls span it). Mirrors the boundary check in selectCut.
 */
export function isCleanToolGroupBoundary(
  messages: readonly Message[],
  cutIndex: number,
): boolean {
  const { completedIntervals, openGroupStart } = analyzeToolGroups(messages);
  const n = messages.length;
  const adjusted = adjustCutToSafeBoundary(cutIndex, completedIntervals, openGroupStart, n);
  return adjusted === cutIndex;
}
