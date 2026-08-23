/**
 * Main-session compaction engine (extracted from send.ts, #12).
 *
 * Owns everything compaction-specific that is not turn lifecycle: the
 * per-session trigger/pending/retry state, trigger calibration hydration,
 * send-time synchronous compaction, mid-turn usage-event prepares, pending
 * consumption/apply at turn start and pause boundaries, selective persistence
 * (single durable transaction per compaction), and the compaction widget
 * lifecycle. `send.ts` keeps `startChatTurn` and calls into this module at its
 * compaction seams (turn-start consumption, usage events, pause/resume,
 * overflow retry).
 *
 * The selective-mode prepare orchestration is shared with the subagent scope
 * via `llm/compaction/run-attempt.ts` (#11); unified behavior there:
 *  - selective mode (including its fallback) never flags user messages (R9);
 *  - synthesized compactor chains use one id scheme: randomUUID().
 *
 * The gate sequence itself (calibrate → threshold/hysteresis → cut → reclaim →
 * evaluate) lives in `llm/compaction/pipeline.ts` (R34); this module is the
 * main-scope adapter — it owns trigger mutation, persistence, widget emission,
 * and the pause registry on top of the pipeline's decisions.
 */
import { randomUUID } from 'node:crypto';
import type { ModelSelection } from '../../../shared/types/provider';
import { ChainStatus } from '../../../shared/types/chain';
import type { Chain } from '../../../shared/types/chain';
import type { Message } from '../../../shared/types/message';
import { IPC_CHANNELS, type ChatCompactResult } from '../../../shared/types/ipc';
import { MAIN_AGENT_SCOPE_ID } from '../../../shared/types/agent-scope';
import type { CompactionProgressEvent, CompactionProgressPhase } from '../../../shared/types/compaction-progress';
import type { ProjectRuntime } from '../../project/runtime';
import type { ProviderAccountingStore } from '../../providers/accounting/store';
import { getProviderRuntime } from '../../providers';
import { getProviderAccountingStore } from '../../providers/accounting/store';
import { getSessionManager } from '../../session/singleton';
import { onSessionDeleted } from '../../session/manager';
import { getChatHistory, setChatHistory } from '../../ipc/chat-history';
import {
  clearCompactionPause,
  clearCompactionPausesForSession,
  requestCompactionPause,
  shouldPauseForCompaction,
} from '../../agents/next-request-stop';
import { publishSessionActivity } from '../../session/activity-live';
import { totalCharsForMessages } from '../../llm/compaction/message-chars';
import { resolveUserExemptIds, type CutResult } from '../../llm/compaction/select';
import {
  clearCompactionPendingsForSession,
  dedupeHistoryById,
  getCompactionPending,
  isPendingCutStillValid,
  setCompactionPending,
  takeCompactionPending,
} from '../../llm/compaction/pending-store';
import {
  computeMessageCharCache,
  deriveTokensPerChar,
  runCompactionGate,
} from '../../llm/compaction/pipeline';
import { summarizeCompactableRange, buildCompactionBridgeContext, type SummarizeResult } from '../../llm/compaction/summarize';
import {
  buildCompactionApply,
  buildSelectiveCompactionApply,
  stampCompactionMetrics,
  type ApplyResult,
} from '../../llm/compaction/apply';
import { CompactionTrigger } from '../../llm/compaction/trigger';
import {
  compactableModelSlice,
  runCompactionAttempt,
  type CompactionAttemptOutcome,
} from '../../llm/compaction/run-attempt';
import { activeAgents, runWithSessionOperationGate, sessionsStarting } from './state';
import { canDeliverTo, sendSessionEvent, sendTurnEvent, type HostClientId } from './events';
import {
  historyFromSession,
  persistCompactionBetweenTurns as persistCompaction,
  persistCompactionDurable,
  publishCompactedSession,
} from './persist';

// ── Compaction state per session (U8, R13) ──────────────────────────────────

const compactionTriggers = new Map<string, CompactionTrigger>();
const compactionRetryTried = new Set<string>();

/**
 * Unsettled main-scope selective runs per session. A selective prepare is
 * fire-and-forget at the usage fire point — the apply awaits the same promise
 * at the pause boundary. When an apply discards a pending early (invalidated
 * cut) the underlying LLM run keeps going; without this guard the next usage
 * event starts ANOTHER compactor run while the orphan still streams (the
 * every-step cascade observed in review #53).
 */
const selectiveRunsInFlight = new Map<string, Promise<unknown>>();

function isSelectiveRunInFlight(sessionId: string): boolean {
  return selectiveRunsInFlight.has(sessionId);
}

function trackSelectiveRun(sessionId: string, run: Promise<unknown>): void {
  selectiveRunsInFlight.set(sessionId, run);
  void run.finally(() => {
    if (selectiveRunsInFlight.get(sessionId) === run) selectiveRunsInFlight.delete(sessionId);
  }).catch(() => {
    // rejection handled by the prepare/apply sites' own catch
  });
}

// ── Compaction widget progress emission ───────────────────────────────────

/**
 * Per-session compaction epoch: bumped on every terminal progress event
 * (`complete`/`failed`). Emitters bind the epoch at creation so a trailing
 * throttled flush from an already-finished compaction can never flip the
 * widget back to a running phase (the regression behind the old
 * `compactionWidgetToolId` machinery). Entries stay monotonic for the
 * process lifetime — session ids are unique, so the map is bounded by the
 * number of sessions ever compacted in this run.
 */
const compactionProgressEpochs = new Map<string, number>();

/**
 * Per-session synthetic event identity for idle compactions (manual
 * `/compact`): stable turnId for the compaction's lifecycle plus a monotonic
 * sequence, minted lazily and dropped on the terminal phase so the next idle
 * compaction starts a fresh stream.
 */
const idleCompactionEventIds = new Map<string, { turnId: string; sequence: number }>();

function idleCompactionIdentity(
  sessionId: string,
  terminal: boolean,
): { sessionId: string; turnId: string; sequence: number } | null {
  // A turn is starting (chat:send's send-time sync compaction window) — a
  // synthetic turnId here would poison the renderer's turn affinity before
  // the real turn's first event arrives and the whole turn would be dropped.
  if (sessionsStarting.has(sessionId)) return null;
  let entry = idleCompactionEventIds.get(sessionId);
  if (!entry) {
    entry = { turnId: randomUUID(), sequence: 0 };
    idleCompactionEventIds.set(sessionId, entry);
  }
  entry.sequence += 1;
  const identity = { sessionId, turnId: entry.turnId, sequence: entry.sequence };
  if (terminal) idleCompactionEventIds.delete(sessionId);
  return identity;
}

/**
 * Emit a typed compaction-progress event through the sequenced turn-event
 * broadcast. Replaces the synthetic `'compaction'` tool-call channel (review
 * #37): no JSON-stringified state, no `toolName` interception, no fake
 * tool-result. The renderer derives widget lifecycle from this event live and
 * from the persisted `compacted` marker on replay.
 *
 * `options.clientId` lets turn-lifecycle call sites deliver on their own
 * sender (the same client the turn events stream to); without it the active
 * agent's window is used only when the installed sink can deliver to it.
 *
 * Idle sessions (manual `/compact` — no ActiveAgent owns a turn identity)
 * emit through a per-session synthetic identity via `sendSessionEvent`, so
 * the widget lifecycle works outside any turn. Silent only while a turn is
 * starting: the send-time synchronous compaction must not mint a synthetic
 * turnId the renderer could bind to before the real turn's first event.
 */
export function emitCompactionProgress(
  sessionId: string,
  phase: CompactionProgressPhase,
  detail?: string,
  options?: {
    clientId?: HostClientId;
    mode?: CompactionProgressEvent['mode'];
    streamText?: string | null;
    estimatedTokens?: number | null;
  },
): void {
  if (phase === 'complete' || phase === 'failed') {
    compactionProgressEpochs.set(sessionId, (compactionProgressEpochs.get(sessionId) ?? 0) + 1);
  }
  const payload: Record<string, unknown> = {
    type: 'compaction_progress',
    agentScopeId: MAIN_AGENT_SCOPE_ID,
    phase,
    ...(detail !== undefined ? { detail } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    ...(options?.streamText !== undefined ? { streamText: options.streamText } : {}),
    ...(options?.estimatedTokens !== undefined ? { estimatedTokens: options.estimatedTokens } : {}),
  };
  const active = activeAgents.get(sessionId);
  if (active && !active.finalized) {
    const clientId = options?.clientId
      ?? (canDeliverTo(active.windowId) ? active.windowId : null);
    if (clientId == null) return;
    sendTurnEvent(clientId, active, IPC_CHANNELS.CHAT_COMPACTION_PROGRESS, payload);
    return;
  }
  const identity = idleCompactionIdentity(sessionId, phase === 'complete' || phase === 'failed');
  if (!identity) return;
  sendSessionEvent(null, sessionId, IPC_CHANNELS.CHAT_COMPACTION_PROGRESS, { ...identity, ...payload });
}

/**
 * Complete the compaction widget by emitting a terminal progress event.
 * Replaces the old `completeCompactionWidget` — no synthetic tool-result needed.
 */
function completeCompactionWidget(sessionId: string, detail?: string): void {
  try {
    emitCompactionProgress(sessionId, 'complete', detail);
    clearCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
  } catch {
    // widget completion is best-effort
  }
}

export function clearCompactionState(sessionId: string): void {
  compactionTriggers.delete(sessionId);
  clearCompactionPendingsForSession(sessionId);
  clearCompactionPausesForSession(sessionId);
  triggerCalibrationHydrated.delete(sessionId);
  selectiveRunsInFlight.delete(sessionId);
  idleCompactionEventIds.delete(sessionId);
  compactionProgressEpochs.set(sessionId, (compactionProgressEpochs.get(sessionId) ?? 0) + 1);
  for (const key of [...compactionRetryTried]) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) compactionRetryTried.delete(key);
  }
}

/** Overflow-retry bookkeeping (one compaction-and-retry per turn, R15). */
export function hasTriedCompactionRetry(sessionId: string, turnId: string): boolean {
  return compactionRetryTried.has(`${sessionId}:${turnId}`);
}

export function markCompactionRetryTried(sessionId: string, turnId: string): void {
  compactionRetryTried.add(`${sessionId}:${turnId}`);
}

export function clearCompactionRetryTried(sessionId: string, turnId: string): void {
  compactionRetryTried.delete(`${sessionId}:${turnId}`);
}

/** Minimum interval between compaction live-progress emissions (IPC flood guard). */
export const COMPACTION_STREAM_EMIT_INTERVAL_MS = 100;

/**
 * Throttled live-progress emitter for the compaction widget: forwards the
 * compactor's accumulated LLM output as `compaction_progress` events with
 * phase `'compacting'`. Routes through `emitCompactionProgress`, so idle
 * sessions (manual `/compact`) get the widget too; safe to pass
 * unconditionally as `onTextDelta`. A trailing flush guarantees
 * the final accumulated text always lands even when deltas arrive in bursts.
 * Bound to the compaction epoch at creation: once this compaction reaches a
 * terminal phase (or the session's compaction state is cleared and a later
 * compaction starts), this emitter goes permanently silent so its stale tail
 * can never resurrect the widget.
 */
export function createCompactionStreamEmitter(sessionId: string): (accumulatedText: string) => void {
  const boundEpoch = compactionProgressEpochs.get(sessionId) ?? 0;
  let lastEmitAt = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let latest = '';
  const flush = (): void => {
    trailingTimer = null;
    lastEmitAt = Date.now();
    if ((compactionProgressEpochs.get(sessionId) ?? 0) !== boundEpoch) return;
    let estimatedTokens: number | null = null;
    try {
      const tpc = getCompactionTrigger(sessionId).state.tokensPerChar;
      if (typeof tpc === 'number' && Number.isFinite(tpc) && tpc > 0) {
        estimatedTokens = Math.ceil(latest.length * tpc);
      }
    } catch {
      // trigger unavailable (test env) — char count remains the display
    }
    emitCompactionProgress(sessionId, 'compacting', undefined, {
      streamText: latest,
      estimatedTokens,
    });
  };
  return (accumulatedText: string): void => {
    latest = accumulatedText;
    if (trailingTimer) return;
    const remaining = COMPACTION_STREAM_EMIT_INTERVAL_MS - (Date.now() - lastEmitAt);
    if (remaining <= 0) {
      flush();
      return;
    }
    trailingTimer = setTimeout(flush, remaining);
  };
}

// Evict compaction Maps when a session is deleted — prevents unbounded growth.
try {
  onSessionDeleted((sessionId) => clearCompactionState(sessionId));
} catch {
  // manager may be unavailable in unit-test imports
}

export function getCompactionTrigger(sessionId: string): CompactionTrigger {
  let t = compactionTriggers.get(sessionId);
  if (!t) {
    t = new CompactionTrigger();
    compactionTriggers.set(sessionId, t);
  }
  return t;
}

// Sessions whose trigger calibration was already seeded from persistence.
const triggerCalibrationHydrated = new Set<string>();

/**
 * Seed an uncalibrated trigger from persisted observations so calibration
 * survives restarts: the accounting DB keeps per-step context snapshots with
 * provider-reported input_tokens; the session chains' message usages are a
 * secondary source. Sets lastObservedInputTokens only — the tokens-per-char
 * ratio is derived against the live history where it is consumed.
 */
export async function hydrateTriggerCalibration(sessionId: string): Promise<void> {
  if (triggerCalibrationHydrated.has(sessionId)) return;
  const trigger = getCompactionTrigger(sessionId);
  if (trigger.state.tokensPerChar != null) {
    triggerCalibrationHydrated.add(sessionId);
    return;
  }
  triggerCalibrationHydrated.add(sessionId);
  let observed: number | null = null;
  try {
    // Lazy import: keeps the chat module-load graph free of the accounting
    // store chain (its config/loader dependency conflicts with test mocks).
    const { getContextSnapshotStore } = await import('../../providers/accounting/context-snapshot-store.js');
    observed = getContextSnapshotStore().latestMainInputTokens(sessionId);
  } catch {
    // store unavailable (not initialized / test env) — fall through
  }
  if (observed == null) {
    try {
      const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
      for (let i = chains.length - 1; i >= 0 && observed == null; i -= 1) {
        const msgs = chains[i]?.messages ?? [];
        for (let j = msgs.length - 1; j >= 0; j -= 1) {
          const usage = msgs[j]!.usage;
          const input = usage?.context?.input_tokens ?? usage?.prompt_tokens;
          if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
            observed = input;
            break;
          }
        }
      }
    } catch {
      // non-fatal — skip
    }
  }
  if (observed != null) {
    trigger.state.lastObservedInputTokens = observed;
  }
}

export { dedupeHistoryById };

function totalChars(messages: readonly Message[]): number {
  return totalCharsForMessages(messages);
}

/**
 * Resolve the main scope's exempt user ids from its CURRENT config over the
 * given history — one set per attempt, threaded into the gate's selectCut AND
 * every apply builder so the cut math and the settle cannot diverge.
 */
function mainExemptIds(
  messages: readonly Message[],
  cfg: {
    readonly keep_last_user_messages?: number | null;
    readonly pin_first_user_message?: boolean;
  },
): Set<string> {
  return resolveUserExemptIds(messages, {
    keepLast: cfg.keep_last_user_messages ?? null,
    pinFirst: cfg.pin_first_user_message ?? true,
  });
}

/**
 * Record the compaction outcome on the summary head's marker: the calibrated
 * tokens-freed estimate (pre minus post), plus the compactor LLM's own cost
 * when the summarizer reported usage. Reclaim-only results (no summary head)
 * pass through unchanged.
 */
function stampApplyMetrics(
  applyResult: ApplyResult,
  estimatedInput: number,
  postTokens: number,
  compactorUsage?: { inputTokens?: number; outputTokens?: number } | null,
): ApplyResult {
  const tokensFreed =
    Number.isFinite(estimatedInput) && Number.isFinite(postTokens)
      ? Math.max(0, Math.floor(estimatedInput - postTokens))
      : undefined;
  const compactorTokens =
    compactorUsage &&
    typeof compactorUsage.inputTokens === 'number' && Number.isFinite(compactorUsage.inputTokens) &&
    typeof compactorUsage.outputTokens === 'number' && Number.isFinite(compactorUsage.outputTokens)
      ? { inputTokens: Math.floor(compactorUsage.inputTokens), outputTokens: Math.floor(compactorUsage.outputTokens) }
      : undefined;
  return stampCompactionMetrics(applyResult, {
    ...(tokensFreed != null && tokensFreed > 0 ? { tokensFreed } : {}),
    ...(compactorTokens ? { compactorTokens } : {}),
  });
}

// ── Selective persistence helper (minimal between-turns) ─────────────────────

interface SelectivePersistInput {
  /** Flat history the selective/fallback pass ran over (settled-flag base). */
  readonly messages: readonly Message[];
  /** Ids the selective/fallback result removed from the model view (pre-settle). */
  readonly flaggedIds: readonly string[];
  /** Mechanical-reclaim ids from the gate; merged into the settled flags. */
  readonly reclaimedIds?: readonly string[];
  /** The run's materialized replay (synthetic summaries + ranged copies + kept). */
  readonly replayMessages: readonly Message[];
  readonly cut: CutResult;
  /** Apply-time exempt user ids; the scoped settle keeps them in the model view. */
  readonly exemptIds?: ReadonlySet<string> | readonly string[];
}

/** Outcome of persistSelectiveCompaction. */
interface SelectivePersistOutcome {
  readonly ok: boolean;
  /**
   * Transcript-complete flat view of what the durable write produced — the
   * settled history (flagged originals preserved) with the new summary rows
   * spliced INLINE at the same anchor storage used. Mid-turn callers hand
   * this to the turn as its durable base so checkpoints and the finalize
   * rewrite never replace the active row with the model-view replay (which
   * drops flagged originals and superseded heads — review #54).
   */
  readonly transcriptMessages?: Message[];
}

/**
 * Persist a successful selective compaction as one targeted durable
 * transaction (R20): settled flags + the run's new replay rows inserted
 * before the preserved window. The flag/settle computation is delegated to
 * the shared never-delete builder `buildSelectiveCompactionApply` (R35) so
 * the main scope's durable flags are exactly the ids the subagent scope
 * excludes from its model view for identical inputs; this helper owns only
 * main's write shape (targeted transaction, cache refresh, re-anchoring).
 */
function persistSelectiveCompaction(sessionId: string, input: SelectivePersistInput): SelectivePersistOutcome {
  try {
    const manager = getSessionManager();
    const existing = manager.getSession(sessionId) ?? manager.load(sessionId);
    // No loadable session means nothing durable to write against — report
    // failure (aligned with persistCompactionBetweenTurns) so the caller
    // treats the compaction as not-applied instead of silently dropping it.
    if (!existing) return { ok: false };
    // R35: one never-delete selective-settle for both scopes. summaryText is
    // null here — main persists the replay rows as the summary chain below
    // rather than one composed summary head; the builder contributes the
    // settled flag set (user-filtered, reclaim-merged, deduped).
    const settled = buildSelectiveCompactionApply({
      messages: input.messages,
      chains: existing.chains as unknown as Chain[],
      cutResult: input.cut,
      flaggedIds: input.flaggedIds,
      ...(input.reclaimedIds ? { reclaimedIds: input.reclaimedIds } : {}),
      ...(input.exemptIds ? { exemptIds: input.exemptIds } : {}),
      summaryText: null,
      sessionId,
    });
    const flaggedSet = new Set(settled?.flaggedIds ?? []);
    const updatedAt = new Date().toISOString();
    // New replay rows produced by the selective run (synthetic summaries +
    // ranged copies) — every replay id that is not already durable.
    const existingIds = new Set(existing.chains.flatMap((c) => c.messages.map((m) => m.id)));
    const newReplayMessages = input.replayMessages.filter((m) => !existingIds.has(m.id)) as Message[];
    // One durable summary-head row (R20) holding the new replay material in
    // replay order, inserted before the preserved window. Unified id scheme
    // (#11): randomUUID() — one scheme for synthesized compactor chains across
    // the main and subagent scopes.
    let summaryChain: Chain | null = null;
    if (newReplayMessages.length > 0) {
      summaryChain = {
        id: randomUUID(),
        sessionId,
        messages: newReplayMessages as unknown as readonly Message[],
        status: ChainStatus.COMPLETED,
        selection: null,
        modelLabel: null,
        agentName: 'compactor',
        agentType: 'internal' as const,
        agentTier: 'seed' as const,
        subagentRecord: null,
        startTime: updatedAt,
        endTime: updatedAt,
        errorDetail: null,
        errorTitle: null,
      } as Chain;
    }
    const flatOriginal: Message[] = existing.chains.flatMap((c) => c.messages as unknown as Message[]);
    const preserveStart = input.cut.compactableRange.end;
    const insertBeforeMessageId = preserveStart < flatOriginal.length
      ? flatOriginal[preserveStart]!.id
      : null;
    // Single targeted durable transaction (same P0-safe path as the simple
    // mode): flags + summary head against FULL durable chain rows — never a
    // wholesale saveSession from the bounded in-memory view, which would
    // truncate pre-window history and wipe durable subagent rows. The
    // settle-cleared ids (covered-kept resets / exempt users) ride the same
    // transaction so no stale true flag survives on the durable rows.
    const durable = persistCompactionDurable({
      sessionId,
      flaggedMessageIds: [...flaggedSet],
      clearedMessageIds: settled?.unflaggedIds ?? [],
      summaryChain,
      insertBeforeMessageId,
      updatedAt,
    });
    // Refresh the in-memory cache from durable rows so the renderer's
    // compaction reload sees the true post-write chain layout. Model replay
    // history is maintained separately via setChatHistory.
    if (durable) {
      publishCompactedSession(manager, sessionId, existing, updatedAt);
    }
    // Transcript view mirroring the durable write (storage inlines the
    // summary rows into the anchor chain at the anchor index): settled flat
    // history + the fresh replay rows at the same position.
    let transcriptMessages: Message[] = [...(settled?.updatedMessages ?? [...input.messages])];
    if (newReplayMessages.length > 0) {
      const anchorIndex = insertBeforeMessageId != null
        ? transcriptMessages.findIndex((m) => m.id === insertBeforeMessageId)
        : -1;
      const insertAt = anchorIndex >= 0 ? anchorIndex : transcriptMessages.length;
      transcriptMessages = [
        ...transcriptMessages.slice(0, insertAt),
        ...newReplayMessages,
        ...transcriptMessages.slice(insertAt),
      ];
    }
    return { ok: true, transcriptMessages };
  } catch (err) {
    console.debug('[compaction] selective chain persist failed (non-fatal):', err);
    return { ok: false };
  }
}

// One shared persistSelectiveCompaction input for every selective and
// fallback-replay call site: the run's own flagged ids lead, the prepare-time
// reclaim flags merge in only when non-empty, and the exempt set threads
// through only when one was resolved.
function buildSelectivePersistInput(input: {
  readonly messages: readonly Message[];
  readonly flaggedIds: readonly string[];
  readonly reclaimedIds: readonly string[];
  readonly exemptIds?: ReadonlySet<string>;
  readonly replayMessages: readonly Message[];
  readonly cut: CutResult;
}): SelectivePersistInput {
  return {
    messages: input.messages,
    flaggedIds: input.flaggedIds,
    ...(input.reclaimedIds.length > 0 ? { reclaimedIds: input.reclaimedIds } : {}),
    ...(input.exemptIds ? { exemptIds: input.exemptIds } : {}),
    replayMessages: input.replayMessages,
    cut: input.cut,
  };
}

/**
 * Re-anchor a prepare-time selective replay onto the CURRENT history (P1 #5).
 *
 * `replayMessages` was materialized when the pending was prepared; consuming it
 * wholesale would drop everything appended since — most importantly the next
 * turn's user message (which then never reaches the model) while the caller's
 * `existingMessages` derivation strips a preserved message instead. The
 * prepare-time materialization of the compactable prefix stays valid; only the
 * preserved suffix is re-derived from the apply-time history, starting at the
 * pending's cut index.
 */
function reanchorSelectiveReplay(
  replayMessages: readonly Message[],
  applyTimeHistory: readonly Message[],
  cutIndex: number,
  rangeStart = 0,
): Message[] {
  const clampedCut = Math.max(0, Math.min(cutIndex, applyTimeHistory.length));
  const boundaryId = applyTimeHistory[clampedCut]?.id;
  let prefixEnd = replayMessages.length;
  if (boundaryId != null) {
    // The preserved suffix starts at the boundary message; everything before it
    // in the replay is the prepare-time materialization (kept messages, ranged
    // copies, synthetic summaries). Ranged copies carry fresh `:range:` ids, so
    // original ids never collide with the boundary.
    const boundaryIndex = replayMessages.findIndex((m) => m.id === boundaryId);
    if (boundaryIndex >= 0) prefixEnd = boundaryIndex;
  }
  const prefix = replayMessages.slice(0, prefixEnd);
  const suffix = applyTimeHistory.slice(clampedCut);
  // R31: visible messages below the compactable range start (pinned user
  // messages the range skips) never enter the manifest, so the replay carries
  // neither their ops nor a preserve copy — re-attach them from the apply-time
  // history or they would silently leave the model view.
  const exemptPrefix = applyTimeHistory
    .slice(0, Math.max(0, rangeStart))
    .filter((m) => !m.excludeFromModel && !m.hidden);
  return dedupeHistoryById([...exemptPrefix, ...prefix, ...suffix]);
}

export async function applyPendingCompactionIfAny(
  sessionId: string,
  messages: Message[],
  runtime: ProjectRuntime,
): Promise<{ applied: boolean; updatedMessages?: Message[]; transcriptMessages?: Message[] }> {
  const pending = takeCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID);
  if (!pending) return { applied: false };
  // The pending cut/expectedIds were computed over the deduped history
  // (handleUsageCompaction dedupes). Mid-turn callers concatenate
  // [...messages, ...turnMessagesFromAgent()] where the turn base repeats
  // the triggering user message, so dedupe here or the index-anchored
  // validation below rejects every mid-turn apply.
  const history = dedupeHistoryById(messages);
  if (!isPendingCutStillValid(pending, history)) {
    failPendingApply(
      sessionId,
      getCompactionTrigger(sessionId),
      `pending cut invalidated before apply (range [${pending.cut.compactableRange.start},${pending.cut.compactableRange.end}) no longer matches live history) — discarding prepared compaction`,
    );
    return { applied: false };
  }
  const trigger = getCompactionTrigger(sessionId);
  // Apply-time exempt resolution from the CURRENT config (config may change
  // between prepare and apply): one set per apply, threaded into every
  // builder below so the cut math and the settle cannot diverge.
  const mainCfg = runtime.config.compaction?.main;
  const exemptIds = mainCfg ? mainExemptIds(history, mainCfg) : undefined;
  try {
    // ── Selective pending ───────────────────────────────────────────────
    if (pending.mode === 'selective' && pending.selectivePromise) {
      const outcome = await pending.selectivePromise;
      if (outcome.kind !== 'ran') {
        failPendingApply(sessionId, trigger, `selective run produced no applicable result (${outcome.reason}) — skipping apply`);
        return { applied: false };
      }
      const result = outcome.result;
      if (result.kind === 'selective') {
        // Atomic: DB first, then memory. Single DB write via persistSelectiveCompaction.
        const persistRes = persistSelectiveCompaction(sessionId, buildSelectivePersistInput({
          messages: history,
          flaggedIds: result.flaggedIds,
          reclaimedIds: pending.flaggedIds,
          exemptIds,
          replayMessages: result.replayMessages,
          cut: pending.cut,
        }));
        if (!persistRes.ok) {
          failPendingApply(sessionId, trigger, 'selective persist failed — compaction not applied');
          return { applied: false };
        }
        // Re-anchor at apply time: the prepare-time replay never saw messages
        // appended after the prepare (e.g. the NEXT turn's user message), so
        // only its compactable prefix is reused — the preserved suffix is
        // re-derived from the current history (P1 #5).
        const reanchored = reanchorSelectiveReplay(result.replayMessages, history, pending.cut.cutIndex, pending.cut.compactableRange.start);
        setChatHistory(sessionId, [...reanchored]);
        const postTokens = (() => {
          const tpc = trigger.state.tokensPerChar ?? (totalChars(reanchored) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
          return tpc ? Math.ceil(totalChars(reanchored) * tpc) : pending.estimatedInput;
        })();
        trigger.onCompactionApplied(pending.estimatedInput, postTokens);
        trigger.abortPrepare();
        completeCompactionWidget(sessionId);
        return {
          applied: true,
          updatedMessages: [...reanchored],
          ...(persistRes.transcriptMessages ? { transcriptMessages: [...persistRes.transcriptMessages] } : {}),
        };
      }
      if (result.kind === 'fallback' && result.fallbackText && result.fallbackText.trim()) {
        const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
        let applyResult = buildCompactionApply({
          messages: history,
          chains: chains as Chain[],
          cutResult: pending.cut,
          summaryText: result.fallbackText,
          mode: runtime.config.compaction.main.mode,
          flaggedIds: pending.flaggedIds,
          ...(exemptIds ? { exemptIds } : {}),
          sessionId,
        });
        if (applyResult.didApply) {
          // R31: the scoped settle inside buildCompactionApply already keeps
          // exempt user ids out of the flagged set in every mode — no
          // scope-specific un-flag pass is needed here.
          const tpc = trigger.state.tokensPerChar ?? (totalChars(applyResult.updatedMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
          const postTokens = tpc ? Math.ceil(totalChars(applyResult.updatedMessages) * tpc) : pending.estimatedInput;
          applyResult = stampApplyMetrics(applyResult, pending.estimatedInput, postTokens);
          const ok = persistCompaction(sessionId, applyResult);
          if (ok) {
            setChatHistory(sessionId, [...applyResult.updatedMessages]);
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
            trigger.abortPrepare();
            completeCompactionWidget(sessionId);
            return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
          }
        }
        if (result.replayMessages && result.replayMessages.length > 0) {
          // Fallback replay without summary — same targeted selective write
          // (flags from the shared never-delete settle, replay rows as the
          // summary chain), then the same apply-time re-anchoring as the
          // selective-success branch (P1 #5).
          const persistRes = persistSelectiveCompaction(sessionId, buildSelectivePersistInput({
            messages: history,
            flaggedIds: result.flaggedIds ?? pending.flaggedIds,
            reclaimedIds: pending.flaggedIds,
            exemptIds,
            replayMessages: result.replayMessages,
            cut: pending.cut,
          }));
          let reanchored: Message[] | undefined;
          if (persistRes.ok) {
            reanchored = reanchorSelectiveReplay(result.replayMessages, history, pending.cut.cutIndex, pending.cut.compactableRange.start);
            setChatHistory(sessionId, [...reanchored]);
            const tpc = trigger.state.tokensPerChar ?? (totalChars(reanchored) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
            const postTokens = tpc ? Math.ceil(totalChars(reanchored) * tpc) : pending.estimatedInput;
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
          } else {
            trigger.onApplyFailed();
          }
          trigger.abortPrepare();
          completeCompactionWidget(sessionId);
          return {
            applied: persistRes.ok,
            updatedMessages: reanchored ? [...reanchored] : undefined,
            ...(persistRes.ok && persistRes.transcriptMessages ? { transcriptMessages: [...persistRes.transcriptMessages] } : {}),
          };
        }
      }
      failPendingApply(sessionId, trigger, 'selective run produced no applicable result — discarding pending');
      return { applied: false };
    }
    // ── Simple pending (existing) ───────────────────────────────────────
    if (pending.promise) {
      const result = await pending.promise;
      if (result && result.text && result.text.trim()) {
        const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
        let applyResult = buildCompactionApply({
          messages: history,
          chains: chains as Chain[],
          cutResult: pending.cut,
          summaryText: result.text,
          mode: runtime.config.compaction.main.mode,
          flaggedIds: pending.flaggedIds,
          ...(exemptIds ? { exemptIds } : {}),
          sessionId,
        });
        if (applyResult.didApply) {
          const tpc = trigger.state.tokensPerChar ?? (totalChars(applyResult.updatedMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
          const postTokens = tpc ? Math.ceil(totalChars(applyResult.updatedMessages) * tpc) : pending.estimatedInput;
          applyResult = stampApplyMetrics(applyResult, pending.estimatedInput, postTokens, result.usage);
          const ok = persistCompaction(sessionId, applyResult);
          if (ok) {
            setChatHistory(sessionId, [...applyResult.updatedMessages]);
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
            trigger.abortPrepare();
            completeCompactionWidget(sessionId);
            return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
          }
        }
      }
      // Summarizer failed or persist failed — clear pending flag
      failPendingApply(sessionId, trigger, 'simple summarizer failed or persist failed — clearing pending');
      return { applied: false };
    }
    // Reclaim-only pending
    if (pending.flaggedIds.length > 0) {
      const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
      const applyResult = buildCompactionApply({
        messages: history,
        chains: chains as Chain[],
        cutResult: pending.cut,
        summaryText: null,
        mode: runtime.config.compaction.main.mode,
        flaggedIds: pending.flaggedIds,
        ...(exemptIds ? { exemptIds } : {}),
        sessionId,
      });
      if (applyResult.didApply) {
        const ok = persistCompaction(sessionId, applyResult);
        if (ok) {
          setChatHistory(sessionId, [...applyResult.updatedMessages]);
          const tpc = trigger.state.tokensPerChar ?? (totalChars(applyResult.updatedMessages) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
          const postTokens = tpc ? Math.ceil(totalChars(applyResult.updatedMessages) * tpc) : pending.estimatedInput;
          trigger.onCompactionApplied(pending.estimatedInput, postTokens);
          completeCompactionWidget(sessionId);
          return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
        }
      }
    }
    // Fall-through (reclaim-only that did not apply, or a pending with neither
    // promise nor flagged ids): clear the prepare so a stuck pendingPrepare
    // cannot silence every future trigger evaluation for the session.
    failPendingApply(sessionId, trigger, 'pending produced no applicable compaction — clearing prepare');
  } catch (err) {
    failPendingApply(sessionId, getCompactionTrigger(sessionId), `pending apply failed (non-fatal): ${String(err)}`);
  }
  return { applied: false };
}

export async function tryCompactSynchronously(
  sessionId: string,
  messages: Message[],
  runtime: ProjectRuntime,
  selection: ModelSelection,
  contextTokens: number | null,
  accountingStore: ProviderAccountingStore,
  chainId: string | null,
  turnId: string,
  opts?: { manual?: boolean },
): Promise<{ didApply: boolean; updatedMessages?: Message[]; transcriptMessages?: Message[]; reason?: string }> {
  const trigger = getCompactionTrigger(sessionId);
  const cfg = runtime.config.compaction?.main;
  if (!cfg) return { didApply: false, reason: 'compaction-disabled' };
  // Models without a configured context window never compact proactively:
  // fabricating an assumed window here diverged from the mid-turn usage path,
  // which is disabled when the limit is unknown. Manual compaction shares the
  // rule — without a window there is no preserve budget to compute.
  if (contextTokens == null || !Number.isFinite(contextTokens) || contextTokens <= 0) return { didApply: false, reason: 'no-context-window' };
  if (trigger.state.pendingPrepare) return { didApply: false, reason: 'prepare-in-flight' };
  // A selective run orphaned by a discarded pending may still be streaming;
  // starting another here would duplicate the compactor LLM call. The backoff
  // is deliberately NOT consulted here — the overflow-retry caller treats
  // compaction as an emergency recovery path and must bypass the cooldown.
  if (isSelectiveRunInFlight(sessionId)) return { didApply: false, reason: 'selective-in-flight' };
  // One exempt set per attempt: the gate's selectCut, the selective runner,
  // and every apply below consume the same resolved set.
  const exemptIds = mainExemptIds(messages, cfg);
  try {
    const decision = runCompactionGate({
      messages,
      config: cfg,
      scope: 'main',
      inputTokens: null,
      contextTokens,
      tokensPerChar: trigger.state.tokensPerChar ?? null,
      triggerState: trigger.state,
      exemptIds,
      ...(opts?.manual ? { manual: true } : {}),
    });
    if (decision.kind === 'no-op') return { didApply: false, reason: decision.reason };
    const { cut, flaggedIds, estimatedInput, tokensPerChar } = decision;
    const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
    if (decision.kind === 'reclaim-only') {
      const applyResult = buildCompactionApply({
        messages,
        chains: chains as Chain[],
        cutResult: cut,
        summaryText: null,
        mode: cfg.mode,
        flaggedIds,
        exemptIds,
        sessionId,
      });
      if (!applyResult.didApply) return { didApply: false };
      const ok = persistCompaction(sessionId, applyResult);
      if (!ok) return { didApply: false };
      setChatHistory(sessionId, [...applyResult.updatedMessages]);
      const tpc2 = trigger.state.tokensPerChar ?? tokensPerChar;
      const postTokens = Math.ceil(totalChars(applyResult.updatedMessages) * tpc2);
      trigger.onCompactionApplied(estimatedInput, postTokens);
      return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
    }
    if (decision.kind === 'prepare') {
      // ── Selective branch ──────────────────────────────────────────────
      if (cfg.mode === 'selective') {
        const slice = compactableModelSlice(messages, cut.compactableRange);
        if (slice.length === 0) return { didApply: false };
        let attempt: CompactionAttemptOutcome;
        try {
          attempt = await runCompactionAttempt({
            messages,
            cut,
            scope: 'main',
            config: runtime.config,
            exemptIds,
            deps: {
              fallbackSelection: selection,
              runtime,
              accounting: { store: accountingStore, sessionId, chainId, turnId },
              onPrepared: () => trigger.markPrepareStarted(cut.compactableRange, flaggedIds),
              onTextDelta: createCompactionStreamEmitter(sessionId),
            },
            maxCorrectionRounds: 3,
          });
        } catch (err) {
          console.debug('[compaction] selective run failed, falling back (non-fatal):', err);
          trigger.abortPrepare();
          return { didApply: false };
        }
        if (attempt.kind === 'noop') return { didApply: false };
        const selResult = attempt.result;
        if (selResult.kind === 'selective') {
          const persistRes = persistSelectiveCompaction(sessionId, buildSelectivePersistInput({
            messages,
            flaggedIds: selResult.flaggedIds,
            reclaimedIds: flaggedIds,
            exemptIds,
            replayMessages: selResult.replayMessages,
            cut,
          }));
          if (!persistRes.ok) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...selResult.replayMessages]);
          const tpcSel = trigger.state.tokensPerChar ?? tokensPerChar;
          const postTokensSel = Math.ceil(totalChars(selResult.replayMessages) * tpcSel);
          trigger.onCompactionApplied(estimatedInput, postTokensSel);
          trigger.abortPrepare();
          return {
            didApply: true,
            updatedMessages: [...selResult.replayMessages],
            ...(persistRes.transcriptMessages ? { transcriptMessages: [...persistRes.transcriptMessages] } : {}),
          };
        }
        if (selResult.kind === 'fallback' && selResult.fallbackText && selResult.fallbackText.trim()) {
          let applyResult = buildCompactionApply({
            messages,
            chains: chains as Chain[],
            cutResult: cut,
            summaryText: selResult.fallbackText,
            mode: cfg.mode,
            flaggedIds,
            exemptIds,
            sessionId,
          });
          if (!applyResult.didApply) {
            if (selResult.replayMessages && selResult.replayMessages.length > 0) {
              // Fallback replay without a usable summary — same targeted
              // selective write (flags from the shared never-delete settle,
              // replay rows as the summary chain). If flaggedIds were derived
              // from the manifest they lead; the gate's reclaim flags merge.
              const persistRes2 = persistSelectiveCompaction(sessionId, buildSelectivePersistInput({
                messages,
                flaggedIds: selResult.flaggedIds ?? flaggedIds,
                reclaimedIds: flaggedIds,
                exemptIds,
                replayMessages: selResult.replayMessages!,
                cut,
              }));
              if (persistRes2.ok) {
                setChatHistory(sessionId, [...selResult.replayMessages!]);
                const tpcF = trigger.state.tokensPerChar ?? tokensPerChar;
                const postF = Math.ceil(totalChars(selResult.replayMessages!) * tpcF);
                trigger.onCompactionApplied(estimatedInput, postF);
              }
              trigger.abortPrepare();
              return {
                didApply: persistRes2.ok,
                updatedMessages: persistRes2.ok ? [...selResult.replayMessages!] : undefined,
                ...(persistRes2.ok && persistRes2.transcriptMessages ? { transcriptMessages: [...persistRes2.transcriptMessages] } : {}),
              };
            }
            trigger.abortPrepare();
            return { didApply: false };
          }
          // R31: the scoped settle inside buildCompactionApply already keeps
          // exempt user ids out of the flagged set in every mode — no
          // scope-specific un-flag pass is needed here.
          const tpcF2 = trigger.state.tokensPerChar ?? tokensPerChar;
          const postF2 = Math.ceil(totalChars(applyResult.updatedMessages) * tpcF2);
          applyResult = stampApplyMetrics(applyResult, estimatedInput, postF2);
          const ok = persistCompaction(sessionId, applyResult);
          if (!ok) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...applyResult.updatedMessages]);
          trigger.onCompactionApplied(estimatedInput, postF2);
          trigger.abortPrepare();
          return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
        }
        if (selResult.kind === 'fallback' && selResult.replayMessages && selResult.replayMessages.length > 0) {
          const persistRes3 = persistSelectiveCompaction(sessionId, buildSelectivePersistInput({
            messages,
            flaggedIds: selResult.flaggedIds ?? flaggedIds,
            reclaimedIds: flaggedIds,
            exemptIds,
            replayMessages: selResult.replayMessages,
            cut,
          }));
          if (!persistRes3.ok) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...selResult.replayMessages]);
          const tpcF3 = trigger.state.tokensPerChar ?? tokensPerChar;
          const postF3 = Math.ceil(totalChars(selResult.replayMessages) * tpcF3);
          trigger.onCompactionApplied(estimatedInput, postF3);
          trigger.abortPrepare();
          return {
            didApply: true,
            updatedMessages: [...selResult.replayMessages],
            ...(persistRes3.transcriptMessages ? { transcriptMessages: [...persistRes3.transcriptMessages] } : {}),
          };
        }
        trigger.abortPrepare();
        return { didApply: false };
      }
      // ── Simple branch (unchanged) ─────────────────────────────────────
      const rawSlice2 = messages.slice(cut.compactableRange.start, cut.compactableRange.end);
      const slice = rawSlice2.filter((m) => !m.excludeFromModel && !m.hidden);
      if (slice.length === 0) return { didApply: false };
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      const simpleBridge = buildCompactionBridgeContext(messages, cut.compactableRange);
      const result: SummarizeResult | null = await summarizeCompactableRange({
        messages: slice,
        scope: 'main',
        config: runtime.config,
        fallbackSelection: selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
        runtime,
        onTextDelta: createCompactionStreamEmitter(sessionId),
        ...(simpleBridge ? { bridgeContext: simpleBridge } : {}),
      });
      if (!result || !result.text || !result.text.trim()) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      let applyResult = buildCompactionApply({
        messages,
        chains: chains as Chain[],
        cutResult: cut,
        summaryText: result.text,
        mode: cfg.mode,
        flaggedIds,
        exemptIds,
        sessionId,
      });
      if (!applyResult.didApply) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      const tpcSimple = trigger.state.tokensPerChar ?? tokensPerChar;
      const postSimple = Math.ceil(totalChars(applyResult.updatedMessages) * tpcSimple);
      applyResult = stampApplyMetrics(applyResult, estimatedInput, postSimple, result.usage);
      const ok = persistCompaction(sessionId, applyResult);
      if (!ok) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      setChatHistory(sessionId, [...applyResult.updatedMessages]);
      trigger.onCompactionApplied(estimatedInput, postSimple);
      trigger.abortPrepare();
      return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
    }
  } catch (err) {
    console.debug('[compaction] synchronous compact failed (non-fatal):', err);
    try { getCompactionTrigger(sessionId).abortPrepare(); } catch {
      // abort cleanup is best-effort after a failed compact
    }
  }
  return { didApply: false };
}

// Arm one freshly-registered pending: emit its preparing widget event, then
// request the compaction pause and publish the working activity — the latter
// two only when the session has no compaction pause armed yet. The activity
// detail mirrors the widget detail (first letter lowercased) under the shared
// "Compacting context — …" prefix.
function armPendingAndPause(
  sessionId: string,
  runtime: ProjectRuntime,
  mode: CompactionProgressEvent['mode'],
  detail: string,
): void {
  try {
    emitCompactionProgress(sessionId, 'preparing', detail, { mode });
  } catch {
    // widget progress is best-effort
  }
  if (!shouldPauseForCompaction(sessionId, MAIN_AGENT_SCOPE_ID)) {
    requestCompactionPause(sessionId, MAIN_AGENT_SCOPE_ID);
    publishSessionActivity(sessionId, {
      cwd: runtime.projectDir ?? '',
      state: 'working',
      phase: 'agent',
      detail: `Compacting context — ${detail.charAt(0).toLowerCase()}${detail.slice(1)}…`,
      canCancel: true,
    });
  }
}

// Widget teardown when a prepare promise rejects before apply; `label`
// distinguishes the prepare kind in the debug log.
function settlePrepareRejection(sessionId: string, label: string, err: unknown): void {
  console.debug(`[compaction] ${label} failed (non-fatal):`, err);
  completeCompactionWidget(sessionId);
}

/**
 * Uniform terminal handling for a pending apply that cannot be applied
 * (invalidated cut, unusable result, persist failure): warn, clear the
 * prepare, arm the re-prepare backoff, and settle the widget. Every discard
 * site routes through here so a failed apply always arms the cooldown that
 * stops the fire-and-forget compactor from re-preparing on every usage step.
 */
function failPendingApply(
  sessionId: string,
  trigger: ReturnType<typeof getCompactionTrigger>,
  reason: string,
): void {
  console.warn(`[compaction] ${reason}`);
  trigger.abortPrepare();
  trigger.onApplyFailed();
  completeCompactionWidget(sessionId);
}

export function handleUsageCompaction(
  sessionId: string,
  fullHistory: Message[],
  inputTokens: number,
  contextTokens: number,
  runtime: ProjectRuntime,
  selection: ModelSelection,
  accountingStore: ProviderAccountingStore,
  chainId: string | null,
  turnId: string,
): void {
  const trigger = getCompactionTrigger(sessionId);
  const cfg = runtime.config.compaction?.main;
  if (!cfg) return;
  // Unknown context window → compaction is disabled, mirroring the send-time path.
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return;
  const history = dedupeHistoryById(fullHistory);
  const effectiveContextTokens = contextTokens;
  const charCache = computeMessageCharCache(history);
  // Derive calibrated tokensPerChar from provider inputTokens / totalChars (no /4 fallback)
  let tokensPerChar: number | undefined = trigger.state.tokensPerChar;
  const derived = deriveTokensPerChar(inputTokens, charCache.total);
  if (derived != null) {
    tokensPerChar = derived;
    trigger.state.tokensPerChar = derived;
  }
  trigger.state.lastObservedInputTokens = inputTokens;
  trigger.onUsage(inputTokens, effectiveContextTokens, cfg.threshold, cfg.hysteresis_delta);
  if (trigger.state.pendingPrepare) return;
  if (getCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID)) return;
  // Post-failure backoff: a discarded/unusable prepare arms a cooldown so the
  // fire point stops re-preparing on every step while a compactor run may
  // still be orphaned in-flight.
  if (trigger.inApplyBackoff()) return;
  if (isSelectiveRunInFlight(sessionId)) return;
  // Prepare-time exempt resolution (one set per attempt): the gate's
  // selectCut and the selective runner consume the same resolved set; the
  // later apply re-resolves from the config current at apply time.
  const exemptIds = mainExemptIds(history, cfg);
  try {
    const decision = runCompactionGate({
      messages: history,
      config: cfg,
      scope: 'main',
      inputTokens,
      contextTokens: effectiveContextTokens,
      tokensPerChar: tokensPerChar ?? null,
      triggerState: trigger.state,
      charCache,
      exemptIds,
    });
    if (decision.kind === 'no-op') return;
    const { cut, flaggedIds } = decision;
    if (decision.kind === 'reclaim-only') {
      const expectedIds = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
      setCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID, { cut, flaggedIds, expectedIds, estimatedInput: decision.estimatedInput, contextTokens: effectiveContextTokens, mode: cfg.mode });
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      armPendingAndPause(sessionId, runtime, cfg.mode, 'Reclaiming duplicates');
      return;
    }
    if (decision.kind === 'prepare') {
      // ── Selective pending branch ──────────────────────────────────────
      if (cfg.mode === 'selective') {
        const slice = compactableModelSlice(history, cut.compactableRange);
        if (slice.length === 0) return;
        const selectivePromise = runCompactionAttempt({
          messages: history,
          cut,
          scope: 'main',
          config: runtime.config,
          exemptIds,
          deps: {
            fallbackSelection: selection,
            runtime,
            accounting: { store: accountingStore, sessionId, chainId, turnId },
            onPrepared: () => trigger.markPrepareStarted(cut.compactableRange, flaggedIds),
            onTextDelta: createCompactionStreamEmitter(sessionId),
          },
          maxCorrectionRounds: 3,
        });
        trackSelectiveRun(sessionId, selectivePromise);
        const expectedIdsForSelective = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
        setCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID, { cut, flaggedIds, expectedIds: expectedIdsForSelective, estimatedInput: decision.estimatedInput, contextTokens: effectiveContextTokens, mode: 'selective', selectivePromise });
        selectivePromise.catch((err) => settlePrepareRejection(sessionId, 'selective prepare', err));
        armPendingAndPause(sessionId, runtime, 'selective', 'Summarizing history');
        return;
      }
      // ── Simple pending branch (unchanged) ─────────────────────────────
      const rawSlice2 = history.slice(cut.compactableRange.start, cut.compactableRange.end);
      const slice = rawSlice2.filter((m) => !m.excludeFromModel && !m.hidden);
      if (slice.length === 0) return;
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      const simpleBridge = buildCompactionBridgeContext(history, cut.compactableRange);
      const promise = summarizeCompactableRange({
        messages: slice,
        scope: 'main',
        config: runtime.config,
        fallbackSelection: selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
        runtime,
        onTextDelta: createCompactionStreamEmitter(sessionId),
        ...(simpleBridge ? { bridgeContext: simpleBridge } : {}),
      });
      const expectedIdsForSimple = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
      setCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID, { cut, flaggedIds, expectedIds: expectedIdsForSimple, promise, estimatedInput: decision.estimatedInput, contextTokens: effectiveContextTokens, mode: 'simple' });
      promise.catch((err) => settlePrepareRejection(sessionId, 'prepare', err));
      armPendingAndPause(sessionId, runtime, 'simple', 'Summarizing history');
    }
  } catch (err) {
    console.debug('[compaction] usage trigger failed (non-fatal):', err);
  }
}

// ── Manual compaction (/compact) ─────────────────────────────────────────────

/**
 * User-initiated compaction on an idle session (`/compact`). Assembles the
 * inputs `startChatTurn` normally owns (history, runtime, selection, context
 * window, compactor attribution), consumes any pending a prior turn left
 * behind, then runs the synchronous compaction with the manual gate profile:
 * threshold/hysteresis and `min_compactable_tokens` are bypassed, the reclaim
 * short-circuit never answers, and calibrate-or-skip still applies.
 *
 * Refuses with `busy` while a turn is streaming or starting — the mid-turn
 * pause machinery owns compaction during a live turn. Post-apply broadcasts
 * ride the existing SESSION_COMPACTION / SESSION_UPDATED events the durable
 * persist path emits, so an idle renderer reloads without extra plumbing.
 */
export function compactSessionNow(
  sessionId: string,
  runtime: ProjectRuntime,
  selection: ModelSelection,
): Promise<ChatCompactResult> {
  // Hold the per-session operation gate across the whole compaction — busy
  // check through compaction persistence and the terminal widget event — so a
  // chat turn cannot start on a half-compacted history: startChatTurn waits
  // the gate out before claiming its turn-start slot.
  return runWithSessionOperationGate(sessionId, () => compactIdleSession(sessionId, runtime, selection));
}

async function compactIdleSession(
  sessionId: string,
  runtime: ProjectRuntime,
  selection: ModelSelection,
): Promise<ChatCompactResult> {
  const active = activeAgents.get(sessionId);
  if ((active && !active.finalized) || sessionsStarting.has(sessionId)) {
    return { status: 'busy', sessionId };
  }
  if (!runtime.config.compaction?.main) {
    return { status: 'nothing_to_compact', sessionId, detail: 'Compaction is disabled for this project.' };
  }
  await hydrateTriggerCalibration(sessionId);
  let messages: Message[];
  try {
    messages = getChatHistory(sessionId) ?? historyFromSession(sessionId);
  } catch (error) {
    return {
      status: 'error',
      error: `Could not load conversation history: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // A pending left behind by an interrupted turn IS the requested compaction
  // half-prepared — consume and apply it before starting a fresh prepare.
  const pendingApplied = await applyPendingCompactionIfAny(sessionId, messages, runtime);
  if (pendingApplied.applied) return { status: 'compacted', sessionId };
  if (pendingApplied.updatedMessages) messages = pendingApplied.updatedMessages;

  let contextTokens: number | null;
  try {
    const execution = await getProviderRuntime().resolveExecution(selection);
    contextTokens = execution.model.limits?.contextTokens ?? null;
  } catch (error) {
    return {
      status: 'error',
      error: `Provider unavailable for compaction: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let accountingStore: ProviderAccountingStore;
  try {
    accountingStore = getProviderAccountingStore();
  } catch (error) {
    return {
      status: 'error',
      error: `Accounting store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Attribute the compactor LLM attempt to the session's latest chain when one
  // exists; otherwise it lands chain-less like other out-of-turn work.
  let chainId: string | null = null;
  try {
    const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
    chainId = chains.length > 0 ? chains[chains.length - 1]!.id : null;
  } catch {
    // attribution is best-effort
  }
  // Widget feedback on the idle session: preparing opens the compaction
  // widget; the pending-consumption apply and the success path below emit the
  // terminal 'complete' phase themselves (completeCompactionWidget), and every
  // other exit emits 'failed' so the widget can never stay stuck on
  // 'preparing'/'compacting' and the idle event identity is cleared.
  emitCompactionProgress(sessionId, 'preparing', 'Compacting context', {
    mode: runtime.config.compaction.main.mode,
  });
  const result = await tryCompactSynchronously(
    sessionId, messages, runtime, selection, contextTokens, accountingStore, chainId, randomUUID(),
    { manual: true },
  );
  if (result.didApply) {
    completeCompactionWidget(sessionId);
    return { status: 'compacted', sessionId };
  }
  emitCompactionProgress(
    sessionId,
    'failed',
    result.reason ? `Compaction skipped — ${result.reason}` : 'Compaction produced no change',
  );
  return { status: 'nothing_to_compact', sessionId, ...(result.reason ? { detail: result.reason } : {}) };
}
