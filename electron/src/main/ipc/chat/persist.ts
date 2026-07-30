import type { WebContents } from 'electron';
import type { AgentContext } from '../../agents/xstate/agent-machine';
import type { Agent } from '../../../shared/types/agent';
import type { ModelSelection } from '../../../shared/types/provider';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { Message, Usage } from '../../../shared/types/message';
import { ChainStatus } from '../../../shared/types/chain';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { flattenSessionMessages, getSessionManager } from '../session';
import { setChatHistory } from '../chat-history';
import {
  makeAssistantMessage,
  makeThinkingMessage,
} from '../../llm/message-factories';
import { activeAgents, pendingCheckpoints, type ActiveAgent } from './state';
import { sendSessionEvent, webContentsForWindowId } from './events';
import { textSegmentIdAtOffset } from './snapshot';

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
  context: Pick<AgentContext, 'response' | 'thinking' | 'usage'> | undefined,
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
      ));
    }
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

/** Materialize the current live tail without mutating committed turn state. */
function checkpointMessagesFromAgent(agent: ActiveAgent, context: AgentContext): Message[] {
  const checkpoint = turnMessagesFromAgent(agent);
  appendLiveTailMessages(checkpoint, agent, context);
  return checkpoint;
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
      if (updated) {
        sendSessionEvent(
          webContentsForWindowId(active.windowId),
          sessionId,
          IPC_CHANNELS.SESSION_UPDATED,
          { session: updated },
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
    }, sessionId);
    if (updated && webContents) {
      sendSessionEvent(webContents, sessionId, IPC_CHANNELS.SESSION_UPDATED, { session: updated });
    }
  } catch (err) {
    console.debug('Failed to persist chat chain (non-fatal):', err);
  }
}

/** Flatten all session chains — never only the active/last chain. */
export function historyFromSession(sessionId: string): Message[] {
  try {
    const session = getSessionManager().getSession(sessionId);
    if (!session) return [];
    return flattenSessionMessages(session);
  } catch {
    return [];
  }
}
