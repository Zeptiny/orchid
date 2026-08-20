/**
 * Subagent mid-run compaction (U9/U5) — helpers shared by SubagentManager's run
 * loop, the per-run compaction controller, and the stream runner.
 *
 * These live in a dedicated module (not subagent-runner.ts) so the manager can
 * import them statically without forming a runtime dependency cycle:
 * manager -> subagent-runner -> tools/index -> manager. Nothing here may
 * import from ../tools or ./manager at runtime (type-only imports are fine —
 * they are erased at compile time).
 *
 * The compaction choreography mirrors the main scope's split (R28/R37):
 * `prepareSubagentCompaction` runs the shared gate pipeline and starts the
 * compactor (summarizer or selective run) at prepare time, registering a
 * scoped pending entry; `applySubagentPendingCompaction` consumes that entry
 * at the pause boundary against the LIVE chain history — re-validated by the
 * shared `isPendingCutStillValid` — so messages appended between prepare and
 * apply are preserved by construction (the apply is built over apply-time
 * history, never a prepare-time snapshot).
 *
 * This module also owns the compaction contracts shared by the manager, the
 * controller, and the runner: the mutable history box, the pause-gate
 * interface, and the pause/overflow outcome unions.
 */
import type { CompactionMode, Message } from '../../shared/types/message';
import type { ModelSelection } from '../../shared/types/provider';
import type { Config } from '../config/schema';
import type { Chain } from '../../shared/types/chain';
import { buildCompactionApply, buildSelectiveCompactionApply, type ApplyResult } from '../llm/compaction/apply';
import type { TriggerState } from '../llm/compaction/trigger';
import type { CompactionPendingEntry } from '../llm/compaction/pending-store';
import {
  acquireCompactionSlot,
  runCompactionGate,
} from '../llm/compaction/pipeline';
import type { CutResult } from '../llm/compaction/select';
import type { SelectiveCompactionResult } from '../llm/compaction/selective/run';
import { getProviderRuntime } from '../providers';

// ── Shared compaction contracts (U5/U6) ──────────────────────────────────────

/**
 * Mutable history handoff shared between the manager and a run's stream
 * (U5). The runner reads `messages` for each stream segment; a compaction
 * apply at a pause boundary swaps the contents so the restarted stream
 * replays the compacted history. Replaces the runner's frozen spawn-time
 * history snapshot.
 */
export interface SubagentHistoryBox {
  messages: Message[];
}

/** Outcome of consuming a compaction pause at a step boundary. */
export type SubagentPauseApplyOutcome =
  /** Compaction applied; restart with the compacted history in the box. */
  | 'applied'
  /** No pending / discarded / failed apply; restart with the accumulated history. */
  | 'skipped'
  /** Post-compaction model view still over the window with nothing left — the partial report (R17) is set and the run must stop. */
  | 'degraded'
  /** Abort/interrupt while consuming the pause — stop without restarting. */
  | 'aborted';

/**
 * Outcome of the reactive overflow fire point (R29 fire point 3 / R30): a
 * classified `context_length_exceeded` stream error asks the compaction
 * controller to recover the run before it degrades or fails.
 */
export type SubagentOverflowOutcome =
  /** Compaction applied and the history box swapped — retry the stream once. */
  | 'applied'
  /** Retry budget spent or nothing left to compact — the partial report (R17) is set on record.result and the run must end normally. */
  | 'degraded'
  /** Compaction disabled or unavailable (no context limits / no scope config) — the stream error propagates unchanged. */
  | 'unavailable'
  /** Abort raced in during the overflow compaction — stop without a retry. */
  | 'aborted';

/**
 * Compaction pause gate for one subagent run, keyed by the run's
 * (sessionId, agentScopeId) scope (R28). The runner binds `shouldPause` into
 * the orchestrator's early-stop predicate; when the stream stops at a step
 * boundary with the pause set, it awaits `applyAtPause` (re-validate against
 * live history, apply, swap the history box) and restarts the stream.
 * `compactForOverflow` is the reactive fire point (R29 fire point 3 / R30):
 * the runner routes a classified context-overflow error event to it instead of
 * letting it fail the run. `discard` is the interrupt path: clear the gate +
 * drop any pending.
 */
export interface SubagentCompactionPauseController {
  /** Whether this run's scope should pause for compaction at the next step boundary. */
  readonly shouldPause: () => boolean;
  /** Consume the pause at a step boundary: validate, apply, swap the history box. */
  readonly applyAtPause: () => Promise<SubagentPauseApplyOutcome>;
  /**
   * Compact synchronously for a context_length_exceeded stream error (prepare
   * + immediate apply — the stream is already dead, so the fire-and-forget
   * pause path cannot help) and report whether the run should retry the
   * stream once, degrade to the partial report, or let the error propagate.
   * `alreadyRetried` marks the post-retry terminal call — the controller
   * degrades instead of compacting again (one retry per run, mirroring main's
   * hasTriedCompactionRetry guard).
   */
  readonly compactForOverflow?: (params: { readonly alreadyRetried: boolean }) => Promise<SubagentOverflowOutcome>;
  /** Interrupt path: clear the scoped gate and discard any pending prepare. */
  readonly discard: () => void;
}

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
 * Compose a selective run's per-op summaries into the single summary-head
 * text the shared never-delete builder carries (plain parts joined by a
 * divider); null when the run produced no summaries (pure drop/ranged-keep).
 */
function composeSelectiveSummaryText(
  selectiveResult: Extract<SelectiveCompactionResult, { kind: 'selective' }>,
): string | null {
  const summaryParts = selectiveResult.summaryMessages.length > 0
    ? selectiveResult.summaryMessages.map((m) => m.content)
    : (selectiveResult.summaryMessage ? [selectiveResult.summaryMessage.content] : []);
  const summaryText = summaryParts.join('\n\n---\n\n').trim();
  return summaryText.length > 0 ? summaryText : null;
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
 * Prepare a subagent compaction (R29 fire point 2): run the shared gate
 * pipeline and start the compactor, WITHOUT applying anything. Returns a
 * pending entry the caller registers in the scoped pending store; the cut,
 * flagged ids, and expected ids are captured at prepare time so the apply at
 * the pause boundary can re-validate them against the live history (R37).
 *
 * Reclaim-only decisions return an entry with no compactor promise — the
 * flags are built at apply time over the live history. Returns null when the
 * gate decides no-op (below threshold / floor / hysteresis, uncalibrated, or
 * nothing left to compact).
 *
 * Accounting inside the summarizer already carries subagent scope (R18) when
 * called with scope='subagents' + subagentId — see summarize.ts.
 *
 * `onProgress` fires at the widget lifecycle points (reclaim/summarize
 * prepares); `onTextDelta` forwards the compactor's accumulated LLM output so
 * the caller can surface a streaming tail. Both are optional display hooks —
 * compaction proceeds identically without them.
 */
export async function prepareSubagentCompaction(params: {
  readonly messages: readonly Message[];
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
}): Promise<CompactionPendingEntry | null> {
  const { messages, selection, config, sessionId, subagentId, chainId, turnId, inputTokens, contextTokens } = params;
  const subagentsScope = config.compaction?.subagents;
  if (!subagentsScope) return null;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;

  // Lazy import: keeps this module's load graph free of the accounting store
  // chain (config/loader conflicts with test mocks) — see the AGENTS.md
  // dynamic-import rule for anything touching config/accounting from agents/.
  const { getProviderAccountingStore } = await import('../providers/accounting/store.js');

  // Shared gate pipeline (R34): calibrate → threshold/hysteresis → cut with
  // exempt user ids → mechanical reclaim → evaluate. The subagent adapter owns
  // everything around it (progress hooks, mode branch, apply).
  let gate;
  try {
    gate = runCompactionGate({
      messages: messages as Message[],
      config: subagentsScope,
      scope: 'subagents',
      inputTokens,
      contextTokens,
      tokensPerChar: null,
      ...(params.triggerState ? { triggerState: params.triggerState } : {}),
    });
  } catch {
    return null;
  }
  if (gate.kind === 'no-op') return null;
  const cut: CutResult = gate.cut;
  const flaggedIds: string[] = gate.flaggedIds;
  const compactableRange = cut.compactableRange;
  const expectedIds = (messages as Message[])
    .slice(compactableRange.start, compactableRange.end)
    .map((m) => m.id);

  // Reclaim-only short-circuit: no compactor call; flags are built at apply
  // time over the live history.
  if (gate.kind === 'reclaim-only') {
    params.onProgress?.({ phase: 'preparing', detail: 'Reclaiming duplicates', mode: subagentsScope.mode as CompactionMode });
    return {
      cut,
      flaggedIds,
      expectedIds,
      estimatedInput: gate.estimatedInput,
      contextTokens,
      mode: subagentsScope.mode === 'selective' ? 'selective' : 'simple',
    };
  }

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
    // multi-turn loop with simple fallback, with subagent-scoped accounting.
    // The runner module is imported lazily like the other compaction leaves to
    // keep this module's load graph free of the provider runtime chain.
    const compactableSlice = takeCompactableSlice();
    if (compactableSlice.length === 0) return null;

    try {
      const { runCompactionAttempt } = await import('../llm/compaction/run-attempt.js');
      params.onProgress?.({ phase: 'preparing', detail: 'Summarizing history', mode: 'selective' });
      const selectivePromise = (async () => {
        const release = await acquireCompactionSlot(config.compaction?.max_concurrent_compactors);
        try {
          return await runCompactionAttempt({
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
        } finally {
          release();
        }
      })();
      return {
        cut,
        flaggedIds,
        expectedIds,
        estimatedInput: gate.estimatedInput,
        contextTokens,
        mode: 'selective',
        selectivePromise,
      };
    } catch {
      return null;
    }
  }

  // Simple default behavior — task-focused compactor-subagent, subagent-scoped accounting (R18)
  const compactableSlice = takeCompactableSlice();
  if (compactableSlice.length === 0) return null;

  try {
    const { summarizeCompactableRange } = await import('../llm/compaction/summarize.js');
    params.onProgress?.({ phase: 'preparing', detail: 'Summarizing history', mode: subagentsScope.mode as CompactionMode });
    const promise = (async () => {
      const release = await acquireCompactionSlot(config.compaction?.max_concurrent_compactors);
      try {
        return await summarizeCompactableRange({
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
      } finally {
        release();
      }
    })();
    return {
      cut,
      flaggedIds,
      expectedIds,
      estimatedInput: gate.estimatedInput,
      contextTokens,
      mode: 'simple',
      promise,
    };
  } catch {
    return null;
  }
}

/**
 * Apply a prepared subagent compaction at the pause boundary (R28/R37).
 *
 * Awaits the compactor outcome prepared earlier, then builds the apply over
 * the LIVE chain history the caller supplies (never the prepare-time
 * snapshot), so every message appended between prepare and apply is
 * preserved — the subagent twin of main's `reanchorSelectiveReplay` contract.
 * Selective success routes through the shared never-delete builder
 * `buildSelectiveCompactionApply` (R3/R35: originals never deleted); the
 * fallback and simple paths route through `buildCompactionApply`, whose
 * universal settle already owns the R31 never-flag-user invariant.
 *
 * Returns the apply result, or null when the compactor produced nothing
 * usable (failed, empty text, or an apply-time precondition failure) — the
 * caller then discards the pending without touching the chain.
 */
export async function applySubagentPendingCompaction(params: {
  readonly pending: CompactionPendingEntry;
  readonly messages: readonly Message[];
  readonly chains: readonly Chain[];
  readonly sessionId: string;
}): Promise<ApplyResult | null> {
  const { pending, messages, chains, sessionId } = params;
  try {
    // ── Selective pending ───────────────────────────────────────────────
    if (pending.selectivePromise) {
      const outcome = await pending.selectivePromise;
      if (outcome.kind !== 'ran') return null;
      if (outcome.result.kind === 'selective') {
        // R3: never delete the transcript. Preserve every original message
        // (excludeFromModel flags + one compacted-marker summary head at the
        // cut) instead of hard-replacing the chain with the materialized
        // replay, whose summarized originals exist only as flagged ids.
        // R35: the same shared builder computes the main scope's selective
        // flags — one never-delete selective-settle for both scopes.
        return buildSelectiveCompactionApply({
          messages: messages as Message[],
          chains,
          cutResult: pending.cut,
          flaggedIds: outcome.result.flaggedIds,
          summaryText: composeSelectiveSummaryText(outcome.result),
          reclaimedIds: pending.flaggedIds,
          sessionId,
        });
      }
      if (outcome.result.kind === 'fallback') {
        const fallbackText = outcome.result.fallbackText;
        if (!fallbackText || fallbackText.trim().length === 0) return null;
        const applyResult = buildCompactionApply({
          messages: messages as Message[],
          chains,
          cutResult: pending.cut,
          summaryText: fallbackText,
          mode: 'simple' as import('../../shared/types/message').CompactionMode,
          reclaimedIds: pending.flaggedIds,
          sessionId,
        });
        // R31: user messages are never excluded from the model view — the
        // universal settle inside buildCompactionApply owns the invariant in
        // every mode (U1), so no scope-specific un-flag pass is needed here.
        return applyResult.didApply ? applyResult : null;
      }
      return null;
    }

    // ── Simple pending ──────────────────────────────────────────────────
    if (pending.promise) {
      const result = await pending.promise;
      if (!result || !result.text || !result.text.trim()) return null;
      const applyResult = buildCompactionApply({
        messages: messages as Message[],
        chains,
        cutResult: pending.cut,
        summaryText: result.text,
        mode: pending.mode as import('../../shared/types/message').CompactionMode,
        reclaimedIds: pending.flaggedIds,
        sessionId,
      });
      return applyResult.didApply ? applyResult : null;
    }

    // ── Reclaim-only pending ────────────────────────────────────────────
    const applyResult = buildCompactionApply({
      messages: messages as Message[],
      chains,
      cutResult: pending.cut,
      summaryText: null,
      mode: pending.mode as import('../../shared/types/message').CompactionMode,
      reclaimedIds: pending.flaggedIds,
      sessionId,
    });
    return applyResult.didApply ? applyResult : null;
  } catch (e) {
    console.debug('[subagent-compaction] pending apply failed (non-fatal):', e);
    return null;
  }
}
