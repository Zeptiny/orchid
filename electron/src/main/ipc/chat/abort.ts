import type { AgentContext } from '../../agents/xstate/agent-machine';
import { ChainStatus } from '../../../shared/types/chain';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { getSessionManager } from '../../session/singleton';
import { getBackgroundStore } from '../../tools/process/background-store';
import { getSubagentManager } from '../../tools';
import { completeSessionActivity } from '../session-activity';
import {
  activeAgents,
  nextAgentGeneration,
  type ActiveAgent,
} from './state';
import {
  cancelPendingCheckpoint,
  flushPartialTurnContent,
  persistTurnConversation,
  turnMessagesFromAgent,
} from './persist';
import { sendChatState, sendTurnEvent, webContentsForWindowId } from './events';

export function disposeActiveAgent(sessionId: string, active: ActiveAgent): void {
  cancelPendingCheckpoint(sessionId);
  // Only clear the map slot if we still own it (a newer agent may have replaced us).
  if (activeAgents.get(sessionId) === active) {
    activeAgents.delete(sessionId);
  }
  active.unsubscribe();
  active.interruptUnsubscribe();
  if (active.interruptResetTimer) {
    clearTimeout(active.interruptResetTimer);
    active.interruptResetTimer = null;
  }
  active.abortController.abort();
  active.actor.stop();
  active.interruptActor.stop();
  active.releaseResources();
}

/**
 * Silently abort any in-flight chat for a window (e.g. on session switch).
 * Does not emit CHAT_DONE — the renderer is about to replace its message list.
 *
 * Dispose is synchronous: a deferred microtask left a window where the old
 * subscription could still emit CHAT_CHUNK after session:load swapped UI state
 * (or after a new chat:send started). Flags + generation bump drop any late
 * callbacks that race with stop/unsubscribe.
 *
 * Before discarding, we attempt to persist any partial turn (user message +
 * tool calls + assistant text produced so far) as INTERRUPTED so the user does
 * not lose context when switching sessions mid-stream (P2-9).
 *
 * If the agent already finalized (persist completed), only dispose — never
 * mint a duplicate INTERRUPTED chain.
 */
export function forceAbortChat(windowId: string): void {
  const sessionId = getSessionManager().getActive(windowId)?.id;
  if (sessionId) forceAbortSession(sessionId);
}

/** Abort exactly one session without affecting work in any other session. */
export function forceAbortSession(sessionId: string): void {
  getBackgroundStore().terminateSession(sessionId);
  try {
    getSubagentManager().cancelRunning(sessionId);
  } catch (err) {
    console.debug(
      'forceAbortSession subagent cancel failed (non-fatal):',
      err,
    );
  }

  forceAbortMainTurn(sessionId);
}

export interface ForceAbortMainTurnOptions {
  /** Notify the originating renderer that its visible turn was interrupted. */
  emitTerminalEvents?: boolean;
}

/**
 * Abort and persist only the main-agent turn for one session.
 *
 * Interactive-question cancellation uses this narrower path so declining a
 * main-agent question cannot terminate independent subagents or background
 * commands owned by the same session.
 */
export function forceAbortMainTurn(
  sessionId: string,
  options: ForceAbortMainTurnOptions = {},
): void {
  const existing = activeAgents.get(sessionId);
  if (!existing) return;

  // Already finalized (done/error/cancel) — only dispose; do not re-persist.
  if (existing.finalized) {
    existing.agentCancelled = true;
    nextAgentGeneration(sessionId);
    disposeActiveAgent(sessionId, existing);
    return;
  }

  let context: AgentContext | undefined;
  let fullHistory = [...existing.messages, ...existing.turnMessages];
  try {
    const snapshot = existing.actor.getSnapshot();
    context = snapshot?.context as AgentContext | undefined;
    flushPartialTurnContent(existing, context);

    if (existing.messages.length > 0 || existing.turnMessages.length > 0) {
      fullHistory = [...existing.messages, ...existing.turnMessages];
      if (fullHistory.length > 0) {
        try {
          const wc = webContentsForWindowId(existing.windowId);
          persistTurnConversation(
            sessionId,
            fullHistory,
            turnMessagesFromAgent(existing),
            ChainStatus.INTERRUPTED,
            existing.agent,
            existing.selection,
            wc ?? undefined,
          );
        } catch (err) {
          console.debug(
            'Failed to persist partial chat on forceAbort (non-fatal):',
            err,
          );
        }
      }
    }
  } catch (err) {
    console.debug(
      'forceAbortMainTurn persistence attempt failed (non-fatal):',
      err,
    );
  }
  existing.messages = fullHistory;

  existing.agentCancelled = true;
  existing.finalized = true;
  completeSessionActivity(
    sessionId,
    getSessionManager().getActive(existing.windowId)?.id !== sessionId,
  );

  if (options.emitTerminalEvents) {
    const ownerWebContents = webContentsForWindowId(existing.windowId);
    if (ownerWebContents) {
      const response = context?.response ?? '';
      const usage = context?.usage ?? null;
      try {
        sendTurnEvent(ownerWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
          type: 'done',
          response,
          messages: fullHistory,
          interrupted: true,
          usage,
        });
      } catch (err) {
        console.debug('Failed to emit CHAT_DONE on main-turn abort (non-fatal):', err);
      }
      try {
        sendChatState(ownerWebContents, existing, {
          state: 'idle',
          error: null,
          interruptState: 'idle',
          cwd: existing.cwd,
        });
      } catch (err) {
        console.debug('Failed to emit CHAT_STATE on main-turn abort (non-fatal):', err);
      }
    }
  }

  nextAgentGeneration(sessionId);
  disposeActiveAgent(sessionId, existing);
}

/**
 * Immediately stop one session for the global Activity surface.
 *
 * Unlike Esc cancellation, this does not require confirmation clicks. It keeps
 * all writes and terminal events on the stopped session's originating window.
 */
export function forceStopSession(sessionId: string): boolean {
  getBackgroundStore().terminateSession(sessionId);
  const existing = activeAgents.get(sessionId);
  const cancelledSubagents = getSubagentManager().cancelRunning(sessionId);
  if (!existing) {
    if (cancelledSubagents.length > 0) {
      completeSessionActivity(sessionId, true);
    }
    return cancelledSubagents.length > 0;
  }

  // Already finalized (done/error/cancel) — only dispose residual work.
  if (existing.finalized) {
    existing.agentCancelled = true;
    nextAgentGeneration(sessionId);
    disposeActiveAgent(sessionId, existing);
    return true;
  }

  const ownerWebContents =
    webContentsForWindowId(existing.windowId) ?? null;
  existing.agentCancelled = true;
  existing.finalized = true;
  const context = existing.actor.getSnapshot().context as AgentContext;
  existing.actor.send({ type: 'CANCEL' });
  flushPartialTurnContent(existing, context);
  const fullHistory = [...existing.messages, ...existing.turnMessages];
  if (fullHistory.length > 0) {
    persistTurnConversation(
      sessionId,
      fullHistory,
      turnMessagesFromAgent(existing),
      ChainStatus.INTERRUPTED,
      existing.agent,
      existing.selection,
      ownerWebContents ?? undefined,
    );
  }
  existing.messages = fullHistory;
  completeSessionActivity(
    sessionId,
    getSessionManager().getActive(existing.windowId)?.id !== sessionId,
  );

  if (ownerWebContents) {
    sendTurnEvent(ownerWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
      type: 'done',
      response: context.response ?? '',
      messages: fullHistory,
      interrupted: true,
      usage: context.usage ?? null,
    });
    sendChatState(ownerWebContents, existing, {
      state: 'idle',
      error: null,
      interruptState: 'idle',
      cwd: existing.cwd,
    });
  }

  nextAgentGeneration(sessionId);
  disposeActiveAgent(sessionId, existing);
  return true;
}

/** Active session IDs whose frozen turn uses the given provider connection. */
export function activeSessionsForProviderConnection(connectionId: string): readonly string[] {
  return [...activeAgents.values()]
    .filter((active) => !active.finalized && active.selection.connectionId === connectionId)
    .map((active) => active.sessionId);
}

/**
 * Destructive disconnect helper. Stops only turns already attributed to this
 * connection; other connections and frozen completed turns remain untouched.
 */
export function stopActiveProviderConnectionTurns(connectionId: string): readonly string[] {
  const sessionIds = activeSessionsForProviderConnection(connectionId);
  for (const sessionId of sessionIds) forceStopSession(sessionId);
  return sessionIds;
}
