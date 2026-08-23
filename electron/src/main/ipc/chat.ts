/** Chat IPC registration and small boundary handlers. */
import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import {
  subscribeBackgroundProcessChanges,
} from '../tools/process/background-store';
import { SEND_INPUT_MAX_TEXT_LENGTH } from '../tools/process/send-input';
import { getSessionManager } from '../session/singleton';
import { IPC_CHANNELS, type ChatSessionSnapshot, type ChatCompactResult } from '../../shared/types/ipc';
import { lastChainError } from '../../shared/types/chain';
import { flattenSessionMessages } from '../../shared/types/session';
import { getProjectTrustState } from '../project/trust';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { clearAllChatHistory } from './chat-history';
import { chatCancelSchema, chatCompactSchema, chatQueueNextSchema, chatSendSchema, chatSnapshotSchema, chatStopSchema } from './payload-schemas';
import { requestNextRequestStop } from '../agents/next-request-stop';
import { electronHostEventSink } from './chat/events';
import { setHostEventSink } from '../host/events';
import {
  activeAgents,
  agentGenerations,
  draftEnsureByWindow,
  sessionsStarting,
} from '../host/chat/state';
import { snapshotForAgent } from '../host/chat/snapshot';
import {
  discardDeletedSessionRuntime,
  disposeActiveAgent,
  forceAbortSession,
  forceStopSession,
} from '../host/chat/abort';
import { startChatTurn } from '../host/chat/send';
import { compactSessionNow } from '../host/chat/compaction';
import { requestChatCancel } from '../host/chat/cancel';
import {
  bgCommandList,
  bgCommandReleaseInput,
  bgCommandSendInput,
  bgCommandSnapshot,
  bgCommandTerminate,
} from '../host/bgcmd';

export { getActiveMainTurnWindowId, getLiveChatSnapshot } from '../host/chat/snapshot';
export {
  activeSessionsForProviderConnection,
  forceAbortChat,
  forceAbortMainTurn,
  stopActiveProviderConnectionTurns,
} from '../host/chat/abort';
export type { ForceAbortMainTurnOptions } from '../host/chat/abort';
export { ensureActiveSession } from '../host/chat/session';
export { webContentsForWindowId } from './chat/events';
export {
  discardDeletedSessionRuntime,
  forceAbortSession,
  forceStopSession,
};

const BG_CMD_SNAPSHOT_MAX_LAST_N = 1000;

/**
 * Discriminated snapshot target: exactly one of `commandId` (background store)
 * or `toolCallId` (foreground live registry). Zero or both targets reject.
 */
const bgCommandSnapshotSchema = z
  .object({
    commandId: z.number().int().positive().optional(),
    toolCallId: z.string().min(1).optional(),
    lastN: z.number().int().positive().max(BG_CMD_SNAPSHOT_MAX_LAST_N).optional(),
    sessionId: z.string().uuid().optional(),
    includeTail: z.boolean().optional(),
  })
  .refine(
    (data) => (data.commandId !== undefined) !== (data.toolCallId !== undefined),
    { message: 'Provide exactly one of commandId or toolCallId' },
  );

const bgCommandListSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

const bgCommandSendInputSchema = z.object({
  commandId: z.number().int().positive(),
  // Cap stdin writes at the boundary; parity with the agent send_input tool.
  text: z.string().max(SEND_INPUT_MAX_TEXT_LENGTH),
  sessionId: z.string().uuid().optional(),
});

/** Shared shape for bgcmd:terminate and bgcmd:release_input. */
const bgCommandControlSchema = z.object({
  commandId: z.number().int().positive(),
  sessionId: z.string().uuid().optional(),
});

function broadcastBgCommandChanged(sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        const active = getSessionManager().getActive(String(win.webContents.id));
        if (!active || active.id !== sessionId) continue;
      } catch {
        continue;
      }
      win.webContents.send(IPC_CHANNELS.BG_CMD_CHANGED, { sessionId });
    } catch (err) {
      console.debug('broadcastBgCommandChanged send failed (non-fatal):', err);
    }
  }
}

let removeBgCommandChangeListener: (() => void) | null = null;

/** Register chat IPC boundaries; the turn lifecycle lives in `host/chat/send.ts`. */
export function registerChatIPC(): void {
  setHostEventSink(electronHostEventSink);

  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, payload: unknown) => {
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid chat:send payload: ${parsed.error.message}`);
    }
    return startChatTurn(String(event.sender.id), parsed.data);
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
        lastChainError: live ? null : lastChainError(session.chains),
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

  ipcMain.handle(IPC_CHANNELS.CHAT_COMPACT, async (event, payload: unknown): Promise<ChatCompactResult> => {
    const parsed = chatCompactSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:compact payload: ${parsed.error.message}`);
    const windowId = String(event.sender.id);
    const sessionId = parsed.data.sessionId ?? getSessionManager().getActive(windowId)?.id;
    if (!sessionId) {
      return { status: 'nothing_to_compact', sessionId: '', detail: 'No active session to compact.' };
    }
    const session = getSessionManager().getSession(sessionId);
    if (!session) {
      return { status: 'nothing_to_compact', sessionId, detail: 'Session not found.' };
    }
    const boundCwd = session.cwd?.trim();
    if (!boundCwd || getProjectTrustState(boundCwd) !== 'trusted') {
      return { status: 'nothing_to_compact', sessionId, detail: 'The project folder for this session is not trusted.' };
    }
    const runtime = getProjectRuntimeRegistry().get(boundCwd);
    const selection = session.selection ?? runtime.config.default_model;
    if (!selection) {
      return { status: 'nothing_to_compact', sessionId, detail: 'A provider connection and model are required before compacting.' };
    }
    return compactSessionNow(sessionId, runtime, selection);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, async (event, payload: unknown) => {
    const parsed = chatCancelSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid chat:cancel payload: ${parsed.error.message}`);
    return requestChatCancel(String(event.sender.id), parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SNAPSHOT, async (event, payload: unknown) => {
    const parsed = bgCommandSnapshotSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:snapshot payload: ${parsed.error.message}`);
    return bgCommandSnapshot(parsed.data, String(event.sender.id));
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_LIST, async (event, payload: unknown) => {
    const parsed = bgCommandListSchema.safeParse(payload ?? {});
    if (!parsed.success) throw new Error(`Invalid bgcmd:list payload: ${parsed.error.message}`);
    return bgCommandList(parsed.data, String(event.sender.id));
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_SEND_INPUT, async (event, payload: unknown) => {
    const parsed = bgCommandSendInputSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:send_input payload: ${parsed.error.message}`);
    return bgCommandSendInput(parsed.data, String(event.sender.id));
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_TERMINATE, async (event, payload: unknown) => {
    const parsed = bgCommandControlSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:terminate payload: ${parsed.error.message}`);
    return bgCommandTerminate(parsed.data, String(event.sender.id));
  });

  ipcMain.handle(IPC_CHANNELS.BG_CMD_RELEASE_INPUT, async (event, payload: unknown) => {
    const parsed = bgCommandControlSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid bgcmd:release_input payload: ${parsed.error.message}`);
    return bgCommandReleaseInput(parsed.data, String(event.sender.id));
  });

  removeBgCommandChangeListener ??= subscribeBackgroundProcessChanges((sessionId) => {
    if (sessionId) broadcastBgCommandChanged(sessionId);
  });
}

/** Unregister chat IPC handlers (for cleanup/testing). */
export function unregisterChatIPC(): void {
  setHostEventSink(null);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SEND);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_CANCEL);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_QUEUE_NEXT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_STOP);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.CHAT_COMPACT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SNAPSHOT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_SEND_INPUT);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_TERMINATE);
  ipcMain.removeHandler(IPC_CHANNELS.BG_CMD_RELEASE_INPUT);
  removeBgCommandChangeListener?.();
  removeBgCommandChangeListener = null;
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
