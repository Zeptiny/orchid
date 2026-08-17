import type { WebContents } from 'electron';
import type { AgentContext } from '../../agents/xstate/agent-machine';
import type { Agent } from '../../../shared/types/agent';
import type { ModelSelection } from '../../../shared/types/provider';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { Message, Usage } from '../../../shared/types/message';
import { ChainStatus } from '../../../shared/types/chain';
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

// ── Compaction persistence (U7) ─────────────────────────────────────────────
// Re-export pure build for convenience; integration helpers below ride the
// existing turn-persistence paths so crash semantics match prior behavior.
// Between-turns persistence is documented as single-transaction (saveSession)
// which atomically replaces flagged chains + inserts the summary head.

export function attachUsageToLatestAssistant(messages: Message[], usage: Usage): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === MessageRole.ASSISTANT && message.type === MessageType.TEXT) {
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
 */
export function turnMessagesFromAgent(agent: ActiveAgent): Message[] {
  const turnBase = agent.messages.slice(agent.priorMessageCount);
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

/** Persist one bounded main-turn checkpoint, debounced per session. */
export function checkpointActiveTurn(agent: ActiveAgent, context: AgentContext): void {
  const sessionId = agent.sessionId;
  const messages = checkpointMessagesFromAgent(agent, context);
  const existing = pendingCheckpoints.get(sessionId);
  if (existing) {
    existing.messages = messages;
    return;
  }
  const timer = setTimeout(() => {
    const entry = pendingCheckpoints.get(sessionId);
    pendingCheckpoints.delete(sessionId);
    const active = activeAgents.get(sessionId);
    if (!active || active.finalized) return;
    try {
      const updated = getSessionManager().updateActiveChainMessages(
        entry?.messages ?? messages,
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
  pendingCheckpoints.set(sessionId, { timer, messages });
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

/**
 * Atomically persist a compaction between turns.
 *
 * Pure applyResult is produced by buildCompactionApply() in
 * `llm/compaction/apply.ts`. This wrapper persists it as one crash-safe
 * write: flagged chains + summary head (COMPLETED) in a single transaction.
 *
 * Crash before: old history (this not yet called).
 * Crash after:  compacted history (transaction committed).
 * Uses saveSession (single SQLite transaction) to satisfy atomicity without
 * mutating older chains in place — the new summary chain is appended as its
 * own chain (R20).
 */
export function persistCompactionBetweenTurns(
  sessionId: string,
  applyResult: { updatedChains: import('../../../shared/types/chain').Chain[]; newChain: import('../../../shared/types/chain').Chain | null; didApply: boolean },
): boolean {
  if (!applyResult.didApply) return true;
  try {
    const manager = getSessionManager();
    // Load authoritative session (in-memory first, then durable)
    const existing = manager.getSession(sessionId) ?? manager.load(sessionId);
    if (!existing) return false;
    // updatedChains already contains the summary chip at its logical position;
    // for storage ordinal consistency we keep the array as-is: saveSession will
    // persist ordinals in array order, so replay order matches updatedMessages.
    const updatedAt = new Date().toISOString();
    // Lazy import to avoid circular during typecheck when apply.ts imports persist
    // helpers — saveSession is side-effect free for type paths.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { saveSession } = require('../../session/storage') as typeof import('../../session/storage');
    const nextSession = {
      ...existing,
      chains: applyResult.updatedChains as typeof existing.chains,
      updatedAt,
    };
    saveSession(nextSession);
    try {
      (manager as unknown as { _sessions: Map<string, unknown> })._sessions?.set(sessionId, nextSession);
    } catch {
    }
    try {
      const updatedIds = new Set(applyResult.updatedChains.map((c) => c.id));
      const existingIds = new Set(existing.chains.map((c) => c.id));
      const changedIds = new Set<string>();
      for (const c of applyResult.updatedChains) {
        const prev = existing.chains.find((p) => p.id === c.id);
        if (!prev || prev.messages.length !== c.messages.length || prev.messages.some((m, i) => m.excludeFromModel !== c.messages[i]?.excludeFromModel || m.id !== c.messages[i]?.id)) {
          changedIds.add(c.id);
        }
      }
      for (const id of updatedIds) if (!existingIds.has(id)) changedIds.add(id);
      if (changedIds.size > 0) {
        const { webContents } = require('electron') as typeof import('electron');
        const all = (webContents?.getAllWebContents?.() ?? []) as unknown as WebContents[];
        for (const chainId of changedIds) {
          const chain = nextSession.chains.find((c) => c.id === chainId);
          if (!chain) continue;
          const event = buildSessionUpdatedEvent(nextSession as unknown as import('../../../shared/types/session').Session, chain.id);
          if (!event) continue;
          for (const wc of all) {
            try {
              const active = (manager as unknown as { getActive: (id: string) => unknown }).getActive(String((wc as unknown as { id: number }).id));
              if ((active as unknown as { id?: string })?.id !== sessionId) continue;
              if (typeof (wc as unknown as { isDestroyed?: () => boolean }).isDestroyed === 'function' && (wc as unknown as { isDestroyed: () => boolean }).isDestroyed()) continue;
              (wc as unknown as { send: (ch: string, p: unknown) => void }).send(IPC_CHANNELS.SESSION_UPDATED, event);
            } catch {
            }
          }
        }
      }
      try {
        const { webContents: wc2 } = require('electron') as typeof import('electron');
        const all2 = (wc2?.getAllWebContents?.() ?? []) as unknown as WebContents[];
        const compactionEvent = { sessionId, updatedAt: nextSession.updatedAt };
        for (const wc of all2) {
          try {
            const active = (manager as unknown as { getActive: (id: string) => unknown }).getActive(String((wc as unknown as { id: number }).id));
            if ((active as unknown as { id?: string })?.id !== sessionId) continue;
            if (typeof (wc as unknown as { isDestroyed?: () => boolean }).isDestroyed === 'function' && (wc as unknown as { isDestroyed: () => boolean }).isDestroyed()) continue;
            (wc as unknown as { send: (ch: string, p: unknown) => void }).send(IPC_CHANNELS.SESSION_COMPACTION, compactionEvent);
          } catch {
          }
        }
      } catch {
      }
    } catch {
    }
    return true;
  } catch (err) {
    console.debug('Failed to persist compaction between turns (non-fatal):', err);
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
  // Replace the agent's turnMessages tail with the compacted checkpoint slice.
  // turnMessages holds tool/assistant messages for this turn only; priorMessageCount
  // indexes into agent.messages. For compaction the prior history flags live in
  // the durable chains, so here we only need to mirror the active chain's new
  // content for crash recovery.
  agent.turnMessages = [...checkpointMessages.slice(agent.priorMessageCount)];
  // If checkpointMessages is the full active-chain snapshot, replace directly:
  // the active chain row is exactly checkpointMessages.
  // For the general mid-turn helper we replace turnMessages with the provided
  // slice that corresponds to the active chain's messages after compaction.
  // The pendingCheckpoints debounce will persist it; callers may also flush
  // immediately via updateActiveChainMessages for deterministic tests.
  const sessionId = agent.sessionId;
  const existing = pendingCheckpoints.get(sessionId);
  if (existing) {
    existing.messages = [...checkpointMessages];
    return;
  }
  // Enqueue a debounced checkpoint with the compacted payload. Reuse the same
  // timer machinery as checkpointActiveTurn but with a compacted origin.
  const timer = setTimeout(() => {
    const entry = pendingCheckpoints.get(sessionId);
    pendingCheckpoints.delete(sessionId);
    const active = activeAgents.get(sessionId);
    if (!active || active.finalized) return;
    if (active !== agent) return;
    try {
      const updated = getSessionManager().updateActiveChainMessages(
        entry?.messages ?? [...checkpointMessages],
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
      console.debug('Failed to checkpoint compaction mid-turn (non-fatal):', err);
    }
  }, CHECKPOINT_DEBOUNCE_MS);
  pendingCheckpoints.set(sessionId, { timer, messages: [...checkpointMessages] });
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
    const updated = getSessionManager().updateActiveChainMessages(pending.messages, sessionId);
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
