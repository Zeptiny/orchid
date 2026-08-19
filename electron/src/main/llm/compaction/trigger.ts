/**
 * Prepare/apply trigger engine — threshold detection, hysteresis, min-range floor,
 * two-phase prepare/apply, and calibrated pre-flight estimates.
 *
 * Requirements: R11,R12,R13,R14,R25. Dependencies U1,U3,U4,U5.
 *
 * Design:
 * - Pure helpers reuse the calibrated snapshot estimator (char measurement scaled
 *   by observed tokens-per-char, never a tokenizer).
 * - Hysteresis: after a compaction suppress re-fire until usage falls below
 *   threshold - hysteresisDelta and re-crosses, OR min_compactable_tokens of new
 *   content accrues since the compaction (R13 alternative path).
 * - Two-phase: prepare may start mid-step (canStartPrepare); apply is deferred
 *   to the next safe boundary (shouldApplyAtBoundary). R12.
 * - Floor (R14): compactableTokens < minCompactableTokens => no fire.
 * - Reclaim short-circuit (R25): run mechanical reclaim first; if post-reclaim
 *   estimate falls below the re-arm line the summarizer is skipped.
 */

import type { Message } from '../../../shared/types/message';
import {
  estimatePostReclaimInputTokens,
  estimateReclaimedTokens,
  isBelowRearmLine,
} from './reclaim';
import { estimateMessageChars, totalCharsForMessages } from './message-chars';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CompactableRange {
  readonly start: number;
  readonly end: number;
}

export interface TriggerDecision {
  readonly shouldPrepare: boolean;
  readonly shouldApply: boolean;
  readonly reason: string;
  readonly compactableRange?: CompactableRange;
  readonly flaggedIds?: string[];
  readonly estimatedInputTokens?: number;
}

export interface TriggerState {
  /** True = compaction just fired; suppress re-fire until re-armed. */
  hysteresisArmed: boolean;
  /** Input tokens observed at the point of last compaction (pre-compaction). */
  lastCompactionInputTokens?: number;
  /** Post-compaction input tokens (if known) — used for accrual alternative. */
  postCompactionInputTokens?: number;
  /** Last observed provider-reported input_tokens. */
  lastObservedInputTokens?: number;
  /** Whether a prepare (summarizer) is currently in-flight. */
  pendingPrepare: boolean;
  /** Pending compactable range for the in-flight prepare. */
  pendingRange?: CompactableRange;
  /** Pending flaggedIds from reclaim (if any). */
  pendingFlaggedIds?: string[];
  /** Calibrated tokens-per-char from the last snapshot (inputTokens/totalChars). */
  tokensPerChar?: number;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Derive calibrated tokens-per-char from provider-reported inputTokens and replay char count. */
export function computeTokensPerChar(
  inputTokens: number,
  messages: readonly Message[],
): number | undefined {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
  const chars = totalCharsForMessages(messages);
  if (chars <= 0) return undefined;
  const ratio = inputTokens / chars;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  // Clamp to plausible range to avoid pathological blow-ups from tiny histories.
  return Math.max(0.05, Math.min(ratio, 2));
}

/**
 * Advisory pre-flight estimate: lastReported + char-estimated tail scaled by a
 * CALIBRATED tokens-per-char ratio. Never uses a heuristic ratio — when no
 * calibration exists the pending tail is not estimated and only the reported
 * base is returned (hard rule: no chars/4 estimation, ever).
 */
export function estimateNextInputTokens(
  lastReportedInputTokens: number | undefined | null,
  pendingMessages: readonly Message[],
  tokensPerChar?: number | null,
): number {
  const base = typeof lastReportedInputTokens === 'number' && Number.isFinite(lastReportedInputTokens)
    ? Math.max(0, lastReportedInputTokens)
    : 0;
  if (!pendingMessages || pendingMessages.length === 0) return base;
  if (typeof tokensPerChar !== 'number' || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) {
    return base;
  }
  let chars = 0;
  for (const m of pendingMessages) chars += estimateMessageChars(m);
  const pendingTokens = Math.ceil(chars * tokensPerChar);
  return base + pendingTokens;
}

/**
 * Core threshold + hysteresis + floor check.
 *
 * Returns true only when all gates pass:
 *  - contextTokens > 0
 *  - inputTokens / contextTokens >= threshold
 *  - hysteresis not armed (or accrual alternative satisfied — caller may override)
 *  - compactableTokens >= minCompactableTokens
 */
export function shouldTriggerCompaction(opts: {
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly threshold: number;
  readonly hysteresisArmed?: boolean;
  readonly compactableTokens: number;
  readonly minCompactableTokens: number;
  readonly lastCompactionInputTokens?: number;
  readonly postCompactionInputTokens?: number;
}): boolean {
  const {
    inputTokens,
    contextTokens,
    threshold,
    hysteresisArmed = false,
    compactableTokens,
    minCompactableTokens,
  } = opts;

  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return false;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return false;
  if (!Number.isFinite(threshold) || threshold <= 0) return false;

  // Floor (R14)
  if (compactableTokens < minCompactableTokens) return false;

  // Threshold crossing (R11) — ratio check
  const ratio = inputTokens / contextTokens;
  if (ratio + 1e-9 < threshold) return false;

  if (inputTokens >= contextTokens) {
    return true;
  }

  // Hysteresis (R13): if armed, suppress unless accrual alternative satisfied
  // Baseline is post-compaction inputTokens (growth since drop), falling back to lastCompaction for old state.
  if (hysteresisArmed) {
    const baseline = (typeof opts.postCompactionInputTokens === 'number' && Number.isFinite(opts.postCompactionInputTokens)
      ? opts.postCompactionInputTokens
      : opts.lastCompactionInputTokens);
    if (typeof baseline === 'number' && Number.isFinite(baseline)) {
      const accrued = inputTokens - baseline;
      if (accrued >= minCompactableTokens) {
        // Accrual alternative re-arms even while still above threshold
        return true;
      }
    }
    return false;
  }

  return true;
}

/**
 * Update hysteresis armed flag after observing a usage event (R13).
 *
 * After a compaction we arm. We stay armed until usage falls below
 * threshold - delta (re-arm line) OR enough new content accrues (>= minCompactableTokens
 * beyond the post-compaction baseline). This function implements the drop-check;
 * the accrual-check is handled inside shouldTriggerCompaction for the next fire.
 * It returns the next armed boolean and the updated state snapshot.
 */
export function nextHysteresisArmed(
  prevArmed: boolean,
  inputTokens: number,
  contextTokens: number,
  threshold: number,
  hysteresisDelta = 0.1,
): boolean {
  if (!prevArmed) return false;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return prevArmed;
  const rearmLine = (threshold - hysteresisDelta) * contextTokens;
  if (inputTokens + 1e-9 < rearmLine) return false;
  return true;
}

export function updateTriggerStateOnUsage(
  state: TriggerState,
  inputTokens: number,
  contextTokens: number,
  threshold: number,
  hysteresisDelta = 0.1,
): TriggerState {
  const nextArmed = nextHysteresisArmed(state.hysteresisArmed, inputTokens, contextTokens, threshold, hysteresisDelta);
  return {
    ...state,
    hysteresisArmed: nextArmed,
    lastObservedInputTokens: inputTokens,
  };
}

export function markCompactionApplied(
  state: TriggerState,
  compactionInputTokens: number,
  postCompactionInputTokens?: number,
): TriggerState {
  return {
    ...state,
    hysteresisArmed: true,
    lastCompactionInputTokens: compactionInputTokens,
    postCompactionInputTokens: typeof postCompactionInputTokens === 'number' ? postCompactionInputTokens : undefined,
    pendingPrepare: false,
    pendingRange: undefined,
    pendingFlaggedIds: undefined,
  };
}

// ── Prepare / Apply split (R12, R25) ───────────────────────────────────────

/** Whether a prepare (summarizer LLM call) may start mid-step. */
export function canStartPrepare(
  state: TriggerState,
  params: {
    readonly inputTokens?: number;
    readonly estimatedInputTokens?: number;
    readonly contextTokens: number;
    readonly threshold: number;
    /** Accepted for caller-shape parity (evaluatePrepare passes it through); intentionally not read — the drop-check uses state.hysteresisArmed. */
    readonly hysteresisDelta?: number;
    readonly compactableTokens: number;
    readonly minCompactableTokens: number;
    readonly compactableRange?: CompactableRange;
    readonly lastCompactionInputTokens?: number;
    readonly postCompactionInputTokens?: number;
  },
): { shouldPrepare: boolean; reason: string } {
  if (state.pendingPrepare) {
    return { shouldPrepare: false, reason: 'prepare-already-pending' };
  }
  // Floor checked first — cheapest gate
  if (params.compactableTokens < params.minCompactableTokens) {
    return { shouldPrepare: false, reason: 'below-floor' };
  }
  // If hysteresis armed, only accrual can override — delegate to shouldTrigger threshold logic
  const inputForThreshold = typeof params.estimatedInputTokens === 'number' ? params.estimatedInputTokens : params.inputTokens;
  if (typeof inputForThreshold !== 'number' || !Number.isFinite(inputForThreshold)) {
    return { shouldPrepare: false, reason: 'no-input-estimate' };
  }
  const hysteresisArmed = state.hysteresisArmed;
  const lastCompaction = params.lastCompactionInputTokens ?? state.lastCompactionInputTokens;
  const postCompaction = params.postCompactionInputTokens ?? state.postCompactionInputTokens;
  const canFire = shouldTriggerCompaction({
    inputTokens: inputForThreshold,
    contextTokens: params.contextTokens,
    threshold: params.threshold,
    hysteresisArmed,
    compactableTokens: params.compactableTokens,
    minCompactableTokens: params.minCompactableTokens,
    lastCompactionInputTokens: lastCompaction,
    postCompactionInputTokens: postCompaction,
  });
  if (!canFire) {
    // Distinguish hysteresis vs threshold for diagnostics
    if (hysteresisArmed) {
      const accrualBaseline = typeof postCompaction === 'number' ? postCompaction : lastCompaction;
      const accruesEnough = typeof accrualBaseline === 'number'
        ? inputForThreshold - accrualBaseline >= params.minCompactableTokens
        : false;
      if (!accruesEnough) return { shouldPrepare: false, reason: 'hysteresis-armed' };
    }
    const ratio = inputForThreshold / params.contextTokens;
    if (ratio + 1e-9 < params.threshold) return { shouldPrepare: false, reason: 'below-threshold' };
    return { shouldPrepare: false, reason: 'suppressed' };
  }
  return { shouldPrepare: true, reason: 'crossed-threshold' };
}

/**
 * Whether the compaction should apply (mutate replay) at the safe boundary (R12).
 *
 * `threshold`, `hysteresisDelta`, `compactableRange`,
 * `lastCompactionInputTokens`, and `postCompactionInputTokens` are accepted
 * for caller-shape parity (tests and manager.ts callers pass them) but are
 * intentionally ignored: the boundary apply depends only on `pendingPrepare`
 * and the compactable floor, since threshold/hysteresis were already gated
 * when the prepare started — a stale prepare still applies.
 */
export function shouldApplyAtBoundary(
  state: TriggerState,
  params: {
    readonly inputTokens: number;
    readonly contextTokens: number;
    readonly threshold: number;
    readonly hysteresisDelta?: number;
    readonly compactableTokens: number;
    readonly minCompactableTokens: number;
    readonly hasPendingPrepare: boolean;
    readonly compactableRange?: CompactableRange;
    readonly lastCompactionInputTokens?: number;
    readonly postCompactionInputTokens?: number;
  },
): { shouldApply: boolean; reason: string } {
  if (!params.hasPendingPrepare && !state.pendingPrepare) {
    return { shouldApply: false, reason: 'no-pending-prepare' };
  }
  if (params.compactableTokens < params.minCompactableTokens) {
    return { shouldApply: false, reason: 'below-floor-at-boundary' };
  }
  // Boundary apply depends only on pendingPrepare and floor; hysteresis/threshold
  // was already gated when the prepare started, so a stale prepare still applies.
  return { shouldApply: true, reason: 'boundary-apply' };
}

// ── Full trigger evaluation (convenience) ───────────────────────────────────

/**
 * Evaluate a trigger decision including reclaim short-circuit (R25).
 *
 * Runs the mechanical reclaim estimate: if post-reclaim usage falls below the
 * re-arm line, the summarizer is skipped (reclaim-only). Caller supplies
 * `flaggedIds` from mechanicalReclaim over the compactable range; we compute
 * whether summarizer should be skipped and shape the decision accordingly.
 *
 * When `flaggedIds` is non-empty and skip is true, decision is:
 *   shouldPrepare=false, shouldApply=true (reclaim-only), flaggedIds set.
 * Otherwise when threshold/hysteresis/floor all pass:
 *   shouldPrepare=true, shouldApply=false (apply later at boundary).
 */
export function evaluateTriggerWithReclaim(params: {
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly threshold: number;
  readonly hysteresisDelta?: number;
  readonly compactableTokens: number;
  readonly minCompactableTokens: number;
  readonly compactableRange?: CompactableRange;
  readonly messages: readonly Message[];
  readonly flaggedIds: readonly string[];
  readonly estimatedInputTokens?: number;
  readonly state?: TriggerState;
}): TriggerDecision {
  const {
    inputTokens,
    contextTokens,
    threshold,
    hysteresisDelta = 0.1,
    compactableTokens,
    minCompactableTokens,
    compactableRange,
    messages,
    flaggedIds,
  } = params;
  const effectiveInput = typeof params.estimatedInputTokens === 'number' ? params.estimatedInputTokens : inputTokens;

  // Fast reject on floor / threshold before reclaim math
  if (compactableTokens < minCompactableTokens) {
    return { shouldPrepare: false, shouldApply: false, reason: 'below-floor' };
  }
  const ratio = effectiveInput / contextTokens;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0 || ratio + 1e-9 < threshold) {
    return { shouldPrepare: false, shouldApply: false, reason: 'below-threshold' };
  }

  // Shared reclaim evaluation + decision shaping (R25): computes the
  // post-reclaim estimate (reported and advisory-estimate variants) and emits
  // the reclaim-short-circuit or prepare decision. Used by both the
  // over-window fast path and the below-window path after hysteresis.
  const reclaimDecision = (): TriggerDecision => {
    const postReclaim = estimatePostReclaimInputTokens(inputTokens, messages, flaggedIds);
    const belowRearm = isBelowRearmLine(postReclaim, contextTokens, threshold, hysteresisDelta);
    const estimatedPostReclaim = flaggedIds.length > 0 && typeof params.estimatedInputTokens === 'number'
      ? Math.max(0, params.estimatedInputTokens - estimateReclaimedTokens(inputTokens, messages, flaggedIds))
      : postReclaim;
    const estimatedBelowRearm = typeof params.estimatedInputTokens === 'number'
      ? isBelowRearmLine(estimatedPostReclaim, contextTokens, threshold, hysteresisDelta)
      : belowRearm;
    const reclaimedForDecision = flaggedIds.length > 0 ? flaggedIds.slice() : undefined;
    // If reclaim alone drops usage below re-arm, do reclaim-only apply (no summarizer call)
    if (flaggedIds.length > 0 && (belowRearm || estimatedBelowRearm)) {
      return {
        shouldPrepare: false,
        shouldApply: true,
        reason: 'reclaim-short-circuit',
        ...(compactableRange ? { compactableRange } : {}),
        ...(reclaimedForDecision ? { flaggedIds: [...reclaimedForDecision] } : {}),
        estimatedInputTokens: effectiveInput,
      };
    }
    // Otherwise, start prepare (summarizer) — apply deferred to boundary
    return {
      shouldPrepare: true,
      shouldApply: false,
      reason: 'prepare',
      ...(compactableRange ? { compactableRange } : {}),
      ...(reclaimedForDecision ? { flaggedIds: [...reclaimedForDecision] } : {}),
      estimatedInputTokens: effectiveInput,
    };
  };

  const isOverWindow = effectiveInput >= contextTokens || inputTokens >= contextTokens;
  if (isOverWindow) {
    return reclaimDecision();
  }
  if (params.state?.hysteresisArmed) {
    const baseline = (typeof params.state.postCompactionInputTokens === 'number' && Number.isFinite(params.state.postCompactionInputTokens)
      ? params.state.postCompactionInputTokens
      : params.state.lastCompactionInputTokens);
    const accruesEnough = typeof baseline === 'number' && Number.isFinite(baseline)
      ? effectiveInput - baseline >= minCompactableTokens
      : false;
    if (!accruesEnough) {
      return { shouldPrepare: false, shouldApply: false, reason: 'hysteresis-armed' };
    }
  }

  return reclaimDecision();
}

// ── Stateful trigger engine class ───────────────────────────────────────────

export class CompactionTrigger {
  state: TriggerState;

  constructor(initial?: Partial<TriggerState>) {
    this.state = {
      hysteresisArmed: initial?.hysteresisArmed ?? false,
      lastCompactionInputTokens: initial?.lastCompactionInputTokens,
      postCompactionInputTokens: initial?.postCompactionInputTokens,
      lastObservedInputTokens: initial?.lastObservedInputTokens,
      pendingPrepare: initial?.pendingPrepare ?? false,
      pendingRange: initial?.pendingRange,
      pendingFlaggedIds: initial?.pendingFlaggedIds,
      tokensPerChar: initial?.tokensPerChar,
    };
  }

  /** Update calibrated tokensPerChar from a newly observed provider usage + replay snapshot. */
  observeUsage(inputTokens: number, messages: readonly Message[]): void {
    const ratio = computeTokensPerChar(inputTokens, messages);
    if (typeof ratio === 'number') this.state.tokensPerChar = ratio;
    this.state.lastObservedInputTokens = inputTokens;
  }

  /** Calibrated estimate for pending messages before the next request. */
  estimatePreFlight(pendingMessages: readonly Message[]): number {
    const last = this.state.lastObservedInputTokens;
    return estimateNextInputTokens(last, pendingMessages, this.state.tokensPerChar);
  }

  /** Called after each streamed usage event to update hysteresis gating. */
  onUsage(inputTokens: number, contextTokens: number, threshold: number, hysteresisDelta = 0.1): void {
    this.state = updateTriggerStateOnUsage(this.state, inputTokens, contextTokens, threshold, hysteresisDelta);
    this.state.lastObservedInputTokens = inputTokens;
  }

  /** Arm hysteresis after a compaction completes at inputTokens, optionally with postCompaction value. */
  onCompactionApplied(compactionInputTokens: number, postCompactionInputTokens?: number): void {
    this.state = markCompactionApplied(this.state, compactionInputTokens, postCompactionInputTokens);
  }

  /** Convenience: evaluate whether a prepare should start (advisory estimate or confirmed usage). */
  evaluatePrepare(params: {
    readonly inputTokens?: number;
    readonly estimatedInputTokens?: number;
    readonly contextTokens: number;
    readonly threshold: number;
    readonly hysteresisDelta?: number;
    readonly compactableTokens: number;
    readonly minCompactableTokens: number;
    readonly compactableRange?: CompactableRange;
  }): { shouldPrepare: boolean; reason: string } {
    const last = params.inputTokens ?? this.state.lastObservedInputTokens;
    const est = params.estimatedInputTokens;
    const effective: typeof params & { lastCompactionInputTokens?: number; postCompactionInputTokens?: number } = {
      ...params,
      inputTokens: typeof est === 'number' ? est : last,
    };
    // canStartPrepare expects hysteresis from state; also handle accrual baseline
    return canStartPrepare(this.state, {
      inputTokens: effective.inputTokens,
      estimatedInputTokens: est,
      contextTokens: params.contextTokens,
      threshold: params.threshold,
      hysteresisDelta: params.hysteresisDelta,
      compactableTokens: params.compactableTokens,
      minCompactableTokens: params.minCompactableTokens,
      compactableRange: params.compactableRange,
      lastCompactionInputTokens: this.state.lastCompactionInputTokens,
      postCompactionInputTokens: this.state.postCompactionInputTokens,
    });
  }

  /** Mark a prepare as in-flight (call when canStartPrepare returned true and summarizer started). */
  markPrepareStarted(range?: CompactableRange, flaggedIds?: string[]): void {
    this.state.pendingPrepare = true;
    if (range) this.state.pendingRange = range;
    if (flaggedIds) this.state.pendingFlaggedIds = [...flaggedIds];
  }

  /** Abort/clear a pending prepare without applying. */
  abortPrepare(): void {
    this.state.pendingPrepare = false;
    this.state.pendingRange = undefined;
    this.state.pendingFlaggedIds = undefined;
  }

  /** Whether apply should run at the next safe boundary. */
  evaluateApply(params: {
    readonly inputTokens: number;
    readonly contextTokens: number;
    readonly threshold: number;
    readonly hysteresisDelta?: number;
    readonly compactableTokens: number;
    readonly minCompactableTokens: number;
    readonly compactableRange?: CompactableRange;
  }): { shouldApply: boolean; reason: string } {
    return shouldApplyAtBoundary(this.state, {
      ...params,
      hasPendingPrepare: this.state.pendingPrepare,
    });
  }

  /** Consume the pending prepare (call after apply). */
  consumePending(): { range?: CompactableRange; flaggedIds?: string[] } {
    const out = { range: this.state.pendingRange, flaggedIds: this.state.pendingFlaggedIds };
    this.state.pendingPrepare = false;
    this.state.pendingRange = undefined;
    this.state.pendingFlaggedIds = undefined;
    return out;
  }

  /** Full decision including reclaim short-circuit. */
  evaluateWithReclaim(params: {
    readonly inputTokens: number;
    readonly contextTokens: number;
    readonly threshold: number;
    readonly hysteresisDelta?: number;
    readonly compactableTokens: number;
    readonly minCompactableTokens: number;
    readonly compactableRange?: CompactableRange;
    readonly messages: readonly Message[];
    readonly flaggedIds: readonly string[];
    readonly estimatedInputTokens?: number;
  }): TriggerDecision {
    return evaluateTriggerWithReclaim({ ...params, state: this.state });
  }
}

// Re-export helpers for callers that import from trigger
export { estimateReclaimedTokens, estimatePostReclaimInputTokens, isBelowRearmLine };
export { totalCharsForMessages as estimateTotalChars };
