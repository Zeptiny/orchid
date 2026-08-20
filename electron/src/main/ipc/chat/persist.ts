import type { WebContents } from 'electron';
import type { AgentContext } from '../../agents/xstate/agent-machine';
import type { Agent } from '../../../shared/types/agent';
import type { ModelSelection } from '../../../shared/types/provider';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { Message, Usage } from '../../../shared/types/message';
import { ChainStatus, type Chain } from '../../../shared/types/chain';
import type { Session } from '../../../shared/types/session';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { getSessionManager } from '../../session/singleton';
import { setChatHistory } from '../chat-history';
import {
  makeAssistantMessage,
  makeThinkingMessage,
} from '../../llm/message-factories';
import { activeAgents, pendingCheckpoints, type ActiveAgent } from './state';
import { buildSessionUpdatedEvent, sendSessionEvent, webContentsForWindowId } from './events';
import { textSegmentIdAtOffset } from './snapshot';
import type { CompactionPersistenceResult } from '../../session/storage';

// ── Compaction persistence (U7) ─────────────────────────────────────────────
// Re-export pure build for convenience; integration helpers below ride the
// existing turn-persistence paths so crash semantics match prior behavior.
// Between-turns persistence is documented as single-transaction (saveSession)
// which atomically replaces flagged chains + inserts the summary head.

export function attachUsageToLatestAssistant(messages: Message[], usage: Usage): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === MessageRole.ASSISTANT && message.type === MessageType.TEXT) {
      // Compaction summary heads are synthetic handoff records, not model
      // output. A later step's usage must never be attributed to one (it
      // would render as a bogus "tokens freed" figure) — keep searching.
      if (message.compacted) continue;
      messages[index] = { ...message, usage };
      return true;
    }
  }
  return false;
}

/** Append the current uncommitted live tail to a turn-local message snapshot. */
export function appendLiveTailMessages(
  messages: Message[],
  agent: ActiveAgent,
  context: Pick<
    AgentContext,
    'response' | 'thinking' | 'thinkingPayloads' | 'thinkingArtifacts' | 'usage'
  > | undefined,
  opts?: { placeholderWhenEmpty?: boolean },
): void {
  const partialResponse = context?.response ?? '';
  const thinking = context?.thinking ?? '';
  const usage = context?.usage ?? null;

  if (thinking.length > agent.thinkingCommittedLength) {
    const segment = thinking.slice(agent.thinkingCommittedLength);
    if (segment.trim()) {
      messages.push(makeThinkingMessage(
        segment,
        textSegmentIdAtOffset(agent, 'thinking', agent.thinkingCommittedLength),
        context?.thinkingPayloads?.[thinking.length],
      ));
    }
  }
  const artifacts = context?.thinkingArtifacts ?? [];
  for (let index = agent.thinkingArtifactsCommitted; index < artifacts.length; index += 1) {
    messages.push(makeThinkingMessage('', undefined, artifacts[index]));
  }

  const remaining = partialResponse.slice(agent.responseCommittedLength);
  if (remaining) {
    messages.push(makeAssistantMessage(
      remaining,
      usage,
      textSegmentIdAtOffset(agent, 'text', agent.responseCommittedLength),
    ));
  } else if (opts?.placeholderWhenEmpty && messages.length === 0) {
    messages.push(makeAssistantMessage(
      partialResponse,
      usage,
      textSegmentIdAtOffset(agent, 'text', agent.responseCommittedLength),
    ));
  } else if (usage && !attachUsageToLatestAssistant(messages, usage)) {
    messages.push({
      ...makeAssistantMessage('', usage),
      hidden: true,
    });
  }
}

/**
 * Flush partial stream content into turnMessages (thinking + uncommitted
 * assistant text). Shared by forceAbort, replace-on-send, and error paths.
 */
export function flushPartialTurnContent(agent: ActiveAgent, context: AgentContext | undefined): void {
  const partialResponse = context?.response ?? '';
  const thinking = context?.thinking ?? '';
  appendLiveTailMessages(agent.turnMessages, agent, context);
  if (thinking.length > agent.thinkingCommittedLength) {
    agent.thinkingCommittedLength = thinking.length;
  }
  const artifacts = context?.thinkingArtifacts ?? [];
  if (artifacts.length > agent.thinkingArtifactsCommitted) {
    agent.thinkingArtifactsCommitted = artifacts.length;
  }
  if (partialResponse.length > agent.responseCommittedLength) {
    agent.responseCommittedLength = partialResponse.length;
  }
}

/**
 * Build turn-local messages for multi-chain storage:
 * current user message (+ any pre-turn messages after priorMessageCount) +
 * tool/assistant messages produced during the turn.
 *
 * Durable writes prefer `transcriptBase` — the transcript-complete turn slice
 * kept after a mid-turn compaction swapped `messages` to the model-view replay
 * (which drops flagged originals and superseded heads).
 */
export function turnMessagesFromAgent(agent: ActiveAgent): Message[] {
  const turnBase = agent.transcriptBase ?? agent.messages.slice(agent.priorMessageCount);
  return [...turnBase, ...agent.turnMessages];
}

/**
 * Materialize the turn-local history including the uncommitted live tail,
 * without mutating committed turn state. Used by checkpoint persistence and
 * by mid-turn session naming.
 */
export function currentTurnSnapshot(
  agent: ActiveAgent,
  context: Pick<
    AgentContext,
    'response' | 'thinking' | 'thinkingPayloads' | 'thinkingArtifacts' | 'usage'
  > | undefined,
): Message[] {
  const snapshot = turnMessagesFromAgent(agent);
  appendLiveTailMessages(snapshot, agent, context);
  return snapshot;
}

/** Materialize the current live tail without mutating committed turn state. */
function checkpointMessagesFromAgent(agent: ActiveAgent, context: AgentContext): Message[] {
  return currentTurnSnapshot(agent, context);
}

const CHECKPOINT_DEBOUNCE_MS = 300;

/**
 * Schedule one debounced checkpoint write for a session's active turn.
 *
 * The snapshot is RE-DERIVED at fire time from the live agent, never captured
 * at schedule time: a checkpoint scheduled by the same usage event that
 * triggers a compaction fires after the pause-apply, and a schedule-time
 * snapshot would be the stale pre-compaction slice — wholesale-replacing the
 * active chain row and erasing the just-written flags and inline summary head
 * (review #55). Fire-time derivation always reflects the current
 * transcriptBase/turnMessages.
 */
function scheduleCheckpoint(
  sessionId: string,
  snapshot: () => Message[],
  guard?: (active: ActiveAgent) => boolean,
): void {
  const existing = pendingCheckpoints.get(sessionId);
  if (existing) {
    existing.snapshot = snapshot;
    existing.guard = guard;
    return;
  }
  const timer = setTimeout(() => {
    const entry = pendingCheckpoints.get(sessionId);
    pendingCheckpoints.delete(sessionId);
    const active = activeAgents.get(sessionId);
    if (!active || active.finalized) return;
    // The entry (if any) was refreshed on every reschedule, so its guard is
    // the LATEST one — falling back to this closure's guard would resurrect
    // the FIRST schedule's stale guard when the latest schedule passed none.
    const effectiveGuard = entry ? entry.guard : guard;
    if (effectiveGuard && !effectiveGuard(active)) return;
    try {
      const updated = getSessionManager().updateActiveChainMessages(
        (entry ?? { snapshot }).snapshot(),
        sessionId,
      );
      const update = updated ? buildSessionUpdatedEvent(updated) : null;
      if (update) {
        sendSessionEvent(
          webContentsForWindowId(active.windowId),
          sessionId,
          IPC_CHANNELS.SESSION_UPDATED,
          update,
        );
      }
    } catch (err) {
      console.debug('Failed to checkpoint active chat chain (non-fatal):', err);
    }
  }, CHECKPOINT_DEBOUNCE_MS);
  pendingCheckpoints.set(sessionId, { timer, snapshot, guard });
}

/** Persist one bounded main-turn checkpoint, debounced per session. */
export function checkpointActiveTurn(agent: ActiveAgent, context: AgentContext): void {
  const sessionId = agent.sessionId;
  scheduleCheckpoint(sessionId, () => checkpointMessagesFromAgent(agent, context));
}

/** Cancel any pending debounced checkpoint for a session. */
export function cancelPendingCheckpoint(sessionId: string): void {
  const pending = pendingCheckpoints.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCheckpoints.delete(sessionId);
  }
}

/**
 * Persist flat LLM history + turn-local multi-chain write.
 *
 * - Window chatHistory keeps the full flattened conversation for the next send.
 * - Session storage writes only `turnMessages` onto the ACTIVE chain (or
 *   creates one via persistTurn when startChain was skipped).
 */
export function persistTurnConversation(
  sessionId: string,
  fullHistory: Message[],
  turnMessages: Message[],
  status: ChainStatus,
  agent: Agent,
  selection?: ModelSelection | null,
  webContents?: WebContents,
  errorDetail?: string | null,
  errorTitle?: string | null,
): void {
  setChatHistory(sessionId, fullHistory);
  try {
    const sessionManager = getSessionManager();
    const updated = sessionManager.persistTurn({
      messages: turnMessages,
      status,
      selection,
      modelLabel: selection?.modelId ?? null,
      agentName: agent.name,
      agentType: agent.type,
      agentTier: agent.tier,
      errorDetail,
      errorTitle,
    }, sessionId);
    const update = updated ? buildSessionUpdatedEvent(updated, null) : null;
    if (update && webContents) {
      sendSessionEvent(webContents, sessionId, IPC_CHANNELS.SESSION_UPDATED, update);
    }
  } catch (err) {
    console.debug('Failed to persist chat chain (non-fatal):', err);
  }
}

/** Flatten all session chains — never only the active/last chain. */
export function historyFromSession(sessionId: string): Message[] {
  return getSessionManager().getModelHistory(sessionId);
}

// ── Compaction integration helpers (U7) ─────────────────────────────────────

/** Apply-result surface the between-turns persist needs. */
export interface CompactionApplyResultLike {
  readonly updatedChains: readonly Chain[];
  readonly newChain: Chain | null;
  readonly didApply: boolean;
  /** Flat replay after the pure apply (summary head inserted at cutIndex). */
  readonly updatedMessages?: readonly Message[];
  readonly summaryMessage?: Message | null;
  readonly flaggedIds?: readonly string[];
}

/** Reusable durable compaction input (shared by simple + selective paths). */
export interface CompactionDurablePersistInput {
  readonly sessionId: string;
  /**
   * Message ids that must become `excludeFromModel` in their durable chains.
   * Storage resolves each id against durable rows and refuses partial sets.
   */
  readonly flaggedMessageIds: readonly string[];
  /** Summary-head chain row to insert; null for reclaim-only compaction. */
  readonly summaryChain: Chain | null;
  /**
   * First preserved-window message id after the cut — the durable message the
   * summary must precede. Null appends the summary after the last chain.
   */
  readonly insertBeforeMessageId: string | null;
  readonly updatedAt?: string;
}

/**
 * Durable compaction entry point for between-turns paths (simple + selective).
 *
 * Writes flags + summary head in ONE storage transaction against durable chain
 * rows (full `messages_json` per affected chain); untouched chains and all
 * `subagent_chains` rows are left exactly as they are. Throws loudly on any
 * integrity failure — callers must never fall back to saveSession-from-view,
 * which would truncate pre-window history for sessions exceeding the view
 * budget and wipe durable subagent rows.
 */
export function persistCompactionDurable(
  input: CompactionDurablePersistInput,
): CompactionPersistenceResult {
  const manager = getSessionManager();
  return manager.applyCompaction(input.sessionId, {
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    flaggedMessageIds: input.flaggedMessageIds,
    summaryChain: input.summaryChain,
    insertBeforeMessageId: input.insertBeforeMessageId,
  });
}

function resolveFlaggedMessageIds(
  applyResult: CompactionApplyResultLike,
  viewChains: readonly Chain[],
): string[] {
  if (applyResult.flaggedIds) {
    return [...new Set(applyResult.flaggedIds)];
  }
  // Minimal apply results without flaggedIds: diff flags against the view.
  const previouslyFlagged = new Map<string, boolean>();
  for (const chain of viewChains) {
    for (const message of chain.messages) {
      previouslyFlagged.set(message.id, message.excludeFromModel === true);
    }
  }
  const flagged: string[] = [];
  for (const chain of applyResult.updatedChains) {
    for (const message of chain.messages) {
      if (message.excludeFromModel && !previouslyFlagged.get(message.id)) {
        flagged.push(message.id);
      }
    }
  }
  return [...new Set(flagged)];
}

function resolveSummaryInsertionAnchor(
  applyResult: CompactionApplyResultLike,
  summaryMessage: Message | null,
): string | null {
  if (!applyResult.newChain || !summaryMessage) return null;
  const updatedMessages = applyResult.updatedMessages;
  if (updatedMessages) {
    const index = updatedMessages.findIndex((m) => m.id === summaryMessage.id);
    if (index >= 0) return updatedMessages[index + 1]?.id ?? null;
  }
  const chainIndex = applyResult.updatedChains.findIndex(
    (chain) => chain.id === applyResult.newChain!.id,
  );
  const next = chainIndex >= 0 ? applyResult.updatedChains[chainIndex + 1] : undefined;
  return next?.messages[0]?.id ?? null;
}

/**
 * Refresh the cached session from durable rows after a compaction write and
 * emit SESSION_COMPACTION / SESSION_UPDATED.
 *
 * The durable write restructured the chain layout (flags + summary head +
 * splits). The cache is refreshed from storage — unrecovered, so a live
 * ACTIVE continuing row keeps its status and pointer — because the
 * renderer's compaction reload (session:open) reuses this cache: serving the
 * pre-split view would mis-order it (summary above the turn's user message,
 * user message vanishing on the next checkpoint update).
 */
export function publishCompactedSession(
  manager: ReturnType<typeof getSessionManager>,
  sessionId: string,
  existing: Session,
  updatedAt: string,
): void {
  const nextSession = manager.refreshCachedSessionFromStorage(sessionId);
  if (!nextSession) {
    console.debug('[compaction] cache refresh after durable write failed (non-fatal)');
    return;
  }
  const changedIds = new Set<string>();
  for (const chain of nextSession.chains) {
    const prev = existing.chains.find((candidate) => candidate.id === chain.id);
    if (
      !prev
      || prev.messages.length !== chain.messages.length
      || prev.messages.some((m, i) => (
        m.excludeFromModel !== chain.messages[i]?.excludeFromModel
        || m.id !== chain.messages[i]?.id
      ))
    ) {
      changedIds.add(chain.id);
    }
  }
  // SESSION_COMPACTION goes out FIRST: the renderer reloads on it and holds
  // back append-only chain updates for that window. The per-chain events that
  // follow carry the compaction's split rows; delivered first, they would
  // append at the tail and order the compacted stub + summary after the
  // preserved window.
  sendSessionEvent(null, sessionId, IPC_CHANNELS.SESSION_COMPACTION, {
    sessionId,
    updatedAt,
  });
  for (const chainId of changedIds) {
    const event = buildSessionUpdatedEvent(nextSession, chainId);
    if (!event) continue;
    sendSessionEvent(null, sessionId, IPC_CHANNELS.SESSION_UPDATED, event);
  }
}

/**
 * Atomically persist a compaction between turns.
 *
 * Pure applyResult is produced by buildCompactionApply() in
 * `llm/compaction/apply.ts`. This wrapper persists it as one crash-safe,
 * targeted storage transaction: flagged chains are rewritten in place from
 * their FULL durable rows and the summary head (COMPLETED) is inserted at its
 * replay ordinal — never a wholesale saveSession from the in-memory view,
 * which would truncate pre-window history (sessions past the view budget) and
 * wipe durable subagent_chains rows (both P0 data-loss hazards).
 *
 * Crash before: old history (this not yet called).
 * Crash after:  compacted history (single transaction committed).
 *
 * After the durable write the in-memory cache is refreshed with a compacted
 * view (partial chain arrays are fine — model replay history is maintained
 * separately via setChatHistory) and SESSION_UPDATED / SESSION_COMPACTION
 * events are broadcast.
 */
export function persistCompactionBetweenTurns(
  sessionId: string,
  applyResult: CompactionApplyResultLike,
): boolean {
  if (!applyResult.didApply) return true;
  try {
    const manager = getSessionManager();
    // Load authoritative session (in-memory first, then durable)
    const existing = manager.getSession(sessionId) ?? manager.load(sessionId);
    if (!existing) return false;
    const updatedAt = new Date().toISOString();

    const summaryChain = applyResult.newChain;
    const summaryMessage = applyResult.summaryMessage
      ?? summaryChain?.messages[0]
      ?? null;
    const insertBeforeMessageId = resolveSummaryInsertionAnchor(applyResult, summaryMessage);
    const flaggedMessageIds = resolveFlaggedMessageIds(applyResult, existing.chains);

    // Single targeted durable transaction. persistCompactionDurable throws
    // loudly when the manager lacks the durable compaction path — there is
    // deliberately no saveSession-from-view fallback (it would truncate
    // pre-window history and wipe durable subagent rows).
    const durable = persistCompactionDurable({
      sessionId,
      flaggedMessageIds,
      summaryChain,
      insertBeforeMessageId,
      updatedAt,
    });
    if (durable) {
      publishCompactedSession(manager, sessionId, existing, updatedAt);
    }
    return true;
  } catch (err) {
    console.error('Failed to persist compaction between turns (non-fatal):', err);
    return false;
  }
}

/**
 * Mid-turn compaction checkpoint — rides the existing debounce (R22).
 *
 * Replaces the active agent's checkpoint payload with the compacted slice so
 * a crash resumes the compacted chain rather than the pre-compaction tail.
 * Caller should have already computed applyResult and the checkpointMessages
 * (via buildMidTurnCheckpoint in apply.ts).
 *
 * This helper updates the in-flight agent's turnMessages and enqueues a
 * debounced checkpoint; callers that need immediate durability can flush via
 * getSessionManager().updateActiveChainMessages directly.
 */
export function checkpointCompactionMidTurn(
  agent: ActiveAgent,
  checkpointMessages: readonly Message[],
): void {
  // Replace the agent's turnMessages with the compacted checkpoint slice.
  // turnMessages and checkpointMessages are both active-chain message lists —
  // the same index space — so the slice is assigned wholesale. (Do NOT slice by
  // priorMessageCount: that counter indexes agent.messages, a different array.)
  agent.turnMessages = [...checkpointMessages];
  const sessionId = agent.sessionId;
  scheduleCheckpoint(sessionId, () => [...checkpointMessages], (active) => active === agent);
}

/** Flush any pending compaction checkpoint immediately (for tests / turn boundary). */
export function flushCompactionCheckpoint(sessionId: string): boolean {
  const pending = pendingCheckpoints.get(sessionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingCheckpoints.delete(sessionId);
  const active = activeAgents.get(sessionId);
  if (!active || active.finalized) return false;
  try {
    const updated = getSessionManager().updateActiveChainMessages(pending.snapshot(), sessionId);
    const update = updated ? buildSessionUpdatedEvent(updated) : null;
    if (update) {
      sendSessionEvent(
        webContentsForWindowId(active.windowId),
        sessionId,
        IPC_CHANNELS.SESSION_UPDATED,
        update,
      );
    }
    return true;
  } catch (err) {
    console.debug('Failed to flush compaction checkpoint (non-fatal):', err);
    return false;
  }
}
