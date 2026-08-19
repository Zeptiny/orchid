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
 */
import { randomUUID } from 'node:crypto';
import type { ModelSelection } from '../../../shared/types/provider';
import { ChainStatus } from '../../../shared/types/chain';
import type { Chain } from '../../../shared/types/chain';
import { compactedMarkerFromUnknown, type Message } from '../../../shared/types/message';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { ProjectRuntime } from '../../project/runtime';
import type { ProviderAccountingStore } from '../../providers/accounting/store';
import { getSessionManager } from '../../session/singleton';
import { onSessionDeleted } from '../../session/manager';
import { setChatHistory } from '../chat-history';
import { requestCompactionPause, clearCompactionPause, shouldPauseForCompaction } from '../next-request-stop';
import { publishSessionActivity } from '../session-activity';
import { estimateMessageChars, totalCharsForMessages } from '../../llm/compaction/message-chars';
import { selectCut, resolvePreservePercent, type CutResult } from '../../llm/compaction/select';
import { mechanicalReclaim } from '../../llm/compaction/reclaim';
import { summarizeCompactableRange, type SummarizeResult } from '../../llm/compaction/summarize';
import { buildCompactionApply, CompactionApplyError, stampCompactionMetrics, type ApplyResult } from '../../llm/compaction/apply';
import { CompactionTrigger } from '../../llm/compaction/trigger';
import {
  compactableModelSlice,
  filterUserFlaggedIds,
  runCompactionAttempt,
  unflagUserMessagesInApply,
  type CompactionAttemptOutcome,
} from '../../llm/compaction/run-attempt';
import type { SelectiveCompactionResult } from '../../llm/compaction/selective/run';
import { activeAgents } from './state';
import { buildSessionUpdatedEvent, sendSessionEvent, sendTurnEvent, webContentsForWindowId } from './events';
import {
  ensureToolSnapshot,
  updateToolSnapshot,
} from './snapshot';
import {
  persistCompactionBetweenTurns as persistCompaction,
  persistCompactionDurable,
} from './persist';

// ── Compaction state per session (U8, R13) ──────────────────────────────────

const compactionTriggers = new Map<string, CompactionTrigger>();
const compactionPending = new Map<string, {
  cut: CutResult;
  flaggedIds: string[];
  expectedIds?: string[];
  estimatedInput: number;
  contextTokens: number;
  mode: 'simple' | 'selective';
  promise?: Promise<SummarizeResult | null>;
  selectivePromise?: Promise<CompactionAttemptOutcome>;
}>();
const compactionRetryTried = new Set<string>();

// ── Compaction widget identity ──────────────────────────────────────────────

/** Tool-call ids of the sessions' CURRENT compaction widget (one per session). */
const compactionWidgetIds = new Map<string, string>();
let compactionWidgetCounter = 0;

/**
 * Tool-call id for the session's current compaction widget.
 *
 * One id per in-flight compaction, NOT one per session: renderer projections
 * upsert by id at the entry's original position, so reusing a session-stable
 * id would pin a later compaction's running widget above everything streamed
 * since the previous one. The id is held until the widget completes (or the
 * session's compaction state is cleared); the next compaction mints a fresh
 * id that appends at the tail.
 */
export function compactionWidgetToolId(sessionId: string): string {
  const existing = compactionWidgetIds.get(sessionId);
  if (existing) return existing;
  const id = `compaction-${sessionId}-${(compactionWidgetCounter += 1)}`;
  compactionWidgetIds.set(sessionId, id);
  return id;
}

function releaseCompactionWidgetToolId(sessionId: string): void {
  compactionWidgetIds.delete(sessionId);
}

export function clearCompactionState(sessionId: string): void {
  compactionTriggers.delete(sessionId);
  compactionPending.delete(sessionId);
  triggerCalibrationHydrated.delete(sessionId);
  releaseCompactionWidgetToolId(sessionId);
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

function completeCompactionWidget(sessionId: string): void {
  try {
    const active = activeAgents.get(sessionId);
    const compactionToolId = compactionWidgetToolId(sessionId);
    if (active && !active.finalized && active.toolCalls.has(compactionToolId)) {
      active.toolCalls.delete(compactionToolId);
      const wc = webContentsForWindowId(active.windowId);
      if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: '', toolResult: { schemaVersion: 1, family: 'generic', status: 'complete', completeness: 'complete', data: { value: '', origin: { kind: 'built-in', name: 'compaction' } } } as unknown as Record<string, unknown> });
    }
    clearCompactionPause(sessionId);
  } catch {
    // widget completion is best-effort; the id must still be released below
  } finally {
    releaseCompactionWidgetToolId(sessionId);
  }
}

/** Minimum interval between compaction live-progress emissions (IPC flood guard). */
export const COMPACTION_STREAM_EMIT_INTERVAL_MS = 100;

/**
 * Throttled live-progress emitter for the compaction widget: forwards the
 * compactor's accumulated LLM output as tool_call_update events with status
 * 'generating'. No-ops when the session has no active agent or the widget was
 * never created (e.g. send-time compaction before the stream starts), so it is
 * safe to pass unconditionally as onTextDelta. A trailing flush guarantees the
 * final accumulated text always lands even when deltas arrive in bursts.
 */
export function createCompactionStreamEmitter(sessionId: string): (accumulatedText: string) => void {
  // Bind to the widget id minted for THIS compaction: a trailing flush must
  // never target a later compaction's widget after this one completes and
  // releases its id.
  const compactionToolId = compactionWidgetToolId(sessionId);
  let lastEmitAt = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let latest = '';
  const flush = (): void => {
    trailingTimer = null;
    lastEmitAt = Date.now();
    const active = activeAgents.get(sessionId);
    if (!active || active.finalized) return;
    const current = active.toolCalls.get(compactionToolId);
    // Lifecycle guard: never resurrect a widget that already reached a
    // terminal state (the mid-turn resume path completes the snapshot without
    // deleting it) or was torn down — a trailing throttled flush landing after
    // the terminal update would otherwise flip it back to 'generating' forever.
    if (!current || (current.status !== 'generating' && current.status !== 'running')) return;
    // Calibrated char→token estimate for the streamed tail. Null when no
    // calibration exists yet — never a heuristic ratio.
    let estimatedTokens: number | null = null;
    try {
      const tpc = getCompactionTrigger(sessionId).state.tokensPerChar;
      if (typeof tpc === 'number' && Number.isFinite(tpc) && tpc > 0) {
        estimatedTokens = Math.ceil(latest.length * tpc);
      }
    } catch {
      // trigger unavailable (test env) — char count remains the display
    }
    updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'generating', content: latest, estimatedTokens });
    const wc = webContentsForWindowId(active.windowId);
    if (wc) {
      sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, {
        type: 'tool_call_update',
        toolCallId: compactionToolId,
        toolName: 'compaction',
        status: 'generating',
        content: latest,
        estimatedTokens,
      });
    }
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

export function dedupeHistoryById(messages: readonly Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.id && seen.has(m.id)) continue;
    if (m.id) seen.add(m.id);
    out.push(m);
  }
  return out;
}

function totalChars(messages: readonly Message[]): number {
  return totalCharsForMessages(messages);
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

function compactableTokenEstimate(messages: readonly Message[], range: { start: number; end: number }, tokensPerChar: number | undefined): number {
  if (tokensPerChar == null || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) return 0;
  let chars = 0;
  for (let i = range.start; i < range.end; i += 1) chars += estimateMessageChars(messages[i]!);
  return Math.ceil(chars * tokensPerChar);
}

/**
 * Calibrated slice estimator shared by the send-time and usage-event paths.
 * Counts the seven message fields directly — empty messages contribute zero
 * characters — then applies the slice-level minimum of one token per message.
 * Deliberately NOT estimateMessageChars: its per-message floor would
 * overestimate slices made of empty messages.
 */
function createCalibratedEstimator(tokensPerChar: number): (slice: readonly Message[]) => number {
  return (slice: readonly Message[]): number => {
    let chars = 0;
    for (const m of slice) {
      if (m.content) chars += m.content.length;
      if (m.thinking) chars += m.thinking.length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
      if (m.tool_result) chars += JSON.stringify(m.tool_result).length;
      if (m.tool_call_id) chars += m.tool_call_id.length;
      if (m.name) chars += m.name.length;
      if ((m as unknown as { compacted?: unknown }).compacted) chars += JSON.stringify((m as unknown as { compacted: unknown }).compacted).length;
    }
    return Math.max(slice.length, Math.ceil(chars * tokensPerChar));
  };
}

function isPendingCutStillValid(pending: { cut: CutResult; flaggedIds: string[]; expectedIds?: string[] }, messages: readonly Message[]): boolean {
  const { start, end } = pending.cut.compactableRange;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || end > messages.length || start >= end) return false;
  if (pending.cut.cutIndex < 0 || pending.cut.cutIndex > messages.length) return false;
  for (let i = start; i < end; i += 1) {
    const message = messages[i];
    if (!message) continue;
    // Mirrors apply.ts's tolerance: pre-flagged (excludeFromModel) messages in
    // range are fine — cancelled tool results and prior mechanical-reclaim
    // flags are already excluded from the model and buildCompactionApply skips
    // them instead of double-processing.
    // A compacted summary head DEEPER than the range start would summarize a
    // summary — invalidate. A head at index === start is being superseded
    // (select.ts lands compactableStart ON the old head so re-compaction can
    // re-summarize it), so it is allowed.
    if (i > start && compactedMarkerFromUnknown(message.compacted)) return false;
  }
  if (pending.flaggedIds.length > 0) {
    const idToMsg = new Map<string, Message>();
    for (const m of messages) idToMsg.set(m.id, m);
    for (const id of pending.flaggedIds) {
      const msg = idToMsg.get(id);
      if (!msg) return false;
      if (msg.excludeFromModel) return false;
    }
  }
  if (pending.expectedIds) {
    if (pending.expectedIds.length !== end - start) return false;
    for (let i = 0; i < pending.expectedIds.length; i += 1) {
      if (messages[start + i]?.id !== pending.expectedIds[i]) return false;
    }
  }
  return true;
}

// ── Selective persistence helper (minimal between-turns) ─────────────────────
function persistSelectiveCompaction(
  sessionId: string,
  result: Extract<SelectiveCompactionResult, { kind: 'selective' }>,
  cut: CutResult,
): boolean {
  try {
    const manager = getSessionManager();
    const existing = manager.getSession(sessionId) ?? manager.load(sessionId);
    if (!existing) return true;
    const flaggedSet = new Set(result.flaggedIds);
    const updatedAt = new Date().toISOString();
    // New replay rows produced by the selective run (synthetic summaries +
    // ranged copies) — every replay id that is not already durable.
    const existingIds = new Set(existing.chains.flatMap((c) => c.messages.map((m) => m.id)));
    const newReplayMessages = result.replayMessages.filter((m) => !existingIds.has(m.id)) as Message[];
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
    const preserveStart = cut.compactableRange.end;
    const insertBeforeMessageId = preserveStart < flatOriginal.length
      ? flatOriginal[preserveStart]!.id
      : null;
    // Single targeted durable transaction (same P0-safe path as the simple
    // mode): flags + summary head against FULL durable chain rows — never a
    // wholesale saveSession from the bounded in-memory view, which would
    // truncate pre-window history and wipe durable subagent rows.
    const durable = persistCompactionDurable({
      sessionId,
      flaggedMessageIds: [...flaggedSet],
      summaryChain,
      insertBeforeMessageId,
      updatedAt,
    });
    // Refresh the in-memory cache: flags applied wherever the view holds the
    // messages, summary chain spliced in at its durable position. Partial
    // arrays are fine — model replay history is maintained separately via
    // setChatHistory.
    const flaggedChains = existing.chains.map((chain) => {
      if (!chain.messages.some((m) => flaggedSet.has(m.id) && !m.excludeFromModel)) return chain;
      return {
        ...chain,
        messages: chain.messages.map((m) =>
          flaggedSet.has(m.id) && !m.excludeFromModel ? { ...m, excludeFromModel: true } : m,
        ),
      };
    });
    let cacheChains: Chain[] = [...flaggedChains] as Chain[];
    if (summaryChain && durable.summaryChainId === summaryChain.id) {
      const order = new Map(durable.chainIds.map((id, index) => [id, index] as const));
      const summaryPosition = order.get(summaryChain.id);
      if (summaryPosition === undefined) {
        cacheChains = [...flaggedChains, summaryChain] as Chain[];
      } else {
        let insertAt = flaggedChains.length;
        for (let index = 0; index < flaggedChains.length; index += 1) {
          const position = order.get(flaggedChains[index]!.id);
          if (position !== undefined && position > summaryPosition) {
            insertAt = index;
            break;
          }
        }
        cacheChains = [
          ...flaggedChains.slice(0, insertAt),
          summaryChain,
          ...flaggedChains.slice(insertAt),
        ] as Chain[];
      }
    }
    const nextSession = { ...existing, chains: cacheChains as typeof existing.chains, updatedAt } as typeof existing;
    manager.setCachedSession(nextSession as unknown as import('../../../shared/types/session').Session);
    {
      const prevIds = new Set(existing.chains.map((c) => c.id));
      const changedIds = new Set<string>();
      for (const c of cacheChains) {
        const prev = existing.chains.find((p) => p.id === c.id);
        if (!prev || prev.messages.length !== c.messages.length || prev.messages.some((m, i) => m.excludeFromModel !== c.messages[i]?.excludeFromModel)) changedIds.add(c.id);
      }
      for (const c of cacheChains) if (!prevIds.has(c.id)) changedIds.add(c.id);
      for (const chainId of changedIds) {
        const chain = nextSession.chains.find((c) => c.id === chainId);
        if (!chain) continue;
        const event = buildSessionUpdatedEvent(nextSession as unknown as import('../../../shared/types/session').Session, chain.id);
        if (!event) continue;
        sendSessionEvent(null, sessionId, IPC_CHANNELS.SESSION_UPDATED, event);
      }
      const compactionEvent = { sessionId, updatedAt: nextSession.updatedAt };
      sendSessionEvent(null, sessionId, IPC_CHANNELS.SESSION_COMPACTION, compactionEvent);
    }
    return true;
  } catch (err) {
    console.debug('[compaction] selective chain persist failed (non-fatal):', err);
    return false;
  }
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
  return dedupeHistoryById([...prefix, ...suffix]);
}

export async function applyPendingCompactionIfAny(
  sessionId: string,
  messages: Message[],
  runtime: ProjectRuntime,
): Promise<{ applied: boolean; updatedMessages?: Message[] }> {
  const pending = compactionPending.get(sessionId);
  if (!pending) return { applied: false };
  // The pending cut/expectedIds were computed over the deduped history
  // (handleUsageCompaction dedupes). Mid-turn callers concatenate
  // [...messages, ...turnMessagesFromAgent()] where the turn base repeats
  // the triggering user message, so dedupe here or the index-anchored
  // validation below rejects every mid-turn apply.
  const history = dedupeHistoryById(messages);
  if (!isPendingCutStillValid(pending, history)) {
    compactionPending.delete(sessionId);
    const t = getCompactionTrigger(sessionId);
    t.abortPrepare();
    completeCompactionWidget(sessionId);
    return { applied: false };
  }
  compactionPending.delete(sessionId);
  const trigger = getCompactionTrigger(sessionId);
  try {
    // ── Selective pending ───────────────────────────────────────────────
    if (pending.mode === 'selective' && pending.selectivePromise) {
      const outcome = await pending.selectivePromise;
      if (outcome.kind !== 'ran') {
        trigger.abortPrepare();
        completeCompactionWidget(sessionId);
        return { applied: false };
      }
      const result = outcome.result;
      if (result.kind === 'selective') {
        // Atomic: DB first, then memory. Single DB write via persistSelectiveCompaction.
        const ok = persistSelectiveCompaction(sessionId, result, pending.cut);
        if (!ok) {
          trigger.abortPrepare();
          completeCompactionWidget(sessionId);
          return { applied: false };
        }
        // Re-anchor at apply time: the prepare-time replay never saw messages
        // appended after the prepare (e.g. the NEXT turn's user message), so
        // only its compactable prefix is reused — the preserved suffix is
        // re-derived from the current history (P1 #5).
        const reanchored = reanchorSelectiveReplay(result.replayMessages, history, pending.cut.cutIndex);
        setChatHistory(sessionId, [...reanchored]);
        const postTokens = (() => {
          const tpc = trigger.state.tokensPerChar ?? (totalChars(reanchored) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
          return tpc ? Math.ceil(totalChars(reanchored) * tpc) : pending.estimatedInput;
        })();
        trigger.onCompactionApplied(pending.estimatedInput, postTokens);
        trigger.abortPrepare();
        completeCompactionWidget(sessionId);
        return { applied: true, updatedMessages: [...reanchored] };
      }
      if (result.kind === 'fallback' && result.fallbackText && result.fallbackText.trim()) {
        const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
        let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
        try {
          applyResult = buildCompactionApply({
            messages: history,
            chains: chains as Chain[],
            cutResult: pending.cut,
            summaryText: result.fallbackText,
            mode: runtime.config.compaction.main.mode,
            flaggedIds: pending.flaggedIds,
            sessionId,
          });
        } catch (e) {
          if (e instanceof CompactionApplyError) {
            trigger.abortPrepare();
            completeCompactionWidget(sessionId);
            compactionPending.delete(sessionId);
            return { applied: false };
          }
          throw e;
        }
        if (applyResult.didApply) {
          // Unified R9 (#11a): the selective fallback never flags user
          // messages — the same protection the subagent scope applies.
          applyResult = unflagUserMessagesInApply(applyResult, history);
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
          // Fallback replay without summary — treat as selective success with single DB write via helper if possible
          const selectiveLike = { kind: 'selective' as const, replayMessages: result.replayMessages, flaggedIds: filterUserFlaggedIds(history, result.flaggedIds ?? pending.flaggedIds), summaryMessages: [], summaryMessage: result.summaryMessage ?? null } as unknown as Extract<SelectiveCompactionResult, { kind: 'selective' }>;
          const ok = persistSelectiveCompaction(sessionId, selectiveLike, pending.cut);
          let reanchored: Message[] | undefined;
          if (ok) {
            // Same apply-time re-anchoring as the selective-success branch (P1 #5).
            reanchored = reanchorSelectiveReplay(result.replayMessages, history, pending.cut.cutIndex);
            setChatHistory(sessionId, [...reanchored]);
            const tpc = trigger.state.tokensPerChar ?? (totalChars(reanchored) > 0 ? pending.estimatedInput / Math.max(1, totalChars(history)) : undefined);
            const postTokens = tpc ? Math.ceil(totalChars(reanchored) * tpc) : pending.estimatedInput;
            trigger.onCompactionApplied(pending.estimatedInput, postTokens);
          }
          trigger.abortPrepare();
          completeCompactionWidget(sessionId);
          return { applied: ok, updatedMessages: reanchored ? [...reanchored] : undefined };
        }
      }
      trigger.abortPrepare();
      completeCompactionWidget(sessionId);
      return { applied: false };
    }
    // ── Simple pending (existing) ───────────────────────────────────────
    if (pending.promise) {
      const result = await pending.promise;
      if (result && result.text && result.text.trim()) {
        const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
        let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
        try {
          applyResult = buildCompactionApply({
            messages: history,
            chains: chains as Chain[],
            cutResult: pending.cut,
            summaryText: result.text,
            mode: runtime.config.compaction.main.mode,
            flaggedIds: pending.flaggedIds,
            sessionId,
          });
        } catch (e) {
          if (e instanceof CompactionApplyError) {
            trigger.abortPrepare();
            completeCompactionWidget(sessionId);
            return { applied: false };
          }
          throw e;
        }
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
      trigger.abortPrepare();
      completeCompactionWidget(sessionId);
      return { applied: false };
    }
    // Reclaim-only pending
    if (pending.flaggedIds.length > 0) {
      const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
      let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
      try {
        applyResult = buildCompactionApply({
          messages: history,
          chains: chains as Chain[],
          cutResult: pending.cut,
          summaryText: null,
          mode: runtime.config.compaction.main.mode,
          flaggedIds: pending.flaggedIds,
          sessionId,
        });
      } catch (e) {
        if (e instanceof CompactionApplyError) {
          trigger.abortPrepare();
          completeCompactionWidget(sessionId);
          return { applied: false };
        }
        throw e;
      }
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
    trigger.abortPrepare();
    completeCompactionWidget(sessionId);
  } catch (err) {
    console.debug('[compaction] pending apply failed (non-fatal):', err);
    const t = getCompactionTrigger(sessionId);
    t.abortPrepare();
    completeCompactionWidget(sessionId);
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
): Promise<{ didApply: boolean; updatedMessages?: Message[] }> {
  const trigger = getCompactionTrigger(sessionId);
  const cfg = runtime.config.compaction?.main;
  if (!cfg) return { didApply: false };
  // Models without a configured context window never compact proactively:
  // fabricating an assumed window here diverged from the mid-turn usage path,
  // which is disabled when the limit is unknown.
  if (contextTokens == null || !Number.isFinite(contextTokens) || contextTokens <= 0) return { didApply: false };
  const windowTokens: number = contextTokens;
  if (trigger.state.pendingPrepare) return { didApply: false };
  try {
    // Single-pass: compute totalChars once, reuse for estimate and trigger ratio
    const totalCharsValue = totalChars(messages);
    let tokensPerChar = trigger.state.tokensPerChar;
    if (tokensPerChar == null && Number.isFinite(trigger.state.lastObservedInputTokens ?? NaN) && totalCharsValue > 0) {
      const obs = trigger.state.lastObservedInputTokens as number;
      const r = obs / totalCharsValue;
      if (Number.isFinite(r) && r > 0) tokensPerChar = Math.max(0.05, Math.min(r, 2));
    }
    // Hard rule: never estimate with a heuristic chars/4 ratio. Without a
    // calibrated tokens-per-char (provider usage or hydrated observation) the
    // input estimate is unknown and proactive send-time compaction is skipped.
    // The overflow-retry path and mid-turn usage events remain as backstops,
    // and the first observed usage calibrates all future estimates.
    if (tokensPerChar == null || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) {
      return { didApply: false };
    }
    const estimatedInput = Math.ceil(totalCharsValue * tokensPerChar);
    // Early gate before expensive selectCut/reclaim: only proceed if threshold crossed or hysteresis accrual allows re-fire
    const ratio = estimatedInput / windowTokens;
    const hysteresisDelta = cfg.hysteresis_delta ?? 0.1;
    const isOverWindow = estimatedInput >= windowTokens;
    if (ratio + 1e-9 < cfg.threshold && !isOverWindow) {
      const baseline = trigger.state.postCompactionInputTokens;
      if (!(trigger.state.hysteresisArmed && typeof baseline === 'number' && estimatedInput - baseline >= cfg.min_compactable_tokens)) {
        return { didApply: false };
      }
    }
    const calibratedEstimator = createCalibratedEstimator(tokensPerChar);
    const cut = selectCut(messages, {
      preserveTokens: Math.floor(resolvePreservePercent(cfg) * windowTokens),
      tokenEstimator: calibratedEstimator,
    });
    if (cut.compactableRange.end <= cut.compactableRange.start) return { didApply: false };
    const compactableTokens = compactableTokenEstimate(messages, cut.compactableRange, tokensPerChar);
    if (compactableTokens < cfg.min_compactable_tokens) return { didApply: false };
    // Gate reclaim behind threshold: only compute reclaim if we passed the gates above
    const reclaim = mechanicalReclaim(messages, cut.compactableRange);
    const flaggedIds = reclaim.flaggedIds;
    const decision = trigger.evaluateWithReclaim({
      inputTokens: estimatedInput,
      contextTokens,
      threshold: cfg.threshold,
      hysteresisDelta,
      compactableTokens,
      minCompactableTokens: cfg.min_compactable_tokens,
      compactableRange: cut.compactableRange,
      messages,
      flaggedIds,
      estimatedInputTokens: estimatedInput,
    });
    if (!decision.shouldPrepare && !decision.shouldApply) return { didApply: false };
    const chains = getSessionManager().getSession(sessionId)?.chains ?? [];
    if (decision.shouldApply && !decision.shouldPrepare) {
      let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
      try {
        applyResult = buildCompactionApply({
          messages,
          chains: chains as Chain[],
          cutResult: cut,
          summaryText: null,
          mode: cfg.mode,
          flaggedIds,
          sessionId,
        });
      } catch (e) {
        if (e instanceof CompactionApplyError) return { didApply: false };
        throw e;
      }
      if (!applyResult.didApply) return { didApply: false };
      const ok = persistCompaction(sessionId, applyResult);
      if (!ok) return { didApply: false };
      setChatHistory(sessionId, [...applyResult.updatedMessages]);
      const tpc2 = trigger.state.tokensPerChar ?? tokensPerChar;
      const postTokens = Math.ceil(totalChars(applyResult.updatedMessages) * tpc2);
      trigger.onCompactionApplied(estimatedInput, postTokens);
      return { didApply: true, updatedMessages: [...applyResult.updatedMessages] };
    }
    if (decision.shouldPrepare) {
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
          const ok = persistSelectiveCompaction(sessionId, selResult, cut);
          if (!ok) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...selResult.replayMessages]);
          const tpcSel = trigger.state.tokensPerChar ?? tokensPerChar;
          const postTokensSel = Math.ceil(totalChars(selResult.replayMessages) * tpcSel);
          trigger.onCompactionApplied(estimatedInput, postTokensSel);
          trigger.abortPrepare();
          return { didApply: true, updatedMessages: [...selResult.replayMessages] };
        }
        if (selResult.kind === 'fallback' && selResult.fallbackText && selResult.fallbackText.trim()) {
          let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
          try {
            applyResult = buildCompactionApply({
              messages,
              chains: chains as Chain[],
              cutResult: cut,
              summaryText: selResult.fallbackText,
              mode: cfg.mode,
              flaggedIds,
              sessionId,
            });
          } catch (e) {
            if (e instanceof CompactionApplyError) {
              trigger.abortPrepare();
              return { didApply: false };
            }
            throw e;
          }
          if (!applyResult.didApply) {
            if (selResult.replayMessages && selResult.replayMessages.length > 0) {
              // fallback replay without summary — single DB write via selective helper
              // If flaggedIds derived from manifest, use those; else use flaggedIds from reclaim
              const flaggedForLike = filterUserFlaggedIds(messages, (selResult.flaggedIds ?? flaggedIds) as string[]);
              const like2: Extract<SelectiveCompactionResult, { kind: 'selective' }> = { kind: 'selective', replayMessages: selResult.replayMessages!, flaggedIds: flaggedForLike, summaryMessages: [], summaryMessage: selResult.summaryMessage ?? null, correctedOps: [], attempts: selResult.attempts } as unknown as Extract<SelectiveCompactionResult, { kind: 'selective' }>;
              const ok2 = persistSelectiveCompaction(sessionId, like2, cut);
              if (ok2) {
                setChatHistory(sessionId, [...selResult.replayMessages!]);
                const tpcF = trigger.state.tokensPerChar ?? tokensPerChar;
                const postF = Math.ceil(totalChars(selResult.replayMessages!) * tpcF);
                trigger.onCompactionApplied(estimatedInput, postF);
              }
              trigger.abortPrepare();
              return { didApply: ok2, updatedMessages: ok2 ? [...selResult.replayMessages!] : undefined };
            }
            trigger.abortPrepare();
            return { didApply: false };
          }
          // Unified R9 (#11a): the selective fallback never flags user
          // messages — the same protection the subagent scope applies.
          applyResult = unflagUserMessagesInApply(applyResult, messages);
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
          const flaggedForFallback = filterUserFlaggedIds(messages, (selResult.flaggedIds ?? flaggedIds) as string[]);
          const like3: Extract<SelectiveCompactionResult, { kind: 'selective' }> = { kind: 'selective', replayMessages: selResult.replayMessages, flaggedIds: flaggedForFallback, summaryMessages: [], summaryMessage: selResult.summaryMessage ?? null, correctedOps: [], attempts: selResult.attempts } as unknown as Extract<SelectiveCompactionResult, { kind: 'selective' }>;
          const ok3 = persistSelectiveCompaction(sessionId, like3, cut);
          if (!ok3) {
            trigger.abortPrepare();
            return { didApply: false };
          }
          setChatHistory(sessionId, [...selResult.replayMessages]);
          const tpcF3 = trigger.state.tokensPerChar ?? tokensPerChar;
          const postF3 = Math.ceil(totalChars(selResult.replayMessages) * tpcF3);
          trigger.onCompactionApplied(estimatedInput, postF3);
          trigger.abortPrepare();
          return { didApply: true, updatedMessages: [...selResult.replayMessages] };
        }
        trigger.abortPrepare();
        return { didApply: false };
      }
      // ── Simple branch (unchanged) ─────────────────────────────────────
      const rawSlice2 = messages.slice(cut.compactableRange.start, cut.compactableRange.end);
      const slice = rawSlice2.filter((m) => !m.excludeFromModel && !m.hidden);
      if (slice.length === 0) return { didApply: false };
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      const result = await summarizeCompactableRange({
        messages: slice,
        scope: 'main',
        config: runtime.config,
        fallbackSelection: selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
        runtime,
        onTextDelta: createCompactionStreamEmitter(sessionId),
      });
      if (!result || !result.text || !result.text.trim()) {
        trigger.abortPrepare();
        return { didApply: false };
      }
      let applyResult: ReturnType<typeof buildCompactionApply> | null = null;
      try {
        applyResult = buildCompactionApply({
          messages,
          chains: chains as Chain[],
          cutResult: cut,
          summaryText: result.text,
          mode: cfg.mode,
          flaggedIds,
          sessionId,
        });
      } catch (e) {
        if (e instanceof CompactionApplyError) {
          trigger.abortPrepare();
          return { didApply: false };
        }
        throw e;
      }
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
  // Single-pass totalChars reuse + early threshold gate (avoids 4× scans per CHAT_USAGE)
  const totalCharsValue = totalChars(history);
  // Derive calibrated tokensPerChar from provider inputTokens / totalChars (no /4 fallback)
  let tokensPerChar: number | undefined = trigger.state.tokensPerChar;
  if (totalCharsValue > 0 && Number.isFinite(inputTokens) && inputTokens > 0) {
    const r = inputTokens / totalCharsValue;
    if (Number.isFinite(r) && r > 0) {
      const clamped = Math.max(0.05, Math.min(r, 2));
      tokensPerChar = clamped;
      trigger.state.tokensPerChar = clamped;
    }
  }
  trigger.state.lastObservedInputTokens = inputTokens;
  trigger.onUsage(inputTokens, effectiveContextTokens, cfg.threshold, cfg.hysteresis_delta);
  if (trigger.state.pendingPrepare) return;
  if (compactionPending.has(sessionId)) return;
  // Calibrate-or-skip: this path always receives provider-reported inputTokens,
  // so a missing calibration means the usage payload was unusable — skip
  // rather than estimate.
  if (tokensPerChar == null || !Number.isFinite(tokensPerChar) || tokensPerChar <= 0) return;
  const calibratedRatio = tokensPerChar;
  const isOverWindow = inputTokens >= effectiveContextTokens;
  if (!isOverWindow) {
    const ratio = inputTokens / effectiveContextTokens;
    if (ratio + 1e-9 < cfg.threshold) {
      const baseline = trigger.state.postCompactionInputTokens;
      if (!(trigger.state.hysteresisArmed && typeof baseline === 'number' && Number.isFinite(baseline) && inputTokens - baseline >= cfg.min_compactable_tokens)) {
        return;
      }
    }
  }
  try {
    const calibratedEstimator2 = createCalibratedEstimator(calibratedRatio);
    const cut = selectCut(history, {
      preserveTokens: Math.floor(resolvePreservePercent(cfg) * effectiveContextTokens),
      tokenEstimator: calibratedEstimator2,
    });
    if (cut.compactableRange.end <= cut.compactableRange.start) return;
    const compactableTokens = compactableTokenEstimate(history, cut.compactableRange, tokensPerChar);
    if (compactableTokens < cfg.min_compactable_tokens) return;
    const reclaim = mechanicalReclaim(history, cut.compactableRange);
    const flaggedIds = reclaim.flaggedIds;
    const decision = trigger.evaluateWithReclaim({
      inputTokens,
      contextTokens: effectiveContextTokens,
      threshold: cfg.threshold,
      hysteresisDelta: cfg.hysteresis_delta,
      compactableTokens,
      minCompactableTokens: cfg.min_compactable_tokens,
      compactableRange: cut.compactableRange,
      messages: history,
      flaggedIds,
    });
    if (!decision.shouldPrepare && !decision.shouldApply) return;
    if (decision.shouldApply && !decision.shouldPrepare) {
      const expectedIds = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
      compactionPending.set(sessionId, { cut, flaggedIds, expectedIds, estimatedInput: inputTokens, contextTokens: effectiveContextTokens, mode: cfg.mode });
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      try {
        const active = activeAgents.get(sessionId);
        if (active && !active.finalized) {
          const compactionToolId = compactionWidgetToolId(sessionId);
          ensureToolSnapshot(active, compactionToolId, 'compaction');
          updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'reclaiming', mode: cfg.mode }), content: null, toolResult: null, finishedAt: null });
          const wc = webContentsForWindowId(active.windowId);
          if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'reclaiming', mode: cfg.mode }) });
        }
      } catch {
        // widget snapshot updates are best-effort
      }
      if (!shouldPauseForCompaction(sessionId)) {
        requestCompactionPause(sessionId);
        publishSessionActivity(sessionId, { cwd: runtime.projectDir ?? '', state: 'working', phase: 'agent', detail: 'Compacting context — reclaiming duplicates…', canCancel: true });
      }
      return;
    }
    if (decision.shouldPrepare) {
      // ── Selective pending branch ──────────────────────────────────────
      if (cfg.mode === 'selective') {
        const slice = compactableModelSlice(history, cut.compactableRange);
        if (slice.length === 0) return;
        const selectivePromise = runCompactionAttempt({
          messages: history,
          cut,
          scope: 'main',
          config: runtime.config,
          deps: {
            fallbackSelection: selection,
            runtime,
            accounting: { store: accountingStore, sessionId, chainId, turnId },
            onPrepared: () => trigger.markPrepareStarted(cut.compactableRange, flaggedIds),
            onTextDelta: createCompactionStreamEmitter(sessionId),
          },
          maxCorrectionRounds: 3,
        });
        const expectedIdsForSelective = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
        compactionPending.set(sessionId, { cut, flaggedIds, expectedIds: expectedIdsForSelective, estimatedInput: inputTokens, contextTokens: effectiveContextTokens, mode: 'selective', selectivePromise });
        selectivePromise.catch((err) => {
          console.debug('[compaction] selective prepare failed (non-fatal):', err);
          try {
            const active = activeAgents.get(sessionId);
            if (active && !active.finalized) {
              const compactionToolId = compactionWidgetToolId(sessionId);
              const wc = webContentsForWindowId(active.windowId);
              const result = { schemaVersion: 1 as const, family: 'generic' as const, status: 'complete' as const, completeness: 'complete' as const, data: { value: '', origin: { kind: 'built-in' as const, name: 'compaction' } } };
              updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'complete', args: '', content: '', toolResult: result as unknown as never, finishedAt: new Date().toISOString() });
              if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: '', toolResult: result as unknown as Record<string, unknown> });
            }
          } catch {
            // widget completion is best-effort on prepare failure
          }
        });
        try {
          const active = activeAgents.get(sessionId);
          if (active && !active.finalized) {
            const compactionToolId = compactionWidgetToolId(sessionId);
            ensureToolSnapshot(active, compactionToolId, 'compaction');
            updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'selective' }), content: null, toolResult: null, finishedAt: null });
            const wc = webContentsForWindowId(active.windowId);
            if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'selective' }) });
          }
        } catch {
          // widget snapshot updates are best-effort
        }
        if (!shouldPauseForCompaction(sessionId)) {
          requestCompactionPause(sessionId);
          publishSessionActivity(sessionId, { cwd: runtime.projectDir ?? '', state: 'working', phase: 'agent', detail: 'Compacting context — summarizing history…', canCancel: true });
        }
        return;
      }
      // ── Simple pending branch (unchanged) ─────────────────────────────
      const rawSlice2 = history.slice(cut.compactableRange.start, cut.compactableRange.end);
      const slice = rawSlice2.filter((m) => !m.excludeFromModel && !m.hidden);
      if (slice.length === 0) return;
      trigger.markPrepareStarted(cut.compactableRange, flaggedIds);
      const promise = summarizeCompactableRange({
        messages: slice,
        scope: 'main',
        config: runtime.config,
        fallbackSelection: selection,
        accounting: { store: accountingStore, sessionId, chainId, turnId },
        runtime,
        onTextDelta: createCompactionStreamEmitter(sessionId),
      });
      const expectedIdsForSimple = history.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
      compactionPending.set(sessionId, { cut, flaggedIds, expectedIds: expectedIdsForSimple, promise, estimatedInput: inputTokens, contextTokens: effectiveContextTokens, mode: 'simple' });
      promise.catch((err) => {
        console.debug('[compaction] prepare failed (non-fatal):', err);
        try {
          const active = activeAgents.get(sessionId);
          if (active && !active.finalized) {
            const compactionToolId = compactionWidgetToolId(sessionId);
            const wc = webContentsForWindowId(active.windowId);
            const result = { schemaVersion: 1 as const, family: 'generic' as const, status: 'complete' as const, completeness: 'complete' as const, data: { value: '', origin: { kind: 'built-in' as const, name: 'compaction' } } };
            updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'complete', args: '', content: '', toolResult: result as unknown as never, finishedAt: new Date().toISOString() });
            if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'complete', args: '', content: '', toolResult: result as unknown as Record<string, unknown> });
          }
        } catch {
          // widget completion is best-effort on prepare failure
        }
      });
      try {
        const active = activeAgents.get(sessionId);
        if (active && !active.finalized) {
          const compactionToolId = compactionWidgetToolId(sessionId);
          ensureToolSnapshot(active, compactionToolId, 'compaction');
          updateToolSnapshot(active, compactionToolId, 'compaction', { status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'simple' }), content: null, toolResult: null, finishedAt: null });
          const wc = webContentsForWindowId(active.windowId);
          if (wc) sendTurnEvent(wc, active, IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE, { type: 'tool_call_update', toolCallId: compactionToolId, toolName: 'compaction', status: 'running', args: JSON.stringify({ phase: 'summarizing', mode: 'simple' }) });
        }
      } catch {
        // widget snapshot updates are best-effort
      }
      if (!shouldPauseForCompaction(sessionId)) {
        requestCompactionPause(sessionId);
        publishSessionActivity(sessionId, { cwd: runtime.projectDir ?? '', state: 'working', phase: 'agent', detail: 'Compacting context — summarizing history…', canCancel: true });
      }
    }
  } catch (err) {
    console.debug('[compaction] usage trigger failed (non-fatal):', err);
  }
}
