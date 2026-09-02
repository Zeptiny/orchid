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
 *
 * Structure: each fire point reads as a sequence of one-bump helpers over a
 * typed attempt/pending context — gate checks, calibration, estimate, prepare,
 * apply, widget settlement, persistence — so no single function owns a whole
 * compaction transaction.
 */
import { randomUUID } from 'node:crypto';
import type { ModelSelection } from '../../../shared/types/provider';
import { ChainStatus } from '../../../shared/types/chain';
import type { Chain } from '../../../shared/types/chain';
import type { Message } from '../../../shared/types/message';
import { IPC_CHANNELS, type ChatCompactResult } from '../../../shared/types/ipc';
import { MAIN_AGENT_SCOPE_ID } from '../../../shared/types/agent-scope';
import type { CompactionProgressEvent, CompactionProgressPhase } from '../../../shared/types/compaction-progress';
import type { CompactionScopeConfig } from '../../config/schema';
import type { ProjectRuntime } from '../../project/runtime';
import type { ProviderAccountingStore } from '../../providers/accounting/store';
import { getProviderRuntime } from '../../providers';
import { getProviderAccountingStore } from '../../providers/accounting/store';
import { getSessionManager } from '../../session/singleton';
import { onSessionDeleted } from '../../session/manager';
import { getChatHistory, setChatHistory } from './history';
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
  type CompactionPendingEntry,
} from '../../llm/compaction/pending-store';
import {
  computeMessageCharCache,
  deriveTokensPerChar,
  runCompactionGate,
  type CompactionGateAction,
  type CompactionGateInput,
  type MessageCharCache,
} from '../../llm/compaction/pipeline';
import {
  buildCompactionBridgeContext,
  summarizeCompactableRange,
  type SummarizeInput,
  type SummarizeResult,
} from '../../llm/compaction/summarize';
import {
  buildCompactionApply,
  buildSelectiveCompactionApply,
  stampCompactionMetrics,
  type ApplyInput,
  type ApplyResult,
  type SelectiveCompactionApplyInput,
} from '../../llm/compaction/apply';
import { CompactionTrigger } from '../../llm/compaction/trigger';
import {
  compactableModelSlice,
  runCompactionAttempt,
  type CompactionAttemptInput,
  type CompactionAttemptOutcome,
} from '../../llm/compaction/run-attempt';
import { activeAgents, runWithSessionOperationGate, sessionsStarting, type ActiveAgent } from './state';
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

// ── Shared reading predicates ──────────────────────────────────────────────

/** A token/calibration reading is only usable when it is a finite positive number. */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** A reported token count is usable at zero — only non-numbers are rejected. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A model context window a preserve budget can be computed against. */
function isUsableContextWindow(contextTokens: number | null | undefined): contextTokens is number {
  return isPositiveFinite(contextTokens);
}

/** A handoff summary text is usable only when it carries content. */
function hasUsableText(text: string | null | undefined): boolean {
  return !!text && text.trim().length > 0;
}

function hasUsableSummary(result: SummarizeResult | null | undefined): result is SummarizeResult {
  return result != null && hasUsableText(result.text);
}

/** An agent that still owns a live (unfinalized) turn — its turn events deliver the widget. */
function hasLiveTurn(active: ActiveAgent | undefined): active is ActiveAgent {
  return active != null && !active.finalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The flat chains of the currently loaded session view. */
function currentSessionChains(sessionId: string): readonly Chain[] {
  return getSessionManager().getSession(sessionId)?.chains ?? [];
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

function bumpCompactionProgressEpoch(sessionId: string): void {
  compactionProgressEpochs.set(sessionId, (compactionProgressEpochs.get(sessionId) ?? 0) + 1);
}

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

/** The result of the main scope's selective prepare (shared run-attempt shape). */
type SelectiveRunResult = Extract<CompactionAttemptOutcome, { kind: 'ran' }>['result'];
type SelectiveRunFallback = Extract<SelectiveRunResult, { kind: 'fallback' }>;
type SelectiveRunSuccess = Extract<SelectiveRunResult, { kind: 'selective' }>;
type CompactorUsage = SummarizeResult['usage'];

function hasUsableFallbackSummary(result: SelectiveRunFallback): result is SelectiveRunFallback & { fallbackText: string } {
  return hasUsableText(result.fallbackText);
}

function hasReplayRows(result: SelectiveRunFallback): result is SelectiveRunFallback & { replayMessages: Message[] } {
  return (result.replayMessages?.length ?? 0) > 0;
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
interface CompactionProgressOptions {
  clientId?: HostClientId;
  mode?: CompactionProgressEvent['mode'];
  streamText?: string | null;
  estimatedTokens?: number | null;
}

function isTerminalProgressPhase(phase: CompactionProgressPhase): boolean {
  return phase === 'complete' || phase === 'failed';
}

/** The sender a turn-scoped progress event rides: the caller's own client first. */
function progressClientId(active: ActiveAgent, clientId?: HostClientId): HostClientId | null {
  return clientId ?? (canDeliverTo(active.windowId) ? active.windowId : null);
}

function compactionProgressPayload(
  phase: CompactionProgressPhase,
  detail?: string,
  options?: CompactionProgressOptions,
): Record<string, unknown> {
  return {
    type: 'compaction_progress',
    agentScopeId: MAIN_AGENT_SCOPE_ID,
    phase,
    ...(detail !== undefined ? { detail } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    ...(options?.streamText !== undefined ? { streamText: options.streamText } : {}),
    ...(options?.estimatedTokens !== undefined ? { estimatedTokens: options.estimatedTokens } : {}),
  };
}

function emitIdleProgress(sessionId: string, terminal: boolean, payload: Record<string, unknown>): void {
  const identity = idleCompactionIdentity(sessionId, terminal);
  if (!identity) return;
  sendSessionEvent(null, sessionId, IPC_CHANNELS.CHAT_COMPACTION_PROGRESS, { ...identity, ...payload });
}

export function emitCompactionProgress(
  sessionId: string,
  phase: CompactionProgressPhase,
  detail?: string,
  options?: CompactionProgressOptions,
): void {
  const terminal = isTerminalProgressPhase(phase);
  if (terminal) bumpCompactionProgressEpoch(sessionId);
  const payload = compactionProgressPayload(phase, detail, options);
  const active = activeAgents.get(sessionId);
  if (hasLiveTurn(active)) {
    const clientId = progressClientId(active, options?.clientId);
    if (clientId != null) sendTurnEvent(clientId, active, IPC_CHANNELS.CHAT_COMPACTION_PROGRESS, payload);
    return;
  }
  emitIdleProgress(sessionId, terminal, payload);
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
  bumpCompactionProgressEpoch(sessionId);
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

/** Estimated token count of `chars` of streamed output, from this session's calibration. */
function estimatedTokensForCalibration(sessionId: string, chars: number): number | null {
  try {
    const tokensPerChar = getCompactionTrigger(sessionId).state.tokensPerChar;
    return isPositiveFinite(tokensPerChar) ? Math.ceil(chars * tokensPerChar) : null;
  } catch {
    // trigger unavailable (test env) — char count remains the display
    return null;
  }
}

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
    emitCompactionProgress(sessionId, 'compacting', undefined, {
      streamText: latest,
      estimatedTokens: estimatedTokensForCalibration(sessionId, latest.length),
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

/** The last provider-reported input-token count in a persisted context snapshot. */
async function snapshotObservedInputTokens(sessionId: string): Promise<number | null> {
  try {
    // Lazy import: keeps the chat module-load graph free of the accounting
    // store chain (its config/loader dependency conflicts with test mocks).
    const { getContextSnapshotStore } = await import('../../providers/accounting/context-snapshot-store.js');
    return getContextSnapshotStore().latestMainInputTokens(sessionId);
  } catch {
    // store unavailable (not initialized / test env) — fall through
    return null;
  }
}

/** The provider-reported input tokens a persisted message carries, if any. */
function reportedInputTokens(usage: Message['usage']): number | null {
  const input = usage?.context?.input_tokens ?? usage?.prompt_tokens;
  return isPositiveFinite(input) ? input : null;
}

function latestReportedInputTokens(messages: readonly Message[]): number | null {
  for (let j = messages.length - 1; j >= 0; j -= 1) {
    const input = reportedInputTokens(messages[j]!.usage);
    if (input != null) return input;
  }
  return null;
}

/** The last provider-reported input-token count on the session's persisted chains. */
function chainsObservedInputTokens(sessionId: string): number | null {
  try {
    const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
    for (let i = chains.length - 1; i >= 0; i -= 1) {
      const observed = latestReportedInputTokens(chains[i]?.messages ?? []);
      if (observed != null) return observed;
    }
    return null;
  } catch {
    // non-fatal — skip
    return null;
  }
}

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
  triggerCalibrationHydrated.add(sessionId);
  if (trigger.state.tokensPerChar != null) return;
  const observed = (await snapshotObservedInputTokens(sessionId)) ?? chainsObservedInputTokens(sessionId);
  if (observed != null) {
    trigger.state.lastObservedInputTokens = observed;
  }
}

export { dedupeHistoryById };

function totalChars(messages: readonly Message[]): number {
  return totalCharsForMessages(messages);
}

/** The model-visible messages of one compactable range. */
function visibleMessagesInRange(messages: readonly Message[], range: CutResult['compactableRange']): Message[] {
  return messages.slice(range.start, range.end).filter((m) => !m.excludeFromModel && !m.hidden);
}

/** The prepare-time ids a pending apply re-validates against the live history. */
function expectedIdsForRange(messages: readonly Message[], range: CutResult['compactableRange']): string[] {
  return messages.slice(range.start, range.end).map((m) => m.id);
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

/** Calibrated tokens freed by an apply, when both sides of the delta are known. */
function tokensFreedMetric(estimatedInput: number, postTokens: number): number | undefined {
  if (!Number.isFinite(estimatedInput) || !Number.isFinite(postTokens)) return undefined;
  const freed = Math.max(0, Math.floor(estimatedInput - postTokens));
  return freed > 0 ? freed : undefined;
}

/** The compactor LLM's own cost, when the summarizer reported both token counts. */
function compactorTokensMetric(usage?: CompactorUsage): CompactorUsageTokens | undefined {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (!isFiniteNumber(inputTokens) || !isFiniteNumber(outputTokens)) return undefined;
  return { inputTokens: Math.floor(inputTokens), outputTokens: Math.floor(outputTokens) };
}

interface CompactorUsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
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
  compactorUsage?: CompactorUsage,
): ApplyResult {
  const tokensFreed = tokensFreedMetric(estimatedInput, postTokens);
  const compactorTokens = compactorTokensMetric(compactorUsage);
  return stampCompactionMetrics(applyResult, {
    ...(tokensFreed != null ? { tokensFreed } : {}),
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

/** One shared never-delete settle input per selective persist (R35). */
function selectiveSettleInput(
  sessionId: string,
  chains: readonly Chain[],
  input: SelectivePersistInput,
): SelectiveCompactionApplyInput {
  // R35: one never-delete selective-settle for both scopes. summaryText is
  // null here — main persists the replay rows as the summary chain below
  // rather than one composed summary head; the builder contributes the
  // settled flag set (user-filtered, reclaim-merged, deduped).
  return {
    messages: input.messages,
    chains,
    cutResult: input.cut,
    flaggedIds: input.flaggedIds,
    ...(input.reclaimedIds ? { reclaimedIds: input.reclaimedIds } : {}),
    ...(input.exemptIds ? { exemptIds: input.exemptIds } : {}),
    summaryText: null,
    sessionId,
  };
}

function selectiveFlaggedIds(settled: ApplyResult | null): string[] {
  return [...new Set(settled?.flaggedIds ?? [])];
}

function selectiveClearedIds(settled: ApplyResult | null): string[] {
  return settled?.unflaggedIds ?? [];
}

/** New replay rows from the selective run (synthetic summaries + ranged copies). */
function newReplayRows(replayMessages: readonly Message[], chains: readonly Chain[]): Message[] {
  const existingIds = new Set(chains.flatMap((c) => c.messages.map((m) => m.id)));
  return replayMessages.filter((m) => !existingIds.has(m.id)) as Message[];
}

/** One durable summary-head row (R20) carrying the new replay material in replay order. */
function selectiveSummaryChain(sessionId: string, rows: readonly Message[], updatedAt: string): Chain | null {
  if (rows.length === 0) return null;
  // Unified id scheme (#11): randomUUID() — one scheme for synthesized
  // compactor chains across the main and subagent scopes.
  return {
    id: randomUUID(),
    sessionId,
    messages: rows as unknown as readonly Message[],
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

/** The first preserved-window message the durable summary rows must precede. */
function selectiveInsertAnchor(chains: readonly Chain[], cut: CutResult): string | null {
  const flatOriginal: Message[] = chains.flatMap((c) => c.messages as unknown as Message[]);
  const preserveStart = cut.compactableRange.end;
  return preserveStart < flatOriginal.length ? flatOriginal[preserveStart]!.id : null;
}

/**
 * Transcript view mirroring the durable write (storage inlines the summary
 * rows into the anchor chain at the anchor index): settled flat history + the
 * fresh replay rows at the same position.
 */
function selectiveTranscriptView(
  settled: ApplyResult | null,
  input: SelectivePersistInput,
  newReplayMessages: readonly Message[],
  insertBeforeMessageId: string | null,
): Message[] {
  const transcript: Message[] = [...(settled?.updatedMessages ?? [...input.messages])];
  if (newReplayMessages.length === 0) return transcript;
  const anchorIndex = insertBeforeMessageId != null
    ? transcript.findIndex((m) => m.id === insertBeforeMessageId)
    : -1;
  const insertAt = anchorIndex >= 0 ? anchorIndex : transcript.length;
  return [
    ...transcript.slice(0, insertAt),
    ...newReplayMessages,
    ...transcript.slice(insertAt),
  ];
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
    const settled = buildSelectiveCompactionApply(selectiveSettleInput(sessionId, existing.chains, input));
    const updatedAt = new Date().toISOString();
    const newReplayMessages = newReplayRows(input.replayMessages, existing.chains);
    const insertBeforeMessageId = selectiveInsertAnchor(existing.chains, input.cut);
    // Single targeted durable transaction (same P0-safe path as the simple
    // mode): flags + summary head against FULL durable chain rows — never a
    // wholesale saveSession from the bounded in-memory view, which would
    // truncate pre-window history and wipe durable subagent rows. The
    // settle-cleared ids (covered-kept resets / exempt users) ride the same
    // transaction so no stale true flag survives on the durable rows.
    const durable = persistCompactionDurable({
      sessionId,
      flaggedMessageIds: selectiveFlaggedIds(settled),
      clearedMessageIds: selectiveClearedIds(settled),
      summaryChain: selectiveSummaryChain(sessionId, newReplayMessages, updatedAt),
      insertBeforeMessageId,
      updatedAt,
    });
    // Refresh the in-memory cache from durable rows so the renderer's
    // compaction reload sees the true post-write chain layout. Model replay
    // history is maintained separately via setChatHistory.
    if (durable) {
      publishCompactedSession(manager, sessionId, existing, updatedAt);
    }
    return {
      ok: true,
      transcriptMessages: selectiveTranscriptView(settled, input, newReplayMessages, insertBeforeMessageId),
    };
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
  const exemptPrefix = visibleMessagesInRange(applyTimeHistory, {
    start: 0,
    end: Math.max(0, rangeStart),
  });
  return dedupeHistoryById([...exemptPrefix, ...prefix, ...suffix]);
}

// ── Pending consumption at a safe boundary (turn start / pause) ──────────────

/** One pending apply: the taken entry plus everything re-derived at apply time. */
interface PendingApplyContext {
  readonly sessionId: string;
  readonly trigger: CompactionTrigger;
  readonly pending: CompactionPendingEntry;
  /** Deduped live history the pending's cut was re-validated against. */
  readonly history: Message[];
  readonly runtime: ProjectRuntime;
  readonly exemptIds: ReadonlySet<string> | undefined;
}

export interface PendingApplyOutcome {
  applied: boolean;
  updatedMessages?: Message[];
  transcriptMessages?: Message[];
}

function pendingCutInvalidatedReason(pending: CompactionPendingEntry): string {
  const { start, end } = pending.cut.compactableRange;
  return `pending cut invalidated before apply (range [${start},${end}) no longer matches live history) — discarding prepared compaction`;
}

/** Post-compaction token estimate from the trigger's calibration over the pending's estimate. */
function postApplyTokens(ctx: PendingApplyContext, updated: readonly Message[]): number {
  const { trigger, pending, history } = ctx;
  const ratio = trigger.state.tokensPerChar
    ?? (totalChars(updated) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
  return ratio ? Math.ceil(totalChars(updated) * ratio) : pending.estimatedInput;
}

function pendingApplyInput(ctx: PendingApplyContext, summaryText: string | null): ApplyInput {
  const { sessionId, history, pending, runtime, exemptIds } = ctx;
  return {
    messages: history,
    chains: currentSessionChains(sessionId),
    cutResult: pending.cut,
    summaryText,
    mode: runtime.config.compaction.main.mode,
    flaggedIds: pending.flaggedIds,
    ...(exemptIds ? { exemptIds } : {}),
    sessionId,
  };
}

function pendingSelectivePersistInput(
  ctx: PendingApplyContext,
  flaggedIds: readonly string[],
  replayMessages: readonly Message[],
): SelectivePersistInput {
  const { history, pending, exemptIds } = ctx;
  return buildSelectivePersistInput({
    messages: history,
    flaggedIds,
    reclaimedIds: pending.flaggedIds,
    exemptIds,
    replayMessages,
    cut: pending.cut,
  });
}

/** Re-anchor a written selective replay into the model history (P1 #5). */
function reanchorPendingReplay(ctx: PendingApplyContext, replayMessages: readonly Message[]): Message[] {
  const { history, pending } = ctx;
  return reanchorSelectiveReplay(
    replayMessages,
    history,
    pending.cut.cutIndex,
    pending.cut.compactableRange.start,
  );
}

/**
 * Apply a pending selective run's replay rows as one targeted durable write
 * (flags from the shared never-delete settle, replay rows as the summary
 * chain), then the same apply-time re-anchoring as the selective-success path
 * (P1 #5). A failed write settles the trigger as an apply failure so the fire
 * point backs off instead of re-preparing every step.
 */
function applyPendingReplayRows(
  ctx: PendingApplyContext,
  replayMessages: readonly Message[],
  flaggedIds: readonly string[],
): PendingApplyOutcome {
  const { sessionId, trigger, pending } = ctx;
  const persistRes = persistSelectiveCompaction(sessionId, pendingSelectivePersistInput(ctx, flaggedIds, replayMessages));
  let reanchored: Message[] | undefined;
  if (persistRes.ok) {
    reanchored = reanchorPendingReplay(ctx, replayMessages);
    setChatHistory(sessionId, [...reanchored]);
    trigger.onCompactionApplied(pending.estimatedInput, postApplyTokens(ctx, reanchored));
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

/**
 * Apply a pending whose selective run materialized a replay: DB first, then
 * memory, in one durable selective transaction.
 */
function applyPendingSelectiveResult(
  ctx: PendingApplyContext,
  result: SelectiveRunSuccess,
): PendingApplyOutcome {
  const { sessionId, trigger, pending } = ctx;
  const persistRes = persistSelectiveCompaction(
    sessionId,
    pendingSelectivePersistInput(ctx, result.flaggedIds, result.replayMessages),
  );
  if (!persistRes.ok) {
    failPendingApply(sessionId, trigger, 'selective persist failed — compaction not applied');
    return { applied: false };
  }
  // Re-anchor at apply time: the prepare-time replay never saw messages
  // appended after the prepare (e.g. the NEXT turn's user message), so
  // only its compactable prefix is reused — the preserved suffix is
  // re-derived from the current history (P1 #5).
  const reanchored = reanchorPendingReplay(ctx, result.replayMessages);
  setChatHistory(sessionId, [...reanchored]);
  trigger.onCompactionApplied(pending.estimatedInput, postApplyTokens(ctx, reanchored));
  trigger.abortPrepare();
  completeCompactionWidget(sessionId);
  return {
    applied: true,
    updatedMessages: [...reanchored],
    ...(persistRes.transcriptMessages ? { transcriptMessages: [...persistRes.transcriptMessages] } : {}),
  };
}

/**
 * Apply a pending that carries a handoff summary (simple mode, or a selective
 * run that fell back to the summarizer). Returns null when nothing was
 * applied, so the caller can still settle the run's replay rows.
 */
function applyPendingSummary(
  ctx: PendingApplyContext,
  summaryText: string,
  compactorUsage?: CompactorUsage,
): PendingApplyOutcome | null {
  const { sessionId, trigger, pending } = ctx;
  // R31: the scoped settle inside buildCompactionApply already keeps exempt
  // user ids out of the flagged set in every mode — no scope-specific un-flag
  // pass is needed here.
  let applyResult = buildCompactionApply(pendingApplyInput(ctx, summaryText));
  if (!applyResult.didApply) return null;
  const postTokens = postApplyTokens(ctx, applyResult.updatedMessages);
  applyResult = stampApplyMetrics(applyResult, pending.estimatedInput, postTokens, compactorUsage);
  if (!persistCompaction(sessionId, applyResult)) return null;
  setChatHistory(sessionId, [...applyResult.updatedMessages]);
  trigger.onCompactionApplied(pending.estimatedInput, postTokens);
  trigger.abortPrepare();
  completeCompactionWidget(sessionId);
  return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
}

/** Apply a reclaim-only pending: flags with no summarizer, no prepare to abort. */
function applyPendingReclaimOnly(ctx: PendingApplyContext): PendingApplyOutcome | null {
  const { sessionId, trigger, pending } = ctx;
  const applyResult = buildCompactionApply(pendingApplyInput(ctx, null));
  if (!applyResult.didApply) return null;
  if (!persistCompaction(sessionId, applyResult)) return null;
  setChatHistory(sessionId, [...applyResult.updatedMessages]);
  trigger.onCompactionApplied(pending.estimatedInput, postApplyTokens(ctx, applyResult.updatedMessages));
  completeCompactionWidget(sessionId);
  return { applied: true, updatedMessages: [...applyResult.updatedMessages] };
}

/**
 * Consume a pending selective run: the materialized replay, its simple
 * fallback, or a terminal discard when the run produced nothing applicable.
 */
async function applySelectivePending(
  ctx: PendingApplyContext,
  selectivePromise: NonNullable<CompactionPendingEntry['selectivePromise']>,
): Promise<PendingApplyOutcome> {
  const { sessionId, trigger } = ctx;
  const outcome = await selectivePromise;
  if (outcome.kind !== 'ran') {
    failPendingApply(
      sessionId,
      trigger,
      `selective run produced no applicable result (${outcome.reason}) — skipping apply`,
    );
    return { applied: false };
  }
  const result = outcome.result;
  if (result.kind === 'selective') return applyPendingSelectiveResult(ctx, result);
  if (result.kind === 'fallback' && hasUsableFallbackSummary(result)) {
    const applied = applyPendingSummary(ctx, result.fallbackText);
    if (applied) return applied;
    if (hasReplayRows(result)) {
      return applyPendingReplayRows(ctx, result.replayMessages, result.flaggedIds ?? ctx.pending.flaggedIds);
    }
  }
  failPendingApply(sessionId, trigger, 'selective run produced no applicable result — discarding pending');
  return { applied: false };
}

async function applySimplePending(
  ctx: PendingApplyContext,
  promise: NonNullable<CompactionPendingEntry['promise']>,
): Promise<PendingApplyOutcome> {
  const { sessionId, trigger } = ctx;
  const result = await promise;
  if (hasUsableSummary(result)) {
    const applied = applyPendingSummary(ctx, result.text, result.usage);
    if (applied) return applied;
  }
  // Summarizer failed or persist failed — clear pending flag
  failPendingApply(sessionId, trigger, 'simple summarizer failed or persist failed — clearing pending');
  return { applied: false };
}

function isSelectivePending(pending: CompactionPendingEntry): boolean {
  return pending.mode === 'selective' && pending.selectivePromise != null;
}

/** Apply-time exempt resolution from the CURRENT config (config may change between prepare and apply). */
function applyTimeExemptIds(
  runtime: ProjectRuntime,
  history: readonly Message[],
): ReadonlySet<string> | undefined {
  const mainCfg = runtime.config.compaction?.main;
  return mainCfg ? mainExemptIds(history, mainCfg) : undefined;
}

export async function applyPendingCompactionIfAny(
  sessionId: string,
  messages: Message[],
  runtime: ProjectRuntime,
): Promise<PendingApplyOutcome> {
  const pending = takeCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID);
  if (!pending) return { applied: false };
  // The pending cut/expectedIds were computed over the deduped history
  // (handleUsageCompaction dedupes). Mid-turn callers concatenate
  // [...messages, ...turnMessagesFromAgent()] where the turn base repeats
  // the triggering user message, so dedupe here or the index-anchored
  // validation below rejects every mid-turn apply.
  const history = dedupeHistoryById(messages);
  if (!isPendingCutStillValid(pending, history)) {
    failPendingApply(sessionId, getCompactionTrigger(sessionId), pendingCutInvalidatedReason(pending));
    return { applied: false };
  }
  // One exempt set per apply, threaded into every builder below so the cut
  // math and the settle cannot diverge.
  const ctx: PendingApplyContext = {
    sessionId,
    trigger: getCompactionTrigger(sessionId),
    pending,
    history,
    runtime,
    exemptIds: applyTimeExemptIds(runtime, history),
  };
  try {
    if (isSelectivePending(pending) && pending.selectivePromise) {
      return await applySelectivePending(ctx, pending.selectivePromise);
    }
    if (pending.promise) return await applySimplePending(ctx, pending.promise);
    const reclaimApplied = pending.flaggedIds.length > 0 ? applyPendingReclaimOnly(ctx) : null;
    if (reclaimApplied) return reclaimApplied;
    // Fall-through (reclaim-only that did not apply, or a pending with neither
    // promise nor flagged ids): clear the prepare so a stuck pendingPrepare
    // cannot silence every future trigger evaluation for the session.
    failPendingApply(sessionId, ctx.trigger, 'pending produced no applicable compaction — clearing prepare');
  } catch (err) {
    failPendingApply(sessionId, getCompactionTrigger(sessionId), `pending apply failed (non-fatal): ${String(err)}`);
  }
  return { applied: false };
}

// ── Send-time / overflow-retry synchronous compaction ───────────────────────

/**
 * Everything one synchronous compaction needs, bundled so every bump (gate
 * checks, estimate, prepare, apply, persist) sees the same turn identity and
 * ledger attribution: the send-time seam, the overflow-retry seam, and the
 * manual `/compact` path all build one of these.
 */
export interface SyncCompactionContext {
  readonly sessionId: string;
  readonly messages: Message[];
  readonly runtime: ProjectRuntime;
  readonly selection: ModelSelection;
  /** Model context window in tokens, or null when the model reports no limit. */
  readonly contextTokens: number | null;
  readonly accountingStore: ProviderAccountingStore;
  /** Chain the compactor LLM attempt is attributed to, when one exists. */
  readonly chainId: string | null;
  readonly turnId: string;
  /** Explicit user request (`/compact`): bypasses the threshold/floor gates. */
  readonly manual?: boolean;
}

export interface SyncCompactionResult {
  didApply: boolean;
  updatedMessages?: Message[];
  transcriptMessages?: Message[];
  reason?: string;
}

/** The pre-work gates a synchronous compaction must pass, or why it must skip. */
function syncCompactionBlock(ctx: SyncCompactionContext, trigger: CompactionTrigger): SyncCompactionResult | null {
  if (trigger.state.pendingPrepare) return { didApply: false, reason: 'prepare-in-flight' };
  // A selective run orphaned by a discarded pending may still be streaming;
  // starting another here would duplicate the compactor LLM call. The backoff
  // is deliberately NOT consulted here — the overflow-retry caller treats
  // compaction as an emergency recovery path and must bypass the cooldown.
  if (isSelectiveRunInFlight(ctx.sessionId)) return { didApply: false, reason: 'selective-in-flight' };
  return null;
}

/** One synchronous compaction attempt: the caller's context plus resolved knobs. */
interface SyncAttempt {
  readonly ctx: SyncCompactionContext;
  readonly trigger: CompactionTrigger;
  readonly cfg: CompactionScopeConfig;
  readonly contextTokens: number;
  /**
   * One exempt set per attempt: the gate's selectCut, the selective runner,
   * and every apply below consume the same resolved set.
   */
  readonly exemptIds: ReadonlySet<string>;
}

/** A synchronous attempt that cleared the gate and has compaction work to do. */
interface SyncGateAttempt extends SyncAttempt {
  readonly decision: CompactionGateAction;
  readonly chains: readonly Chain[];
}

function syncGateInput(attempt: SyncAttempt): CompactionGateInput {
  const { ctx, cfg, contextTokens, exemptIds, trigger } = attempt;
  return {
    messages: ctx.messages,
    config: cfg,
    scope: 'main',
    inputTokens: null,
    contextTokens,
    tokensPerChar: trigger.state.tokensPerChar ?? null,
    triggerState: trigger.state,
    exemptIds,
    ...(ctx.manual ? { manual: true } : {}),
  };
}

function syncAccounting(attempt: SyncAttempt) {
  const { ctx } = attempt;
  return {
    store: ctx.accountingStore,
    sessionId: ctx.sessionId,
    chainId: ctx.chainId,
    turnId: ctx.turnId,
  };
}

function syncSelectiveAttemptInput(attempt: SyncGateAttempt): CompactionAttemptInput {
  const { ctx, exemptIds, trigger, decision } = attempt;
  const range = decision.cut.compactableRange;
  return {
    messages: ctx.messages,
    cut: decision.cut,
    scope: 'main',
    config: ctx.runtime.config,
    exemptIds,
    deps: {
      fallbackSelection: ctx.selection,
      runtime: ctx.runtime,
      accounting: syncAccounting(attempt),
      onPrepared: () => trigger.markPrepareStarted(range, decision.flaggedIds),
      onTextDelta: createCompactionStreamEmitter(ctx.sessionId),
    },
    maxCorrectionRounds: 3,
  };
}

function syncCompactorInput(attempt: SyncGateAttempt, slice: readonly Message[]): SummarizeInput {
  const { ctx, decision } = attempt;
  const bridge = buildCompactionBridgeContext(ctx.messages, decision.cut.compactableRange);
  return {
    messages: slice,
    scope: 'main',
    config: ctx.runtime.config,
    fallbackSelection: ctx.selection,
    accounting: syncAccounting(attempt),
    runtime: ctx.runtime,
    onTextDelta: createCompactionStreamEmitter(ctx.sessionId),
    ...(bridge ? { bridgeContext: bridge } : {}),
  };
}

function syncApplyInput(
  attempt: SyncGateAttempt,
  summaryText: string | null,
  flaggedIds: readonly string[],
): ApplyInput {
  const { ctx, cfg, exemptIds, decision } = attempt;
  return {
    messages: ctx.messages,
    chains: attempt.chains,
    cutResult: decision.cut,
    summaryText,
    mode: cfg.mode,
    flaggedIds,
    exemptIds,
    sessionId: ctx.sessionId,
  };
}

/** Post-compaction estimate on the synchronous path: trigger calibration over the gate's. */
function syncPostTokens(attempt: SyncGateAttempt, updated: readonly Message[]): number {
  const ratio = attempt.trigger.state.tokensPerChar ?? attempt.decision.tokensPerChar;
  return Math.ceil(totalChars(updated) * ratio);
}

function abortSyncPrepare(attempt: SyncAttempt): SyncCompactionResult {
  attempt.trigger.abortPrepare();
  return { didApply: false };
}

/** Apply a reclaim-only decision: mechanical-reclaim flags, no summarizer call. */
function applySyncReclaimOnly(attempt: SyncGateAttempt): SyncCompactionResult {
  const { ctx, trigger, decision } = attempt;
  const applyResult = buildCompactionApply(syncApplyInput(attempt, null, decision.flaggedIds));
  if (!applyResult.didApply) return { didApply: false };
  if (!persistCompaction(ctx.sessionId, applyResult)) return { didApply: false };
  setChatHistory(ctx.sessionId, [...applyResult.updatedMessages]);
  trigger.onCompactionApplied(decision.estimatedInput, syncPostTokens(attempt, applyResult.updatedMessages));
  return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
}

/** Stamp, persist and settle a synchronous summary apply (simple mode or fallback text). */
function persistSyncSummaryApply(
  attempt: SyncGateAttempt,
  applyResult: ApplyResult,
  compactorUsage?: CompactorUsage,
): SyncCompactionResult {
  const { ctx, trigger, decision } = attempt;
  const postTokens = syncPostTokens(attempt, applyResult.updatedMessages);
  const stamped = stampApplyMetrics(applyResult, decision.estimatedInput, postTokens, compactorUsage);
  if (!persistCompaction(ctx.sessionId, stamped)) return abortSyncPrepare(attempt);
  setChatHistory(ctx.sessionId, [...stamped.updatedMessages]);
  trigger.onCompactionApplied(decision.estimatedInput, postTokens);
  trigger.abortPrepare();
  return { didApply: true, updatedMessages: [...stamped.updatedMessages] };
}

/**
 * Persist a selective run's replay rows as one targeted durable write and
 * adopt them as the model history. If flagged ids were derived from the
 * manifest they lead; the gate's reclaim flags merge.
 */
function applySyncReplayRows(
  attempt: SyncGateAttempt,
  replayMessages: readonly Message[],
  flaggedIds: readonly string[],
): SyncCompactionResult {
  const { ctx, trigger, decision, exemptIds } = attempt;
  const persistRes = persistSelectiveCompaction(ctx.sessionId, buildSelectivePersistInput({
    messages: ctx.messages,
    flaggedIds,
    reclaimedIds: decision.flaggedIds,
    exemptIds,
    replayMessages,
    cut: decision.cut,
  }));
  if (!persistRes.ok) return abortSyncPrepare(attempt);
  setChatHistory(ctx.sessionId, [...replayMessages]);
  trigger.onCompactionApplied(decision.estimatedInput, syncPostTokens(attempt, replayMessages));
  trigger.abortPrepare();
  return {
    didApply: true,
    updatedMessages: [...replayMessages],
    ...(persistRes.transcriptMessages ? { transcriptMessages: [...persistRes.transcriptMessages] } : {}),
  };
}

/**
 * A selective run that produced a handoff text: try the composed simple apply
 * first; when it yields no durable change, the run's replay rows carry the
 * compaction instead.
 */
function applySyncSelectiveFallback(
  attempt: SyncGateAttempt,
  result: SelectiveRunFallback,
): SyncCompactionResult {
  const applyResult = buildCompactionApply(
    syncApplyInput(attempt, result.fallbackText, attempt.decision.flaggedIds),
  );
  if (!applyResult.didApply) {
    return hasReplayRows(result)
      ? applySyncReplayRows(attempt, result.replayMessages, result.flaggedIds ?? attempt.decision.flaggedIds)
      : abortSyncPrepare(attempt);
  }
  // R31: the scoped settle inside buildCompactionApply already keeps exempt
  // user ids out of the flagged set in every mode — no scope-specific un-flag
  // pass is needed here.
  return persistSyncSummaryApply(attempt, applyResult);
}

async function runSyncSelectivePrepare(attempt: SyncGateAttempt): Promise<SyncCompactionResult> {
  const { ctx, trigger } = attempt;
  const range = attempt.decision.cut.compactableRange;
  if (compactableModelSlice(ctx.messages, range).length === 0) return { didApply: false };
  let outcome: CompactionAttemptOutcome;
  try {
    outcome = await runCompactionAttempt(syncSelectiveAttemptInput(attempt));
  } catch (err) {
    console.debug('[compaction] selective run failed, falling back (non-fatal):', err);
    trigger.abortPrepare();
    return { didApply: false };
  }
  if (outcome.kind === 'noop') return { didApply: false };
  const result = outcome.result;
  if (result.kind === 'selective') {
    return applySyncReplayRows(attempt, result.replayMessages, result.flaggedIds);
  }
  if (result.kind === 'fallback') {
    if (hasUsableFallbackSummary(result)) return applySyncSelectiveFallback(attempt, result);
    if (hasReplayRows(result)) {
      return applySyncReplayRows(attempt, result.replayMessages, result.flaggedIds ?? attempt.decision.flaggedIds);
    }
  }
  return abortSyncPrepare(attempt);
}

async function runSyncSimplePrepare(attempt: SyncGateAttempt): Promise<SyncCompactionResult> {
  const { ctx, trigger, decision } = attempt;
  const slice = visibleMessagesInRange(ctx.messages, decision.cut.compactableRange);
  if (slice.length === 0) return { didApply: false };
  trigger.markPrepareStarted(decision.cut.compactableRange, decision.flaggedIds);
  const result: SummarizeResult | null = await summarizeCompactableRange(
    syncCompactorInput(attempt, slice),
  );
  if (!hasUsableSummary(result)) return abortSyncPrepare(attempt);
  const applyResult = buildCompactionApply(syncApplyInput(attempt, result.text, decision.flaggedIds));
  if (!applyResult.didApply) return abortSyncPrepare(attempt);
  return persistSyncSummaryApply(attempt, applyResult, result.usage);
}

async function runSyncPrepare(attempt: SyncGateAttempt): Promise<SyncCompactionResult> {
  if (attempt.cfg.mode === 'selective') return runSyncSelectivePrepare(attempt);
  return runSyncSimplePrepare(attempt);
}

/** Estimate → reclaim or prepare → apply, over one already-armed attempt. */
async function runSynchronousCompaction(attempt: SyncAttempt): Promise<SyncCompactionResult> {
  try {
    const decision = runCompactionGate(syncGateInput(attempt));
    if (decision.kind === 'no-op') return { didApply: false, reason: decision.reason };
    const gated: SyncGateAttempt = {
      ...attempt,
      decision,
      chains: currentSessionChains(attempt.ctx.sessionId),
    };
    if (decision.kind === 'reclaim-only') return applySyncReclaimOnly(gated);
    return await runSyncPrepare(gated);
  } catch (err) {
    console.debug('[compaction] synchronous compact failed (non-fatal):', err);
    abortPrepareQuietly(attempt.trigger);
  }
  return { didApply: false };
}

function abortPrepareQuietly(trigger: CompactionTrigger): void {
  try {
    trigger.abortPrepare();
  } catch {
    // abort cleanup is best-effort after a failed compact
  }
}

export async function tryCompactSynchronously(
  ctx: SyncCompactionContext,
): Promise<SyncCompactionResult> {
  const trigger = getCompactionTrigger(ctx.sessionId);
  const cfg = ctx.runtime.config.compaction?.main;
  if (!cfg) return { didApply: false, reason: 'compaction-disabled' };
  const blocked = syncCompactionBlock(ctx, trigger);
  if (blocked) return blocked;
  // Models without a configured context window never compact proactively:
  // fabricating an assumed window here diverged from the mid-turn usage path,
  // which is disabled when the limit is unknown. Manual compaction shares the
  // rule — without a window there is no preserve budget to compute.
  if (!isUsableContextWindow(ctx.contextTokens)) return { didApply: false, reason: 'no-context-window' };
  const { contextTokens } = ctx;
  return runSynchronousCompaction({
    ctx,
    trigger,
    cfg,
    contextTokens,
    exemptIds: mainExemptIds(ctx.messages, cfg),
  });
}

// ── Usage-event fire point (mid-turn prepares) ──────────────────────────────

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

/** Everything one usage-event fire point arms a pending from. */
interface UsageFireContext {
  readonly sessionId: string;
  readonly history: Message[];
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly runtime: ProjectRuntime;
  readonly selection: ModelSelection;
  readonly accountingStore: ProviderAccountingStore;
  readonly chainId: string | null;
  readonly turnId: string;
}

/** Calibrate the trigger from this usage observation (no chars/4 fallback). */
function calibrateUsageTrigger(
  trigger: CompactionTrigger,
  inputTokens: number,
  charCache: MessageCharCache,
): void {
  const derived = deriveTokensPerChar(inputTokens, charCache.total);
  if (derived != null) trigger.state.tokensPerChar = derived;
  trigger.state.lastObservedInputTokens = inputTokens;
}

/** Whether this usage event may arm a new prepare at all. */
function canArmUsagePending(sessionId: string, trigger: CompactionTrigger): boolean {
  if (trigger.state.pendingPrepare) return false;
  if (getCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID)) return false;
  // Post-failure backoff: a discarded/unusable prepare arms a cooldown so the
  // fire point stops re-preparing on every step while a compactor run may
  // still be orphaned in-flight.
  if (trigger.inApplyBackoff()) return false;
  return !isSelectiveRunInFlight(sessionId);
}

function usageGateInput(
  ctx: UsageFireContext,
  cfg: CompactionScopeConfig,
  trigger: CompactionTrigger,
  charCache: MessageCharCache,
  exemptIds: ReadonlySet<string>,
): CompactionGateInput {
  return {
    messages: ctx.history,
    config: cfg,
    scope: 'main',
    inputTokens: ctx.inputTokens,
    contextTokens: ctx.contextTokens,
    tokensPerChar: trigger.state.tokensPerChar ?? null,
    triggerState: trigger.state,
    charCache,
    exemptIds,
  };
}

function armUsageReclaimPending(
  ctx: UsageFireContext,
  cfg: CompactionScopeConfig,
  trigger: CompactionTrigger,
  decision: CompactionGateAction,
  expectedIds: string[],
): void {
  const { sessionId, contextTokens } = ctx;
  setCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID, {
    cut: decision.cut,
    flaggedIds: decision.flaggedIds,
    expectedIds,
    estimatedInput: decision.estimatedInput,
    contextTokens,
    mode: cfg.mode,
  });
  trigger.markPrepareStarted(decision.cut.compactableRange, decision.flaggedIds);
  armPendingAndPause(sessionId, ctx.runtime, cfg.mode, 'Reclaiming duplicates');
}

function armUsageSelectivePending(
  ctx: UsageFireContext,
  trigger: CompactionTrigger,
  decision: CompactionGateAction,
  expectedIds: string[],
  exemptIds: ReadonlySet<string>,
): void {
  const { sessionId, history, runtime, selection, accountingStore, chainId, turnId } = ctx;
  const range = decision.cut.compactableRange;
  if (compactableModelSlice(history, range).length === 0) return;
  const selectivePromise = runCompactionAttempt({
    messages: history,
    cut: decision.cut,
    scope: 'main',
    config: runtime.config,
    exemptIds,
    deps: {
      fallbackSelection: selection,
      runtime,
      accounting: { store: accountingStore, sessionId, chainId, turnId },
      onPrepared: () => trigger.markPrepareStarted(range, decision.flaggedIds),
      onTextDelta: createCompactionStreamEmitter(sessionId),
    },
    maxCorrectionRounds: 3,
  });
  trackSelectiveRun(sessionId, selectivePromise);
  setCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID, {
    cut: decision.cut,
    flaggedIds: decision.flaggedIds,
    expectedIds,
    estimatedInput: decision.estimatedInput,
    contextTokens: ctx.contextTokens,
    mode: 'selective',
    selectivePromise,
  });
  selectivePromise.catch((err) => settlePrepareRejection(sessionId, 'selective prepare', err));
  armPendingAndPause(sessionId, runtime, 'selective', 'Summarizing history');
}

function armUsageSimplePending(
  ctx: UsageFireContext,
  trigger: CompactionTrigger,
  decision: CompactionGateAction,
  expectedIds: string[],
): void {
  const { sessionId, history, runtime, selection, accountingStore, chainId, turnId } = ctx;
  const range = decision.cut.compactableRange;
  const slice = visibleMessagesInRange(history, range);
  if (slice.length === 0) return;
  trigger.markPrepareStarted(range, decision.flaggedIds);
  const bridge = buildCompactionBridgeContext(history, range);
  const promise = summarizeCompactableRange({
    messages: slice,
    scope: 'main',
    config: runtime.config,
    fallbackSelection: selection,
    accounting: { store: accountingStore, sessionId, chainId, turnId },
    runtime,
    onTextDelta: createCompactionStreamEmitter(sessionId),
    ...(bridge ? { bridgeContext: bridge } : {}),
  });
  setCompactionPending(sessionId, MAIN_AGENT_SCOPE_ID, {
    cut: decision.cut,
    flaggedIds: decision.flaggedIds,
    expectedIds,
    estimatedInput: decision.estimatedInput,
    contextTokens: ctx.contextTokens,
    mode: 'simple',
    promise,
  });
  promise.catch((err) => settlePrepareRejection(sessionId, 'prepare', err));
  armPendingAndPause(sessionId, runtime, 'simple', 'Summarizing history');
}

/** Evaluate the gate for this usage event and arm the matching pending. */
function armUsagePending(
  ctx: UsageFireContext,
  cfg: CompactionScopeConfig,
  trigger: CompactionTrigger,
  charCache: MessageCharCache,
): void {
  // Prepare-time exempt resolution (one set per attempt): the gate's
  // selectCut and the selective runner consume the same resolved set; the
  // later apply re-resolves from the config current at apply time.
  const exemptIds = mainExemptIds(ctx.history, cfg);
  try {
    const decision = runCompactionGate(usageGateInput(ctx, cfg, trigger, charCache, exemptIds));
    if (decision.kind === 'no-op') return;
    const expectedIds = expectedIdsForRange(ctx.history, decision.cut.compactableRange);
    if (decision.kind === 'reclaim-only') {
      armUsageReclaimPending(ctx, cfg, trigger, decision, expectedIds);
      return;
    }
    if (cfg.mode === 'selective') {
      armUsageSelectivePending(ctx, trigger, decision, expectedIds, exemptIds);
      return;
    }
    armUsageSimplePending(ctx, trigger, decision, expectedIds);
  } catch (err) {
    console.debug('[compaction] usage trigger failed (non-fatal):', err);
  }
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
  if (!isUsableContextWindow(contextTokens)) return;
  const history = dedupeHistoryById(fullHistory);
  const charCache = computeMessageCharCache(history);
  calibrateUsageTrigger(trigger, inputTokens, charCache);
  trigger.onUsage(inputTokens, contextTokens, cfg.threshold, cfg.hysteresis_delta);
  if (!canArmUsagePending(sessionId, trigger)) return;
  armUsagePending(
    { sessionId, history, inputTokens, contextTokens, runtime, selection, accountingStore, chainId, turnId },
    cfg,
    trigger,
    charCache,
  );
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

/** Whether a live or starting turn owns compaction for this session. */
function hasLiveOrStartingTurn(sessionId: string): boolean {
  return hasLiveTurn(activeAgents.get(sessionId)) || sessionsStarting.has(sessionId);
}

/** Why a manual compaction must refuse this session, or null when it may run. */
function idleCompactionRefusal(sessionId: string, runtime: ProjectRuntime): ChatCompactResult | null {
  if (hasLiveOrStartingTurn(sessionId)) return { status: 'busy', sessionId };
  if (!runtime.config.compaction?.main) {
    return { status: 'nothing_to_compact', sessionId, detail: 'Compaction is disabled for this project.' };
  }
  return null;
}

function idleSessionHistory(sessionId: string): { messages: Message[] } | { error: string } {
  try {
    return { messages: getChatHistory(sessionId) ?? historyFromSession(sessionId) };
  } catch (error) {
    return { error: `Could not load conversation history: ${errorMessage(error)}` };
  }
}

async function idleContextWindow(
  selection: ModelSelection,
): Promise<{ contextTokens: number | null } | { error: string }> {
  try {
    const execution = await getProviderRuntime().resolveExecution(selection);
    return { contextTokens: execution.model.limits?.contextTokens ?? null };
  } catch (error) {
    return { error: `Provider unavailable for compaction: ${errorMessage(error)}` };
  }
}

function idleAccountingStore(): { store: ProviderAccountingStore } | { error: string } {
  try {
    return { store: getProviderAccountingStore() };
  } catch (error) {
    return { error: `Accounting store unavailable: ${errorMessage(error)}` };
  }
}

// Attribute the compactor LLM attempt to the session's latest chain when one
// exists; otherwise it lands chain-less like other out-of-turn work.
function latestSessionChainId(sessionId: string): string | null {
  try {
    const chains = currentSessionChains(sessionId);
    return chains.length > 0 ? chains[chains.length - 1]!.id : null;
  } catch {
    // attribution is best-effort
    return null;
  }
}

// Widget feedback on the idle session: preparing opens the compaction
// widget; the pending-consumption apply and the success path below emit the
// terminal 'complete' phase themselves (completeCompactionWidget), and every
// other exit emits 'failed' so the widget can never stay stuck on
// 'preparing'/'compacting' and the idle event identity is cleared.
function idleCompactionOutcome(sessionId: string, result: SyncCompactionResult): ChatCompactResult {
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

async function compactIdleSession(
  sessionId: string,
  runtime: ProjectRuntime,
  selection: ModelSelection,
): Promise<ChatCompactResult> {
  const refusal = idleCompactionRefusal(sessionId, runtime);
  if (refusal) return refusal;
  await hydrateTriggerCalibration(sessionId);
  const loaded = idleSessionHistory(sessionId);
  if ('error' in loaded) return { status: 'error', error: loaded.error };
  let messages = loaded.messages;
  // A pending left behind by an interrupted turn IS the requested compaction
  // half-prepared — consume and apply it before starting a fresh prepare.
  const pendingApplied = await applyPendingCompactionIfAny(sessionId, messages, runtime);
  if (pendingApplied.applied) return { status: 'compacted', sessionId };
  if (pendingApplied.updatedMessages) messages = pendingApplied.updatedMessages;

  const window = await idleContextWindow(selection);
  if ('error' in window) return { status: 'error', error: window.error };
  const accounting = idleAccountingStore();
  if ('error' in accounting) return { status: 'error', error: accounting.error };
  const chainId = latestSessionChainId(sessionId);
  emitCompactionProgress(sessionId, 'preparing', 'Compacting context', {
    mode: runtime.config.compaction.main.mode,
  });
  const result = await tryCompactSynchronously({
    sessionId,
    messages,
    runtime,
    selection,
    contextTokens: window.contextTokens,
    accountingStore: accounting.store,
    chainId,
    turnId: randomUUID(),
    manual: true,
  });
  return idleCompactionOutcome(sessionId, result);
}
