/**
 * Cancel/interrupt core behind the chat:cancel boundary.
 *
 * The two-phase Esc interrupt ladder (agent confirm → subagents confirm) and
 * the standalone subagent-only cancel live here so both the Electron IPC
 * boundary (ipc/chat.ts) and the host protocol (host/server.ts) share one
 * implementation. Client-addressed (opaque string id), Electron-free.
 */
import { getSubagentManager } from '../../tools';
import {
  getBackgroundStore,
} from '../../tools/process/background-store';
import { getForegroundLiveRegistry } from '../../tools/process/foreground-live';
import { getSessionManager } from '../../session/singleton';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import { ChainStatus } from '../../../shared/types/chain';
import { MAIN_AGENT_SCOPE_ID } from '../../../shared/types/agent-scope';
import { isTerminalSubagentState } from '../../agents/types';
import { completeSessionActivity } from '../../session/activity-live';
import type { AgentContext } from '../../agents/xstate/agent-machine';
import {
  activeAgents,
  clearSubagentCancelConfirm,
  consumeSubagentCancelConfirm,
  stageSubagentCancelConfirm,
} from './state';
import { canDeliverTo, sendChatState, sendTurnEvent } from './events';
import {
  appendLiveTailMessages,
  persistTurnConversation,
  turnMessagesFromAgent,
} from './persist';
import { disposeActiveAgent } from './abort';
import { triggerInterruptedTurnAutoName } from './title';

function sessionHasActiveSubagents(sessionId: string): boolean {
  try {
    return getSubagentManager()
      .getStates(sessionId)
      .some((record) => !isTerminalSubagentState(record.state));
  } catch {
    return false;
  }
}

/**
 * Third interrupt layer with no live main-agent turn: the main agent was
 * cancelled (its ActiveAgent disposed after the interrupt reset window), but
 * session-owned subagents still run. The first Esc stages the confirmation;
 * the next Esc within the window cancels the subagents and their
 * session-owned processes. After the window the next Esc re-stages,
 * mirroring the interrupt machine's auto-reset. Keeps layer 3 reachable for
 * as long as subagents run (issue #145).
 */
function handleSubagentOnlyCancel(
  sessionId: string,
  clientId: string,
): { status: string } {
  if (!sessionHasActiveSubagents(sessionId)) {
    clearSubagentCancelConfirm(sessionId);
    return { status: 'no_active_stream' };
  }
  if (!consumeSubagentCancelConfirm(sessionId)) {
    stageSubagentCancelConfirm(sessionId);
    return { status: 'confirming_subagents' };
  }
  getBackgroundStore().terminateSession(sessionId);
  getForegroundLiveRegistry().dropSession(sessionId);
  const cancelled = getSubagentManager().cancelRunning(sessionId);
  if (cancelled.length > 0) {
    completeSessionActivity(
      sessionId,
      getSessionManager().getActive(clientId)?.id !== sessionId,
    );
  }
  return { status: 'cancelled' };
}

/**
 * chat:cancel — two-phase Esc interrupt for the client's active (or
 * explicitly addressed) session. `payload.sessionId` may be null to target
 * the client's active session.
 */
export async function requestChatCancel(
  clientId: string,
  payload: { sessionId?: string | null },
): Promise<{ status: string }> {
  const sessionId = payload.sessionId ?? getSessionManager().getActive(clientId)?.id;
  if (!sessionId) return { status: 'no_active_stream' };
  const existing = activeAgents.get(sessionId);
  if (!existing) return handleSubagentOnlyCancel(sessionId, clientId);
  const streamClientId = canDeliverTo(existing.windowId) ? existing.windowId : clientId;
  const interruptState = existing.interruptActor.getSnapshot().value as
    | 'idle'
    | 'confirmAgent'
    | 'confirmSubagents';
  if (interruptState === 'idle') {
    existing.interruptActor.send({ type: 'INTERRUPT' });
    return { status: 'confirming' };
  }
  if (interruptState === 'confirmAgent') {
    // Second Esc cancels only the main agent. Scope the process cleanup to
    // the main agent's own commands: subagent-owned commands live under the
    // same session id with their own scope ids and must survive until the
    // third Esc confirms subagent cancellation (issue #145).
    getBackgroundStore().terminateScope(sessionId, MAIN_AGENT_SCOPE_ID);
    getForegroundLiveRegistry().dropScope(sessionId, MAIN_AGENT_SCOPE_ID);
    existing.agentCancelled = true;
    const context = existing.actor.getSnapshot().context as AgentContext;
    existing.actor.send({ type: 'CANCEL' });
    if (!existing.finalized) {
      existing.finalized = true;
      const partial = context.response ?? '';
      const thinking = context.thinking ?? '';
      const usage = context.usage ?? null;
      appendLiveTailMessages(existing.turnMessages, existing, context, { placeholderWhenEmpty: true });
      if (thinking.length > existing.thinkingCommittedLength) existing.thinkingCommittedLength = thinking.length;
      if (partial.length > existing.responseCommittedLength) existing.responseCommittedLength = partial.length;
      const terminalMessages = turnMessagesFromAgent(existing);
      const fullHistory = [...existing.messages, ...existing.turnMessages];
      persistTurnConversation(
        sessionId, fullHistory, terminalMessages, ChainStatus.INTERRUPTED,
        existing.agent, existing.selection, streamClientId,
      );
      existing.messages = fullHistory;
      // Interrupted turns still name the session from what was exchanged so far.
      triggerInterruptedTurnAutoName(existing, fullHistory);
      completeSessionActivity(
        sessionId,
        getSessionManager().getActive(existing.windowId)?.id !== sessionId,
      );
      sendTurnEvent(streamClientId, existing, IPC_CHANNELS.CHAT_DONE, {
        type: 'done', response: partial, messages: terminalMessages, interrupted: true, usage,
      });
      sendChatState(streamClientId, existing, {
        state: 'idle', error: null, interruptState: 'confirmSubagents', cwd: existing.cwd,
      });
    }
    existing.interruptActor.send({ type: 'INTERRUPT' });
    return { status: 'confirming_subagents' };
  }
  if (interruptState === 'confirmSubagents') {
    clearSubagentCancelConfirm(sessionId);
    getBackgroundStore().terminateSession(sessionId);
    getForegroundLiveRegistry().dropSession(sessionId);
    getSubagentManager().cancelRunning(sessionId);
    disposeActiveAgent(sessionId, existing);
    sendChatState(streamClientId, existing, {
      state: 'idle', error: null, interruptState: 'idle', cwd: existing.cwd,
    });
    return { status: 'cancelled' };
  }
  return { status: 'no_active_stream' };
}
