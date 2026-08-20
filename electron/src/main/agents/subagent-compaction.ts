/**
 * Subagent mid-run compaction (U9) — helpers shared by SubagentManager's run
 * loop and the stream runner.
 *
 * These live in a dedicated module (not subagent-runner.ts) so the manager can
 * import them statically without forming a runtime dependency cycle:
 * manager -> subagent-runner -> tools/index -> manager. Nothing here may
 * import from ../tools or ./manager at runtime.
 */
import type { CompactionMode, Message } from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import type { Config } from '../config/schema';
import type { Chain } from '../../shared/types/chain';
import { buildCompactionApply, type ApplyResult } from '../llm/compaction/apply';
import type { TriggerState } from '../llm/compaction/trigger';
import type { CompactionAttemptOutcome } from '../llm/compaction/run-attempt';
import { estimateMessageChars } from '../llm/compaction/message-chars';
import type { CutResult } from '../llm/compaction/select';
import type { SelectiveCompactionResult } from '../llm/compaction/selective/run';
import { getProviderRuntime } from '../providers';

/** Subagent mid-run compaction (U9): partial-report helper for R17. */
export interface SubagentPartialReportInput {
  readonly done: string;
  readonly remaining: string;
  readonly stoppedAt: string;
}

/**
 * Build a structured partial report returned to the parent as a normal tool
 * result when the run still exceeds the window after compaction (R17).
 *
 * The parent sees this as `record.result` inside the wait_for_subagent XML;
 * it is not a hard failure.
 */
export function buildSubagentPartialReport(input: SubagentPartialReportInput): string {
  const done = input.done?.trim() || '(no completed steps reported)';
  const remaining = input.remaining?.trim() || '(unknown remaining work)';
  const stoppedAt = input.stoppedAt?.trim() || 'unknown step';
  return [
    '[Subagent partial report — context window limit reached after compaction]',
    '',
    'Done:',
    done,
    '',
    'Remaining:',
    remaining,
    '',
    `Stopped at: ${stoppedAt}`,
    '',
    'Note: The subagent stopped early because the context window was still exceeded after compaction. This is a partial result returned as a normal tool result to the parent.',
  ].join('\n');
}

/**
 * Resolve a subagent run's own model limits (contextTokens) via the frozen
 * selection's trusted provider execution (R16). Returns null when the catalog
 * has no limits or the selection is unusable — caller falls back to no-op.
 */
export async function resolveSubagentContextTokens(
  selection: ModelSelection | null,
): Promise<number | null> {
  if (!selection) return null;
  try {
    const execution = await getProviderRuntime().resolveExecution(selection);
    const tokens = execution.model.limits?.contextTokens;
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null;
  } catch {
    return null;
  }
}

/**
 * Materialize a SUCCESSFUL selective-compaction run for a subagent chain (R3).
 *
 * The selective loop decides which messages leave the MODEL view; persistence
 * must never delete them from the transcript. Adopting the materialized
 * replay (`replayMessages`) wholesale would hard-delete every summarized
 * original — inside summarize/drop/keep_range spans they exist only as
 * `flaggedIds`, never in the replay. Instead this routes the result through
 * buildCompactionApply (the same never-delete helper the simple and fallback
 * paths use): every original message is kept, the covered ids
 * (summarized/dropped/ranged-kept + mechanical reclaim) get
 * excludeFromModel:true, and one summary head carrying the compacted marker
 * (mode 'selective') is inserted at the cut.
 *
 * buildCompactionApply flags the ENTIRE compactable range, so afterwards this
 * settles the flags: ids the selective pass kept verbatim become visible
 * again, and user messages are never flagged (R9 — the same protection the
 * fallback path applies). Pre-existing flags from EARLIER compactions survive
 * everywhere except user messages — those messages are already out of the
 * model view and un-flagging them would resurrect summarized content. Inside
 * the covered range they beat the un-flag rule; outside it they are untouched.
 */
export function buildSelectiveSubagentApply(params: {
  readonly messages: readonly Message[];
  readonly chains: readonly Chain[];
  readonly cutResult: CutResult;
  readonly selectiveResult: Extract<SelectiveCompactionResult, { kind: 'selective' }>;
  /** Mechanical-reclaim ids from this run's pre-pass; merged with the selective flags. */
  readonly reclaimedIds?: readonly string[];
  readonly sessionId?: string;
}): ApplyResult | null {
  const { messages, chains, cutResult, selectiveResult } = params;

  // R9: user messages are never excluded from the model view.
  const userIds = new Set(messages.filter((m) => m.role === 'user').map((m) => m.id));
  const mergedFlagged = [...new Set([...selectiveResult.flaggedIds, ...(params.reclaimedIds ?? [])])]
    .filter((id) => !userIds.has(id));

  // Compose the per-op summaries into one summary head — the same plain-text
  // shape the simple path passes to buildCompactionApply.
  const summaryParts = selectiveResult.summaryMessages.length > 0
    ? selectiveResult.summaryMessages.map((m) => m.content)
    : (selectiveResult.summaryMessage ? [selectiveResult.summaryMessage.content] : []);
  const summaryText = summaryParts.join('\n\n---\n\n').trim();
  if (mergedFlagged.length === 0 && summaryText.length === 0) return null;

  let applyResult: ApplyResult;
  try {
    applyResult = buildCompactionApply({
      messages: [...messages],
      chains,
      cutResult,
      summaryText: summaryText.length > 0 ? summaryText : null,
      mode: 'selective',
      reclaimedIds: mergedFlagged,
      sessionId: params.sessionId,
    });
  } catch {
    // e.g. range already flagged by an earlier compaction — mirror the simple
    // path's failure mode (no-op) rather than risk the transcript.
    return null;
  }
  if (!applyResult.didApply) return null;

  // Settle flags: reset excludeFromModel on covered ids that selective kept
  // verbatim (and on user messages) so the model view matches the selective
  // decision while the transcript keeps every original.
  const n = messages.length;
  const start = Math.max(0, Math.min(cutResult.compactableRange.start, n));
  const end = Math.max(start, Math.min(cutResult.compactableRange.end, n));
  const coveredIds = new Set<string>(mergedFlagged);
  // Messages already excludeFromModel BEFORE this compaction (flagged by an
  // earlier one) — settle must keep them excluded; see the settle rule below.
  const preExcludedIds = new Set<string>();
  for (let i = start; i < end; i += 1) {
    const m = messages[i];
    if (!m) continue;
    coveredIds.add(m.id);
    if (m.excludeFromModel) preExcludedIds.add(m.id);
  }
  const flaggedSet = new Set(mergedFlagged);
  const settle = (m: Message): Message => {
    if (userIds.has(m.id)) return m.excludeFromModel ? { ...m, excludeFromModel: false } : m;
    if (flaggedSet.has(m.id)) return m.excludeFromModel ? m : { ...m, excludeFromModel: true };
    // Pre-existing exclusions from EARLIER compactions survive: the message is
    // already out of the model view, and un-flagging it here would resurrect
    // content a previous summary replaced.
    if (preExcludedIds.has(m.id)) return m;
    if (coveredIds.has(m.id) && m.excludeFromModel) return { ...m, excludeFromModel: false };
    return m;
  };
  return {
    ...applyResult,
    updatedMessages: applyResult.updatedMessages.map(settle),
    updatedChains: applyResult.updatedChains.map((c) => ({ ...c, messages: c.messages.map(settle) })),
    flaggedIds: mergedFlagged,
  };
}

/**
 * Live progress payload for the subagent compaction widget (R27). Mirrors the
 * main-scope `CompactionProgressEvent` fields; routed by the caller through
 * the subagent live projection keyed by agent scope.
 */
export interface SubagentCompactionProgress {
  readonly phase: 'preparing' | 'compacting' | 'complete' | 'failed';
  readonly detail?: string;
  readonly mode?: CompactionMode;
  readonly streamText?: string | null;
  readonly estimatedTokens?: number | null;
}

/**
 * Shared subagent compaction attempt — uses the same trigger engine as U6 but
 * with the subagents scope config (R16). The caller supplies the current chain
 * history, latest provider-reported inputTokens, and resolved contextTokens.
 *
 * Returns a compaction ApplyResult when the trigger fired and the summary was
 * built, or null for no-op (below threshold / floor / hysteresis, or summarizer
 * unavailable). Reclaim-only (no summary head) is returned as an ApplyResult
 * with flaggedIds and no summaryMessage, which the caller persists via the
 * subagent checkpoint path.
 *
 * Accounting inside the summarizer already carries subagent scope (R18) when
 * called with scope='subagents' + subagentId — see summarize.ts.
 *
 * `onProgress` fires at the widget lifecycle points (reclaim/summarize
 * prepares); `onTextDelta` forwards the compactor's accumulated LLM output so
 * the caller can surface a streaming tail. Both are optional display hooks —
 * compaction proceeds identically without them.
 */
export async function tryCompactSubagentHistory(params: {
  readonly messages: readonly Message[];
  readonly chains: readonly Chain[];
  readonly selection: ModelSelection | null;
  readonly config: Config;
  readonly sessionId: string;
  readonly subagentId: string;
  readonly chainId: string | null;
  readonly turnId: string | null;
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly triggerState?: TriggerState;
  readonly onProgress?: (progress: SubagentCompactionProgress) => void;
  readonly onTextDelta?: (accumulatedText: string) => void;
}): Promise<ApplyResult | null> {
  const { messages, chains, selection, config, sessionId, subagentId, chainId, turnId, inputTokens, contextTokens } = params;
  const subagentsScope = config.compaction?.subagents;
  if (!subagentsScope) return null;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;

  // Lazy imports to avoid cycle with provider runtime during typecheck
  const { selectCut, resolvePreservePercent, resolveUserExemptIds } = await import('../llm/compaction/select.js');
  const { mechanicalReclaim } = await import('../llm/compaction/reclaim.js');
  const { evaluateTriggerWithReclaim } = await import('../llm/compaction/trigger.js');
  const { getProviderAccountingStore } = await import('../providers/accounting/store.js');

  let totalCharsAll = 0;
  for (const m of messages) totalCharsAll += estimateMessageChars(m);
  if (totalCharsAll === 0) totalCharsAll = 1;
  const tokensPerCharSub = (() => {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
    const r = inputTokens / totalCharsAll;
    if (!Number.isFinite(r) || r <= 0) return undefined;
    return Math.max(0.05, Math.min(r, 2));
  })();
  if (!tokensPerCharSub) return null;
  // R31/R32: subagent scope pins ALL user messages (null default). Exempt ids
  // never enter the compactable range and don't consume the preserve budget.
  const exemptIdsSub = resolveUserExemptIds(messages as Message[], {
    keepLast: subagentsScope.keep_last_user_messages ?? null,
    pinFirst: subagentsScope.pin_first_user_message,
  });
  let cut: ReturnType<typeof selectCut>;
  try {
    const calibratedEstimatorSub = (slice: readonly Message[]): number => {
      let chars = 0;
      for (const m of slice) chars += estimateMessageChars(m);
      return Math.max(slice.length, Math.ceil(chars * tokensPerCharSub));
    };
    cut = selectCut(messages as Message[], {
      preserveTokens: Math.floor(resolvePreservePercent(subagentsScope) * contextTokens),
      tokenEstimator: calibratedEstimatorSub,
      exemptIds: exemptIdsSub,
    });
  } catch {
    return null;
  }
  const compactableRange = cut.compactableRange;
  let sliceChars = 0;
  for (let i = compactableRange.start; i < compactableRange.end; i += 1) {
    const m = (messages as readonly Message[])[i];
    if (!m) continue;
    sliceChars += estimateMessageChars(m);
  }
  const compactableTokens = Math.ceil(sliceChars * tokensPerCharSub);
  if (compactableTokens <= 0) return null;

  // Mechanical reclaim pass before summarizer (v1 single rule, R25)
  let flaggedIds: string[] = [];
  if (subagentsScope.mechanical_reclaim) {
    try {
      const reclaim = mechanicalReclaim(messages as Message[], compactableRange);
      flaggedIds = [...reclaim.flaggedIds];
    } catch {
      // non-fatal
    }
  }

  const decision = evaluateTriggerWithReclaim({
    inputTokens,
    contextTokens,
    threshold: subagentsScope.threshold,
    hysteresisDelta: subagentsScope.hysteresis_delta,
    compactableTokens,
    minCompactableTokens: subagentsScope.min_compactable_tokens,
    compactableRange,
    messages: messages as Message[],
    flaggedIds,
    ...(params.triggerState ? { state: params.triggerState } : {}),
  });

  // Reclaim-only short-circuit: build apply without summarizer
  if (decision.shouldApply && !decision.shouldPrepare && flaggedIds.length > 0) {
    params.onProgress?.({ phase: 'preparing', detail: 'Reclaiming duplicates', mode: subagentsScope.mode as CompactionMode });
    try {
      const applyResult = buildCompactionApply({
        messages: messages as Message[],
        chains,
        cutResult: cut,
        summaryText: null,
        mode: subagentsScope.mode as import('../../shared/types/message').CompactionMode,
        reclaimedIds: flaggedIds,
      });
      return applyResult.didApply ? applyResult : null;
    } catch {
      return null;
    }
  }

  if (!decision.shouldPrepare) return null;

  // Ledger for both compaction modes — resolved once before the mode branch.
  let accountingStore: ReturnType<typeof getProviderAccountingStore> | undefined;
  try {
    accountingStore = getProviderAccountingStore();
  } catch {
    accountingStore = undefined;
  }

  // Compactable slice shared by both modes: in-range messages that are still
  // model-visible (not excludeFromModel) and not hidden. Both mode branches
  // no-op when the range has nothing left to compact.
  const takeCompactableSlice = (): Message[] =>
    (messages.slice(compactableRange.start, compactableRange.end) as Message[]).filter((m) => !m.excludeFromModel && !m.hidden);

  // Branch on compaction mode: selective uses manifest+LLM caller, simple uses summarizeCompactableRange.
  // Simple is default (opt-in selective via config.compaction.subagents.mode==='selective').
  if ((subagentsScope.mode as string) === 'selective') {
    // Shared selective runner (#11): slice → manifest → LLM caller →
    // multi-turn loop with simple fallback, with subagent-scoped accounting
    // and the R9 never-flag-user invariant applied to the result. The runner
    // module is imported lazily like the other compaction leaves to keep this
    // module's load graph free of the provider runtime chain.
    const compactableSlice = takeCompactableSlice();
    if (compactableSlice.length === 0) return null;

    let attempt: CompactionAttemptOutcome;
    try {
      const { runCompactionAttempt, unflagUserMessagesInApply } = await import('../llm/compaction/run-attempt.js');
      params.onProgress?.({ phase: 'preparing', detail: 'Summarizing history', mode: 'selective' });
      attempt = await runCompactionAttempt({
        messages: messages as Message[],
        cut,
        scope: 'subagents',
        config,
        deps: {
          fallbackSelection: selection,
          subagentId,
          accounting: accountingStore
            ? { store: accountingStore, sessionId, chainId, turnId }
            : { sessionId, chainId, turnId },
          ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
        },
      });
      if (attempt.kind === 'ran' && attempt.result.kind === 'selective') {
        // R3: never delete the transcript. Preserve every original message
        // (excludeFromModel flags + one compacted-marker summary head at the
        // cut) instead of hard-replacing the chain with the materialized
        // replay, whose summarized originals exist only as flagged ids.
        return buildSelectiveSubagentApply({
          messages: messages as Message[],
          chains,
          cutResult: cut,
          selectiveResult: attempt.result,
          reclaimedIds: flaggedIds,
          sessionId,
        });
      }
      if (attempt.kind === 'ran' && attempt.result.kind === 'fallback') {
        const fallbackText = attempt.result.fallbackText;
        if (!fallbackText || fallbackText.trim().length === 0) return null;
        const applyResult = buildCompactionApply({
          messages: messages as Message[],
          chains,
          cutResult: cut,
          summaryText: fallbackText,
          mode: 'simple' as import('../../shared/types/message').CompactionMode,
          reclaimedIds: flaggedIds,
          sessionId,
        });
        if (!applyResult.didApply) return null;
        // R9: user messages are never excluded from the model view — shared
        // helper (#11a), previously inlined here (and now applied by the main
        // scope's selective fallback too).
        return unflagUserMessagesInApply(applyResult, messages as Message[]);
      }
      return null;
    } catch {
      return null;
    }
  }

  // Simple default behavior (unchanged) — task-focused compactor-subagent, subagent-scoped accounting (R18)
  const compactableSlice = takeCompactableSlice();
  if (compactableSlice.length === 0) return null;

  let summarizeResult: Awaited<ReturnType<typeof import('../llm/compaction/summarize.js').summarizeCompactableRange>> | null;
  try {
    const { summarizeCompactableRange } = await import('../llm/compaction/summarize.js');
    params.onProgress?.({ phase: 'preparing', detail: 'Summarizing history', mode: subagentsScope.mode as CompactionMode });
    summarizeResult = await summarizeCompactableRange({
      messages: compactableSlice,
      scope: 'subagents',
      config,
      fallbackSelection: selection,
      existingModelSelection: selection,
      accounting: accountingStore
        ? { store: accountingStore, sessionId, chainId, turnId }
        : { sessionId, chainId, turnId },
      subagentId,
      ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
    });
  } catch {
    return null;
  }
  if (!summarizeResult || !summarizeResult.text?.trim()) {
    // Summarizer unavailable — if reclaim had ids, we already handled short-circuit; otherwise no-op
    return null;
  }

  try {
    const applyResult = buildCompactionApply({
      messages: messages as Message[],
      chains,
      cutResult: cut,
      summaryText: summarizeResult!.text,
      mode: subagentsScope.mode as import('../../shared/types/message').CompactionMode,
      reclaimedIds: flaggedIds,
      sessionId,
    });
    if (!applyResult.didApply) return null;
    return applyResult;
  } catch {
    return null;
  }
}
