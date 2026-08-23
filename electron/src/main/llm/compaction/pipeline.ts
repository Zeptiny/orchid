/**
 * Scope-parameterized compaction gate pipeline (R34).
 *
 * One engine owns the gate sequence every compaction fire point shares:
 * calibrate → threshold/hysteresis gate → cut selection (exempt user ids) →
 * mechanical reclaim → trigger evaluation with the reclaim short-circuit.
 * Scope adapters (`host/chat/compaction.ts` for main, `agents/subagent-compaction.ts`
 * for subagents) own everything the gate deliberately does not: summarizer
 * execution, trigger-state mutation, persistence, and widget routing.
 *
 * Serialization economy (review #47): `computeMessageCharCache` measures each
 * message exactly once per evaluation; the total, the compactable-range
 * estimate, and the preserve-window walk estimator all read the cache instead
 * of re-serializing messages per consumer.
 */
import type { Message } from '../../../shared/types/message';
import type { CompactionScopeConfig } from '../../config/schema';
import { estimateMessageChars } from './message-chars';
import { mechanicalReclaim } from './reclaim';
import { resolvePreservePercent, resolveUserExemptIds, selectCut } from './select';
import type { CutResult } from './select';
import { evaluateTriggerWithReclaim } from './trigger';
import type { TriggerState } from './trigger';

export type { CompactableRange } from './select';

// ── Char measurement (single pass per evaluation) ────────────────────────────

/**
 * Per-message char measurement computed once per gate evaluation. `total`
 * carries the same non-zero floor `totalCharsForMessages` applies so
 * tokens-per-char derivation never divides by zero.
 */
export interface MessageCharCache {
  /** `estimateMessageChars` per input message, by position. */
  readonly chars: readonly number[];
  /** Sum of `chars`, floored at 1. */
  readonly total: number;
}

/**
 * Measure every message's serialized char count exactly once. Consumers that
 * need a slice or a range sum from `chars` instead of re-serializing.
 */
export function computeMessageCharCache(messages: readonly Message[]): MessageCharCache {
  const chars: number[] = new Array<number>(messages.length);
  let total = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const measured = estimateMessageChars(messages[i]!);
    chars[i] = measured;
    total += measured;
  }
  return { chars, total: total === 0 ? 1 : total };
}

/**
 * Cached-char slice estimator for `selectCut`'s preserve-window walk. Contract
 * matches the calibrated estimators the call sites used to build inline: the
 * slice-level minimum of one token per message applies once per slice, never
 * per message.
 */
function cachedCharEstimator(
  charsByMessage: ReadonlyMap<Message, number>,
  tokensPerChar: number,
): (slice: readonly Message[]) => number {
  return (slice: readonly Message[]): number => {
    let chars = 0;
    for (const message of slice) chars += charsByMessage.get(message) ?? 0;
    return Math.max(slice.length, Math.ceil(chars * tokensPerChar));
  };
}

// ── Calibration helpers ──────────────────────────────────────────────────────

/**
 * Clamp a raw tokens-per-char ratio into the plausible calibrated band shared
 * by every compaction math site (pathological ratios from tiny histories are
 * bounded instead of trusted).
 */
export function clampTokensPerChar(ratio: number): number {
  return Math.max(0.05, Math.min(ratio, 2));
}

/**
 * Derive a calibrated tokens-per-char ratio from an observed provider-reported
 * input-token count, or null when the observation is unusable. This is the
 * only sanctioned derivation — there is deliberately no heuristic fallback
 * (calibrate-or-skip hard rule: never chars/4).
 */
export function deriveTokensPerChar(
  inputTokens: number | null | undefined,
  totalChars: number,
): number | null {
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0) return null;
  if (!Number.isFinite(totalChars) || totalChars <= 0) return null;
  const ratio = inputTokens / totalChars;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return clampTokensPerChar(ratio);
}

/**
 * Sum cached char measurements for the given message ids. Ids with no matching
 * message contribute zero, mirroring the per-id accumulation the manager
 * previously inlined.
 */
export function charsForMessageIds(messages: readonly Message[], ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const charsById = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (!charsById.has(message.id)) charsById.set(message.id, estimateMessageChars(message));
  }
  let sum = 0;
  for (const id of ids) sum += charsById.get(id) ?? 0;
  return sum;
}

// ── Cut selection helper ─────────────────────────────────────────────────────

/**
 * Structural config slice `calibratedCut` reads. `CompactionScopeConfig` is
 * assignable; degraded call sites (config load failed) may pass the two knobs
 * the cut math strictly needs.
 */
export interface CompactionCutConfig {
  readonly threshold: number;
  readonly hysteresis_delta?: number;
  readonly preserve_percent: number;
  readonly keep_last_user_messages?: number | null;
  readonly pin_first_user_message?: boolean;
}

/**
 * Preserve-budget base for one evaluation: `preserve_percent` scales against
 * CURRENT usage, not the model window — clamped at the window so an
 * over-window estimate cannot inflate the base. Falls back to the window when
 * no current estimate exists (the pre-usage behavior).
 */
export function preserveBaseTokens(
  currentInputTokens: number | null | undefined,
  contextTokens: number,
): number {
  if (
    typeof currentInputTokens === 'number'
    && Number.isFinite(currentInputTokens)
    && currentInputTokens > 0
  ) {
    return Math.min(currentInputTokens, contextTokens);
  }
  return contextTokens;
}

/**
 * Cut selection with a calibrated estimator and the R31/R32/R33 exempt user
 * ids resolved from config — the shared math for fire points that need a cut
 * without the threshold gate (the overflow-retry exhaustion check).
 */
export function calibratedCut(
  messages: readonly Message[],
  opts: {
    readonly config: CompactionCutConfig;
    readonly contextTokens: number;
    readonly tokensPerChar: number;
    /** Current estimated/observed input tokens; preserve scales against this. */
    readonly currentInputTokens?: number | null;
  },
): CutResult {
  const tokensPerChar = clampTokensPerChar(opts.tokensPerChar);
  const cache = computeMessageCharCache(messages);
  const charsByMessage = new Map<Message, number>();
  for (let i = 0; i < messages.length; i += 1) charsByMessage.set(messages[i]!, cache.chars[i]!);
  return selectCut(messages, {
    preserveTokens: Math.floor(
      resolvePreservePercent(opts.config) * preserveBaseTokens(opts.currentInputTokens, opts.contextTokens),
    ),
    tokenEstimator: cachedCharEstimator(charsByMessage, tokensPerChar),
    exemptIds: resolveUserExemptIds(messages, {
      keepLast: opts.config.keep_last_user_messages ?? null,
      pinFirst: opts.config.pin_first_user_message ?? true,
    }),
  });
}

// ── Gate pipeline (R34) ──────────────────────────────────────────────────────

/**
 * Everything the gate needs for one evaluation. `inputTokens` is the observed
 * provider-reported input-token count at this fire point, or null when the
 * fire point only has history (send-time / spawn-time gates estimate instead).
 */
export interface CompactionGateInput {
  /** Replayable history the cut is computed over. */
  readonly messages: readonly Message[];
  /** Resolved scope config slice (`compaction.main` / `compaction.subagents`). */
  readonly config: CompactionScopeConfig;
  /** Identifies the calling adapter; carried for routing and diagnostics. */
  readonly scope: 'main' | 'subagents';
  /** Observed provider-reported input tokens, or null to use the calibrated estimate. */
  readonly inputTokens: number | null;
  /** Calibrated tokens-per-char when the caller already holds one, else null. */
  readonly tokensPerChar: number | null;
  /** Model context window in tokens. */
  readonly contextTokens: number;
  /** Trigger state the hysteresis/pending gates read. Never mutated here. */
  readonly triggerState?: TriggerState;
  /**
   * Explicit user request (`/compact`): bypasses the threshold/hysteresis gate
   * and the `min_compactable_tokens` floor, and never takes the reclaim
   * short-circuit (the user asked for a compaction, so a summarizer/selective
   * run always prepares; reclaim flags still merge into the apply). The
   * uncalibrated gate, the empty-range check, and exempt ids still apply.
   */
  readonly manual?: boolean;
  /** Pre-resolved exempt user ids; defaults to `resolveUserExemptIds` from config. */
  readonly exemptIds?: ReadonlySet<string>;
  /** Pre-computed char cache; defaults to a fresh single pass over `messages`. */
  readonly charCache?: MessageCharCache;
}

/**
 * A gate decision that wants compaction work: `reclaim-only` applies the
 * mechanical-reclaim flags without a summarizer call (R25 short-circuit);
 * `prepare` starts (or arms) the summarizer/selective run.
 */
export interface CompactionGateAction {
  readonly kind: 'reclaim-only' | 'prepare';
  /** Trigger-engine reason string for diagnostics. */
  readonly reason: string;
  /** Selected cut; the compactable range is `[start, end)`. */
  readonly cut: CutResult;
  /** Mechanical-reclaim ids for this evaluation (empty when reclaim is off). */
  readonly flaggedIds: string[];
  /** Calibrated token estimate of the compactable range. */
  readonly compactableTokens: number;
  /** Observed input tokens, or the calibrated estimate when unobserved. */
  readonly estimatedInput: number;
  /** The calibrated tokens-per-char this evaluation used. */
  readonly tokensPerChar: number;
}

/** A gate decision that wants no compaction work at this fire point. */
export interface CompactionGateNoOp {
  readonly kind: 'no-op';
  readonly reason: string;
  /** The calibration this evaluation reached, or null when uncalibrated. */
  readonly tokensPerChar: number | null;
}

export type CompactionGateDecision = CompactionGateAction | CompactionGateNoOp;

const UNARMED_TRIGGER_STATE: TriggerState = { hysteresisArmed: false, pendingPrepare: false };

/**
 * Run the shared gate pipeline: calibration → threshold/hysteresis gate →
 * `selectCut` with exempt user ids → mechanical reclaim →
 * `evaluateTriggerWithReclaim`. Pure with respect to trigger state and
 * history — callers own pending-prepare bookkeeping (checked before invoking),
 * marking prepares, running summarizers, persisting, and emitting progress.
 */
export function runCompactionGate(input: CompactionGateInput): CompactionGateDecision {
  const { messages, config, contextTokens } = input;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    return { kind: 'no-op', reason: 'no-context-window', tokensPerChar: null };
  }
  const state: TriggerState = input.triggerState ?? UNARMED_TRIGGER_STATE;
  const cache = input.charCache ?? computeMessageCharCache(messages);
  const tokensPerChar =
    (typeof input.tokensPerChar === 'number' && Number.isFinite(input.tokensPerChar) && input.tokensPerChar > 0
      ? input.tokensPerChar
      : null) ??
    deriveTokensPerChar(input.inputTokens, cache.total) ??
    deriveTokensPerChar(state.lastObservedInputTokens, cache.total);
  if (tokensPerChar == null) {
    return { kind: 'no-op', reason: 'uncalibrated', tokensPerChar: null };
  }
  const observed =
    typeof input.inputTokens === 'number' && Number.isFinite(input.inputTokens) && input.inputTokens >= 0
      ? input.inputTokens
      : null;
  const estimatedInput = observed ?? Math.ceil(cache.total * tokensPerChar);

  if (!input.manual && estimatedInput < contextTokens) {
    const ratio = estimatedInput / contextTokens;
    if (ratio + 1e-9 < config.threshold) {
      const baseline = state.postCompactionInputTokens;
      const accrues =
        state.hysteresisArmed &&
        typeof baseline === 'number' &&
        Number.isFinite(baseline) &&
        estimatedInput - baseline >= config.min_compactable_tokens;
      if (!accrues) {
        return { kind: 'no-op', reason: 'below-threshold', tokensPerChar };
      }
    }
  }

  const exemptIds =
    input.exemptIds ??
    resolveUserExemptIds(messages, {
      keepLast: config.keep_last_user_messages ?? null,
      pinFirst: config.pin_first_user_message,
    });
  const charsByMessage = new Map<Message, number>();
  for (let i = 0; i < messages.length; i += 1) charsByMessage.set(messages[i]!, cache.chars[i]!);
  const cut = selectCut(messages, {
    preserveTokens: Math.floor(
      resolvePreservePercent(config) * preserveBaseTokens(estimatedInput, contextTokens),
    ),
    tokenEstimator: cachedCharEstimator(charsByMessage, tokensPerChar),
    exemptIds,
  });
  const range = cut.compactableRange;
  if (range.end <= range.start) {
    return { kind: 'no-op', reason: 'empty-compactable-range', tokensPerChar };
  }
  let rangeChars = 0;
  for (let i = range.start; i < range.end; i += 1) rangeChars += cache.chars[i] ?? 0;
  const compactableTokens = Math.ceil(rangeChars * tokensPerChar);
  if (!input.manual && compactableTokens < config.min_compactable_tokens) {
    return { kind: 'no-op', reason: 'below-floor', tokensPerChar };
  }

  let flaggedIds: string[] = [];
  if (config.mechanical_reclaim) {
    flaggedIds = mechanicalReclaim(messages, range).flaggedIds;
  }

  // Manual requests skip the trigger evaluation entirely: threshold and
  // hysteresis were user-supplied intent, the floor does not apply, and the
  // reclaim short-circuit must not answer a compaction request with flags
  // alone. Reclaim flags computed above still merge into the apply.
  if (input.manual) {
    return { kind: 'prepare', reason: 'manual', cut, flaggedIds, compactableTokens, estimatedInput, tokensPerChar };
  }

  const decision = evaluateTriggerWithReclaim({
    inputTokens: estimatedInput,
    contextTokens,
    threshold: config.threshold,
    hysteresisDelta: config.hysteresis_delta,
    compactableTokens,
    minCompactableTokens: config.min_compactable_tokens,
    compactableRange: range,
    messages,
    flaggedIds,
    estimatedInputTokens: observed == null ? estimatedInput : undefined,
    state,
  });
  if (decision.shouldPrepare) {
    return { kind: 'prepare', reason: decision.reason, cut, flaggedIds, compactableTokens, estimatedInput, tokensPerChar };
  }
  if (decision.shouldApply && flaggedIds.length > 0) {
    return { kind: 'reclaim-only', reason: decision.reason, cut, flaggedIds, compactableTokens, estimatedInput, tokensPerChar };
  }
  return { kind: 'no-op', reason: decision.reason, tokensPerChar };
}
