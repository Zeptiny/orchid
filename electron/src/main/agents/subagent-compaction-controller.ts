/**
 * Per-run subagent compaction controller (U7) — owns everything compaction
 * that previously lived as closures inside SubagentManager._startRun.
 *
 * One controller per run generation carries:
 *  - the per-run trigger with the subagent's own model limits (R16), lazily
 *    resolved so the run start is not blocked by an extra provider lookup;
 *  - the three fire points: spawn/resume estimate gate (R29 #1), usage-event
 *    prepare (R29 #2), and the reactive overflow retry (R29 #3 / R30);
 *  - the pause-gate choreography (R28/R37): re-validate the pending cut
 *    against the live history, apply over it, persist transactionally (R36),
 *    swap the history box the runner restarts from;
 *  - the terminal still-over partial-report degradation (R17).
 *
 * The manager constructs it with narrow sinks (record chain swap, persistence
 * transaction, live-projection emitter, assembler rebaser) so the run loop
 * itself keeps no compaction logic. Nothing here may import from ../tools or
 * ./manager at runtime — the SubagentRecord type below is a type-only import
 * (erased at compile time); value dependencies arrive via constructor
 * injection. This keeps the manager -> runner -> tools cycle-free module
 * graph documented in subagent-compaction.ts intact.
 */
import type { Chain } from '../../shared/types/chain';
import type { Message } from '../../shared/types/message';
import type { CompactionScopeConfig } from '../../shared/types/ipc-boundary';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import type { ApplyResult } from '../llm/compaction/apply';
import { estimateMessageChars, totalCharsForMessages } from '../llm/compaction/message-chars';
import { charsForMessageIds, deriveTokensPerChar } from '../llm/compaction/pipeline';
import {
  dedupeHistoryById,
  deleteCompactionPending,
  getCompactionPending,
  isPendingCutStillValid,
  setCompactionPending,
  takeCompactionPending,
  type CompactionPendingEntry,
} from '../llm/compaction/pending-store';
import type { CompactionTrigger } from '../llm/compaction/trigger';
import type { SubagentCompactionPayload } from '../session/storage';
import {
  clearCompactionPause,
  requestCompactionPause,
  shouldPauseForCompaction,
} from '../ipc/next-request-stop';
import type { SubagentRecord } from './manager';
import {
  applySubagentPendingCompaction,
  buildSubagentPartialReport,
  prepareSubagentCompaction,
  resolveSubagentContextTokens,
  type SubagentCompactionPauseController,
  type SubagentCompactionProgress,
  type SubagentHistoryBox,
  type SubagentOverflowOutcome,
  type SubagentPauseApplyOutcome,
} from './subagent-compaction';

/** Minimum interval between subagent compaction live-progress emissions (IPC flood guard). */
const SUBAGENT_COMPACTION_EMIT_INTERVAL_MS = 100;

/** Narrow assembler surface the controller needs (snapshot + rebase, U5). */
interface AssemblerAccess {
  snapshotTranscript(): Message[];
  rebase(messages: readonly Message[]): void;
}

/**
 * Narrow constructor dependencies injected by SubagentManager — every
 * manager-owned effect the controller must perform lands here as a sink, so
 * the controller never reaches back into the manager.
 */
export interface SubagentCompactionControllerDeps {
  /** The run's runtime record; read live (chain/usage) and mutated on degradation (result). */
  readonly record: SubagentRecord;
  /** The run generation, for per-run turn attribution (`record.id#generation`). */
  readonly runGeneration: number;
  /** The run's abort signal — races every compaction await so interrupts abort cleanly. */
  readonly abortSignal: AbortSignal;
  /** Mutable history handoff the runner replays and the apply swaps (U5). */
  readonly historyBox: SubagentHistoryBox;
  /** Run assembler: live transcript snapshots + post-apply rebases. */
  readonly assembler: AssemblerAccess;
  /** Live-projection emitter for the compaction widget (R27); display-only. */
  readonly emitProgress: (progress: SubagentCompactionProgress) => void;
  /** Swap the record's chain messages in memory (manager owns the record). */
  readonly setChainMessages: (messages: Message[]) => void;
  /** Perform the targeted subagent-chain compaction transaction (R36). */
  readonly applySubagentCompaction: (sessionId: string, payload: SubagentCompactionPayload) => void;
  /** Record a compaction mutation when no session owns the record (no durable write). */
  readonly markCompaction: () => void;
  /** Mark the record dirty and bump its manager-owned revision. */
  readonly markRecordDirty: () => void;
  /** Empty chain factory for applies on records without a chain yet. */
  readonly emptyChain: () => Chain;
  /** Fired whenever a fire-and-forget prepare evaluation settles (test-observable counter). */
  readonly onPrepareEvaluated: () => void;
}

/**
 * Newest observed provider input-token count carried on a chain's messages,
 * or null when none carry usage. Calibration hydration source for the subagent
 * spawn/resume gate (R29 fire point 1) — a real observation, never a heuristic.
 */
function latestObservedInputTokens(messages: readonly Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = messages[i]?.usage;
    const input = usage?.context?.input_tokens ?? usage?.prompt_tokens;
    if (typeof input === 'number' && Number.isFinite(input) && input > 0) return input;
  }
  return null;
}

/**
 * Compaction controller for exactly one subagent run generation (U7).
 *
 * Public surface: the `pauseController` gate handed to the stream runner, the
 * run-loop event hooks (`onUsageEvent`, `onStepFinish`), the spawn/resume
 * gate starter, and the teardown `discard`. All compaction state (trigger,
 * cached scope config, context-window limits) dies with the run.
 */
export class SubagentCompactionController {
  readonly pauseController: SubagentCompactionPauseController;

  private readonly _deps: SubagentCompactionControllerDeps;
  private _contextTokens: number | null | undefined = undefined;
  private _trigger: CompactionTrigger | null = null;
  private _initDone = false;
  private _cachedCfg: CompactionScopeConfig | null = null;
  private _lastStepIndex = 0;
  private _lastProgressEmitAt = 0;
  private _progressTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SubagentCompactionControllerDeps) {
    this._deps = deps;
    this.pauseController = {
      shouldPause: () => shouldPauseForCompaction(this.sessionKey, this._deps.record.id),
      applyAtPause: () => this._applyPendingAtPause(),
      compactForOverflow: (params) => this._compactForOverflow(params),
      discard: () => this.discard(),
    };
  }

  /** Scope key for the pending store and pause registry. */
  private get sessionKey(): string {
    return this._deps.record.sessionId ?? 'unknown';
  }

  /** Per-run turn id for provider accounting attribution. */
  private get turnId(): string {
    return `${this._deps.record.id}#${this._deps.runGeneration}`;
  }

  /**
   * R27: route widget progress through the live projection keyed by agent
   * scope. Failures are display-only and never break the compaction.
   */
  private _emitProgress(progress: SubagentCompactionProgress): void {
    try {
      this._deps.emitProgress(progress);
    } catch {
      // projection entry may be gone (run removed) — display-only
    }
  }

  /**
   * Time-gated streaming tail for the widget: forwards the compactor's
   * accumulated LLM output as `compacting` progress with a calibrated token
   * estimate, throttled to the emission interval.
   */
  private _onTextDelta(accumulatedText: string): void {
    const emit = (): void => {
      this._progressTimer = null;
      this._lastProgressEmitAt = Date.now();
      const tpc = this._trigger?.state.tokensPerChar;
      this._emitProgress({
        phase: 'compacting',
        streamText: accumulatedText,
        ...(typeof tpc === 'number' && Number.isFinite(tpc) && tpc > 0
          ? { estimatedTokens: Math.ceil(accumulatedText.length * tpc) }
          : {}),
      });
    };
    if (this._progressTimer) return;
    const remaining = SUBAGENT_COMPACTION_EMIT_INTERVAL_MS - (Date.now() - this._lastProgressEmitAt);
    if (remaining <= 0) {
      emit();
      return;
    }
    this._progressTimer = setTimeout(emit, remaining);
  }

  /** Cached `compaction.subagents` scope config; refetched while unset, null when the config is unavailable. */
  private _scopeConfig(): CompactionScopeConfig | null {
    if (this._cachedCfg) return this._cachedCfg;
    try {
      const cfg = getConfig().compaction?.subagents ?? null;
      this._cachedCfg = cfg;
      return cfg;
    } catch {
      return null;
    }
  }

  /**
   * Lazy compaction init: resolve the subagent's own model limits via the
   * frozen selection's trusted provider execution (R16) and arm the per-run
   * trigger. Returns false (permanently, once tried) when the limits are
   * unavailable — the run start is never blocked by the provider lookup.
   */
  private async _ensureInit(): Promise<boolean> {
    if (this._initDone) return this._contextTokens !== null && this._trigger !== null;
    this._initDone = true;
    try {
      const tokens = await resolveSubagentContextTokens(this._deps.record.selection);
      this._contextTokens = tokens;
      if (tokens !== null) {
        const { CompactionTrigger } = await import('../llm/compaction/trigger.js');
        this._trigger = new CompactionTrigger();
        this._scopeConfig();
        return true;
      }
    } catch (e) {
      // non-fatal
      console.debug('[subagent-compaction] compaction init failed:', e);
    }
    this._contextTokens = null;
    return false;
  }

  /**
   * Fire-and-forget compaction prepare (R29 fire point 2). Registers a
   * scoped pending entry and requests the scoped pause so the run's tool
   * loop stops at the next step boundary (R28) — main's
   * handleUsageCompaction choreography on the subagent host. The whole body
   * sits in a try/finally so EVERY settled evaluation — registered a
   * pending, decided not to, or threw — increments the test-observable
   * counter (see onPrepareEvaluated); tests await it instead of fixed sleeps.
   */
  private async _maybePrepare(inputTokens: number): Promise<void> {
    try {
      const { record } = this._deps;
      if (getCompactionPending(this.sessionKey, record.id)) return;
      const ok = await this._ensureInit();
      if (!ok || this._contextTokens == null || !this._trigger) return;
      const cfg = this._scopeConfig();
      if (!cfg) return;
      const prepared = await prepareSubagentCompaction({
        messages: (record.chain?.messages ?? []) as Message[],
        selection: record.selection,
        config: this._liveConfig(cfg),
        sessionId: this.sessionKey,
        subagentId: record.id,
        chainId: record.chain?.id ?? null,
        turnId: this.turnId,
        inputTokens,
        contextTokens: this._contextTokens,
        triggerState: this._trigger.state,
        onProgress: (progress) => this._emitProgress(progress),
        onTextDelta: (text) => this._onTextDelta(text),
      });
      if (!prepared) return;
      this._trigger.markPrepareStarted(prepared.cut.compactableRange, prepared.flaggedIds);
      setCompactionPending(this.sessionKey, record.id, prepared);
      // The compactor promise is consumed at the pause boundary; until
      // then a rejection (compactor provider down) has no observer —
      // attach a no-op catch so it can never surface as an unhandled
      // rejection. The apply awaits the same promise and handles it.
      prepared.promise?.catch(() => undefined);
      prepared.selectivePromise?.catch(() => undefined);
      if (!shouldPauseForCompaction(this.sessionKey, record.id)) {
        requestCompactionPause(this.sessionKey, record.id);
      }
    } catch (e) {
      // non-fatal
      console.debug('[subagent-compaction] prepare start failed:', e);
    } finally {
      this._deps.onPrepareEvaluated();
    }
  }

  /**
   * The live process config when loadable, else the minimal shape carrying
   * the cached subagents scope — the prepare path reads both.
   */
  private _liveConfig(cfg: CompactionScopeConfig): Config {
    try {
      return getConfig() as unknown as Config;
    } catch {
      return { compaction: { subagents: cfg } } as unknown as Config;
    }
  }

  /**
   * U5: consume the scoped compaction pause at a step boundary (R28) — the
   * subagent twin of main's idle-intercept apply in send.ts. Re-validates the
   * pending cut against the LIVE chain history (R37), applies over that live
   * history (so the post-prepare suffix survives — the re-anchor contract),
   * persists via the transactional subagent path (R36), swaps the history box
   * the runner restart reads, and runs the terminal still-over/partial-report
   * degradation (R17). Always clears the scoped pause gate first so exactly
   * one apply runs per pause cycle.
   */
  private async _applyPendingAtPause(): Promise<SubagentPauseApplyOutcome> {
    const { record, abortSignal, historyBox, assembler } = this._deps;
    const pending = takeCompactionPending(this.sessionKey, record.id);
    clearCompactionPause(this.sessionKey, record.id);
    if (!pending) {
      historyBox.messages = assembler.snapshotTranscript();
      return 'skipped';
    }
    if (abortSignal.aborted) {
      try { this._trigger?.consumePending(); } catch { /* trigger may be unresolved */ }
      this._emitProgress({ phase: 'complete' });
      return 'aborted';
    }
    const ok = await this._ensureInit();
    if (!ok || !this._trigger || this._contextTokens == null) {
      try { this._trigger?.consumePending(); } catch { /* trigger may be unresolved */ }
      this._emitProgress({ phase: 'complete' });
      historyBox.messages = assembler.snapshotTranscript();
      return 'skipped';
    }
    this._emitProgress({ phase: 'compacting', detail: 'Applying summary', mode: pending.mode });
    // R37: the pending's cut/expected ids were captured at prepare time —
    // re-validate against the live chain history (everything the run has
    // accumulated, including the current step's trailing text) before apply.
    const liveHistory = dedupeHistoryById(assembler.snapshotTranscript());
    if (!isPendingCutStillValid(pending, liveHistory)) {
      this._trigger.consumePending();
      this._emitProgress({ phase: 'complete' });
      historyBox.messages = [...liveHistory];
      return 'skipped';
    }
    // Race the compactor wait against the run's abort signal so an interrupt
    // during the pause aborts cleanly (the subagent twin of review #33).
    const applyResult = await this._raceAbortableApply(pending, liveHistory);
    if (abortSignal.aborted) {
      this._trigger.consumePending();
      this._emitProgress({ phase: 'complete' });
      return 'aborted';
    }
    const shouldApply = this._evaluateApply(applyResult);
    if (!applyResult || !shouldApply) {
      this._trigger.consumePending();
      this._emitProgress({ phase: 'complete' });
      historyBox.messages = [...liveHistory];
      return 'skipped';
    }
    // Persist via the transactional subagent compaction path so crash
    // mid-run resumes the compacted chain (R36), applied BEFORE the run
    // resumes. Memory follows: the record chain, the assembler base (via
    // rebase — never a field poke), and the history box the restarted
    // stream replays.
    this._commitApply(applyResult);
    // Hysteresis accrual baseline is post-compaction inputTokens, not pre-compaction peak
    const preInput = record.usage?.prompt_tokens ?? 0;
    const postCompactionTokens = this._pausePathBaselineTokens(applyResult, preInput);
    this._trigger?.onCompactionApplied(preInput, postCompactionTokens);
    this._emitProgress({ phase: 'complete', detail: 'Context compacted — resuming' });
    // R17: still over limit after compaction -> partial report degradation
    const cfg = this._scopeConfig();
    const threshold = cfg?.threshold ?? 0.85;
    const postTokens = postCompactionTokens ?? record.usage?.prompt_tokens ?? 0;
    const stillOver = this._contextTokens !== null && Number.isFinite(this._contextTokens)
      && postTokens / this._contextTokens >= threshold * 0.98;
    // Also handle case where still over but we did compact: check if next cut would be empty
    if (stillOver) {
      try {
        // Lazy import like the other compaction leaves (module-graph rule).
        const { calibratedCut, deriveTokensPerChar: deriveTpc } = await import('../llm/compaction/pipeline.js');
        const cfg2 = this._scopeConfig();
        // Calibrate from the run's reported usage; without it the emptiness
        // check is skipped (hard rule: no heuristic token estimates).
        const retryMessages = (record.chain?.messages ?? []) as Message[];
        const tpc3 = deriveTpc(record.usage?.prompt_tokens ?? null, totalCharsForMessages(retryMessages));
        if (tpc3 == null) return 'applied';
        // R31/R32: exempt user ids thread through so the exhaustion check's
        // compactable range matches the real compaction range.
        const cut = calibratedCut(retryMessages, {
          config: cfg2 ?? { threshold: 0.85, preserve_percent: 0.25 },
          contextTokens: this._contextTokens ?? 0,
          tokensPerChar: tpc3,
        });
        // Exhaustion test: with chain inference splitting summary heads into
        // their own chains, the range may still contain the previous head
        // (re-summarizable by design). A range whose only unflagged content
        // is summary heads cannot make progress — degrading beats looping.
        const rangeMessages = retryMessages.slice(cut.compactableRange.start, cut.compactableRange.end);
        const netNew = rangeMessages.filter((m) => !m.excludeFromModel && !m.hidden && !m.compacted);
        if (netNew.length === 0) {
          return this._degradeToPartialReport();
        }
      } catch {
        // ignore
      }
    }
    return 'applied';
  }

  /**
   * R29 fire point 3 / R30: reactive overflow retry — the subagent twin of
   * main's overflow-retry site in ipc/chat/send.ts. A classified
   * context_length_exceeded error is terminal for the stream segment but not
   * for the run: record the window as a measured lower bound (the overflow
   * proves input >= window; calibrate-or-skip never fabricates an estimate),
   * compact SYNCHRONOUSLY (prepare + immediate apply — the stream is already
   * dead, so the fire-and-forget pause path cannot help), persist via the
   * transactional subagent sink (R36), swap the history box, and tell the
   * runner to restart the stream once. When the retry budget is spent
   * (alreadyRetried), the gate no-ops (nothing left to compact), or the
   * apply produces nothing usable, the run degrades to the structured
   * partial report (R17) and completes normally. Compaction-disabled or
   * unavailable runs return 'unavailable' and the original error propagates.
   */
  private async _compactForOverflow(params: {
    readonly alreadyRetried: boolean;
  }): Promise<SubagentOverflowOutcome> {
    const { record, abortSignal, historyBox, assembler } = this._deps;
    if (abortSignal.aborted) return 'aborted';
    if (params.alreadyRetried) return this._degradeToPartialReport();
    const cfg = this._scopeConfig();
    if (!cfg) return 'unavailable';
    const ready = await this._ensureInit();
    if (abortSignal.aborted) return 'aborted';
    if (!ready || this._contextTokens == null || !this._trigger) return 'unavailable';
    // Consume any pending the proactive fire points already prepared (its
    // compactor may already be running) and clear the scoped pause gate: the
    // retry segment must not stop at the next boundary for a compaction this
    // path applies itself.
    let pending: CompactionPendingEntry | null | undefined = takeCompactionPending(this.sessionKey, record.id);
    clearCompactionPause(this.sessionKey, record.id);
    const liveHistory = dedupeHistoryById(assembler.snapshotTranscript());
    if (pending && !isPendingCutStillValid(pending, liveHistory)) {
      try { this._trigger.abortPrepare(); } catch { /* trigger may be unresolved */ }
      pending = undefined;
    }
    if (!pending) {
      // Measured lower bound: the failed request proves input >= the window,
      // which calibrates the gate when no usage observation exists yet and
      // doubles as this fire point's observed inputTokens (over-window, so
      // the threshold gate cannot block the recovery it exists for).
      if (this._trigger.state.tokensPerChar == null) {
        this._trigger.state.lastObservedInputTokens = this._contextTokens;
      }
      pending = await prepareSubagentCompaction({
        messages: liveHistory,
        selection: record.selection,
        config: this._liveConfig(cfg),
        sessionId: this.sessionKey,
        subagentId: record.id,
        chainId: record.chain?.id ?? null,
        turnId: this.turnId,
        inputTokens: this._contextTokens,
        contextTokens: this._contextTokens,
        triggerState: this._trigger.state,
        onProgress: (progress) => this._emitProgress(progress),
        onTextDelta: (text) => this._onTextDelta(text),
      });
      if (abortSignal.aborted) {
        pending?.promise?.catch(() => undefined);
        pending?.selectivePromise?.catch(() => undefined);
        try { this._trigger.abortPrepare(); } catch { /* trigger may be unresolved */ }
        this._emitProgress({ phase: 'complete' });
        return 'aborted';
      }
      if (!pending) {
        // Gate no-op: nothing left to compact (empty cut / below floor) —
        // the partial report is the terminal fallback.
        try { this._trigger.abortPrepare(); } catch { /* trigger may be unresolved */ }
        this._emitProgress({ phase: 'complete' });
        return this._degradeToPartialReport();
      }
      this._trigger.markPrepareStarted(pending.cut.compactableRange, pending.flaggedIds);
      // The compactor promise is consumed by the apply below; a rejection
      // before that has no observer — never surface as an unhandled one.
      pending.promise?.catch(() => undefined);
      pending.selectivePromise?.catch(() => undefined);
    }
    this._emitProgress({ phase: 'compacting', detail: 'Applying summary', mode: pending.mode });
    // Race the apply against the run's abort signal so an interrupt during
    // the overflow recovery breaks out cleanly (review #33 semantics).
    const applyResult = await this._raceAbortableApply(pending, liveHistory);
    if (abortSignal.aborted) {
      try { this._trigger.consumePending(); } catch { /* trigger may be unresolved */ }
      this._emitProgress({ phase: 'complete' });
      return 'aborted';
    }
    const shouldApply = this._evaluateApply(applyResult);
    if (!applyResult || !shouldApply) {
      // Nothing usable came out of the compactor — restarting the dead
      // stream with unchanged history would only overflow again, so this is
      // the degradation arm, not a skip.
      try { this._trigger.consumePending(); } catch { /* trigger may be unresolved */ }
      this._emitProgress({ phase: 'complete' });
      historyBox.messages = [...liveHistory];
      return this._degradeToPartialReport();
    }
    // Persist via the transactional subagent compaction path so crash
    // mid-retry resumes the compacted chain (R36), then memory follows:
    // record chain, assembler base (rebase — never a field poke), and the
    // history box the retried stream replays.
    this._commitApply(applyResult);
    // Arm hysteresis from the post-compaction model view so the retried
    // stream's usage events re-evaluate against the new baseline.
    const preInput = record.usage?.prompt_tokens ?? 0;
    let postCompactionTokens: number | undefined;
    try {
      let totalPost = 0;
      for (const m of applyResult.updatedMessages) {
        if ((m as Message).excludeFromModel === true) continue;
        totalPost += estimateMessageChars(m as Message);
      }
      if (totalPost === 0) totalPost = 1;
      const tpc = this._trigger.state.tokensPerChar
        ?? deriveTokensPerChar(preInput, totalCharsForMessages(record.chain?.messages ?? []));
      if (tpc != null) postCompactionTokens = Math.ceil(totalPost * tpc);
    } catch {
      // token calibration is best-effort
    }
    this._trigger.onCompactionApplied(preInput, postCompactionTokens);
    this._emitProgress({ phase: 'complete', detail: 'Context compacted — retrying' });
    return 'applied';
  }

  /**
   * Race an apply await against the run's abort signal: resolves null when
   * the signal fires first, so an interrupt during the compaction aborts
   * cleanly instead of observing a late result.
   */
  private _raceAbortableApply(
    pending: CompactionPendingEntry,
    liveHistory: readonly Message[],
  ): Promise<ApplyResult | null> {
    const { record, abortSignal } = this._deps;
    return new Promise<ApplyResult | null>((resolve) => {
      if (abortSignal.aborted) {
        resolve(null);
        return;
      }
      let settled = false;
      const settle = (value: ApplyResult | null): void => {
        if (settled) return;
        settled = true;
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => settle(null);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      applySubagentPendingCompaction({
        pending,
        messages: [...liveHistory],
        chains: [
          {
            ...(record.chain ?? this._deps.emptyChain()),
            messages: [...liveHistory],
          },
        ] as unknown as import('../../shared/types/chain').Chain[],
        sessionId: this.sessionKey,
      }).then(settle, () => settle(null));
    });
  }

  /**
   * The trigger's apply gate: estimates the compactable tokens the apply
   * would reclaim (calibrated from this run's usage) and asks the trigger
   * whether the compaction is worth applying.
   */
  private _evaluateApply(applyResult: ApplyResult | null): boolean {
    const { record } = this._deps;
    if (!this._trigger || this._contextTokens == null) return false;
    const chainMessages = record.chain?.messages ?? [];
    const cfg = this._scopeConfig();
    return this._trigger.evaluateApply({
      inputTokens: record.usage?.prompt_tokens ?? 0,
      contextTokens: this._contextTokens,
      threshold: cfg?.threshold ?? (() => {
        try {
          return getConfig().compaction.subagents.threshold;
        } catch {
          return 0.85;
        }
      })(),
      compactableTokens: (() => {
        try {
          const flagged = applyResult?.flaggedIds ?? [];
          if (flagged.length === 0) return 0;
          let flaggedChars = charsForMessageIds(chainMessages, flagged);
          if (flaggedChars === 0) flaggedChars = flagged.length * 200;
          const tpc =
            this._trigger.state.tokensPerChar ??
            deriveTokensPerChar(record.usage?.prompt_tokens ?? null, totalCharsForMessages(chainMessages)) ??
            0.25;
          return Math.ceil(flaggedChars * tpc);
        } catch {
          return applyResult?.flaggedIds.length ?? 0;
        }
      })(),
      minCompactableTokens: cfg?.min_compactable_tokens ?? (() => {
        try {
          return getConfig().compaction.subagents.min_compactable_tokens;
        } catch {
          return 4000;
        }
      })(),
    }).shouldApply;
  }

  /**
   * Commit an accepted apply: memory first (record chain, assembler rebase,
   * history box), then the transactional durable write (R36) applied BEFORE
   * the run resumes, then the record revision bump and the trigger's pending
   * consumption. Baseline re-arm and the completion widget event stay with
   * the calling fire point (their shape differs per path).
   */
  private _commitApply(applyResult: ApplyResult): void {
    const { record, historyBox, assembler } = this._deps;
    const updatedMessages = applyResult.updatedMessages;
    this._deps.setChainMessages([...updatedMessages]);
    assembler.rebase(updatedMessages);
    historyBox.messages = [...updatedMessages];
    try {
      const sessionId = record.sessionId ?? undefined;
      if (sessionId) {
        let insertBeforeMessageId: string | null = null;
        if (applyResult.summaryMessage) {
          const summaryIdx = updatedMessages.findIndex(
            (m) => m.id === applyResult.summaryMessage!.id,
          );
          if (summaryIdx >= 0 && summaryIdx + 1 < updatedMessages.length) {
            insertBeforeMessageId = updatedMessages[summaryIdx + 1]!.id;
          }
        }
        const payload: SubagentCompactionPayload = {
          updatedAt: new Date().toISOString(),
          flaggedMessageIds: applyResult.flaggedIds,
          summaryMessage: applyResult.summaryMessage,
          insertBeforeMessageId,
        };
        this._deps.applySubagentCompaction(sessionId, payload);
      } else {
        this._deps.markCompaction();
      }
    } catch {
      // compaction persistence marker is best-effort
    }
    this._deps.markRecordDirty();
    this._trigger?.consumePending();
  }

  /**
   * Post-compaction model-view token estimate for the pause path's hysteresis
   * baseline: calibrated tokens-per-char when available, else derived from
   * this run's reported usage over the post-compaction view (then the whole
   * chain). Best-effort — null when nothing calibrates.
   */
  private _pausePathBaselineTokens(applyResult: ApplyResult, preInput: number): number | undefined {
    const { record } = this._deps;
    let postCompactionTokens: number | undefined;
    try {
      let totalPost = 0;
      for (const m of applyResult.updatedMessages) {
        if ((m as Message).excludeFromModel === true) continue;
        totalPost += estimateMessageChars(m as Message);
      }
      if (totalPost === 0) totalPost = 1;
      let tpc: number | undefined = this._trigger?.state.tokensPerChar;
      if (tpc == null && Number.isFinite(preInput) && preInput > 0) {
        const r = preInput / Math.max(1, totalPost + (applyResult.flaggedIds.length * 200));
        if (Number.isFinite(r) && r > 0) tpc = Math.max(0.05, Math.min(r, 2));
      }
      if (tpc == null) tpc = this._trigger?.state.tokensPerChar;
      if (tpc != null) postCompactionTokens = Math.ceil(totalPost * tpc);
      else {
        let totalAll = 0;
        for (const m of (record.chain?.messages ?? [])) totalAll += estimateMessageChars(m as Message);
        if (totalAll > 0 && Number.isFinite(preInput) && preInput > 0) {
          const r2 = preInput / totalAll;
          const tpc2 = Math.max(0.05, Math.min(r2, 2));
          postCompactionTokens = Math.ceil(totalPost * tpc2);
        }
      }
    } catch {
      // token calibration is best-effort
    }
    return postCompactionTokens;
  }

  /**
   * R17: terminal degradation — the run COMPLETES (never fails) with a
   * structured partial report as its normal result, carrying done/remaining/
   * stopped-at for the parent.
   */
  private _degradeToPartialReport(): 'degraded' {
    const { record } = this._deps;
    const done = `${record.chain?.messages.filter((m) => m.type === 'tool_result').length ?? 0} tool results`;
    record.result = buildSubagentPartialReport({
      done,
      remaining: record.task.slice(0, 200),
      stoppedAt: `step ${this._lastStepIndex}`,
    });
    return 'degraded';
  }

  /**
   * R29 fire point 2 hook: observe a usage event, feed the trigger, and
   * (when the threshold is crossed) start the fire-and-forget prepare in
   * parallel with the run.
   */
  async onUsageEvent(inputTokens: number): Promise<void> {
    const ready = await this._ensureInit();
    if (!ready || this._contextTokens == null || !this._trigger) return;
    this._trigger.observeUsage(inputTokens, this._deps.record.chain?.messages ?? []);
    this._trigger.onUsage(
      inputTokens,
      this._contextTokens,
      this._scopeConfig()?.threshold ?? (() => {
        try {
          return getConfig().compaction.subagents.threshold;
        } catch {
          return 0.85;
        }
      })(),
    );
    // Prepare in parallel (non-blocking) if threshold crossed
    void this._maybePrepare(inputTokens);
  }

  /** Track the run's step index for the partial report's `stoppedAt` (R17). */
  onStepFinish(stepIndex: number): void {
    this._lastStepIndex = stepIndex;
  }

  /**
   * R29 fire point 1: spawn/resume estimate gate, run once before the run's
   * first stream starts. Calibrate-or-skip is a hard rule — a fresh run has
   * no observed usage and no-ops; a resumed run seeds calibration from the
   * chain's persisted message usages (the subagent twin of the main scope's
   * hydrateTriggerCalibration) and can compact before the first request.
   * Fire-and-forget: the gate never blocks the first stream.
   */
  startSpawnTimeGate(): void {
    void (async () => {
      try {
        const { record } = this._deps;
        const history = (record.chain?.messages ?? []) as Message[];
        if (history.length === 0) return;
        if (getCompactionPending(this.sessionKey, record.id)) return;
        const ok = await this._ensureInit();
        if (!ok || this._contextTokens == null || !this._trigger) return;
        const { runCompactionGate } = await import('../llm/compaction/pipeline.js');
        // Hydrate calibration from the newest chain-message usage — the same
        // secondary source the main scope's hydrateTriggerCalibration reads.
        // `record.usage` is deliberately not used: on a resumed record it is
        // null (the follow-up transition resets it) and on a restored one it is
        // a summed aggregate across steps, not one request's observed input.
        const observed = latestObservedInputTokens(history);
        if (observed != null) {
          this._trigger.observeUsage(observed, history);
        }
        const decision = runCompactionGate({
          messages: history,
          config: this._scopeConfig() ?? getConfig().compaction.subagents,
          scope: 'subagents',
          inputTokens: this._trigger.state.lastObservedInputTokens ?? null,
          contextTokens: this._contextTokens,
          tokensPerChar: this._trigger.state.tokensPerChar ?? null,
          triggerState: this._trigger.state,
        });
        if (decision.kind === 'prepare') {
          await this._maybePrepare(decision.estimatedInput);
        }
      } catch (e) {
        // non-fatal — the usage-event prepare and overflow retry remain as backstops
        console.debug('[subagent-compaction] spawn-time gate failed:', e);
      }
    })();
  }

  /**
   * Interrupt or natural-end teardown: clear this run's scoped compaction
   * gate and drop any pending it never consumed — the per-run trigger dies
   * with the run, and the next run re-prepares via its own gates.
   */
  discard(): void {
    clearCompactionPause(this.sessionKey, this._deps.record.id);
    deleteCompactionPending(this.sessionKey, this._deps.record.id);
    try { this._trigger?.consumePending(); } catch { /* trigger may be unresolved */ }
  }
}
