/**
 * Shared selective-compaction attempt runner (#11).
 *
 * One orchestration for the three near-copies that previously lived in
 * ipc/chat/send.ts (send-time synchronous prepare + mid-turn usage prepare)
 * and agents/subagent-runner.ts: slice the compactable range, build the
 * manifest, wire the scope-owned selective LLM caller + simple fallback
 * (model selection and ledger accounting arrive via `deps`), and run the
 * multi-turn selective loop.
 *
 * Callers keep owning persistence: the outcome is the raw selective result
 * (with R9 applied — see below) or a noop reason; scope-specific apply and
 * durable writes stay at the call sites.
 *
 * Unified behavior (intentional, #11):
 *  - R9: selective mode — including its fallback — never flags EXEMPT user
 *    messages. The runner filters the resolved exempt set
 *    (`resolveUserExemptIds` output, threaded via `exemptIds`; omitted →
 *    every user message, the backcompat default) out of the result's
 *    `flaggedIds`. The apply-side settle is owned by `buildCompactionApply` /
 *    `buildSelectiveCompactionApply` (U1/R31, scoped via their `exemptIds`) —
 *    the old per-mode un-flag helpers were removed once both covered their
 *    call sites.
 */

import type { Message } from '../../../shared/types/message';
import { MessageRole } from '../../../shared/types/message';
import type { ModelSelection } from '../../../shared/types/provider';
import type { Config } from '../../config/schema';
import type { ProjectRuntime } from '../../project/runtime';
import type { ProviderAccountingStore } from '../../providers/accounting/store';
import type { CutResult } from './select';
import { buildManifest } from './selective/manifest';
import { createLlmSelectiveCaller, runSelectiveCompaction } from './selective/run';
import type { SelectiveCompactionResult, SimpleFallback } from './selective/run';
import { buildCompactionBridgeContext, summarizeCompactableRange } from './summarize';

/** Ledger + identity context the selective/summarizer attempts attribute to. */
export interface CompactionAttemptAccounting {
  readonly store?: ProviderAccountingStore;
  readonly sessionId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
}

export interface CompactionAttemptDeps {
  /** Current turn/run model selection — last-resort fallback for the compactor model. */
  readonly fallbackSelection: ModelSelection | null;
  /** Ledger attribution for the selective caller and simple-fallback attempts. */
  readonly accounting: CompactionAttemptAccounting;
  /** Project runtime for compactor-agent lookup (main scope). */
  readonly runtime?: ProjectRuntime;
  /** Subagent id (subagents scope) — propagated as agentScope. */
  readonly subagentId?: string;
  /**
   * Fires synchronously once the noop gates pass, right before the LLM run
   * starts — the main scope marks its trigger prepare here.
   */
  readonly onPrepared?: () => void;
  /**
   * Live progress observer for the compactor's LLM output — selective ops
   * (raw JSON) in selective mode, summary text on the simple fallback.
   */
  readonly onTextDelta?: (accumulatedText: string) => void;
}

export interface CompactionAttemptInput {
  readonly messages: readonly Message[];
  readonly cut: CutResult;
  /** Compaction scope — selects the compactor agent and its config section. */
  readonly scope: 'main' | 'subagents';
  readonly config: Config;
  readonly deps: CompactionAttemptDeps;
  readonly maxCorrectionRounds?: number;
  /**
   * Scoped exempt user ids (`resolveUserExemptIds` output): R9 filters only
   * these user ids out of the result's flaggedIds. Omitted → every user
   * message is filtered (backcompat default).
   */
  readonly exemptIds?: ReadonlySet<string> | readonly string[];
}

export type CompactionAttemptOutcome =
  | { readonly kind: 'noop'; readonly reason: 'empty-slice' | 'empty-manifest' }
  | { readonly kind: 'ran'; readonly result: SelectiveCompactionResult };

/** Model-visible slice of the compactable range (excluded/hidden messages drop out). */
export function compactableModelSlice(
  messages: readonly Message[],
  range: { start: number; end: number },
): Message[] {
  return messages
    .slice(range.start, range.end)
    .filter((m) => !m.excludeFromModel && !m.hidden);
}

/** R9: ids of EXEMPT user messages, which selective mode never excludes from the model view. */
function exemptUserIdsIn(
  messages: readonly Message[],
  exemptIds?: ReadonlySet<string> | readonly string[],
): Set<string> {
  const exempt = exemptIds ? (exemptIds instanceof Set ? exemptIds : new Set(exemptIds)) : null;
  const userIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== MessageRole.USER) continue;
    if (!exempt || exempt.has(m.id)) userIds.add(m.id);
  }
  return userIds;
}

/** R9: drop exempt-user ids from a flagged set (selective mode, including its fallback). */
function filterUserFlaggedIds(
  messages: readonly Message[],
  flaggedIds: readonly string[],
  exemptIds?: ReadonlySet<string> | readonly string[],
): string[] {
  const userIds = exemptUserIdsIn(messages, exemptIds);
  return flaggedIds.filter((id) => !userIds.has(id));
}

/** Apply the R9 never-flag-exempt-user invariant to a selective run result in place of the caller. */
function applyR9ToResult(
  messages: readonly Message[],
  result: SelectiveCompactionResult,
  exemptIds?: ReadonlySet<string> | readonly string[],
): SelectiveCompactionResult {
  if (result.flaggedIds && result.flaggedIds.length > 0) {
    return { ...result, flaggedIds: filterUserFlaggedIds(messages, result.flaggedIds, exemptIds) };
  }
  return result;
}

/**
 * Run one selective-compaction attempt (manifest → LLM caller → multi-turn
 * loop with simple fallback). Rejections propagate to the caller — the
 * prepare/apply sites each own their non-fatal handling. Returns `noop` when
 * there is nothing model-visible to compact.
 */
export async function runCompactionAttempt(
  input: CompactionAttemptInput,
): Promise<CompactionAttemptOutcome> {
  const { messages, cut, scope, config, deps } = input;
  const slice = compactableModelSlice(messages, cut.compactableRange);
  if (slice.length === 0) return { kind: 'noop', reason: 'empty-slice' };
  const manifest = buildManifest(messages, cut.compactableRange);
  if (manifest.entries.length === 0) return { kind: 'noop', reason: 'empty-manifest' };
  // Bridge context (trailing preserve-window excerpt) shared by the selective
  // caller and the simple fallback so the handoff is oriented toward what the
  // next turn already has instead of restating it.
  const bridgeContext = buildCompactionBridgeContext(messages, cut.compactableRange);
  const selectiveCaller = createLlmSelectiveCaller({
    config,
    scope,
    fallbackSelection: deps.fallbackSelection,
    ...(deps.runtime ? { runtime: deps.runtime } : {}),
    ...(deps.subagentId !== undefined ? { subagentId: deps.subagentId } : {}),
    accounting: deps.accounting,
    ...(deps.onTextDelta ? { onTextDelta: deps.onTextDelta } : {}),
    ...(bridgeContext ? { bridgeContext } : {}),
  });
  const simpleFallback: SimpleFallback = async () => {
    const result = await summarizeCompactableRange({
      messages: slice,
      scope,
      config,
      fallbackSelection: deps.fallbackSelection,
      existingModelSelection: deps.fallbackSelection,
      accounting: deps.accounting,
      ...(deps.runtime ? { runtime: deps.runtime } : {}),
      ...(deps.subagentId !== undefined ? { subagentId: deps.subagentId } : {}),
      ...(deps.onTextDelta ? { onTextDelta: deps.onTextDelta } : {}),
      ...(bridgeContext ? { bridgeContext } : {}),
    });
    if (!result || !result.text || !result.text.trim()) return null;
    return { text: result.text };
  };
  deps.onPrepared?.();
  const result = await runSelectiveCompaction({
    messages,
    compactableRange: cut.compactableRange,
    manifest,
    selectiveCaller,
    simpleFallback,
    ...(input.maxCorrectionRounds !== undefined ? { maxCorrectionRounds: input.maxCorrectionRounds } : {}),
  });
  return { kind: 'ran', result: applyR9ToResult(messages, result, input.exemptIds) };
}
