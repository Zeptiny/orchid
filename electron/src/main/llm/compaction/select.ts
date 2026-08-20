/**
 * Cut-point selection — pure function partitioning replayable history.
 *
 * Requirements R5,R6:
 * - Never leaves a dangling tool_calls block or orphaned tool_result (R5).
 * - Preserve window is a verbatim token-budget suffix (preserve_percent ×
 *   context window, or an absolute preserveTokens), walked from the newest
 *   message backward. The trailing open tool group is always preserved (R6).
 * - Chain boundaries are opportunitically respected (the walk naturally stops
 *   wherever the budget runs out); a single oversized turn no longer forces an
 *   empty preserved window. Summary heads (compacted marker) are re-summarized,
 *   never preserved.
 * - Floor: the most recent complete tool group survives verbatim even when it
 *   alone exceeds the budget (best-effort, bounded by one group).
 *
 * Patterns followed:
 * - Tool-group atomicity in reconcileOrphanToolResults (chain.ts)
 * - Survival pre-pass in history.ts (toApiMessages) for pending tool_calls
 * - Coalescing of consecutive tool-call messages (history.ts)
 */

import type { Message } from '../../../shared/types/message';
import { compactedMarkerFromUnknown, MessageType, MessageRole } from '../../../shared/types/message';
import { estimateMessageChars } from './message-chars';

/** Shared empty set sentinel so `exemptIds` omission allocates nothing. */
const emptySet: Set<string> = new Set();

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
  /** Fraction of contextTokens preserved verbatim (e.g. 0.25). */
  readonly preservePercent?: number;
  /** Direct token ceiling; overrides contextTokens*threshold when present. */
  readonly maxPreserveTokens?: number;
  /** Provider-reported inputTokens to scale char estimate; optional. */
  readonly inputTokens?: number;
}

export interface SelectCutOptions {
  /** Absolute token budget for the verbatim preserved suffix. Preferred form. */
  readonly preserveTokens?: number;
  /** Fraction of contextTokens preserved verbatim; alternative to preserveTokens. */
  readonly preservePercent?: number;
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
  /**
   * R31: message ids exempt from compaction removal. Exempt ids do NOT count
   * against the preserve budget (the walk's estimate filters them out), the
   * compactable range's leading edge skips them, and they may sit anywhere in
   * the preserved window tail. Mid-range exempt ids can still fall inside the
   * compactable range positionally — the apply-side universal settle
   * guarantees they are never flagged. Typically the pinned user-message set
   * from `resolveUserExemptIds`.
   */
  readonly exemptIds?: ReadonlySet<string> | readonly string[];
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

/**
 * Structural marker validation via the shared parser (compactedMarkerFromUnknown):
 * a malformed `compacted` value (boolean, string, partial object) is NOT a
 * summary head. Must stay identical to the check in llm/context-snapshot.ts —
 * both modules validate through the same shared helper.
 */
function hasCompactedMarker(message: Message): boolean {
  return compactedMarkerFromUnknown((message as Message & { compacted?: unknown }).compacted) !== undefined;
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
      continue;
    }
    // A compacted summary head is its own chain (R20), and the content that
    // accrued after it is real history. Without these boundaries a single
    // long turn (one USER message) whose mid-turn compaction planted a head
    // looks like one summary-only chain → realChains empty → re-compaction
    // deadlocks with an empty compactable range even far over the window.
    if (hasCompactedMarker(msg)) {
      if (boundaries[boundaries.length - 1] !== i) boundaries.push(i);
      if (i + 1 < messages.length && boundaries[boundaries.length - 1] !== i + 1) boundaries.push(i + 1);
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
  for (const m of messages) chars += estimateMessageChars(m);
  // Rough 4 chars per token, at least 1 per message
  return Math.max(messages.length, Math.ceil(chars / 4));
}

function resolvePreserveTokens(opts: SelectCutOptions): number | null {
  if (typeof opts.preserveTokens === 'number' && Number.isFinite(opts.preserveTokens)) return opts.preserveTokens;
  if (typeof opts.maxPreserveTokens === 'number' && Number.isFinite(opts.maxPreserveTokens)) return opts.maxPreserveTokens;
  if (opts.budget?.maxPreserveTokens !== undefined && Number.isFinite(opts.budget.maxPreserveTokens)) return opts.budget.maxPreserveTokens;
  const percent = opts.preservePercent ?? opts.budget?.preservePercent;
  const contextTokens = opts.contextTokens ?? opts.budget?.contextTokens;
  if (typeof percent === 'number' && Number.isFinite(percent) && typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0) {
    return Math.max(0, Math.floor(percent * contextTokens));
  }
  // Legacy threshold-derived budget (no preserve knob): threshold * contextTokens
  const threshold = opts.threshold ?? opts.budget?.threshold;
  if (typeof threshold === 'number' && Number.isFinite(threshold) && typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0) {
    return Math.max(0, Math.floor(threshold * contextTokens));
  }
  return null;
}

/**
 * Effective preserve fraction with the hysteresis guard: a preserved window at
 * or above the re-arm line (threshold - delta) would keep the trigger armed
 * forever, so cap preserve_percent below it. Floor keeps a sane minimum.
 */
export function resolvePreservePercent(scope: {
  readonly threshold: number;
  readonly hysteresis_delta?: number;
  readonly preserve_percent: number;
}): number {
  const cap = scope.threshold - (scope.hysteresis_delta ?? 0.1) - 0.05;
  return Math.max(0.05, Math.min(scope.preserve_percent, cap));
}

/**
 * R31/R32/R33: compute the set of user-message ids that compaction must keep
 * in the model view. The result threads through `selectCut` as `exemptIds`
 * (selection-side: the compactable range's leading edge skips them and they
 * never consume the preserve budget) and through `buildCompactionApply`
 * (apply-side: universal un-flag settle, which also covers mid-range ids).
 *
 * Rules:
 * - `keepLast === null` → ALL user messages are exempt (subagent hard
 *   guarantee, R32).
 * - `keepLast` (number) → the last K user messages are exempt (main scope,
 *   R33).
 * - `pinFirst` → the FIRST user message in history is always exempt
 *   regardless of `keepLast` (R33).
 *
 * Hidden/excluded user messages are still counted for positional resolution
 * (a hidden user message occupies a slot in the "last K") but their ids are
 * included — the caller decides via `exemptIds` which is the authoritative
 * set; exempted-but-hidden messages are a no-op downstream.
 */
export function resolveUserExemptIds(
  messages: readonly Message[],
  opts: { keepLast: number | null; pinFirst: boolean },
): Set<string> {
  const exempt = new Set<string>();
  const userIds: string[] = [];
  for (const m of messages) {
    if (m.role === MessageRole.USER) userIds.push(m.id);
  }
  if (opts.pinFirst && userIds.length > 0) {
    exempt.add(userIds[0]!);
  }
  if (opts.keepLast === null) {
    for (const id of userIds) exempt.add(id);
  } else if (opts.keepLast > 0) {
    const start = Math.max(0, userIds.length - opts.keepLast);
    for (let i = start; i < userIds.length; i += 1) {
      exempt.add(userIds[i]!);
    }
  }
  return exempt;
}

/** Start index of the trailing tool group (open if present, else last completed group ending at n-1). */
function trailingGroupFloor(
  completedIntervals: ReadonlyArray<readonly [number, number]>,
  openGroupStart: number | null,
  n: number,
): number | null {
  if (openGroupStart !== null) return openGroupStart;
  for (let i = completedIntervals.length - 1; i >= 0; i -= 1) {
    const [start, end] = completedIntervals[i]!;
    if (end >= n - 1) return start;
  }
  return null;
}

// ── Core: selectCut ─────────────────────────────────────────────────────────

export function selectCut(
  messages: readonly Message[],
  opts: SelectCutOptions,
): CutResult {
  const n = messages.length;

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

  const preserveBudget = resolvePreserveTokens(opts);
  const estimator = opts.tokenEstimator ?? defaultEstimateTokens;

  // R31: exempt ids (pinned user messages) never enter the compactable range
  // and never count against the preserve budget. Normalized to a Set once.
  const exemptSet: Set<string> = opts.exemptIds
    ? (opts.exemptIds instanceof Set ? opts.exemptIds : new Set(opts.exemptIds))
    : emptySet;

  // No preserve budget → nothing is compactable (preserve everything).
  if (preserveBudget === null) {
    return {
      cutIndex: 0,
      compactableRange: { start: 0, end: 0 },
      preservedCount: realChains.length,
      openGroupStart,
      preservedRange: { start: 0, end: n },
    };
  }

  // Token-walk the newest suffix: find the largest suffix whose SLICE estimate
  // fits the preserve budget — the estimator receives the whole slice per its
  // contract, never one message at a time (per-call minimums and ceilings must
  // apply once per slice, not per message). Slice estimates are monotone in
  // suffix length, so a binary search over the cut index needs only O(log n)
  // estimator invocations even for estimators with per-call overhead. The cut
  // lands at the largest suffix that fits, regardless of chain boundaries — a
  // single oversized turn no longer forces an empty preserved window.
  //
  // R31: exempt ids do not consume the preserve budget — the estimator
  // receives the slice with exempt ids filtered out, so the walk budgets only
  // the non-exempt (compactable-eligible) content. The cut index still refers
  // to the original array. An exempt id the walk lands ON is already the first
  // preserved message — the cut stays put (never snapped forward past it).
  const sliceForEstimate = (start: number): Message[] => {
    const slice = messages.slice(start);
    if (exemptSet.size === 0) return slice;
    return slice.filter((m) => !exemptSet.has(m.id));
  };
  const floorCut = trailingGroupFloor(completedIntervals, openGroupStart, n);
  let tokenCut: number;
  {
    let lo = 0;
    let hi = n; // the empty suffix always fits
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (estimator(sliceForEstimate(mid)) > preserveBudget) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    tokenCut = hi;
  }

  // Floor: the trailing open (or most recent completed) tool group is always
  // preserved verbatim — best-effort over budget, bounded by one group.
  if (floorCut !== null && tokenCut > floorCut) tokenCut = floorCut;

  // Adjust to safe boundary (never split a tool group). Snapping backward may
  // exceed the budget slightly; forward snaps are never needed because the
  // walk already stops outside groups that fit.
  let cutCandidate = adjustCutToSafeBoundary(tokenCut, completedIntervals, openGroupStart, n);
  if (floorCut !== null && cutCandidate > floorCut) cutCandidate = floorCut;

  let preservedCount: number;
  if (cutCandidate <= 0) {
    preservedCount = realChains.length;
  } else {
    preservedCount = realChains.filter((c) => c.end > cutCandidate).length;
  }

  // compactableRange is [0, cutCandidate) after skipping the leading messages
  // that can never be compacted away — already-excluded/hidden ones and R31
  // exempt ids (the pinned task head / first user message). The summary head
  // stays in the range so it can be re-summarized with new chains.
  let compactableStart = 0;
  while (
    compactableStart < cutCandidate &&
    (messages[compactableStart]?.excludeFromModel ||
      messages[compactableStart]?.hidden ||
      exemptSet.has(messages[compactableStart]!.id))
  ) {
    compactableStart++;
  }

  return {
    cutIndex: cutCandidate,
    compactableRange: { start: compactableStart, end: cutCandidate },
    preservedCount,
    openGroupStart,
    preservedRange: { start: cutCandidate, end: n },
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
