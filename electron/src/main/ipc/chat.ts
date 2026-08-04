/** Chat IPC registration and small boundary handlers. */
import { ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import { getSubagentManager } from '../tools';
import { getBackgroundStore } from '../tools/process/background-store';
import { getSessionManager } from '../session/singleton';
import { IPC_CHANNELS, type ChatSessionSnapshot } from '../../shared/types/ipc';
import { ChainStatus } from '../../shared/types/chain';
import { flattenSessionMessages } from '../../shared/types/session';
import { clearAllChatHistory } from './chat-history';
import { chatCancelSchema, chatQueueNextSchema, chatSendSchema, chatSnapshotSchema, chatStopSchema } from './payload-schemas';
import { requestNextRequestStop } from './next-request-stop';
import { completeSessionActivity } from './session-activity';
import {
  activeAgents,
  agentGenerations,
  draftEnsureByWindow,
  sessionsStarting,
} from './chat/state';
import { sendChatState, sendTurnEvent, webContentsForWindowId } from './chat/events';
import { snapshotForAgent } from './chat/snapshot';
import { appendLiveTailMessages, persistTurnConversation, turnMessagesFromAgent } from './chat/persist';
import { disposeActiveAgent, forceAbortSession, forceStopSession } from './chat/abort';
import { startChatTurn } from './chat/send';
import { triggerInterruptedTurnAutoName } from './chat/title';
import type { AgentContext } from '../agents/xstate/agent-machine';

export { getActiveMainTurnWindowId, getLiveChatSnapshot } from './chat/snapshot';
export {
  activeSessionsForProviderConnection,
  forceAbortChat,
  forceAbortMainTurn,
  stopActiveProviderConnectionTurns,
} from './chat/abort';
export type { ForceAbortMainTurnOptions } from './chat/abort';
export { ensureActiveSession } from './chat/session';
export { forceAbortSession, forceStopSession, webContentsForWindowId };

const BG_CMD_SNAPSHOT_MAX_LAST_N = 1000;

const bgCommandSnapshotSchema = z.object({
  commandId: z.number().int().positive(),
  lastN: z.number().int().positive().max(BG_CMD_SNAPSHOT_MAX_LAST_N).optional(),
  sessionId: z.string().uuid().optional(),
});

/** Register chat IPC boundaries; the turn lifecycle lives in `chat/send.ts`. */
export function registerChatIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, payload: unknown) => {
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:send payload: ${parsed.error.message}`);
    }
    return startChatTurn(event.sender, parsed.data);
  });

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SNAPSHOT,
    async (event, payload: unknown): Promise<ChatSessionSnapshot | null> => {
      const parsed = chatSnapshotSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw new Error(`Invalid chat:snapshot payload: ${parsed.error.message}`);
      }
      const windowId = String(event.sender.id);
      const sessionId = parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
      if (!sessionId) return null;
      const session = getSessionManager().getSession(sessionId);
      if (!session) return null;
      const liveAgent = activeAgents.get(sessionId);
      const live = liveAgent && !liveAgent.finalized ? snapshotForAgent(liveAgent) : null;
      return {
        sessionId,
        messages: liveAgent && live ? [...liveAgent.messages] : flattenSessionMessages(session),
        live,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (_event, payload: unknown) => {
    const parsed = chatStopSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid chat:stop payload: ${parsed.error.message}`);
    return { status: forceStopSession(parsed.data.sessionId) ? 'stopped' : 'no_active_stream' };
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_QUEUE_NEXT, async (_event, payload: unknown) => {
    const parsed = chatQueueNextSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:queue_next payload: ${parsed.error.message}`);
    requestNextRequestStop(parsed.data.sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event, payload: unknown) => {
    const webContents: WebContents = event.sender;
    const windowId = String(webContents.id);
    const parsed = chatCancelSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:cancel payload: ${parsed.error.message}`);
    const sessionId = parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
    if (!sessionId) return { status: 'no_active_stream' };
    const existing = activeAgents.get(sessionId);
    if (!existing) return { status: 'no_active_stream' };
    const streamWebContents = webContentsForWindowId(existing.windowId) ?? webContents;
    const interruptState = existing.interruptActor.getSnapshot().value as
      | 'idle'
      | 'confirmAgent'
      | 'confirmSubagents';
    if (interruptState === 'idle') {
      existing.interruptActor.send({ type: 'INTERRUPT' });
      return { status: 'confirming' };
    }
    if (interruptState === 'confirmAgent') {
      getBackgroundStore().terminateSession(sessionId);
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
        const fullHistory = [...existing.messages, ...existing.turnMessages];
        persistTurnConversation(
          sessionId, fullHistory, turnMessagesFromAgent(existing), ChainStatus.INTERRUPTED,
          existing.agent, existing.selection, streamWebContents,
        );
        existing.messages = fullHistory;
        // Interrupted turns still name the session from what was exchanged so far.
        triggerInterruptedTurnAutoName(existing, fullHistory);
        completeSessionActivity(
          sessionId,
          getSessionManager().getActive(existing.windowId)?.id !== sessionId,
        );
        sendTurnEvent(streamWebContents, existing, IPC_CHANNELS.CHAT_DONE, {
          type: 'done', response: partial, messages: fullHistory, interrupted: true, usage,
        });
        sendChatState(streamWebContents, existing, {
          state: 'idle', error: null, interruptState: 'confirmSubagents', cwd: existing.cwd,
        });
      }
      existing.interruptActor.send({ type: 'INTERRUPT' });
      return { status: 'confirming_subagents' };
    }
    if (interruptState === 'confirmSubagents') {
      getBackgroundStore().terminateSession(sessionId);
      getSubagentManager().cancelRunning(sessionId);
      disposeActiveAgent(sessionId, existing);
      sendChatState(streamWebContents, existing, {
        state: 'idle', error: null, interruptState: 'idle', cwd: existing.cwd,
      });
      return { status: 'cancelled' };
    }
    return { status: 'no_active_stream' };
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (event, payload: unknown) => {
    const parsed = bgCommandSnapshotSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    const { commandId, lastN, sessionId: requestedSessionId } = parsed.data;
    const sessionId = requestedSessionId ?? getSessionManager().getActive(String(event.sender.id))?.id ?? null;
    if (!sessionId) return { found: false };
    const snapshot = getBackgroundStore().snapshotForSession(commandId, lastN ?? 50, sessionId);
    return snapshot ? { found: true, ...snapshot } : { found: false };
  });
}

/** Unregister chat IPC handlers (for cleanup/testing). */
export function unregisterChatIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_NEXT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);
  for (const [sessionId, agent] of [...activeAgents.entries()]) {
    agent.agentCancelled = true;
    agent.finalized = true;
    disposeActiveAgent(sessionId, agent);
  }
  activeAgents.clear();
  sessionsStarting.clear();
  draftEnsureByWindow.clear();
  agentGenerations.clear();
  clearAllChatHistory();
}
